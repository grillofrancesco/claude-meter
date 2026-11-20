import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SessionStore} from './lib/sessionStore.js';
import {panelWidths, SPRITE_H} from './lib/crabs.js';

Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');

const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

// Replace the home directory prefix with '~' (only on a path boundary).
function tildify(path) {
    const home = GLib.get_home_dir();
    if (path === home)
        return '~';
    if (path.startsWith(`${home}/`))
        return `~${path.slice(home.length)}`;
    return path;
}

function formatDate(date) {
    if (!date || Number.isNaN(date.getTime()))
        return '—';
    const pad = n => String(n).padStart(2, '0');
    return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Group sessions (already sorted, most recent first) by project directory,
// keeping the order of first appearance = most recent session of each project.
function groupByProject(sessions) {
    const groups = new Map();
    for (const session of sessions) {
        if (!groups.has(session.projectDir))
            groups.set(session.projectDir, []);
        groups.get(session.projectDir).push(session);
    }
    return [...groups.values()];
}

// The "Conversazioni" page: list of conversations grouped by project, with
// move-to-trash support. Deletion is always "select, then Elimina (N)": the
// row / group checkboxes are invisible (opacity 0, space kept) until hovered
// or focused; checking one enters deletion mode. `store` is a SessionStore (or
// a compatible fake).
//
// Action bar: Adw.PreferencesPage has no bottom bar and Adw.PreferencesWindow
// only accepts PreferencesPage children (no ToolbarView around one page), so
// the deletion actions live in the header of the first group, next to reload.
class SessionsPage {
    constructor(window, store) {
        this._window = window;
        this._store = store;
        this._generation = 0;
        this._cancellable = null;
        this._closed = false;
        this._busy = false;
        this._syncing = false;
        this._selectionMode = false;
        this._selected = new Set();
        this._escController = null;
        this._projectGroups = [];
        this._groups = new Map(); // group -> {sessions, check, hover}
        this._rows = new Map(); // session -> {row, group, projectSessions, check, hover}
        this._statusWidget = null;

        this.page = new Adw.PreferencesPage({
            title: 'Conversazioni',
            icon_name: 'user-trash-symbolic',
        });

        // Always-visible first group: hosts the header buttons and the
        // loading / empty / error states.
        this._headGroup = new Adw.PreferencesGroup({
            title: 'Conversazioni',
            description: 'Le conversazioni eliminate vengono spostate nel cestino.',
        });
        this._headBox = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER});

        this._trashModeButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Elimina conversazioni',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._trashModeButton.connect('clicked', () => this._setSelectionMode(true));

        this._deleteSelectedButton = new Gtk.Button({
            label: 'Elimina (0)',
            sensitive: false,
            visible: false,
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        this._deleteSelectedButton.connect('clicked', () => this._onTrashSelected());

        this._cancelSelectButton = new Gtk.Button({
            label: 'Annulla',
            visible: false,
            valign: Gtk.Align.CENTER,
        });
        this._cancelSelectButton.connect('clicked', () => this._setSelectionMode(false));

        this._reloadButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Ricarica elenco',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._reloadButton.connect('clicked', () => this.reload());

        for (const w of [this._trashModeButton, this._deleteSelectedButton, this._cancelSelectButton, this._reloadButton])
            this._headBox.append(w);
        this._headGroup.set_header_suffix(this._headBox);
        this.page.add(this._headGroup);
    }

    // Cancel pending work; call when the window closes.
    close() {
        this._closed = true;
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._removeEscController();
    }

    _setStatus(widget) {
        if (this._statusWidget)
            this._headGroup.remove(this._statusWidget);
        this._statusWidget = widget;
        if (widget)
            this._headGroup.add(widget);
    }

    _clearProjects() {
        for (const group of this._projectGroups)
            this.page.remove(group);
        this._projectGroups = [];
        this._groups.clear();
        this._rows.clear();
        this._selected.clear();
        this._syncSelectionUi();
    }

    _showLoading() {
        const props = {width_request: 32, height_request: 32, halign: Gtk.Align.CENTER, margin_top: 24, margin_bottom: 24};
        this._setStatus(Adw.Spinner
            ? new Adw.Spinner(props)
            : new Gtk.Spinner({...props, spinning: true}));
    }

    _showEmpty() {
        this._setStatus(new Adw.StatusPage({
            icon_name: 'user-trash-symbolic',
            title: 'Nessuna conversazione',
        }));
    }

    _showError() {
        const status = new Adw.StatusPage({
            icon_name: 'dialog-error-symbolic',
            title: 'Impossibile leggere le conversazioni',
        });
        const retry = new Gtk.Button({
            label: 'Riprova',
            halign: Gtk.Align.CENTER,
            css_classes: ['pill', 'suggested-action'],
        });
        retry.connect('clicked', () => this.reload());
        status.set_child(retry);
        this._setStatus(status);
    }

    async reload() {
        if (this._closed)
            return;
        // A newer reload supersedes any older one.
        const generation = ++this._generation;
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._clearProjects();
        this._showLoading();

        let sessions;
        try {
            sessions = await this._store.list(cancellable);
        } catch (e) {
            if (generation !== this._generation)
                return;
            console.debug(`claude-meter: sessions list failed: ${e.message}`);
            this._showError();
            return;
        }
        if (generation !== this._generation)
            return;

        this._populate(sessions);
    }

    // ---- selection mode ----

    _setSelectionMode(on) {
        if (this._busy || this._closed)
            return;
        this._applySelectionMode(on);
    }

    _applySelectionMode(on) {
        if (this._selectionMode === on)
            return;
        this._selectionMode = on;
        this._selected.clear();
        for (const [session, entry] of this._rows) {
            this._updateCheckVisibility(entry);
            entry.row.activatable_widget = on && !session.active ? entry.check : null;
        }
        for (const info of this._groups.values()) {
            this._updateCheckVisibility(info);
        }
        if (on)
            this._addEscController();
        else
            this._removeEscController();
        this._syncSelectionUi();
    }

    // Esc leaves selection mode. The controller exists only while the mode is
    // on, and lets Esc through while an operation/dialog is in progress.
    _addEscController() {
        if (this._escController)
            return;
        const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        controller.connect('key-pressed', (_c, keyval) => {
            if (keyval !== Gdk.KEY_Escape || this._busy || !this._selectionMode)
                return false;
            this._applySelectionMode(false);
            return true;
        });
        this._window.add_controller(controller);
        this._escController = controller;
    }

    _removeEscController() {
        if (!this._escController)
            return;
        this._window.remove_controller(this._escController);
        this._escController = null;
    }

    // Reflect _selected and the mode on every selection widget.
    _syncSelectionUi() {
        this._syncing = true;
        try {
            for (const [session, entry] of this._rows)
                entry.check.active = this._selected.has(session);
            for (const info of this._groups.values()) {
                const eligible = info.sessions.filter(s => !s.active);
                const count = eligible.filter(s => this._selected.has(s)).length;
                const all = eligible.length > 0 && count === eligible.length;
                info.check.sensitive = eligible.length > 0;
                info.check.tooltip_text = eligible.length > 0
                    ? 'Seleziona tutte le conversazioni del progetto'
                    : 'Tutte le conversazioni sono in corso';
                info.check.inconsistent = count > 0 && !all;
                info.check.active = all;
            }
        } finally {
            this._syncing = false;
        }
        const n = this._selected.size;
        const on = this._selectionMode;
        this._trashModeButton.visible = !on;
        this._deleteSelectedButton.visible = on;
        this._cancelSelectButton.visible = on;
        this._deleteSelectedButton.label = `Elimina (${n})`;
        this._deleteSelectedButton.sensitive = n > 0;
    }

    // Disable the controls while an operation runs (the page stays scrollable).
    _setBusy(busy) {
        this._busy = busy;
        this._headBox.sensitive = !busy;
        for (const group of this._projectGroups)
            group.sensitive = !busy;
    }

    _populate(sessions) {
        this._clearProjects();
        if (sessions.length === 0) {
            this._showEmpty();
            return;
        }
        this._setStatus(null);

        for (const projectSessions of groupByProject(sessions)) {
            const projectPath = projectSessions.find(s => s.projectPath)?.projectPath ?? null;
            const group = new Adw.PreferencesGroup({
                // Group titles are Pango markup: escape the path.
                title: GLib.markup_escape_text(projectPath ? tildify(projectPath) : '—', -1),
                sensitive: !this._busy,
            });
            this._addGroupHeader(group, projectSessions);
            this.page.add(group);
            this._projectGroups.push(group);
            for (const session of projectSessions)
                this._addRow(group, session, projectSessions);
        }
        this._syncSelectionUi();
    }

    // Checkboxes stay in the layout (opacity 0) and show up on hover, keyboard
    // focus, or while the deletion mode is on.
    _updateCheckVisibility(entry) {
        const show = this._selectionMode || entry.hover || entry.check.has_focus;
        entry.check.opacity = show ? 1 : 0;
    }

    // Wire hover (on `hoverWidget`) and focus (on the checkbox) visibility.
    _trackVisibility(entry, hoverWidget) {
        entry.hover = false;
        const motion = new Gtk.EventControllerMotion();
        motion.connect('enter', () => {
            entry.hover = true;
            this._updateCheckVisibility(entry);
        });
        motion.connect('leave', () => {
            entry.hover = false;
            this._updateCheckVisibility(entry);
        });
        hoverWidget.add_controller(motion);
        entry.check.connect('notify::has-focus', () => this._updateCheckVisibility(entry));
        this._updateCheckVisibility(entry);
    }

    _addGroupHeader(group, projectSessions) {
        const check = new Gtk.CheckButton({
            tooltip_text: 'Seleziona tutte le conversazioni del progetto',
            valign: Gtk.Align.CENTER,
        });
        const info = {sessions: projectSessions, check, hover: false};
        check.connect('toggled', () => {
            if (this._syncing)
                return;
            const checked = check.active;
            if (checked && !this._selectionMode)
                this._applySelectionMode(true);
            for (const s of projectSessions.filter(s => !s.active)) {
                if (checked)
                    this._selected.add(s);
                else
                    this._selected.delete(s);
            }
            this._syncSelectionUi();
        });
        group.set_header_suffix(check);
        this._groups.set(group, info);
        // Hover over the whole header (the suffix's parent), not just the checkbox.
        this._trackVisibility(info, check.get_parent() ?? check);
    }

    _addRow(group, session, projectSessions) {
        // Titles are arbitrary user text: never parse them as markup. Disable
        // markup before setting the text (construct-property order is not guaranteed).
        const row = new Adw.ActionRow({subtitle_lines: 1});
        row.use_markup = false;
        row.title = session.title ?? 'Senza titolo';
        row.subtitle = `Ultima apertura ${formatDate(session.lastUsedAt)} · ` +
            `Creata ${formatDate(session.createdAt)}`;

        const check = new Gtk.CheckButton({
            valign: Gtk.Align.CENTER,
            sensitive: !session.active,
        });
        if (session.active)
            check.tooltip_text = 'Conversazione in corso: non può essere eliminata';
        check.connect('toggled', () => {
            if (this._syncing)
                return;
            const checked = check.active;
            if (checked && !this._selectionMode)
                this._applySelectionMode(true);
            if (checked)
                this._selected.add(session);
            else
                this._selected.delete(session);
            this._syncSelectionUi();
        });

        if (session.active) {
            row.add_suffix(new Gtk.Label({
                label: 'In corso',
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
            }));
        }
        row.add_suffix(check);
        if (this._selectionMode && !session.active)
            row.activatable_widget = check;
        group.add(row);
        const entry = {row, group, projectSessions, check, hover: false};
        this._rows.set(session, entry);
        this._trackVisibility(entry, row);
    }

    _toast(title) {
        if (!this._closed)
            this._window.add_toast(new Adw.Toast({title}));
    }

    // ---- operations ----

    async _onTrashSelected() {
        if (this._busy || this._selected.size === 0)
            return;
        const sessions = [...this._selected];
        this._setBusy(true);
        try {
            const targets = await this._prepare(() => this._store.getDeletionTargetsFor(sessions, this._cancellable));
            if (!targets)
                return;
            const n = sessions.length;
            const result = await this._confirmAndTrash({
                targets,
                heading: n === 1 ? 'Eliminare 1 conversazione?' : `Eliminare ${n} conversazioni?`,
                body: 'Verranno spostati nel cestino:',
                trash: () => this._store.trashMany(sessions, null),
                activeMessage: 'Una conversazione è in corso: non può essere eliminata',
            });
            if (!result)
                return;

            const skipped = result.skippedActive?.length ?? 0;
            const failed = result.failed.length;
            if (failed === 0 && skipped === 0) {
                this._applySelectionMode(false);
                for (const s of sessions)
                    this._removeRow(s);
                this._toast(n === 1 ? '1 conversazione spostata nel cestino'
                    : `${n} conversazioni spostate nel cestino`);
            } else if (failed > 0 && result.trashed.length === 0 && skipped === 0) {
                this._toast('Eliminazione non riuscita');
            } else {
                const deleted = n - skipped;
                let msg = skipped > 0
                    ? `${deleted} eliminate, ${skipped} in corso non eliminate`
                    : `${deleted} eliminate`;
                if (failed > 0)
                    msg += `; ${failed === 1 ? '1 elemento non eliminato' : `${failed} elementi non eliminati`}`;
                this._toast(msg);
                this._applySelectionMode(false);
                this.reload();
            }
        } finally {
            this._setBusy(false);
        }
    }

    // Compute the deletion targets; null (with a toast) on failure/close.
    async _prepare(compute) {
        let targets;
        try {
            targets = await compute();
        } catch (e) {
            if (this._closed)
                return null;
            console.debug(`claude-meter: deletion targets failed: ${e.message}`);
            this._toast("Impossibile preparare l'eliminazione");
            return null;
        }
        return this._closed ? null : targets;
    }

    // Confirm with the list of paths, run
    // `trash()` and map errors. Returns the store result, or null when
    // cancelled / failed / refused because something became active.
    async _confirmAndTrash({targets, heading, body, trash, activeMessage}) {
        // heading/body are plain text unless *_use_markup is set: no escaping.
        const dialog = new Adw.AlertDialog({heading, body});
        dialog.set_extra_child(this._buildTargetsList(targets));
        dialog.add_response('cancel', 'Annulla');
        dialog.add_response('delete', 'Elimina');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        const response = await dialog.choose(this._window, null);
        if (response !== 'delete' || this._closed)
            return null;

        try {
            // Not cancellable: a reload must not interrupt a half-done trash.
            return await trash();
        } catch (e) {
            if (this._closed)
                return null;
            if (e.code === 'active') {
                this._toast(activeMessage);
                this._applySelectionMode(false);
                this.reload();
            } else {
                console.debug(`claude-meter: trash failed: ${e.message}`);
                this._toast('Eliminazione non riuscita');
            }
            return null;
        }
    }

    _buildTargetsList(targets) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});

        const list = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        for (const target of targets) {
            list.append(new Gtk.Label({
                label: tildify(target.path),
                xalign: 0,
                wrap: true,
                wrap_mode: 2, // Pango.WrapMode.WORD_CHAR
                width_chars: 40,
                max_width_chars: 60,
                css_classes: ['monospace', 'caption', 'dim-label'],
            }));
        }
        box.append(new Gtk.ScrolledWindow({
            child: list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
            max_content_height: 200,
        }));

        const projects = targets.filter(t => t.kind === 'project-dir').length;
        if (projects > 0) {
            box.append(new Gtk.Label({
                label: projects === 1
                    ? "Verrà eliminata l'intera cartella del progetto in ~/.claude, compresa la " +
                        'memoria di Claude (memory/)'
                    : `Verranno eliminate le cartelle di ${projects} progetti in ~/.claude, comprese ` +
                        'le memorie di Claude (memory/)',
                xalign: 0,
                wrap: true,
                max_width_chars: 50,
                css_classes: ['warning'],
            }));
        }
        return box;
    }

    _removeRow(session) {
        const entry = this._rows.get(session);
        if (!entry)
            return;
        this._rows.delete(session);
        this._selected.delete(session);
        entry.group.remove(entry.row);
        const idx = entry.projectSessions.indexOf(session);
        if (idx >= 0)
            entry.projectSessions.splice(idx, 1);
        if (entry.projectSessions.length === 0) {
            this.page.remove(entry.group);
            this._groups.delete(entry.group);
            this._projectGroups.splice(this._projectGroups.indexOf(entry.group), 1);
        }
        if (this._rows.size === 0)
            this._showEmpty();
        this._syncSelectionUi();
    }
}

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

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Barra superiore',
            description: 'Se non è attivo nulla viene mostrata l\'icona.',
        });
        page.add(panelGroup);

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
        const crabSyncIds = ['crab-max', 'crabs-enabled', 'panel-show-five-hour', 'panel-show-seven-day']
            .map(key => settings.connect(`changed::${key}`, syncCrabMaxRow));

        const overflowModes = ['overflow', 'crop'];
        const overflowRow = new Adw.ComboRow({
            title: 'Animazioni troppo alte',
            model: Gtk.StringList.new(['Sbordare', 'Tagliare in alto']),
        });
        panelGroup.add(overflowRow);
        const syncOverflowRow = () => {
            const index = overflowModes.indexOf(settings.get_string('crab-overflow'));
            overflowRow.selected = index < 0 ? 0 : index;
        };
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
        syncOverflowRow();
        syncOverflowSubtitle();
        overflowRow.connect('notify::selected', () => {
            const mode = overflowModes[overflowRow.selected] ?? 'overflow';
            if (settings.get_string('crab-overflow') !== mode)
                settings.set_string('crab-overflow', mode);
        });
        const overflowChangedId = settings.connect('changed::crab-overflow', syncOverflowRow);
        const heightChangedId = settings.connect('changed::panel-content-height', syncOverflowSubtitle);

        const emptyModes = ['crab', 'icon'];
        const emptyRow = new Adw.ComboRow({
            title: 'Senza sessioni aperte',
            model: Gtk.StringList.new(['Clawd che dorme', 'Icona']),
        });
        panelGroup.add(emptyRow);
        const syncEmptyRow = () => {
            const index = emptyModes.indexOf(settings.get_string('panel-empty'));
            emptyRow.selected = index < 0 ? 0 : index;
        };
        syncEmptyRow();
        emptyRow.connect('notify::selected', () => {
            const mode = emptyModes[emptyRow.selected] ?? 'crab';
            if (settings.get_string('panel-empty') !== mode)
                settings.set_string('panel-empty', mode);
        });
        const emptyChangedId = settings.connect('changed::panel-empty', syncEmptyRow);
        window.connect('close-request', () => {
            crabSyncIds.forEach(id => settings.disconnect(id));
            settings.disconnect(overflowChangedId);
            settings.disconnect(heightChangedId);
            settings.disconnect(emptyChangedId);
            return false;
        });

        const lookGroup = new Adw.PreferencesGroup({title: 'Aspetto'});
        page.add(lookGroup);

        const modes = ['accent', 'traffic'];
        const colorRow = new Adw.ComboRow({
            title: 'Colore di barre e cerchi',
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

        const sessionsPage = new SessionsPage(window, new SessionStore());
        window.add(sessionsPage.page);
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
        const startPageId = settings.connect('changed::prefs-start-page', () => {
            if (!consumeStartPage())
                return;
            window.set_visible_page(sessionsPage.page);
            sessionsPage.reload();
        });
        window.connect('close-request', () => {
            settings.disconnect(startPageId);
            sessionsPage.close();
            return false;
        });

        // Do not start with the first spin button focused (and its text selected):
        // GTK assigns the initial focus when the window is shown; undo it once.
        const focusId = window.connect('notify::focus-widget', () => {
            if (!window.get_focus())
                return;
            window.disconnect(focusId);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                for (const row of [refreshRow, planRow, crabMaxRow])
                    row.set_position(-1); // clears the select-on-focus selection
                window.set_focus(null);
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}
