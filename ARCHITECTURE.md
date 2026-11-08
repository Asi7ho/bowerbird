# Architecture — core as API, all GUI as plugins

The core is headless: it owns the board model, persistence, the plugin host and the API, and it renders nothing. Every visible thing — title bar, toolbar, search, settings, board view, card kinds — is a plugin built on that API. Replacing any piece of the UI is replacing a plugin, and writing a new plugin is the same act as building a piece of the UI.

This is the VS Code / Obsidian shape, not a skin system: the built-in UI has no privileged path. It uses the same public `PluginContext` every third-party plugin uses.

## Principles

- **One API.** There is a single public surface (`PluginContext`, in `src/plugins.ts`). If the built-in UI needs something, that something is added to the API first, then the UI uses it. The core never reaches into a plugin's DOM and a plugin never reaches into the core's DOM or internals.
- **Core renders nothing.** `index.html` is a bare mount point. The core creates no title bar, toolbar, search box, settings window or board DOM. A plugin builds each of those.
- **First-party plugins are plugins.** The bundled UI is a set of first-party plugins in `src/core-plugins/`. They use the same `PluginContext` as user plugins. The only difference is loading: first-party plugins are ES modules imported by the core; user plugins are ES modules loaded over the `plugin:` scheme, so they can be multiple files with relative imports.
- **Board JSON is stable.** Moving a card kind or a UI piece into a plugin never changes the board format. Built-in kinds (`Text`, `Image`, `Swatch`, `UrlCard`, `PdfCard`, `Audio`, `Video`, `Shape`, `Stroke`, `Connector`) keep their shape in board JSON; only who renders them changes.

## Layout

```
index.html            bare mount: <div id="app"> + boot script
src/main.ts           core boot only: load board, create the
                      PluginHost + PluginContext factory, load
                      plugins. Renders no DOM.
src/                  headless core: board model, persistence,
                      undo, camera, events, the plugin host.
src/plugins.ts        plugin host: loads first-party (ES module)
                      and user (plugin: scheme) plugins, builds
                      PluginContext, enforces permissions.
src/core-plugins/     first-party UI plugins, one file per surface,
                      each using only PluginContext: board, cards,
                      toolbar, titlebar, search, settings.
plugins/              the eight bundled plugins (AI Chat, Multiple
                      Boards, Command Palette, Hide Button, Colour
                      Palette, Presentation, Tidy Up, Visual
                      Library). Same API, opt-in, written in
                      TypeScript.
electron/             main process and the window.bowerbird bridge
                      (board load/save, files, window controls,
                      plugin IPC). TypeScript, compiled to
                      electron-dist/ by tsc -p tsconfig.main.json.
```

## Plugin loading

- **User plugins** (in `plugins/` or installed): loaded as ES modules over the `plugin:` scheme. `apiVersion` is checked, permissions are enforced. A plugin is written in TypeScript and compiled in the app when it loads — there is no build step (see PLUGIN_API.md).
- **First-party plugins** (in `src/core-plugins/`): ES modules imported by the core at boot, then `activate(api)` with the same `PluginContext` a user plugin gets, under a manifest that declares the same permissions. They are *not* given a back door: if a first-party plugin needs something, that something goes in the API.
- **Required plugins.** The board and Settings are `required: true` and cannot be disabled: disabling the board removed the toolbar and the Settings window with it, so the app soft-locked with no way back. A required plugin is always enabled, whatever the enabled map says, so a stale `false` in plugins.json self-heals on the next boot. The other core plugins stay disableable — that is how a replacement UI plugin takes over.

## Known boundary

The render loop and the input loop (pan, zoom, drag, resize/rotate, text edit, ~1000 lines in `src/main.ts`) still live in the core. The core renders no DOM but still owns the board controller. Moving them into the board plugin (`src/core-plugins/board.ts`) needs the drag state machine rewritten against `api.board` (hitTest, updateItems) and the render loop against `api.board.getItems()` / `api.board.renderCard()`. `api.board.hitTest` was added for that move.
