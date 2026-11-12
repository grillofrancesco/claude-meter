// Tests for lib/tokenParser.js — run with: gjs -m tests/test-parser.js
//
// All fixtures live in temp dirs created with GLib.dir_make_tmp; nothing is
// written to ~/.claude or ~/.local/share. The final smoke test only READS the
// real projects dir and prints aggregate numbers, never content.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {TokenParser} from '../lib/tokenParser.js';

const tmpDirs = [];
let passCount = 0;
let failCount = 0;

// ------------------------------------------------------------------ helpers

function makeTmpDir() {
    const dir = GLib.dir_make_tmp('claude-meter-parser-XXXXXX');
    tmpDirs.push(dir);
    return dir;
}

function writeFile(path, content) {
    const parent = GLib.path_get_dirname(path);
    GLib.mkdir_with_parents(parent, 0o755);
    GLib.file_set_contents(path, content);
}

function readFile(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error(`cannot read fixture ${path}`);
    return new TextDecoder('utf-8').decode(bytes);
}

function appendFile(path, content) {
    writeFile(path, readFile(path) + content);
}

function removeTree(path) {
    const dir = Gio.File.new_for_path(path);
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return;
    }
    while (true) {
        const info = enumerator.next_file(null);
        if (!info)
            break;
        const child = GLib.build_filenamev([path, info.get_name()]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            removeTree(child);
        else
            Gio.File.new_for_path(child).delete(null);
    }
    enumerator.close(null);
    dir.delete(null);
}

function freshState() {
    return {files: {}, seen: {}};
}

function iso(ms) {
    return new Date(ms).toISOString();
}

function byteLength(str) {
    return new TextEncoder().encode(str).length;
}

function usageLine({
    messageId = 'msg_1',
    requestId = 'req_1',
    timestamp = Date.now(),
    input = 0,
    output = 0,
    cacheCreation = 0,
    cacheRead = 0,
    sessionId = 'sess-1',
    uuid = null,
    omitMessageId = false,
    omitRequestId = false,
} = {}) {
    const obj = {
        type: 'assistant',
        timestamp: iso(timestamp),
        sessionId,
    };
    if (!omitRequestId)
        obj.requestId = requestId;
    if (uuid !== null)
        obj.uuid = uuid;
    const message = {
        usage: {
            input_tokens: input,
            output_tokens: output,
            cache_creation_input_tokens: cacheCreation,
            cache_read_input_tokens: cacheRead,
        },
    };
    if (!omitMessageId)
        message.id = messageId;
    obj.message = message;
    return JSON.stringify(obj);
}

function assert(cond, msg) {
    if (!cond)
        throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected)
        throw new Error(`${msg} (expected ${expected}, got ${actual})`);
}

function bytesWritten(path) {
    return Gio.File.new_for_path(path).query_info('standard::size',
        Gio.FileQueryInfoFlags.NONE, null).get_size();
}

// Count read_bytes_async invocations to prove "no re-read" when nothing changed.
function instrumentReads() {
    const proto = Gio.InputStream.prototype;
    const original = proto.read_bytes_async;
    let count = 0;
    proto.read_bytes_async = function (...args) {
        count += 1;
        return original.apply(this, args);
    };
    return {
        get count() {
            return count;
        },
        restore() {
            proto.read_bytes_async = original;
        },
    };
}

async function run(name, fn) {
    try {
        await fn();
        passCount += 1;
        print(`PASS ${name}`);
    } catch (e) {
        failCount += 1;
        print(`FAIL ${name}: ${e.message}`);
    }
}

// -------------------------------------------------------------------- cases

async function runCases() {
    await run('1. same message.id+requestId counted once', async () => {
        const dir = makeTmpDir();
        const file = GLib.build_filenamev([dir, 'proj', 'session.jsonl']);
        const line = usageLine({messageId: 'msg_dup', requestId: 'req_dup',
            timestamp: Date.now(), input: 10, output: 5});
        writeFile(file, `${line}\n${line}\n`);

        const parser = new TokenParser(dir);
        const state = freshState();
        const records = await parser.scan(state);

        assertEqual(records.length, 1, 'one record expected');
        assertEqual(records[0].key, 'msg_dup:req_dup', 'key');
        assertEqual(records[0].input, 10, 'input');
        assertEqual(records[0].output, 5, 'output');
        assertEqual(state.seen['msg_dup:req_dup'] !== undefined, true, 'seen populated');
    });

    await run('2. cache tokens kept separate from input', async () => {
        const dir = makeTmpDir();
        const file = GLib.build_filenamev([dir, 'proj', 'a.jsonl']);
        writeFile(file, `${usageLine({messageId: 'm2', requestId: 'r2',
            input: 7, output: 3, cacheCreation: 1000, cacheRead: 2000})}\n`);

        const parser = new TokenParser(dir);
        const records = await parser.scan(freshState());

        assertEqual(records.length, 1, 'record count');
        assertEqual(records[0].input, 7, 'input excludes cache creation');
        assertEqual(records[0].cacheCreation, 1000, 'cacheCreation');
        assertEqual(records[0].cacheRead, 2000, 'cacheRead');
        assertEqual(records[0].output, 3, 'output');
    });

    await run('3. partial last line not consumed, then completed', async () => {
        const dir = makeTmpDir();
        const file = GLib.build_filenamev([dir, 'proj', 'b.jsonl']);
        const first = usageLine({messageId: 'm3a', requestId: 'r3a', input: 1, output: 1});
        const second = usageLine({messageId: 'm3b', requestId: 'r3b', input: 2, output: 2});
        const cut = Math.floor(second.length / 2);

        writeFile(file, `${first}\n${second.slice(0, cut)}`);

        const parser = new TokenParser(dir);
        const state = freshState();
        const records1 = await parser.scan(state);

        assertEqual(records1.length, 1, 'first scan sees only complete line');
        assertEqual(records1[0].key, 'm3a:r3a', 'first record key');
        assertEqual(state.files[file].offset, byteLength(`${first}\n`),
            'offset stops right after the newline');
        assert(state.files[file].offset < bytesWritten(file), 'partial bytes not consumed');

        appendFile(file, `${second.slice(cut)}\n`);
        const records2 = await parser.scan(state);

        assertEqual(records2.length, 1, 'second scan returns only the completed line');
        assertEqual(records2[0].key, 'm3b:r3b', 'second record key');
        assertEqual(records2[0].input, 2, 'second record input');
        assertEqual(state.files[file].offset, bytesWritten(file), 'offset at EOF');

        const records3 = await parser.scan(state);
        assertEqual(records3.length, 0, 'third scan returns nothing');
    });

    await run('4. unchanged second scan returns [] and does not read', async () => {
        const dir = makeTmpDir();
        const file = GLib.build_filenamev([dir, 'proj', 'c.jsonl']);
        writeFile(file, `${usageLine({messageId: 'm4', requestId: 'r4', input: 4, output: 4})}\n`);

        const parser = new TokenParser(dir);
        const state = freshState();
        const first = await parser.scan(state);
        assertEqual(first.length, 1, 'initial scan');
        assertEqual(state.files[file].offset, state.files[file].size, 'offsets consistent');
        const seenBefore = JSON.stringify(state.seen);

        const reads = instrumentReads();
        let second;
        try {
            second = await parser.scan(state);
        } finally {
            reads.restore();
        }

        assertEqual(second.length, 0, 'no new records');
        assertEqual(reads.count, 0, 'no file bytes were read');
        assertEqual(JSON.stringify(state.seen), seenBefore, 'seen state untouched');
    });

    await run('5. nested subagents/*.jsonl discovered', async () => {
        const dir = makeTmpDir();
        const nested = GLib.build_filenamev([
            dir, 'proj', 'sess-1', 'subagents', 'agent-1.jsonl',
        ]);
        writeFile(nested, `${usageLine({messageId: 'm5', requestId: 'r5',
            input: 50, output: 25, sessionId: 'sess-1'})}\n`);

        const parser = new TokenParser(dir);
        const state = freshState();
        const records = await parser.scan(state);

        assertEqual(records.length, 1, 'nested record found');
        assertEqual(records[0].key, 'm5:r5', 'nested key');
        assertEqual(records[0].sessionId, 'sess-1', 'sessionId');
        assert(state.files[nested] !== undefined, 'nested file tracked');
    });

    await run('6. malformed line and stale record skipped', async () => {
        const dir = makeTmpDir();
        const file = GLib.build_filenamev([dir, 'proj', 'd.jsonl']);
        const now = Date.now();
        const old = usageLine({messageId: 'm6old', requestId: 'r6old',
            timestamp: now - 31 * 24 * 60 * 60 * 1000, input: 99, output: 99});
        const recent = usageLine({messageId: 'm6new', requestId: 'r6new',
            timestamp: now, input: 6, output: 6});

        writeFile(file, `{ this is not json\n${old}\n${recent}\n`);

        const parser = new TokenParser(dir);
        const state = freshState();
        const records = await parser.scan(state);

        assertEqual(records.length, 1, 'only the recent valid record');
        assertEqual(records[0].key, 'm6new:r6new', 'record key');
        assertEqual(state.seen['m6old:r6old'], undefined, 'stale key not remembered');
    });

    await run('7. truncated file re-read from 0 without double counting', async () => {
        const dir = makeTmpDir();
        const file = GLib.build_filenamev([dir, 'proj', 'e.jsonl']);
        const keep = usageLine({messageId: 'm7a', requestId: 'r7a', input: 1, output: 1});
        const padding = 'x'.repeat(600);
        const fresh = usageLine({messageId: 'm7c', requestId: 'r7c', input: 3, output: 3});

        writeFile(file, `${keep}\n${padding}\n`);

        const parser = new TokenParser(dir);
        const state = freshState();
        const first = await parser.scan(state);
        assertEqual(first.length, 1, 'initial scan');
        const oldOffset = state.files[file].offset;

        // Rewrite shorter than old offset: must restart at 0.
        writeFile(file, `${keep}\n${fresh}\n`);
        assert(bytesWritten(file) < oldOffset, 'fixture is actually truncated');

        const second = await parser.scan(state);
        assertEqual(second.length, 1, 'only the new record after truncation');
        assertEqual(second[0].key, 'm7c:r7c', 'new record key');
        assertEqual(second[0].input, 3, 'new record input');
        assertEqual(state.files[file].offset, bytesWritten(file), 'offset back at EOF');
    });

    await run('8. missing projectsDir returns []', async () => {
        const dir = makeTmpDir();
        const missing = GLib.build_filenamev([dir, 'does-not-exist']);
        const parser = new TokenParser(missing);
        const state = freshState();
        const records = await parser.scan(state);

        assertEqual(records.length, 0, 'empty result');
        assertEqual(Object.keys(state.files).length, 0, 'state untouched');
        assertEqual(Object.keys(state.seen).length, 0, 'seen untouched');
    });

    await run('9. missing message.id/requestId falls back to uuid', async () => {
        const dir = makeTmpDir();
        const file = GLib.build_filenamev([dir, 'proj', 'f.jsonl']);
        const noIds = usageLine({timestamp: Date.now(), input: 8, output: 2,
            uuid: 'uuid-fallback', omitMessageId: true, omitRequestId: true});
        const noKey = usageLine({timestamp: Date.now(), input: 5, output: 5,
            omitMessageId: true, omitRequestId: true, uuid: null});
        writeFile(file, `${noIds}\n${noKey}\n`);

        const parser = new TokenParser(dir);
        const records = await parser.scan(freshState());

        assertEqual(records.length, 1, 'only the uuid-keyed record is accepted');
        assertEqual(records[0].key, 'uuid-fallback', 'uuid used as key');
    });

    await run('10. files removed from state when deleted', async () => {
        const dir = makeTmpDir();
        const file = GLib.build_filenamev([dir, 'proj', 'g.jsonl']);
        writeFile(file, `${usageLine({messageId: 'm10', requestId: 'r10'})}\n`);

        const parser = new TokenParser(dir);
        const state = freshState();
        await parser.scan(state);
        assert(state.files[file] !== undefined, 'tracked before deletion');

        Gio.File.new_for_path(file).delete(null);
        const records = await parser.scan(state);

        assertEqual(records.length, 0, 'no records');
        assertEqual(state.files[file], undefined, 'state entry removed');
    });
}

// ---------------------------------------------------------------- smoke test

async function smokeTest() {
    const projectsDir = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);
    const root = Gio.File.new_for_path(projectsDir);
    if (!root.query_exists(null)) {
        print('SMOKE skipped: real projects dir not found');
        return;
    }

    const parser = new TokenParser(projectsDir);
    const state = freshState();
    const records = await parser.scan(state);

    let input = 0;
    let output = 0;
    for (const r of records) {
        input += r.input;
        output += r.output;
    }

    print(`SMOKE records=${records.length} input=${input} output=${output}`);
}

// -------------------------------------------------------------------- entry

let exitCode = 0;
const loop = new GLib.MainLoop(null, false);

(async () => {
    try {
        await runCases();
        await smokeTest();
    } catch (e) {
        print(`FAIL unexpected error: ${e.message}`);
        failCount += 1;
    } finally {
        for (const dir of tmpDirs) {
            try {
                removeTree(dir);
            } catch {
                // Best-effort cleanup.
            }
        }
    }

    print(`SUMMARY pass=${passCount} fail=${failCount}`);
    exitCode = failCount === 0 ? 0 : 1;
    loop.quit();
})();

loop.run();
System.exit(exitCode);
