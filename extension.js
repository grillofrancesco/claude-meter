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
import {t, setLanguage, resolveLanguage} from './lib/i18n.js';
import {isPlanDue, planExpired, mergeReason, backoffDelay, nextResetFetchDelayS} from './lib/planScheduler.js';

// The usage endpoint rate-limits aggressively (HTTP 429): plan requests are
// scheduled separately from the local token scan (policy: lib/planScheduler.js).

// Persist parser offsets at least this often even without new records.
const FORCED_SAVE_MS = 10 * 60 * 1000;
const RESUME_DELAY_S = 5;
// Claude Code sessions (crabs): file changes are picked up right away; the
// poll catches processes that died without removing their file.
const SESSION_POLL_S = 5;
const SESSION_DEBOUNCE_MS = 250;

// Error strings are translated when shown (see _planErrorText).
function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export default class ClaudeMeterExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();

        setLanguage(resolveLanguage(this._settings.get_string('language')));
        this._languageId = this._settings.connect('changed::language', () => {
            setLanguage(resolveLanguage(this._settings.get_string('language')));
            this._retranslateErrors();
        });
        this._planErrorCode = null;
        this._tokensError = false;

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

        if (this._languageId) {
            this._settings.disconnect(this._languageId);
            this._languageId = 0;
        }

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
            this._planErrorCode = 'rate-limited';
            this._indicator.setPlanUsage(null, this._planErrorText());
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
        const seconds = nextResetFetchDelayS(this._planUsage, Date.now());
        if (seconds === null)
            return;
        this._resetSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._resetSourceId = 0;
            if (planExpired(this._planUsage, Date.now()))
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

    _removeResumeSource() {
        if (this._resumeSourceId) {
            GLib.source_remove(this._resumeSourceId);
            this._resumeSourceId = 0;
        }
    }

    /**
     * Local tokens are always rescanned; the plan request depends on `reason`
     * (see isPlanDue in lib/planScheduler.js).
     * @param {object} opts
     * @param {'startup'|'tick'|'open'|'resume'|'reset'} opts.reason
     */
    _refresh({reason}) {
        if (!this._ready || !this._cancellable)
            return Promise.resolve();
        if (this._refreshing) {
            // Keep the most eager reason: a queued tick or reset must not
            // degrade to 'open' and lose its plan fetch.
            this._pendingReason = mergeReason(this._pendingReason, reason);
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

    // Returns true on success, false on failure or when skipped.
    async _refreshPlan(reason, cancellable) {
        const now = Date.now();
        if (!isPlanDue(reason, now, {
            backoffUntil: this._planBackoffUntil,
            lastAttempt: this._lastPlanAttempt,
            lastSuccess: this._lastPlanSuccess,
            intervalS: this._settings.get_uint('plan-refresh-interval'),
            usage: this._planUsage,
        }))
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
            this._planErrorCode = null;
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
                const delay = backoffDelay(this._rateLimitHits, e.retryAfterMs);
                this._planBackoffUntil = Date.now() + delay;
                this._data.setPlan({backoffUntil: this._planBackoffUntil, rateLimitHits: this._rateLimitHits});
                this._saveState();
            }
            console.debug(`Claude Meter: plan usage unavailable (${code})`);
            this._planErrorCode = code;
            this._indicator.setPlanUsage(null, this._planErrorText());
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
            this._renderTokens(true);
            return false;
        }
    }

    _planErrorText() {
        const code = this._planErrorCode;
        if (!code)
            return null;
        const key = `errors.plan.${code}`;
        const text = t(key);
        return text === key ? t('errors.plan.network') : text;
    }

    // Language switched: re-send the errors currently shown, translated.
    // No fetches: successful values are formatted by the indicator itself.
    _retranslateErrors() {
        if (!this._indicator)
            return;
        if (this._planErrorCode)
            this._indicator.setPlanUsage(null, this._planErrorText());
        if (this._tokensError && this._data)
            this._renderTokens(true);
    }

    // `failed`: true when the token scan failed (the error text is translated here).
    _renderTokens(failed) {
        this._tokensError = !!failed;
        const error = failed ? t('errors.tokens.unreadable') : null;
        this._indicator.setTokens(failed ? null : this._data.getToday(), error);
        const history = this._data.getHistory(30);
        const json = JSON.stringify(history);
        if (json !== this._lastHistoryJson) {
            this._lastHistoryJson = json;
            this._indicator.setHistory(history);
        }
    }
}
