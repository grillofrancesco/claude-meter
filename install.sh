#!/usr/bin/env bash
# Pack and install Claude Meter for the current user.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
gnome-extensions install --force dist/claude-meter@whitebear.shell-extension.zip
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/claude-meter@whitebear"
glib-compile-schemas "$DEST/schemas"
echo "Installata. Su Wayland: esci e rientra nella sessione, poi:"
echo "  gnome-extensions enable claude-meter@whitebear"
