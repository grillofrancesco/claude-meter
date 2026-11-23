// Plan usage section of the menu (5h / 7d meter rows, error, data age) plus the top-bar rings
// it feeds. Owns the reset timer; the indicator owns the "menu open" tick that calls updateCountdowns().

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {formatPercent, formatCountdown, formatRelativeTime, formatClock, toDate} from '../format.js';
import {setRing} from './rings.js';
import {setBar} from './bars.js';
import {createSection, createMeterRow, createErrorLabel} from './menu.js';
import {t} from '../i18n.js';

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

// Shown when a window has no live value (never fetched, or past its reset):
// usage restarts from zero after a reset, so the meter and the ring show 0%.
const EMPTY_WINDOW = Object.freeze({percent: 0, resetsAt: null});

export function setStale(actor, stale) {
    if (!actor)
        return;
    // St CSS has no reliable `opacity` on containers: set it on the actor.
    actor.opacity = stale ? 128 : 255;
}

export class PlanSection {
    /**
     * @param {object} pages MenuPages (for equalize)
     * @param {{fiveHour: object, sevenDay: object}} rings top-bar rings fed by render()
     * @param {Function} getColorMode
     * @param {Function} getThresholds () => {warn, critical}
     */
    constructor(pages, rings, getColorMode, getThresholds) {
        this._pages = pages;
        this._rings = rings;
        this._getThresholds = getThresholds;
        this._usage = null;
        this._usageError = null;
        this._planRetryAt = null;
        this._resetTimerId = 0;

        const plan = createSection();
        this.item = plan.item;
        this._planBox = plan.box;

        this._fiveHourRow = createMeterRow(t('panel.plan.fiveHour'), getColorMode);
        this._planBox.add_child(this._fiveHourRow.root);

        this._sevenDayRow = createMeterRow(t('panel.plan.sevenDay'), getColorMode);
        this._planBox.add_child(this._sevenDayRow.root);

        this._planErrorLabel = createErrorLabel();
        this._planBox.add_child(this._planErrorLabel);

        // Age of the plan data (+ next attempt after a 429).
        this._planAgeLabel = new St.Label({
            text: '',
            style_class: 'claude-meter-dim claude-meter-plan-age',
            x_align: Clutter.ActorAlign.END,
        });
        this._planBox.add_child(this._planAgeLabel);
    }

    setUsage(usage, error) {
        // Keep the last valid value when the refresh failed.
        if (usage)
            this._usage = usage;
        this._usageError = error ? String(error) : null;
        this.render();
    }

    setRetryAt(date) {
        this._planRetryAt = toDate(date);
        this.updateAge();
    }

    render() {
        const usage = this._usage;
        const error = this._usageError;
        const stale = Boolean(error && usage);
        const {warn, critical} = this._getThresholds();

        const now = Date.now();
        const fiveHour = liveWindow(usage?.fiveHour, now) ?? EMPTY_WINDOW;
        const sevenDay = liveWindow(usage?.sevenDay, now) ?? EMPTY_WINDOW;

        this._updateMeterRow(this._fiveHourRow, fiveHour,
            Boolean(usage?.fiveHour && fiveHour === EMPTY_WINDOW));
        setStale(this._fiveHourRow.root, stale);

        this._updateMeterRow(this._sevenDayRow, sevenDay,
            Boolean(usage?.sevenDay && sevenDay === EMPTY_WINDOW));
        setStale(this._sevenDayRow.root, stale);

        setRing(this._rings.fiveHour, fiveHour, stale, warn, critical);
        setRing(this._rings.sevenDay, sevenDay, stale, warn, critical);
        this._scheduleResetRender(usage, now);

        this._planErrorLabel.text = error ?? '';
        this._planErrorLabel.visible = Boolean(error);
        this.updateAge();
        this._pages.equalize();
    }

    /** @param {boolean} expired the window has reset since the last fetch */
    _updateMeterRow(row, entry, expired = false) {
        const source = entry ?? {};
        const percent = typeof source.percent === 'number' ? source.percent : null;
        const {warn, critical} = this._getThresholds();

        row.percent = percent;
        row.resetsAt = toDate(source.resetsAt);
        row.expired = expired;
        row.value.text = formatPercent(percent);
        row.reset.text = this._resetText(row.resetsAt, expired);

        setBar(row.bar, percent, warn, critical);
    }

    _resetText(resetsAt, expired = false) {
        if (expired)
            return t('panel.plan.resetDone');
        if (!resetsAt)
            return t('panel.plan.resetUnknown');
        const countdown = formatCountdown(resetsAt);
        return countdown === '—' ? t('panel.plan.resetUnknown') : t('panel.plan.reset', {countdown});
    }

    updateAge() {
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

    updateCountdowns() {
        const rows = [this._fiveHourRow, this._sevenDayRow];
        for (const row of rows) {
            if (row)
                row.reset.text = this._resetText(row.resetsAt, row.expired);
        }
        this.updateAge();
    }

    queueRepaint() {
        this._fiveHourRow?.bar.area.queue_repaint();
        this._sevenDayRow?.bar.area.queue_repaint();
    }

    /** Language changed: re-set the static labels (the caller re-renders). */
    relabel() {
        this._fiveHourRow.label.text = t('panel.plan.fiveHour');
        this._sevenDayRow.label.text = t('panel.plan.sevenDay');
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
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopResetTimer() {
        if (!this._resetTimerId)
            return;
        GLib.source_remove(this._resetTimerId);
        this._resetTimerId = 0;
    }

    destroy() {
        this._stopResetTimer();
        this._usage = null;
    }
}
