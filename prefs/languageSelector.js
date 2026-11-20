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

// First row of "Aspetto" (the first entry of the general page).
export function createLanguageComboRow(settings, tracker) {
    const row = new Adw.ComboRow({
        title: t('prefs.language.rowTitle'),
        model: languageModel(),
    });
    bindLanguage(settings, row, tracker);
    return row;
}
