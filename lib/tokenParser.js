// Token Parser — incremental, async reader of Claude Code JSONL transcripts.
//
// Reads only *new* bytes of each *.jsonl file under the Claude projects
// directory and returns one Record per unique API request. State (file
// offsets + seen keys) is owned by DataManager and mutated in place.
//
// Pure module: imports only Gio and GLib, so it can run under plain `gjs -m`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');

const CHUNK_SIZE = 256 * 1024; // 256 KiB
const NEWLINE = 0x0a;
const BATCH_SIZE = 32;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const decoder = new TextDecoder('utf-8');

function pad2(n) {
    return n < 10 ? `0${n}` : `${n}`;
}

// Local calendar day of a ms-epoch timestamp, as 'YYYY-MM-DD'.
function localDay(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function asNumber(value) {
    return Number(value) || 0;
}

function asString(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function isCancelled(cancellable) {
    return cancellable !== null && cancellable !== undefined && cancellable.is_cancelled();
}

function isCancelledError(e) {
    try {
        return e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
    } catch {
        return false;
    }
}

function concatBytes(a, b) {
    if (a.length === 0)
        return b;
    if (b.length === 0)
        return a;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

export class TokenParser {
    constructor(projectsDir = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects'])) {
        this.projectsDir = projectsDir;
    }

    /**
     * Scan the projects directory for new usage records.
     *
     * @param {{files: Object<string, {offset: number, size: number}>, seen: Object<string, string>}} state
     * @param {?Gio.Cancellable} cancellable
     * @returns {Promise<Array<{key: string, timestamp: number, sessionId: string|null,
     *                          input: number, output: number,
     *                          cacheCreation: number, cacheRead: number}>>}
     */
    async scan(state, cancellable = null) {
        if (!state || typeof state !== 'object')
            return [];
        if (!state.files || typeof state.files !== 'object')
            state.files = {};
        if (!state.seen || typeof state.seen !== 'object')
            state.seen = {};

        const paths = await this._listJsonlFiles(this.projectsDir, cancellable);
        // Root directory unusable (missing/unreadable): keep state untouched.
        if (paths === null)
            return [];

        const present = new Set(paths);
        for (const path of Object.keys(state.files)) {
            if (!present.has(path))
                delete state.files[path];
        }

        const records = [];
        const cutoff = Date.now() - RETENTION_MS;

        for (const path of paths) {
            if (isCancelled(cancellable))
                break;
            try {
                const found = await this._scanFile(path, state, cutoff, cancellable);
                records.push(...found);
            } catch (e) {
                if (isCancelledError(e))
                    break;
                // Short diagnostic only: never log file content.
                console.debug(`claude-meter: tokenParser: file scan failed (${e.message})`);
            }
        }

        return records;
    }

    // ---------------------------------------------------------------- walking

    /**
     * Recursively collect absolute paths of *.jsonl files.
     * Returns null when the root directory cannot be enumerated at all,
     * an array (possibly empty) otherwise.
     */
    async _listJsonlFiles(dirPath, cancellable) {
        const dir = Gio.File.new_for_path(dirPath);

        let enumerator;
        try {
            enumerator = await dir.enumerate_children_async(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable);
        } catch (e) {
            if (isCancelledError(e))
                return [];
            console.debug(`claude-meter: tokenParser: projects dir unavailable (${e.message})`);
            return null;
        }

        const out = [];
        await this._collect(enumerator, dirPath, out, cancellable);
        out.sort();
        return out;
    }

    async _collect(enumerator, dirPath, out, cancellable) {
        try {
            while (!isCancelled(cancellable)) {
                const infos = await enumerator.next_files_async(
                    BATCH_SIZE, GLib.PRIORITY_DEFAULT, cancellable);
                if (!infos || infos.length === 0)
                    break;

                for (const info of infos) {
                    const name = info.get_name();
                    if (!name)
                        continue;
                    const childPath = GLib.build_filenamev([dirPath, name]);
                    const type = info.get_file_type();

                    if (type === Gio.FileType.DIRECTORY) {
                        await this._walkSubdir(childPath, out, cancellable);
                    } else if (type === Gio.FileType.REGULAR && name.endsWith('.jsonl')) {
                        out.push(childPath);
                    }
                }
            }
        } catch (e) {
            if (!isCancelledError(e))
                console.debug(`claude-meter: tokenParser: directory scan failed (${e.message})`);
        } finally {
            try {
                await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
            } catch {
                // Ignore close failures.
            }
        }
    }

    async _walkSubdir(dirPath, out, cancellable) {
        const dir = Gio.File.new_for_path(dirPath);
        let enumerator;
        try {
            enumerator = await dir.enumerate_children_async(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable);
        } catch (e) {
            if (!isCancelledError(e))
                console.debug(`claude-meter: tokenParser: subdirectory skipped (${e.message})`);
            return;
        }
        await this._collect(enumerator, dirPath, out, cancellable);
    }

    // ------------------------------------------------------------- per-file

    async _scanFile(path, state, cutoff, cancellable) {
        const file = Gio.File.new_for_path(path);

        let info;
        try {
            info = await file.query_info_async(
                'standard::size,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable);
        } catch (e) {
            if (isCancelledError(e))
                throw e;
            // File vanished or became unreadable: forget it.
            delete state.files[path];
            console.debug(`claude-meter: tokenParser: file unavailable (${e.message})`);
            return [];
        }

        if (info.get_file_type() !== Gio.FileType.REGULAR)
            return [];

        const size = info.get_size();
        const previous = state.files[path];
        let offset = previous && Number.isFinite(previous.offset) ? previous.offset : 0;

        if (previous && size === offset) {
            // Nothing new since last scan: do not even open the file.
            if (previous.size !== offset)
                previous.size = offset;
            return [];
        }

        if (offset > size || offset < 0) {
            // File was truncated/rewritten: restart from the beginning.
            // Dedup via state.seen still prevents double counting.
            offset = 0;
        }

        const records = [];
        if (size === 0) {
            state.files[path] = { offset: 0, size: 0 };
            return records;
        }

        let stream;
        try {
            stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (isCancelledError(e))
                throw e;
            delete state.files[path];
            if (!isCancelledError(e))
                console.debug(`claude-meter: tokenParser: open failed (${e.message})`);
            return [];
        }

        let position = offset; // absolute byte position of consumed complete lines
        let pending = new Uint8Array(0);

        try {
            if (offset > 0)
                stream.seek(offset, GLib.SeekType.SET, cancellable);

            while (!isCancelled(cancellable)) {
                let bytes;
                try {
                    bytes = await stream.read_bytes_async(
                        CHUNK_SIZE, GLib.PRIORITY_DEFAULT, cancellable);
                } catch (e) {
                    if (isCancelledError(e))
                        break;
                    throw e;
                }

                const chunkSize = bytes.get_size();
                if (chunkSize === 0)
                    break;

                const buffer = concatBytes(pending, bytes.toArray());

                // Only complete lines are consumed; a trailing partial line
                // stays buffered so the next scan can finish it. Offsets are
                // byte offsets: split on 0x0A *before* UTF-8 decoding.
                const lastNewline = buffer.lastIndexOf(NEWLINE);
                if (lastNewline === -1) {
                    pending = buffer;
                    continue;
                }

                const complete = buffer.subarray(0, lastNewline + 1);
                pending = buffer.subarray(lastNewline + 1);
                position += lastNewline + 1;

                const text = decoder.decode(complete);
                for (const line of text.split('\n'))
                    this._processLine(line, cutoff, state, records);
            }
        } finally {
            try {
                await stream.close_async(GLib.PRIORITY_DEFAULT, null);
            } catch {
                // Ignore close failures.
            }
        }

        state.files[path] = { offset: position, size: position };
        return records;
    }

    // ------------------------------------------------------------- parsing

    _processLine(line, cutoff, state, records) {
        if (!line || line.trim().length === 0)
            return;

        let obj;
        try {
            obj = JSON.parse(line);
        } catch {
            return; // malformed line
        }

        if (!obj || typeof obj !== 'object')
            return;

        const message = obj.message;
        if (!message || typeof message !== 'object')
            return;
        const usage = message.usage;
        if (!usage || typeof usage !== 'object' || Array.isArray(usage))
            return;

        let key = null;
        const messageId = asString(message.id);
        const requestId = asString(obj.requestId);
        if (messageId && requestId)
            key = `${messageId}:${requestId}`;
        else
            key = asString(obj.uuid);
        if (!key)
            return;

        const rawTimestamp = obj.timestamp;
        let timestamp;
        if (typeof rawTimestamp === 'string')
            timestamp = Date.parse(rawTimestamp);
        else if (typeof rawTimestamp === 'number')
            timestamp = rawTimestamp;
        else
            timestamp = NaN;

        if (!Number.isFinite(timestamp))
            return;
        if (timestamp < cutoff)
            return; // older than retention window

        if (Object.prototype.hasOwnProperty.call(state.seen, key))
            return; // already counted (same request appears on several lines)

        const record = {
            key,
            timestamp,
            sessionId: asString(obj.sessionId) ?? asString(obj.session_id),
            input: asNumber(usage.input_tokens),
            output: asNumber(usage.output_tokens),
            cacheCreation: asNumber(usage.cache_creation_input_tokens),
            cacheRead: asNumber(usage.cache_read_input_tokens),
        };

        state.seen[key] = localDay(timestamp);
        records.push(record);
    }
}
