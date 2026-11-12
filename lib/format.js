// Pure formatting helpers for Claude Meter.
// No shell imports here: this module must be testable with plain gjs.

const WEEKDAYS_IT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const MONTHS_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu',
    'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

const DASH = '—';

/**
 * Coerce a value to a valid Date, or null.
 * @param {*} value Date | number (ms) | ISO string | null
 * @returns {Date|null}
 */
function toDate(value) {
    if (value === null || value === undefined || value === '')
        return null;

    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? null : value;

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Local day key 'YYYY-MM-DD' for a Date. */
function dayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** Parse 'YYYY-MM-DD' as a local date (no UTC shift). */
function parseDayKey(key) {
    if (typeof key !== 'string')
        return null;

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match)
        return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31)
        return null;

    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day)
        return null;

    return date;
}

/** One decimal, dropping a trailing '.0'. */
function oneDecimal(value) {
    const text = value.toFixed(1);
    return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/**
 * Human readable token count: 999, 12.3K, 1.2M, 3.4B.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatTokens(n) {
    if (n === null || n === undefined || n === '')
        return DASH;

    const value = Number(n);
    if (!Number.isFinite(value))
        return DASH;

    const abs = Math.abs(value);
    if (abs < 1e3)
        return String(Math.round(value));
    if (abs < 1e6)
        return `${oneDecimal(value / 1e3)}K`;
    if (abs < 1e9)
        return `${oneDecimal(value / 1e6)}M`;

    return `${oneDecimal(value / 1e9)}B`;
}

/**
 * Rounded integer percentage.
 * @param {number|null|undefined} p
 * @returns {string}
 */
export function formatPercent(p) {
    if (p === null || p === undefined || p === '')
        return DASH;

    const value = Number(p);
    if (!Number.isFinite(value))
        return DASH;

    return `${Math.round(value)}%`;
}

/**
 * Time left until `date`: 'tra 2 h 15 min', '< 1 min', 'a breve', ...
 * @param {Date|number|string|null} date
 * @param {Date} [now]
 * @returns {string}
 */
export function formatCountdown(date, now = new Date()) {
    const target = toDate(date);
    if (!target)
        return DASH;

    const reference = toDate(now) ?? new Date();
    const diffMs = target.getTime() - reference.getTime();
    if (diffMs <= 0)
        return 'a breve';

    if (diffMs < 60000)
        return '< 1 min';

    const totalMinutes = Math.floor(diffMs / 60000);
    if (totalMinutes < 60)
        return `tra ${totalMinutes} min`;

    const totalHours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (totalHours < 24) {
        return minutes === 0
            ? `tra ${totalHours} h`
            : `tra ${totalHours} h ${minutes} min`;
    }

    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours === 0 ? `tra ${days} g` : `tra ${days} g ${hours} h`;
}

/**
 * Elapsed time since `date`: 'adesso', '5 min fa', '2 h fa', else 'HH:MM'.
 * @param {Date|number|string|null} date
 * @param {Date} [now]
 * @returns {string}
 */
export function formatRelativeTime(date, now = new Date()) {
    const target = toDate(date);
    if (!target)
        return 'mai';

    const reference = toDate(now) ?? new Date();
    const diffMs = reference.getTime() - target.getTime();
    if (diffMs < 60000)
        return 'adesso';

    const totalMinutes = Math.floor(diffMs / 60000);
    if (totalMinutes < 60)
        return `${totalMinutes} min fa`;

    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24)
        return `${totalHours} h fa`;

    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * 'Oggi', 'Ieri' or a short Italian label like 'lun 9 nov'.
 * @param {string|Date} day 'YYYY-MM-DD' (or a Date)
 * @param {Date} [now]
 * @returns {string}
 */
export function formatDayLabel(day, now = new Date()) {
    const reference = toDate(now) ?? new Date();
    const parsed = day instanceof Date ? toDate(day) : parseDayKey(day);
    if (!parsed)
        return typeof day === 'string' && day !== '' ? day : DASH;

    const key = dayKey(parsed);
    if (key === dayKey(reference))
        return 'Oggi';

    const yesterday = new Date(reference.getFullYear(), reference.getMonth(),
        reference.getDate() - 1);
    if (key === dayKey(yesterday))
        return 'Ieri';

    return `${WEEKDAYS_IT[parsed.getDay()]} ${parsed.getDate()} ${MONTHS_IT[parsed.getMonth()]}`;
}

/**
 * Severity level for a percentage against the configured thresholds.
 * @param {number|null|undefined} percent
 * @param {number} warn
 * @param {number} critical
 * @returns {'normal'|'warning'|'critical'|'unknown'}
 */
export function levelFor(percent, warn, critical) {
    if (percent === null || percent === undefined || percent === '')
        return 'unknown';

    const value = Number(percent);
    if (!Number.isFinite(value))
        return 'unknown';

    const warnAt = Number.isFinite(Number(warn)) ? Number(warn) : 70;
    const criticalAt = Number.isFinite(Number(critical)) ? Number(critical) : 90;

    if (value >= criticalAt)
        return 'critical';
    if (value >= warnAt)
        return 'warning';

    return 'normal';
}

// Exported for tests / other pure helpers.
export { toDate, dayKey };

/**
 * Short Italian weekday for a day key ('lun', 'mar', ...), 'oggi' for today.
 * @param {string} day 'YYYY-MM-DD'
 * @param {Date} [now]
 * @returns {string}
 */
export function formatWeekdayShort(day, now = new Date()) {
    const parsed = parseDayKey(day);
    if (!parsed)
        return DASH;
    if (dayKey(parsed) === dayKey(toDate(now) ?? new Date()))
        return 'oggi';
    return WEEKDAYS_IT[parsed.getDay()];
}
