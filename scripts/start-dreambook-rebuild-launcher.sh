#!/bin/sh
set -eu
BUN="$HOME/.bun/bin/bun"
if [ ! -x "$BUN" ]; then
  printf '%s\n' "DreamBook Bun executable is missing: $BUN" >&2
  exit 1
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$BUN" run "$SCRIPT_DIR/start-dreambook-rebuild-launcher.ts"
