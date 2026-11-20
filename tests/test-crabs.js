// Tests for lib/crabs.js (pure module): gjs -m tests/test-crabs.js
import System from 'system';

import {CrabRow, PLACEHOLDER_ID, compileAnimations, COMPILED_ANIMATIONS, COMPILED_GRID, FPS, SPRITE_W, CRAB_GAP, CRAB_SLOT, panelWidths, splitSessions, RING_SIZE, PANEL_SPACING, MORE_WIDTH, HIGHLIGHT_PAD, SPRITE_H, PIXEL}
    from '../lib/crabs.js';
import {ANIMATIONS, PALETTE, STATES, GRID_W, GRID_H, SPRITE_HEIGHT} from '../lib/sprites.js';

let total = 0;
let failures = 0;

function check(name, condition, detail = null) {
    total++;
    if (condition) {
        print(`PASS ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}${detail === null ? '' : ` — ${detail}`}`);
    }
}

function throws(fn, re) {
    try {
        fn();
    } catch (e) {
        return re.test(e.message);
    }
    return false;
}

const works = Array.isArray(STATES.work) ? STATES.work : [STATES.work];
const nameOf = (row, id = 'a') => row.frames().find(f => f.id === id).animation;
const stateOf = (row, id = 'a') => row.frames().find(f => f.id === id).state;
const lenOf = name => COMPILED_ANIMATIONS[name].frames.length;
const steps = (row, n) => { for (let i = 0; i < n; i++) row.step(); };

function testCompile() {
    check('griglia 16x13, sprite 26 px', GRID_W === 16 && GRID_H === 13 && COMPILED_GRID.width === 16 &&
        COMPILED_GRID.height === 13 && SPRITE_HEIGHT === 26 && GRID_H * PIXEL === SPRITE_HEIGHT && SPRITE_H === 26);
    for (const name of [STATES.sleep, STATES.start, STATES.done, ...works])
        check(`animazione '${name}' compilata`, Boolean(COMPILED_ANIMATIONS[name]?.frames.length));
    const f = COMPILED_ANIMATIONS[STATES.sleep].frames[0];
    check('layer con rgba 0..1 e pixel',
        f.layers.length > 0 && f.layers.every(l => l.rgba.length === 4 && l.rgba.every(v => v >= 0 && v <= 1) &&
            l.pixels.length > 0));
    check('FPS = 8', FPS === 8);

    const pal = {X: [255, 0, 0, 255], Y: [0, 0, 255, 128]};
    const st = {sleep: 'a', start: 'a', work: ['a'], done: 'a'};
    const ok = {a: {loop: true, seconds: null, frames: [['X.', '.Y']]}};
    const c = compileAnimations(ok, pal, st);
    check('compile minimo: 2 layer', c.animations.a.frames[0].layers.length === 2 && c.width === 2 && c.height === 2);
    check('alpha preservato', Math.abs(c.animations.a.frames[0].layers[1].rgba[3] - 128 / 255) < 1e-9);
    check('errore carattere sconosciuto', throws(() =>
        compileAnimations({a: {loop: true, frames: [['X?', '..']]}}, pal, st), /sconosciuto '\?'.*'a' frame 0 riga 0/));
    check('errore stato mancante', throws(() => compileAnimations(ok, pal, {...st, done: 'zzz'}), /'zzz' mancante/));
    check('errore riga di lunghezza errata', throws(() =>
        compileAnimations({a: {loop: true, frames: [['XX', '.']]}}, pal, st), /riga 1/));
    check('errore frame vuoti', throws(() => compileAnimations({a: {loop: true, frames: []}}, pal, st), /non ha frame/));
    check('errore griglia incoerente tra frame', throws(() =>
        compileAnimations({a: {loop: true, frames: [['XX', '..'], ['XXX', '...']]}}, pal, st), /colonne/));
}

function testMachine() {
    const row = new CrabRow(() => 0);
    row.sync([{id: 'a', busy: true}, {id: 'b', busy: false}]);
    check('nuovo busy parte in work', stateOf(row, 'a') === 'work' && nameOf(row, 'a') === works[0]);
    check('nuovo idle parte in sleep', stateOf(row, 'b') === 'sleep' && nameOf(row, 'b') === STATES.sleep);

    // idle -> busy: start plays all frames, then work
    const r = new CrabRow(() => 0);
    r.sync([{id: 'a', busy: false}]);
    r.sync([{id: 'a', busy: true}]);
    const startLen = lenOf(STATES.start);
    check('idle->busy: start', stateOf(r) === 'start');
    const seen = [r.frames()[0].sprite];
    for (let i = 0; i < startLen - 1; i++) {
        r.step();
        seen.push(r.frames()[0].sprite);
    }
    check('start mostra tutti i frame', new Set(seen).size === startLen && stateOf(r) === 'start',
        `${new Set(seen).size}/${startLen}`);
    r.step();
    check('dopo start -> work', stateOf(r) === 'work');

    // busy -> idle: done for seconds*FPS ticks
    r.sync([{id: 'a', busy: false}]);
    const doneAnim = COMPILED_ANIMATIONS[STATES.done];
    const n = Math.round((doneAnim.seconds ?? doneAnim.frames.length / FPS) * FPS);
    check('done dura 16 tick (2 s)', n === 16, `${n}`);
    check('busy->idle: done', stateOf(r) === 'done');
    steps(r, n - 1);
    check('ancora done prima della fine', stateOf(r) === 'done');
    r.step();
    check('dopo done -> sleep', stateOf(r) === 'sleep');

    // busy flip during start: finishes start then done
    const s = new CrabRow(() => 0);
    s.sync([{id: 'a', busy: false}]);
    s.sync([{id: 'a', busy: true}]);
    s.step();
    s.sync([{id: 'a', busy: false}]);
    check('flip durante start: start continua', stateOf(s) === 'start');
    steps(s, startLen - 1);
    check('fine start con idle -> done', stateOf(s) === 'done');

    // flip back during done: finish done then start
    s.sync([{id: 'a', busy: true}]);
    check('flip durante done: done continua', stateOf(s) === 'done');
    steps(s, n - 1);
    check('ancora done', stateOf(s) === 'done');
    s.step();
    check('fine done con busy -> start', stateOf(s) === 'start');

    // looping states react immediately
    const l = new CrabRow(() => 0);
    l.sync([{id: 'a', busy: true}]);
    l.sync([{id: 'a', busy: false}]);
    check('work -> done subito', stateOf(l) === 'done');
}

function testWorkChoice() {
    const seq = [0, 0.99, 0];
    let i = 0;
    const row = new CrabRow(() => seq[i++ % seq.length]);
    row.sync([{id: 'a', busy: true}, {id: 'b', busy: true}]);
    check('work casuale iniettato', nameOf(row, 'a') === works[0] && nameOf(row, 'b') === works[works.length - 1]);
    for (let k = 0; k < 40; k++) {
        row.sync([{id: 'a', busy: k % 2 === 0}, {id: 'b', busy: true}]);
        steps(row, 7);
    }
    row.sync([{id: 'a', busy: true}, {id: 'b', busy: true}]);
    steps(row, 40);
    check('work stabile per sessione', nameOf(row, 'a') === works[0] && nameOf(row, 'b') === works[works.length - 1]);
}

function testSlots() {
    const row = new CrabRow(() => 0);
    row.sync([{id: 'a', busy: false}, {id: 'b', busy: false}, {id: 'c', busy: false}]);
    check('slot x = i*CRAB_SLOT', row.frames().every((f, i) => f.x === i * CRAB_SLOT));
    row.sync([{id: 'a', busy: false}, {id: 'c', busy: false}]);
    const fr = row.frames();
    check('compattazione a sinistra', row.size === 2 && fr[0].id === 'a' && fr[1].id === 'c' && fr[1].x === CRAB_SLOT);
    row.sync([{id: 'a', busy: false}, {id: 'c', busy: false}, {id: 'd', busy: false}]);
    check('nuova sessione a destra', row.frames()[2].id === 'd' && row.frames()[2].x === 2 * CRAB_SLOT);

    check('widthFor(0) = 0', CrabRow.widthFor(0) === 0);
    check('widthFor(3)', CrabRow.widthFor(3) === 3 * CRAB_SLOT - CRAB_GAP);
    check('capacity(widthFor(n)) = n', [1, 2, 3, 5].every(n => CrabRow.capacity(CrabRow.widthFor(n)) === n));
    check('capacity troppo stretto = 0', CrabRow.capacity(SPRITE_W - 1) === 0 && CrabRow.capacity(0) === 0);
    check('capacity un pixel sotto', CrabRow.capacity(CrabRow.widthFor(3) - 1) === 2);

    // panelWidths
    check('panelWidths vuoto = 0', panelWidths().total === 0 && panelWidths().crabs === 0);
    check('panelWidths 0..10 granchi = widthFor', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every(n =>
        panelWidths({crabs: n}).crabs === CrabRow.widthFor(n) && panelWidths({crabs: n}).total === CrabRow.widthFor(n)));
    const HP = 2 * HIGHLIGHT_PAD;
    check('panelWidths solo anelli', panelWidths({rings: 1}).total === RING_SIZE + HP &&
        panelWidths({rings: 2}).total === 2 * RING_SIZE + PANEL_SPACING + HP);
    check('panelWidths granchi + anelli', panelWidths({crabs: 3, rings: 2}).total ===
        CrabRow.widthFor(3) + 2 * RING_SIZE + 2 * PANEL_SPACING + HP);
    check('panelWidths con +N', panelWidths({crabs: 3, more: 2, rings: 2}).total ===
        CrabRow.widthFor(3) + MORE_WIDTH + 2 * RING_SIZE + 3 * PANEL_SPACING + HP &&
        panelWidths({crabs: 3, more: 2, rings: 2}).crabs === CrabRow.widthFor(3));
    check('panelWidths +N senza anelli', panelWidths({crabs: 1, more: true}).total ===
        CrabRow.widthFor(1) + PANEL_SPACING + MORE_WIDTH);
    check('panelWidths 10 granchi, +N, 2 anelli', panelWidths({crabs: 10, more: 1, rings: 2}).total ===
        10 * CRAB_SLOT - CRAB_GAP + MORE_WIDTH + 2 * RING_SIZE + 3 * PANEL_SPACING + HP);

    // splitSessions
    {
        const s5 = [1, 2, 3, 4, 5].map(i => ({id: `s${i}`}));
        const a = splitSessions(s5, 3);
        check('split 5 sessioni max 3', a.shown.length === 3 && a.hidden === 2 && a.shown[0].id === 's1' && a.shown[2].id === 's3');
        const b = splitSessions(s5.slice(0, 2), 3);
        check('split 2 sessioni max 3', b.shown.length === 2 && b.hidden === 0);
        const c = splitSessions(s5, 3, false);
        check('split granchi disabilitati', c.shown.length === 0 && c.hidden === 0);
        check('split nessuna sessione', splitSessions([], 3).shown.length === 0 && splitSessions([], 3).hidden === 0);
        check('split max 10', splitSessions(s5, 10).hidden === 0);
    }
}

function testStepAndAnimating() {
    const row = new CrabRow(() => 0);
    check('riga vuota: step false, non animating', row.step() === false && row.animating === false);
    row.sync([{id: 'a', busy: false}]);
    const sleepFrames = lenOf(STATES.sleep);
    check('animating segue i frame di sleep', row.animating === (sleepFrames > 1));
    if (sleepFrames > 1) {
        check('step true se il frame cambia', row.step() === true);
    } else {
        check('step false se un solo frame', row.step() === false);
    }
    // a work animation with a single frame would not change; emulate with a static source
    const pal = {X: [1, 2, 3, 255]};
    const st = {sleep: 'a', start: 'b', work: ['a'], done: 'a'};
    const anims = compileAnimations({
        a: {loop: true, seconds: 1, frames: [['X']]},
        b: {loop: false, seconds: null, frames: [['X'], ['X']]},
    }, pal, st).animations;
    const s = new CrabRow(() => 0, anims, st);
    s.sync([{id: 'a', busy: false}]);
    check('un frame: non animating', s.animating === false);
    check('un frame: step false', s.step() === false);
    s.sync([{id: 'a', busy: true}]);
    check('in transizione: animating', s.animating === true && stateOf(s) === 'start');
    check('start 2 frame: step true', s.step() === true);
}

function testPlaceholder() {
    const P = {placeholder: true};
    const doneTicks = Math.max(1, Math.round((COMPILED_ANIMATIONS[STATES.done].seconds ??
        lenOf(STATES.done) / FPS) * FPS));
    let row = new CrabRow(() => 0);
    row.sync([], P);
    check('placeholder: un granchio che dorme',
        row.size === 1 && row.frames()[0].id === PLACEHOLDER_ID && row.frames()[0].state === 'sleep' &&
        row.frames()[0].x === 0);
    row.sync([]);
    check('senza placeholder: nessun granchio', row.size === 0);
    row.sync([], P);
    row.sync([]);
    check('placeholder spento senza sessioni svuota la riga', row.size === 0);

    // adoption, busy
    row = new CrabRow(() => 0);
    row.sync([], P);
    steps(row, 5);
    const crab = row._crabs[0];
    row.sync([{id: 'a', busy: true}], P);
    check('adozione: stesso oggetto, id nuovo, in start',
        row._crabs[0] === crab && crab.id === 'a' && stateOf(row) === 'start');
    steps(row, lenOf(STATES.start) - 1);
    check('adozione: ancora start prima della fine', stateOf(row) === 'start');
    row.step();
    check('adozione: dopo i frame di start passa a work', stateOf(row) === 'work' &&
        nameOf(row) === crab.workName);

    // adoption, idle
    row = new CrabRow(() => 0);
    row.sync([], P);
    steps(row, 5);
    const c2 = row._crabs[0];
    const tick = c2.tick;
    row.sync([{id: 'a', busy: false}], P);
    check('adozione idle: resta in sleep senza reset del tick',
        row._crabs[0] === c2 && stateOf(row) === 'sleep' && c2.tick === tick && tick > 0);

    // release from work
    row = new CrabRow(() => 0);
    row.sync([{id: 'a', busy: true}], P);
    const c3 = row._crabs[0];
    row.sync([], P);
    check('rilascio: stesso oggetto, placeholder, done', row._crabs[0] === c3 &&
        c3.id === PLACEHOLDER_ID && stateOf(row, PLACEHOLDER_ID) === 'done');
    steps(row, doneTicks - 1);
    check('rilascio: done per seconds*FPS tick', stateOf(row, PLACEHOLDER_ID) === 'done');
    row.step();
    check('rilascio: poi sleep', stateOf(row, PLACEHOLDER_ID) === 'sleep');

    // release with 3 sessions keeps slot 0
    row = new CrabRow(() => 0);
    row.sync([{id: 'a', busy: false}, {id: 'b', busy: false}, {id: 'c', busy: false}], P);
    const c0 = row._crabs[0];
    row.sync([], P);
    check('rilascio da 3 sessioni: resta il granchio dello slot 0', row.size === 1 && row._crabs[0] === c0);
    row.sync([], P);
    check('placeholder ripetuto idempotente', row.size === 1 && row._crabs[0] === c0);
}

try {
    testCompile();
    testMachine();
    testWorkChoice();
    testSlots();
    testStepAndAnimating();
    testPlaceholder();
} catch (e) {
    failures++;
    print(`FAIL eccezione: ${e.message}\n${e.stack}`);
}
print(`${total - failures}/${total} test passati`);
System.exit(failures > 0 ? 1 : 0);
