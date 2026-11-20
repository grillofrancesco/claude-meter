// Menu progress bars: St.DrawingArea creation, state update and painting.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {levelFor} from '../format.js';
import {roundedRect, setSource} from './drawing.js';

const BAR_HEIGHT = 6;

/**
 * Menu progress bar. Drawn (like the rings) instead of sizing a child
 * actor from the track allocation: the fill always matches the percentage,
 * whatever the allocation state of the menu when the value changed.
 * @param {() => string} getColorMode 'accent' | 'traffic', read at paint time
 */
export function createBar(getColorMode) {
    const area = new St.DrawingArea({
        style_class: 'claude-meter-bar',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    area.set_height(BAR_HEIGHT);
    const bar = {area, percent: null, level: 'unknown'};
    area.connect('repaint', a => paintBar(a, bar, getColorMode()));
    return bar;
}

/** @param {number|null} percent raw percentage of the window (null = unknown) */
export function setBar(bar, percent, warnThreshold, criticalThreshold) {
    bar.percent = percent === null || !Number.isFinite(percent)
        ? null
        : Math.max(0, Math.min(100, percent));
    bar.level = levelFor(bar.percent, warnThreshold, criticalThreshold);
    bar.area.queue_repaint();
}

function paintBar(area, bar, colorMode) {
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
        if (colorMode === 'traffic' && bar.level !== 'unknown')
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
