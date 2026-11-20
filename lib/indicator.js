// Top-bar indicator + popup menu for Claude Meter.
// Shell-side module: only imported from extension.js inside GNOME Shell.
// Composition root: the pieces live in lib/ui/ (rings, bars, chart, menu, crabArea, panelSpace).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    formatTokens,
    formatPercent,
    formatCountdown,
    formatRelativeTime,
    formatClock,
    toDate,
} from './format.js';
import {SPRITE_H, MORE_WIDTH, panelWidths, splitSessions} from './crabs.js';
import {createRing, setRing} from './ui/rings.js';
import {setBar} from './ui/bars.js';
import {WeekChart} from './ui/chart.js';
import {MenuPages, createSection, createHeaderLabel, createMeterRow, createValueRow} from './ui/menu.js';
import {CrabArea} from './ui/crabArea.js';
import {PanelSpace} from './ui/panelSpace.js';
import {t, onLanguageChanged, disconnectLanguage} from './i18n.js';

const COLOR_MODES = ['accent', 'traffic'];
const TICK_SECONDS = 30;
const DEFAULT_WARN = 70;
const DEFAULT_CRITICAL = 90;
const PANEL_KEYS = ['panel-show-five-hour', 'panel-show-seven-day', 'crabs-enabled', 'crab-max',
    'crab-overflow', 'panel-empty'];

/**
 * A window counts only until its reset time: afterwards the old percentage is
 * no longer true, so it is treated as unknown until a fresh value arrives.
 */
function liveWindow(entry, now = Date.now()) {
    if (!entry)
        return null;
    const resetsAt = toDate(entry.resetsAt);
    if (resetsAt && resetsAt.getTime() <= now)
        return null;
    return entry;
}

export const ClaudeMeterIndicator = GObject.registerClass({
    Signals: {
        // Emitted when the menu opens; the extension decides what is stale.
        'refresh-requested': {},
    },
}, class ClaudeMeterIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Claude Meter');

        this._extension = extension ?? null;
        this._settings = null;
        try {
            this._settings = typeof extension?.getSettings === 'function'
                ? extension.getSettings()
                : null;
        } catch (e) {
            console.debug(`claude-meter: impostazioni non disponibili: ${e.message}`);
            this._settings = null;
        }

        // Cached data (last valid values, kept on errors).
        this._usage = null;
        this._usageError = null;
        this._tokens = null;
        this._tokensError = null;
        this._history = [];
        this._planRetryAt = null;

        this._tickId = 0;
        this._resetTimerId = 0;

        this._sessions = [];
        this._colorMode = 'accent';

        this._warnThreshold = DEFAULT_WARN;
        this._criticalThreshold = DEFAULT_CRITICAL;
        this._readThresholds();

        this._buildPanel();
        this._buildMenu();
        this._renderPlan();
        this._renderTokens();
        this._renderHistory();
        this._updatePlanAge();
        this._pages.show('main');
        this._langId = onLanguageChanged(() => this._relabel());

        this.menu.connectObject('open-state-changed',
            (_menu, isOpen) => this._onMenuOpenChanged(isOpen), this);

        this._applyColorMode();
        this._updatePanelLayout();

        if (this._settings) {
            for (const key of PANEL_KEYS)
                this._settings.connectObject(`changed::${key}`, () => this._updatePanelLayout(), this);
            this._settings.connectObject('changed::bar-color-mode', () => this._applyColorMode(), this);
            for (const key of ['warn-threshold', 'critical-threshold']) {
                this._settings.connectObject(`changed::${key}`, () => {
                    this._readThresholds();
                    this._renderPlan();
                }, this);
            }
        }
    }

    // ---------------------------------------------------------------- public API

    setPlanUsage(usage, error) {
        // Keep the last valid value when the refresh failed.
        if (usage)
            this._usage = usage;
        this._usageError = error ? String(error) : null;
        this._renderPlan();
    }

    setTokens(today, error) {
        if (today)
            this._tokens = today;
        this._tokensError = error ? String(error) : null;
        this._renderTokens();
    }

    setHistory(history) {
        this._history = Array.isArray(history) ? history : [];
        this._renderHistory();
    }

    /** When the next plan request will be attempted after a 429 (null = none). */
    setPlanRetryAt(date) {
        this._planRetryAt = toDate(date);
        this._updatePlanAge();
    }

    /** Open Claude Code sessions: [{id, busy}] oldest first (null = unknown). */
    setSessions(sessions) {
        this._sessions = Array.isArray(sessions) ? sessions : [];
        this._updatePanelLayout();
    }

    destroy() {
        if (this._langId) {
            disconnectLanguage(this._langId);
            this._langId = 0;
        }
        this._stopTick();
        this._stopResetTimer();
        this._crabs.stop();
        this._panelSpace.destroy();
        this.disconnectObject(this);

        this.menu.disconnectObject(this);
        this._sessionsItem.disconnectObject(this);
        this._prefsItem.disconnectObject(this);

        try {
            this._settings?.disconnectObject(this);
        } catch (e) {
            console.debug(`claude-meter: disconnessione impostazioni fallita: ${e.message}`);
        }
        this._settings = null;

        this._usage = null;
        this._tokens = null;
        this._history = [];

        super.destroy();
    }

    // ------------------------------------------------------------------ building

    _buildPanel() {
        this.add_style_class_name('claude-meter-button');
        this._panelBox = new St.BoxLayout({
            style_class: 'claude-meter-panel',
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true,
        });
        // Rings + icon live in their own box: only this group gets the hover/active highlight.
        this._highlightBox = new St.BoxLayout({
            style_class: 'claude-meter-highlight',
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true,
        });

        const path = this._extension?.path;
        this._icon = path
            ? new St.Icon({
                gicon: Gio.icon_new_for_string(`${path}/icons/claude-meter-symbolic.svg`),
                style_class: 'system-status-icon',
            })
            : new St.Icon({
                icon_name: 'dialog-information-symbolic',
                style_class: 'system-status-icon',
            });
        this._highlightBox.add_child(this._icon);

        this._crabs = new CrabArea();
        this._panelBox.add_child(this._crabs.actor);

        this._moreLabel = new St.Label({
            style_class: 'claude-meter-crab-more',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._moreLabel.set_width(MORE_WIDTH);
        this._panelBox.add_child(this._moreLabel);

        // Rings on the right: the box grows leftwards, so they stay put as crabs come and go.
        const getColorMode = () => this._colorMode;
        this._fiveHourRing = createRing(getColorMode);
        this._sevenDayRing = createRing(getColorMode);
        this._highlightBox.add_child(this._fiveHourRing.area);
        this._highlightBox.add_child(this._sevenDayRing.area);
        this._panelBox.add_child(this._highlightBox);

        this.add_child(this._panelBox);

        // Pointer cursor on the whole top-bar area (crabs, "+N", rings, icon): children keep the
        // default INHERIT cursor type. The menu is a separate actor tree, so it is not affected.
        this.set_cursor_type(Clutter.CursorType.POINTER);

        // Mirror the button state on the highlight box (the stock button background is transparent).
        this.connectObject(
            'notify::hover', () => this._syncHighlight(),
            'key-focus-in', () => this._syncHighlight(),
            'key-focus-out', () => this._syncHighlight(),
            this);

        // Measures the button content box (notify::allocation / style-changed) and shifts the crabs.
        this._panelSpace = new PanelSpace(this, this._crabs.actor, this._settings, this._extension,
            () => this._updatePanelLayout());
    }

    _syncHighlight() {
        const box = this._highlightBox;
        if (!box)
            return;
        const set = (name, on) => on ? box.add_style_pseudo_class(name) : box.remove_style_pseudo_class(name);
        set('hover', this.hover);
        set('focus', this.has_key_focus());
        set('active', Boolean(this.menu?.isOpen));
    }

    _readPanelSettings() {
        const get = (fn, key, fallback) => {
            try {
                return this._settings ? this._settings[fn](key) : fallback;
            } catch (e) {
                return fallback;
            }
        };
        return {
            showFiveHour: get('get_boolean', 'panel-show-five-hour', true),
            showSevenDay: get('get_boolean', 'panel-show-seven-day', true),
            crabsEnabled: get('get_boolean', 'crabs-enabled', true),
            crabMax: get('get_uint', 'crab-max', 3),
            overflow: get('get_string', 'crab-overflow', 'overflow'),
            panelEmpty: get('get_string', 'panel-empty', 'crab'),
        };
    }

    /** Show/hide rings and crabs; the crab area follows the measured space in 'crop' mode. */
    _updatePanelLayout() {
        if (!this._panelBox)
            return;
        const cfg = this._readPanelSettings();

        this._fiveHourRing.area.visible = cfg.showFiveHour;
        this._sevenDayRing.area.visible = cfg.showSevenDay;

        const {shown, hidden} = splitSessions(this._sessions, cfg.crabMax, cfg.crabsEnabled);

        // Nothing to show (no session crab, no "+N"): sleeping placeholder crab or the icon.
        const empty = shown.length === 0 && hidden === 0;
        // Clawds off: always the icon (the saved panel-empty choice is kept for later).
        const placeholder = empty && cfg.crabsEnabled && cfg.panelEmpty !== 'icon';
        const crabCount = placeholder ? 1 : shown.length;

        const contentHeight = this._panelSpace.contentHeight;
        const crop = cfg.overflow === 'crop' && contentHeight > 0 && contentHeight < SPRITE_H;
        this._crabs.update({
            count: crabCount,
            width: crabCount > 0 ? panelWidths({crabs: crabCount}).crabs : 0,
            height: crop ? contentHeight : SPRITE_H,
            shown,
            placeholder,
        });
        this._moreLabel.visible = hidden > 0;
        if (hidden > 0)
            this._moreLabel.text = `+${hidden}`;
        this._icon.visible = empty && !placeholder;
    }

    _buildMenu() {
        const menuTarget = this.menu.box ?? this.menu.actor;
        if (menuTarget && typeof menuTarget.add_style_class_name === 'function')
            menuTarget.add_style_class_name('claude-meter-menu');

        const getColorMode = () => this._colorMode;
        this._pages = new MenuPages(this.menu);
        this._chart = new WeekChart();
        this._pages.detailsFiller = this._chart.filler;
        this._pages.onDetailsShown = () => this._chart.queueRepaint();

        // Titolo + utilizzo del piano.
        const title = createSection();
        this._titleLabel = new St.Label({
            text: t('panel.menu.title'),
            style_class: 'claude-meter-title',
            x_align: Clutter.ActorAlign.START,
        });
        title.box.add_child(this._titleLabel);

        const plan = createSection();
        this._planItem = plan.item;
        this._planBox = plan.box;

        this._fiveHourRow = createMeterRow(t('panel.plan.fiveHour'), getColorMode);
        this._planBox.add_child(this._fiveHourRow.root);

        this._sevenDayRow = createMeterRow(t('panel.plan.sevenDay'), getColorMode);
        this._planBox.add_child(this._sevenDayRow.root);

        this._planErrorLabel = new St.Label({
            text: '',
            style_class: 'claude-meter-error',
            visible: false,
        });
        this._planBox.add_child(this._planErrorLabel);

        // Età dei dati del piano (+ prossimo tentativo dopo un 429).
        this._planAgeLabel = new St.Label({
            text: '',
            style_class: 'claude-meter-dim claude-meter-plan-age',
            x_align: Clutter.ActorAlign.END,
        });
        this._planBox.add_child(this._planAgeLabel);

        const {mainPage, detailsPage} = this._pages;
        mainPage.addMenuItem(title.item);
        mainPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        mainPage.addMenuItem(this._planItem);
        mainPage.box.add_child(this._pages.mainFiller);
        this._sessionsItem = new PopupMenu.PopupMenuItem(t('panel.menu.manageSessions'));
        this._sessionsItem.connectObject('activate', () => {
            try {
                this._settings?.set_string('prefs-start-page', 'sessions');
            } catch (e) {
                console.debug(`claude-meter: pagina iniziale preferenze non impostata: ${e.message}`);
            }
            this._openPreferences();
        }, this);
        mainPage.addMenuItem(this._sessionsItem);
        mainPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        mainPage.addMenuItem(this._pages.detailsNav);
        this.menu.addMenuItem(mainPage);

        const tokens = createSection();
        this._tokensItem = tokens.item;
        this._tokensBox = tokens.box;

        this._tokensHeader = createHeaderLabel(t('panel.tokens.title'));
        this._tokensBox.add_child(this._tokensHeader);

        this._inputRow = createValueRow(t('panel.tokens.input'));
        this._tokensBox.add_child(this._inputRow.row);

        this._outputRow = createValueRow(t('panel.tokens.output'));
        this._tokensBox.add_child(this._outputRow.row);

        this._tokensErrorLabel = new St.Label({
            text: '',
            style_class: 'claude-meter-error',
            visible: false,
        });
        this._tokensBox.add_child(this._tokensErrorLabel);
        detailsPage.addMenuItem(this._tokensItem);
        detailsPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        detailsPage.addMenuItem(this._chart.item);

        this._prefsItem = new PopupMenu.PopupMenuItem(t('panel.menu.preferences'));
        this._prefsItem.connectObject('activate', () => this._openPreferences(), this);
        detailsPage.addMenuItem(this._prefsItem);
        detailsPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        detailsPage.addMenuItem(this._pages.backNav);
        this.menu.addMenuItem(detailsPage);
    }

    /**
     * Open the preferences window. If it is already open the shell refuses
     * ("Already showing a prefs dialog"): bring the existing window to the front.
     */
    _openPreferences() {
        if (!this._extension || typeof this._extension.openPreferences !== 'function')
            return;
        const title = this._extension.metadata?.name;
        const window = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions' &&
                w.get_title() === title);
        if (window)
            Main.activateWindow(window);
        else
            this._extension.openPreferences();
    }

    // ----------------------------------------------------------------- rendering

    _renderPlan() {
        const usage = this._usage;
        const error = this._usageError;
        const stale = Boolean(error && usage);

        const now = Date.now();
        const fiveHour = liveWindow(usage?.fiveHour, now);
        const sevenDay = liveWindow(usage?.sevenDay, now);

        this._updateMeterRow(this._fiveHourRow, fiveHour, Boolean(usage?.fiveHour && !fiveHour));
        this._setStale(this._fiveHourRow.root, stale);

        this._updateMeterRow(this._sevenDayRow, sevenDay, Boolean(usage?.sevenDay && !sevenDay));
        this._setStale(this._sevenDayRow.root, stale);

        setRing(this._fiveHourRing, fiveHour, stale, this._warnThreshold, this._criticalThreshold);
        setRing(this._sevenDayRing, sevenDay, stale, this._warnThreshold, this._criticalThreshold);
        this._scheduleResetRender(usage, now);

        this._planErrorLabel.text = error ?? '';
        this._planErrorLabel.visible = Boolean(error);
        this._updatePlanAge();
        this._pages.equalize();
    }

    /** @param {boolean} expired the window has reset since the last fetch */
    _updateMeterRow(row, entry, expired = false) {
        const source = entry ?? {};
        const percent = typeof source.percent === 'number' ? source.percent : null;

        row.percent = percent;
        row.resetsAt = toDate(source.resetsAt);
        row.expired = expired;
        row.value.text = formatPercent(percent);
        row.reset.text = this._resetText(row.resetsAt, expired);

        setBar(row.bar, percent, this._warnThreshold, this._criticalThreshold);
    }

    _renderTokens() {
        const tokens = this._tokens;
        const error = this._tokensError;

        this._inputRow.value.text = formatTokens(tokens ? tokens.input : null);
        this._outputRow.value.text = formatTokens(tokens ? tokens.output : null);

        const stale = Boolean(error && tokens);
        this._setStale(this._inputRow.row, stale);
        this._setStale(this._outputRow.row, stale);

        this._tokensErrorLabel.text = error ?? '';
        this._tokensErrorLabel.visible = Boolean(error);
        this._pages.equalize();
    }

    _renderHistory() {
        this._chart.setHistory(this._history);
    }

    _applyColorMode() {
        let mode = 'accent';
        try {
            mode = this._settings?.get_string('bar-color-mode') ?? 'accent';
        } catch (e) {
            mode = 'accent';
        }
        if (!COLOR_MODES.includes(mode))
            mode = 'accent';
        const box = this.menu.box;
        for (const m of COLOR_MODES)
            box.remove_style_class_name(`claude-meter-mode-${m}`);
        box.add_style_class_name(`claude-meter-mode-${mode}`);
        this._colorMode = mode;
        this._fiveHourRing?.area.queue_repaint();
        this._sevenDayRing?.area.queue_repaint();
        this._fiveHourRow?.bar.area.queue_repaint();
        this._sevenDayRow?.bar.area.queue_repaint();
    }

    // ------------------------------------------------------------------- helpers

    _resetText(resetsAt, expired = false) {
        if (expired)
            return t('panel.plan.resetDone');
        if (!resetsAt)
            return t('panel.plan.resetUnknown');
        const countdown = formatCountdown(resetsAt);
        return countdown === '—' ? t('panel.plan.resetUnknown') : t('panel.plan.reset', {countdown});
    }

    _updatePlanAge() {
        if (!this._planAgeLabel)
            return;
        const parts = [];
        const fetchedAt = toDate(this._usage?.fetchedAt);
        if (fetchedAt) {
            const age = formatRelativeTime(fetchedAt);
            parts.push(/^\d{1,2}:\d{2}$/.test(age)
                ? t('panel.age.updatedAt', {time: age})
                : t('panel.age.updated', {age}));
        }
        if (this._planRetryAt && this._planRetryAt.getTime() > Date.now())
            parts.push(t('panel.age.retryAt', {time: formatClock(this._planRetryAt)}));
        const text = parts.join(' · ');
        this._planAgeLabel.text = text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
        this._planAgeLabel.visible = text !== '';
    }

    _setStale(actor, stale) {
        if (!actor)
            return;
        // St CSS has no reliable `opacity` on containers: set it on the actor.
        actor.opacity = stale ? 128 : 255;
    }

    _updateCountdowns() {
        const rows = [this._fiveHourRow, this._sevenDayRow];
        for (const row of rows) {
            if (row)
                row.reset.text = this._resetText(row.resetsAt, row.expired);
        }
        this._updatePlanAge();
    }

    /**
     * Language changed: the menu is built once, so its static labels are re-set
     * and the dynamic texts re-rendered. The panel (crabs, rings, icon) is untouched.
     */
    _relabel() {
        if (!this._titleLabel)
            return;
        this._titleLabel.text = t('panel.menu.title');
        this._fiveHourRow.label.text = t('panel.plan.fiveHour');
        this._sevenDayRow.label.text = t('panel.plan.sevenDay');
        this._sessionsItem.label.text = t('panel.menu.manageSessions');
        this._prefsItem.label.text = t('panel.menu.preferences');
        this._tokensHeader.text = t('panel.tokens.title');
        this._inputRow.label.text = t('panel.tokens.input');
        this._outputRow.label.text = t('panel.tokens.output');
        this._pages.relabel();
        this._chart.relabel();
        this._renderPlan();
        this._renderTokens();
        this._renderHistory();
    }

    /** Re-render the plan right when the next window resets (rings included). */
    _scheduleResetRender(usage, now) {
        this._stopResetTimer();
        const next = [usage?.fiveHour, usage?.sevenDay]
            .map(w => toDate(w?.resetsAt)?.getTime() ?? null)
            .filter(t => t !== null && t > now)
            .reduce((min, t) => Math.min(min, t), Infinity);
        if (!Number.isFinite(next))
            return;
        // Capped: the callback re-renders and schedules again.
        const seconds = Math.min(3600, Math.ceil((next - now) / 1000) + 1);
        this._resetTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._resetTimerId = 0;
            this._renderPlan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopResetTimer() {
        if (!this._resetTimerId)
            return;
        GLib.source_remove(this._resetTimerId);
        this._resetTimerId = 0;
    }

    _readThresholds() {
        this._warnThreshold = DEFAULT_WARN;
        this._criticalThreshold = DEFAULT_CRITICAL;
        if (!this._settings)
            return;

        try {
            this._warnThreshold = this._settings.get_int('warn-threshold');
        } catch (e) {
            this._warnThreshold = DEFAULT_WARN;
        }
        try {
            this._criticalThreshold = this._settings.get_int('critical-threshold');
        } catch (e) {
            this._criticalThreshold = DEFAULT_CRITICAL;
        }
    }

    _onMenuOpenChanged(isOpen) {
        this._syncHighlight();
        if (isOpen) {
            this._updateCountdowns();
            this._pages.equalize();
            this._startTick();
            this.emit('refresh-requested');
        } else {
            this._stopTick();
            this._pages.show('main');
        }
    }

    _startTick() {
        if (this._tickId)
            return;

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._updateCountdowns();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (!this._tickId)
            return;
        GLib.source_remove(this._tickId);
        this._tickId = 0;
    }
});
