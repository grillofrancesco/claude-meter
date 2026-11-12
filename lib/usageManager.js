// Usage Manager — legge le percentuali del piano Claude dai dati OAuth locali
// e interroga l'endpoint NON ufficiale di Anthropic.
//
// Questo modulo isola l'endpoint non ufficiale: se cambia, va modificato solo qui.
// Le credenziali sono di sola lettura: non vengono mai scritte né rinnovate.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_SECONDS = 15;
const USER_AGENT = 'claude-meter/0.1';

export class UsageError extends Error {
    /**
     * @param {string} code
     * @param {string} [message]
     * @param {number|null} [retryAfterMs] server-suggested wait (429 only)
     */
    constructor(code, message, retryAfterMs = null) {
        super(message ?? code);
        this.name = 'UsageError';
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}

function clampPercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return null;
    return Math.min(100, Math.max(0, value));
}

function parseResetsAt(value) {
    if (typeof value === 'string' && value !== '') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime()))
            return date;
    }
    return null;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeWindow(percent, resetsAt) {
    const clamped = clampPercent(percent);
    if (clamped === null)
        return null;
    return { percent: clamped, resetsAt: parseResetsAt(resetsAt) };
}

function findLimit(limits, kind) {
    return limits.find(limit => limit && limit.kind === kind) ?? null;
}

function scopedLabel(limit) {
    const scope = isObject(limit.scope) ? limit.scope : null;
    const model = scope && isObject(scope.model) ? scope.model : null;
    const displayName = model ? model.display_name : null;
    if (typeof displayName === 'string' && displayName.trim() !== '')
        return displayName;
    if (scope && typeof scope.surface === 'string' && scope.surface.trim() !== '')
        return scope.surface;
    return 'Limite';
}

/**
 * Converte il corpo JSON dell'endpoint in un PlanUsage.
 * Funzione pura (nessun I/O) così può essere testata con gjs.
 * @param {*} obj corpo JSON già decodificato
 * @returns {{fiveHour: object|null, sevenDay: object|null, scoped: object[], fetchedAt: Date}}
 * @throws {UsageError} con code 'invalid-response'
 */
export function parseUsageResponse(obj) {
    if (!isObject(obj))
        throw new UsageError('invalid-response', 'Risposta non valida');

    const limits = Array.isArray(obj.limits)
        ? obj.limits.filter(limit => isObject(limit))
        : [];

    const fiveHourLimit = findLimit(limits, 'session');
    const fiveHourObj = isObject(obj.five_hour) ? obj.five_hour : null;
    const fiveHourPercent = fiveHourObj && clampPercent(fiveHourObj.utilization) !== null
        ? fiveHourObj.utilization
        : fiveHourLimit?.percent;
    const fiveHourReset = fiveHourObj && parseResetsAt(fiveHourObj.resets_at) !== null
        ? fiveHourObj.resets_at
        : fiveHourLimit?.resets_at;
    const fiveHour = makeWindow(fiveHourPercent, fiveHourReset);

    const sevenDayLimit = findLimit(limits, 'weekly_all');
    const sevenDayObj = isObject(obj.seven_day) ? obj.seven_day : null;
    const sevenDayPercent = sevenDayObj && clampPercent(sevenDayObj.utilization) !== null
        ? sevenDayObj.utilization
        : sevenDayLimit?.percent;
    const sevenDayReset = sevenDayObj && parseResetsAt(sevenDayObj.resets_at) !== null
        ? sevenDayObj.resets_at
        : sevenDayLimit?.resets_at;
    const sevenDay = makeWindow(sevenDayPercent, sevenDayReset);

    if (fiveHour === null && sevenDay === null)
        throw new UsageError('invalid-response', 'Risposta non valida');

    const scoped = [];
    for (const limit of limits) {
        if (limit.kind !== 'weekly_scoped')
            continue;
        const percent = clampPercent(limit.percent);
        if (percent === null)
            continue;
        scoped.push({
            label: scopedLabel(limit),
            percent,
            resetsAt: parseResetsAt(limit.resets_at),
        });
    }

    const legacy = [
        ['seven_day_opus', 'Opus'],
        ['seven_day_sonnet', 'Sonnet'],
    ];
    for (const [key, label] of legacy) {
        const entry = obj[key];
        if (entry === null || entry === undefined)
            continue;
        if (scoped.some(item => item.label === label))
            continue;

        let percent = null;
        let resetsAt = null;
        if (typeof entry === 'number') {
            percent = clampPercent(entry);
        } else if (isObject(entry)) {
            percent = clampPercent(entry.utilization);
            resetsAt = entry.resets_at;
        }
        if (percent === null)
            continue;
        scoped.push({ label, percent, resetsAt: parseResetsAt(resetsAt) });
    }

    return { fiveHour, sevenDay, scoped, fetchedAt: new Date() };
}

/**
 * Retry-After header → milliseconds (seconds or HTTP date). null if absent/invalid/zero.
 * @param {string|null} value
 * @returns {number|null}
 */
export function parseRetryAfter(value, now = Date.now()) {
    if (typeof value !== 'string' || value.trim() === '')
        return null;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        const ms = Number(trimmed) * 1000;
        return ms > 0 ? ms : null;
    }
    const date = Date.parse(trimmed);
    if (Number.isNaN(date))
        return null;
    const ms = date - now;
    return ms > 0 ? ms : null;
}

export class UsageManager {
    /**
     * @param {string} [credentialsPath] default: ~/.claude/.credentials.json
     */
    constructor(credentialsPath = GLib.build_filenamev([
        GLib.get_home_dir(), '.claude', '.credentials.json',
    ])) {
        this._credentialsPath = credentialsPath;
        this._session = new Soup.Session({
            timeout: REQUEST_TIMEOUT_SECONDS,
            user_agent: USER_AGENT,
        });
        this._destroyed = false;
    }

    /**
     * Legge le credenziali (solo il token resta in una variabile locale).
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<string>} access token
     */
    async _readAccessToken(cancellable = null) {
        let contents;
        try {
            const file = Gio.File.new_for_path(this._credentialsPath);
            [contents] = await file.load_contents_async(cancellable);
        } catch (e) {
            if (e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw new UsageError('no-credentials', 'Credenziali Claude Code non trovate');
        }

        let parsed;
        try {
            parsed = JSON.parse(new TextDecoder().decode(contents));
        } catch {
            throw new UsageError('no-credentials', 'Credenziali Claude Code non valide');
        }

        const oauth = isObject(parsed) ? parsed.claudeAiOauth : null;
        if (!isObject(oauth) ||
            typeof oauth.accessToken !== 'string' ||
            oauth.accessToken === '')
            throw new UsageError('no-credentials', 'Credenziali Claude Code non trovate');

        if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now())
            throw new UsageError('expired', 'Credenziali Claude Code scadute');

        return oauth.accessToken;
    }

    /**
     * Scarica le percentuali del piano.
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<{fiveHour: object|null, sevenDay: object|null, scoped: object[], fetchedAt: Date}>}
     * @throws {UsageError}
     */
    async fetch(cancellable = null) {
        // Il token vive solo in questa variabile: non viene salvato su `this`.
        const accessToken = await this._readAccessToken(cancellable);

        if (this._destroyed)
            throw new UsageError('network', 'Sessione chiusa');

        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${accessToken}`);
        message.request_headers.append('anthropic-beta', OAUTH_BETA);
        message.request_headers.append('Accept', 'application/json');

        let bytes;
        try {
            bytes = await this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw new UsageError('network', e?.message ?? 'Errore di rete');
        }

        // status_code (plain uint): get_status() throws in GJS for codes missing
        // from the Soup.Status enum, e.g. 429.
        const status = message.status_code;
        // Numeric codes: Soup 3 has no TOO_MANY_REQUESTS member.
        if (status === 401 || status === 403)
            throw new UsageError('unauthorized', 'Non autorizzato');
        if (status === 429) {
            throw new UsageError('rate-limited', 'Troppe richieste',
                parseRetryAfter(message.response_headers.get_one('Retry-After')));
        }
        if (status < 200 || status > 299)
            throw new UsageError('network', `HTTP ${status}`);

        let obj;
        try {
            obj = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch {
            throw new UsageError('invalid-response', 'Risposta non valida');
        }

        return parseUsageResponse(obj);
    }

    destroy() {
        this._destroyed = true;
        this._session?.abort();
    }
}
