import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const STATE_VERSION = 1;
const HISTORY_DAYS = 30;

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Chiave del giorno LOCALE ('YYYY-MM-DD') per un timestamp in millisecondi.
 * @param {number} ms
 * @returns {string}
 */
export function localDateKey(ms) {
    const seconds = Math.floor(Number(ms) / 1000);
    return GLib.DateTime.new_from_unix_local(seconds).format('%Y-%m-%d');
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function freshState() {
    return {version: STATE_VERSION, files: {}, seen: {}, days: {}};
}

function sanitizeState(raw) {
    if (!isObject(raw) || raw.version !== STATE_VERSION)
        return freshState();

    const state = freshState();

    if (isObject(raw.files)) {
        for (const [path, entry] of Object.entries(raw.files)) {
            if (!isObject(entry))
                continue;
            const offset = Number(entry.offset);
            if (!Number.isFinite(offset) || offset < 0)
                continue;
            const size = Number(entry.size);
            state.files[path] = {
                offset: Math.floor(offset),
                size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0,
            };
        }
    }

    if (isObject(raw.seen)) {
        for (const [key, value] of Object.entries(raw.seen)) {
            if (typeof value === 'string' && DATE_KEY_RE.test(value))
                state.seen[key] = value;
        }
    }

    if (isObject(raw.days)) {
        for (const [date, bucket] of Object.entries(raw.days)) {
            if (!DATE_KEY_RE.test(date) || !isObject(bucket))
                continue;
            state.days[date] = {
                input: asCount(bucket.input),
                output: asCount(bucket.output),
            };
        }
    }

    return state;
}

async function ensureDirectory(path, cancellable) {
    if (!path || path === '/')
        return;

    const dir = Gio.File.new_for_path(path);
    try {
        await dir.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
        return;
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw e;
    }

    const parent = dir.get_parent();
    if (parent)
        await ensureDirectory(parent.get_path(), cancellable);

    try {
        await dir.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
}

export class DataManager {
    constructor(statePath = GLib.build_filenamev([GLib.get_user_data_dir(), 'claude-meter', 'state.json'])) {
        this._statePath = statePath;
        this._state = freshState();
        this._saveChain = Promise.resolve();
    }

    /**
     * Legge lo stato da disco. File assente o non valido -> stato vuoto (mai eccezioni).
     * @param {Gio.Cancellable|null} cancellable
     */
    async load(cancellable = null) {
        const file = Gio.File.new_for_path(this._statePath);
        let contents = null;

        try {
            const [data] = await file.load_contents_async(cancellable);
            contents = data;
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.debug(`claude-meter: lettura stato fallita: ${e.message}`);
        }

        let state = freshState();
        if (contents && contents.length > 0) {
            try {
                const text = new TextDecoder('utf-8').decode(contents);
                state = sanitizeState(JSON.parse(text));
            } catch (e) {
                console.debug(`claude-meter: stato non valido, riparto da zero: ${e.message}`);
                state = freshState();
            }
        }

        this._state = state;
    }

    /**
     * Oggetto passato a TokenParser.scan(); le sue proprietà sono gli stessi
     * oggetti tenuti in this._state, quindi le mutazioni del parser vengono salvate.
     * Gli accessor coprono anche l'eventuale riassegnazione difensiva di
     * `state.files` / `state.seen` da parte del parser.
     */
    get parserState() {
        const self = this;
        return {
            get files() {
                return self._state.files;
            },
            set files(value) {
                self._state.files = value;
            },
            get seen() {
                return self._state.seen;
            },
            set seen(value) {
                self._state.seen = value;
            },
        };
    }

    /**
     * Aggrega i record per giorno LOCALE. Cache letta/scritta volutamente ignorata.
     * @param {Array<{timestamp: number, input: number, output: number}>} records
     */
    addRecords(records) {
        if (!Array.isArray(records))
            return;

        const days = this._state.days;
        for (const record of records) {
            if (!isObject(record))
                continue;
            const timestamp = Number(record.timestamp);
            if (!Number.isFinite(timestamp) || timestamp <= 0)
                continue;

            const key = localDateKey(timestamp);
            if (!days[key])
                days[key] = {input: 0, output: 0};
            days[key].input += asCount(record.input);
            days[key].output += asCount(record.output);
        }
    }

    /**
     * Mantiene gli ultimi 30 giorni locali (oggi incluso) e pota `seen`.
     * @param {Date} now
     */
    prune(now = new Date()) {
        const base = GLib.DateTime.new_from_unix_local(Math.floor(now.getTime() / 1000));
        const cutoff = base.add_days(-(HISTORY_DAYS - 1)).format('%Y-%m-%d');

        for (const date of Object.keys(this._state.days)) {
            if (date < cutoff)
                delete this._state.days[date];
        }

        for (const [key, date] of Object.entries(this._state.seen)) {
            if (typeof date !== 'string' || date < cutoff)
                delete this._state.seen[key];
        }
    }

    /**
     * Scrittura atomica, permessi 0600. Le chiamate concorrenti sono serializzate.
     * @param {Gio.Cancellable|null} cancellable
     */
    async save(cancellable = null) {
        const run = this._saveChain.then(() => this._write(cancellable));
        this._saveChain = run.catch(() => {});
        return run;
    }

    async _write(cancellable) {
        const parent = GLib.path_get_dirname(this._statePath);
        await ensureDirectory(parent, cancellable);

        const json = JSON.stringify({
            version: STATE_VERSION,
            files: this._state.files,
            seen: this._state.seen,
            days: this._state.days,
        });
        const bytes = new TextEncoder('utf-8').encode(json);
        const file = Gio.File.new_for_path(this._statePath);

        await file.replace_contents_bytes_async(
            new GLib.Bytes(bytes),
            null,
            false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable);
    }

    /**
     * Token di oggi (zona locale). Zeri reali: i dati sono già stati scansionati.
     * @param {Date} now
     */
    getToday(now = new Date()) {
        const bucket = this._state.days[localDateKey(now.getTime())];
        const input = bucket ? bucket.input : 0;
        const output = bucket ? bucket.output : 0;
        return {input, output, total: input + output};
    }

    /**
     * Storico dal più recente, zero-filled.
     * @param {number} days
     * @returns {Array<{date: string, input: number, output: number, total: number}>}
     */
    getHistory(days = HISTORY_DAYS) {
        const count = Number.isFinite(days) && days > 0 ? Math.floor(days) : HISTORY_DAYS;
        const today = GLib.DateTime.new_now_local();
        const history = [];

        for (let i = 0; i < count; i++) {
            const date = today.add_days(-i).format('%Y-%m-%d');
            const bucket = this._state.days[date];
            const input = bucket ? bucket.input : 0;
            const output = bucket ? bucket.output : 0;
            history.push({date, input, output, total: input + output});
        }

        return history;
    }
}
