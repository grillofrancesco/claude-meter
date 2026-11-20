#!/usr/bin/env bash
# Pack and install Claude Meter for the current user.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
gnome-extensions install --force dist/claude-meter@grillofra.shell-extension.zip
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/claude-meter@grillofra"
glib-compile-schemas "$DEST/schemas"

# Controllo altezza animazioni vs spazio misurato nel pannello.
# $1 = SPRITE_HEIGHT (px), $2 = panel-content-height (px, 0 = mai misurato)
check_height() {
    local sprite="$1" measured="$2" mode answer
    local gs=(gsettings --schemadir "$DEST/schemas")
    if [ "$measured" -eq 0 ]; then
        echo "Altezza animazioni: ${sprite} px. Lo spazio nel pannello non e' ancora stato misurato:"
        echo "l'estensione avvisera' al primo avvio se le animazioni non ci stanno."
    elif [ "$measured" -ge "$sprite" ]; then
        echo "Animazioni: ${sprite} px, spazio nel pannello: ${measured} px — OK"
    else
        mode=$("${gs[@]}" get org.gnome.shell.extensions.claude-meter crab-overflow 2>/dev/null || echo "'overflow'")
        mode=${mode//\'/}
        echo "Animazioni: ${sprite} px, spazio nel pannello: ${measured} px — le animazioni sono troppo alte."
        if [ -t 0 ]; then
            read -r -p "[s]bordare o [t]agliare la parte superiore? (attuale: ${mode}) " answer || answer=""
            case "$answer" in
                [sS]*) "${gs[@]}" set org.gnome.shell.extensions.claude-meter crab-overflow overflow || true ;;
                [tT]*) "${gs[@]}" set org.gnome.shell.extensions.claude-meter crab-overflow crop || true ;;
                *) echo "Impostazione invariata (${mode})." ;;
            esac
        else
            echo "Per cambiare: Preferenze → \"Animazioni troppo alte\" (attuale: ${mode})."
        fi
    fi
}

SPRITE_HEIGHT=$(grep -oE 'SPRITE_HEIGHT = [0-9]+' lib/sprites.js | grep -oE '[0-9]+$' || echo 0)
MEASURED=$(gsettings --schemadir "$DEST/schemas" get org.gnome.shell.extensions.claude-meter panel-content-height 2>/dev/null | grep -oE '[0-9]+$' || true)
MEASURED=${MEASURED:-0}

clear
echo "Claude Meter @ grillofra"
echo "Estensione installata con successo."
echo "Ora esci e rientra nella sessione, poi esegui:"
echo "gnome-extensions enable claude-meter@grillofra"
echo
check_height "${SPRITE_HEIGHT:-0}" "$MEASURED"
