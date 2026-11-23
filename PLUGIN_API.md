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
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "apiVersion": "2",
  "description": "An example plugin that adds a card, a tool, a panel, a command and a view.",
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
- The API types come from the `bowerbird-plugin-api` module (`import type { PluginContext } from "bowerbird-plugin-api"`). It is its own package (`plugin-api/`, linked as a dev dependency), so a plugin imports the API by name and never imports from the core's source — it is written as if it were a third-party plugin, and only ever receives the `api` object. `npm run typecheck:plugins` type-checks the bundled plugins.

```ts
import type { PluginContext } from "bowerbird-plugin-api";

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

Bundled plugins are listed in Settings as "Core" or "Extra" and update with the app. A duplicate id in a later folder is skipped.

Enable and disable are per plugin, in Settings → Plugins. Disabling unregisters its tools, panels, commands and views, and re-renders the board so its cards become placeholders (see below). Re-enabling re-runs `activate`.

## The API object

`activate(api)` receives one object, per plugin, filtered to the manifest's permissions. `api.version` is `"2"`. The full reference is the `PluginContext` type in the `bowerbird-plugin-api` module. The domains:

- `board` — read and write the board: items, selection, add / update / remove, group / ungroup / delete, undo / redo, canvas, save, render. Writes need `board:write`. A plugin may read any card but may only write its own plugin cards' data, plus core kinds' position, size and group, plus a colour patch on a stroke ({ color }) or a swatch ({ hex }). A group is a labelled frame: grouping cards draws a labelled frame around them, and `setGroupLabel` renames it. Three methods exist for building and tidying structures: `addItems` adds several items at once, in one undo step (addItem saves after every item); `arrange` lays a set of cards out — a grid, flowing columns, a single row or column, or a ring around a central card — in one undo step, anchored on the cards' current bounding box; `connect` draws a connector between two cards by id, so the caller never builds the anchor format or the line's bounding box. The board view itself uses a further set of methods, which are part of the same contract: `renderCardAt` renders a card exactly as it appears on the board (real position, selection and editing state), while `renderCard` renders it at 0,0 with no selection or editing state, for embedding in a panel or view; `getLive` / `getItemLive` are the live board / item with no copy, for the app's own UI hot paths (render, drags) — they exist on the same object but are app-UI-only, and a plugin that calls them is rejected, so a plugin reads through `get` / `getItem`, which return copies; `hitTest`, `marqueeSelect`, `lassoSelect` and `strokesNear` are pure selection queries over the live board; `moveItems`, `resizeItem`, `setItemRotation`, `removeItems`, `bringToFront`, `setTextContent` and `addItemSilent` change the live board without saving or rendering, so a drag (or a text commit) saves once at the end instead of once per pointermove — a plugin that wants a saved, undoable change uses `updateItem(s)` instead, and `saveWithoutUndo` saves to disk without creating an undo step, for a change the user did not make as an edit (a pan's camera move, a click's re-stack); `previewStroke(points, pressures?, opts?)` draws a drag tool's live preview stroke in the preview layer above the cards, without touching the board at all — no save, no undo step — and a call with no points clears it at once (`opts` is `{ width?, color?, marker?, pencil? }`, defaulting to width 3 and the pen colour); `previewShape(shape, x0, y0, w, h, opts?)` draws a drag tool's live shape preview in the same layer — the shape in its drag box, filled in the pen colour or outlined when `opts.outline` is set — and the core clears it when the drag ends or cancels, so it never lands in board JSON; `createGroup` groups a set of cards with a fresh group id from the board's `next_group`, in one undo step. Layers (`getLayers`, `createLayer(name?)`, `renameLayer`, `moveLayer`, `setLayerVisible`, `setLayerLocked`, `deleteLayer`, `getItemLayer`, `setItemLayer`, and the `layer` field on `updateItem(s)`) are the board's paint order, visibility and lock: layers paint bottom-to-top in list order, a hidden layer's items are not drawn and cannot be hit, marqueed or erased, and a locked layer's items do not move, resize, rotate or edit. New items land on the default layer (`"default"`), which is always present, visible and unlocked, and cannot be deleted; deleting another layer moves its items to the default. Every layer change is one undo step, and an old board without layers loads with every item on the default layer. Per-board plugin data (`getExtension`, `setExtension`, `removeExtension`) is a JSON value per plugin id, saved in board JSON and undone with the board: a plugin reads and writes only its own entry — there is no call that names another plugin's — and the data must be JSON (a value that cannot survive a round trip is rejected). `selectCard(selected, id, additive)` is the selection after clicking a card — the card and its whole group when it is grouped, or just the card — which the board view calls on a card click and on keyboard navigation; `registerController` is how the board plugin registers its render, selection, editing and tool functions with the core, the same shape as `registerSettingsUI`. Only the app's own UI may call `registerController` (or `registerSettingsUI`, or hand the plugin system its shell elements) — a plugin that tries is rejected, so no plugin can replace the board controller or the settings UI.
- `boards` — list, create, switch, rename and delete boards. Needs `board:write` except for `list` and `current`. Deleting a board is destructive: `delete` needs `{ confirmed: true }`, passed only after the caller's own confirmation (the UI arms the delete first).
- `app` — read-only app info: build id and platform. `getAppSettings` reads the persisted app settings (corner, panel layout, dock visibility, hardware acceleration, shortcut overrides); `setShortcuts` and `setHardwareAcceleration` write them back, and `restart` relaunches the app so a new hardware acceleration value takes effect. `factoryReset` wipes everything the app has saved; it needs `{ confirmed: true }`, passed only after the caller's own confirmation.
- `backups` — list and restore board backups, and open the backups folder in the file explorer. `listAll` lists every kept backup, for the Versions history in the Boards panel; `recoveryStatus` says whether the crash-recovery journal holds edits `board.json` does not, and `restoreRecovery` / `discardRecovery` restore or drop them.
- `exportBoard` / `importBoard` — top-level on the API object, not under a domain: export downloads the whole board as a ZIP (null when the user cancels the save dialog); import installs a data export — a ZIP file or the folder it unzips to — and loads the board that was current at export time. Import needs `board:write`.
- `window` — hide / show / minimise / close / fullscreen / maximise, and the Hide corner. Needs the `window` permission.
- `view` — camera, zoom, the current view, switching views, and `refresh` to re-render the active plugin view after the board changes. `setCamera` saves and renders; `setCameraSilent` sets the camera without saving or rendering, for a live pan or zoom drag that saves once at drag end.
- `shapes` — the shape table for a shape picker, and `previewPoints` for the drag-preview polygon of a shape in a box.
- `ui` — toast, tools, panels, commands, views, overlays, settings sections, shortcuts, the settings UI. Tools are drag tools as well as click tools: a tool that defines any of `onPointerDown` / `onPointerMove` / `onPointerUp` / `onPointerCancel` owns the gesture while it is active — the core starts the drag on pointerdown, routes every pointermove to `onPointerMove`, and ends it on pointerup (`onPointerUp`) or pointercancel / Escape / tool switch (`onPointerCancel`, at the drag's last point). Each callback gets the world point and a `PluginPointerEvent` (`pressure` 0..1, `tiltX` / `tiltY` in degrees, `pointerType` "mouse" / "pen" / "touch", `pointerId`, `buttons`, `isPrimary`). A tool with none of the drag callbacks keeps the old click behaviour (`onMouseDown` / `onMouseUp` only); when both are defined, the drag callbacks win and the click ones are not called. A drag tool shows its stroke while dragging with `board.previewStroke(points, pressures?, opts?)`, which draws in the preview layer above the cards without touching the board — the core clears it when the drag ends or cancels, and the next full render wipes it, so it never lands in board JSON; the tool commits the finished stroke with `addItem` on pointerup, as one undo step. A shape tool previews the same way with `board.previewShape(shape, x0, y0, w, h, opts?)`, and commits the finished shape with `addItem` on pointerup. Plugin shortcuts are single keys, no modifiers; the core's keys win. (Core shortcuts are different: rebindable bindings with modifiers, changed in Settings → Shortcuts.) `registerCreateAction({ id, label, icon?, run(world) })` offers an alternative to typing when the user double-clicks: the core opens the text box as always, with the action's icon beside it, and clicking the icon runs the action at the note's position instead of typing; `listCreateActions` lists the registered ones, so the board view can offer them. `getToolDef(id)` returns a plugin tool's full definition (its pointer handlers), and `dispatchShortcut(key)` offers a key to the shortcuts — the board view routes input to plugins through these, so a replacement board view can do the same. Isolation: a plugin runs and dispatches only its own commands and shortcuts (`runCommand`, `dispatchShortcut`); running or dispatching another plugin's is rejected. Listing them stays open, so a palette can show them. `routeCommand(pluginId, id)` is the command palette's routing path: the palette is a list the user picks from, not an executor — when the user picks a plugin command, the palette reports the pick here and the host runs the command as its owning plugin. Only the command palette may call it; a plugin runs its own commands with `runCommand`.
- `cards` — register a card kind (`register`) or a built-in kind's renderer (`registerBuiltin`). Card data is always JSON. `registerDecorator` adds a decoration inside a card, at its bottom edge (`{ id, side?, render(item) }`, `side` "left" by default, "right" for the other corner; returning HTML or null); the core calls it for every card on every render, so it must be pure, fast, and escape its text, and the decoration never takes clicks. A Text card's checklist progress is core, not a decorator — it always shows n/m at the bottom right — and it is open to plugins: `getChecklistProgress(item)` reads it (`{ done, total }`, or null with no task lines), `setChecklistProgress(id, done)` sets how many task lines are checked, in one undo step (needs `board:write`). `isFrame(item)` says whether a plugin card is a frame (declared in its manifest or by its renderer, holding even when the plugin is disabled, so a frame never rotates); `dispatchAction(action, item)` and `dispatchDoubleClick(item)` route a card action or double-click to the plugin that rendered the card, which is how the board view hands input to plugin cards. A plugin dispatches only on its own cards; dispatching on another plugin's card is rejected. A card kind may also provide `renderNode(item, data)` alongside `render`: instead of an HTML string, it returns a live DOM node (`{ node, update?, unmount? }`), which the board mounts inside the card chrome exactly where the string would go — same position, size, rotation, decorations, selection ring, drag, grouping and layer behaviour — and keeps across renders instead of rebuilding it. Use `render` for static content and `renderNode` when the card owns a `<canvas>`, a WebGL view, or interactive controls that must survive across renders. `render` stays required: plain contexts (slides, the library, export) have no live DOM and always use the HTML string, and a `renderNode` that throws falls back to `render` for that card. Lifecycle: `renderNode` is called once when the card's DOM is created (returning null hides the card, as `render` returning null does); `update(item, data)` is called when the item or its data changes, instead of rebuilding the card DOM — the plugin patches its own node in place, and returning false hides the card (it mounts again from `renderNode` when it should show); `unmount()` is called when the card leaves the board (deleted, culled out of view, hidden layer, board switch, plugin disabled) while the node is still attached, so the plugin can release listeners, animation frames and WebGL contexts — a removed card must not keep timers or listeners alive. Return a single element node, not a DocumentFragment: the core can only detach the node itself across renders. A node card's visibility may also depend on state outside the item (as a slide frame does on its panel): check that in `update` and return false to hide. `renderNodeCardChromeAt(id)` is the board view's builder for the empty chrome a node is mounted into. (`{ plain, transcriptHidden, transcriptShown }`) is the Audio card's heights, so a plugin that creates an audio card sizes it from these instead of hardcoding them.
- `files` — embed files, the library folder, file URLs, open external, link previews, and `readFileBase64` for the board view's media fallback. All file access goes through the core. Reads and path-based embeds only ever touch board-local files: `embedFile` takes a `File` (from a file input or a drop, sent as bytes) or a board-local path, and `readTextFile` / `fileSize` / `readFileBase64` refuse anything outside the board.
- `storage` / `secureStorage` — per-plugin settings. Do not store secrets in plain storage; secure storage encrypts where the OS can. The ids are a contract, not a boundary: the main process cannot tell which plugin is calling, so a plugin that calls the bridge directly can read another plugin's stored values. Only install plugins you trust.
- `plugins` — list, enable / disable, reset, install, try in memory, end a trial. Needs `plugins:install`.
- `ai` — chat completions (`chat({ base, model, messages })`), run in the main process, not the renderer. Only the chat-completions path of the given base is called. The API key is never passed per call and never held in the renderer: the main process looks it up from its own store (set it with `setKey`, check it with `hasKey`), and it is not readable through `api.secureStorage`. Public bases must be https; a localhost base may be http, for a local model server. Needs `ai`.
- `events` — `on` / `off` for `selection`, `board`, `view`, `pen`, `tool`, plus `camera` (the zoom changed), `items-moved` (cards moved or resized live, without a save — a drag moves cards and saves once at drag end, so a listener that follows a card needs this, not the save-time `board` event), `saving` (a content write started), `saved` (the board file holds the latest content) and `save-failed` (a write failed — the next save retries). `emit(event)` fires an event for every listener; the board view emits `selection` and `tool` when they change, and a plugin may emit its own custom event the same way — but a core event name (`board`, `camera`, `items-moved`, `pen`, `saving`, `saved`, `save-failed`, `selection`, `tool`, `view`) is rejected, so no plugin can fake a state change. Do not write to the board synchronously inside a `board` handler in a way that loops.
- `pen` — the pen colour, shared with the toolbar.
- `media` — PDF and audio state for the cards that play media: `toggleAudio` and `seekAudio` for an audio card's play button and seek slider, `setPdfPage` for a PDF card's prev/next buttons. `transcribeAudio(blob)` transcribes a recorded audio blob to text, on-device (Whisper in the main process), or null when it cannot be decoded or the model cannot run; no audio leaves the machine, and no permission is needed.
- `text` / `geometry` — pure helpers: escaping, markdown, colour (`parseHex`, `tint`, `tileColorFor`), toggling a task line (`toggleTaskLine`), hit-testing, segment and rect math, and the board's own geometry (`centre`, `itemBounds`, `itemRotation`, `rotatePoint`, `clippedEnds`, `fitCamera`) — the same functions the board view uses, so a plugin's layout and zoom-to-fit match the core's exactly.
- `search` — the search engine: hand it the box elements, update, clear, jump to a match.

A plugin that throws during `activate`, or whose module fails to import, is recorded as failed, listed in Settings → Plugins with its error, and does not stop other plugins or the board from loading. A plugin that throws during a card render falls back to the missing-plugin placeholder for that card.

## Board-safe rules

1. **Uninstall is not delete.** Plugin card data is stored as `{ "Plugin": { "plugin": "<id>", "kind": "<kind>", "data": {...} } }` in board JSON. The core never strips a `Plugin` item it does not recognise, on load or on save.
2. **Open without the plugin is not lose.** A `Plugin` item whose plugin is missing or disabled renders as a placeholder naming the plugin and kind, with the note that its data is kept. It can still be moved, grouped, connected and deleted like any other card.
3. **Views never overwrite 2D data.** A view's extra per-item data lives in that plugin's namespace, separate from `pos` and `size`. Returning to `"board"` restores the 2D layout.
4. **Plugin storage is not board data.** Disabling or removing a plugin does not delete board items, and deleting a board does not delete plugin storage.
5. **Layers are shared board structure; extensions are not.** Any plugin with `board:write` can list and change layers, and hiding or locking a layer affects every plugin and the board view alike. Per-board plugin data is the opposite: namespaced by plugin id, so a plugin reads and writes only its own entry, and uninstalling a plugin never deletes another plugin's board data. An old board without layers or extensions loads unchanged: every item on the default layer, extensions empty, healed in memory — the file gains the fields on the next save, never on load.

## Styling

Use the core tokens, not hard-coded copies: SF type, ink `#1D1D1F`, grey `#6e6e73`, hairline `rgba(0,0,0,0.08)`, separator `rgba(0,0,0,0.10)`, fill `rgba(120,120,128,0.12)`, quiet grey field `#F5F5F7`. Panels are opaque white with a hairline on the left. Cards are white, 12px radius, border transparent, box-shadow none — only `.card.filecard` keeps a hairline border, so a design file reads as a framed document. Scope plugin CSS to the plugin's own containers — the core prefixes panel and view containers with `data-plugin="<id>"`. Do not restyle core UI from a plugin, and do not add branding, ads or a second toolbar inside a panel.

## What is not in the API

- No menu bar contributions.
- No network access except through `fetchPreview`.
- No main-process plugins, no Node access, no direct filesystem or shell access.
- No plugin store, no paid plugins, no auto-update.
- No deactivate cleanup for event listeners. Handlers registered in `activate` stay registered after `deactivate`, so they must guard on missing panel, view or overlay elements.
- No sandboxing stronger than the contract above. A locally installed plugin runs in the renderer with the API object, and like any locally installed extension it must be trusted by the person who installed it.

## Bundled and first-party plugins

Plugins in `plugins/` ship inside the app and use exactly this API, no backdoors. See `plugins/README.md`. The built-in UI in `src/ui/` is built on the same API, loaded the same way, under a manifest with the same permissions — the only difference is loading. See `ARCHITECTURE.md`.
