import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SessionStore} from './lib/sessionStore.js';
import {SessionsPage} from './prefs/sessionsPage.js';
import {buildGeneralPage} from './prefs/generalPage.js';
import {SignalTracker, clearInitialSpinFocus} from './prefs/widgets.js';

export default class ClaudeMeterPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const tracker = new SignalTracker(window);

        const {page, spinRows} = buildGeneralPage(settings, tracker);
        window.add(page);

        const sessionsPage = new SessionsPage(window, new SessionStore());
        window.add(sessionsPage.page);
        sessionsPage.installOverlay();
        sessionsPage.reload();

        // Honour the requested start page, then reset the key. Resetting from
        // inside the handler is safe: the re-emitted change reads 'general'.
        const consumeStartPage = () => {
            if (settings.get_string('prefs-start-page') !== 'sessions')
                return false;
            settings.set_string('prefs-start-page', 'general');
            return true;
        };
        if (consumeStartPage())
            window.set_visible_page(sessionsPage.page);
        tracker.connect(settings, 'changed::prefs-start-page', () => {
            if (!consumeStartPage())
                return;
            window.set_visible_page(sessionsPage.page);
            sessionsPage.reload();
        });
        window.connect('close-request', () => {
            sessionsPage.close();
            return false;
        });

        clearInitialSpinFocus(window, spinRows);
    }
}
