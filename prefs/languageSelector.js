import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {LANGUAGES, resolveLanguage, t} from '../lib/i18n.js';
import {bindComboRow} from './widgets.js';

// Each language is always written in its own language (never translated).
const LANGUAGE_NAMES = {it: 'Italiano', en: 'English'};

function languageModel() {
    return Gtk.StringList.new(LANGUAGES.map(l => LANGUAGE_NAMES[l]));
}

// Shows the effective language (resolved when the key is ''), writes 'it'|'en'.
function bindLanguage(settings, widget, tracker) {
    bindComboRow(settings, 'language', LANGUAGES, widget, {
        tracker,
        displayValue: () => resolveLanguage(settings.get_string('language')),
    });
}

// Compact drop-down for the window header bar.
export function createLanguageDropDown(settings, tracker) {
    const dropDown = new Gtk.DropDown({
        model: languageModel(),
        valign: Gtk.Align.CENTER,
        tooltip_text: t('prefs.language.tooltip'),
    });
    bindLanguage(settings, dropDown, tracker);
    return dropDown;
}

// Fallback when no header bar is found: a row at the top of "Aspetto".
export function createLanguageComboRow(settings, tracker) {
    const row = new Adw.ComboRow({
        title: t('prefs.language.rowTitle'),
        model: languageModel(),
    });
    bindLanguage(settings, row, tracker);
    return row;
}

// Walk the widget tree depth-first and collect the Adw.HeaderBar widgets.
export function findHeaderBars(root) {
    const found = [];
    const walk = widget => {
        if (widget instanceof Adw.HeaderBar)
            found.push(widget);
        for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
            walk(child);
    };
    walk(root);
    return found;
}

// The main header bar of a PreferencesWindow: the first mapped one in tree
// order (search / subpage bars are unmapped or come later), else the first.
export function findMainHeaderBar(window) {
    const bars = findHeaderBars(window);
    return bars.find(b => b.get_mapped()) ?? bars[0] ?? null;
}
