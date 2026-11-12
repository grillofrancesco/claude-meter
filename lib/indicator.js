// Top-bar indicator + popup menu for Claude Meter.
// Shell-side module: only imported from extension.js inside GNOME Shell.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    formatTokens,
    formatPercent,
    formatCountdown,
    formatRelativeTime,
    formatWeekdayShort,
    levelFor,
    toDate,
} from './format.js';

const BAR_HEIGHT = 6;
const CHART_DAYS = 7;
const CHART_HEIGHT = 80;
const CHART_AXIS_WIDTH = 40;
const CHART_HEADROOM = 4;
const CHART_GAP = 6; // must match .claude-meter-chart spacing
const COLOR_MODES = ['accent', 'traffic'];
const TICK_SECONDS = 30;
const LEVEL_CLASSES = ['claude-meter-normal', 'claude-meter-warning', 'claude-meter-critical'];
const DEFAULT_WARN = 70;
const DEFAULT_CRITICAL = 90;

/** Recompute the fill width of a bar from its track allocation. */
function applyBarWidth(bar) {
    const trackWidth = bar.track.width;
    if (!(trackWidth > 0))
        return;

    const percent = bar.percent;
    const width = percent === null
        ? 0
        : Math.max(0, Math.min(trackWidth, Math.round(trackWidth * percent / 100)));

    if (width === bar.lastWidth)
        return;

    bar.lastWidth = width;
    if (width <= 0) {
        bar.fill.hide();
    } else {
        bar.fill.set_size(width, BAR_HEIGHT);
        bar.fill.show();
    }
}

/**
 * Track + fill progress bar. Width follows the track allocation.
 * @param {string} trackClass
 * @param {string} fillClass
 * @param {{expand?: boolean, width?: number}} [options]
 */
function createBar(trackClass, fillClass, options = {}) {
    const {expand = true, width = -1} = options;

    const track = new St.BoxLayout({
        style_class: trackClass,
        reactive: false,
        x_expand: expand,
        y_align: Clutter.ActorAlign.CENTER,
    });
    track.set_height(BAR_HEIGHT);
    if (width > 0)
        track.set_width(width);

    const fill = new St.Widget({
        style_class: fillClass,
        reactive: false,
        visible: false,
    });
    fill.set_size(0, BAR_HEIGHT);
    track.add_child(fill);

    const bar = {track, fill, percent: null, level: null, lastWidth: -1};
    track.connect('notify::width', () => applyBarWidth(bar));

    return bar;
}

/** Set a bar percentage (0..100, null = unknown) and optional level class. */
function setBarPercent(bar, percent, level = null) {
    const valid = typeof percent === 'number' && Number.isFinite(percent);
    bar.percent = valid ? Math.max(0, Math.min(100, percent)) : null;

    if (level !== null) {
        for (const className of LEVEL_CLASSES)
            bar.fill.remove_style_class_name(className);
        bar.fill.add_style_class_name(`claude-meter-${level}`);
        bar.level = level;
    }

    bar.lastWidth = -1;
    applyBarWidth(bar);
}

export const ClaudeMeterIndicator = GObject.registerClass({
    Signals: {
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
        this._lastUpdated = null;
        this._refreshing = false;

        this._tickId = 0;
        this._settingsIds = [];
        this._menuOpenId = 0;
        this._refreshClickedId = 0;
        this._prefsActivateId = 0;

        this._scopedRows = [];

        this._warnThreshold = DEFAULT_WARN;
        this._criticalThreshold = DEFAULT_CRITICAL;
        this._readThresholds();

        this._buildPanelIcon();
        this._buildMenu();
        this._renderPlan();
        this._renderTokens();
        this._renderHistory();
        this._updateFooterText();
        this.setRefreshing(false);

        this._menuOpenId = this.menu.connect('open-state-changed',
            (_menu, isOpen) => this._onMenuOpenChanged(isOpen));

        this._applyColorMode();

        if (this._settings) {
            this._settingsIds.push(this._settings.connect('changed::bar-color-mode',
                () => this._applyColorMode()));
            for (const key of ['warn-threshold', 'critical-threshold']) {
                const id = this._settings.connect(`changed::${key}`, () => {
                    this._readThresholds();
                    this._renderPlan();
                });
                this._settingsIds.push(id);
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

    setLastUpdated(date) {
        this._lastUpdated = toDate(date);
        this._updateFooterText();
    }

    setRefreshing(refreshing) {
        this._refreshing = Boolean(refreshing);
        if (!this._refreshButton)
            return;
        this._refreshButton.reactive = !this._refreshing;
        this._refreshButton.can_focus = !this._refreshing;
        this._refreshButton.opacity = this._refreshing ? 115 : 255;
    }

    destroy() {
        this._stopTick();

        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }
        if (this._refreshClickedId) {
            this._refreshButton.disconnect(this._refreshClickedId);
            this._refreshClickedId = 0;
        }
        if (this._moreOpenId) {
            this._moreItem.menu.disconnect(this._moreOpenId);
            this._moreOpenId = 0;
        }
        if (this._prefsActivateId) {
            this._prefsItem.disconnect(this._prefsActivateId);
            this._prefsActivateId = 0;
        }

        for (const id of this._settingsIds) {
            try {
                this._settings.disconnect(id);
            } catch (e) {
                console.debug(`claude-meter: disconnessione impostazioni fallita: ${e.message}`);
            }
        }
        this._settingsIds = [];
        this._settings = null;

        this._usage = null;
        this._tokens = null;
        this._history = [];
        this._scopedRows = [];

        super.destroy();
    }

    // ------------------------------------------------------------------ building

    _buildPanelIcon() {
        const path = this._extension?.path;
        const icon = path
            ? new St.Icon({
                gicon: Gio.icon_new_for_string(`${path}/icons/claude-meter-symbolic.svg`),
                style_class: 'system-status-icon',
            })
            : new St.Icon({
                icon_name: 'dialog-information-symbolic',
                style_class: 'system-status-icon',
            });

        this._icon = icon;
        this.add_child(icon);
    }

    _buildMenu() {
        const menuTarget = this.menu.box ?? this.menu.actor;
        if (menuTarget && typeof menuTarget.add_style_class_name === 'function')
            menuTarget.add_style_class_name('claude-meter-menu');

        // 1-5. Piano Claude Pro.
        const plan = this._createSection();
        this._planItem = plan.item;
        this._planBox = plan.box;

        this._planBox.add_child(this._createHeaderLabel('Piano Claude Pro'));

        this._fiveHourRow = this._createMeterRow('Sessione (5 h)');
        this._planBox.add_child(this._fiveHourRow.root);

        this._sevenDayRow = this._createMeterRow('Settimanale');
        this._planBox.add_child(this._sevenDayRow.root);

        this._planErrorLabel = new St.Label({
            text: '',
            style_class: 'claude-meter-error',
            visible: false,
        });
        this._planBox.add_child(this._planErrorLabel);

        this.menu.addMenuItem(this._planItem);

        // Ultimo aggiornamento + refresh: sempre visibili sotto i consumi.
        this.menu.addMenuItem(this._buildFooter());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // "Mostra di più": token, grafico 7 giorni, preferenze.
        this._moreItem = new PopupMenu.PopupSubMenuMenuItem('Mostra di più');
        this._moreItem.add_style_class_name('claude-meter-more');
        this._moreOpenId = this._moreItem.menu.connect('open-state-changed', (_m, open) => {
            this._moreItem.label.text = open ? 'Mostra di meno' : 'Mostra di più';
            if (open)
                this._chartArea?.queue_repaint();
        });
        this.menu.addMenuItem(this._moreItem);
        const more = this._moreItem.menu;

        const tokens = this._createSection();
        this._tokensItem = tokens.item;
        this._tokensBox = tokens.box;

        this._tokensBox.add_child(this._createHeaderLabel('Token Claude Code · oggi'));

        this._inputRow = this._createValueRow('Input');
        this._tokensBox.add_child(this._inputRow.row);

        this._outputRow = this._createValueRow('Output');
        this._tokensBox.add_child(this._outputRow.row);

        this._tokensErrorLabel = new St.Label({
            text: '',
            style_class: 'claude-meter-error',
            visible: false,
        });
        this._tokensBox.add_child(this._tokensErrorLabel);
        more.addMenuItem(this._tokensItem);

        more.addMenuItem(this._buildChart());

        this._prefsItem = new PopupMenu.PopupMenuItem('Preferenze');
        this._prefsActivateId = this._prefsItem.connect('activate', () => {
            if (this._extension && typeof this._extension.openPreferences === 'function')
                this._extension.openPreferences();
        });
        more.addMenuItem(this._prefsItem);
    }

    /** Cartesian bar chart of the last 7 days (y: total tokens, x: weekday). */
    _buildChart() {
        const {item, box} = this._createSection();
        box.add_child(this._createHeaderLabel('Ultimi 7 giorni'));

        const plotRow = new St.BoxLayout({x_expand: true, style_class: 'claude-meter-chart'});
        const yAxis = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'claude-meter-chart-yaxis',
        });
        yAxis.set_width(CHART_AXIS_WIDTH);
        this._chartMaxLabel = new St.Label({
            text: '—',
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
            x_align: Clutter.ActorAlign.END,
            style_class: 'claude-meter-dim claude-meter-chart-label',
        });
        const zeroLabel = new St.Label({
            text: '0',
            y_align: Clutter.ActorAlign.END,
            x_align: Clutter.ActorAlign.END,
            style_class: 'claude-meter-dim claude-meter-chart-label',
        });
        yAxis.add_child(this._chartMaxLabel);
        yAxis.add_child(zeroLabel);

        this._chartArea = new St.DrawingArea({
            x_expand: true,
            style_class: 'claude-meter-chart-area',
        });
        this._chartArea.set_height(CHART_HEIGHT);
        this._chartArea.connect('repaint', area => this._paintChart(area));

        plotRow.add_child(yAxis);
        plotRow.add_child(this._chartArea);
        box.add_child(plotRow);

        const xRow = new St.BoxLayout({x_expand: true, style_class: 'claude-meter-chart-xaxis'});
        const spacer = new St.Widget();
        spacer.set_width(CHART_AXIS_WIDTH + CHART_GAP);
        xRow.add_child(spacer);
        this._chartDayLabels = [];
        for (let i = 0; i < CHART_DAYS; i++) {
            const label = new St.Label({
                text: '',
                x_expand: true,
                style_class: 'claude-meter-dim claude-meter-chart-label claude-meter-chart-day',
            });
            label.clutter_text.x_align = Clutter.ActorAlign.CENTER;
            this._chartDayLabels.push(label);
            xRow.add_child(label);
        }
        box.add_child(xRow);

        this._chartTotalLabel = new St.Label({
            text: '',
            x_align: Clutter.ActorAlign.END,
            style_class: 'claude-meter-dim claude-meter-chart-total',
        });
        box.add_child(this._chartTotalLabel);

        return item;
    }

    _paintChart(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            const node = area.get_theme_node();
            const fg = node.get_foreground_color();
            const [hasColor, barColor] = node.lookup_color('-claude-meter-chart-color', false);
            const bar = hasColor ? barColor : fg;
            const rgba = (c, a) => cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, a);

            const days = this._chartDays ?? [];
            const max = days.reduce((m, d) => Math.max(m, d.total), 0);
            const baseline = height - 0.5;
            const usable = height - 1 - CHART_HEADROOM;

            cr.setLineWidth(1);
            rgba(fg, 0.3);
            cr.moveTo(0, baseline);
            cr.lineTo(width, baseline);
            cr.stroke();

            rgba(fg, 0.15);
            cr.setDash([2, 3], 0);
            cr.moveTo(0, CHART_HEADROOM + 0.5);
            cr.lineTo(width, CHART_HEADROOM + 0.5);
            cr.stroke();
            cr.setDash([], 0);

            const slot = width / CHART_DAYS;
            const barWidth = Math.max(4, Math.min(18, Math.floor(slot * 0.55)));
            days.forEach((day, i) => {
                if (!(day.total > 0) || max <= 0)
                    return;
                const barHeight = Math.max(2, Math.round(day.total / max * usable));
                const x = Math.round(slot * i + (slot - barWidth) / 2);
                rgba(bar, i === days.length - 1 ? 1 : 0.6);
                cr.rectangle(x, height - 1 - barHeight, barWidth, barHeight);
                cr.fill();
            });
        } finally {
            cr.$dispose();
        }
    }

    /** Non-reactive menu item holding one vertical section. */
    _createSection() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        item.can_focus = false;
        item.add_style_class_name('claude-meter-item');

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'claude-meter-section',
        });
        item.add_child(box);

        return {item, box};
    }

    _createHeaderLabel(text) {
        return new St.Label({
            text,
            style_class: 'claude-meter-header',
            x_align: Clutter.ActorAlign.START,
        });
    }

    /** One meter: label + percent, progress bar, dim reset line. */
    _createMeterRow(labelText) {
        const root = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'claude-meter-meter',
        });

        const top = new St.BoxLayout({
            x_expand: true,
            style_class: 'claude-meter-row',
        });

        const label = new St.Label({
            text: labelText,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-meter-label',
        });

        const value = new St.Label({
            text: '—',
            x_expand: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-meter-value',
        });

        top.add_child(label);
        top.add_child(value);

        const bar = createBar('claude-meter-bar', 'claude-meter-fill');

        const reset = new St.Label({
            text: '',
            style_class: 'claude-meter-dim claude-meter-reset',
            x_align: Clutter.ActorAlign.START,
        });

        root.add_child(top);
        root.add_child(bar.track);
        root.add_child(reset);

        return {root, label, value, bar, reset, percent: null, resetsAt: null};
    }

    /** Simple label + right aligned value row (no bar). */
    _createValueRow(labelText) {
        const row = new St.BoxLayout({
            x_expand: true,
            style_class: 'claude-meter-row',
        });

        const label = new St.Label({
            text: labelText,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-meter-label',
        });

        const value = new St.Label({
            text: '—',
            x_expand: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-meter-value',
        });

        row.add_child(label);
        row.add_child(value);

        return {row, label, value};
    }

    _buildFooter() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        item.can_focus = false;
        item.add_style_class_name('claude-meter-item');

        const box = new St.BoxLayout({
            x_expand: true,
            style_class: 'claude-meter-footer',
        });

        this._updatedLabel = new St.Label({
            text: '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-meter-dim',
        });

        this._refreshButton = new St.Button({
            style_class: 'claude-meter-refresh-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: 'Aggiorna',
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                style_class: 'claude-meter-refresh-icon',
            }),
        });

        this._refreshClickedId = this._refreshButton.connect('clicked', () => {
            this.emit('refresh-requested');
        });

        box.add_child(this._updatedLabel);
        box.add_child(this._refreshButton);
        item.add_child(box);

        return item;
    }

    // ----------------------------------------------------------------- rendering

    _renderPlan() {
        const usage = this._usage;
        const error = this._usageError;
        const stale = Boolean(error && usage);

        this._updateMeterRow(this._fiveHourRow, usage ? usage.fiveHour : null);
        this._setStale(this._fiveHourRow.root, stale);

        this._updateMeterRow(this._sevenDayRow, usage ? usage.sevenDay : null);
        this._setStale(this._sevenDayRow.root, stale);

        const scoped = usage && Array.isArray(usage.scoped) ? usage.scoped : [];

        while (this._scopedRows.length > scoped.length) {
            const row = this._scopedRows.pop();
            row.root.destroy();
        }

        for (let i = 0; i < scoped.length; i++) {
            const entry = scoped[i] ?? {};
            let row = this._scopedRows[i];

            if (!row) {
                row = this._createMeterRow('');
                this._planBox.insert_child_below(row.root, this._planErrorLabel);
                this._scopedRows.push(row);
            }

            row.label.text = entry.label ? `Settimanale · ${entry.label}` : 'Settimanale';
            this._updateMeterRow(row, entry);
            this._setStale(row.root, stale);
        }

        this._planErrorLabel.text = error ?? '';
        this._planErrorLabel.visible = Boolean(error);
    }

    _updateMeterRow(row, entry) {
        const source = entry ?? {};
        const percent = typeof source.percent === 'number' ? source.percent : null;

        row.percent = percent;
        row.resetsAt = toDate(source.resetsAt);
        row.value.text = formatPercent(percent);
        row.reset.text = this._resetText(row.resetsAt);

        const level = levelFor(percent, this._warnThreshold, this._criticalThreshold);
        setBarPercent(row.bar, percent, level === 'unknown' ? null : level);
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
    }

    _renderHistory() {
        // History is newest first; the chart wants the last 7 days oldest → newest.
        const days = this._history.slice(0, CHART_DAYS).reverse().map(entry => ({
            date: entry?.date ?? null,
            total: Number(entry?.total) || 0,
        }));
        this._chartDays = days;

        const max = days.reduce((m, d) => Math.max(m, d.total), 0);
        this._chartMaxLabel.text = days.length ? formatTokens(max) : '—';
        for (let i = 0; i < CHART_DAYS; i++)
            this._chartDayLabels[i].text = days[i] ? formatWeekdayShort(days[i].date) : '';

        const sum = days.reduce((acc, d) => acc + d.total, 0);
        this._chartTotalLabel.text = days.length ? `Totale 7 giorni: ${formatTokens(sum)}` : '';
        this._chartArea.queue_repaint();
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
    }

    // ------------------------------------------------------------------- helpers

    _resetText(resetsAt) {
        if (!resetsAt)
            return 'Reset non disponibile';
        const countdown = formatCountdown(resetsAt);
        return countdown === '—' ? 'Reset non disponibile' : `Reset ${countdown}`;
    }

    _updateFooterText() {
        if (!this._updatedLabel)
            return;
        this._updatedLabel.text = `Aggiornato ${formatRelativeTime(this._lastUpdated)}`;
    }

    _setStale(actor, stale) {
        if (!actor)
            return;
        // St CSS has no reliable `opacity` on containers: set it on the actor.
        actor.opacity = stale ? 128 : 255;
    }

    _updateCountdowns() {
        const rows = [this._fiveHourRow, this._sevenDayRow, ...this._scopedRows];
        for (const row of rows) {
            if (row)
                row.reset.text = this._resetText(row.resetsAt);
        }
        this._updateFooterText();
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
        if (isOpen) {
            this._updateCountdowns();
            this._startTick();
            this.emit('refresh-requested');
        } else {
            this._stopTick();
            this._moreItem?.setSubmenuShown(false);
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
