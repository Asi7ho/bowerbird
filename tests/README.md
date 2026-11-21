# Tests

Three layers, each run in CI on every pull request and push to
main (`.github/workflows/test.yml`, Ubuntu only).

## Unit — `npm run test:unit`

Vitest, no DOM, no Electron. 272 tests in 19 suites under
`tests/unit/`, covering the pure core: stylus pressure,
hit-testing, marquee and lasso selection, arranging, selection
and mutation, text cards (markdown, checklists, height), board
and settings parsing, undo, search, shortcuts, overlay
placement, live import (SVG, PSD, AI), 3D models, link previews,
audio peaks, export, recovery, welcome board, and the agent CLI.
Add a test next to the behaviour it pins down; keep the
tests in `tests/unit/`.

## End to end — `npm run build && npm run test:e2e`

Boots the production build in Electron (via
playwright-core, no browser download) and drives it like a
user: 63 checks covering pen and strokes, undo/redo, notes,
plugins (user and bundled), reload survival, groups, 3D model
cards in all six formats, backups/restore plus the Versions
history, shortcuts, search, FileCard/PSD/AI drops, SVG
live-import, audio and video cards, shape outlines, crash
recovery, and save-on-quit.
The app runs against temp dirs (`BOWERBIRD_BOARD_PATH`,
`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `BOWERBIRD_PLUGINS_DIR`),
so it never touches a real board. The runner creates its temp
dir under `os.tmpdir()`, so `TMPDIR` controls where it lands
(e.g. `TMPDIR=~/workspace/perf-measure/e2e-tmp`).

The 3D checks need WebGL. CI has no GPU, so the runner
launches Electron with `--enable-unsafe-swiftshader` and
`--ignore-gpu-blocklist` (software GL); a real machine uses
its own GPU and never needs them.

Fixtures live in `tests/e2e/fixtures/`: `cube.{glb,obj,fbx,stl,usdz,dae}`,
`sample.{pdf,psd,ai,svg}`, `legacy.ai`, `sample-vector.ai`, `speech.mp3`, `transparent.png`.

Needs a display: `xvfb-run -a npm run test:e2e` in CI,
or a desktop session locally. On failure the script saves
a screenshot to `tests/e2e/artifacts/` and keeps the temp
board so the state can be inspected.

## Typechecks — `npm run typecheck`

Renderer, main process and plugins (`tsc --noEmit`,
`tsc -p tsconfig.main.json --noEmit`,
`npm run typecheck:plugins`). `npm test` runs the unit
suite; the workflow runs all three layers.
