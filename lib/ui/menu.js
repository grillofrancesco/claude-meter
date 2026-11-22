// Popup menu building blocks: navigation item, the two "pages", section / header /
// meter / value rows and the page height equalisation.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {createBar} from './bars.js';
import {t} from '../i18n.js';

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
        // Height padding between the plan age and "Dettagli ›".
        this.mainFiller = new St.Widget({height: 0});
        this.detailsFiller = null;
        this.detailsNav = new NavItem(t('panel.nav.details'), false, () => this.show('details'));
        this.backNav = new NavItem(t('panel.nav.back'), true, () => this.show('main'));
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
        // Wrapping labels need the real width to report their height: the pages fill the
        // menu content box, whose width is its natural width minus padding and borders
        // (a hidden page keeps a stale allocation, so its own width is not usable).
        const box = this._menu.box;
        const node = box.get_theme_node();
        const [, boxWidth] = box.get_preferred_width(-1);
        const width = boxWidth - node.get_horizontal_padding() -
            node.get_border_width(St.Side.LEFT) - node.get_border_width(St.Side.RIGHT);
        const forWidth = width > 0 ? width : -1;
        const [, mainHeight] = main.get_preferred_height(forWidth);
        const [, detailsHeight] = details.get_preferred_height(forWidth);
        main.visible = mainVisible;
        details.visible = detailsVisible;
        const diff = Math.round(detailsHeight - mainHeight);
        if (diff > 0)
            this.mainFiller.height = diff;
        else if (diff < 0)
            this.detailsFiller.height = -diff;
    }

    /** Re-set the navigation labels after a language change. */
    relabel() {
        this.detailsNav.label.text = t('panel.nav.details');
        this.backNav.label.text = t('panel.nav.back');
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

/**
 * Label that never asks for width: it takes the width the other rows give the
 * menu and wraps inside it (height follows the wrapped lines), so a long
 * error message does not widen the menu.
 */
const WrapLabel = GObject.registerClass(
class WrapLabel extends St.Label {
    _init(params) {
        super._init(params);
        this.clutter_text.line_wrap = true;
        this.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
});

/** Yellow error line of a section (hidden until an error is set). */
export function createErrorLabel() {
    return new WrapLabel({
        text: '',
        style_class: 'claude-meter-error',
        x_expand: true,
        visible: false,
    });
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

/**
 * Open the preferences window. If it is already open the shell refuses
 * ("Already showing a prefs dialog"): bring the existing window to the front.
 */
export function openPreferences(extension) {
    if (!extension || typeof extension.openPreferences !== 'function')
        return;
    const title = extension.metadata?.name;
    const window = global.get_window_actors()
        .map(actor => actor.meta_window)
        .find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions' &&
            w.get_title() === title);
    if (window)
        Main.activateWindow(window);
    else
        extension.openPreferences();
}
