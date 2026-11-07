# Bowerbird Plugin API — v1

Plugins extend Bowerbird. A plugin can add card kinds, tools, panels, a view that replaces the canvas, a card editor, commands, drop handlers and a settings section, all at once.

This is v1. It is local and simple: no store, no accounts, no auto-update. Installing a plugin is trusting its code, the way installing an Obsidian or VS Code extension is. The API below is the supported contract. A plugin that reaches past it into core DOM or internals may break in a later version.

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
  "apiVersion": "2",
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

- `id` is unique, lowercase, letters, digits and `-` only. It names the plugin in board JSON, in storage and in the UI.
- `apiVersion` is `"2"`. A plugin that needs a newer API is listed as incompatible and is not loaded. Version 2 is the plugin-built core: the settings window, cards, toolbar, title bar, search box and board DOM are all first-party plugins on this API, and a user plugin can be multiple files with relative imports (loaded over the `plugin:` scheme). A plugin written for API 1 does not load on API 2; update its `apiVersion` and re-test.
- `permissions` gates the API object. A method that needs a permission the manifest did not declare throws. `board:read` is always allowed. Everything else must be declared.
- `contributions` is a summary for Settings. The code in `main.js` is what actually registers each contribution. If the two disagree, the registered contributions win.

`main.js` is a JavaScript module. It must export `activate(api)` and may export `deactivate()`. It is loaded as an ES module over the `plugin:` scheme (`plugin://<plugin-id>/main.js`), so it may be multiple files: a relative import in `main.js` resolves against the plugin's own folder, exactly like a first-party plugin. Only `.js`, `.css` and `.json` files are served, and only from the plugin's own folder. A single-file plugin is the special case; libraries may also be bundled inside one file.

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

Plugins are loaded once, first place wins, in this order:

1. The folder named by `BOWERBIRD_PLUGINS_DIR`, if set. This is for development and testing.
2. The user plugins folder next to the board data: `~/.local/share/bowerbird/plugins/` on Linux, the equivalent Application Support folder on macOS.
3. The bundled `plugins/` folder in the app.

Bundled plugins are listed in Settings as "Built in" and update with the app. A duplicate id in a later folder is skipped, not loaded twice.

Enable and disable are per plugin, in Settings → Plugins. Disabling unregisters its tools, panels, commands and views, and re-renders the board so its cards become placeholders (see Board-safe below). Re-enabling re-runs `activate`.

## The API object

`activate(api)` receives one object, per plugin, filtered to the manifest's permissions. `api.version` is `"2"`. `api.has(cap)` reports whether a capability exists in this core version, so a plugin can degrade gracefully on an older core.

### Board — `api.board`

- `get()` — a read-only snapshot of the board: items, camera, bg, grid. Do not mutate it. Use the methods below.
- `getItems()`, `getItem(id)`, `getSelected()`, `setSelected(ids)`
- `renderCard(id)` — the item's card HTML, rendered by the core exactly as on the board: same markup, same classes, same size, at position 0,0, with no selection ring and audio shown neutral. No extra permission is needed, since a plugin can already read the item. Strokes and connectors return `null`.
- `hitTest({ x, y })` — the top item id at a world point, or `null`. A frame is a container, not content: a card inside a frame wins over the frame itself, so cards inside a slide can be grabbed, moved and edited once framed. Only if nothing else covers the point does the frame itself win. The board view uses this for clicks, drags and cursor hints.
- `addItem(kind, pos, size)` — add a core card kind. Requires `board:write`.
- `addPluginCard(kind, data, pos, size)` — add one of this plugin's own card kinds. Requires `board:write`.
- `updateItem(id, patch)` — patch `pos`, `size`, `group`, or, for a plugin card of this plugin, `data`. Requires `board:write`.
- `updateItems(patches)` — apply several `updateItem` patches at once, with one save at the end, so the whole batch is one undo step. Requires `board:write`. The Tidy Up plugin uses this: aligning five cards with `updateItem` would take five undos to undo.
- `removeItem(id)` — requires `board:write`.
- `groupSelected()`, `ungroupSelected()`, `deleteSelected()` — group, ungroup or delete the current selection, exactly as Ctrl+G, Ctrl+U and Delete do, including group ids from `board.next_group`. Requires `board:write`. Returns false when there is nothing to do.
- `undo()`, `redo()` — undo or redo one step, exactly as Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z do. Requires `board:write`. Returns false when there is nothing to undo or redo. `canUndo()`, `canRedo()` need no permission.
- `moveItem(id, toIndex)` — move an item to a position in board order, which is also paint order and, for frames, slide order. Requires `board:write`. Returns false when the item does not exist. It saves like any board change, so it is undoable.
- `save()` — save through the core's save path, including the demo-mode no-op. Most board methods save automatically. Call this after a batch of changes made without a method call. Requires `board:write`.
- `render()` — re-render the board.
- `setCanvas({ bg, grid })` — set the board's background colour and/or grid (`"Dots"`, `"Lines"` or `"Off"`). A board-level write, so it requires `board:write`. This is how the Settings plugin's canvas options work.
- `setNoteBackground(ids, hex)` — set the background colour of the given text notes, in one save (one undo step). The toolbar's note-colour flyout. A board write. Only Text notes are affected; other kinds are ignored.
- `reset()` — reset the board to a fresh welcome board, exactly as Settings → Data → Delete all board data does. Requires `board:write`. Not available to a trial plugin.
- `getDir()` — the board's folder on disk, for display. Read-only, no permission needed.

Board methods validate their input and throw on bad ids, bad positions, or a plugin trying to edit another plugin's card data. A plugin may read any card, but may only write its own plugin cards, plus core kinds for position, size and group.

Undo is snapshots, not operations: every save compares the board content with the last saved content, and a change becomes one undo step, up to 50 steps. A plugin board change saves immediately, like a core drag or note commit, so it is undoable too. Panning and zooming never create a step, and undoing never moves the view. `api.board.undo()`, `redo()`, `canUndo()` and `canRedo()` run undo from a plugin; undo and redo need `board:write`.

### Boards — `api.boards`

Multi-board is a plugin, not core UI: the core owns one board at a time, and this domain is how a plugin lists and switches boards. Switching saves the current board, loads the new one, and swaps in that board's own undo stack, search and context index, which are all per-board — creating or switching boards never wipes another board's undo. All methods except `list` and `current` need `board:write`.

- `list()` — `[{ name, current, items }]`, Main first, then other boards by name. Main is the default board; other boards live in their own folders under the base folder's `boards/`, each with its own assets and backups.
- `current()` — the current board's name.
- `create(name)` — create an empty board. Names are 1–64 characters; Main is reserved and cannot be created, renamed or deleted.
- `switch(name, preserveUndo?)` — switch to a board, returning true on success. `preserveUndo` is for a rename followed by a switch to the new name, where the board is the same board in a new folder, so its undo stack is kept instead of swapped. The current board name is stored in app settings, so the last board survives the Boards plugin being turned off.
- `rename(oldName, newName)` — rename a board's folder and display name.
- `delete(name)` — delete a board's folder, including its assets and backups, after the plugin's own confirmation. It refuses the current board: switch to another board first, then delete, or the renderer would be left on a deleted folder.

### App — `api.app`

Read-only information about the app itself. No permission needed.

- `getBuildId()` — the build id for this run (a git short hash in a packaged build, `"dev"` from source). The feedback message carries it so a report can be matched to the exact build.
- `getPlatform()` — the OS platform string (`"darwin"`, `"win32"`, `"linux"`).
- `isDemo()` — whether the app is running in demo mode (a fresh welcome board, nothing saved).

### Backups — `api.backups`

- `list()` — the board's backups, newest first: `[{ name, items, size }]`. Read-only, no permission needed. In demo mode the list is empty.
- `restore(name)` — restore a backup, loading its board into the app, like `boards.switch`. Requires `board:write`. Not available to a trial plugin. Returns true on success.

### Window — `api.window`

Requires the `window` permission. These are main-process primitives a renderer plugin cannot do itself. The Hide plugin is built on exactly these.

- `hide()` — hide the board window and show the peek icon at the stored corner. A no-op if the corner is `off`.
- `show()` — destroy the peek icon and restore the board to its saved bounds, focused.
- `minimise()` — minimise the window through the OS.
- `close()` — close the window. Close quits the app (the old Settings Quit button did exactly this: commit, save, then quit, which destroys the peek window too).
- `fullscreen()` — toggle full screen (macOS) and return the new state. `maximise()` — toggle maximise (Windows and Linux) and return the new state.
- `getWindowState()` — `{ maximised, fullscreen }`, so a title bar can show the right icon (enter/exit full screen, maximise/restore).
- `move(dx, dy)` — move the window by a screen-coordinate delta, fire-and-forget. The Hide plugin no longer uses this: the title bar is the window drag region now.
- `getCorner()` / `setCorner(corner)` — read and write the stored corner: `bottom-left`, `bottom-right`, `top-left`, `top-right`, `off`. `setCorner` returns the stored value, validated by the main process. Use that, not the value you asked for. The corner lives in the app's settings file, not in plugin storage, because the peek icon needs it while the board window is hidden.

### View and camera — `api.view`

- `getCamera()`, `setCamera({ x, y, zoom })`
- `zoomBy(factor)` — zoom around the board centre, by a factor (1.2 in, 1/1.2 out). The toolbar's zoom buttons. The core owns the camera math; a UI plugin just says "zoom in" or "zoom out".
- `centreOn(itemId)` — move the camera like Tab does.
- `getView()` — `"board"` or a registered view id.
- `setView(id)` — switch views. `"board"` always exists and is always the way back. A plugin view cannot remove it, and the core draws the view switcher itself, so the exit control is never inside plugin code.
- `listViews()` — `[{ id, title, plugin }]`.

A view is registered with `api.ui.registerView({ id, title, render, onShow, onHide })`. When the view is active, the core hides the 2D canvas layers and shows the view's container, which fills the board area. The toolbar and search stay reachable. `render(container, board)` is called on activation and whenever the board changes while the view is active. Pause expensive work (WebGL, video) when `onHide` fires. The core does not do that for you.

A view is a view of the board, not a separate app. Extra per-item data (depth, rotation) lives in that plugin's namespace, never overwriting the 2D position and size. Switching back to `"board"` must restore the 2D layout exactly. A view that needs its own separate scene should store that scene as a plugin card's data, not as a replacement for the board.

### Shapes — `api.shapes`

- `list()` — the shape table: `[{ kind, label, key, svg }]`, for the shape picker's flyout. Read-only UI data, no permission needed. The toolbar plugin builds the flyout from this.

### UI — `api.ui`

- `toast(message)` — the core toast, 4 seconds, same style as core.
- `registerTool({ id, title, icon, onMouseDown, onMouseUp })` — adds a button to the toolbar's tool segment, after the core tools. `icon` is an SVG string. The core rejects icons containing `<script>`. Tools in v1 are click tools, not drag tools: core drag state (pen strokes, connectors, marquee, move, resize) is not handed to plugins. A tool that needs dragging should be built as a card editor or a view for now. Tools that write need `board:write`.
- `registerPanel({ id, title, icon, render })` — adds a panel to the right dock, full window height, as a mini tab in the dock's tab bar. The dock is core-owned: one panel is shown at a time, switched by its tab. There is no per-panel header. Tabs are icons only: `icon` is an SVG string, shown at 20px in a 32px tab. The title stays as the tab's tooltip and aria-label. A panel with no icon falls back to its title text in the tab. A close button in the tab bar hides the whole dock, and a panels toggle in the title bar shows it again with its tabs and active panel intact. `render(container)` is called when the panel is created. Listen to `api.events` and update your own panel DOM from there. Panels are contextual by convention: show content only when it is relevant, by calling `showPanel` / `hidePanel`, or by rendering an empty state. The core does not guess relevance for you.
- `showPanel(id)`, `hidePanel(id)`, `getPanelElement(id)` — showing a panel also activates its tab. Hiding the active panel switches to another shown panel.
- `registerCommand({ id, title, run })` — a command listed in Settings → Plugins under this plugin, with a Run button. Commands are run from Settings, from a panel, from a tool, or from the Command Palette plugin. `run` may be async.
- `listCommands()` — every registered command: `[{ pluginId, pluginName, id, title }]`. `runCommand(pluginId, id)` runs one. Commands are user actions, not code: listing and running them is what Settings' Run buttons already do, so these need no permission, and a command still runs with its own plugin's API object.
- `listTools()` — every registered plugin tool: `[{ pluginId, pluginName, id, title }]`, where `id` is the tool id `setTool` accepts. Core tools (Select, Pen, Arrow) are not plugin tools, so they are not listed; their ids are `"select"`, `"pen"` and `"connector"`.
- `setTool(id)` — activate a core or plugin tool, as if its toolbar button was clicked.
- `getTool()` — the current tool id (`"select"`, `"pen"`, `"connector"`, a shape kind, or a plugin tool's full id). The toolbar plugin highlights the active tool from this. Changing the tool fires a `"tool"` plugin event.
- `setToolbarToolsEl(el)` — hand the plugin system the toolbar's tool container (the `#tools` segment), so plugin tool buttons can be added to it. The toolbar plugin provides this; other plugins do not call it.
- `setPanelsToggleEl(el)` — hand the plugin system the panels toggle button, so the plugin system can hide it when no plugin panels exist and mark it active when a panel is open. The title bar plugin provides this; other plugins do not call it.
- `setBoardElements({ board, canvas, pluginView, overlays, viewSwitcher, toast })` — hand the plugin system the board DOM elements, built by the core-board plugin. The core reads them back through the shell; it does not query them by id. The board plugin provides these; other plugins do not call it.
- `setSearchBoxEl(el)` / `getSearchBoxEl()` — hand the plugin system the search box container, and read it back. The title bar plugin provides the container; the search plugin mounts its input, count, clear button and results into it. `getSearchBoxEl()` returns `null` until the title bar plugin has activated.
- `openSettings()`, `closeSettings()`, `isSettingsOpen()` — open, close, and check Settings.
- `registerOverlay({ id, render })` — a full-board overlay layer that takes no clicks itself (pointer-events: none). Interactive elements inside it must set pointer-events: auto on themselves, so board clicks pass through everywhere except on your own controls. This is how a corner button can sit in a corner without blocking the board.
- `registerSettingsSection({ id, title, render })` — a section in Settings → Plugin settings, rendered with its own heading when that tab is shown, and only for plugins that are on. Use it for app-level settings, like the Hide plugin's corner picker. Board-level controls belong in a panel, not here.
- `renderSettingsSections()` — re-render every registered settings section into the settings container. A settings UI calls this after a plugin is enabled or disabled, so the sections match the plugins that are on.
- `boardEl` — the board area element: the mount point for board overlays. A UI plugin appends its overlay DOM here (the Settings window is one). A plugin never queries core DOM by id; the API hands it this mount point instead.
- `setSettingsSectionsContainer(el)` — hand the plugin system the container that plugin settings sections render into. The Settings plugin provides this; other plugins do not call it.
- `registerSettingsUI({ open, close, isOpen, setTab, refresh })` — register a plugin as the settings UI, so the core can open, close and refresh it without knowing which plugin provides it. Only the Settings plugin calls this. `refresh()` re-renders the settings window's canvas options and meta to match the current board (after an undo, for example).
- `listShortcuts()` — every shortcut a plugin registered: `[{ pluginId, pluginName, key, title }]`, so a settings UI can list them alongside the core's.
- `registerShortcut({ key, title, run })` — a single-key shortcut, no modifiers, listed in Settings' shortcuts table with the plugin's name. Core keys win: the core checks its own shortcuts first, and a plugin shortcut is only tried for keys the core did not handle, with Ctrl/Cmd held keys excluded, so a plugin cannot steal Ctrl+G. Shortcuts do not fire in a textarea, in the search box, while editing, or while Settings is open. A plugin that needs a modifier shortcut listens for it itself, in the capture phase, as the Command Palette does for Cmd/Ctrl+K, and must remove that listener in `deactivate`.
- `registerView({ id, title, render, onShow, onHide })` — see View above. Requires `view:replace`.

### Cards — `api.cards`

`register({ kind, title, render, onDoubleClick, onAction, searchText })`

- `render(item, data)` returns an HTML string for the card's inner content, where `data` is this card's plugin data, the same object stored in board JSON. The core wraps it in the standard card chrome (position, size, selection ring). The plugin is responsible for escaping its own data in that HTML, the way core card rendering escapes note text.
- `onDoubleClick(item, data)` is called on double-click of the card, instead of core double-click handling. Use it for a card editor.
- `onAction(action, item, data)` is called when an element inside the card with `data-plugin-action="..."` is clicked. The core routes the click by card id. Do not attach your own global click listeners for card buttons.
- `searchText(data)` returns searchable text for the card. Without it, the core falls back to the plugin id, kind and JSON data.

`registerBuiltin({ kind, title, render, onDoubleClick, onAction, searchText })` registers a renderer for a *built-in* card kind (`Text`, `Image`, `Swatch`, `UrlCard`, `PdfCard`, `Audio`, `Video`, `Shape`). `render(item, data, plain)` receives the full item and the kind's payload (for Text, `{ text, size, color, bg }`), and returns the complete card HTML — outer div, position, size, selection ring and all — exactly as the core's renderer did. `plain` is true when the card is rendered for a slide, the library or an export, where a live preview (PDF page, playing audio) cannot survive as HTML, so the renderer stays a tile. This is how the core-cards plugin provides the built-in kinds; a user plugin could replace one by registering the same kind name.

Card data is always JSON. Large files go in the board's `assets` folder by reference (see Files), never inline in JSON.

### Files — `api.files`

All file access goes through the core, never directly. Writes need `files:embed`, reads need `files:read`.

- `embedFile(path)` — copy a file into the board's `assets` folder and return its board-owned path, exactly like a dropped file. In demo mode it returns the original path and copies nothing, like core drops.
- `listLibrary()` — list the library folder, recursively: images and PDFs only, sorted by name, capped at 1000, each with `name`, `path`, `relativePath` (forward slashes, relative to the library), `ext`, `kind` (`image` or `pdf`), `category` and `size_bytes` and `mtime_ms`, plus the folder `path`, `categories` (immediate subfolders, each with a `name` and a file `count`, including empty folders) and `uncategorizedCount` (files in the library root). A category is an immediate subfolder: a file's category is the first segment of its path under the library, or `null` for files in the root. The folder is `board/library/` (a temp folder in demo, so a demo never reads the real library). Listing is scoped to that one folder. A plugin never gets an arbitrary folder to list. The bundled Visual Library no longer uses this: it shows board items, not a folder.
- `addToLibrary(path)` — copy a file into the library folder (deduplicated like `embedFile`, `stem-1` suffix on a name clash) and return its library path, or the path unchanged if it is already in the library. Requires `files:embed`.
- `createLibraryCategory(name)` — create a subfolder of the library folder and return its path. The name must be a single folder name: no `/`, `\` or `..`, not starting with `.`, at most 100 characters. `All` and `Uncategorized` are reserved. Requires `files:embed`.
- `moveLibraryItem(relativePath, category)` — move a library file to another category (a subfolder, created if needed), or to the library root when `category` is `null`. The source must already be inside the library, the destination stays inside it, and only library extensions move. A name clash at the destination is deduplicated like `addToLibrary`. Returns the destination path, relative to the library. Requires `files:embed`.
- `fileUrl(path)` — the `app-file://` URL the renderer can use for an image, audio or video source.
- `readTextFile(path)`, `fileSize(path)`
- `openExternal(target)` — open a URL or a file outside the app, through the core's guard: https URLs in the browser, board-local files in their system app, anything else refused.
- `fetchPreview(url)` — the core's link-preview fetch, with its timeout and public http(s)-only rule. A plugin must not fetch arbitrary URLs from the renderer itself.

### Storage — `api.storage`

Plugin-scoped settings, kept out of board JSON, in the app's userData folder, one file per app, keyed by plugin id. Requires the `storage` permission. `get(key)`, `set(key, value)`, `delete(key)` are async. Values must be JSON. Do not store secrets, tokens or passwords here. There is no encryption in v1, and plugin storage is not a vault.

### Secure storage — `api.secureStorage`

For secrets, which survive restarts like storage but are not plain text on disk. Requires the same `storage` permission, and is scoped to the plugin id, like storage. `available()` reports whether the OS can encrypt (macOS always can, via the Keychain); `get(key)`, `set(key, value)`, `delete(key)` are async, values are strings. Where the OS can encrypt, `set` stores the value encrypted by the OS keychain; where it cannot, the value is still stored, but the plugin must say so plainly in its UI instead of pretending it is encrypted. Secure values live in their own file, so a plain storage read can never return a secret by accident.

### Installing plugins — `api.plugins`

Adding this domain did not change `apiVersion` at the time: additive additions do not break existing plugins. The API is `"2"` now, because the core UI itself became plugins (see above).

- `list()` — every loaded plugin with its state: `[{ id, name, version, description, active, failed, error, trial }]`. Read-only, no permission needed. This is how a settings UI shows the plugin list.
- `setEnabled(id, enabled)` — enable or disable a plugin. Requires the `plugins:install` permission, like install. A trial plugin cannot be toggled this way.
- `plugins.install({ id, name, description, permissions, mainCode, styleCode })` — write a plugin to the user plugins folder, never the bundled folder, and never over an existing plugin with the same id. Requires the `plugins:install` permission. Blocked in demo mode. The manifest is built by the core, with `apiVersion "2"` and `version "1.0.0"`.
- `plugins.refresh()` — re-scan for plugins installed since startup, and activate any new ones that are enabled, with no restart. Requires the `plugins:install` permission.
- `plugins.try({ id, name, description, permissions, mainCode, styleCode })` — activate a plugin in memory only, without writing anything to disk, so it can be tried before it is installed. Requires the `plugins:install` permission. A trial plugin runs with the same permission checks as an installed plugin, but it cannot install other plugins, and it cannot create, rename, switch or delete boards — those calls throw while it is being tried. Board writes it does make are undoable, like any board write. Its own storage writes, if it has the `storage` permission, are scoped by its id and inert once the trial ends, because no plugin with that id exists to read them again.
- `plugins.endTrial(id)` — deactivate a trial plugin and remove it completely. Requires the `plugins:install` permission. Ending a trial (or quitting the app) leaves nothing behind: a trial plugin is never on disk, so there is nothing to uninstall. A trial is a reversibility trial, not a code sandbox: the plugin still runs in the renderer, like any plugin, so this must not be presented to a user as a security sandbox. Settings shows a trial plugin as "Trying", with no toggle.

### Events — `api.events`

`on(event, handler)`, `off(event, handler)`. Events in v1: `selection`, `board`, `view`, `pen`, `tool`. `board` fires after a board change that the core saved or rendered. A plugin's own board writes fire it too, after the write. Do not write to the board synchronously inside a `board` handler in a way that loops. If a handler needs to react by writing, guard against your own last write, for example by comparing ids or by a flag. The core will not prevent a loop you create in v1. `tool` fires when the active tool changes (via `setTool`, a toolbar button or a keyboard shortcut), so a toolbar plugin can highlight the active tool and show the right flyout without polling.

### Pen — `api.pen`

The pen's colour, shared with the toolbar's pen swatches. No permission is needed, like `setTool`: it is a tool setting, not a board mutation. `getColor()` returns the current colour as a hex string. `setColor(hex)` sets it (a 6-digit hex only, anything else is ignored and returns false) and fires a `pen` event, so a listening plugin can follow it. Pen colour is session state, not saved in board JSON. Palette uses this: picking a colour there sets the pen, and picking a toolbar swatch updates Palette back.

### Media — `api.media`

Media state, for the cards that play or preview media (PdfCard, Audio). Read-only views of the core's media module, plus the triggers that load a PDF page or an audio duration on demand. No permission needed: these read and trigger loads for board files the plugin can already see. The raw audio element is never exposed; `getAudioState` returns the derived playback state.

- `audioFailed(path)` — whether the audio file failed to load.
- `getAudioState()` — `{ id, playing, currentTime, duration }` for the audio currently loaded in the player, or `{ id: null, playing: false, currentTime: 0, duration: 0 }`.
- `getAudioDuration(path)` — the cached duration in seconds, or `undefined`.
- `loadAudioDuration(id, path)` — trigger loading the duration for a card.
- `formatAudioTime(sec)` — seconds as `m:ss` (or `0:00` for an unknown duration).
- `pdfFailed(path)` — whether the PDF failed to load.
- `getPdfPage(id)` — the current page number for a PDF card (1 when unset).
- `loadPdfPage(id, path)` — trigger loading a PDF page for a card.

### Text — `api.text`

Pure text and colour helpers, from `src/model.ts`. No permission needed. A card renderer needs these to escape text, render markdown, and colour link tiles, the way the core's renderers did. One implementation, so a plugin's cards match the core's exactly.

- `escapeHtml(s)`, `renderMarkdownHtml(text, baseSize)`, `domainOf(url)`, `elide(s, widthPx, textPx, bold)`, `tileColorFor(domain)`, `tint(hex, whiteMix)`.

### Geometry — `api.geometry`

Pure geometry, from the core's `src/model.ts`. No permission is needed, because these read nothing and write nothing. They take points and rectangles and return points and booleans. Use them instead of copying the math into a plugin.

Adding this domain did not change `apiVersion` at the time: additive additions do not break existing plugins. The API is `"2"` now, because the core UI itself became plugins (see above).

- `centre(item)` — the centre of a card's rect.
- `anchorPoint(anchor)` — a connector endpoint: a raw point, or the centre of the item it points to, or `null` if that item is gone.
- `rectCrossing(from, to, pos, w, h, entry)` — where a segment crosses a rectangle, entry (first) or exit (second), or `null` if it does not cross.
- `clippedEnds(from, to)` — a connector's ends, clipped to the cards it joins, or `null` if an endpoint is gone.
- `segmentIntersectsRect(a, b, rect)` — whether a segment enters a rectangle at all, however briefly.
- `itemRotation(item)` — the item's rotation in radians, as used by the resize handle. A card renderer draws its content at this rotation.

### Search — `api.search`

The search engine (MiniSearch + local context search: CLIP for images and video, AST labels for audio). The engine owns the matching, the dimming and the results; the core-search plugin builds the box and hands the engine its elements. No permission needed: searching is a read, and jumping only moves the camera and the selection.

- `setElements({ input, count, clear, results })` — hand the engine the search box elements, built by the search plugin. Attaches the input and keyboard listeners. Until this is called, the search engine has no box to operate on.
- `update()` — re-run the search for the current input value, as after a board change.
- `clear()` — clear the search.
- `jumpTo(idx)` — jump to a match by index.
- `rectsOverlap(a, b)` — strict rect overlap. Touching an edge, with no area inside, does not count.
- `itemRotation(item)` — an item's rotation in degrees (0 when it has none).

### Errors and failure

A plugin that throws during `activate`, or whose module fails to import, is recorded as failed, listed in Settings → Plugins with its error, and does not stop other plugins or the board from loading. A plugin that throws during a card render falls back to the missing-plugin placeholder for that card, not a blank board. A plugin that throws during a tool, command or panel render shows a toast and is otherwise left running. Disabling the plugin in Settings is the user's escape hatch.

## Board-safe rules

1. **Uninstall is not delete.** Plugin card data is stored as `{ "Plugin": { "plugin": "<id>", "kind": "<kind>", "data": {...} } }` in board JSON. The core never strips a `Plugin` item it does not recognise, on load or on save. It is carried through verbatim.
2. **Open without the plugin is not lose.** A `Plugin` item whose plugin is missing or disabled renders as a placeholder card naming the plugin and kind, with the note that its data is kept. It can still be moved, grouped, connected and deleted like any other card. Deleting the placeholder deletes the data, the same as deleting any card.
3. **Views never overwrite 2D data.** A view's extra per-item data lives in that plugin's namespace, separate from `pos` and `size`. Returning to `"board"` restores the 2D layout.
4. **Edits are non-destructive where the plugin claims they are.** A plugin that edits an image must keep the original asset and store edits as plugin data on top of it, so the fallback (plugin missing) is the original, not a corrupted edit. A plugin that destructively overwrites an asset must say so in its description, and must not do it silently.
5. **Plugin storage is not board data.** Disabling or removing a plugin does not delete board items, and deleting a board does not delete plugin storage. They are separate on purpose.

## Styling

Plugin panels, tool buttons and card chrome follow Bowerbird's design system, using the core tokens, not hard-coded copies: SF type, ink `#1D1D1F`, grey `#86868B`, hairline `rgba(0,0,0,0.08)`, separator `rgba(0,0,0,0.10)`, fill `rgba(120,120,128,0.12)`, quiet grey field `#F5F5F7`, and the core shadows.

Panels are opaque white, hairline on the left, no frost or floating shadow. The tab bar is 48px, with a hairline underneath and a hairline on the left. Its tabs are a segmented control: fill-grey pill, 32px icon tabs, active tab white with the segmented active shadow. A panel body is the core panel body (13px/1.5).

A full-board view is a different surface. It uses the core view type (14px/1.6, padding 24px) with a document title (17px/700), not the tab bar forced to match it.

Cards are white, 12px radius, hairline border, soft shadow. Search fields are quiet grey fields with no border, icon buttons are borderless with a 9px radius, text buttons are bordered white with a 9px radius, and small circular controls are white with a hairline border and a soft shadow.

Same surface, same style: a panel in one plugin looks like a panel in another. A plugin's content, what it draws inside its canvas, view or card, is its own: a 3D scene looks like a 3D scene, a photo editor looks like a photo editor. Do not restyle core UI from a plugin, do not add branding, ads or a second toolbar inside a panel, and scope plugin CSS to the plugin's own containers. The core prefixes panel and view containers with `data-plugin="<id>"`. Use that as your selector root.

## Bundled plugins

Plugins in `plugins/` ship inside the app, are listed in Settings as "Built in", and update with the app. They use exactly this API, no backdoors. See `plugins/README.md` for detail.

- `hide/` — the corner button, the corner picker in Settings, and H to minimise. The main process still owns what a renderer plugin cannot do: hiding the window, showing the peek icon, remembering the corner.
- `visual-library/` — the library is the board. Every board card except strokes and connectors, in board order, under a single Uncategorized section. Click duplicates at the camera centre, drag duplicates at the drop point. A view shows the same cards as a masonry board, and hides the panel while it is active.
- `palette/` — a colour wheel panel. Pick a colour and five palettes are made from it live: Monochromatic, Analogous, Complementary, Split complementary, Triadic, five colours each. Click a colour, or the preview swatch, to place a 120x120 swatch at the camera centre. Drag to place it at the drop point. Placed swatches are ordinary board Swatch items, so they survive disabling the plugin. Needs only `board:write`.
- `presentation/` — slides are frames on the board. Draw a rectangle around cards to make a slide, then play it. The panel lists slides in frame creation order, with Play and Draw a slide at the top, per-slide Play and Delete, and Export pinned to the very bottom, below a scrolling slide list. Double-clicking a frame on the board plays from that slide. Export downloads all slides, in order, as a single HTML file that shows one slide at a time, with arrows and a counter: images, audio and video are embedded, links become real links, and print CSS gives one slide per page. Playing shows a frame's area, scaled to fit, cropped to the frame: every card that overlaps it at all, every pen stroke and connector segment that enters it, drawing under cards. Video and audio play in place, a link opens outside, other clicks do nothing. Needs `board:write`, `view:replace` and `files:read`.
- `command-palette/` — Cmd or Ctrl + K opens one place to run anything: plugin commands, jumping to a board card, switching views, picking a tool, and core actions like zoom, group, ungroup, delete, Settings, minimise and hide. Type to search, Arrow keys to move, Enter to run, Esc to close. Needs `board:write` and `window`.
- `boards/` — multiple boards, as a panel: click a board to open it, click the current board's name to rename it inline, × to delete it (with confirmation), and a name field plus New board to create one and open it at once. Needs `board:write`.
- `tidy-up/` — align and distribute the selected cards, from a panel: six align actions (to an edge or the centre of the selection) and two distribute actions (even spacing, first and last cards fixed). Needs 2 or more selected cards to align, 3 or more to distribute. Cards only. Needs `board:write`.

## First-party plugins (the core UI is plugins too)

The core is headless: it owns the board model, persistence, the plugin host and this API, and it renders nothing. Every visible thing is a plugin built on this API — including the built-in UI. The built-in UI plugins live in `src/core-plugins/`, are ES modules bundled with the app, and are loaded with `activateFirstPartyPlugin` at boot, before user plugins. They get the same `PluginContext`, the same permission checks and the same manifest as a user plugin. The only difference is loading: a user plugin is an ES module loaded over the `plugin:` scheme; a first-party plugin is an ES module imported by the core. Either way it can be multiple files with relative imports. A first-party plugin has no back door: if it needs something, that something is in this API. See `ARCHITECTURE.md` for the full design and the migration order.

- `core-settings/` — the Settings window (General, Plugins, Plugin settings). It builds its own DOM, registers itself as the settings UI (`api.ui.registerSettingsUI`), and hands the plugin system the container its settings sections render into (`api.ui.setSettingsSectionsContainer`). It uses `api.board` (canvas, reset, folder), `api.app`, `api.backups` and `api.plugins` (list, enable/disable). It is the reference implementation for a UI plugin: a plugin that replaces a piece of the built-in UI is built the same way.
- `core-cards/` — the built-in card kinds (Text, Image, Swatch, UrlCard, PdfCard, Audio, Video, Shape). It registers a renderer for each kind through `api.cards.registerBuiltin`, using `api.board` (selection), `api.media` (PDF and audio state), `api.files` (file URLs) and `api.text` / `api.geometry` (the pure helpers). The core renders no card itself; it only wraps the plugin's HTML in the card chrome.
- `core-toolbar/` — the toolbar (tools, pen palette, shape picker, note colours, zoom, delete, settings). It builds the toolbar DOM, hands the plugin system the `#tools` segment (`api.ui.setToolbarToolsEl`) so plugin tool buttons land beside the core tools, and follows the tool, the selection and the pen colour through the `"tool"`, `"selection"` and `"pen"` events. It uses `api.ui` (setTool, getTool, openSettings, closeSettings, isSettingsOpen), `api.view` (zoomBy), `api.pen` (colour), `api.shapes` (the shape picker) and `api.board` (selection, setNoteBackground, deleteSelected). The tool behaviour itself (what a drag does) still lives in the core's input loop, which moves with core-board.
- `core-board/` — the board view DOM: canvas, grid, SVG layer, cards layer, plugin view, overlays, view switcher, resize/rotate handles and toast. It builds the board DOM, appends it to the main column, and hands the elements to the plugin system (`api.ui.setBoardElements`). It activates first, before the toolbar (which appends to the board) and the title bar (which inserts before it). The render loop and the input loop (pan, zoom, drag, resize/rotate, text edit) still live in the core, which owns the board model, the undo store and the search engine; moving them into this plugin is the remaining deep work.
- `core-titlebar/` — the title bar (window controls, app name, undo/redo, panels toggle, search box). It builds the title bar DOM, inserts it immediately before the board element, hands the plugin system the panels toggle (`api.ui.setPanelsToggleEl`) and the search box container (`api.ui.setSearchBoxEl`), and wires the window controls through `api.window` (close, minimise, fullscreen, maximise, getWindowState) and undo/redo through `api.board`. The platform comes from `api.app.getPlatform`. It activates before core-search, so the search box container exists when the search plugin mounts into it.
- `core-search/` — the board search box. It builds the search input, match count, clear button and results dropdown into the search box container the title bar provides (`api.ui.getSearchBoxEl`), and hands those elements to the search engine (`api.search.setElements`). The engine owns the matching, the dimming and the results; this plugin owns the box. The box is fixed at 360×34 in every state: the results dropdown is absolutely positioned below it, so it never changes the box's size.

## Frame cards

A plugin card can be a frame, by setting `frame: true` in its card def. A frame is a container, not content: on the board it renders as a transparent dashed border only, never hiding the cards inside it. In board interaction it is hit-tested after every other card, so clicking a card inside a frame selects the card, not the frame, and clicking empty space inside a frame selects the frame. Frames are never brought to the front on click, so their board order, and therefore any frame-based order like a presentation's slide order, never changes just by selecting a frame.

Frame cards should use kind `"slide"` by convention, so library-style plugins can exclude them from content lists, as Visual Library does: a slide border is not a library card.

## What is not in v1

- No drag tools. Click tools only.
- No menu bar contributions. The command palette is a bundled plugin, not core, and it runs on the API above.
- No network access except through `fetchPreview`.
- No main-process plugins, no Node access, no direct filesystem or shell access.
- No plugin store, no paid plugins, no auto-update.
- No deactivate cleanup for event listeners. Handlers registered in `activate` stay registered after `deactivate` in v1, so they must guard on missing panel, view or overlay elements. A future version will pass the API object to `deactivate` for cleanup.
- No sandboxing stronger than the contract above. A locally installed plugin runs in the renderer with the API object, and like any locally installed extension it must be trusted by the person who installed it. A future version may move plugin panels and views into isolated frames. V1 does not, and does not pretend otherwise.

## Security boundaries

These are enforced in the main process, not in the renderer, because renderer code can be replaced by a crafted board:

- Board JSON, file names and link-preview data are untrusted. Card rendering coerces positions and sizes to numbers, only allows strict hex colours, and escapes file names, link domains, titles and descriptions before they reach HTML, so a crafted board or a file named like markup cannot break out of an attribute or inject a script.
- The `app-file` scheme only serves board-local files and app assets. Any other path is a 404, even if the renderer asked for it by full path.
- `api.files.openExternal` opens https URLs in the browser and board-local files in their system app. Anything else (a local app, a script, a `file://` URL outside the board) is refused, so a click on a link card cannot open an arbitrary local file.
- `api.files.fetchPreview` only fetches public http(s) URLs. Localhost, `.local` names and private or loopback IP literals are refused, as is a redirect that lands on one. A DNS name that resolves to a private address after the check (DNS rebinding) is not covered by this check.
- The plugin permission checks in `src/plugins.ts` are a contract for well-behaved plugins, not a sandbox against a malicious one: a plugin runs in the same renderer as the core, so installing a plugin is trusting its code.

## Sample plugin

`examples/plugins/hello-card/` is the smallest plugin that uses the card, tool, panel, command and view surfaces. Copy that folder into your plugins folder to try it, or copy it as the starting point for a new plugin. It is an example, not a bundled plugin, and it is not copied into packaged apps.

## Replacing a built-in UI piece

A built-in UI piece is a first-party plugin, so a user plugin can replace it by providing the same surface and disabling the built-in one in Settings → Plugins. The core never builds that surface itself; whichever plugin provides it wins. This is the minimal toolbar replacement: it builds its own toolbar with one tool (a pen) and a zoom-out button, using only the API the built-in toolbar uses. Disable `core-toolbar` first, or both toolbars will show.

`manifest.json`:

```json
{
  "id": "my-toolbar",
  "name": "My toolbar",
  "version": "1.0.0",
  "apiVersion": "2",
  "description": "A minimal toolbar: pen tool and zoom out.",
  "main": "main.js",
  "permissions": ["board:read", "board:write", "pen"]
}
```

`main.js`:

```js
// A minimal toolbar replacement. It builds its own toolbar DOM
// and appends it to the board, registers a pen tool through
// api.ui.registerTool, and zooms out through api.view.zoomBy.
// The built-in toolbar (core-toolbar) is disabled in Settings,
// so this is the only toolbar. The core's input loop runs the
// pen tool's drag behaviour; this plugin only provides the
// button and the tool registration.
export function activate(api) {
  const bar = document.createElement("div");
  bar.id = "my-toolbar";
  bar.innerHTML = `
    <button id="my-pen" title="Pen">Pen</button>
    <button id="my-zoom-out" title="Zoom out">−</button>`;
  api.ui.boardEl.appendChild(bar);
  api.ui.registerTool({
    id: "pen",
    title: "Pen",
    icon: "<svg viewBox=\"0 0 24 24\"><path d=\"M4 20l1-4L16 5l3 3L8 19l-4 1z\" /></svg>",
    onMouseDown: () => {},
    onMouseUp: () => {},
  });
  bar.querySelector("#my-pen").addEventListener("click", () => api.ui.setTool("pen"));
  bar.querySelector("#my-zoom-out").addEventListener("click", () => api.view.zoomBy(1 / 1.2));
}

export function deactivate() {
  document.getElementById("my-toolbar")?.remove();
}
```

The same pattern replaces any built-in piece: build the DOM, register it through the shell (`api.ui.setToolbarToolsEl`, `setSearchBoxEl`, `setBoardElements`, `registerSettingsUI`), and drive it through the API. The built-in plugin's source in `src/core-plugins/` is the reference implementation.
