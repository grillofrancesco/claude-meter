// Top-bar indicator + popup menu for Claude Meter.
// Shell-side module: only imported from extension.js inside GNOME Shell.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {
    formatTokens,
    formatPercent,
    formatCountdown,
    formatRelativeTime,
    formatWeekdayShort,
    levelFor,
    toDate,
} from './format.js';
import {CrabRow, PIXEL, SPRITE_H, FPS, RING_SIZE, MORE_WIDTH, panelWidths, splitSessions} from './crabs.js';

const BAR_HEIGHT = 6;
const CHART_DAYS = 7;
const CHART_HEIGHT = 80;
const CHART_AXIS_WIDTH = 40;
const CHART_HEADROOM = 4;
const CHART_GAP = 6; // must match .claude-meter-chart spacing
const COLOR_MODES = ['accent', 'traffic'];
const TICK_SECONDS = 30;
const DEFAULT_WARN = 70;
const DEFAULT_CRITICAL = 90;
const RING_LINE = 2.5;
const MEASURE_DELAY_MS = 400; // debounce of the panel space measurement
const PANEL_KEYS = ['panel-show-five-hour', 'panel-show-seven-day', 'crabs-enabled', 'crab-max',
    'crab-overflow', 'panel-empty'];

/** Rounded rectangle path (radius clamped to the shape). */
function roundedRect(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

function setSource(cr, color, alpha = 1) {
    cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255,
        alpha * color.alpha / 255);
}

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

const NavItem = GObject.registerClass(
class NavItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, back, callback) {
        super._init({style_class: 'claude-meter-nav'});
        this._callback = callback;

        if (back) {
            this.add_child(new St.Icon({
                icon_name: 'go-previous-symbolic',
                style_class: 'popup-menu-icon',
            }));
        }
        this.label = new St.Label({
            text,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: back ? 'claude-meter-nav-title' : '',
        });
        this.add_child(this.label);
        this.label_actor = this.label;
        if (!back) {
            this.add_child(new St.Icon({
                icon_name: 'go-next-symbolic',
                style_class: 'popup-menu-icon',
            }));
        }
    }

    activate(_event) {
        this._callback?.();
    }
});

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
        this._settingsIds = [];
        this._menuOpenId = 0;
        this._prefsActivateId = 0;
        this._sessionsActivateId = 0;

        this._sessions = [];
        this._crabs = new CrabRow();
        this._crabTimerId = 0;
        this._contentHeight = 0; // measured px available in the button (0 = unknown)
        this._measureTimerId = 0;
        this._allocationId = 0;
        this._hoverIds = [];
        this._notifySource = null;
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
        this._showPage('main');

        this._menuOpenId = this.menu.connect('open-state-changed',
            (_menu, isOpen) => this._onMenuOpenChanged(isOpen));

        this._applyColorMode();
        this._updatePanelLayout();

        if (this._settings) {
            for (const key of PANEL_KEYS) {
                this._settingsIds.push(this._settings.connect(`changed::${key}`,
                    () => this._updatePanelLayout()));
            }
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
        this._stopTick();
        this._stopResetTimer();
        this._stopCrabTimer();
        if (this._measureTimerId) {
            GLib.source_remove(this._measureTimerId);
            this._measureTimerId = 0;
        }
        if (this._allocationId) {
            this.disconnect(this._allocationId);
            this._allocationId = 0;
        }
        for (const [obj, id] of this._hoverIds)
            obj.disconnect(id);
        this._hoverIds = [];
        this._notifySource?.destroy();
        this._notifySource = null;

        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }
        if (this._sessionsActivateId) {
            this._sessionsItem.disconnect(this._sessionsActivateId);
            this._sessionsActivateId = 0;
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

        this._crabArea = new St.DrawingArea({
            style_class: 'claude-meter-crabs',
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        this._crabArea.set_height(SPRITE_H);
        this._crabArea.connect('repaint', area => this._paintCrabs(area));
        this._panelBox.add_child(this._crabArea);

        this._moreLabel = new St.Label({
            style_class: 'claude-meter-crab-more',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._moreLabel.set_width(MORE_WIDTH);
        this._panelBox.add_child(this._moreLabel);

        // Rings on the right: the box grows leftwards, so they stay put as crabs come and go.
        this._fiveHourRing = this._createRing();
        this._sevenDayRing = this._createRing();
        this._highlightBox.add_child(this._fiveHourRing.area);
        this._highlightBox.add_child(this._sevenDayRing.area);
        this._panelBox.add_child(this._highlightBox);

        this.add_child(this._panelBox);

        // Mirror the button state on the highlight box (the stock button background is transparent).
        for (const sig of ['notify::hover', 'key-focus-in', 'key-focus-out'])
            this._hoverIds.push([this, this.connect(sig, () => this._syncHighlight())]);
        this._allocationId = this.connect('notify::allocation', () => this._queueMeasure());
        this._hoverIds.push([this, this.connect('style-changed', () => this._queueMeasure())]);
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

    // ------------------------------------------------------- panel space measurement

    _queueMeasure() {
        if (this._measureTimerId)
            return;
        // First measurement right away (so the crabs sit in the content box from the start),
        // later ones debounced. Never inside the allocation pass itself.
        const delay = this._contentHeight > 0 ? MEASURE_DELAY_MS : 0;
        this._measureTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._measureTimerId = 0;
            this._measureContentHeight();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Content height of the button: allocation minus the theme node's border/padding. */
    _measureContentHeight() {
        if (!this._panelBox || !this.get_stage())
            return;
        let height = 0;
        try {
            const alloc = this.get_allocation_box();
            const box = this.get_theme_node().get_content_box(alloc);
            height = Math.round(box.y2 - box.y1);
            // The shell hands our child the whole button height: the crabs are shifted up by the
            // theme's bottom border/padding so they sit in the content box (the highlight box
            // has its own 3 px transparent border in CSS, like the stock button). Margins cannot
            // be negative, hence translation_y: in 'overflow' mode the full sprite then extends
            // above a shorter content box.
            const bottom = Math.round(alloc.y2 - box.y2);
            if (this._crabArea.translation_y !== -bottom)
                this._crabArea.translation_y = -bottom;
        } catch (e) {
            console.debug(`claude-meter: misura dello spazio fallita: ${e.message}`);
            return;
        }
        if (height > 0)
            this._applyContentHeight(height);
    }

    /** Store a measured height, repaint, persist it and warn once when it is too small. */
    _applyContentHeight(height) {
        const changed = height !== this._contentHeight;
        this._contentHeight = height;
        if (changed) {
            console.debug(`claude-meter: spazio nel pannello ${height} px, animazioni ${SPRITE_H} px`);
            this._updatePanelLayout();
        }
        let stored = height;
        try {
            stored = this._settings ? this._settings.get_uint('panel-content-height') : height;
            if (this._settings && stored !== height)
                this._settings.set_uint('panel-content-height', height);
        } catch (e) {
            console.debug(`claude-meter: altezza non salvata: ${e.message}`);
        }
        if (stored !== height && height < SPRITE_H)
            this._notifyTooTall(height);
    }

    _notifyTooTall(height) {
        try {
            if (!this._notifySource) {
                this._notifySource = new MessageTray.Source({
                    title: 'Claude Meter',
                    iconName: 'dialog-warning-symbolic',
                });
                this._notifySource.connect('destroy', () => {
                    this._notifySource = null;
                });
                Main.messageTray.add(this._notifySource);
            }
            const notification = new MessageTray.Notification({
                source: this._notifySource,
                title: 'Animazioni troppo alte per il pannello',
                body: `Le animazioni (${SPRITE_H} px) sono più alte dello spazio disponibile ` +
                    `(${height} px). In Preferenze → "Animazioni troppo alte" puoi scegliere ` +
                    'se farle sbordare o tagliarle in alto.',
            });
            notification.addAction('Apri preferenze', () => this._extension?.openPreferences());
            this._notifySource.addNotification(notification);
        } catch (e) {
            console.debug(`claude-meter: notifica fallita: ${e.message}`);
        }
    }

    _createRing() {
        const area = new St.DrawingArea({
            style_class: 'claude-meter-ring',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        area.set_size(RING_SIZE, RING_SIZE);
        const ring = {area, percent: null, level: 'unknown'};
        area.connect('repaint', a => this._paintRing(a, ring));
        return ring;
    }

    _paintRing(area, ring) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            const node = area.get_theme_node();
            const fg = node.get_foreground_color();
            const cx = width / 2;
            const cy = height / 2;
            const radius = Math.min(width, height) / 2 - RING_LINE / 2;
            const start = -Math.PI / 2;

            cr.setLineWidth(RING_LINE);
            cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.3);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();

            if (ring.percent === null || ring.percent <= 0)
                return;

            let colorName = '-claude-meter-ring-color';
            if (this._colorMode === 'traffic' && ring.level !== 'unknown')
                colorName = `-claude-meter-ring-${ring.level}`;
            const [found, color] = node.lookup_color(colorName, false);
            const c = found ? color : fg;
            cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, 1);
            cr.arc(cx, cy, radius, start, start + 2 * Math.PI * Math.min(100, ring.percent) / 100);
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }

    /**
     * Menu progress bar. Drawn (like the rings) instead of sizing a child
     * actor from the track allocation: the fill always matches the percentage,
     * whatever the allocation state of the menu when the value changed.
     */
    _createBar() {
        const area = new St.DrawingArea({
            style_class: 'claude-meter-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        area.set_height(BAR_HEIGHT);
        const bar = {area, percent: null, level: 'unknown'};
        area.connect('repaint', a => this._paintBar(a, bar));
        return bar;
    }

    _paintBar(area, bar) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            if (!(width > 0 && height > 0))
                return;
            const node = area.get_theme_node();
            const fg = node.get_foreground_color();
            const radius = height / 2;

            roundedRect(cr, 0, 0, width, height, radius);
            cr.clip();

            const [trackFound, track] = node.lookup_color('-claude-meter-bar-track', false);
            if (trackFound)
                setSource(cr, track);
            else
                setSource(cr, fg, 0.1);
            cr.paint();

            if (bar.percent === null || bar.percent <= 0)
                return;
            const fillWidth = Math.min(width, width * bar.percent / 100);

            let colorName = '-claude-meter-bar-color';
            if (this._colorMode === 'traffic' && bar.level !== 'unknown')
                colorName = `-claude-meter-bar-${bar.level}`;
            const [found, color] = node.lookup_color(colorName, false);
            setSource(cr, found ? color : fg);
            if (fillWidth >= height)
                roundedRect(cr, 0, 0, fillWidth, height, radius);
            else
                cr.rectangle(0, 0, fillWidth, height);
            cr.fill();
        } finally {
            cr.$dispose();
        }
    }

    _paintCrabs(area) {
        const cr = area.get_context();
        try {
            const [, height] = area.get_surface_size();
            // Bottom-aligned: when the area is shorter than the sprite the top rows are cut.
            const y0 = height - SPRITE_H;
            for (const frame of this._crabs.frames()) {
                for (const {rgba, pixels} of frame.sprite.layers) {
                    cr.setSourceRGBA(...rgba);
                    for (const [col, row] of pixels)
                        cr.rectangle(frame.x + col * PIXEL, y0 + row * PIXEL, PIXEL, PIXEL);
                    cr.fill();
                }
            }
        } finally {
            cr.$dispose();
        }
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
        const placeholder = empty && cfg.panelEmpty !== 'icon';
        const crabCount = placeholder ? 1 : shown.length;

        if (crabCount > 0)
            this._crabArea.set_width(panelWidths({crabs: crabCount}).crabs);
        const crop = cfg.overflow === 'crop' && this._contentHeight > 0 && this._contentHeight < SPRITE_H;
        this._crabArea.set_height(crop ? this._contentHeight : SPRITE_H);
        // Bottom edge of the crabs = bottom of the content box (see _measureContentHeight).
        this._crabs.sync(shown, {placeholder});
        this._crabArea.visible = crabCount > 0;
        this._moreLabel.visible = hidden > 0;
        if (hidden > 0)
            this._moreLabel.text = `+${hidden}`;
        this._icon.visible = empty && !placeholder;

        this._crabArea.queue_repaint();
        this._updateCrabTimer();
    }

    _updateCrabTimer() {
        const needed = this._crabArea.visible && this._crabs.animating;
        if (needed && !this._crabTimerId) {
            this._crabTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / FPS), () => {
                if (this._crabs.step())
                    this._crabArea.queue_repaint();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needed) {
            this._stopCrabTimer();
        }
    }

    _stopCrabTimer() {
        if (!this._crabTimerId)
            return;
        GLib.source_remove(this._crabTimerId);
        this._crabTimerId = 0;
    }

    /** @param {Array<object|null>} windows [fiveHour, sevenDay], already checked by liveWindow */
    _renderRings([fiveHour, sevenDay], stale) {
        const pairs = [[this._fiveHourRing, fiveHour], [this._sevenDayRing, sevenDay]];
        for (const [ring, entry] of pairs) {
            const percent = typeof entry?.percent === 'number' && Number.isFinite(entry.percent)
                ? Math.max(0, entry.percent)
                : null;
            ring.percent = percent;
            ring.level = levelFor(percent, this._warnThreshold, this._criticalThreshold);
            ring.area.opacity = stale ? 128 : 255;
            ring.area.queue_repaint();
        }
    }

    _buildMenu() {
        const menuTarget = this.menu.box ?? this.menu.actor;
        if (menuTarget && typeof menuTarget.add_style_class_name === 'function')
            menuTarget.add_style_class_name('claude-meter-menu');

        // Titolo + utilizzo del piano.
        const title = this._createSection();
        title.box.add_child(new St.Label({
            text: 'Utilizzo di Claude',
            style_class: 'claude-meter-title',
            x_align: Clutter.ActorAlign.START,
        }));

        const plan = this._createSection();
        this._planItem = plan.item;
        this._planBox = plan.box;

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

        // Età dei dati del piano (+ prossimo tentativo dopo un 429).
        this._planAgeLabel = new St.Label({
            text: '',
            style_class: 'claude-meter-dim claude-meter-plan-age',
            x_align: Clutter.ActorAlign.START,
        });
        this._planBox.add_child(this._planAgeLabel);

        // Two "pages" in the same menu, padded to the same height so that
        // "Dettagli ›" (page 1) and "‹ Indietro" (page 2) sit at the same spot.
        this._mainPage = new PopupMenu.PopupMenuSection();
        this._mainPage.addMenuItem(title.item);
        this._mainPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._mainPage.addMenuItem(this._planItem);
        this._sessionsItem = new PopupMenu.PopupMenuItem('Gestisci conversazioni');
        this._sessionsActivateId = this._sessionsItem.connect('activate', () => {
            try {
                this._settings?.set_string('prefs-start-page', 'sessions');
            } catch (e) {
                console.debug(`claude-meter: pagina iniziale preferenze non impostata: ${e.message}`);
            }
            this._openPreferences();
        });
        this._mainPage.addMenuItem(this._sessionsItem);
        this._mainFiller = new St.Widget({height: 0});
        this._mainPage.box.add_child(this._mainFiller);
        this._mainPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._detailsNav = new NavItem('Dettagli', false, () => this._showPage('details'));
        this._mainPage.addMenuItem(this._detailsNav);
        this.menu.addMenuItem(this._mainPage);

        this._detailsPage = new PopupMenu.PopupMenuSection();

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
        this._detailsPage.addMenuItem(this._tokensItem);
        this._detailsPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._detailsPage.addMenuItem(this._buildChart());

        this._prefsItem = new PopupMenu.PopupMenuItem('Preferenze');
        this._prefsActivateId = this._prefsItem.connect('activate', () => this._openPreferences());
        this._detailsPage.addMenuItem(this._prefsItem);
        this._detailsPage.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._backNav = new NavItem('Indietro', true, () => this._showPage('main'));
        this._detailsPage.addMenuItem(this._backNav);
        this.menu.addMenuItem(this._detailsPage);
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

    /**
     * Pad the shorter page so both pages have the same height.
     * A never-shown page has no computed style (wrong font sizes), so both pages
     * are made visible for the measurement; it happens synchronously, before
     * the next frame, so nothing flickers. Only meaningful while the menu is open.
     */
    _equalizePages() {
        if (!this._mainFiller || !this._detailsFiller || !this.menu.isOpen)
            return;
        const main = this._mainPage.actor;
        const details = this._detailsPage.actor;
        const [mainVisible, detailsVisible] = [main.visible, details.visible];
        main.visible = true;
        details.visible = true;
        this._mainFiller.height = 0;
        this._detailsFiller.height = 0;
        const [, mainHeight] = main.get_preferred_height(-1);
        const [, detailsHeight] = details.get_preferred_height(-1);
        main.visible = mainVisible;
        details.visible = detailsVisible;
        const diff = Math.round(detailsHeight - mainHeight);
        if (diff > 0)
            this._mainFiller.height = diff;
        else if (diff < 0)
            this._detailsFiller.height = -diff;
    }

    /** @param {'main'|'details'} page */
    _showPage(page) {
        const details = page === 'details';
        this._equalizePages();
        this._mainPage.actor.visible = !details;
        this._detailsPage.actor.visible = details;
        if (details)
            this._chartArea?.queue_repaint();
        if (this.menu.isOpen)
            (details ? this._backNav : this._detailsNav).grab_key_focus();
    }

    /** Cartesian bar chart of the last 7 days (y: total tokens, x: weekday). */
    _buildChart() {
        const {item, box} = this._createSection();
        const headerRow = new St.BoxLayout({x_expand: true, style_class: 'claude-meter-row'});
        const header = this._createHeaderLabel('Ultimi 7 giorni');
        header.x_expand = true;
        this._chartTotalLabel = new St.Label({
            text: '',
            x_align: Clutter.ActorAlign.END,
            style_class: 'claude-meter-header claude-meter-chart-total',
        });
        headerRow.add_child(header);
        headerRow.add_child(this._chartTotalLabel);
        box.add_child(headerRow);
        // Page height padding goes here (not under "Preferenze"), so the gap
        // above "‹ Indietro" matches the one below the separator.
        this._detailsFiller = new St.Widget({height: 0});
        box.add_child(this._detailsFiller);

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

        const bar = this._createBar();

        const reset = new St.Label({
            text: '',
            style_class: 'claude-meter-dim claude-meter-reset',
            x_align: Clutter.ActorAlign.START,
        });

        root.add_child(top);
        root.add_child(bar.area);
        root.add_child(reset);

        return {root, label, value, bar, reset, percent: null, resetsAt: null, expired: false};
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

        this._renderRings([fiveHour, sevenDay], stale);
        this._scheduleResetRender(usage, now);

        this._planErrorLabel.text = error ?? '';
        this._planErrorLabel.visible = Boolean(error);
        this._updatePlanAge();
        this._equalizePages();
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

        const bar = row.bar;
        bar.percent = percent === null || !Number.isFinite(percent)
            ? null
            : Math.max(0, Math.min(100, percent));
        bar.level = levelFor(bar.percent, this._warnThreshold, this._criticalThreshold);
        bar.area.queue_repaint();
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
        this._equalizePages();
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
        this._chartTotalLabel.text = days.length ? `${formatTokens(sum)} token` : '';
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
        this._colorMode = mode;
        this._fiveHourRing?.area.queue_repaint();
        this._sevenDayRing?.area.queue_repaint();
        this._fiveHourRow?.bar.area.queue_repaint();
        this._sevenDayRow?.bar.area.queue_repaint();
    }

    // ------------------------------------------------------------------- helpers

    _resetText(resetsAt, expired = false) {
        if (expired)
            return 'Reset avvenuto, in aggiornamento';
        if (!resetsAt)
            return 'Reset non disponibile';
        const countdown = formatCountdown(resetsAt);
        return countdown === '—' ? 'Reset non disponibile' : `Reset ${countdown}`;
    }

    _updatePlanAge() {
        if (!this._planAgeLabel)
            return;
        const parts = [];
        const fetchedAt = toDate(this._usage?.fetchedAt);
        if (fetchedAt) {
            const age = formatRelativeTime(fetchedAt);
            parts.push(`aggiornato ${/^\d{1,2}:\d{2}$/.test(age) ? `alle ${age}` : age}`);
        }
        if (this._planRetryAt && this._planRetryAt.getTime() > Date.now())
            parts.push(`nuovo tentativo alle ${clockTime(this._planRetryAt)}`);
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
            this._equalizePages();
            this._startTick();
            this.emit('refresh-requested');
        } else {
            this._stopTick();
            this._showPage('main');
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
