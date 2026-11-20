import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {panelWidths, SPRITE_H} from '../lib/crabs.js';
import {t} from '../lib/i18n.js';
import {bindComboRow} from './widgets.js';
import {createLanguageComboRow} from './languageSelector.js';

// Builds the "Claude Meter" page. `tracker` is a SignalTracker (settings
// handlers are disconnected when the window closes). Returns the page and the
// spin rows (for the initial-focus fix).
export function buildGeneralPage(settings, tracker, {languageRow = false} = {}) {
    const page = new Adw.PreferencesPage({
        title: t('prefs.general.title'),
        icon_name: 'claude-meter-brush-symbolic',
    });

    // Groups are created in code order but added to the page at the end of this
    // function, in display order (see the page.add loop after thresholdGroup).
    const refreshGroup = new Adw.PreferencesGroup({title: t('prefs.refresh.title')});

    const refreshRow = new Adw.SpinRow({
        title: t('prefs.refresh.local.title'),
        subtitle: t('prefs.refresh.local.subtitle'),
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
    tracker.bind(settings, 'refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const planRow = new Adw.SpinRow({
        title: t('prefs.refresh.plan.title'),
        subtitle: t('prefs.refresh.plan.subtitle'),
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
    tracker.bind(settings, 'plan-refresh-interval', planRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const panelGroup = new Adw.PreferencesGroup({
        title: t('prefs.panel.title'),
        description: t('prefs.panel.description'),
    });

    const fiveHourRow = new Adw.SwitchRow({title: t('prefs.panel.fiveHour')});
    panelGroup.add(fiveHourRow);
    tracker.bind(settings, 'panel-show-five-hour', fiveHourRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const sevenDayRow = new Adw.SwitchRow({title: t('prefs.panel.sevenDay')});
    panelGroup.add(sevenDayRow);
    tracker.bind(settings, 'panel-show-seven-day', sevenDayRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const crabsRow = new Adw.SwitchRow({title: t('prefs.panel.crabs')});
    panelGroup.add(crabsRow);
    tracker.bind(settings, 'crabs-enabled', crabsRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const crabMaxRow = new Adw.SpinRow({
        title: t('prefs.panel.crabMax'),
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
    tracker.bind(settings, 'crab-max', crabMaxRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const syncCrabMaxRow = () => {
        const n = settings.get_uint('crab-max');
        const rings = Number(settings.get_boolean('panel-show-five-hour')) +
            Number(settings.get_boolean('panel-show-seven-day'));
        // Worst case: more sessions than crabs, so the "+N" label is shown too.
        const widths = panelWidths({crabs: n, more: 1, rings});
        crabMaxRow.subtitle = t('prefs.panel.crabMaxSubtitle', {crabs: widths.crabs, total: widths.total});
        crabMaxRow.sensitive = settings.get_boolean('crabs-enabled');
    };
    syncCrabMaxRow();
    for (const key of ['crab-max', 'crabs-enabled', 'panel-show-five-hour', 'panel-show-seven-day'])
        tracker.connect(settings, `changed::${key}`, syncCrabMaxRow);

    const overflowRow = new Adw.ComboRow({
        title: t('prefs.panel.overflow.title'),
        model: Gtk.StringList.new([t('prefs.panel.overflow.overflow'), t('prefs.panel.overflow.crop')]),
    });
    panelGroup.add(overflowRow);
    const syncOverflowSubtitle = () => {
        const h = settings.get_uint('panel-content-height');
        overflowRow.subtitle = h > 0
            ? t('prefs.panel.overflow.measured', {space: h, sprite: SPRITE_H})
            : t('prefs.panel.overflow.notMeasured');
        // Muted when the measured space is enough: the choice has no effect.
        const fits = h > 0 && h >= SPRITE_H;
        overflowRow.sensitive = !fits;
        overflowRow.tooltip_text = fits
            ? t('prefs.panel.overflow.fits', {sprite: SPRITE_H, space: h})
            : null;
    };
    bindComboRow(settings, 'crab-overflow', ['overflow', 'crop'], overflowRow, {tracker});
    syncOverflowSubtitle();
    tracker.connect(settings, 'changed::panel-content-height', syncOverflowSubtitle);

    const emptyRow = new Adw.ComboRow({
        title: t('prefs.panel.empty.title'),
        model: Gtk.StringList.new([t('prefs.panel.empty.crab'), t('prefs.panel.empty.icon')]),
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
            emptyRow.tooltip_text = enabled ? null : t('prefs.panel.empty.crabsOff');
        },
    });

    const lookGroup = new Adw.PreferencesGroup({title: t('prefs.look.title')});

    if (languageRow)
        lookGroup.add(createLanguageComboRow(settings, tracker));

    const colorRow = new Adw.ComboRow({
        title: t('prefs.look.color.title'),
        // Explicit line break: a narrower subtitle leaves room for the dropdown.
        subtitle: t('prefs.look.color.subtitle'),
        subtitle_lines: 2,
        model: Gtk.StringList.new([t('prefs.look.color.accent'), t('prefs.look.color.traffic')]),
    });
    lookGroup.add(colorRow);
    bindComboRow(settings, 'bar-color-mode', ['accent', 'traffic'], colorRow, {tracker});

    const thresholdGroup = new Adw.PreferencesGroup({
        title: t('prefs.thresholds.title'),
        description: t('prefs.thresholds.description'),
    });
    // Display order of the groups on the page.
    for (const group of [lookGroup, thresholdGroup, panelGroup, refreshGroup])
        page.add(group);

    const warnRow = new Adw.SpinRow({
        title: t('prefs.thresholds.warn'),
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
        title: t('prefs.thresholds.critical'),
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

    tracker.bind(settings, 'warn-threshold', warnRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    tracker.bind(settings, 'critical-threshold', criticalRow, 'value', Gio.SettingsBindFlags.DEFAULT);

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
