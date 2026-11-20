#!/usr/bin/env bash
# Pack and install Claude Meter for the current user.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
gnome-extensions install --force dist/claude-meter@grillofra.shell-extension.zip
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/claude-meter@grillofra"
glib-compile-schemas "$DEST/schemas"

# Animation height vs the space measured in the panel.
# $1 = SPRITE_HEIGHT (px), $2 = panel-content-height (px, 0 = not measured yet)
check_height() {
    local sprite="$1" measured="$2" mode answer
    local gs=(gsettings --schemadir "$DEST/schemas")
    if [ "$measured" -eq 0 ]; then
        echo "Animation height: ${sprite} px. The panel space has not been measured yet:"
        echo "the extension will warn on first start if the animations do not fit."
    elif [ "$measured" -ge "$sprite" ]; then
        echo "Animations: ${sprite} px, panel space: ${measured} px - OK"
    else
        mode=$("${gs[@]}" get org.gnome.shell.extensions.claude-meter crab-overflow 2>/dev/null || echo "'overflow'")
        mode=${mode//\'/}
        echo "Animations: ${sprite} px, panel space: ${measured} px - the animations are too tall."
        if [ -t 0 ]; then
            read -r -p "[o]verflow or [c]rop the top rows? (current: ${mode}) " answer || answer=""
            case "$answer" in
                [oO]*) "${gs[@]}" set org.gnome.shell.extensions.claude-meter crab-overflow overflow || true ;;
                [cC]*) "${gs[@]}" set org.gnome.shell.extensions.claude-meter crab-overflow crop || true ;;
                *) echo "Setting unchanged (${mode})." ;;
            esac
        else
            echo "To change: Preferences -> \"Animations too tall\" (current: ${mode})."
        fi
    fi
}

SPRITE_HEIGHT=$(grep -oE 'SPRITE_HEIGHT = [0-9]+' lib/sprites.js | grep -oE '[0-9]+$' || echo 0)
MEASURED=$(gsettings --schemadir "$DEST/schemas" get org.gnome.shell.extensions.claude-meter panel-content-height 2>/dev/null | grep -oE '[0-9]+$' || true)
MEASURED=${MEASURED:-0}

clear
echo "Claude Meter @ grillofra"
echo "Extension installed successfully."
echo "Now log out and back in, then run:"
echo "gnome-extensions enable claude-meter@grillofra"
echo
check_height "${SPRITE_HEIGHT:-0}" "$MEASURED"
