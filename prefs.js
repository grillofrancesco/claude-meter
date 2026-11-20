import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {fillWindow} from './prefs/window.js';

export default class ClaudeMeterPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        fillWindow(window, this.getSettings(), {iconsDir: `${this.path}/icons`});
    }
}
