// Popup menu building blocks: navigation item, the two "pages", section / header /
// meter / value rows and the page height equalisation.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {createBar} from './bars.js';

export const NavItem = GObject.registerClass(
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

/**
 * Two "pages" in the same menu, padded to the same height so that
 * "Dettagli ›" (page 1) and "‹ Indietro" (page 2) sit at the same spot.
 * The caller fills `mainPage` / `detailsPage` with items and registers the
 * details filler (it lives inside the chart section) via `detailsFiller`.
 */
export class MenuPages {
    /** @param {object} menu the PopupMenu of the panel button */
    constructor(menu) {
        this._menu = menu;
        this.mainPage = new PopupMenu.PopupMenuSection();
        this.detailsPage = new PopupMenu.PopupMenuSection();
        // Height padding between the plan age and "Gestisci conversazioni".
        this.mainFiller = new St.Widget({height: 0});
        this.detailsFiller = null;
        this.detailsNav = new NavItem('Dettagli', false, () => this.show('details'));
        this.backNav = new NavItem('Indietro', true, () => this.show('main'));
        // Called when the details page is shown (the chart repaints).
        this.onDetailsShown = null;
    }

    /**
     * Pad the shorter page so both pages have the same height.
     * A never-shown page has no computed style (wrong font sizes), so both pages
     * are made visible for the measurement; it happens synchronously, before
     * the next frame, so nothing flickers. Only meaningful while the menu is open.
     */
    equalize() {
        if (!this.mainFiller || !this.detailsFiller || !this._menu.isOpen)
            return;
        const main = this.mainPage.actor;
        const details = this.detailsPage.actor;
        const [mainVisible, detailsVisible] = [main.visible, details.visible];
        main.visible = true;
        details.visible = true;
        this.mainFiller.height = 0;
        this.detailsFiller.height = 0;
        const [, mainHeight] = main.get_preferred_height(-1);
        const [, detailsHeight] = details.get_preferred_height(-1);
        main.visible = mainVisible;
        details.visible = detailsVisible;
        const diff = Math.round(detailsHeight - mainHeight);
        if (diff > 0)
            this.mainFiller.height = diff;
        else if (diff < 0)
            this.detailsFiller.height = -diff;
    }

    /** @param {'main'|'details'} page */
    show(page) {
        const details = page === 'details';
        this.equalize();
        this.mainPage.actor.visible = !details;
        this.detailsPage.actor.visible = details;
        if (details)
            this.onDetailsShown?.();
        if (this._menu.isOpen)
            (details ? this.backNav : this.detailsNav).grab_key_focus();
    }
}

/** Non-reactive menu item holding one vertical section. */
export function createSection() {
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

export function createHeaderLabel(text) {
    return new St.Label({
        text,
        style_class: 'claude-meter-header',
        x_align: Clutter.ActorAlign.START,
    });
}

/**
 * One meter: label + percent, progress bar, dim reset line.
 * @param {() => string} getColorMode forwarded to the bar painter
 */
export function createMeterRow(labelText, getColorMode) {
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

    const bar = createBar(getColorMode);

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
export function createValueRow(labelText) {
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
