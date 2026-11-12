import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

import {ClaudeMeterIndicator} from './lib/indicator.js';
import {TokenParser} from './lib/tokenParser.js';
import {UsageManager} from './lib/usageManager.js';
import {DataManager} from './lib/dataManager.js';

// The usage endpoint rate-limits aggressively (HTTP 429): plan requests are
// scheduled separately from the local token scan.
// Menu open refreshes the plan only if the last good value is older than this.
const PLAN_STALE_ON_OPEN_MS = 3 * 60 * 1000;
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
        this._pendingRefresh = false;
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
            this._indicator.setPlanUsage(plan.usage, null);
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
     * @param {'startup'|'tick'|'open'|'resume'} opts.reason
     */
    _refresh({reason}) {
        if (!this._ready || !this._cancellable)
            return Promise.resolve();
        if (this._refreshing) {
            this._pendingRefresh = true;
            return this._refreshing;
        }
        this._refreshing = this._doRefresh(reason)
            .catch(e => {
                if (!isCancelled(e))
                    console.error(`Claude Meter: refresh failed: ${e.message}`);
            })
            .finally(() => {
                this._refreshing = null;
                if (this._pendingRefresh && this._cancellable) {
                    this._pendingRefresh = false;
                    this._refresh({reason: 'open'});
                }
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

        switch (reason) {
        case 'startup':
            // Persisted values younger than one interval are good enough.
            return sinceSuccess >= interval - PLAN_TICK_TOLERANCE_MS;
        case 'open':
            return sinceSuccess >= PLAN_STALE_ON_OPEN_MS && sinceAttempt >= PLAN_MIN_SPACING_MS;
        case 'resume':
            return sinceSuccess >= PLAN_STALE_ON_OPEN_MS;
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
