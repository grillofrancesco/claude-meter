// Top-bar content of the indicator: crabs, "+N", highlight box (icon + rings), panel measurement.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import {SPRITE_H, MORE_WIDTH, panelWidths, splitSessions} from '../crabs.js';
import {createRing} from './rings.js';
import {CrabArea} from './crabArea.js';
import {PanelSpace} from './panelSpace.js';

export const PANEL_KEYS = ['panel-show-five-hour', 'panel-show-seven-day', 'crabs-enabled', 'crab-max',
    'crab-overflow', 'panel-empty'];

export class PanelBox {
    /**
     * @param {object} button the PanelMenu.Button (its children and signals are managed here;
     *   the caller disconnects `button` as owner in destroy)
     */
    constructor(button, extension, settings, getColorMode) {
        this._button = button;
        this._settings = settings;
        this._sessions = [];

        button.add_style_class_name('claude-meter-button');
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

        const path = extension?.path;
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
        this.fiveHourRing = createRing(getColorMode);
        this.sevenDayRing = createRing(getColorMode);
        this._highlightBox.add_child(this.fiveHourRing.area);
        this._highlightBox.add_child(this.sevenDayRing.area);
        this._panelBox.add_child(this._highlightBox);

        button.add_child(this._panelBox);

        // Pointer cursor on the whole top-bar area (crabs, "+N", rings, icon): children keep the
        // default INHERIT cursor type. The menu is a separate actor tree, so it is not affected.
        button.set_cursor_type(Clutter.CursorType.POINTER);

        // Mirror the button state on the highlight box (the stock button background is transparent).
        button.connectObject(
            'notify::hover', () => this.syncHighlight(),
            'key-focus-in', () => this.syncHighlight(),
            'key-focus-out', () => this.syncHighlight(),
            button);

        // Measures the button content box (notify::allocation / style-changed) and shifts the crabs.
        this._panelSpace = new PanelSpace(button, this._crabs.actor, settings, extension,
            () => this.updateLayout());
    }

    syncHighlight() {
        const box = this._highlightBox;
        if (!box)
            return;
        const button = this._button;
        const set = (name, on) => on ? box.add_style_pseudo_class(name) : box.remove_style_pseudo_class(name);
        set('hover', button.hover);
        set('focus', button.has_key_focus());
        set('active', Boolean(button.menu?.isOpen));
    }

    setSessions(sessions) {
        this._sessions = sessions;
        this.updateLayout();
    }

    queueRepaint() {
        this.fiveHourRing.area.queue_repaint();
        this.sevenDayRing.area.queue_repaint();
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
    updateLayout() {
        if (!this._panelBox)
            return;
        const cfg = this._readPanelSettings();

        this.fiveHourRing.area.visible = cfg.showFiveHour;
        this.sevenDayRing.area.visible = cfg.showSevenDay;

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

    destroy() {
        this._crabs.stop();
        this._panelSpace.destroy();
    }
}
