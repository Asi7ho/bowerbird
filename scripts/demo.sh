#!/bin/sh
# Bowerbird demo — runs the app without saving anything.
#
# Usage (from the repo root, or from anywhere — the script finds it):
#   ./scripts/demo.sh
#
# What demo mode does:
#   - Always starts from the fresh welcome board, never your real board
#   - Never writes a board file, a settings file, a showcase copy,
#     or a dropped-file copy, and never deletes anything
#   - Changing the corner, resetting the board, or quitting all
#     stay in memory only; quit and everything is gone
#   - Chromium's own cache (which Electron writes on every launch)
#     goes to an OS temp folder in demo mode, not to your
#     Bowerbird config folder, so a demo run leaves no Bowerbird
#     folder behind at all
#   - The window title says "Bowerbird — Demo", and Settings says
#     "Demo — nothing is saved"
#
# What it does not do: it does not make a separate demo app or a
# separate install. It is the same app, run with BOWERBIRD_DEMO=1.
# Your real board and settings are untouched — the demo never
# even opens them.
set -e
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
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
