// Tests for lib/sessionStore.js — run with: gjs -m tests/test-sessions.js
//
// All fixtures live in temp dirs (GLib.dir_make_tmp). trash_async is never
// called: SessionStore._trashPath is replaced by a fake. The final smoke test
// only READS the real ~/.claude via list() and prints counts, never content.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SessionStore} from '../lib/sessionStore.js';

const tmpDirs = [];
let passCount = 0;
let failCount = 0;

// ------------------------------------------------------------------ helpers

function makeTmpDir() {
    const dir = GLib.dir_make_tmp('claude-meter-sessions-XXXXXX');
    tmpDirs.push(dir);
    return dir;
}

function join(...parts) {
    return GLib.build_filenamev(parts);
}

function writeFile(path, content = '') {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, content);
}

function mkdir(path) {
    GLib.mkdir_with_parents(path, 0o755);
}

function setMtime(path, ms) {
    Gio.File.new_for_path(path).set_attribute_uint64('time::modified',
        Math.floor(ms / 1000), Gio.FileQueryInfoFlags.NONE, null);
}

const OLD = Date.now() - 24 * 3600 * 1000;

function removeTree(path) {
    const dir = Gio.File.new_for_path(path);
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch {
        return;
    }
    while (true) {
        const info = enumerator.next_file(null);
        if (!info)
            break;
        const child = join(path, info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            removeTree(child);
        else
            Gio.File.new_for_path(child).delete(null);
    }
    enumerator.close(null);
    dir.delete(null);
}

function assert(cond, msg) {
    if (!cond)
        throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected)
        throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function assertJson(actual, expected, msg) {
    assertEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
}

async function assertRejects(promiseFn, check, msg) {
    try {
        await promiseFn();
    } catch (e) {
        if (check && !check(e))
            throw new Error(`${msg}: wrong error ${e.message}`);
        return;
    }
    throw new Error(`${msg}: expected rejection`);
}

const L = o => `${JSON.stringify(o)}\n`;

// Fixture: a claudeDir + fake proc dir.
function makeEnv() {
    const root = makeTmpDir();
    const claude = join(root, 'claude');
    const proc = join(root, 'proc');
    mkdir(join(claude, 'projects'));
    mkdir(proc);
    return {claude, proc, store: new SessionStore(claude, proc)};
}

// Writes projects/<project>/<id>.jsonl (old mtime unless given), returns path.
function addConv(env, project, id, lines, mtime = OLD) {
    const file = join(env.claude, 'projects', project, `${id}.jsonl`);
    writeFile(file, lines.join(''));
    setMtime(file, mtime);
    return file;
}

function sessionFor(env, project, id) {
    const projectDir = join(env.claude, 'projects', project);
    return {sessionId: id, title: null, projectPath: null, projectDir,
        file: join(projectDir, `${id}.jsonl`), createdAt: null, lastUsedAt: null, active: false};
}

async function listOne(env, id) {
    return (await env.store.list()).find(s => s.sessionId === id);
}

// -------------------------------------------------------------------- cases

const cases = [];
function test(name, fn) {
    cases.push({name, fn});
}

test('title from ai-title', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's1', [L({type: 'ai-title', aiTitle: 'AI name', sessionId: 's1'})]);
    assertEqual((await listOne(env, 's1')).title, 'AI name', 'title');
});

test('title from custom-title', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's1', [L({type: 'custom-title', customTitle: 'Mine', sessionId: 's1'})]);
    assertEqual((await listOne(env, 's1')).title, 'Mine', 'title');
});

test('last title wins (custom then ai, and ai then custom)', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', [
        L({type: 'custom-title', customTitle: 'first'}),
        L({type: 'ai-title', aiTitle: 'second'}),
    ]);
    addConv(env, 'p', 'b', [
        L({type: 'ai-title', aiTitle: 'first'}),
        L({type: 'custom-title', customTitle: 'second'}),
        L({type: 'ai-title', aiTitle: ''}),
    ]);
    assertEqual((await listOne(env, 'a')).title, 'second', 'a');
    assertEqual((await listOne(env, 'b')).title, 'second', 'b (empty ignored)');
});

test('title beats user message even when user message comes later', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'user', message: {content: 'hello'}}),
        L({type: 'ai-title', aiTitle: 'T'}),
    ]);
    assertEqual((await listOne(env, 's')).title, 'T', 'title');
});

test('fallback to first user message: string content', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'user', isMeta: true, message: {content: 'meta noise'}}),
        L({type: 'user', isSidechain: true, message: {content: 'side noise'}}),
        L({type: 'user', message: {content: '  Ciao\n\n  mondo  '}}),
        L({type: 'user', message: {content: 'later'}}),
    ]);
    assertEqual((await listOne(env, 's')).title, 'Ciao mondo', 'title');
});

test('fallback to first user message: array content, tool results skipped', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'user', message: {content: [{type: 'tool_result', content: 'x'}]}}),
        L({type: 'user', message: {content: [{type: 'image'}, {type: 'text', text: 'from array'}]}}),
    ]);
    assertEqual((await listOne(env, 's')).title, 'from array', 'title');
});

test('fallback skips slash-command wrappers', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'user', message: {content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>'}}),
        L({type: 'user', message: {content: '<local-command-stdout></local-command-stdout>'}}),
        L({type: 'user', message: {content: [{type: 'text', text: '<local-command-caveat>x</local-command-caveat>'}]}}),
        L({type: 'user', message: {content: '<b>vero</b> messaggio'}}),
    ]);
    assertEqual((await listOne(env, 's')).title, '<b>vero</b> messaggio', 'title');
});

test('fallback truncates to ~80 chars with ellipsis', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'user', message: {content: 'x'.repeat(200)}})]);
    const t = (await listOne(env, 's')).title;
    assertEqual(t, `${'x'.repeat(80)}…`, 'title');
});

test('no title at all -> null', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'assistant', message: {content: 'hi'}}),
        L({type: 'user', isMeta: true, message: {content: 'meta'}}),
    ]);
    assertEqual((await listOne(env, 's')).title, null, 'title');
});

test('cwd and createdAt present', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        L({type: 'queue-operation'}),
        L({type: 'user', cwd: '/home/x/proj', timestamp: '2026-01-02T03:04:05.000Z', message: {content: 'a'}}),
        L({type: 'user', cwd: '/other', timestamp: '2027-01-01T00:00:00.000Z', message: {content: 'b'}}),
    ]);
    const s = await listOne(env, 's');
    assertEqual(s.projectPath, '/home/x/proj', 'cwd');
    assertEqual(s.createdAt.toISOString(), '2026-01-02T03:04:05.000Z', 'createdAt');
    assert(s.lastUsedAt instanceof Date, 'lastUsedAt is Date');
});

test('cwd and createdAt missing -> null', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x', timestamp: 'not a date'})]);
    const s = await listOne(env, 's');
    assertEqual(s.projectPath, null, 'cwd');
    assertEqual(s.createdAt, null, 'createdAt');
});

test('corrupt JSON lines skipped, valid ones still used', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [
        '{not json\n',
        '\n',
        L({type: 'ai-title', aiTitle: 'Survivor'}),
        '{"type":"ai-title","aiTitle":"trunc',
    ]);
    assertEqual((await listOne(env, 's')).title, 'Survivor', 'title');
});

test('very long lines and chunk boundaries are handled', async () => {
    const env = makeEnv();
    const big = L({type: 'assistant', blob: 'z'.repeat(600 * 1024)});
    addConv(env, 'p', 's', [
        L({type: 'user', cwd: '/c', message: {content: 'start'}}),
        big, big,
        L({type: 'ai-title', aiTitle: 'after big'}),
    ]);
    const s = await listOne(env, 's');
    assertEqual(s.title, 'after big', 'title');
    assertEqual(s.projectPath, '/c', 'cwd');
});

test('subagent files and memory are not conversations', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'ai-title', aiTitle: 'T'})]);
    writeFile(join(env.claude, 'projects', 'p', 's', 'subagents', 'agent-1.jsonl'), L({type: 'user'}));
    writeFile(join(env.claude, 'projects', 'p', 'memory', 'MEMORY.md'), 'x');
    writeFile(join(env.claude, 'projects', 'p', 'notes.txt'), 'x');
    const list = await env.store.list();
    assertEqual(list.length, 1, 'count');
    assertEqual(list[0].sessionId, 's', 'id');
    assertEqual(list[0].projectDir, join(env.claude, 'projects', 'p'), 'projectDir');
    assertEqual(list[0].file, join(env.claude, 'projects', 'p', 's.jsonl'), 'file');
});

test('missing projects/ and sessions/ -> empty list, no throw', async () => {
    const root = makeTmpDir();
    const store = new SessionStore(join(root, 'nothing'), join(root, 'proc'));
    assertJson(await store.list(), [], 'list');
});

test('ordering: most recently used first', async () => {
    const env = makeEnv();
    addConv(env, 'p1', 'old', [L({type: 'x'})], OLD);
    addConv(env, 'p2', 'older', [L({type: 'x'})], OLD - 5 * 3600 * 1000);
    addConv(env, 'p1', 'mid', [L({type: 'x'})], OLD - 3600 * 1000);
    assertJson((await env.store.list()).map(s => s.sessionId), ['old', 'mid', 'older'], 'order');
});

test('active: registry with live pid', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'live', [L({type: 'x'})]);
    addConv(env, 'p', 'dead', [L({type: 'x'})]);
    addConv(env, 'p', 'idle', [L({type: 'x'})]);
    mkdir(join(env.proc, '4242'));
    writeFile(join(env.claude, 'sessions', '4242.json'), JSON.stringify({pid: 4242, sessionId: 'live'}));
    writeFile(join(env.claude, 'sessions', '4343.json'), JSON.stringify({pid: 4343, sessionId: 'dead'}));
    const by = Object.fromEntries((await env.store.list()).map(s => [s.sessionId, s.active]));
    assertEqual(by.live, true, 'live');
    assertEqual(by.dead, false, 'dead pid');
    assertEqual(by.idle, false, 'idle');
});

test('active: .key / garbage / malformed registry files ignored', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'g', [L({type: 'x'})]);
    mkdir(join(env.proc, '1'));
    writeFile(join(env.claude, 'sessions', '1.abc.key'), JSON.stringify({pid: 1, sessionId: 'g'}));
    writeFile(join(env.claude, 'sessions', '1.json'), 'garbage{');
    writeFile(join(env.claude, 'sessions', '2.json'), JSON.stringify({pid: 1}));
    writeFile(join(env.claude, 'sessions', '3.json'), JSON.stringify({sessionId: 'g'}));
    assertEqual((await listOne(env, 'g')).active, false, 'active');
});

test('active: recent mtime without a live pid is NOT active', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'fresh', [L({type: 'x'})], Date.now() - 1000);
    assertEqual((await listOne(env, 'fresh')).active, false, 'fresh');
});

test('targets: only existing ones, fixed order, todos prefix match', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    addConv(env, 'p', 'other', [L({type: 'x'})]);
    mkdir(join(env.claude, 'projects', 'p', 's'));
    mkdir(join(env.claude, 'file-history', 's'));
    // session-env intentionally missing
    writeFile(join(env.claude, 'todos', 's-agent-s.json'), '[]');
    writeFile(join(env.claude, 'todos', 's.json'), '[]');
    writeFile(join(env.claude, 'todos', 'other-agent-other.json'), '[]');
    writeFile(join(env.claude, 'file-history', 'other', 'x'), 'x');
    const t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    const p = join(env.claude, 'projects', 'p');
    assertJson(t, [
        {path: join(p, 's.jsonl'), kind: 'conversation'},
        {path: join(p, 's'), kind: 'session-dir'},
        {path: join(env.claude, 'file-history', 's'), kind: 'file-history'},
        {path: join(env.claude, 'todos', 's-agent-s.json'), kind: 'todos'},
        {path: join(env.claude, 'todos', 's.json'), kind: 'todos'},
    ], 'targets');
});

test('targets: session-env included; nonexistent conversation not listed', async () => {
    const env = makeEnv();
    mkdir(join(env.claude, 'projects', 'p', 'keep'));
    mkdir(join(env.claude, 'session-env', 's'));
    const t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    assertJson(t, [{path: join(env.claude, 'session-env', 's'), kind: 'session-env'}], 'targets');
});

test('targets: project dir when it would be left empty', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    writeFile(join(env.claude, 'projects', 'p', 's', 'subagents', 'a.jsonl'), '');
    mkdir(join(env.claude, 'session-env', 's'));
    const t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    assertJson(t, [
        {path: join(env.claude, 'projects', 'p'), kind: 'project-dir'},
        {path: join(env.claude, 'session-env', 's'), kind: 'session-env'},
    ], 'targets');
});

test('targets: project dir when only memory/ would remain', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    writeFile(join(env.claude, 'projects', 'p', 'memory', 'MEMORY.md'), 'x');
    const t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    assertJson(t, [{path: join(env.claude, 'projects', 'p'), kind: 'project-dir'}], 'targets');
});

test('targets: project dir excluded when other conversations or files remain', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    addConv(env, 'p', 'other', [L({type: 'x'})]);
    let t = await env.store.getDeletionTargets(sessionFor(env, 'p', 's'));
    assertJson(t.map(x => x.kind), ['conversation'], 'other conversation');

    const env2 = makeEnv();
    addConv(env2, 'p', 's', [L({type: 'x'})]);
    writeFile(join(env2.claude, 'projects', 'p', 'stray.txt'), 'x');
    t = await env2.store.getDeletionTargets(sessionFor(env2, 'p', 's'));
    assertJson(t.map(x => x.kind), ['conversation'], 'stray file');

    const env3 = makeEnv();
    addConv(env3, 'p', 's', [L({type: 'x'})]);
    writeFile(join(env3.claude, 'projects', 'p', 'memory'), 'a file named memory');
    t = await env3.store.getDeletionTargets(sessionFor(env3, 'p', 's'));
    assertJson(t.map(x => x.kind), ['conversation'], 'memory is a file');
});

test('invalid session objects rejected', async () => {
    const env = makeEnv();
    const good = sessionFor(env, 'p', 's');
    const outside = makeTmpDir();
    const bads = [
        null,
        {},
        {...good, sessionId: ''},
        {...good, sessionId: '..'},
        {...good, sessionId: '.'},
        {...good, sessionId: 'a/b'},
        {...good, sessionId: 5},
        {...good, file: join(outside, 's.jsonl')},
        {...good, projectDir: outside},
        {...good, projectDir: env.claude},
        {...good, projectDir: join(env.claude, 'projects')},
        {...good, projectDir: join(env.claude, 'projects', 'p', '..', '..', 'x')},
        {...good, file: join(env.claude, 'projects', 'p', 'other.jsonl')},
        {...good, file: join(env.claude, 'projects', 'p', '..', 'p2', 's.jsonl')},
        {...good, file: 'relative/s.jsonl'},
    ];
    for (let i = 0; i < bads.length; i++) {
        await assertRejects(() => env.store.getDeletionTargets(bads[i]), null, `targets bad #${i}`);
        await assertRejects(() => env.store.trash(bads[i]), null, `trash bad #${i}`);
    }
});

test('trash refuses an active conversation (registry) and trashes nothing', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    mkdir(join(env.proc, '77'));
    writeFile(join(env.claude, 'sessions', '77.json'), JSON.stringify({pid: 77, sessionId: 's'}));
    const calls = [];
    env.store._trashPath = async p => calls.push(p);
    await assertRejects(() => env.store.trash(sessionFor(env, 'p', 's')),
        e => e.code === 'active', 'trash active');
    assertEqual(calls.length, 0, 'no trash calls');
});

test('trash accepts a recently modified conversation with no live pid', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})], Date.now() - 1000);
    const calls = [];
    env.store._trashPath = async p => calls.push(p);
    const res = await env.store.trash(sessionFor(env, 'p', 's'));
    assertEqual(res.trashed.length, 1, 'trashed');
    assertEqual(calls.length, 1, 'calls');
});

test('trash: success path trashes all targets in order', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    addConv(env, 'p', 'other', [L({type: 'x'})]);
    mkdir(join(env.claude, 'file-history', 's'));
    const calls = [];
    env.store._trashPath = async p => calls.push(p);
    const res = await env.store.trash(sessionFor(env, 'p', 's'));
    assertJson(res.trashed, calls, 'trashed == calls');
    assertEqual(res.trashed.length, 2, 'two targets');
    assertEqual(res.failed.length, 0, 'no failures');
});

test('trash: partial failure reported, continues after error', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    addConv(env, 'p', 'other', [L({type: 'x'})]);
    mkdir(join(env.claude, 'projects', 'p', 's'));
    mkdir(join(env.claude, 'file-history', 's'));
    writeFile(join(env.claude, 'todos', 's-agent-s.json'), '[]');
    const calls = [];
    const bad = join(env.claude, 'projects', 'p', 's');
    env.store._trashPath = async p => {
        calls.push(p);
        if (p === bad)
            throw new Error('boom');
    };
    const res = await env.store.trash(sessionFor(env, 'p', 's'));
    assertEqual(calls.length, 4, 'all four attempted');
    assertEqual(res.trashed.length, 3, 'three trashed');
    assertEqual(res.failed.length, 1, 'one failed');
    assertEqual(res.failed[0].path, bad, 'failed path');
    assertEqual(res.failed[0].message, 'boom', 'failed message');
});

// ------------------------------------------------------- multi / project

function markLive(env, pid, id) {
    mkdir(join(env.proc, String(pid)));
    writeFile(join(env.claude, 'sessions', `${pid}.json`), JSON.stringify({pid, sessionId: id}));
}

function fakeTrash(env, failOn = null) {
    const calls = [];
    env.store._trashPath = async p => {
        calls.push(p);
        if (p === failOn)
            throw new Error('boom');
    };
    return calls;
}

test('multi targets: two of three -> single targets, no project-dir', async () => {
    const env = makeEnv();
    for (const id of ['a', 'b', 'c'])
        addConv(env, 'p', id, [L({type: 'x'})]);
    const t = await env.store.getDeletionTargetsFor([sessionFor(env, 'p', 'a'), sessionFor(env, 'p', 'b')]);
    const p = join(env.claude, 'projects', 'p');
    assertJson(t, [
        {path: join(p, 'a.jsonl'), kind: 'conversation'},
        {path: join(p, 'b.jsonl'), kind: 'conversation'},
    ], 'targets');
});

test('multi targets: all conversations -> one project-dir', async () => {
    const env = makeEnv();
    for (const id of ['a', 'b', 'c'])
        addConv(env, 'p', id, [L({type: 'x'})]);
    mkdir(join(env.claude, 'projects', 'p', 'a'));
    mkdir(join(env.claude, 'projects', 'p', 'memory'));
    const t = await env.store.getDeletionTargetsFor(['a', 'b', 'c'].map(i => sessionFor(env, 'p', i)));
    assertJson(t, [{path: join(env.claude, 'projects', 'p'), kind: 'project-dir'}], 'targets');
});

test('multi targets: all conversations but a stray file remains -> no project-dir', async () => {
    const env = makeEnv();
    for (const id of ['a', 'b'])
        addConv(env, 'p', id, [L({type: 'x'})]);
    writeFile(join(env.claude, 'projects', 'p', 'stray.txt'), 'x');
    const t = await env.store.getDeletionTargetsFor(['a', 'b'].map(i => sessionFor(env, 'p', i)));
    assertJson(t.map(x => x.kind), ['conversation', 'conversation'], 'kinds');
});

test('multi targets: rule applied project by project', async () => {
    const env = makeEnv();
    addConv(env, 'p1', 'a', [L({type: 'x'})]);
    addConv(env, 'p2', 'b', [L({type: 'x'})]);
    addConv(env, 'p2', 'c', [L({type: 'x'})]);
    const t = await env.store.getDeletionTargetsFor([
        sessionFor(env, 'p1', 'a'), sessionFor(env, 'p2', 'b')]);
    assertJson(t, [
        {path: join(env.claude, 'projects', 'p1'), kind: 'project-dir'},
        {path: join(env.claude, 'projects', 'p2', 'b.jsonl'), kind: 'conversation'},
    ], 'targets');
});

test('multi targets: linked data per conversation, no duplicates', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', [L({type: 'x'})]);
    addConv(env, 'p', 'b', [L({type: 'x'})]);
    addConv(env, 'p', 'keep', [L({type: 'x'})]);
    mkdir(join(env.claude, 'file-history', 'a'));
    mkdir(join(env.claude, 'session-env', 'b'));
    writeFile(join(env.claude, 'todos', 'a-agent-a.json'), '[]');
    writeFile(join(env.claude, 'todos', 'b-agent-b.json'), '[]');
    const sa = sessionFor(env, 'p', 'a');
    const t = await env.store.getDeletionTargetsFor([sa, sessionFor(env, 'p', 'b'), sa]);
    const paths = t.map(x => x.path);
    assertEqual(new Set(paths).size, paths.length, 'no duplicates');
    assertEqual(t.length, 6, 'two conversations + 4 linked');
    assert(t.some(x => x.kind === 'file-history') && t.some(x => x.kind === 'session-env'), 'linked kinds');
    assertEqual(t.filter(x => x.kind === 'todos').length, 2, 'todos');
});

test('multi targets: single element equals getDeletionTargets', async () => {
    const env = makeEnv();
    addConv(env, 'p', 's', [L({type: 'x'})]);
    addConv(env, 'p', 'o', [L({type: 'x'})]);
    mkdir(join(env.claude, 'projects', 'p', 's'));
    mkdir(join(env.claude, 'file-history', 's'));
    writeFile(join(env.claude, 'todos', 's-agent-s.json'), '[]');
    const s = sessionFor(env, 'p', 's');
    assertJson(await env.store.getDeletionTargetsFor([s]), await env.store.getDeletionTargets(s), 'same');
    assertJson(await env.store.getDeletionTargetsFor([]), [], 'empty');
});

test('trashMany: active one skipped, others trashed, project-dir kept', async () => {
    const env = makeEnv();
    for (const id of ['a', 'b', 'live'])
        addConv(env, 'p', id, [L({type: 'x'})]);
    markLive(env, 91, 'live');
    const calls = fakeTrash(env);
    const live = sessionFor(env, 'p', 'live');
    const res = await env.store.trashMany([sessionFor(env, 'p', 'a'), live, sessionFor(env, 'p', 'b')]);
    const p = join(env.claude, 'projects', 'p');
    assertJson(calls, [join(p, 'a.jsonl'), join(p, 'b.jsonl')], 'calls');
    assertJson(res.trashed, calls, 'trashed');
    assertEqual(res.skippedActive.length, 1, 'skipped count');
    assertEqual(res.skippedActive[0], live, 'skipped is the original object');
    assertEqual(res.failed.length, 0, 'no failures');
});

test('trashMany: error on one target, the others proceed', async () => {
    const env = makeEnv();
    for (const id of ['a', 'b', 'c'])
        addConv(env, 'p', id, [L({type: 'x'})]);
    const p = join(env.claude, 'projects', 'p');
    const calls = fakeTrash(env, join(p, 'a.jsonl'));
    const res = await env.store.trashMany([sessionFor(env, 'p', 'a'), sessionFor(env, 'p', 'b')]);
    assertEqual(calls.length, 2, 'both attempted');
    assertJson(res.trashed, [join(p, 'b.jsonl')], 'trashed');
    assertEqual(res.failed.length, 1, 'failed count');
    assertEqual(res.failed[0].message, 'boom', 'message');
});

test('trashMany: invalid session -> throws, nothing trashed', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', [L({type: 'x'})]);
    const calls = fakeTrash(env);
    await assertRejects(() => env.store.trashMany([
        sessionFor(env, 'p', 'a'), {...sessionFor(env, 'p', 'a'), sessionId: '..'}]), null, 'bad');
    await assertRejects(() => env.store.trashMany(null), null, 'not an array');
    assertEqual(calls.length, 0, 'no calls');
});

test('list: Session.size is the .jsonl size in bytes', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', ['x'.repeat(1234)]);
    writeFile(join(env.claude, 'projects', 'p', 'a', 'sub.bin'), 'y'.repeat(999));
    assertEqual((await listOne(env, 'a')).size, 1234, 'size');
});

test('getTargetsSize: nested dirs, missing path, symlink not followed', async () => {
    const env = makeEnv();
    const d = join(env.claude, 'data');
    writeFile(join(d, 'a.txt'), 'x'.repeat(100));
    writeFile(join(d, 'n', 'm', 'b.txt'), 'x'.repeat(50));
    writeFile(join(env.claude, 'big.bin'), 'x'.repeat(100000));
    Gio.File.new_for_path(join(d, 'link')).make_symbolic_link(join(env.claude, 'big.bin'), null);
    assertEqual(await env.store.getTargetsSize([{path: d, kind: 'x'}]), 150, 'dir');
    assertEqual(await env.store.getTargetsSize([
        {path: d, kind: 'x'}, {path: join(env.claude, 'missing'), kind: 'x'},
        {path: join(env.claude, 'big.bin'), kind: 'x'}]), 100150, 'sum with missing');
    assertEqual(await env.store.getTargetsSize([]), 0, 'empty');
});

test('trashMany: trashedBytes sums trashed targets, failed excluded', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', ['x'.repeat(10)]);
    addConv(env, 'p', 'b', ['x'.repeat(20)]);
    addConv(env, 'p', 'c', ['x'.repeat(40)]);
    writeFile(join(env.claude, 'file-history', 'b', 'h'), 'x'.repeat(5));
    const p = join(env.claude, 'projects', 'p');
    fakeTrash(env, join(p, 'a.jsonl'));
    const res = await env.store.trashMany([sessionFor(env, 'p', 'a'), sessionFor(env, 'p', 'b')]);
    assertEqual(res.trashedBytes, 25, 'only b + its history');
});

test('trashMany: empty list is a no-op', async () => {
    const env = makeEnv();
    const calls = fakeTrash(env);
    assertJson(await env.store.trashMany([]), {trashed: [], failed: [], skippedActive: [], trashedBytes: 0}, 'result');
    assertEqual(calls.length, 0, 'no calls');
});

test('project targets: project-dir plus linked data of all sessions', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', [L({type: 'x'})]);
    addConv(env, 'p', 'b', [L({type: 'x'})]);
    writeFile(join(env.claude, 'projects', 'p', 'memory', 'MEMORY.md'), 'x');
    writeFile(join(env.claude, 'projects', 'p', 'extra.txt'), 'x');
    mkdir(join(env.claude, 'file-history', 'a'));
    mkdir(join(env.claude, 'session-env', 'b'));
    writeFile(join(env.claude, 'todos', 'b-agent-b.json'), '[]');
    addConv(env, 'q', 'z', [L({type: 'x'})]);
    mkdir(join(env.claude, 'file-history', 'z'));
    const dir = join(env.claude, 'projects', 'p');
    assertJson(await env.store.getProjectDeletionTargets(dir), [
        {path: dir, kind: 'project-dir'},
        {path: join(env.claude, 'file-history', 'a'), kind: 'file-history'},
        {path: join(env.claude, 'session-env', 'b'), kind: 'session-env'},
        {path: join(env.claude, 'todos', 'b-agent-b.json'), kind: 'todos'},
    ], 'targets');
    const calls = fakeTrash(env);
    const res = await env.store.trashProject(dir);
    assertJson(res.trashed, calls, 'trashed');
    assertEqual(res.trashed.length, 4, 'four');
    assertEqual(res.failed.length, 0, 'no failures');
});

test('trashProject: active conversation -> code active, nothing trashed', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', [L({type: 'x'})]);
    addConv(env, 'p', 'b', [L({type: 'x'})]);
    markLive(env, 92, 'b');
    const calls = fakeTrash(env);
    await assertRejects(() => env.store.trashProject(join(env.claude, 'projects', 'p')),
        e => e.code === 'active', 'active');
    assertEqual(calls.length, 0, 'no calls');
});

test('project: conversation created after list() is covered', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', [L({type: 'x'})]);
    await env.store.list();
    addConv(env, 'p', 'late', [L({type: 'x'})]);
    mkdir(join(env.claude, 'file-history', 'late'));
    const dir = join(env.claude, 'projects', 'p');
    const t = await env.store.getProjectDeletionTargets(dir);
    assert(t.some(x => x.path === join(env.claude, 'file-history', 'late')), 'late linked data');
    // an active late conversation blocks as well
    markLive(env, 93, 'late');
    await assertRejects(() => env.store.trashProject(dir), e => e.code === 'active', 'late active');
});

test('project: dir outside projects/ or with .. rejected', async () => {
    const env = makeEnv();
    addConv(env, 'p', 'a', [L({type: 'x'})]);
    const outside = makeTmpDir();
    const calls = fakeTrash(env);
    const bads = [
        outside,
        env.claude,
        join(env.claude, 'projects'),
        join(env.claude, 'projects', 'p', 'sub'),
        join(env.claude, 'projects', 'p', '..', 'p'),
        join(env.claude, 'projects', 'p', '..', '..', 'x'),
        'relative/p',
        '',
        null,
    ];
    for (let i = 0; i < bads.length; i++) {
        await assertRejects(() => env.store.getProjectDeletionTargets(bads[i]), null, `targets bad #${i}`);
        await assertRejects(() => env.store.trashProject(bads[i]), null, `trash bad #${i}`);
    }
    assertEqual(calls.length, 0, 'no calls');
});

// -------------------------------------------------------------------- smoke

async function smokeTest() {
    const store = new SessionStore();
    const list = await store.list();
    const active = list.filter(s => s.active).length;
    const noTitle = list.filter(s => s.title === null).length;
    const noPath = list.filter(s => s.projectPath === null).length;
    print(`SMOKE sessions=${list.length} active=${active} nullTitle=${noTitle} nullProjectPath=${noPath}`);
}

// -------------------------------------------------------------------- entry

let exitCode = 0;
const loop = new GLib.MainLoop(null, false);

(async () => {
    for (const {name, fn} of cases) {
        try {
            await fn();
            print(`PASS ${name}`);
            passCount += 1;
        } catch (e) {
            print(`FAIL ${name}: ${e.message}`);
            failCount += 1;
        }
    }
    try {
        await smokeTest();
    } catch (e) {
        print(`FAIL smoke: ${e.message}`);
        failCount += 1;
    }
    for (const dir of tmpDirs) {
        try {
            removeTree(dir);
        } catch {
            // Best-effort cleanup.
        }
    }
    print(`SUMMARY pass=${passCount} fail=${failCount}`);
    exitCode = failCount === 0 ? 0 : 1;
    loop.quit();
})();

loop.run();
System.exit(exitCode);
