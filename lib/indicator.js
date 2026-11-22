// Top-bar indicator + popup menu for Claude Meter.
// Shell-side module: only imported from extension.js inside GNOME Shell.
// Composition root: the pieces live in lib/ui/ (rings, bars, chart, menu, planSection, tokensSection, panelBox,
// crabArea, panelSpace).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {WeekChart} from './ui/chart.js';
import {MenuPages, createSection, openPreferences} from './ui/menu.js';
import {PlanSection} from './ui/planSection.js';
import {TokensSection} from './ui/tokensSection.js';
import {PanelBox, PANEL_KEYS} from './ui/panelBox.js';
import {t, onLanguageChanged, disconnectLanguage} from './i18n.js';

const COLOR_MODES = ['accent', 'traffic'];
const TICK_SECONDS = 30;
const DEFAULT_WARN = 70;
const DEFAULT_CRITICAL = 90;

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
        this._history = [];

        this._tickId = 0;

        this._colorMode = 'accent';

        this._warnThreshold = DEFAULT_WARN;
        this._criticalThreshold = DEFAULT_CRITICAL;
        this._readThresholds();

        this._panel = new PanelBox(this, this._extension, this._settings, () => this._colorMode);
        this._buildMenu();
        this._plan.render();
        this._tokensSection.render();
        this._renderHistory();
        this._plan.updateAge();
        this._pages.show('main');
        this._langId = onLanguageChanged(() => this._relabel());

        this.menu.connectObject('open-state-changed',
            (_menu, isOpen) => this._onMenuOpenChanged(isOpen), this);

        this._applyColorMode();
        this._panel.updateLayout();

        if (this._settings) {
            for (const key of PANEL_KEYS)
                this._settings.connectObject(`changed::${key}`, () => this._panel.updateLayout(), this);
            this._settings.connectObject('changed::bar-color-mode', () => this._applyColorMode(), this);
            for (const key of ['warn-threshold', 'critical-threshold']) {
                this._settings.connectObject(`changed::${key}`, () => {
                    this._readThresholds();
                    this._plan.render();
                }, this);
            }
        }
    }

    // ---------------------------------------------------------------- public API

    setPlanUsage(usage, error) {
        this._plan.setUsage(usage, error);
    }

    setTokens(today, error) {
        this._tokensSection.setTokens(today, error);
    }

    setHistory(history) {
        this._history = Array.isArray(history) ? history : [];
        this._renderHistory();
    }

    /** When the next plan request will be attempted after a 429 (null = none). */
    setPlanRetryAt(date) {
        this._plan.setRetryAt(date);
    }

    /** Open Claude Code sessions: [{id, busy}] oldest first (null = unknown). */
    setSessions(sessions) {
        this._panel.setSessions(Array.isArray(sessions) ? sessions : []);
    }

    destroy() {
        if (this._langId) {
            disconnectLanguage(this._langId);
            this._langId = 0;
        }
        this._stopTick();
        this._plan.destroy();
        this._panel.destroy();
        this.disconnectObject(this);

        this.menu.disconnectObject(this);
        this._prefsButton.disconnectObject(this);

        try {
            this._settings?.disconnectObject(this);
        } catch (e) {
            console.debug(`claude-meter: disconnessione impostazioni fallita: ${e.message}`);
        }
        this._settings = null;

        this._tokensSection.destroy();
        this._history = [];

        super.destroy();
    }

    // ------------------------------------------------------------------ building

    _buildMenu() {
        const menuTarget = this.menu.box ?? this.menu.actor;
        if (menuTarget && typeof menuTarget.add_style_class_name === 'function')
            menuTarget.add_style_class_name('claude-meter-menu');

        const getColorMode = () => this._colorMode;
        this._pages = new MenuPages(this.menu);
        this._chart = new WeekChart();
        this._pages.onDetailsShown = () => this._chart.queueRepaint();

        // Title + preferences gear, then the plan usage.
        const title = createSection();
        const titleRow = new St.BoxLayout({
            x_expand: true,
            style_class: 'claude-meter-title-row',
        });
        this._titleLabel = new St.Label({
            text: t('panel.menu.title'),
            style_class: 'claude-meter-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._prefsButton = new St.Button({
            style_class: 'claude-meter-prefs-button',
            can_focus: true,
            track_hover: true,
            cursor_type: Clutter.CursorType.POINTER,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: t('panel.menu.preferences'),
            child: new St.Icon({icon_name: 'emblem-system-symbolic'}),
        });
        this._prefsButton.connectObject('clicked', () => {
            this.menu.close();
            openPreferences(this._extension);
        }, this);
        titleRow.add_child(this._titleLabel);
        titleRow.add_child(this._prefsButton);
        title.box.add_child(titleRow);

        this._plan = new PlanSection(this._pages, {fiveHour: this._panel.fiveHourRing,
            sevenDay: this._panel.sevenDayRing}, getColorMode,
            () => ({warn: this._warnThreshold, critical: this._criticalThreshold}));

        const {mainPage, detailsPage} = this._pages;
        mainPage.addMenuItem(title.item);
        mainPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        mainPage.addMenuItem(this._plan.item);
        mainPage.box.add_child(this._pages.mainFiller);
        mainPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        mainPage.addMenuItem(this._pages.detailsNav);
        this.menu.addMenuItem(mainPage);

        this._tokensSection = new TokensSection(this._pages);
        this._pages.detailsFiller = this._tokensSection.filler;
        detailsPage.addMenuItem(this._chart.item);
        detailsPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        detailsPage.addMenuItem(this._tokensSection.item);
        detailsPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        detailsPage.addMenuItem(this._pages.backNav);
        this.menu.addMenuItem(detailsPage);
    }

    // ----------------------------------------------------------------- rendering

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
        this._panel?.queueRepaint();
        this._plan?.queueRepaint();
    }

    // ------------------------------------------------------------------- helpers

    /**
     * Language changed: the menu is built once, so its static labels are re-set
     * and the dynamic texts re-rendered. The panel (crabs, rings, icon) is untouched.
     */
    _relabel() {
        if (!this._titleLabel)
            return;
        this._titleLabel.text = t('panel.menu.title');
        this._plan.relabel();
        this._prefsButton.accessible_name = t('panel.menu.preferences');
        this._tokensSection.relabel();
        this._pages.relabel();
        this._chart.relabel();
        this._plan.render();
        this._tokensSection.render();
        this._renderHistory();
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
        this._panel.syncHighlight();
        if (isOpen) {
            this._plan.updateCountdowns();
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
            this._plan.updateCountdowns();
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
