// "Ultimi 7 giorni" chart section of the details page: widgets, data and painting.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {formatTokens, formatWeekdayShort} from '../format.js';
import {t} from '../i18n.js';
import {createSection, createHeaderLabel} from './menu.js';

const CHART_DAYS = 7;
const CHART_HEIGHT = 80;
const CHART_AXIS_WIDTH = 40;
const CHART_HEADROOM = 4;
const CHART_GAP = 6; // must match .claude-meter-chart spacing

/** Cartesian bar chart of the last 7 days (y: total tokens, x: weekday). */
export class WeekChart {
    constructor() {
        this._days = [];
        this._build();
    }

    /** Menu item holding the chart. */
    get item() {
        return this._item;
    }

    /** Spacer used to pad the details page to the height of the main page. */
    get filler() {
        return this._filler;
    }

    /** Re-set the static title after a language change (call setHistory() afterwards). */
    relabel() {
        this._header.text = t('panel.chart.title');
    }

    queueRepaint() {
        this._area?.queue_repaint();
    }

    /** @param {Array} history getHistory() result: newest first */
    setHistory(history) {
        // History is newest first; the chart wants the last 7 days oldest → newest.
        const days = history.slice(0, CHART_DAYS).reverse().map(entry => ({
            date: entry?.date ?? null,
            total: Number(entry?.total) || 0,
        }));
        this._days = days;

        const max = days.reduce((m, d) => Math.max(m, d.total), 0);
        this._maxLabel.text = days.length ? formatTokens(max) : '—';
        for (let i = 0; i < CHART_DAYS; i++)
            this._dayLabels[i].text = days[i] ? formatWeekdayShort(days[i].date) : '';

        const sum = days.reduce((acc, d) => acc + d.total, 0);
        this._totalLabel.text = days.length ? t('panel.chart.total', {amount: formatTokens(sum)}) : '';
        this._area.queue_repaint();
    }

    _build() {
        const {item, box} = createSection();
        const headerRow = new St.BoxLayout({x_expand: true, style_class: 'claude-meter-row'});
        const header = createHeaderLabel(t('panel.chart.title'));
        this._header = header;
        header.x_expand = true;
        this._totalLabel = new St.Label({
            text: '',
            x_align: Clutter.ActorAlign.END,
            style_class: 'claude-meter-header claude-meter-chart-total',
        });
        headerRow.add_child(header);
        headerRow.add_child(this._totalLabel);
        box.add_child(headerRow);
        // Page height padding goes here (not under "Preferenze"), so the gap
        // above "‹ Indietro" matches the one below the separator.
        this._filler = new St.Widget({height: 0});
        box.add_child(this._filler);

        const plotRow = new St.BoxLayout({x_expand: true, style_class: 'claude-meter-chart'});
        const yAxis = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'claude-meter-chart-yaxis',
        });
        yAxis.set_width(CHART_AXIS_WIDTH);
        this._maxLabel = new St.Label({
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
        yAxis.add_child(this._maxLabel);
        yAxis.add_child(zeroLabel);

        this._area = new St.DrawingArea({
            x_expand: true,
            style_class: 'claude-meter-chart-area',
        });
        this._area.set_height(CHART_HEIGHT);
        this._area.connect('repaint', area => this._paint(area));

        plotRow.add_child(yAxis);
        plotRow.add_child(this._area);
        box.add_child(plotRow);

        const xRow = new St.BoxLayout({x_expand: true, style_class: 'claude-meter-chart-xaxis'});
        const spacer = new St.Widget();
        spacer.set_width(CHART_AXIS_WIDTH + CHART_GAP);
        xRow.add_child(spacer);
        this._dayLabels = [];
        for (let i = 0; i < CHART_DAYS; i++) {
            const label = new St.Label({
                text: '',
                x_expand: true,
                style_class: 'claude-meter-dim claude-meter-chart-label claude-meter-chart-day',
            });
            label.clutter_text.x_align = Clutter.ActorAlign.CENTER;
            this._dayLabels.push(label);
            xRow.add_child(label);
        }
        box.add_child(xRow);

        this._item = item;
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            const node = area.get_theme_node();
            const fg = node.get_foreground_color();
            const [hasColor, barColor] = node.lookup_color('-claude-meter-chart-color', false);
            const bar = hasColor ? barColor : fg;
            const rgba = (c, a) => cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, a);

            const days = this._days ?? [];
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
}
