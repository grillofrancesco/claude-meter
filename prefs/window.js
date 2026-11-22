import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {SessionStore} from '../lib/sessionStore.js';
import {
    setLanguage, resolveLanguage, onLanguageChanged, disconnectLanguage,
} from '../lib/i18n.js';
import {SessionsPage} from './sessionsPage.js';
import {buildGeneralPage} from './generalPage.js';
import {SignalTracker, clearInitialSpinFocus} from './widgets.js';

// The tab icons (brush, chat bubble) ship with the extension: add its icons/
// directory to the icon theme once per prefs process.
const iconDirs = new Set();
function addIconsDir(dir) {
    const display = Gdk.Display.get_default();
    if (!dir || !display || iconDirs.has(dir))
        return;
    Gtk.IconTheme.get_for_display(display).add_search_path(dir);
    iconDirs.add(dir);
}

// Fills an Adw.PreferencesWindow: general page + conversations page, a language
// row in the general page, and a live rebuild of both pages when `language`
// changes. Kept apart from prefs.js (which needs the shell's ExtensionPreferences)
// so that it can be exercised from plain gjs.
// Returns {rebuild, generalPage, sessionsPage} (for tests).
export function fillWindow(window, settings, {store = null, iconsDir = null} = {}) {
    setLanguage(resolveLanguage(settings.get_string('language')));
    addIconsDir(iconsDir);
    // Few options: no search button.
    window.search_enabled = false;

    // Window lifetime: language listener, settings handlers.
    const windowTracker = new SignalTracker(window);
    // Pages lifetime: recreated on every rebuild.
    let pageTracker = null;
    let general = null;
    let sessionsPage = null;
    let closed = false;

    const build = () => {
        pageTracker = new SignalTracker();
        general = buildGeneralPage(settings, pageTracker);
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

    build();

    const languageId = onLanguageChanged(() => rebuild());
    windowTracker.connect(settings, 'changed::language', () =>
        setLanguage(resolveLanguage(settings.get_string('language'))));

    window.connect('close-request', () => {
        closed = true;
        disconnectLanguage(languageId);
        sessionsPage.close();
        return false;
    });

    clearInitialSpinFocus(window, general.spinRows);
    return {
        rebuild,
        get generalPage() { return general.page; },
        get sessionsPage() { return sessionsPage; },
    };
}
