import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

import {ClaudeMeterIndicator} from './lib/indicator.js';
import {TokenParser} from './lib/tokenParser.js';
import {UsageManager} from './lib/usageManager.js';
import {DataManager} from './lib/dataManager.js';

// Minimum spacing between two plan requests triggered by menu-open / manual refresh.
const PLAN_MIN_SPACING_MS = 15 * 1000;
// Back-off after HTTP 429.
const RATE_LIMIT_BASE_MS = 2 * 60 * 1000;
const RATE_LIMIT_MAX_MS = 15 * 60 * 1000;
// Persist parser offsets at least this often even without new records.
const FORCED_SAVE_MS = 10 * 60 * 1000;
const RESUME_DELAY_S = 5;

const PLAN_ERRORS = {
    'no-credentials': 'Credenziali Claude Code non trovate',
    'expired': 'Credenziali scadute: apri Claude Code per rinnovarle',
    'unauthorized': 'Accesso negato da Anthropic',
    'rate-limited': 'Troppe richieste, nuovo tentativo a breve',
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
        this._planBackoffUntil = 0;
        this._rateLimitHits = 0;
        this._lastSave = 0;
        this._lastHistoryJson = null;
        this._ready = false;

        this._indicator = new ClaudeMeterIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.connect('refresh-requested', () => this._refresh({force: false}));

        this._settingsChangedId = this._settings.connect('changed::refresh-interval',
            () => this._restartTimer());

        this._loginManager = LoginManager.getLoginManager();
        this._sleepId = this._loginManager.connect('prepare-for-sleep', (_lm, aboutToSuspend) => {
            if (aboutToSuspend)
                return;
            this._removeResumeSource();
            this._resumeSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESUME_DELAY_S, () => {
                this._resumeSourceId = 0;
                this._planBackoffUntil = 0;
                this._refresh({force: true});
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
        this._renderTokens(null);
        this._restartTimer();
        await this._refresh({force: true});
    }

    _restartTimer() {
        this._removeTimer();
        const interval = Math.max(30, this._settings.get_uint('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh({force: true});
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
     * @param {object} opts
     * @param {boolean} opts.force - true for timer/startup ticks; false for menu-open and
     *   manual clicks, which are throttled for the network part.
     */
    _refresh({force}) {
        if (!this._ready || !this._cancellable)
            return Promise.resolve();
        if (this._refreshing) {
            this._pendingRefresh = true;
            return this._refreshing;
        }
        this._refreshing = this._doRefresh(force)
            .catch(e => {
                if (!isCancelled(e))
                    console.error(`Claude Meter: refresh failed: ${e.message}`);
            })
            .finally(() => {
                this._refreshing = null;
                if (this._pendingRefresh && this._cancellable) {
                    this._pendingRefresh = false;
                    this._refresh({force: false});
                }
            });
        return this._refreshing;
    }

    async _doRefresh(force) {
        const cancellable = this._cancellable;
        const indicator = this._indicator;
        indicator.setRefreshing(true);

        const [planOk, tokensOk] = await Promise.all([
            this._refreshPlan(force, cancellable),
            this._refreshTokens(cancellable),
        ]);

        if (cancellable.is_cancelled())
            return;
        if (planOk || tokensOk)
            indicator.setLastUpdated(new Date());
        indicator.setRefreshing(false);
    }

    // Returns true on success, false on failure or when skipped.
    async _refreshPlan(force, cancellable) {
        const now = Date.now();
        if (now < this._planBackoffUntil)
            return false;
        if (!force && now - this._lastPlanAttempt < PLAN_MIN_SPACING_MS)
            return false;
        this._lastPlanAttempt = now;

        try {
            const usage = await this._usage.fetch(cancellable);
            if (cancellable.is_cancelled())
                return false;
            this._rateLimitHits = 0;
            this._indicator.setPlanUsage(usage, null);
            return true;
        } catch (e) {
            if (isCancelled(e) || cancellable.is_cancelled())
                return false;
            const code = e.code ?? 'network';
            if (code === 'rate-limited') {
                this._rateLimitHits++;
                const delay = Math.min(RATE_LIMIT_BASE_MS * 2 ** (this._rateLimitHits - 1), RATE_LIMIT_MAX_MS);
                this._planBackoffUntil = Date.now() + delay;
            }
            console.debug(`Claude Meter: plan usage unavailable (${code})`);
            this._indicator.setPlanUsage(null, PLAN_ERRORS[code] ?? PLAN_ERRORS.network);
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
            if (records.length > 0 || now - this._lastSave > FORCED_SAVE_MS) {
                this._lastSave = now;
                await this._data.save();
            }
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
