// Top-bar usage rings (5 h / 7 d): creation, state update and painting.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {levelFor} from '../format.js';
import {RING_SIZE} from '../crabs.js';

const RING_LINE = 2.5;

/**
 * @param {() => string} getColorMode 'accent' | 'traffic', read at paint time
 * @returns {{area: St.DrawingArea, percent: number|null, level: string}}
 */
export function createRing(getColorMode) {
    const area = new St.DrawingArea({
        style_class: 'claude-meter-ring',
        y_align: Clutter.ActorAlign.CENTER,
        visible: false,
    });
    area.set_size(RING_SIZE, RING_SIZE);
    const ring = {area, percent: null, level: 'unknown'};
    area.connect('repaint', a => paintRing(a, ring, getColorMode()));
    return ring;
}

/**
 * Update one ring from a plan window entry (already checked by liveWindow).
 * @param {object|null} entry {percent, resetsAt}
 */
export function setRing(ring, entry, stale, warnThreshold, criticalThreshold) {
    const percent = typeof entry?.percent === 'number' && Number.isFinite(entry.percent)
        ? Math.max(0, entry.percent)
        : null;
    ring.percent = percent;
    ring.level = levelFor(percent, warnThreshold, criticalThreshold);
    ring.area.opacity = stale ? 128 : 255;
    ring.area.queue_repaint();
}

function paintRing(area, ring, colorMode) {
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
        if (colorMode === 'traffic' && ring.level !== 'unknown')
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
