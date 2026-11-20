// Tests for lib/i18n.js and consistency of the lib/locale dictionaries.
// Run: gjs -m tests/test-i18n.js
import System from 'system';

import {
    LANGUAGES, AREAS, addTranslations, resolveLanguage, getLanguage, getLocale,
    setLanguage, onLanguageChanged, disconnectLanguage, t, tn,
} from '../lib/i18n.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
        print(`PASS ${name}`);
    } else {
        failed++;
        print(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
    }
}

function eq(name, actual, expected) {
    check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const forms = value => typeof value === 'string' ? {other: value} : value;

// ---------------------------------------------------------------- dictionaries
const owner = new Map();
for (const [area, dict] of Object.entries(AREAS)) {
    for (const lang of LANGUAGES)
        check(`${area}: has '${lang}'`, dict && typeof dict[lang] === 'object');
    const itKeys = Object.keys(dict.it ?? {}).sort();
    const enKeys = Object.keys(dict.en ?? {}).sort();
    const onlyIt = itKeys.filter(k => !enKeys.includes(k));
    const onlyEn = enKeys.filter(k => !itKeys.includes(k));
    check(`${area}: same keys in it/en`, onlyIt.length === 0 && onlyEn.length === 0,
        `only it: [${onlyIt}], only en: [${onlyEn}]`);

    for (const key of itKeys) {
        check(`${area}: '${key}' starts with '${area}.'`, key.startsWith(`${area}.`));
        if (owner.has(key))
            check(`'${key}' unique across areas`, false, `also in ${owner.get(key)}`);
        owner.set(key, area);
        if (!enKeys.includes(key))
            continue;
        const it = forms(dict.it[key]);
        const en = forms(dict.en[key]);
        check(`${area}: '${key}' non-empty`, Object.values(it).every(v => typeof v === 'string' && v !== '') &&
            Object.values(en).every(v => typeof v === 'string' && v !== ''));
        check(`${area}: '${key}' same kind (string/plural)`,
            typeof dict.it[key] === typeof dict.en[key]);
        if (typeof dict.it[key] === 'object') {
            check(`${area}: '${key}' plural has 'other'`, 'other' in it && 'other' in en);
        }
        const ph = new Set([...Object.values(it), ...Object.values(en)].map(placeholders));
        // Plural forms may omit {count} (e.g. 'one' = "un minuto"); others must match.
        const strip = s => s.split(',').filter(p => p && p !== 'count').join(',');
        check(`${area}: '${key}' same placeholders`, new Set([...ph].map(strip)).size <= 1, [...ph].join(' | '));
    }
}

// ---------------------------------------------------------------- resolveLanguage
eq('resolve explicit it', resolveLanguage('it', ['en_US.UTF-8', 'en', 'C']), 'it');
eq('resolve explicit en', resolveLanguage('en', ['it_IT.UTF-8', 'it', 'C']), 'en');
eq('resolve unset + italian desktop', resolveLanguage('', ['it_IT.UTF-8', 'it_IT', 'it', 'C']), 'it');
eq('resolve unset + english desktop', resolveLanguage('', ['en_US.UTF-8', 'en', 'C']), 'en');
eq('resolve unset + german desktop -> en', resolveLanguage('', ['de_DE.UTF-8', 'de', 'C']), 'en');
eq('resolve unset + only C -> en', resolveLanguage('', ['C']), 'en');
eq('resolve unknown value + italian', resolveLanguage('fr', ['it']), 'it');
eq('resolve unset + empty list', resolveLanguage('', []), 'en');
eq('resolve default system names', LANGUAGES.includes(resolveLanguage('')), true);

// ---------------------------------------------------------------- t / tn / listeners
addTranslations({
    it: {
        'test.hello': 'Ciao {name}',
        'test.onlyIt': 'solo italiano',
        'test.minutes': {one: 'un minuto', other: '{count} minuti'},
        'test.keep': 'valore {missing}',
    },
    en: {
        'test.hello': 'Hello {name}',
        'test.minutes': {one: '{count} minute', other: '{count} minutes'},
        'test.keep': 'value {missing}',
    },
});

setLanguage('it');
eq('getLanguage it', getLanguage(), 'it');
eq('getLocale it', getLocale(), 'it-IT');
eq('t interpolation it', t('test.hello', {name: 'Ada'}), 'Ciao Ada');
eq('t unknown placeholder kept', t('test.keep'), 'valore {missing}');
eq('t missing key -> key', t('test.nope'), 'test.nope');
eq('tn one it', tn('test.minutes', 1), 'un minuto');
eq('tn other it', tn('test.minutes', 5), '5 minuti');
eq('t on plural -> other', t('test.minutes', {count: 3}), '3 minuti');

let calls = [];
const id = onLanguageChanged(lang => calls.push(lang));
setLanguage('en');
eq('listener called once', calls.join(','), 'en');
setLanguage('en');
eq('same language: no call', calls.length, 1);
setLanguage('xx');
eq('invalid language ignored', getLanguage(), 'en');
eq('getLocale en', getLocale(), 'en-GB');
eq('t interpolation en', t('test.hello', {name: 'Ada'}), 'Hello Ada');
eq('t falls back... only to en, then key', t('test.onlyIt'), 'test.onlyIt');
eq('tn one en', tn('test.minutes', 1), '1 minute');
eq('tn other en', tn('test.minutes', 2), '2 minutes');
disconnectLanguage(id);
setLanguage('it');
eq('disconnected listener not called', calls.length, 1);
eq('it -> en fallback for key only in en? (none) / it-only key in it', t('test.onlyIt'), 'solo italiano');

const throwing = onLanguageChanged(() => {
    throw new Error('boom');
});
let after = false;
const second = onLanguageChanged(() => {
    after = true;
});
setLanguage('en');
check('throwing listener does not stop the others', after);
disconnectLanguage(throwing);
disconnectLanguage(second);

print(`\n${passed} passed, ${failed} failed`);
System.exit(failed > 0 ? 1 : 0);
