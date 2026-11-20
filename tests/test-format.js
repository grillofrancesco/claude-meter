// Regression tests for lib/format.js (current Italian output).
// Run: gjs -m tests/test-format.js

import System from 'system';

import {
    formatTokens, formatPercent, formatCountdown, formatRelativeTime,
    formatDayLabel, levelFor, toDate, dayKey, formatWeekdayShort,
} from '../lib/format.js';

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
    if (actual === expected) {
        passed++;
        print(`PASS ${name}`);
    } else {
        failed++;
        print(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

const D = (y, m, d, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s);
const DASH = '—';

// formatTokens
for (const v of [null, undefined, '', NaN, Infinity, -Infinity, 'abc'])
    eq(`formatTokens(${String(v)}) -> dash`, formatTokens(v), DASH);
eq('formatTokens(0)', formatTokens(0), '0');
eq('formatTokens(999)', formatTokens(999), '999');
eq('formatTokens(999.4) rounds', formatTokens(999.4), '999');
eq('formatTokens(1000)', formatTokens(1000), '1K');
eq('formatTokens(1500)', formatTokens(1500), '1.5K');
eq('formatTokens(12345)', formatTokens(12345), '12.3K');
eq('formatTokens(999999)', formatTokens(999999), '1000K');
eq('formatTokens(1e6)', formatTokens(1e6), '1M');
eq('formatTokens(1.25e6)', formatTokens(1.25e6), '1.3M');
eq('formatTokens(999999999)', formatTokens(999999999), '1000M');
eq('formatTokens(1e9)', formatTokens(1e9), '1B');
eq('formatTokens(3.4e9)', formatTokens(3.4e9), '3.4B');
eq('formatTokens(-5)', formatTokens(-5), '-5');
eq('formatTokens(-1000)', formatTokens(-1000), '-1K');
eq('formatTokens(-1500)', formatTokens(-1500), '-1.5K');
eq('formatTokens(-2e6)', formatTokens(-2e6), '-2M');
eq('formatTokens("1500") numeric string', formatTokens('1500'), '1.5K');

// formatPercent
for (const v of [null, undefined, '', NaN, Infinity, 'x'])
    eq(`formatPercent(${String(v)}) -> dash`, formatPercent(v), DASH);
eq('formatPercent(0)', formatPercent(0), '0%');
eq('formatPercent(42.4)', formatPercent(42.4), '42%');
eq('formatPercent(42.5)', formatPercent(42.5), '43%');
eq('formatPercent(100)', formatPercent(100), '100%');
eq('formatPercent(150)', formatPercent(150), '150%');
eq('formatPercent(-3)', formatPercent(-3), '-3%');
eq('formatPercent("7")', formatPercent('7'), '7%');

// toDate
eq('toDate(null)', toDate(null), null);
eq('toDate(undefined)', toDate(undefined), null);
eq('toDate("")', toDate(''), null);
eq('toDate(invalid Date)', toDate(new Date(NaN)), null);
eq('toDate("garbage")', toDate('garbage'), null);
eq('toDate(NaN)', toDate(NaN), null);
{
    const d = D(2025, 11, 9, 10, 0);
    eq('toDate(Date) same instance', toDate(d), d);
    eq('toDate(ms)', toDate(d.getTime()).getTime(), d.getTime());
    eq('toDate(ISO)', toDate('2025-11-09T10:00:00Z').getTime(), Date.UTC(2025, 10, 9, 10, 0, 0));
    eq('toDate(0) epoch', toDate(0).getTime(), 0);
}

// dayKey
eq('dayKey pads', dayKey(D(2025, 1, 5)), '2025-01-05');
eq('dayKey Dec 31', dayKey(D(2025, 12, 31, 23, 59)), '2025-12-31');
eq('dayKey Jan 1', dayKey(D(2026, 1, 1, 0, 0)), '2026-01-01');
eq('dayKey leap day', dayKey(D(2024, 2, 29)), '2024-02-29');

// formatCountdown
{
    const now = D(2025, 11, 9, 12, 0, 0);
    const at = ms => new Date(now.getTime() + ms);
    const S = 1000, M = 60 * S, H = 60 * M, DAY = 24 * H;
    for (const v of [null, undefined, '', 'junk', new Date(NaN)])
        eq(`formatCountdown(${String(v)}) -> dash`, formatCountdown(v, now), DASH);
    eq('countdown past', formatCountdown(at(-5 * M), now), 'a breve');
    eq('countdown exactly now', formatCountdown(at(0), now), 'a breve');
    eq('countdown 1 ms', formatCountdown(at(1), now), '< 1 min');
    eq('countdown 59.999 s', formatCountdown(at(59999), now), '< 1 min');
    eq('countdown 60 s', formatCountdown(at(60 * S), now), 'tra 1 min');
    eq('countdown 59 min', formatCountdown(at(59 * M), now), 'tra 59 min');
    eq('countdown 59 min 59 s', formatCountdown(at(59 * M + 59 * S), now), 'tra 59 min');
    eq('countdown 60 min', formatCountdown(at(60 * M), now), 'tra 1 h');
    eq('countdown 1 h 1 min', formatCountdown(at(61 * M), now), 'tra 1 h 1 min');
    eq('countdown 2 h 15 min', formatCountdown(at(2 * H + 15 * M), now), 'tra 2 h 15 min');
    eq('countdown 23 h', formatCountdown(at(23 * H), now), 'tra 23 h');
    eq('countdown 23 h 59 min', formatCountdown(at(23 * H + 59 * M), now), 'tra 23 h 59 min');
    eq('countdown 24 h', formatCountdown(at(DAY), now), 'tra 1 g');
    eq('countdown 24 h 30 min -> minutes dropped', formatCountdown(at(DAY + 30 * M), now), 'tra 1 g');
    eq('countdown 1 g 1 h', formatCountdown(at(DAY + H), now), 'tra 1 g 1 h');
    eq('countdown 3 g 5 h', formatCountdown(at(3 * DAY + 5 * H), now), 'tra 3 g 5 h');
    eq('countdown 7 g', formatCountdown(at(7 * DAY), now), 'tra 7 g');
    eq('countdown accepts ms number', formatCountdown(now.getTime() + 5 * M, now), 'tra 5 min');
    eq('countdown accepts ISO string', formatCountdown(at(2 * H).toISOString(), now), 'tra 2 h');
}

// formatRelativeTime
{
    const now = D(2025, 11, 9, 12, 0, 0);
    const ago = ms => new Date(now.getTime() - ms);
    const S = 1000, M = 60 * S, H = 60 * M;
    for (const v of [null, undefined, '', 'junk', new Date(NaN)])
        eq(`formatRelativeTime(${String(v)}) -> mai`, formatRelativeTime(v, now), 'mai');
    eq('relative 0', formatRelativeTime(ago(0), now), 'adesso');
    eq('relative 59.999 s', formatRelativeTime(ago(59999), now), 'adesso');
    eq('relative future -> adesso', formatRelativeTime(new Date(now.getTime() + 5 * M), now), 'adesso');
    eq('relative 60 s', formatRelativeTime(ago(60 * S), now), '1 min fa');
    eq('relative 59 min 59 s', formatRelativeTime(ago(59 * M + 59 * S), now), '59 min fa');
    eq('relative 60 min', formatRelativeTime(ago(60 * M), now), '1 h fa');
    eq('relative 2 h 59 min', formatRelativeTime(ago(2 * H + 59 * M), now), '2 h fa');
    eq('relative 23 h 59 min', formatRelativeTime(ago(23 * H + 59 * M), now), '23 h fa');
    eq('relative 24 h -> HH:MM', formatRelativeTime(D(2025, 11, 8, 12, 0), now), '12:00');
    eq('relative old -> padded HH:MM', formatRelativeTime(D(2025, 11, 7, 9, 5), now), '09:05');
    eq('relative much older -> HH:MM', formatRelativeTime(D(2025, 10, 1, 23, 59), now), '23:59');
    eq('relative accepts ms', formatRelativeTime(now.getTime() - 5 * M, now), '5 min fa');
}

// formatDayLabel
{
    const now = D(2025, 11, 10, 15, 30); // Monday
    eq('day Oggi', formatDayLabel('2025-11-10', now), 'Oggi');
    eq('day Oggi late night now', formatDayLabel('2025-11-10', D(2025, 11, 10, 23, 59)), 'Oggi');
    eq('day Ieri', formatDayLabel('2025-11-09', now), 'Ieri');
    eq('day older', formatDayLabel('2025-11-08', now), 'sab 8 nov');
    eq('day 1 week back', formatDayLabel('2025-11-03', now), 'lun 3 nov');
    eq('day future', formatDayLabel('2025-11-11', now), 'mar 11 nov');
    eq('day Date object today', formatDayLabel(D(2025, 11, 10, 3, 0), now), 'Oggi');
    eq('day Date object old', formatDayLabel(D(2025, 11, 1, 3, 0), now), 'sab 1 nov');
    eq('day Ieri across month', formatDayLabel('2025-10-31', D(2025, 11, 1, 8, 0)), 'Ieri');
    eq('day Ieri across year', formatDayLabel('2025-12-31', D(2026, 1, 1, 8, 0)), 'Ieri');
    eq('day Ieri leap Feb 29', formatDayLabel('2024-02-29', D(2024, 3, 1, 8, 0)), 'Ieri');
    eq('day Ieri non-leap Feb 28', formatDayLabel('2025-02-28', D(2025, 3, 1, 8, 0)), 'Ieri');
    eq('day label Jan', formatDayLabel('2026-01-01', D(2026, 1, 15)), 'gio 1 gen');
    eq('day label Dec', formatDayLabel('2025-12-25', D(2026, 1, 15)), 'gio 25 dic');
    eq('day label all months',
        ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']
            .map(m => formatDayLabel(`2025-${m}-15`, D(2030, 6, 1)).split(' ')[2]).join(','),
        'gen,feb,mar,apr,mag,giu,lug,ago,set,ott,nov,dic');
    // 2025-11-02 is a Sunday
    eq('day label all weekdays',
        ['02', '03', '04', '05', '06', '07', '08']
            .map(d => formatDayLabel(`2025-11-${d}`, D(2030, 6, 1)).split(' ')[0]).join(','),
        'dom,lun,mar,mer,gio,ven,sab');
    eq('day invalid 2025-02-30 returns input', formatDayLabel('2025-02-30', now), '2025-02-30');
    eq('day invalid abc returns input', formatDayLabel('abc', now), 'abc');
    eq('day invalid month 13 returns input', formatDayLabel('2025-13-01', now), '2025-13-01');
    eq('day non-padded 2025-1-1 returns input', formatDayLabel('2025-1-1', now), '2025-1-1');
    eq('day non-leap Feb 29 returns input', formatDayLabel('2025-02-29', now), '2025-02-29');
    eq('day empty -> dash', formatDayLabel('', now), DASH);
    eq('day null -> dash', formatDayLabel(null, now), DASH);
    eq('day undefined -> dash', formatDayLabel(undefined, now), DASH);
    eq('day invalid Date -> dash', formatDayLabel(new Date(NaN), now), DASH);
    eq('day number -> dash', formatDayLabel(5, now), DASH);
}

// formatWeekdayShort
{
    const now = D(2025, 11, 10, 15, 30);
    eq('weekday today -> oggi', formatWeekdayShort('2025-11-10', now), 'oggi');
    eq('weekday yesterday (no Ieri)', formatWeekdayShort('2025-11-09', now), 'dom');
    eq('weekday mon', formatWeekdayShort('2025-11-03', now), 'lun');
    eq('weekday sat', formatWeekdayShort('2025-11-08', now), 'sab');
    eq('weekday invalid -> dash', formatWeekdayShort('2025-02-30', now), DASH);
    eq('weekday abc -> dash', formatWeekdayShort('abc', now), DASH);
    eq('weekday null -> dash', formatWeekdayShort(null, now), DASH);
    eq('weekday Date object -> dash', formatWeekdayShort(D(2025, 11, 10), now), DASH);
}

// levelFor
eq('level null -> unknown', levelFor(null, 70, 90), 'unknown');
eq('level undefined -> unknown', levelFor(undefined, 70, 90), 'unknown');
eq('level "" -> unknown', levelFor('', 70, 90), 'unknown');
eq('level NaN -> unknown', levelFor(NaN, 70, 90), 'unknown');
eq('level "x" -> unknown', levelFor('x', 70, 90), 'unknown');
eq('level 0 normal', levelFor(0, 70, 90), 'normal');
eq('level 69.9 normal', levelFor(69.9, 70, 90), 'normal');
eq('level 70 warning', levelFor(70, 70, 90), 'warning');
eq('level 89.9 warning', levelFor(89.9, 70, 90), 'warning');
eq('level 90 critical', levelFor(90, 70, 90), 'critical');
eq('level 100 critical', levelFor(100, 70, 90), 'critical');
eq('level custom thresholds normal', levelFor(40, 50, 80), 'normal');
eq('level custom thresholds warning', levelFor(50, 50, 80), 'warning');
eq('level custom thresholds critical', levelFor(80, 50, 80), 'critical');
eq('level numeric string percent', levelFor('95', 70, 90), 'critical');
eq('level undefined thresholds -> 70/90 warning', levelFor(75, undefined, undefined), 'warning');
eq('level undefined thresholds -> 70/90 critical', levelFor(95, undefined, undefined), 'critical');
eq('level undefined thresholds -> 70/90 normal', levelFor(50, undefined, undefined), 'normal');
eq('level NaN warn falls back to 70', levelFor(70, NaN, 90), 'warning');
eq('level "x" critical falls back to 90', levelFor(90, 70, 'x'), 'critical');
eq('level only warn custom', levelFor(60, 55, undefined), 'warning');
eq('level null threshold coerces to 0', levelFor(1, null, null), 'critical');
eq('level warn > critical: critical wins', levelFor(60, 80, 50), 'critical');

print(`\n${passed} passed, ${failed} failed`);
System.exit(failed > 0 ? 1 : 0);
