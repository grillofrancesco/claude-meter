#!/usr/bin/env bash
# Run every tests/test-*.js with gjs, then validate the GSettings schema.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

status=0
for t in tests/test-*.js; do
    [ -e "$t" ] || continue
    out=$(gjs -m "$t" 2>&1)
    rc=$?
    printf '%s\n' "$out" | grep '^FAIL' || true
    if [ "$rc" -eq 0 ]; then
        echo "OK    $t"
    else
        echo "FAIL  $t (exit $rc)"
        if ! printf '%s\n' "$out" | grep -q '^FAIL'; then
            printf '%s\n' "$out" | tail -n 20
        fi
        status=1
    fi
done

if glib-compile-schemas --strict --dry-run schemas/; then
    echo "OK    schemas"
else
    echo "FAIL  schemas"
    status=1
fi

if [ "$status" -eq 0 ]; then
    echo "All checks passed."
else
    echo "Some checks failed."
fi
exit "$status"
