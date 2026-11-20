import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {panelWidths, SPRITE_H} from '../lib/crabs.js';
import {bindComboRow} from './widgets.js';

// Builds the "Claude Meter" page. `tracker` is a SignalTracker (settings
// handlers are disconnected when the window closes). Returns the page and the
// spin rows (for the initial-focus fix).
export function buildGeneralPage(settings, tracker) {
    const page = new Adw.PreferencesPage({
        title: 'Claude Meter',
        icon_name: 'preferences-system-symbolic',
    });

    // Groups are created in code order but added to the page at the end of this
    // function, in display order (see the page.add loop after thresholdGroup).
    const refreshGroup = new Adw.PreferencesGroup({title: 'Aggiornamento'});

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

    const panelGroup = new Adw.PreferencesGroup({
        title: 'Barra superiore',
        description: 'Se non è attivo nulla viene mostrata l\'icona.',
    });

    const fiveHourRow = new Adw.SwitchRow({title: 'Cerchio sessione (5 h)'});
    panelGroup.add(fiveHourRow);
    settings.bind('panel-show-five-hour', fiveHourRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const sevenDayRow = new Adw.SwitchRow({title: 'Cerchio settimanale'});
    panelGroup.add(sevenDayRow);
    settings.bind('panel-show-seven-day', sevenDayRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const crabsRow = new Adw.SwitchRow({title: 'Clawds'});
    panelGroup.add(crabsRow);
    settings.bind('crabs-enabled', crabsRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const crabMaxRow = new Adw.SpinRow({
        title: 'Sessioni mostrate',
        adjustment: new Gtk.Adjustment({
            lower: 1,
            upper: 10,
            step_increment: 1,
            page_increment: 5,
            value: settings.get_uint('crab-max'),
        }),
        digits: 0,
    });
    panelGroup.add(crabMaxRow);
    settings.bind('crab-max', crabMaxRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const syncCrabMaxRow = () => {
        const n = settings.get_uint('crab-max');
        const rings = Number(settings.get_boolean('panel-show-five-hour')) +
            Number(settings.get_boolean('panel-show-seven-day'));
        // Worst case: more sessions than crabs, so the "+N" label is shown too.
        const widths = panelWidths({crabs: n, more: 1, rings});
        crabMaxRow.subtitle = `Clawds: ${widths.crabs} px · Totale: ${widths.total} px`;
        crabMaxRow.sensitive = settings.get_boolean('crabs-enabled');
    };
    syncCrabMaxRow();
    for (const key of ['crab-max', 'crabs-enabled', 'panel-show-five-hour', 'panel-show-seven-day'])
        tracker.connect(settings, `changed::${key}`, syncCrabMaxRow);

    const overflowRow = new Adw.ComboRow({
        title: 'Animazioni troppo alte',
        model: Gtk.StringList.new(['Sbordare', 'Tagliare in alto']),
    });
    panelGroup.add(overflowRow);
    const syncOverflowSubtitle = () => {
        const h = settings.get_uint('panel-content-height');
        overflowRow.subtitle = h > 0
            ? `Spazio nel pannello: ${h} px, animazioni: ${SPRITE_H} px`
            : 'Spazio nel pannello non ancora misurato';
        // Muted when the measured space is enough: the choice has no effect.
        const fits = h > 0 && h >= SPRITE_H;
        overflowRow.sensitive = !fits;
        overflowRow.tooltip_text = fits
            ? `Le animazioni (${SPRITE_H} px) rientrano nell'altezza della barra superiore (${h} px)`
            : null;
    };
    bindComboRow(settings, 'crab-overflow', ['overflow', 'crop'], overflowRow, {tracker});
    syncOverflowSubtitle();
    tracker.connect(settings, 'changed::panel-content-height', syncOverflowSubtitle);

    const emptyRow = new Adw.ComboRow({
        title: 'Senza sessioni aperte',
        model: Gtk.StringList.new(['Clawd che dorme', 'Icona']),
    });
    panelGroup.add(emptyRow);
    // With Clawds off the panel always shows the icon: the row is muted and shows
    // "Icona", but the saved choice is kept and comes back when Clawds are re-enabled.
    bindComboRow(settings, 'panel-empty', ['crab', 'icon'], emptyRow, {
        tracker,
        extraKeys: ['crabs-enabled'],
        displayValue: () => settings.get_boolean('crabs-enabled')
            ? settings.get_string('panel-empty')
            : 'icon',
        writable: () => settings.get_boolean('crabs-enabled'),
        onSync: () => {
            const enabled = settings.get_boolean('crabs-enabled');
            emptyRow.sensitive = enabled;
            emptyRow.tooltip_text = enabled ? null : 'Con i Clawds disattivati la barra mostra sempre l\'icona';
        },
    });

    const lookGroup = new Adw.PreferencesGroup({title: 'Aspetto'});

    const colorRow = new Adw.ComboRow({
        title: 'Colore di barre e cerchi',
        // Explicit line break: a narrower subtitle leaves room for the dropdown.
        subtitle: "Accento di sistema, oppure\nverde/giallo/rosso secondo le soglie",
        subtitle_lines: 2,
        model: Gtk.StringList.new(["Colore d'accento", 'Semaforo (verde/giallo/rosso)']),
    });
    lookGroup.add(colorRow);
    bindComboRow(settings, 'bar-color-mode', ['accent', 'traffic'], colorRow, {tracker});

    const thresholdGroup = new Adw.PreferencesGroup({
        title: 'Soglie colori (solo con semaforo)',
        description: "Percentuale di utilizzo oltre la quale l'indicatore cambia colore.",
    });
    // Display order of the groups on the page.
    for (const group of [lookGroup, thresholdGroup, panelGroup, refreshGroup])
        page.add(group);

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
    tracker.connect(settings, 'changed::bar-color-mode', syncThresholds);

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

    return {page, spinRows: [refreshRow, planRow, crabMaxRow]};
}
