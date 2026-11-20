import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Collects signal handler ids and disconnects them all when the window closes
// (or on demand: pass no window for a tracker that is disposed by hand, e.g.
// the one of pages that are rebuilt on a language change).
export class SignalTracker {
    constructor(window = null) {
        this._handlers = []; // [object, id]
        this._binds = []; // [settings, key... ] GSettings bindings, see bind()
        window?.connect('close-request', () => {
            this.disconnectAll();
            return false;
        });
    }

    // settings.bind(key, object, property, flags), unbound by disconnectAll().
    bind(settings, key, object, property, flags) {
        settings.bind(key, object, property, flags);
        this._binds.push([settings, object, property]);
    }

    // obj.connect(signal, callback), remembered for disconnectAll().
    connect(obj, signal, callback) {
        const id = obj.connect(signal, callback);
        this._handlers.push([obj, id]);
        return id;
    }

    disconnectAll() {
        for (const [obj, id] of this._handlers)
            obj.disconnect(id);
        this._handlers = [];
        for (const [settings, object, property] of this._binds)
            Gio.Settings.unbind(object, property);
        this._binds = [];
    }
}

// Two-way sync between an Adw.ComboRow and a string setting whose valid values
// are `values` (same order as the row's model).
//   fallback      value used when the row selection / setting is not in `values`
//   displayValue  () => string: value to show instead of the setting (default: the setting)
//   writable      () => bool: false = selection changes are not written back
//   extraKeys     other settings keys that also trigger a re-sync
//   onSync        () => void: called after every sync (sensitivity, tooltip, ...)
// Returns the sync function (already called once).
export function bindComboRow(settings, key, values, row, {
    tracker,
    fallback = values[0],
    displayValue = () => settings.get_string(key),
    writable = () => true,
    extraKeys = [],
    onSync = null,
} = {}) {
    let syncing = false;
    const sync = () => {
        const index = values.indexOf(displayValue());
        syncing = true;
        row.selected = index < 0 ? 0 : index;
        syncing = false;
        onSync?.();
    };
    sync();
    row.connect('notify::selected', () => {
        if (syncing || !writable())
            return;
        const value = values[row.selected] ?? fallback;
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    for (const k of [key, ...extraKeys])
        tracker.connect(settings, `changed::${k}`, sync);
    return sync;
}

// Do not start with the first spin button focused (and its text selected):
// GTK assigns the initial focus when the window is shown; undo it once.
export function clearInitialSpinFocus(window, spinRows) {
    const focusId = window.connect('notify::focus-widget', () => {
        if (!window.get_focus())
            return;
        window.disconnect(focusId);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            for (const row of spinRows)
                row.set_position(-1); // clears the select-on-focus selection
            window.set_focus(null);
            return GLib.SOURCE_REMOVE;
        });
    });
}
