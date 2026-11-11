# Tests

Three layers, each run in CI on every pull request and push to
main (`.github/workflows/test.yml`, Ubuntu only).

## Unit — `npm run test:unit`

Vitest, no DOM, no Electron. Covers the pure core in
`src/model.ts`: stylus pressure, hit-testing, marquee and
lasso selection, arranging, selection and mutation, text
cards (markdown, checklists, height) and the small helpers.
Add a test next to the behaviour it pins down; keep the
tests in `tests/unit/`.

## End to end — `npm run build && npm run test:e2e`

Boots the production build in Electron (via
playwright-core, no browser download) and drives it like a
user: pen draws a stroke and it lands in `board.json`, undo
removes it, double-click creates a text note and edits it
back, two slow clicks do not open an editor, a user plugin
written in TypeScript loads and renders its card, a bundled
plugin enables and opens, and the board survives a reload.
The app runs against temp dirs (`BOWERBIRD_BOARD_PATH`,
`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `BOWERBIRD_PLUGINS_DIR`),
so it never touches a real board.

Needs a display: `xvfb-run -a npm run test:e2e` in CI,
or a desktop session locally. On failure the script saves
a screenshot to `tests/e2e/artifacts/` and keeps the temp
board so the state can be inspected.

## Typechecks — `npm run typecheck`

Renderer, main process and plugins (`tsc --noEmit`,
`tsc -p tsconfig.main.json --noEmit`,
`npm run typecheck:plugins`). `npm test` runs the unit
suite; the workflow runs all three layers.
