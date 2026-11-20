// Panel content-height measurement and the "animations too tall" notification.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {SPRITE_H} from '../crabs.js';

const MEASURE_DELAY_MS = 400; // debounce of the panel space measurement

export class PanelSpace {
    /**
     * @param {object} button the PanelMenu.Button (its allocation is measured)
     * @param {object} crabArea St.DrawingArea shifted with translation_y
     * @param {object|null} settings GSettings (writes `panel-content-height`)
     * @param {object|null} extension for "Apri preferenze"
     * @param {() => void} onChange called when the measured height changes
     */
    constructor(button, crabArea, settings, extension, onChange) {
        this._button = button;
        this._crabArea = crabArea;
        this._settings = settings;
        this._extension = extension;
        this._onChange = onChange;

        this._contentHeight = 0; // measured px available in the button (0 = unknown)
        this._measureTimerId = 0;
        this._notifySource = null;

        button.connectObject(
            'notify::allocation', () => this._queueMeasure(),
            'style-changed', () => this._queueMeasure(),
            this);
    }

    /** Measured px available in the button content box (0 = unknown). */
    get contentHeight() {
        return this._contentHeight;
    }

    destroy() {
        if (this._measureTimerId) {
            GLib.source_remove(this._measureTimerId);
            this._measureTimerId = 0;
        }
        this._button.disconnectObject(this);
        this._notifySource?.destroy();
        this._notifySource = null;
        this._settings = null;
    }

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
        if (!this._button.get_stage())
            return;
        let height = 0;
        try {
            const alloc = this._button.get_allocation_box();
            const box = this._button.get_theme_node().get_content_box(alloc);
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
            this._onChange();
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
}
