// Test della politica di refresh del piano (lib/planScheduler.js).
// Esecuzione: gjs -m tests/test-scheduler.js

import System from 'system';

import {
    isPlanDue, planExpired, resetTimes, mergeReason, backoffDelay, nextResetFetchDelayS,
    RESET_FETCH_DELAY_S,
} from '../lib/planScheduler.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
        print(`PASS ${name}`);
    } else {
        failed++;
        print(`FAIL ${name}${detail ? ` (${detail})` : ''}`);
    }
}

function checkEqual(name, actual, expected) {
    check(name, actual === expected, `atteso ${expected}, ottenuto ${actual}`);
}

const S = 1000;
const MIN = 60 * S;
const NOW = Date.UTC(2026, 10, 12, 10, 0, 0);

const win = (offsetMs) => ({percent: 10, resetsAt: new Date(NOW + offsetMs)});
const FRESH = {fiveHour: win(MIN * 60), sevenDay: win(MIN * 60 * 24)};
const EXPIRED = {fiveHour: win(-S), sevenDay: win(MIN * 60 * 24)};

// Stato base: ultimo successo e tentativo 'ago' ms fa, intervallo 300 s.
function st({success = 0, attempt = success, backoff = 0, interval = 300, usage = FRESH} = {}) {
    return {
        backoffUntil: backoff,
        lastAttempt: NOW - attempt,
        lastSuccess: NOW - success,
        intervalS: interval,
        usage,
    };
}

// [nome, reason, stato, atteso]
const DUE_CASES = [
    // back-off sempre rispettato, anche con finestra scaduta
    ...['startup', 'tick', 'open', 'resume', 'reset'].flatMap(r => [
        [`${r}: back-off attivo`, r, st({success: 3600 * S, attempt: 3600 * S, backoff: NOW + S}), false],
        [`${r}: back-off attivo + scaduta`, r, st({success: 3600 * S, attempt: 3600 * S, backoff: NOW + S, usage: EXPIRED}), false],
    ]),
    ['tick: back-off appena finito', 'tick', st({success: 3600 * S, backoff: NOW}), true],
    // tick
    ['tick: sotto intervallo', 'tick', st({attempt: 200 * S}), false],
    ['tick: tolleranza 5 s', 'tick', st({attempt: 295 * S}), true],
    ['tick: appena fuori tolleranza', 'tick', st({attempt: 295 * S - 1}), false],
    ['tick: oltre intervallo', 'tick', st({attempt: 400 * S}), true],
    ['tick: usa lastAttempt, non lastSuccess', 'tick', st({success: 3600 * S, attempt: 10 * S}), false],
    ['tick: scaduta ma ritmo normale', 'tick', st({attempt: 10 * S, usage: EXPIRED}), false],
    // clamp intervallo (minimo 60 s)
    ['tick: intervallo 10 -> 60, a 54 s no', 'tick', st({attempt: 54 * S, interval: 10}), false],
    ['tick: intervallo 10 -> 60, a 55 s si', 'tick', st({attempt: 55 * S, interval: 10}), true],
    ['tick: intervallo 0 -> 60', 'tick', st({attempt: 30 * S, interval: 0}), false],
    ['tick: intervallo 3600, a 1000 s no', 'tick', st({attempt: 1000 * S, interval: 3600}), false],
    // startup
    ['startup: valore giovane', 'startup', st({success: 100 * S}), false],
    ['startup: valore giovane, tolleranza', 'startup', st({success: 295 * S}), true],
    ['startup: valore vecchio', 'startup', st({success: 400 * S}), true],
    ['startup: scaduta', 'startup', st({success: S, usage: EXPIRED}), true],
    ['startup: nessun valore (lastSuccess 0)', 'startup', {...st(), lastSuccess: 0}, true],
    ['startup: nessun usage, giovane', 'startup', st({success: S, usage: null}), false],
    // open
    ['open: fresco', 'open', st({success: 30 * S}), false],
    ['open: stantio ma tentativo recente', 'open', st({success: 120 * S, attempt: 30 * S}), false],
    ['open: stantio e distanziato', 'open', st({success: 120 * S, attempt: 60 * S}), true],
    ['open: soglia stantio 60 s', 'open', st({success: 60 * S}), true],
    ['open: appena sotto soglia', 'open', st({success: 60 * S - 1, attempt: 60 * S}), false],
    ['open: scaduta e distanziato', 'open', st({success: 5 * S, attempt: 61 * S, usage: EXPIRED}), true],
    ['open: scaduta ma tentativo recente', 'open', st({success: 5 * S, attempt: 10 * S, usage: EXPIRED}), false],
    // resume
    ['resume: fresco', 'resume', st({success: 30 * S}), false],
    ['resume: stantio', 'resume', st({success: 60 * S}), true],
    ['resume: stantio, ignora spaziatura', 'resume', st({success: 120 * S, attempt: 1 * S}), true],
    ['resume: scaduta', 'resume', st({success: 1 * S, attempt: 1 * S, usage: EXPIRED}), true],
    // reset
    ['reset: non scaduta', 'reset', st({success: 3600 * S, attempt: 3600 * S}), false],
    ['reset: scaduta, tentativo vecchio', 'reset', st({success: 3600 * S, attempt: 60 * S, usage: EXPIRED}), true],
    ['reset: scaduta, tentativo recente', 'reset', st({success: 3600 * S, attempt: 59 * S, usage: EXPIRED}), false],
    // reason sconosciuta = tick
    ['sconosciuta: come tick (no)', 'boh', st({attempt: 10 * S}), false],
    ['sconosciuta: come tick (si)', 'boh', st({attempt: 400 * S}), true],
    // finestra con resetsAt esattamente adesso = scaduta
    ['scaduta a resetsAt == now', 'resume', st({success: S, usage: {fiveHour: win(0), sevenDay: null}}), true],
    // finestra con resetsAt null non scade
    ['resetsAt null non scade', 'resume', st({success: S, usage: {fiveHour: {percent: 1, resetsAt: null}, sevenDay: null}}), false],
];

function testDue() {
    for (const [name, reason, state, expected] of DUE_CASES)
        checkEqual(`isPlanDue ${name}`, isPlanDue(reason, NOW, state), expected);
}

function testExpired() {
    checkEqual('planExpired usage null', planExpired(null, NOW), false);
    checkEqual('planExpired fresca', planExpired(FRESH, NOW), false);
    checkEqual('planExpired una finestra passata', planExpired(EXPIRED, NOW), true);
    checkEqual('planExpired solo sevenDay passata', planExpired({fiveHour: null, sevenDay: win(-1)}, NOW), true);
    checkEqual('resetTimes ignora null/invalid', resetTimes({
        fiveHour: {percent: 1, resetsAt: new Date(NaN)},
        sevenDay: win(5 * S),
    }).length, 1);
    checkEqual('resetTimes usage null', resetTimes(null).length, 0);
}

function testMerge() {
    checkEqual('merge: nessuno pending', mergeReason(null, 'open'), 'open');
    checkEqual('merge: tick batte open', mergeReason('open', 'tick'), 'tick');
    checkEqual('merge: open non degrada tick', mergeReason('tick', 'open'), 'tick');
    checkEqual('merge: resume batte tick', mergeReason('tick', 'resume'), 'resume');
    checkEqual('merge: startup batte resume', mergeReason('resume', 'startup'), 'startup');
    checkEqual('merge: reset batte tutto', mergeReason('startup', 'reset'), 'reset');
    checkEqual('merge: reset resta', mergeReason('reset', 'open'), 'reset');
    checkEqual('merge: stessa reason', mergeReason('tick', 'tick'), 'tick');
}

function testBackoff() {
    checkEqual('backoff 1 colpo = 5 min', backoffDelay(1), 5 * MIN);
    checkEqual('backoff 2 colpi = 10 min', backoffDelay(2), 10 * MIN);
    checkEqual('backoff 3 colpi = 20 min', backoffDelay(3), 20 * MIN);
    checkEqual('backoff 4 colpi = tetto 30 min', backoffDelay(4), 30 * MIN);
    checkEqual('backoff 10 colpi = tetto 30 min', backoffDelay(10), 30 * MIN);
    checkEqual('backoff Retry-After maggiore', backoffDelay(1, 45 * MIN), 45 * MIN);
    checkEqual('backoff Retry-After minore', backoffDelay(2, 1 * MIN), 10 * MIN);
    checkEqual('backoff Retry-After null', backoffDelay(1, null), 5 * MIN);
    checkEqual('backoff Retry-After undefined', backoffDelay(1, undefined), 5 * MIN);
    checkEqual('backoff Retry-After supera il tetto', backoffDelay(5, 2 * 3600 * S), 2 * 3600 * S);
}

function testResetDelay() {
    checkEqual('reset-delay usage null', nextResetFetchDelayS(null, NOW), null);
    checkEqual('reset-delay nessun reset futuro', nextResetFetchDelayS({fiveHour: win(-S), sevenDay: win(-MIN)}, NOW), null);
    checkEqual('reset-delay resetsAt null', nextResetFetchDelayS({fiveHour: {percent: 1, resetsAt: null}, sevenDay: null}, NOW), null);
    checkEqual('reset-delay 100 s + ritardo', nextResetFetchDelayS({fiveHour: win(100 * S), sevenDay: null}, NOW), 100 + RESET_FETCH_DELAY_S);
    checkEqual('reset-delay arrotonda per eccesso', nextResetFetchDelayS({fiveHour: win(100 * S + 1), sevenDay: null}, NOW), 101 + RESET_FETCH_DELAY_S);
    checkEqual('reset-delay prende il piu vicino', nextResetFetchDelayS({fiveHour: win(500 * S), sevenDay: win(200 * S)}, NOW), 200 + RESET_FETCH_DELAY_S);
    checkEqual('reset-delay ignora i passati', nextResetFetchDelayS({fiveHour: win(-S), sevenDay: win(300 * S)}, NOW), 300 + RESET_FETCH_DELAY_S);
    checkEqual('reset-delay tetto 3600', nextResetFetchDelayS(FRESH, NOW), 3600);
    checkEqual('reset-delay appena sotto il tetto', nextResetFetchDelayS({fiveHour: win((3600 - RESET_FETCH_DELAY_S) * S), sevenDay: null}, NOW), 3600);
    checkEqual('reset-delay reset == now non conta', nextResetFetchDelayS({fiveHour: win(0), sevenDay: null}, NOW), null);
}

testDue();
testExpired();
testMerge();
testBackoff();
testResetDelay();

print(`\n${passed} passati, ${failed} falliti`);
if (failed > 0)
    System.exit(1);
