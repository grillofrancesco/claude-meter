// Plan-refresh policy (pure: no shell imports, no timers). extension.js owns
// the timers and I/O and asks this module when to fetch and how long to wait.
// The usage endpoint rate-limits aggressively (HTTP 429).

// Menu open refreshes the plan only if the last good value is older than this.
export const PLAN_STALE_ON_OPEN_MS = 60 * 1000;
// Menu open never retries the plan more often than this (e.g. while offline).
export const PLAN_MIN_SPACING_MS = 60 * 1000;
// Timer ticks are coarse: accept a plan tick slightly early.
export const PLAN_TICK_TOLERANCE_MS = 5 * 1000;
// Back-off after HTTP 429 (doubles on each consecutive 429).
export const RATE_LIMIT_BASE_MS = 5 * 60 * 1000;
export const RATE_LIMIT_MAX_MS = 30 * 60 * 1000;
// Fetch the plan this long after a window's reset time (the server needs a
// moment to roll the window over).
export const RESET_FETCH_DELAY_S = 15;
// Pending refreshes collapse into one: the reason that fetches the plan most
// eagerly wins.
export const REASON_PRIORITY = ['reset', 'startup', 'resume', 'tick', 'open'];

/** Reset times (ms epoch) of the shown windows. */
export function resetTimes(usage) {
    return [usage?.fiveHour, usage?.sevenDay]
        .map(w => w?.resetsAt instanceof Date ? w.resetsAt.getTime() : null)
        .filter(t => t !== null && Number.isFinite(t));
}

/** True when a shown window has passed its reset time (its value is outdated). */
export function planExpired(usage, now) {
    return resetTimes(usage).some(t => t <= now);
}

/** Most eager reason between the pending one (or null) and a new one. */
export function mergeReason(pending, reason) {
    if (!pending || REASON_PRIORITY.indexOf(reason) < REASON_PRIORITY.indexOf(pending))
        return reason;
    return pending;
}

/** Back-off (ms) after the `hits`-th consecutive 429 (hits >= 1). */
export function backoffDelay(hits, retryAfterMs = null) {
    const exponential = Math.min(RATE_LIMIT_BASE_MS * 2 ** (hits - 1), RATE_LIMIT_MAX_MS);
    return Math.max(exponential, retryAfterMs ?? 0);
}

/**
 * Whether a plan fetch should happen now.
 * @param {string} reason 'startup'|'tick'|'open'|'resume'|'reset'
 * @param {number} now ms epoch
 * @param {object} s {backoffUntil, lastAttempt, lastSuccess (ms epoch), intervalS
 *   (raw plan-refresh-interval setting, clamped to >= 60 here), usage}
 */
export function isPlanDue(reason, now, {backoffUntil, lastAttempt, lastSuccess, intervalS, usage}) {
    // A 429 back-off is always honoured (also across re-logins).
    if (now < backoffUntil)
        return false;
    const sinceAttempt = now - lastAttempt;
    const sinceSuccess = now - lastSuccess;
    const interval = Math.max(60, intervalS) * 1000;
    // A window past its reset time shows "—": get the new value soon.
    const expired = planExpired(usage, now);

    switch (reason) {
    case 'reset':
        return expired && sinceAttempt >= PLAN_MIN_SPACING_MS;
    case 'startup':
        // Persisted values younger than one interval are good enough.
        return expired || sinceSuccess >= interval - PLAN_TICK_TOLERANCE_MS;
    case 'open':
        return (expired || sinceSuccess >= PLAN_STALE_ON_OPEN_MS) &&
            sinceAttempt >= PLAN_MIN_SPACING_MS;
    case 'resume':
        return expired || sinceSuccess >= PLAN_STALE_ON_OPEN_MS;
    case 'tick':
    default:
        return sinceAttempt >= interval - PLAN_TICK_TOLERANCE_MS;
    }
}

/**
 * Seconds until the next plan fetch after the earliest future reset, or null
 * when no window has a future reset. Capped at 3600 (timer drift, suspend: an
 * early wake-up just reschedules).
 */
export function nextResetFetchDelayS(usage, now) {
    const next = resetTimes(usage)
        .filter(t => t > now)
        .reduce((min, t) => Math.min(min, t), Infinity);
    if (!Number.isFinite(next))
        return null;
    return Math.min(3600, Math.ceil((next - now) / 1000) + RESET_FETCH_DELAY_S);
}
