#!/usr/bin/env bash
# Headless, isolated GNOME Shell for testing the extension (needs mutter-devkit).
#   dev/nested.sh start            build, (re)start the shell with the extension enabled
#   dev/nested.sh eval '<js>'      run JS in the shell (unsafe mode via a test-only helper extension)
#   dev/nested.sh shot NAME [x y w h]  screenshot to .dev/NAME.png
#   dev/nested.sh log | stop
# Everything lives in .dev/ (XDG_DATA_HOME + memory GSettings): the real session is untouched.
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"; D="$P/.dev"; X="$D/xdg"
bus() { export DBUS_SESSION_BUS_ADDRESS="$(cat "$D/bus.txt")"; }
case "${1:-}" in
start)
    "$0" stop
    (cd "$P" && ./build.sh >/dev/null) || exit 1
    E="$X/gnome-shell/extensions"; rm -rf "$E/claude-meter@grillofra"; mkdir -p "$E/claude-meter@grillofra" "$E/devtest@local"
    (cd "$E/claude-meter@grillofra" && unzip -q -o "$P/dist/claude-meter@grillofra.shell-extension.zip" && glib-compile-schemas schemas)
    echo '{"uuid":"devtest@local","name":"devtest","description":"test only","shell-version":["50"]}' > "$E/devtest@local/metadata.json"
    printf '%s\n' "import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';" \
        "export default class extends Extension { enable() { global.context.unsafe_mode = true; } disable() {} }" > "$E/devtest@local/extension.js"
    cat > "$D/inner.sh" <<IN
#!/bin/bash
export XDG_DATA_HOME="$X" GSETTINGS_BACKEND=memory
gnome-shell --headless --virtual-monitor 1280x900 --wayland --no-x11 > "$D/shell.log" 2>&1 &
echo \$! > "$D/shell.pid"
for i in \$(seq 1 30); do gdbus introspect --session -d org.gnome.Shell -o /org/gnome/Shell >/dev/null 2>&1 && break; sleep 1; done
gnome-extensions enable devtest@local; gnome-extensions enable claude-meter@grillofra
echo "\$DBUS_SESSION_BUS_ADDRESS" > "$D/bus.txt"
wait
IN
    chmod +x "$D/inner.sh"; rm -f "$D/bus.txt"
    setsid dbus-run-session -- "$D/inner.sh" >/dev/null 2>&1 < /dev/null &
    for i in $(seq 1 40); do [ -s "$D/bus.txt" ] && break; sleep 1; done
    sleep 6; "$0" log ;;
eval) bus; gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval "$2" ;;
shot) bus; sleep 1; gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell/Screenshot \
        -m org.gnome.Shell.Screenshot.ScreenshotArea "${3:-0}" "${4:-0}" "${5:-1280}" "${6:-900}" false "$D/$2.png" >/dev/null && echo "$D/$2.png" ;;
log) grep -iE 'claude|JS ERROR|CRITICAL' "$D/shell.log" 2>/dev/null | grep -v geolocation | tail -20; true ;;
stop) [ -f "$D/shell.pid" ] && kill "$(cat "$D/shell.pid")" 2>/dev/null; rm -f "$D/shell.pid"; sleep 1 ;;
*) sed -n 2,8p "$0" ;;
esac
