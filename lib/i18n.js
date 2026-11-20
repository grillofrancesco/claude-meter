// UI translations (Italian / English). Pure module: GLib only, usable from the
// shell, prefs and plain gjs tests. Each process (shell, prefs) has its own
// current language; extension.js and prefs.js set it from the `language` key.
//
// Dictionaries live in lib/locale/<area>.js as {it: {...}, en: {...}}; keys are
// '<area>.<section>.<name>' and must be unique across areas. A value is either a
// string with '{name}' placeholders or, for tn(), a plural object {one, other}
// (any Intl.PluralRules category may be given; 'other' is the fallback).

import GLib from 'gi://GLib';

import common from './locale/common.js';
import panel from './locale/panel.js';
import prefs from './locale/prefs.js';
import errors from './locale/errors.js';

export const LANGUAGES = ['it', 'en'];
export const FALLBACK_LANGUAGE = 'en';

// Area name -> dictionary; exported for the consistency tests.
export const AREAS = {common, panel, prefs, errors};

const tables = {it: {}, en: {}};
const listeners = new Map();
let nextListenerId = 1;
let current = FALLBACK_LANGUAGE;

/** Merge a dictionary {it: {...}, en: {...}} into the lookup tables. */
export function addTranslations(dict) {
    for (const lang of LANGUAGES)
        Object.assign(tables[lang], dict?.[lang] ?? {});
}

for (const dict of Object.values(AREAS))
    addTranslations(dict);

/**
 * Effective language for a `language` setting value.
 * '' (never chosen) or an unknown value: 'it' when the first desktop language
 * is Italian, otherwise 'en'.
 * @param {string} setting
 * @param {string[]} [systemNames] as returned by GLib.get_language_names()
 * @returns {'it'|'en'}
 */
export function resolveLanguage(setting, systemNames = GLib.get_language_names()) {
    if (LANGUAGES.includes(setting))
        return setting;
    const first = (systemNames ?? []).find(n => n && n !== 'C' && n !== 'POSIX');
    const base = first ? first.split(/[_.@-]/)[0].toLowerCase() : '';
    return base === 'it' ? 'it' : FALLBACK_LANGUAGE;
}

/** Current language ('it' | 'en'). */
export function getLanguage() {
    return current;
}

/** BCP 47 locale for Intl APIs. */
export function getLocale(lang = current) {
    return lang === 'it' ? 'it-IT' : 'en-GB';
}

/** Switch language; listeners are called only if it actually changed. */
export function setLanguage(lang) {
    if (!LANGUAGES.includes(lang) || lang === current)
        return;
    current = lang;
    for (const callback of [...listeners.values()]) {
        try {
            callback(lang);
        } catch (e) {
            console.error(`Claude Meter: language listener failed: ${e.message}`);
        }
    }
}

/** @returns {number} id for disconnectLanguage() */
export function onLanguageChanged(callback) {
    const id = nextListenerId++;
    listeners.set(id, callback);
    return id;
}

export function disconnectLanguage(id) {
    listeners.delete(id);
}

function lookup(key) {
    const value = tables[current][key] ?? tables[FALLBACK_LANGUAGE][key];
    if (value === undefined)
        console.debug(`Claude Meter: missing translation '${key}'`);
    return value;
}

function interpolate(text, params) {
    return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(params, name) ? String(params[name]) : match);
}

/**
 * Translated text for `key` with '{name}' placeholders filled from `params`.
 * Missing key: English, then the key itself. Never throws.
 */
export function t(key, params = {}) {
    const value = lookup(key);
    if (value === undefined)
        return key;
    const text = typeof value === 'string' ? value : value.other ?? key;
    return interpolate(text, params);
}

/**
 * Plural form of `key` for `count` (also available as '{count}').
 * The entry is {one, other, ...}; a plain string is used as is.
 */
export function tn(key, count, params = {}) {
    const value = lookup(key);
    if (value === undefined)
        return key;
    const all = {count, ...params};
    if (typeof value === 'string')
        return interpolate(value, all);
    const category = new Intl.PluralRules(getLocale()).select(count);
    return interpolate(value[category] ?? value.other ?? key, all);
}
