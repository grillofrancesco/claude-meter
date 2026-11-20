import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
export class SessionsPage {
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

        this._buildBar();

        this._reloadButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Ricarica elenco',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._reloadButton.connect('clicked', () => this.reload());

        for (const w of [this._trashModeButton, this._reloadButton])
            this._headBox.append(w);
        this._headGroup.set_header_suffix(this._headBox);
        this.page.add(this._headGroup);
    }

    // Floating bar shown at the bottom of the window while the selection mode is on.
    _buildBar() {
        this._deleteSelectedButton = new Gtk.Button({
            sensitive: false,
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Elimina le conversazioni selezionate',
            css_classes: ['destructive-action'],
        });
        const content = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
        content.append(new Gtk.Image({icon_name: 'user-trash-symbolic'}));
        this._deleteCountLabel = new Gtk.Label({label: '0'});
        content.append(this._deleteCountLabel);
        this._deleteSelectedButton.set_child(content);
        this._deleteSelectedButton.connect('clicked', () => this._onTrashSelected());

        this._sizeLabel = new Gtk.Label({
            label: '—',
            valign: Gtk.Align.CENTER,
            width_chars: 8,
            css_classes: ['dim-label'],
        });

        this._cancelSelectButton = new Gtk.Button({label: 'Annulla', valign: Gtk.Align.CENTER});
        this._cancelSelectButton.connect('clicked', () => this._setSelectionMode(false));

        this._bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.END,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
            visible: false,
            css_classes: ['toolbar', 'claude-meter-bar'],
        });
        for (const w of [this._deleteSelectedButton, this._sizeLabel, this._cancelSelectButton])
            this._bar.append(w);

        // Opaque pill (the stock .osd lets the rows show through).
        const css = new Gtk.CssProvider();
        css.load_from_string('.claude-meter-bar { background-color: @popover_bg_color; ' +
            'color: @popover_fg_color; border-radius: 999px; padding: 6px 8px; ' +
            'box-shadow: 0 2px 10px alpha(black, 0.45), 0 0 0 1px alpha(@borders, 0.6); }');
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    // Adw.PreferencesWindow only accepts pages: wrap its content in an overlay
    // that hosts the floating bar. Call once, after the page is added.
    installOverlay() {
        const content = this._window.get_content();
        if (!content || this._overlay)
            return;
        this._window.set_content(null);
        this._overlay = new Gtk.Overlay({child: content});
        this._overlay.add_overlay(this._bar);
        this._window.set_content(this._overlay);
        this._visiblePageId = this._window.connect('notify::visible-page', () => this._syncBar());
        this._syncBar();
    }

    _syncBar() {
        const show = this._selectionMode && this._window.get_visible_page() === this.page;
        this._bar.visible = show;
        // Keep the last row reachable: spare room under the last group while the bar is up.
        this._projectGroups.forEach((g, i) => {
            g.margin_bottom = show && i === this._projectGroups.length - 1 ? 72 : 0;
        });
    }

    // Cancel pending work; call when the window closes.
    close() {
        this._closed = true;
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._removeEscController();
        if (this._visiblePageId) {
            this._window.disconnect(this._visiblePageId);
            this._visiblePageId = 0;
        }
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
        this._trashModeButton.visible = !this._selectionMode;
        this._deleteCountLabel.label = String(n);
        this._deleteSelectedButton.sensitive = n > 0 && !this._busy;
        this._cancelSelectButton.sensitive = !this._busy;
        let known = 0;
        let any = false;
        for (const s of this._selected) {
            if (typeof s.size === 'number') {
                known += s.size;
                any = true;
            }
        }
        this._sizeLabel.label = any ? GLib.format_size(known) : '—';
        this._syncBar();
    }

    // Disable the controls while an operation runs (the page stays scrollable).
    _setBusy(busy) {
        this._busy = busy;
        this._headBox.sensitive = !busy;
        this._bar.sensitive = !busy;
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
            // Row suffixes sit inside the row padding: line the centers up.
            margin_end: 14,
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
        const size = typeof session.size === 'number' ? GLib.format_size(session.size) : '—';
        row.subtitle = `Ultima apertura ${formatDate(session.lastUsedAt)} · ${size}`;

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
            let totalBytes = null;
            try {
                totalBytes = await this._store.getTargetsSize(targets, this._cancellable);
            } catch (e) {
                console.debug(`claude-meter: size failed: ${e.message}`);
            }
            const result = await this._confirmAndTrash({
                targets,
                totalBytes,
                heading: n === 1 ? 'Eliminare 1 conversazione?' : `Eliminare ${n} conversazioni?`,
                body: 'Verranno spostati nel cestino:',
                trash: () => this._store.trashMany(sessions, null),
                activeMessage: 'Una conversazione è in corso: non può essere eliminata',
            });
            if (!result)
                return;

            const skipped = result.skippedActive?.length ?? 0;
            const failed = result.failed.length;
            const freed = GLib.format_size(result.trashedBytes ?? 0);
            if (failed === 0 && skipped === 0) {
                this._applySelectionMode(false);
                for (const s of sessions)
                    this._removeRow(s);
                this._toast(n === 1 ? `1 conversazione spostata nel cestino: ${freed}`
                    : `${n} conversazioni spostate nel cestino: ${freed}`);
            } else if (failed > 0 && result.trashed.length === 0 && skipped === 0) {
                this._toast('Eliminazione non riuscita');
            } else {
                const deleted = n - skipped;
                let msg = skipped > 0
                    ? `${deleted} eliminate, ${skipped} in corso non eliminate`
                    : `${deleted} eliminate`;
                if (failed > 0)
                    msg += `; ${failed === 1 ? '1 elemento non eliminato' : `${failed} elementi non eliminati`}`;
                if (result.trashed.length > 0)
                    msg += ` (${freed} nel cestino)`;
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
    async _confirmAndTrash({targets, totalBytes = null, heading, body, trash, activeMessage}) {
        // heading/body are plain text unless *_use_markup is set: no escaping.
        const dialog = new Adw.AlertDialog({heading, body});
        dialog.set_extra_child(this._buildTargetsList(targets, totalBytes));
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

    _buildTargetsList(targets, totalBytes = null) {
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

        if (totalBytes !== null) {
            box.append(new Gtk.Label({
                label: `Verranno spostati nel cestino ${GLib.format_size(totalBytes)} in totale ` +
                    '(conversazioni e dati collegati).',
                xalign: 0,
                wrap: true,
                max_width_chars: 50,
            }));
        }

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
