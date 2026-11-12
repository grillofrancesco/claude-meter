// Test del modulo Usage Manager.
// Esecuzione: gjs -m tests/test-usage.js
// Non scrive mai in ~/.claude: le credenziali finte vivono in una dir temporanea.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import { UsageManager, UsageError, parseUsageResponse, parseRetryAfter } from '../lib/usageManager.js';

let passed = 0;

function testRetryAfter() {
    const now = Date.UTC(2026, 10, 12, 10, 0, 0);
    checkEqual('Retry-After secondi', parseRetryAfter('120', now), 120000);
    checkEqual('Retry-After 0 -> null', parseRetryAfter('0', now), null);
    checkEqual('Retry-After assente -> null', parseRetryAfter(null, now), null);
    checkEqual('Retry-After data HTTP', parseRetryAfter('Thu, 12 Nov 2026 10:01:00 GMT', now), 60000);
    checkEqual('Retry-After invalido -> null', parseRetryAfter('boh', now), null);
}
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
    check(name, Object.is(actual, expected), `atteso ${expected}, ottenuto ${actual}`);
}

function expectUsageError(name, fn, code) {
    try {
        fn();
        check(name, false, 'nessuna eccezione');
    } catch (e) {
        check(name, e instanceof UsageError && e.code === code,
            `ottenuto ${e?.name}/${e?.code ?? e?.message}`);
    }
}

async function expectUsageErrorAsync(name, fn, code) {
    try {
        await fn();
        check(name, false, 'nessuna eccezione');
    } catch (e) {
        check(name, e instanceof UsageError && e.code === code,
            `ottenuto ${e?.name}/${e?.code ?? e?.message}`);
    }
}

function removeRecursive(path) {
    const file = Gio.File.new_for_path(path);
    let type = null;
    try {
        type = file.query_info('standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_file_type();
    } catch {
        return;
    }
    if (type === Gio.FileType.DIRECTORY) {
        let enumerator = null;
        try {
            enumerator = file.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null)
                removeRecursive(GLib.build_filenamev([path, info.get_name()]));
        } catch {
            // ignora: è solo pulizia
        } finally {
            enumerator?.close(null);
        }
    }
    try {
        file.delete(null);
    } catch {
        // ignora: è solo pulizia
    }
}

const SAMPLE = {
    five_hour: {
        utilization: 2.0,
        resets_at: '2026-11-12T03:30:00.605967+00:00',
    },
    seven_day: {
        utilization: 46.0,
        resets_at: '2026-11-13T21:00:00.605987+00:00',
    },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
        {
            kind: 'session',
            group: 'session',
            percent: 2,
            severity: 'normal',
            resets_at: '2026-11-12T03:30:00+00:00',
            scope: null,
        },
        {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 46,
            resets_at: '2026-11-13T21:00:00+00:00',
            scope: null,
        },
        {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 63,
            resets_at: '2026-11-13T20:59:59+00:00',
            scope: {
                model: { id: null, display_name: 'Fable' },
                surface: null,
            },
        },
    ],
};

function testParser() {
    const usage = parseUsageResponse(SAMPLE);
    checkEqual('sample: fiveHour.percent', usage.fiveHour.percent, 2);
    check('sample: fiveHour.resetsAt è una Date', usage.fiveHour.resetsAt instanceof Date);
    checkEqual('sample: sevenDay.percent', usage.sevenDay.percent, 46);
    check('sample: sevenDay.resetsAt è una Date', usage.sevenDay.resetsAt instanceof Date);
    checkEqual('sample: scoped.length', usage.scoped.length, 1);
    checkEqual('sample: scoped label', usage.scoped[0].label, 'Fable');
    checkEqual('sample: scoped percent', usage.scoped[0].percent, 63);
    check('sample: fetchedAt è una Date', usage.fetchedAt instanceof Date);

    const onlyLimits = parseUsageResponse({
        limits: [
            { kind: 'session', percent: 12, resets_at: '2026-11-12T01:00:00+00:00' },
            { kind: 'weekly_all', percent: 34, resets_at: '2026-11-14T01:00:00+00:00' },
            { kind: 'weekly_scoped', percent: 56, resets_at: '2026-11-13T01:00:00+00:00',
              scope: { surface: 'cli' } },
        ],
    });
    checkEqual('limits fallback: fiveHour.percent', onlyLimits.fiveHour.percent, 12);
    checkEqual('limits fallback: sevenDay.percent', onlyLimits.sevenDay.percent, 34);
    checkEqual('limits fallback: scoped label surface', onlyLimits.scoped[0].label, 'cli');

    expectUsageError('garbage string -> invalid-response',
        () => parseUsageResponse('nope'), 'invalid-response');
    expectUsageError('garbage null -> invalid-response',
        () => parseUsageResponse(null), 'invalid-response');
    expectUsageError('nessuna finestra -> invalid-response',
        () => parseUsageResponse({ foo: 1 }), 'invalid-response');

    const over = parseUsageResponse({
        five_hour: { utilization: 140, resets_at: '2026-11-12T03:30:00+00:00' },
    });
    checkEqual('percent > 100 clampato', over.fiveHour.percent, 100);

    const negative = parseUsageResponse({
        five_hour: { utilization: -5, resets_at: '2026-11-12T03:30:00+00:00' },
    });
    checkEqual('percent < 0 clampato', negative.fiveHour.percent, 0);

    const badDate = parseUsageResponse({
        five_hour: { utilization: 10, resets_at: 'not-a-date' },
    });
    checkEqual('data non valida -> null', badDate.fiveHour.resetsAt, null);

    const legacy = parseUsageResponse({
        seven_day: { utilization: 40, resets_at: '2026-11-13T21:00:00+00:00' },
        seven_day_opus: { utilization: 20, resets_at: '2026-11-13T20:00:00+00:00' },
        seven_day_sonnet: null,
    });
    checkEqual('legacy opus: scoped.length', legacy.scoped.length, 1);
    checkEqual('legacy opus: label', legacy.scoped[0].label, 'Opus');
    checkEqual('legacy opus: percent', legacy.scoped[0].percent, 20);

    const legacyDedupe = parseUsageResponse({
        seven_day: { utilization: 40 },
        seven_day_opus: { utilization: 20 },
        limits: [
            { kind: 'weekly_scoped', percent: 30,
              scope: { model: { display_name: 'Opus' } } },
        ],
    });
    checkEqual('legacy non duplicato', legacyDedupe.scoped.length, 1);
    checkEqual('legacy non duplicato: percent da limits',
        legacyDedupe.scoped[0].percent, 30);

    const noPercent = parseUsageResponse({
        five_hour: {},
        limits: [{ kind: 'session', percent: 7 }, { kind: 'weekly_all', percent: 9 }],
    });
    checkEqual('utilization assente -> fallback limits', noPercent.fiveHour.percent, 7);
}

function writeCredentials(path, data) {
    GLib.file_set_contents(path, JSON.stringify(data));
}

async function testCredentials(tmpDir) {
    const missingPath = GLib.build_filenamev([tmpDir, 'missing.json']);
    const missingManager = new UsageManager(missingPath);
    const start = Date.now();
    await expectUsageErrorAsync('credenziali mancanti -> no-credentials',
        () => missingManager.fetch(), 'no-credentials');
    const elapsed = Date.now() - start;
    check('credenziali mancanti: nessuna rete (< 50 ms)', elapsed < 50, `${elapsed} ms`);
    missingManager.destroy();

    const expiredPath = GLib.build_filenamev([tmpDir, 'expired.json']);
    writeCredentials(expiredPath, {
        claudeAiOauth: {
            accessToken: 'fake-token',
            refreshToken: 'fake-refresh',
            expiresAt: Date.now() - 60_000,
            subscriptionType: 'max',
        },
    });
    const expiredManager = new UsageManager(expiredPath);
    const expiredStart = Date.now();
    await expectUsageErrorAsync('credenziali scadute -> expired',
        () => expiredManager.fetch(), 'expired');
    const expiredElapsed = Date.now() - expiredStart;
    check('credenziali scadute: nessuna rete (< 50 ms)', expiredElapsed < 50,
        `${expiredElapsed} ms`);
    expiredManager.destroy();

    const noTokenPath = GLib.build_filenamev([tmpDir, 'no-token.json']);
    writeCredentials(noTokenPath, { claudeAiOauth: { refreshToken: 'r' } });
    const noTokenManager = new UsageManager(noTokenPath);
    await expectUsageErrorAsync('accessToken assente -> no-credentials',
        () => noTokenManager.fetch(), 'no-credentials');
    noTokenManager.destroy();

    const corruptPath = GLib.build_filenamev([tmpDir, 'corrupt.json']);
    GLib.file_set_contents(corruptPath, 'not json');
    const corruptManager = new UsageManager(corruptPath);
    await expectUsageErrorAsync('credenziali corrotte -> no-credentials',
        () => corruptManager.fetch(), 'no-credentials');
    corruptManager.destroy();
}

async function testLive() {
    const manager = new UsageManager();
    try {
        const usage = await manager.fetch();
        print(`live fiveHour=${usage.fiveHour?.percent ?? null} ` +
            `sevenDay=${usage.sevenDay?.percent ?? null} scoped=${usage.scoped.length}`);
    } catch (e) {
        print(`live error=${e?.code ?? e?.message ?? 'unknown'}`);
    } finally {
        manager.destroy();
    }
}

async function main() {
    testParser();

    const tmpDir = GLib.dir_make_tmp('claude-meter-usage-XXXXXX');
    try {
        await testCredentials(tmpDir);
    } finally {
        removeRecursive(tmpDir);
    }

    testRetryAfter();
    await testLive();

    print(`\n${passed} passed, ${failed} failed`);
}

const loop = GLib.MainLoop.new(null, false);
main()
    .catch(e => {
        failed++;
        print(`FAIL errore inatteso: ${e?.message ?? e}`);
    })
    .finally(() => loop.quit());
loop.run();

System.exit(failed > 0 ? 1 : 0);
