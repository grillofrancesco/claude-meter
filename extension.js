import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

import {ClaudeMeterIndicator} from './lib/indicator.js';
import {TokenParser} from './lib/tokenParser.js';
import {UsageManager} from './lib/usageManager.js';
import {DataManager} from './lib/dataManager.js';
import {SessionMonitor} from './lib/sessionMonitor.js';

// The usage endpoint rate-limits aggressively (HTTP 429): plan requests are
// scheduled separately from the local token scan.
// Menu open refreshes the plan only if the last good value is older than this.
const PLAN_STALE_ON_OPEN_MS = 60 * 1000;
// Menu open never retries the plan more often than this (e.g. while offline).
const PLAN_MIN_SPACING_MS = 60 * 1000;
// Timer ticks are coarse: accept a plan tick slightly early.
const PLAN_TICK_TOLERANCE_MS = 5 * 1000;
// Back-off after HTTP 429 (doubles on each consecutive 429).
const RATE_LIMIT_BASE_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_MS = 30 * 60 * 1000;
// Persist parser offsets at least this often even without new records.
const FORCED_SAVE_MS = 10 * 60 * 1000;
const RESUME_DELAY_S = 5;
// Fetch the plan this long after a window's reset time (the server needs a
// moment to roll the window over).
const RESET_FETCH_DELAY_S = 15;
// Pending refreshes collapse into one: the reason that fetches the plan most
// eagerly wins.
const REASON_PRIORITY = ['reset', 'startup', 'resume', 'tick', 'open'];
// Claude Code sessions (crabs): file changes are picked up right away; the
// poll catches processes that died without removing their file.
const SESSION_POLL_S = 5;
const SESSION_DEBOUNCE_MS = 250;

const PLAN_ERRORS = {
    'no-credentials': 'Credenziali Claude Code non trovate',
    'expired': 'Credenziali scadute: apri Claude Code per rinnovarle',
    'unauthorized': 'Accesso negato da Anthropic',
    'rate-limited': 'Troppe richieste ad Anthropic',
    'network': 'Anthropic non raggiungibile',
    'invalid-response': 'Risposta non valida da Anthropic',
};

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export default class ClaudeMeterExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();

        this._parser = new TokenParser();
        this._usage = new UsageManager();
        this._data = new DataManager();

        this._refreshing = null;
        this._pendingReason = null;
        this._planUsage = null;
        this._lastPlanAttempt = 0;
        this._lastPlanSuccess = 0;
        this._planBackoffUntil = 0;
        this._rateLimitHits = 0;
        this._lastSave = 0;
        this._lastHistoryJson = null;
        this._ready = false;

        this._indicator = new ClaudeMeterIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.connect('refresh-requested', () => this._refresh({reason: 'open'}));

        this._settingsChangedId = this._settings.connect('changed::refresh-interval',
            () => this._restartTimer());

        this._sessions = new SessionMonitor();
        this._sessionScanning = false;
        this._sessionRescan = false;
        this._crabModeId = this._settings.connect('changed::crabs-enabled',
            () => this._updateSessionWatch());
        this._updateSessionWatch();

        this._loginManager = LoginManager.getLoginManager();
        this._sleepId = this._loginManager.connect('prepare-for-sleep', (_lm, aboutToSuspend) => {
            if (aboutToSuspend)
                return;
            this._removeResumeSource();
            this._resumeSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESUME_DELAY_S, () => {
                this._resumeSourceId = 0;
                this._refresh({reason: 'resume'});
                return GLib.SOURCE_REMOVE;
            });
        });

        this._start().catch(e => {
            if (!isCancelled(e))
                console.error(`Claude Meter: startup failed: ${e.message}`);
        });
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;

        this._removeTimer();
        this._removeResumeSource();
        this._removeResetSource();
        this._stopSessionWatch();
        if (this._crabModeId) {
            this._settings.disconnect(this._crabModeId);
            this._crabModeId = 0;
        }
        this._sessions = null;

        if (this._sleepId) {
            this._loginManager.disconnect(this._sleepId);
            this._sleepId = 0;
        }
        this._loginManager = null;

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._usage?.destroy();
        this._usage = null;
        this._parser = null;
        this._data = null;
        this._refreshing = null;
    }

    // ------------------------------------------------------------ sessions / crabs

    _updateSessionWatch() {
        if (!this._settings.get_boolean('crabs-enabled')) {
            this._stopSessionWatch();
            this._indicator?.setSessions([]);
            return;
        }
        if (this._sessionPollId)
            return;

        try {
            const dir = Gio.File.new_for_path(this._sessions.directory);
            this._sessionDirMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._sessionDirMonitor.connect('changed', () => this._queueSessionScan());
        } catch (e) {
            console.debug(`Claude Meter: session directory not watched: ${e.message}`);
            this._sessionDirMonitor = null;
        }
        this._sessionPollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SESSION_POLL_S, () => {
            this._scanSessions();
            return GLib.SOURCE_CONTINUE;
        });
        this._scanSessions();
    }

    _stopSessionWatch() {
        if (this._sessionPollId) {
            GLib.source_remove(this._sessionPollId);
            this._sessionPollId = 0;
        }
        if (this._sessionDebounceId) {
            GLib.source_remove(this._sessionDebounceId);
            this._sessionDebounceId = 0;
        }
        this._sessionDirMonitor?.cancel();
        this._sessionDirMonitor = null;
    }

    _queueSessionScan() {
        if (this._sessionDebounceId)
            return;
        this._sessionDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SESSION_DEBOUNCE_MS, () => {
            this._sessionDebounceId = 0;
            this._scanSessions();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _scanSessions() {
        if (!this._sessions || !this._cancellable)
            return;
        if (this._sessionScanning) {
            this._sessionRescan = true;
            return;
        }
        this._sessionScanning = true;
        const cancellable = this._cancellable;
        try {
            const sessions = await this._sessions.scan(cancellable);
            if (!cancellable.is_cancelled() && this._sessionPollId)
                this._indicator?.setSessions(sessions);
        } catch (e) {
            if (!isCancelled(e))
                console.debug(`Claude Meter: session scan failed: ${e.message}`);
        } finally {
            this._sessionScanning = false;
            if (this._sessionRescan && !cancellable.is_cancelled()) {
                this._sessionRescan = false;
                this._scanSessions();
            }
        }
    }

    async _start() {
        const cancellable = this._cancellable;
        await this._data.load();
        if (cancellable.is_cancelled())
            return;
        this._ready = true;
        this._restorePlan();
        this._renderTokens(null);
        this._restartTimer();
        await this._refresh({reason: 'startup'});
    }

    // Show the last persisted plan values right away (marked by their age) and
    // keep honouring a 429 back-off that started before a re-login.
    _restorePlan() {
        const plan = this._data.getPlan();
        this._planBackoffUntil = plan.backoffUntil;
        this._rateLimitHits = plan.rateLimitHits;
        if (plan.usage) {
            this._lastPlanSuccess = plan.usage.fetchedAt.getTime();
            this._planUsage = plan.usage;
            this._indicator.setPlanUsage(plan.usage, null);
            this._scheduleResetFetch();
        }
        if (Date.now() < this._planBackoffUntil) {
            this._indicator.setPlanUsage(null, PLAN_ERRORS['rate-limited']);
            this._indicator.setPlanRetryAt(new Date(this._planBackoffUntil));
        }
    }

    _saveState() {
        this._lastSave = Date.now();
        return this._data.save().catch(e => {
            if (!isCancelled(e))
                console.debug(`Claude Meter: state save failed: ${e.message}`);
        });
    }

    _restartTimer() {
        this._removeTimer();
        const interval = Math.max(30, this._settings.get_uint('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh({reason: 'tick'});
            return GLib.SOURCE_CONTINUE;
        });
    }

    _removeTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    /** Next plan fetch right after the earliest future window reset. */
    _scheduleResetFetch() {
        this._removeResetSource();
        const now = Date.now();
        const next = this._resetTimes()
            .filter(t => t > now)
            .reduce((min, t) => Math.min(min, t), Infinity);
        if (!Number.isFinite(next))
            return;
        // Capped (timer drift, suspend): an early wake-up just reschedules.
        const seconds = Math.min(3600, Math.ceil((next - now) / 1000) + RESET_FETCH_DELAY_S);
        this._resetSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._resetSourceId = 0;
            if (this._planExpired(Date.now()))
                this._refresh({reason: 'reset'});
            else
                this._scheduleResetFetch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _removeResetSource() {
        if (this._resetSourceId) {
            GLib.source_remove(this._resetSourceId);
            this._resetSourceId = 0;
        }
    }

    _resetTimes() {
        const usage = this._planUsage;
        return [usage?.fiveHour, usage?.sevenDay]
            .map(w => w?.resetsAt instanceof Date ? w.resetsAt.getTime() : null)
            .filter(t => t !== null && Number.isFinite(t));
    }

    /** True when a shown window has passed its reset time (its value is outdated). */
    _planExpired(now) {
        return this._resetTimes().some(t => t <= now);
    }

    _removeResumeSource() {
        if (this._resumeSourceId) {
            GLib.source_remove(this._resumeSourceId);
            this._resumeSourceId = 0;
        }
    }

    /**
     * Local tokens are always rescanned; the plan request depends on `reason`
     * (see _isPlanDue).
     * @param {object} opts
     * @param {'startup'|'tick'|'open'|'resume'|'reset'} opts.reason
     */
    _refresh({reason}) {
        if (!this._ready || !this._cancellable)
            return Promise.resolve();
        if (this._refreshing) {
            // Keep the most eager reason: a queued tick or reset must not
            // degrade to 'open' and lose its plan fetch.
            const pending = this._pendingReason;
            if (!pending || REASON_PRIORITY.indexOf(reason) < REASON_PRIORITY.indexOf(pending))
                this._pendingReason = reason;
            return this._refreshing;
        }
        this._refreshing = this._doRefresh(reason)
            .catch(e => {
                if (!isCancelled(e))
                    console.error(`Claude Meter: refresh failed: ${e.message}`);
            })
            .finally(() => {
                this._refreshing = null;
                const pending = this._pendingReason;
                this._pendingReason = null;
                if (pending && this._cancellable)
                    this._refresh({reason: pending});
            });
        return this._refreshing;
    }

    async _doRefresh(reason) {
        const cancellable = this._cancellable;
        await Promise.all([
            this._refreshPlan(reason, cancellable),
            this._refreshTokens(cancellable),
        ]);
    }

    _isPlanDue(reason, now) {
        // A 429 back-off is always honoured (also across re-logins).
        if (now < this._planBackoffUntil)
            return false;
        const sinceAttempt = now - this._lastPlanAttempt;
        const sinceSuccess = now - this._lastPlanSuccess;
        const interval = Math.max(60, this._settings.get_uint('plan-refresh-interval')) * 1000;
        // A window past its reset time shows "—": get the new value soon.
        const expired = this._planExpired(now);

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

    // Returns true on success, false on failure or when skipped.
    async _refreshPlan(reason, cancellable) {
        const now = Date.now();
        if (!this._isPlanDue(reason, now))
            return false;
        this._lastPlanAttempt = now;

        try {
            const usage = await this._usage.fetch(cancellable);
            if (cancellable.is_cancelled())
                return false;
            this._rateLimitHits = 0;
            this._planBackoffUntil = 0;
            this._lastPlanSuccess = Date.now();
            this._planUsage = usage;
            this._scheduleResetFetch();
            this._indicator.setPlanUsage(usage, null);
            this._indicator.setPlanRetryAt(null);
            this._data.setPlan({usage, backoffUntil: 0, rateLimitHits: 0});
            this._saveState();
            return true;
        } catch (e) {
            if (isCancelled(e) || cancellable.is_cancelled())
                return false;
            const code = e.code ?? 'network';
            if (code === 'rate-limited') {
                this._rateLimitHits++;
                const exponential = Math.min(RATE_LIMIT_BASE_MS * 2 ** (this._rateLimitHits - 1),
                    RATE_LIMIT_MAX_MS);
                const delay = Math.max(exponential, e.retryAfterMs ?? 0);
                this._planBackoffUntil = Date.now() + delay;
                this._data.setPlan({backoffUntil: this._planBackoffUntil, rateLimitHits: this._rateLimitHits});
                this._saveState();
            }
            console.debug(`Claude Meter: plan usage unavailable (${code})`);
            this._indicator.setPlanUsage(null, PLAN_ERRORS[code] ?? PLAN_ERRORS.network);
            this._indicator.setPlanRetryAt(code === 'rate-limited' ? new Date(this._planBackoffUntil) : null);
            return false;
        }
    }

    async _refreshTokens(cancellable) {
        try {
            const records = await this._parser.scan(this._data.parserState, cancellable);
            if (cancellable.is_cancelled())
                return false;
            this._data.addRecords(records);
            this._data.prune(new Date());

            const now = Date.now();
            if (records.length > 0 || now - this._lastSave > FORCED_SAVE_MS)
                await this._saveState();
            if (cancellable.is_cancelled())
                return false;
            this._renderTokens(null);
            return true;
        } catch (e) {
            if (isCancelled(e) || cancellable.is_cancelled())
                return false;
            console.debug(`Claude Meter: token scan failed: ${e.message}`);
            this._renderTokens('Sessioni Claude Code non leggibili');
            return false;
        }
    }

    _renderTokens(error) {
        this._indicator.setTokens(error ? null : this._data.getToday(), error);
        const history = this._data.getHistory(30);
        const json = JSON.stringify(history);
        if (json !== this._lastHistoryJson) {
            this._lastHistoryJson = json;
            this._indicator.setHistory(history);
        }
    }
}
