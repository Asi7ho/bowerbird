# Bowerbird Plugin API — v1

Plugins extend Bowerbird. A plugin can contribute many things at once:
card kinds, tools, panels, a view that replaces the canvas, a card editor,
commands, drop handlers, and a settings section. A plugin can also
*transform* the canvas: a view mode takes over the main viewport, with a
core-owned way back to the 2D board that the plugin cannot remove.

This is v1. It is deliberately local and simple: no store, no accounts,
no auto-update. Installing a plugin is trusting its code, the way
installing an Obsidian or VS Code extension is. The API below is the
supported contract. A plugin that reaches past it into core DOM or
internals may break in a later version, and a later version may sandbox
plugins harder. Do not rely on anything not documented here.

## What a plugin is

A folder with at least:

```
my-plugin/
  manifest.json
  main.js
  style.css        (optional)
```

`manifest.json`:

```json
{
  "id": "hello-card",
  "name": "Hello Card",
  "version": "0.1.0",
  "apiVersion": "1",
  "description": "A sample card, tool, panel, command and view.",
  "permissions": ["board:write", "files:embed", "storage", "view:replace"],
  "main": "main.js",
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

- `id` must be unique, lowercase, letters/digits/`-` only. It names
  the plugin everywhere: in board JSON, in storage, in the UI.
- `apiVersion` is `"1"` for this API. A plugin that needs a newer
  API version is listed as incompatible and is not loaded.
- `permissions` gates the API object (below). A method that needs a
  permission the manifest did not declare throws, it does not silently
  succeed. `board:read` is always allowed. Everything else must be
  declared.
- `contributions` is a summary for the Settings → Plugins list and
  for the core to know what to expect. The code in `main.js` is what
  actually registers each contribution through the API. The two must
  agree; if they don't, the registered contributions win and the
  manifest list is just out of date in the UI.

`main.js` is a JavaScript module. It must export `activate(api)` and
may export `deactivate()`. It is loaded with a dynamic import from a
blob URL, so it is a single file with no relative imports in v1. It
may bundle its own libraries inside that one file (for example a
bundled Three.js build for a 3D view).

```js
export function activate(api) {
  api.cards.register({
    kind: "Hello",
    title: "Hello card",
    render: (item, data) => `<div class="hello"><strong>${escape(data.text)}</strong></div>`,
  });
  api.commands.register({
    id: "add-hello",
    title: "Add a hello card",
    run: () => api.board.addPluginCard("Hello", { text: "Hello!" }, { x: 100, y: 100 }, { w: 260, h: 96 }),
  });
}
```

## Where plugins live

- Bundled plugins (the 1st-party ones, when they exist) live in the
  app bundle's `plugins/` folder. They are listed in Settings as
  "Built in" and update with the app.
- User plugins live in the plugins folder next to the board data:
  `~/.local/share/bowerbird/plugins/` on Linux, the equivalent
  Application Support folder on macOS. Each plugin is a subfolder
  with a `manifest.json`.
- `BOWERBIRD_PLUGINS_DIR`, if set, replaces the user plugins folder
  with the folder it names. This is for development and testing.
- A plugin with the same id in two places is loaded once; the first
  place wins in the order env folder, user folder, bundled folder,
  and the duplicate is skipped (logged to the console, not toasted).

Enable/disable is per plugin, in Settings → Plugins. Disabling
unregisters its tools, panels, commands and views, removes its
buttons, and re-renders the board so its cards become placeholders
(see Board-safe below). Re-enabling re-runs `activate`.

## The API object

`activate(api)` receives one object, per plugin, filtered to the
manifest's permissions. `api.version` is `"1"`. `api.has(cap)`
reports whether a capability exists in this core version, so a
plugin can degrade gracefully instead of crashing on an older core.

### Board — `api.board`

- `get()` — a read-only snapshot of the board: items, camera, bg, grid.
  Do not mutate the snapshot; use the methods below.
- `getItems()` — the board's items, as plain data.
- `getItem(id)`, `getSelected()`, `setSelected(ids)`
- `renderCard(id)` — the board item's card HTML, rendered by the
  core exactly as it renders on the board: same markup, same
  classes, same size, at position 0,0, with no selection ring and
  no editing state, and with audio shown neutral (not playing).
  A plugin can already read the item via `getItems()`, so this
  needs no extra permission. Strokes and connectors return
  `null` (they are not cards). Use this to show a board card in
  a panel or view without re-rendering it a second, different
  way — the aspect ratio is the board item's width/height, not
  the file's natural ratio.
- `addItem(kind, pos, size)` — add a core card kind, e.g.
  `api.board.addItem({ Text: { text: "Hi", bold: false, size: 16, color: "#1A1A1A" } }, { x: 100, y: 100 }, { w: 260, h: 48 })`.
  Requires `board:write`.
- `addPluginCard(kind, data, pos, size)` — add one of this plugin's
  own card kinds. Requires `board:write`.
- `updateItem(id, patch)` — patch `pos`, `size`, `group`, or, for a
  plugin card of this plugin, `data`. Requires `board:write`.
- `removeItem(id)` — requires `board:write`.
- `save()` — save the board through the core's save path
  (write-then-rename, demo-mode no-op included). Requires
  `board:write`. Most board methods save automatically; call this
  after a batch of changes made without a method call.
- `render()` — re-render the board (for example after a plugin
  changed how a card should look).

Board methods validate their input and throw on bad ids, bad
positions, or a plugin trying to edit another plugin's card data.
A plugin may read any card, but it may only write its own plugin
cards, plus core kinds through `addItem`/`updateItem` for pos/size/
group. It may not rewrite another plugin's data.

There is no undo stack in v1, core or plugin. A plugin board change
saves immediately, like a core drag or note commit. Undo for plugin
actions is a future API addition, not something to fake with a
private stack.

### Window — `api.window`

Requires the `window` permission. These are the main-process
primitives a renderer plugin cannot do itself: hiding the window,
showing the peek icon, moving the window, and remembering the
corner for the peek. The Hide plugin is built on exactly these.

- `hide()` — hide the board window and show the peek icon at the
  stored corner. A no-op if the corner is `off` (the main process
  has no peek bounds then, so it does nothing).
- `show()` — destroy the peek icon and restore the board to its
  saved bounds, focused.
- `minimise()` — minimise the window through the OS.
- `move(dx, dy)` — move the window by a screen-coordinate delta,
  fire-and-forget. Screen coordinates, not client coordinates:
  client coordinates move when the window itself moves, which
  fed a move-back loop. The Hide plugin no longer uses this —
  the title bar is the window drag region now, via
  `-webkit-app-region: drag` — but the primitive stays for
  any plugin that needs to move the window itself.
- `getCorner()` / `setCorner(corner)` — read and write the stored
  corner (`bottom-left`, `bottom-right`, `top-left`, `top-right`,
  `off`). `setCorner` returns the stored value (validated by the
  main process), which is what the plugin should use, not the
  value it asked for. The corner lives in the app's settings file,
  not in plugin storage, because the peek icon (a main-process
  window) needs it even while the board window is hidden.

### View and camera — `api.view`

- `getCamera()`, `setCamera({ x, y, zoom })`
- `centreOn(itemId)` — move the camera like Tab does.
- `getView()` — `"board"` or a registered view id.
- `setView(id)` — switch views. `"board"` always exists and is
  always the way back. A plugin view cannot remove it, and the
  core draws the view switcher itself, so the exit control is
  never inside plugin code.
- `listViews()` — `[{ id, title, plugin }]`.

A view is registered with `api.ui.registerView({ id, title, render,
onShow, onHide })`. When the view is active, the core hides the
2D canvas layers (grid, strokes/connectors layer, cards) and shows
the view's container, which fills the board area. The toolbar,
search and Settings stay core-owned and stay reachable. The plugin's `render(container, board)` is called on
activation and whenever the board changes while the view is
active. The plugin must pause expensive work (WebGL, video) when
`onHide` fires; the core does not do that for it.

A view is a *view of the board*, not a separate app. A 3D view
shows the same board items in 3D, with extra per-item data (depth,
rotation) stored in that plugin's namespace, never overwriting the
2D position and size. Switching back to `"board"` must restore the
2D layout exactly. A view that needs its own separate scene should
store that scene as a plugin card's data, not as a replacement for
the board.

### UI — `api.ui`

- `toast(message)` — the core toast, 4 seconds, same style as core.
- `registerTool({ id, title, icon, onMouseDown, onMouseUp })` —
  adds a button to the toolbar's tool segment, after the core
  tools. `icon` is an SVG string (no `<script>`; the core rejects
  icons containing one). `onMouseDown(world, event)` is called
  instead of core tool handling when this tool is active and the
  user presses on the board. Tools in v1 are click tools, not
  drag tools: core drag state (pen strokes, connectors, marquee,
  move, resize) is not handed to plugins yet. A tool that needs
  dragging should be built as a card editor or a view for now.
  Requires the `ui:tools` permission (declared by listing the
  tool in the manifest; the permission name in the manifest is
  `board:write` for tools that write, plus the tool contribution
  itself).
- `registerPanel({ id, title, render })` — adds a panel to the
  right dock, full window height, so a panel's header sits at
  the title bar's level. The dock is core-owned: panels stack vertically,
  each with a core header (title + close button) and a body the
  plugin renders into. `render(container)` is called when the
  panel is created; the plugin should listen to `api.events` and
  update its own panel DOM from there. Panels are contextual by
  convention: show the panel's content only when it is relevant
  (for example a photo panel only when a photo is selected) by
  calling `showPanel`/`hidePanel`, or by rendering an empty state.
  The core does not guess relevance for a plugin.
- `showPanel(id)`, `hidePanel(id)`, `getPanelElement(id)`
- `registerCommand({ id, title, run })` — a command listed in
  Settings → Plugins under this plugin, with a Run button. There
  is no command palette in v1; commands are run from Settings,
  from a panel, or from a tool. A command's `run` may be async.
- `registerOverlay({ id, render })` — a full-board overlay layer
  that takes no clicks itself (pointer-events: none). Interactive
  elements a plugin puts inside it must set pointer-events: auto
  on themselves, so board clicks pass through everywhere except
  on the plugin's own controls. This is how a corner button can
  sit in a corner without blocking the board.
- `registerSettingsSection({ id, title, render })` — a section in
  the Settings → Plugin settings tab, rendered with its own heading
  when that tab is shown, and only for plugins that are on.
  Use it for plugin settings that are app-level, not board-level
  (for example the Hide plugin's corner picker). Board-level
  controls belong in a panel, not here.
- `registerShortcut({ key, title, run })` — a single-key shortcut,
  no modifiers, listed in Settings' shortcuts table with the
  plugin's name. Core keys win: the core checks its own shortcuts
  first, and a plugin shortcut is only tried for keys the core did
  not handle, with Ctrl/Cmd held keys excluded, so a plugin cannot
  steal Ctrl+G or similar. Shortcuts do not fire in a textarea,
  in the search box, while editing, or while Settings is open —
  the same guards as core shortcuts.
- `registerView({ id, title, render, onShow, onHide })` — see View
  above. Requires `view:replace` in permissions for any view that
  replaces the canvas; a view that only adds a read-only alternate
  layout still registers the same way, and the permission name
  is the same, because the core cannot tell the difference from
  the outside.

### Cards — `api.cards`

- `register({ kind, title, render, onDoubleClick, onAction, searchText })`
  - `render(item, data)` returns an HTML string for the card's inner
    content, where `data` is this card's plugin data (the same
    object stored in board JSON, so the plugin never has to dig
    through `item.kind.Plugin.data`). The core wraps it in the
    standard card chrome (position, size, selection ring). The
    plugin is responsible for escaping its own data in that HTML,
    the way core card rendering escapes note text.
  - `onDoubleClick(item, data)` is called on double-click of the
    card, instead of core double-click handling. Use it for a card
    editor: for example a photo card that opens an editing mode.
  - `onAction(action, item, data)` is called when an element inside
    the card with `data-plugin-action="..."` is clicked. The core
    routes the click by card id; the plugin does not attach its
    own global click listeners for card buttons.
  - `searchText(data)` returns searchable text for the card, or
    the core falls back to the plugin id, kind and JSON data.
- Card data is always JSON. Large files go in the board's `assets`
  folder by reference (see Files), never inline in JSON.

### Files — `api.files`

All file access goes through the core, never directly. Requires
`files:embed` for writes, `files:read` for reads (reads are the
same bridge the core uses for its own cards).

- `embedFile(path)` — copy a file into the board's `assets`
  folder and return its board-owned path, exactly like a dropped
  file. In demo mode it returns the original path and copies
  nothing, like core drops.
- `listLibrary()` — list a library folder, recursively (the
  bundled Visual Library no longer uses this: it shows board
  items, not a folder — see below):
  images and PDFs only, sorted by name, capped at 1000, each
  with `name`, `path`, `relativePath` (forward slashes, relative
  to the library), `ext`, `kind` (`image` or `pdf`), `category`
  and `size_bytes` and `mtime_ms`, plus the folder `path`
  itself, `categories` (immediate subfolders, each with a
  `name` and a file `count`, including empty folders) and
  `uncategorizedCount` (files in the library root). A category
  is an immediate subfolder: a file's category is the first
  segment of its path under the library, or `null` for files in
  the root. The folder is `board/library/` (temp folder in demo,
  so a demo never reads the real library). Listing is scoped to
  that one folder: a plugin never gets an arbitrary folder to
  list.
- `addToLibrary(path)` — copy a file into the library folder
  (deduplicated like `embedFile`, `stem-1` suffix on a name
  clash) and return its library path, or the path unchanged if
  it is already in the library. Requires `files:embed`.
- `createLibraryCategory(name)` — create a subfolder of the
  library folder and return its path. The name must be a single
  folder name (no `/`, `\` or `..`, not starting with `.`, at
  most 100 characters); `All` and `Uncategorized` are reserved
  because they are the virtual categories in the UI. Requires
  `files:embed`.
- `moveLibraryItem(relativePath, category)` — move a library
  file to another category (a subfolder, created if needed),
  or to the library root when `category` is `null`
  (Uncategorized). The source must already be inside the
  library, the destination stays inside it, and only library
  extensions move; a name clash at the destination is
  deduplicated (`stem-1`, `stem-2`, …) like `addToLibrary`.
  Returns the destination path, relative to the library.
  Requires `files:embed`.
- `fileUrl(path)` — the `app-file://` URL the renderer can use
  for an image, audio or video source.
- `readTextFile(path)`, `fileSize(path)`
- `openExternal(target)` — open a URL or a file outside the app,
  through the core's shell guard (http(s) URLs and local paths
  only, as core does).
- `fetchPreview(url)` — the core's link-preview fetch, with its
  timeout and http(s)-only resolution. A plugin must not fetch
  arbitrary URLs from the renderer itself; use this, or declare
  and justify a network need in a later API version.

### Storage — `api.storage`

Plugin-scoped settings, kept out of board JSON, in the app's
userData folder, one file per app, keyed by plugin id. Requires
the `storage` permission. `get(key)`, `set(key, value)`,
`delete(key)` are async. Values must be JSON. Do not store
secrets, tokens or passwords here; there is no encryption in v1,
and plugin storage is not a vault.

### Events — `api.events`

- `on(event, handler)`, `off(event, handler)`. Events in v1:
  `selection`, `board`, `view`. `board` fires after a board
  change that the core saved or rendered (a plugin's own board
  writes fire it too, after the write). Handlers must not write
  to the board synchronously inside a `board` handler in a way
  that loops; if a handler needs to react by writing, it should
  guard against its own last write (for example by comparing ids
  or by a flag), or the core will re-render in a loop that the
  plugin created. This is documented because it is easy to get
  wrong, not because the core will prevent it in v1.

### Errors and failure

A plugin that throws during `activate`, or whose module fails to
import, is recorded as failed, listed in Settings → Plugins with
its error, and does not stop other plugins or the board from
loading. A plugin that throws during a card render falls back to
the missing-plugin placeholder for that card, not a blank board.
A plugin that throws during a tool, command or panel render shows
a toast and is otherwise left running; repeated failures are the
plugin author's bug to fix, and disabling the plugin in Settings
is the user's escape hatch.

## Board-safe rules (testable guarantees)

1. **Uninstall is not delete.** Plugin card data is stored as
   `{ "Plugin": { "plugin": "<id>", "kind": "<kind>", "data": {...} } }`
   in board JSON. The core never strips a `Plugin` item it does
   not recognise, on load or on save. It is carried through
   verbatim.
2. **Open without the plugin is not lose.** A `Plugin` item whose
   plugin is missing or disabled renders as a placeholder card
   naming the plugin and kind, with the note that its data is
   kept. It can still be moved, grouped, connected and deleted
   like any other card. Deleting the placeholder deletes the
   data, the same as deleting any card — that is the user's
   choice, not an accident of opening the board.
3. **Views never overwrite 2D data.** A view's extra per-item
   data lives in that plugin's namespace, separate from `pos`
   and `size`. Returning to `"board"` restores the 2D layout.
4. **Edits are non-destructive where the plugin claims they are.**
   A photo plugin that edits an image must keep the original
   asset and store edits as plugin data on top of it, so the
   fallback (plugin missing) is the original, not a corrupted
   edit. A plugin that destructively overwrites an asset must
   say so in its description, and must not do it silently.
5. **Plugin storage is not board data.** Disabling or removing a
   plugin does not delete board items, and deleting a board does
   not delete plugin storage. They are separate on purpose.

## Styling

Plugin panels, tool buttons and card chrome follow Bowerbird's
design system: same frosted panels, same 12px card radius, same
typography and colours as core. A plugin's *content* — what it
draws inside its canvas, view or card — is its own: a 3D scene
looks like a 3D scene, a photo editor looks like a photo editor.
Do not restyle core UI from a plugin, do not add branding, ads
or a second toolbar inside a panel, and scope plugin CSS to the
plugin's own containers (the core prefixes panel and view
containers with `data-plugin="<id>"`; use that as your selector
root).

## Bundled plugins

Plugins in `plugins/` in this repo ship inside the app, are listed
in Settings → Plugins as "Built in", and update with the app.
They use exactly this API — no backdoors. The first one is `hide/`:
the corner button, the corner picker in Settings, and H to
minimise, moved out of the core into a plugin. The main process
still owns what a renderer plugin cannot do (hiding the window,
showing the peek icon, remembering the corner), and everything
the user sees lives in the plugin. The second is
`visual-library/`: two modes over the same board, with
the same board card in both — not a folder. The library is
the board's own elements: every card on the whiteboard
(text, images, links, PDFs, swatches, audio, video, plugin
cards; strokes and connectors are not cards and are not
shown), rendered by the core via `renderCard`, scaled
uniformly to its span width so the aspect ratio is
the board item's, unchanged — scaled down to fit, never up
beyond the board size. The grid is spanning masonry from
small columns: a small card (a swatch) spans one column,
every other card spans two (~250px), so two consecutive
swatches sit side by side, 16px apart, instead of a 120px
swatch centred in a 250px column leaving 149px between
them. The panel sections keep 15px of right padding as
the scrollbar's lane, so an overlay scrollbar never floats
over a card's right edge. Panel mode is a panel flush
against the right edge, full height, over the board, one
column, with search, click-to-duplicate at the camera centre
and drag-to-duplicate at the drop point. Whiteboard mode is
a view replacing the canvas, laid out like Pinterest, which
hides the panel while it is active and shows it again on the
way back to the board. There is one category,
Uncategorized, holding every board item in board order; no
categories are created for the user, by kind or otherwise,
and there is no New category control for now. A duplicate
is an ordinary board item of the same kind and the same size
as the original, so it appears in the library too, in
Uncategorized. There are no Refresh, Open folder,
folder-path or Add controls in the UI: the library
refreshes automatically when the board is saved, so no
manual refresh control exists. Panels in general
are now a flush sidebar in the core CSS (opaque white,
hairline left border, no frost or floating shadow), 290px
wide so a panel card is ~250px wide — the same size as a
whiteboard-view card, with the same 14px type and 16px gaps
— so a panel reads as part of the app, not an overlay card.
The library-folder methods above (`listLibrary`,
`addToLibrary`, `createLibraryCategory`,
`moveLibraryItem`) remain in the API for other plugins; the
bundled library does not use them, and a `board/library/`
folder from an earlier version is ignored, not deleted.
The third is `palette/`: a panel of curated colour
palettes, not a library of the board's own cards. Click a
colour to place a 120x120 swatch at the camera centre,
drag it to place it at the drop point, the same
interaction as Visual Library. Placed swatches are
ordinary board Swatch items, so they survive disabling
the plugin. Palettes are static and bundled in the plugin
file, with no network and no storage, and the plugin needs
only `board:write`.

## What is not in v1

- No drag tools (click tools only; see Tools above).
- No command palette, no menu bar contributions.
- No undo for plugin actions.
- No network access except through `fetchPreview`.
- No main-process plugins, no Node access, no direct filesystem
  or shell access.
- No plugin store, no paid plugins, no auto-update.
- No deactivate cleanup for event listeners: handlers registered in
  `activate` stay registered after `deactivate` in v1, so they must
  guard on missing panel/view/overlay elements (the sample plugin
  does; the Hide plugin's button listeners die with its removed
  overlay DOM).
  A future version will pass the API object to `deactivate` for
  cleanup.
- No sandboxing stronger than the contract above: a locally
  installed plugin runs in the renderer with the API object, and
  like any locally installed extension it must be trusted by the
  person who installed it. A future version may move plugin
  panels and views into isolated frames; v1 does not, and does
  not pretend otherwise.

## Sample plugin

`examples/plugins/hello-card/` in this repo is the smallest
plugin that uses the card, tool, panel, command and view
surfaces: a card kind, a tool, a panel, a command and a view.
Copy that folder into your plugins folder to try it, or copy
it as the starting point for a new plugin. It is an example,
not a bundled plugin, and it is not copied into packaged apps.
