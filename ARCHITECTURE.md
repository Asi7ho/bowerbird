# Bowerbird architecture — core as API, all GUI as plugins

## Goal

The core is headless: it owns the board model, persistence, the
plugin host and the API, and it renders nothing. Every visible
thing — title bar, toolbar, search, settings, board view, card
kinds — is a plugin built on that API. Replacing any piece of
the UI is replacing a plugin, and writing a new plugin is the
same act as building a piece of the UI.

This is the VS Code / Obsidian shape, not a skin system: the
built-in UI has no privileged path. It uses the same public
`PluginContext` every third-party plugin uses.

## Principles

- **One API.** There is a single public surface (`PluginContext`,
  in `src/plugins.ts`). If the built-in UI needs something, that
  something is added to the API first, then the UI uses it. The
  core never reaches into a plugin's DOM and a plugin never
  reaches into the core's DOM or internals.
- **Core renders nothing.** `index.html` is a bare mount point
  (`<div id="app">` plus the boot script). The core creates no
  title bar, toolbar, search box, settings window or board DOM.
  A plugin builds each of those.
- **First-party plugins are plugins.** The bundled UI is a set
  of first-party plugins that ship with the app. They use the
  same `PluginContext` as user plugins. The only difference is
  loading: first-party plugins are ES modules bundled with the
  app; user plugins are ES modules loaded over the plugin:
  scheme, so they can be multiple files with relative imports,
  exactly like a first-party plugin.
- **Board JSON is stable.** Moving a card kind or a UI piece
  into a plugin never changes the board format. Built-in kinds
  (`Text`, `Image`, `Swatch`, `UrlCard`, `PdfCard`, `Audio`,
  `Video`, `Shape`, `Stroke`, `Connector`) keep their shape in
  board JSON; only who renders them changes.
- **One piece at a time, verified live.** Each UI surface moves
  in its own step, and the app is run end to end as a real user
  would after that step before the next one starts. A step that
  breaks the app is reverted, not worked around.

## Current state (2026-11-06, before this refactor)

- `electron/main.js` + `electron/preload.js`: main process and
  the `window.bowerbird` bridge (board load/save, files, window
  controls, plugin IPC). This stays: it is the privileged layer,
  not UI.
- `src/main.ts` (~2,000 lines): the app. It builds and owns the
  whole UI (title bar, search, toolbar, board rendering, input,
  drag/pan/zoom, text editing, undo wiring) and passes a
  `PluginHost` to the plugin system.
- `src/plugins.ts` (~1,600 lines): the plugin host. It loads
  plugins, builds a `PluginContext` per plugin (board, boards,
  window, view, pen, ui, cards, files, storage, secureStorage,
  plugins, events, geometry), enforces permissions, and owns the
  panel/view/tool/command registries.
- `index.html`: the full GUI shell, hard-coded — title bar,
  search box, board, toolbar, settings dialog, plugin dock.
- `src/settings.ts`, `src/search.ts`, `src/cards.ts`,
  `src/model.ts`, `src/undo.ts`, `src/media.ts`, `src/drops.ts`:
  core modules the UI is built from.
- `plugins/`: seven bundled user-style plugins (Boards, Command
  Palette, Hide, Palette, Presentation, Tidy Up, Visual
  Library). They already use only the public API.

The gap: the plugin API is an *extension* surface on top of a
full GUI app. The core UI (toolbar, title bar, search, settings,
board view, built-in card renderers) is not built on it and
cannot be replaced by a plugin.

## Target architecture

```
index.html            bare mount: <div id="app"> + boot script
  └─ src/main.ts      core boot only: load board, create the
                      PluginHost + PluginContext factory, load
                      plugins, nothing else. Renders no DOM.
  └─ src/core/        headless core: board model, persistence
     (via the preload bridge), undo, camera, events,
     the plugin host. No DOM, no CSS, no toolbar.
  └─ src/plugins.ts   plugin host (unchanged role): loads
                      first-party (ES module) and user (blob
                      URL) plugins, builds PluginContext,
                      enforces permissions.
  └─ plugins/core-*/  first-party UI plugins, one per surface,
                      each using only PluginContext:
     core-board/      the board view: canvas, cards, input,
                      pan/zoom, drag, resize/rotate, text edit
     core-cards/      built-in card kinds (Text, Image, Swatch,
                      UrlCard, PdfCard, Audio, Video, Shape)
     core-toolbar/    toolbar + core tools (select, pen,
                      connector, shape) + zoom/delete/settings
     core-titlebar/   title bar: window controls, undo/redo,
                      panels toggle, search box host
     core-search/     search box + results list
     core-settings/   settings window (General, Plugins,
                      Plugin settings)
  └─ plugins/         the existing seven user-style plugins,
                      unchanged, still opt-in.
```

The core exposes, through `PluginContext`, everything the UI
plugins need. Where the current API is short, the API is
extended first (see below) — never by letting a UI plugin
reach into core internals.

## API extensions the UI needs (v1 → the UI can be built on it)

These are added to `PluginContext` before the UI piece that
needs them moves. Each is a small, named addition, not a new
API version on its own; the version bumps to `"2"` when the
core UI itself is fully plugin-built.

- **Board view primitives.** The board view needs the camera,
  hit-testing and the drag/edit loop. Add: `view.getCamera /
  setCamera` (exists), plus a `board` hit-test
  (`hitTest(world)`) and the selection/drag state the toolbar
  and view share. The input loop itself lives in the
  `core-board` plugin, which owns the board DOM and its
  listeners; the core only supplies model + geometry.
- **Card kinds.** A plugin must be able to register a renderer
  for a *built-in* kind, not only for `Plugin` kinds. Extend
  `cards.register` so a `core-cards` plugin registers
  `Text`, `Image`, `Swatch`, `UrlCard`, `PdfCard`, `Audio`,
  `Video`, `Shape`. The core's card wrapper (position, size,
  rotation, selection chrome) stays in the core and calls the
  registered renderer for the kind; a kind with no renderer
  shows the existing "missing renderer" placeholder instead
  of a silent blank.
- **Tools.** `ui.registerTool` / `ui.setTool` exist. The core
  tools (select, pen, connector, shape) become plugin tools
  registered by `core-toolbar`; their `onMouseDown` /
  `onMouseUp` run the same behaviour the core runs today.
  The core keeps no built-in tool of its own.
- **Settings.** Add to the API what the settings window
  needs: `backups.list()` / `backups.restore(name)`,
  `app.getBuildId()` / `app.getPlatform()` /
  `app.isDemo()`, and a `feedback` helper (the mailto the
  settings window builds today). The settings plugin builds
  its own DOM; it does not rely on static HTML in
  `index.html`.
- **Search.** The search UI is a plugin (`core-search`) that
  renders its own box + results and uses the existing search
  engine (MiniSearch + local context search) through the API.
  The engine stays a core module; the *box* becomes a plugin.
- **Title bar / window.** `window.*` (hide/show/minimise/
  move/getCorner/setCorner) exists. The title bar plugin also
  needs `ui` undo/redo state (`board.canUndo/canRedo`,
  `board.undo/redo` — exist) and a way to show/hide the
  panels dock (`ui.showPanel/hidePanel` — exist).

## Loading: first-party vs user plugins

- **User plugins** (in `plugins/` or installed): unchanged.
  Multi-file `main.js` (relative imports resolve over the
  plugin: scheme), `apiVersion` checked, permissions enforced.
  This is the v1 contract and it does not change.
- **First-party plugins** (in `plugins/core-*/`): ES modules
  bundled with the app. The core loads them with a normal
  `import()` at boot, then calls `activate(api)` with the
  same `PluginContext` a user plugin gets, under a manifest
  that declares the same permissions. They are *not* given a
  back door: if a first-party plugin needs something, that
  something goes in the API. Their code lives in the repo
  (not in `plugins/`, which is the user-plugin folder) so the
  two kinds are never confused.

## Migration order

Each step is a commit, verified live in a dev run before the
next step. The app must work identically after every step.

1. **Foundation.** First-party plugin loading: the core can
   `import()` a bundled plugin module and `activate()` it
   with a `PluginContext`, under a manifest. Add the API
   extensions the first UI slice needs. No UI moves yet.
   **Done** (`f79162c`).
2. **`core-settings`.** Move the settings window into a
   first-party plugin. It builds its own DOM and uses the
   API (board, backups, app info, feedback). The core no
   longer builds settings UI. Verify: open settings, every
   tab, change canvas colour/grid, restore a backup.
   **Done** (`f79162c`).
3. **`core-cards`.** Move the built-in card renderers into a
   first-party plugin via the extended `cards.register`.
   The core keeps only the card wrapper. Verify: the welcome
   board renders every kind; add each kind; old boards load.
   **Done** (`d8db03a`, with step 4).
4. **`core-toolbar`.** Move the toolbar and the core tools
   into a first-party plugin (tools registered via
   `ui.registerTool`). Verify: every tool, zoom, delete,
   settings button. **Done** (`d8db03a`, with step 3).
5. **`core-titlebar` + `core-search`.** Move the title bar
   (window controls, undo/redo, panels toggle) and the search
   box + results into plugins. Verify: window controls, undo/
   redo buttons, search finds and jumps, count is stable.
   **Done** (this commit). The title bar plugin builds the
   title bar and inserts it before the board element; it
   registers the panels toggle and the search box container
   through the shell, and wires window controls through new
   `api.window` methods (close, fullscreen, maximise,
   getWindowState). The search plugin builds the box
   contents into the title bar's container and hands the
   elements to the engine through `api.search.setElements`;
   the engine keeps the matching, dimming and results, and
   no longer queries the search box by id. The search box
   stays fixed at 360×34 in every state. The toolbar's
   Settings button now toggles (open/close) instead of
   opening only: the core's old toggle listener and the
   plugin's open-only listener both fired on a click, so
   the button could not close Settings.
6. **`core-board`.** Move the board view (canvas, cards
   layer, input, pan/zoom, drag, resize/rotate, text edit)
   into a first-party plugin. This is the largest step and
   goes last, once every other surface is already a plugin
   and the API has proven itself. Verify: full cold playtest
   — pan, zoom, add/edit/move/delete every card kind,
   undo/redo, plugins still work.
   **Partly done** (this commit): the board DOM is built by
   the core-board plugin (it creates #board and its layers
   and hands them to the shell via `api.ui.setBoardElements`),
   `index.html` is a bare mount point, and the core reads the
   board elements from the shell after the plugin activates.
   The render loop and the input loop (pan, zoom, drag,
   resize/rotate, text edit) still live in the core
   (`src/main.ts`), which owns the board model, the undo
   store and the search engine. Moving them into the plugin
   — the remaining deep work — needs the drag state machine
   rewritten against `api.board` (hitTest, updateItems) and
   the render loop against `api.board.getItems()` /
   `api.board.renderCard()`; it is not attempted here, to
   avoid regressing the board's core interactions.
7. **Bare shell.** `index.html` becomes the mount point only.
   The core renders nothing on its own. Bump the plugin
   `apiVersion` to `"2"` and document it in `PLUGIN_API.md`.

## What "done" looks like

- The app boots with zero UI plugins enabled and shows an
  empty mount point (a deliberate, visible proof the core
  renders nothing). Enabling the `core-*` plugins brings the
  full app back.
- Any `core-*` plugin can be disabled and replaced by a user
  plugin that provides the same surface (e.g. a different
  toolbar), with no core change.
- `PLUGIN_API.md` documents the full API a UI plugin uses,
  with a working minimal example (a plugin that replaces the
  toolbar).
- The existing seven plugins still work unchanged, and the
  welcome board still loads and renders identically.
