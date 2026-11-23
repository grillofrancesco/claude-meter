// Open Claude Code sessions, read from ~/.claude/sessions/<pid>.json.
// Pure module: imports only Gio and GLib, so it can run under plain `gjs -m`.
//
// Each running Claude Code process writes one file with (among others)
// `pid`, `sessionId`, `kind` ('interactive' | 'bg'), `status` ('idle' | 'busy'),
// `startedAt` (ms) and `procStart` (field 22 of /proc/<pid>/stat). Only
// interactive sessions whose process is still alive (same pid AND same start
// time, so a reused pid is not mistaken for the session) are reported.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');

const decoder = new TextDecoder('utf-8');

function isNotFound(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/** Field 22 (starttime) of a /proc/<pid>/stat line, or null. */
export function parseProcStart(statText) {
    if (typeof statText !== 'string')
        return null;
    // comm (field 2) may contain spaces and parentheses: split after the last ')'.
    const end = statText.lastIndexOf(')');
    if (end < 0)
        return null;
    const fields = statText.slice(end + 2).trim().split(/\s+/);
    // fields[0] is field 3 (state) → field 22 is fields[19].
    return fields.length > 19 ? fields[19] : null;
}

/** Validate one parsed session file; returns the session or null. */
export function parseSession(json) {
    if (!json || typeof json !== 'object')
        return null;
    if (json.kind !== 'interactive')
        return null;
    const pid = Number(json.pid);
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    return {
        id: typeof json.sessionId === 'string' && json.sessionId ? json.sessionId : `pid:${pid}`,
        pid,
        busy: json.status === 'busy',
        startedAt: Number(json.startedAt) || 0,
        procStart: json.procStart === undefined || json.procStart === null
            ? null
            : String(json.procStart),
    };
}

export class SessionMonitor {
    /**
     * @param {string} sessionsDir
     * @param {string} procDir only overridden by tests
     */
    constructor(
        sessionsDir = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'sessions']),
        procDir = '/proc'
    ) {
        this._dir = sessionsDir;
        this._procDir = procDir;
        // Last good parse per file: a file caught mid-write keeps its previous value.
        this._cache = new Map();
    }

    get directory() {
        return this._dir;
    }

    /**
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<Array<{id: string, busy: boolean, startedAt: number}>>}
     *   alive interactive sessions, oldest first. Missing directory → [].
     */
    async scan(cancellable = null) {
        const names = await this._listJsonFiles(cancellable);
        const seen = new Set(names);
        for (const name of this._cache.keys()) {
            if (!seen.has(name))
                this._cache.delete(name);
        }

        const results = await Promise.all(names.map(name => this._readSession(name, cancellable)));
        const sessions = results.filter(s => s !== null);
        sessions.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));

        // One entry per session id (a resumed session could leave two files).
        const unique = new Map();
        for (const s of sessions) {
            const prev = unique.get(s.id);
            unique.set(s.id, prev ? {...prev, busy: prev.busy || s.busy} : s);
        }
        return [...unique.values()].map(({id, busy, startedAt}) => ({id, busy, startedAt}));
    }

    async _listJsonFiles(cancellable) {
        const dir = Gio.File.new_for_path(this._dir);
        let enumerator;
        try {
            enumerator = await dir.enumerate_children_async('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (isNotFound(e))
                return [];
            throw e;
        }

        const names = [];
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable);
                if (!infos.length)
                    break;
                for (const info of infos) {
                    const name = info.get_name();
                    if (info.get_file_type() === Gio.FileType.REGULAR && name.endsWith('.json'))
                        names.push(name);
                }
            }
        } finally {
            try {
                await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
            } catch {
                // ignore
            }
        }
        return names;
    }

    async _readSession(name, cancellable) {
        let session = null;
        try {
            const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, name]));
            const [bytes] = await file.load_contents_async(cancellable);
            session = parseSession(JSON.parse(decoder.decode(bytes)));
            this._cache.set(name, session);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            // Partial write or unreadable: keep the last good value for this file.
            session = this._cache.get(name) ?? null;
        }
        if (!session)
            return null;
        return await this._isAlive(session, cancellable) ? session : null;
    }

    async _isAlive(session, cancellable) {
        try {
            const file = Gio.File.new_for_path(
                GLib.build_filenamev([this._procDir, String(session.pid), 'stat']));
            const [bytes] = await file.load_contents_async(cancellable);
            if (session.procStart === null)
                return true;
            return parseProcStart(decoder.decode(bytes)) === session.procStart;
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return false;
        }
    }
}
