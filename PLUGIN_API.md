# Plugin API

A plugin extends Bowerbird. It can add card kinds, tools, panels, a view, commands, drop handlers and a settings section.

Installing a plugin is trusting its code, the way installing an Obsidian or VS Code extension is. The API below is the supported contract. A plugin that reaches past it into core DOM or internals may break in a later version.

## What a plugin is

A folder with a manifest and an entry point:

```
my-plugin/
  manifest.json
  main.ts
  style.css        (optional)
```

`manifest.json`:

```json
{
  "id": "hello-card",
  "name": "Hello Card",
  "version": "0.1.0",
  "apiVersion": "2",
  "description": "A sample card, tool, panel, command and view.",
  "permissions": ["board:write", "files:embed", "storage", "view:replace"],
  "main": "main.ts",
  "styles": ["style.css"],
  "contributions": {
    "cards": [{ "kind": "Hello", "title": "Hello card" }],
    "tools": [{ "id": "stamp", "title": "Hello stamp" }],
    "panels": [{ "id": "hello", "title": "Hello" }],
    "views": [{ "id": "list", "title": "List view" }],
    "commands": [{ "id": "add-hello", "title": "Add a hello card" }]
  }
}
```

- `id` is unique, lowercase, letters, digits and `-` only. It names the plugin in board JSON, in storage and in the UI.
- `apiVersion` is `"2"`. A plugin written for API 1 does not load.
- `permissions` gates the API object. A method that needs a permission the manifest did not declare throws. `board:read` is always allowed; everything else must be declared.
- `required` (optional) marks a plugin that cannot be disabled. Only the board and the Settings window use it. Do not mark an ordinary plugin required.
- `contributions` is a summary for Settings. The code in `main.ts` is what actually registers each contribution. If the two disagree, the registered contributions win. One exception: a card contribution may carry `"frame": true`, which the core reads from the manifest — a frame card is a container, not content, so when its plugin is disabled the frame hides instead of showing a placeholder, and re-enabling the plugin brings it back.

## TypeScript, compiled in the app

Write the plugin in TypeScript. The app compiles it when it loads — there is no build step, and adding a file to a plugin folder never means rebuilding the app.

- The entry point is `main.ts`. It must export `activate(api)` and may export `deactivate()`. It loads as an ES module over the `plugin:` scheme (`plugin://<plugin-id>/main.ts`), so it may be multiple files: a relative import in `main.ts` resolves against the plugin's own folder. Import a sibling as `./helper.js` and the app serves the transpiled `helper.ts`.
- Only `.js`, `.ts`, `.css` and `.json` are served, and only from the plugin's own folder. A path that escapes the folder is a 404.
- A plugin may also be plain JavaScript (`main.js`). Either way the loader only ever sees JavaScript.
- The API types come from `import type { PluginContext } from "../../src/plugins"`. A type-only import is erased at compile time, so a plugin never depends on the core's source at runtime. `npm run typecheck:plugins` type-checks the bundled plugins.

```ts
import type { PluginContext } from "../../src/plugins";

export function activate(api: PluginContext) {
  api.cards.register({
    kind: "Hello",
    title: "Hello card",
    render: (item, data) =>
      `<div class="hello"><strong>${api.text.escapeHtml(data.text)}</strong></div>`,
  });
  api.ui.registerCommand({
    id: "add-hello",
    title: "Add a hello card",
    run: () =>
      api.board.addPluginCard("Hello", { text: "Hello!" }, { x: 100, y: 100 }, { w: 260, h: 96 }),
  });
}
```

## Where plugins live

Loaded once, first place wins, in this order:

1. The folder named by `BOWERBIRD_PLUGINS_DIR`, if set. For development and testing.
2. The user plugins folder next to the board data (`~/.local/share/bowerbird/plugins/` on Linux, the equivalent Application Support folder on macOS).
3. The bundled `plugins/` folder in the app.

Bundled plugins are listed in Settings as "Built in" and update with the app. A duplicate id in a later folder is skipped.

Enable and disable are per plugin, in Settings → Plugins. Disabling unregisters its tools, panels, commands and views, and re-renders the board so its cards become placeholders (see below). Re-enabling re-runs `activate`.

## The API object

`activate(api)` receives one object, per plugin, filtered to the manifest's permissions. `api.version` is `"2"`. The full reference is the `PluginContext` type in `src/plugins.ts`. The domains:

- `board` — read and write the board: items, selection, add / update / remove, group / ungroup / delete, undo / redo, canvas, save, render. Writes need `board:write`. A plugin may read any card but may only write its own plugin cards' data, plus core kinds' position, size and group. A group is a section: grouping cards draws a labelled frame around them, and `setGroupLabel` renames it. Three methods exist for building and tidying structures: `addItems` adds several items at once, in one undo step (addItem saves after every item); `arrange` lays a set of cards out — a grid, flowing columns, a single row or column, or a ring around a central card — in one undo step, anchored on the cards' current bounding box; `connect` draws a connector between two cards by id, so the caller never builds the anchor format or the line's bounding box. The board view itself uses a further set of methods, which are part of the same contract: `renderCardAt` renders a card exactly as it appears on the board (real position, selection and editing state), while `renderCard` renders it at 0,0 with no selection or editing state, for embedding in a panel or view; `hitTest`, `marqueeSelect`, `lassoSelect` and `strokesNear` are pure selection queries over the live board; `moveItems`, `resizeItem`, `setItemRotation`, `removeItems`, `bringToFront`, `setTextContent` and `addItemSilent` change the live board without saving or rendering, so a drag (or a text commit) saves once at the end instead of once per pointermove — a plugin that wants a saved, undoable change uses `updateItem(s)` instead, and `saveWithoutUndo` saves to disk without creating an undo step, for a change the user did not make as an edit (a pan's camera move, a click's re-stack); `createGroup` groups a set of cards with a fresh group id from the board's `next_group`, in one undo step.
- `boards` — list, read, create, switch, rename and delete boards. Needs `board:write` except for `list`, `read` and `current`. `read(name)` returns the board's items, so a plugin can show cards from a board that is not open.
- `app` — read-only app info: build id and platform.
- `backups` — list and restore board backups, and open the backups folder in the file explorer.
- `window` — hide / show / minimise / close / fullscreen / maximise, and the Hide corner. Needs the `window` permission.
- `view` — camera, zoom, the current view, switching views. `setCamera` saves and renders; `setCameraSilent` sets the camera without saving or rendering, for a live pan or zoom drag that saves once at drag end.
- `shapes` — the shape table for a shape picker, and `previewPoints` for the drag-preview polygon of a shape in a box.
- `ui` — toast, tools, panels, commands, views, overlays, settings sections, shortcuts, the settings UI. Tools are click tools, not drag tools: core drag state is not handed to plugins. Shortcuts are single keys, no modifiers; the core's keys win. `registerCreateAction({ id, label, icon?, run(world) })` offers an alternative to typing when the user double-clicks: the core opens the text box as always, with the action's icon beside it, and clicking the icon runs the action at the note's position instead of typing.
- `cards` — register a card kind (`register`) or a built-in kind's renderer (`registerBuiltin`). Card data is always JSON. `registerDecorator` adds a decoration inside a card, at its bottom edge (`{ id, side?, render(item) }`, `side` "left" by default, "right" for the other corner; returning HTML or null); the core calls it for every card on every render, so it must be pure, fast, and escape its text, and the decoration never takes clicks. A Text card's checklist progress is core, not a decorator — it always shows n/m at the bottom right — and it is open to plugins: `getChecklistProgress(item)` reads it (`{ done, total }`, or null with no task lines), `setChecklistProgress(id, done)` sets how many task lines are checked, in one undo step (needs `board:write`).
- `files` — embed files, the library folder, file URLs, open external, link previews, and `readFileBase64` for the board view's media fallback. All file access goes through the core. Reads and path-based embeds only ever touch board-local files: `embedFile` takes a `File` (from a file input or a drop, sent as bytes) or a board-local path, and `readTextFile` / `fileSize` / `readFileBase64` refuse anything outside the board.
- `storage` / `secureStorage` — per-plugin settings. Do not store secrets in plain storage; secure storage encrypts where the OS can. The ids are a contract, not a boundary: the main process cannot tell which plugin is calling, so a plugin that calls the bridge directly can read another plugin's stored values. Only install plugins you trust.
- `plugins` — list, enable / disable, reset, install, try in memory, end a trial. Needs `plugins:install`.
- `ai` — chat completions (`chat({ base, model, messages })`), run in the main process, not the renderer. Only the chat-completions path of the given base is called. The API key is never passed per call and never held in the renderer: the main process looks it up from its own store (set it with `setKey`, check it with `hasKey`), and it is not readable through `api.secureStorage`. Public bases must be https; a localhost base may be http, for a local model server. Needs `ai`.
- `events` — `on` / `off` for `selection`, `board`, `view`, `pen`, `tool`, plus `camera` (the zoom changed), `saving` (a content write started), `saved` (the board file holds the latest content) and `save-failed` (a write failed — the next save retries). Do not write to the board synchronously inside a `board` handler in a way that loops.
- `pen` — the pen colour, shared with the toolbar.
- `media` — PDF and audio state for the cards that play media: `toggleAudio` and `seekAudio` for an audio card's play button and seek slider, `setPdfPage` for a PDF card's prev/next buttons. `transcribeAudio(blob)` transcribes a recorded audio blob to text, on-device (Whisper in the main process), or null when it cannot be decoded or the model cannot run; no audio leaves the machine, and no permission is needed.
- `text` / `geometry` — pure helpers: escaping, markdown, colour, hit-testing, segment and rect math.
- `search` — the search engine: hand it the box elements, update, clear, jump to a match.

A plugin that throws during `activate`, or whose module fails to import, is recorded as failed, listed in Settings → Plugins with its error, and does not stop other plugins or the board from loading. A plugin that throws during a card render falls back to the missing-plugin placeholder for that card.

## Board-safe rules

1. **Uninstall is not delete.** Plugin card data is stored as `{ "Plugin": { "plugin": "<id>", "kind": "<kind>", "data": {...} } }` in board JSON. The core never strips a `Plugin` item it does not recognise, on load or on save.
2. **Open without the plugin is not lose.** A `Plugin` item whose plugin is missing or disabled renders as a placeholder naming the plugin and kind, with the note that its data is kept. It can still be moved, grouped, connected and deleted like any other card.
3. **Views never overwrite 2D data.** A view's extra per-item data lives in that plugin's namespace, separate from `pos` and `size`. Returning to `"board"` restores the 2D layout.
4. **Plugin storage is not board data.** Disabling or removing a plugin does not delete board items, and deleting a board does not delete plugin storage.

## Styling

Use the core tokens, not hard-coded copies: SF type, ink `#1D1D1F`, grey `#86868B`, hairline `rgba(0,0,0,0.08)`, separator `rgba(0,0,0,0.10)`, fill `rgba(120,120,128,0.12)`, quiet grey field `#F5F5F7`. Panels are opaque white with a hairline on the left. Cards are white, 12px radius, hairline border, soft shadow. Scope plugin CSS to the plugin's own containers — the core prefixes panel and view containers with `data-plugin="<id>"`. Do not restyle core UI from a plugin, and do not add branding, ads or a second toolbar inside a panel.

## What is not in the API

- No drag tools. Click tools only.
- No menu bar contributions.
- No network access except through `fetchPreview`.
- No main-process plugins, no Node access, no direct filesystem or shell access.
- No plugin store, no paid plugins, no auto-update.
- No deactivate cleanup for event listeners. Handlers registered in `activate` stay registered after `deactivate`, so they must guard on missing panel, view or overlay elements.
- No sandboxing stronger than the contract above. A locally installed plugin runs in the renderer with the API object, and like any locally installed extension it must be trusted by the person who installed it.

## Bundled and first-party plugins

Plugins in `plugins/` ship inside the app and use exactly this API, no backdoors. See `plugins/README.md`. The built-in UI in `src/core-plugins/` is built on the same API, loaded the same way, under a manifest with the same permissions — the only difference is loading. See `ARCHITECTURE.md`.
