import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {SessionStore} from '../lib/sessionStore.js';
import {
    setLanguage, resolveLanguage, onLanguageChanged, disconnectLanguage,
} from '../lib/i18n.js';
import {SessionsPage} from './sessionsPage.js';
import {buildGeneralPage} from './generalPage.js';
import {SignalTracker, clearInitialSpinFocus} from './widgets.js';
import {findMainHeaderBar} from './languageSelector.js';

// Brand name shown as the window title: never translated.
const WINDOW_TITLE = 'Claude Meter';

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

// First descendant of `root` that is an instance of `type`, or null.
function findDescendant(root, type) {
    if (root instanceof type)
        return root;
    for (let child = root.get_first_child(); child; child = child.get_next_sibling()) {
        const found = findDescendant(child, type);
        if (found)
            return found;
    }
    return null;
}

// "Claude Meter" at the start of the header bar, next to the centred page tabs.
// On a narrow window libadwaita moves the tabs to a bottom bar and shows the
// window title in the header itself: the label is hidden then (no duplicate).
function addHeaderTitle(window, headerBar, tracker) {
    const label = new Gtk.Label({
        label: WINDOW_TITLE,
        css_classes: ['heading'],
        valign: Gtk.Align.CENTER,
        margin_start: 6,
    });
    headerBar.pack_start(label);
    const bottomBar = findDescendant(window, Adw.ViewSwitcherBar);
    if (bottomBar) {
        const sync = () => {
            label.visible = !bottomBar.reveal;
        };
        sync();
        tracker.connect(bottomBar, 'notify::reveal', sync);
    }
}

// Fills an Adw.PreferencesWindow: general page + conversations page, a language
// row in the general page, and a live rebuild of both pages when `language`
// changes. Kept apart from prefs.js (which needs the shell's ExtensionPreferences)
// so that it can be exercised from plain gjs.
// Returns {rebuild, headerBar, generalPage, sessionsPage} (for tests).
export function fillWindow(window, settings, {store = null, iconsDir = null} = {}) {
    setLanguage(resolveLanguage(settings.get_string('language')));
    addIconsDir(iconsDir);
    window.title = WINDOW_TITLE;
    // Few options: the search button would only push the title aside.
    window.search_enabled = false;

    // Window lifetime: language listener, settings handlers.
    const windowTracker = new SignalTracker(window);
    // Pages lifetime: recreated on every rebuild.
    let pageTracker = null;
    let general = null;
    let sessionsPage = null;
    let headerBar = null;
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

    // Honour the requested start page, then reset the key. Resetting from
    // inside the handler is safe: the re-emitted change reads 'general'.
    const consumeStartPage = () => {
        if (settings.get_string('prefs-start-page') !== 'sessions')
            return false;
        settings.set_string('prefs-start-page', 'general');
        return true;
    };

    // Title at the start of the main header bar of the window.
    const attachTitle = () => {
        if (headerBar || closed)
            return !!headerBar;
        headerBar = findMainHeaderBar(window);
        if (!headerBar)
            return false;
        addHeaderTitle(window, headerBar, windowTracker);
        return true;
    };

    attachTitle();
    build();
    if (consumeStartPage())
        window.set_visible_page(sessionsPage.page);

    // The header bar may only exist once the window is realized: retry when mapped.
    if (!headerBar) {
        const mapId = window.connect('map', () => {
            window.disconnect(mapId);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                attachTitle();
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
