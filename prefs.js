import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeMeterPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Claude Meter',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const refreshGroup = new Adw.PreferencesGroup({title: 'Aggiornamento'});
        page.add(refreshGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Tempo tra lettura dei file locali',
            subtitle: 'Secondi (30-3600)',
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 3600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_uint('refresh-interval'),
            }),
            digits: 0,
        });
        refreshGroup.add(refreshRow);
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const planRow = new Adw.SpinRow({
            title: 'Tempo tra lettura dei dati online',
            subtitle: 'Secondi (60-3600). Valori bassi possono causare blocchi temporanei.',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 30,
                page_increment: 300,
                value: settings.get_uint('plan-refresh-interval'),
            }),
            digits: 0,
        });
        refreshGroup.add(planRow);
        settings.bind('plan-refresh-interval', planRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const lookGroup = new Adw.PreferencesGroup({title: 'Aspetto'});
        page.add(lookGroup);

        const modes = ['accent', 'traffic'];
        const colorRow = new Adw.ComboRow({
            title: 'Colore delle barre',
            // Explicit line break: a narrower subtitle leaves room for the dropdown.
            subtitle: "Accento di sistema, oppure\nverde/giallo/rosso secondo le soglie",
            subtitle_lines: 2,
            model: Gtk.StringList.new(["Colore d'accento", 'Semaforo (verde/giallo/rosso)']),
        });
        lookGroup.add(colorRow);
        const syncColorRow = () => {
            const index = modes.indexOf(settings.get_string('bar-color-mode'));
            colorRow.selected = index < 0 ? 0 : index;
        };
        syncColorRow();
        colorRow.connect('notify::selected', () => {
            const mode = modes[colorRow.selected] ?? 'accent';
            if (settings.get_string('bar-color-mode') !== mode)
                settings.set_string('bar-color-mode', mode);
        });
        const colorChangedId = settings.connect('changed::bar-color-mode', syncColorRow);
        window.connect('close-request', () => {
            settings.disconnect(colorChangedId);
            return false;
        });

        const thresholdGroup = new Adw.PreferencesGroup({
            title: 'Soglie colori (solo con semaforo)',
            description: "Percentuale di utilizzo oltre la quale l'indicatore cambia colore.",
        });
        page.add(thresholdGroup);

        const warnRow = new Adw.SpinRow({
            title: 'Soglia di avviso (giallo)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('warn-threshold'),
            }),
            digits: 0,
        });
        const criticalRow = new Adw.SpinRow({
            title: 'Soglia critica (rosso)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('critical-threshold'),
            }),
            digits: 0,
        });
        thresholdGroup.add(warnRow);
        thresholdGroup.add(criticalRow);

        settings.bind('warn-threshold', warnRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('critical-threshold', criticalRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Le soglie servono solo in modalità semaforo.
        const syncThresholds = () => {
            thresholdGroup.sensitive = settings.get_string('bar-color-mode') === 'traffic';
        };
        syncThresholds();
        const thresholdChangedId = settings.connect('changed::bar-color-mode', syncThresholds);
        window.connect('close-request', () => {
            settings.disconnect(thresholdChangedId);
            return false;
        });

        // Avviso < critica, con aggiustamento gentile quando l'utente li incrocia.
        let adjusting = false;
        const keepOrder = () => {
            if (adjusting)
                return;

            const warn = warnRow.value;
            const critical = criticalRow.value;
            if (warn < critical)
                return;

            adjusting = true;
            criticalRow.value = Math.min(warn + 1, 100);
            adjusting = false;
        };
        warnRow.connect('notify::value', keepOrder);
        criticalRow.connect('notify::value', keepOrder);

        // Do not start with the first spin button focused (and its text selected):
        // GTK assigns the initial focus when the window is shown; undo it once.
        const focusId = window.connect('notify::focus-widget', () => {
            if (!window.get_focus())
                return;
            window.disconnect(focusId);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                for (const row of [refreshRow, planRow])
                    row.set_position(-1); // clears the select-on-focus selection
                window.set_focus(null);
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}
