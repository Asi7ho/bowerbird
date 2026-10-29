#!/bin/sh
# Bowerbird demo.
#
# By default this builds a package other people can install:
#   ./scripts/demo.sh            # builds dist-mac-demo/Bowerbird-Demo-*.dmg
#   ./scripts/demo.sh --package  # same thing, explicit
#
# To run the demo locally from source instead:
#   ./scripts/demo.sh --run
#   npm run demo
#
# The demo is the same app, in demo mode (BOWERBIRD_DEMO=1 when
# run from source, a demo-mode marker file when packaged — see
# scripts/package-demo.sh). In demo mode it:
#   - Always starts from the fresh welcome board, never your real board
#   - Never writes a board file, a settings file, a showcase copy,
#     or a dropped-file copy, and never deletes anything
#   - Changing the corner, resetting the board, or quitting all
#     stay in memory only; quit and everything is gone
#   - The window title says "Bowerbird — Demo", and Settings says
#     "Demo — nothing is saved"
#   - Chromium's own cache goes to an OS temp folder in demo mode,
#     not to your Bowerbird config folder
#
# What it does not do: the demo package is unsigned, like the
# normal DMG, so a recipient must right-click it and choose Open
# the first time.
set -e
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
case "${1:-}" in
  --run)
    if [ ! -f node_modules/electron/package.json ]; then
      echo "Dependencies are not installed in this folder. Run: npm install" >&2
      exit 1
    fi
    echo "Bowerbird demo — nothing will be saved. Quit to discard everything."
    npm run build >/dev/null
    EXTRA=""
    if [ "$(id -u)" = "0" ]; then
      # Electron refuses to run as root without this; on a normal
      # user account (e.g. a Mac) it is not needed.
      EXTRA="--no-sandbox"
    fi
    BOWERBIRD_DEMO=1 ./node_modules/.bin/electron . $EXTRA
    ;;
  --package|"")
    ./scripts/package-demo.sh
    ;;
  --help|-h)
    echo "Usage: ./scripts/demo.sh [--package|--run]"
    echo "  --package  build the demo DMG for others to install (default)"
    echo "  --run      run the demo locally from source"
    ;;
  *)
    echo "Unknown option: $1 (try --help)" >&2
    exit 1
    ;;
esac
