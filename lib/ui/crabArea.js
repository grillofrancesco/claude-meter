// Top-bar crab strip: the drawing area, the CrabRow state machine, the 8 fps timer
// (running only while something animates) and the sprite painting.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {CrabRow, PIXEL, SPRITE_H, FPS} from '../crabs.js';

export class CrabArea {
    constructor() {
        this._crabs = new CrabRow();
        this._timerId = 0;

        this.actor = new St.DrawingArea({
            style_class: 'claude-meter-crabs',
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        this.actor.set_height(SPRITE_H);
        this.actor.connect('repaint', area => this._paint(area));
    }

    /**
     * Apply the layout computed by the indicator.
     * @param {object} p
     * @param {number} p.count crabs drawn (placeholder included)
     * @param {number} p.width area width (used only when count > 0)
     * @param {number} p.height area height
     * @param {Array} p.shown sessions with a crab
     * @param {boolean} p.placeholder one sleeping placeholder crab
     */
    update({count, width, height, shown, placeholder}) {
        if (count > 0)
            this.actor.set_width(width);
        this.actor.set_height(height);
        // Bottom edge of the crabs = bottom of the content box (see PanelSpace).
        this._crabs.sync(shown, {placeholder});
        this.actor.visible = count > 0;
        this.actor.queue_repaint();
        this._updateTimer();
    }

    stop() {
        if (!this._timerId)
            return;
        GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _updateTimer() {
        const needed = this.actor.visible && this._crabs.animating;
        if (needed && !this._timerId) {
            this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / FPS), () => {
                if (this._crabs.step())
                    this.actor.queue_repaint();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needed) {
            this.stop();
        }
    }

    _paint(area) {
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
}
