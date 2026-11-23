// Pure formatting helpers for Claude Meter.
// No shell imports here: this module must be testable with plain gjs.

import {t, getLanguage, getLocale} from './i18n.js';

// Short weekday / month name from ICU, without a trailing '.' and (English) at
// most 3 letters (en-GB gives 'Sept').
function shortName(date, field) {
    const text = new Intl.DateTimeFormat(getLocale(), {[field]: 'short'})
        .format(date).replace(/\./g, '');
    return getLanguage() === 'en' ? text.slice(0, 3) : text;
}

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

    if (Math.abs(value) < 999.5)
        return String(Math.round(value));

    // Round to one decimal; if that reaches 1000 move to the next unit.
    const units = ['K', 'M', 'B'];
    let scaled = value / 1e3;
    let i = 0;
    while (i < units.length - 1 && Math.abs(Number(scaled.toFixed(1))) >= 1000) {
        scaled /= 1e3;
        i++;
    }
    return `${oneDecimal(scaled)}${units[i]}`;
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
        return t('common.time.soon');

    if (diffMs < 60000)
        return t('common.time.lessThanMinute');

    const totalMinutes = Math.floor(diffMs / 60000);
    if (totalMinutes < 60)
        return t('common.time.inMinutes', {m: totalMinutes});

    const totalHours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (totalHours < 24) {
        return minutes === 0
            ? t('common.time.inHours', {h: totalHours})
            : t('common.time.inHoursMinutes', {h: totalHours, m: minutes});
    }

    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (hours > 0)
        return t('common.time.inDaysHours', {d: days, h: hours});
    // Whole hours only: keep the minutes so '1 d 30 min' does not become '1 d'.
    return minutes === 0
        ? t('common.time.inDays', {d: days})
        : t('common.time.inDaysMinutes', {d: days, m: minutes});
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
        return t('common.time.never');

    const reference = toDate(now) ?? new Date();
    const diffMs = reference.getTime() - target.getTime();
    // Also covers dates in the future (clock skew between the file/server and
    // this machine): shown as "now" rather than a negative age.
    if (diffMs < 60000)
        return t('common.time.now');

    const totalMinutes = Math.floor(diffMs / 60000);
    if (totalMinutes < 60)
        return t('common.time.minutesAgo', {m: totalMinutes});

    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24)
        return t('common.time.hoursAgo', {h: totalHours});

    return formatClock(target);
}

/**
 * Local wall-clock time 'HH:MM'.
 * @param {Date|number|string|null} date
 * @returns {string}
 */
export function formatClock(date) {
    const target = toDate(date);
    if (!target)
        return DASH;

    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * 'Oggi'/'Ieri' (or Today/Yesterday) or a short label like 'lun 9 nov'.
 * @param {string|Date} day 'YYYY-MM-DD' (or a Date)
 * @param {Date} [now]
 * @returns {string}
 */
export function formatDayLabel(day, now = new Date()) {
    const reference = toDate(now) ?? new Date();
    const parsed = day instanceof Date ? toDate(day) : parseDayKey(day);
    if (!parsed)
        return DASH;

    const key = dayKey(parsed);
    if (key === dayKey(reference))
        return t('common.day.today');

    const yesterday = new Date(reference.getFullYear(), reference.getMonth(),
        reference.getDate() - 1);
    if (key === dayKey(yesterday))
        return t('common.day.yesterday');

    return `${shortName(parsed, 'weekday')} ${parsed.getDate()} ${shortName(parsed, 'month')}`;
}

/** Threshold as a number; null/undefined/''/non-finite -> fallback. */
function thresholdOr(value, fallback) {
    if (value === null || value === undefined || value === '')
        return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
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

    const warnAt = thresholdOr(warn, 70);
    const criticalAt = thresholdOr(critical, 90);

    if (value >= criticalAt)
        return 'critical';
    if (value >= warnAt)
        return 'warning';

    return 'normal';
}

// Exported for tests / other pure helpers.
export {toDate, dayKey};

/**
 * Short weekday for a day key ('lun', 'mar', ...), 'oggi'/'today' for today.
 * @param {string|Date} day 'YYYY-MM-DD' (or a Date)
 * @param {Date} [now]
 * @returns {string}
 */
export function formatWeekdayShort(day, now = new Date()) {
    const parsed = day instanceof Date ? toDate(day) : parseDayKey(day);
    if (!parsed)
        return DASH;
    if (dayKey(parsed) === dayKey(toDate(now) ?? new Date()))
        return t('common.day.todayLower');
    return shortName(parsed, 'weekday');
}
