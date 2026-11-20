import GLib from 'gi://GLib';

import {SessionStore} from '../lib/sessionStore.js';
import {
    setLanguage, resolveLanguage, onLanguageChanged, disconnectLanguage,
} from '../lib/i18n.js';
import {SessionsPage} from './sessionsPage.js';
import {buildGeneralPage} from './generalPage.js';
import {SignalTracker, clearInitialSpinFocus} from './widgets.js';
import {createLanguageDropDown, findMainHeaderBar} from './languageSelector.js';

// Fills an Adw.PreferencesWindow: general page + conversations page, a language
// selector in the header bar, and a live rebuild of both pages when `language`
// changes. Kept apart from prefs.js (which needs the shell's ExtensionPreferences)
// so that it can be exercised from plain gjs.
// Returns {rebuild, headerBar, generalPage, sessionsPage} (for tests).
export function fillWindow(window, settings, {store = null} = {}) {
    setLanguage(resolveLanguage(settings.get_string('language')));

    // Window lifetime: language selector, language listener, settings handlers.
    const windowTracker = new SignalTracker(window);
    // Pages lifetime: recreated on every rebuild.
    let pageTracker = null;
    let general = null;
    let sessionsPage = null;
    let headerBar = null;
    let selector = null;
    let closed = false;

    const build = () => {
        pageTracker = new SignalTracker();
        // Without a header bar the selector is a row at the top of "Aspetto".
        general = buildGeneralPage(settings, pageTracker, {languageRow: !selector});
        window.add(general.page);

        sessionsPage = new SessionsPage(window, store ?? new SessionStore());
        window.add(sessionsPage.page);
        sessionsPage.installOverlay();
        sessionsPage.reload();
    };

    const teardown = () => {
        pageTracker.disconnectAll();
        sessionsPage.uninstallOverlay();
        sessionsPage.close();
        window.remove(general.page);
        window.remove(sessionsPage.page);
    };

    const rebuild = () => {
        if (closed)
            return;
        const wasSessions = window.get_visible_page() === sessionsPage.page;
        teardown();
        build();
        window.set_visible_page(wasSessions ? sessionsPage.page : general.page);
    };

    // Honour the requested start page, then reset the key. Resetting from
    // inside the handler is safe: the re-emitted change reads 'general'.
    const consumeStartPage = () => {
        if (settings.get_string('prefs-start-page') !== 'sessions')
            return false;
        settings.set_string('prefs-start-page', 'general');
        return true;
    };

    // Language selector: pack_end on the main header bar of the window.
    const attachSelector = () => {
        if (selector || closed)
            return !!selector;
        headerBar = findMainHeaderBar(window);
        if (!headerBar)
            return false;
        selector = createLanguageDropDown(settings, windowTracker);
        headerBar.pack_end(selector);
        return true;
    };

    attachSelector();
    build();
    if (consumeStartPage())
        window.set_visible_page(sessionsPage.page);

    // The header bar may only exist once the window is realized: retry when
    // mapped, then swap the fallback row for the header selector.
    if (!selector) {
        const mapId = window.connect('map', () => {
            window.disconnect(mapId);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!closed && attachSelector())
                    rebuild();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    const languageId = onLanguageChanged(() => rebuild());
    windowTracker.connect(settings, 'changed::language', () =>
        setLanguage(resolveLanguage(settings.get_string('language'))));
    windowTracker.connect(settings, 'changed::prefs-start-page', () => {
        if (!consumeStartPage())
            return;
        window.set_visible_page(sessionsPage.page);
        sessionsPage.reload();
    });

    window.connect('close-request', () => {
        closed = true;
        disconnectLanguage(languageId);
        sessionsPage.close();
        return false;
    });

    clearInitialSpinFocus(window, general.spinRows);
    return {
        rebuild,
        get headerBar() { return headerBar; },
        get generalPage() { return general.page; },
        get sessionsPage() { return sessionsPage; },
    };
}
