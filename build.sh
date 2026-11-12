#!/usr/bin/env bash
# Generate theme stylesheets and pack the extension into dist/.
set -euo pipefail
cd "$(dirname "$0")"
cat styles/base.css styles/dark.css  > stylesheet-dark.css
cat styles/base.css styles/light.css > stylesheet-light.css
cp stylesheet-dark.css stylesheet.css   # fallback when no variant applies
mkdir -p dist
gnome-extensions pack --force --out-dir=dist \
    --extra-source=lib --extra-source=icons \
    --extra-source=stylesheet-dark.css --extra-source=stylesheet-light.css \
    --schema=schemas/org.gnome.shell.extensions.claude-meter.gschema.xml .
