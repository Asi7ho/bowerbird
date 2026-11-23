// Bowerbird plugin API types — the public contract plugins build
// against. A plugin is a folder with a manifest.json and a main
// module; it receives one `api: PluginContext` and must not import
// anything from the app's own source (src/). These types live in
// the bowerbird-plugin-api package (plugin-api/), so a plugin
// imports them by name — `import type { ... } from
// "bowerbird-plugin-api"` — and never reaches into the core. The
// core (src/backend/model.ts and src/plugins/host.ts) re-exports
// them, so existing core imports keep working. Board JSON is the
// stable on-disk shape these types
// describe; see ARCHITECTURE.md and PLUGIN_API.md.

// ---- board model (from src/backend/model.ts) ----

export interface Pt { x: number; y: number }

export interface Size { w: number; h: number }

export type Anchor = { Point: Pt } | { Item: number };

export type ShapeKind = "rect" | "ellipse" | "triangle" | "diamond" | "hexagon" | "star" | "arrow";

export type Kind =
  | { Text: { text: string; bold: boolean; size: number; color: string; bg?: string } }
  | { Shape: { shape: ShapeKind; fill: string; outline?: boolean } }
  | { Image: { path: string } }
  | { UrlCard: { url: string; title: string | null; description: string | null; image?: string | null; icon?: string | null; embed?: boolean } }
  | { PdfCard: { path: string; size_bytes: number } }
  // A native design file (.psd, .ai) lands as one card,
  // like a PDF: a preview of the artwork, with a small
  // format pill on its bottom-right corner — no file name
  // or size below it. `path` is the source file itself
  // (kept in the board's assets, live-synced); `preview`
  // is the rendered artwork, embedded alongside it.
  // Double-clicking opens the source in its app.
  | { FileCard: { path: string; size_bytes: number; format: "psd" | "ai"; preview?: string } }
  | { Swatch: { hex: string } }
  | { Audio: { path: string; title?: string; transcript?: string } }
  | { Video: { source: string; remote: boolean; size_bytes: number; poster?: string; duration?: number } }
  | { Model3D: { path: string; size_bytes: number } }
  | { Stroke: { points: Pt[]; color: string; width: number; marker: boolean; pressures?: number[]; pencil?: boolean } }
  | { Connector: { from: Anchor; to: Anchor; color: string } }
  // Plugin cards (see PLUGIN_API.md): namespaced so the core never
  // has to know a plugin's data shape. `data` is always JSON. If
  // the plugin is missing or disabled, the core renders a
  // placeholder and carries `data` through load and save verbatim
  // — uninstalling a plugin never deletes its cards' data.
  | { Plugin: { plugin: string; kind: string; data: unknown } };

export interface Item {
  id: number;
  pos: Pt;
  size: Size;
  group: number | null;
  kind: Kind;
  // Rotation in degrees, clockwise, around the item's centre
  // (card centre, or stroke bounding-box centre).
  // Optional so old boards load unchanged: missing means 0.
  // Cards and strokes rotate; connectors never carry it,
  // and slide frames are excluded by the rotate action.
  rotation?: number;
  // The layer this item sits on, by layer id. Optional so
  // old boards load unchanged: missing means the default
  // layer ("default").
  layer?: string;
}

// Layers: the paint order, visibility and lock of a board's
// items. A layer is a named band items sit on: layers paint
// bottom-to-top in array order, and items on one layer keep
// their board order among themselves. Layer ids are strings,
// not numbers: layers are created and deleted at runtime, so
// a string id needs no `next_layer` counter on the board and
// can never collide with the numeric item and group id
// spaces. The default layer is always present (id
// "default", healed on load), visible and unlocked, and
// cannot be deleted — every board keeps somewhere for its
// items to be.
export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
}

export interface Camera { x: number; y: number; zoom: number }

export interface Board {
  items: Item[];
  camera: Camera;
  next_id: number;
  next_group: number;
  // Labels for groups: each group carries the label its
  // frame shows. Optional so old boards load unchanged:
  // a group with no entry gets "Group <id>" on load.
  // A group can also be a live import: the cards came from
  // one source file (.svg, .psd or .ai) kept in the board's
  // assets, and the app re-imports it when that file
  // changes on disk. The source is the board-local path
  // the file was embedded at, never a path outside the
  // board (see the security boundaries in electron/main.ts).
  groups?: Record<number, GroupEntry>;
  // Layers, bottom-to-top in array order (see Layer).
  // Optional so old boards load unchanged: a board with no
  // layers heals to a single default layer on load.
  layers?: Layer[];
  // Per-board plugin data, namespaced by plugin id: a
  // plugin reads and writes only its own entry (see
  // api.board.getExtension / setExtension). Optional so
  // old boards load unchanged: missing means no plugin
  // has stored board data yet. Unlike plugin storage,
  // this travels with the board — it is saved in board
  // JSON, undone with the board, and deleted with it.
  extensions?: Record<string, unknown>;
  bg: string;
  grid: "Lines" | "Dots" | "Off";
}

// One entry of Board.groups.
export interface GroupEntry {
  label: string;
  source?: ImportSource;
}

// The file a live-import group came from: its kind, and the
// board-local path it was embedded at. size and mtimeMs are
// the file as last imported: the app re-imports when the
// file on disk differs from them, and ignores its own write
// (which matches them).
export interface ImportSource {
  path: string;
  kind: "svg" | "psd" | "ai";
  size?: number;
  mtimeMs?: number;
}

// Arranging cards: the layout math for api.board.arrange.
// Given the board and a set of item ids, compute where each
// card goes. The caller applies the positions (one undo step
// via updateItems). Every layout anchors on the bounding box
// of the cards' current positions, so the arrangement happens
// in place — "tidy these" keeps them where they are,
// organised. Connectors are not cards to lay out, so they
// are skipped. A single card has nowhere to go, so it stays.
export type ArrangeOptions =
  | { type: "grid"; columns: number; gap?: number }
  | { type: "columns"; columns: number; gap?: number }
  | { type: "row"; gap?: number }
  | { type: "column"; gap?: number }
  | { type: "radial"; center: number; radius?: number };

export interface Segment { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: boolean; strike?: boolean }

export type Block =
  | { Heading: { level: number; segments: Segment[] } }
  | { Bullet: { segments: Segment[] } }
  | { Ordered: { n: number; segments: Segment[] } }
  | { Quote: { segments: Segment[] } }
  | { Code: { lines: string[] } }
  | { Paragraph: { segments: Segment[] } };

// ---- plugin API (from src/plugins/host.ts) ----

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  description?: string;
  permissions?: string[];
  main: string;
  styles?: string[];
  source?: string;
  enabled?: boolean;
  // Required plugins cannot be disabled: they are the
  // foundation the rest of the app stands on (the board
  // itself, and the Settings window that manages plugins).
  // Disabling one would remove the only way to re-enable
  // it — a soft lock. A required plugin is always enabled,
  // whatever the enabled map says, so a stale "false" in
  // plugins.json cannot lock the app out either.
  required?: boolean;
  contributions?: {
    cards?: Array<{ kind: string; title: string; frame?: boolean }>;
    tools?: Array<{ id: string; title: string }>;
    panels?: Array<{ id: string; title: string }>;
    views?: Array<{ id: string; title: string }>;
    commands?: Array<{ id: string; title: string }>;
    createActions?: Array<{ id: string; title: string }>;
    overlays?: Array<{ id: string; title: string }>;
    settingsSections?: Array<{ id: string; title: string }>;
    shortcuts?: Array<{ key: string; title: string }>;
  };
}

export interface PluginCardDef {
  kind: string;
  title: string;
  // Handlers receive the full board item AND the plugin's data
  // separately, so a plugin author never has to dig through
  // item.kind.Plugin.data: render(item, data) is the easy path.
  // Returning null hides the card entirely — the core renders
  // nothing for it — so a plugin can show a card only in
  // the context it belongs to (for example, a slide frame
  // only while its panel is open).
  render: (item: Item, data: unknown) => string | null;
  onDoubleClick?: (item: Item, data: unknown) => void;
  onAction?: (action: string, item: Item, data: unknown) => void;
  searchText?: (data: unknown) => string;
  // A frame card is a container, not content: on the board
  // it renders as a transparent dashed border only, so it
  // never hides the cards inside it, and in board interaction
  // it is hit-tested after every other card, so clicking a
  // card inside a frame selects the card, not the frame, and
  // clicking empty space inside a frame selects the frame.
  // Frames are also never brought to the front on click, so
  // their board order — and therefore a frame-based order
  // like a presentation's slide order — never changes just
  // by selecting a frame. Frame cards should use kind
  // "slide" by convention, so library-style plugins can
  // exclude them from content lists, as Visual Library does.
  frame?: boolean;
}

// A renderer for a built-in card kind (Text, Image, Swatch,
// UrlCard, PdfCard, Audio, Video, Shape). The built-in kinds
// used to be rendered by core code; now they are rendered by
// the core-cards plugin, through this same shape. `render`
// receives the full item and the kind's payload (for Text,
// `{ text, size, color, bg }`), and returns the complete
// card HTML — outer div, position, size, selection ring and
// all — exactly as the core's renderer did. `plain` is true
// when the card is rendered for a slide, the library or an
// export, where a live preview (PDF page, playing audio)
// cannot survive as HTML, so the renderer stays a tile.
// The core's card wrapper calls the registered renderer
// for the kind, and falls back to a placeholder when no
// plugin provides one.
export interface PluginBuiltinCardDef {
  kind: string;
  title: string;
  render: (item: Item, data: unknown, plain?: boolean) => string;
  onDoubleClick?: (item: Item, data: unknown) => void;
  onAction?: (action: string, item: Item, data: unknown) => void;
  searchText?: (data: unknown) => string;
}

// A card decoration: HTML shown inside a card, at its
// bottom edge. `id` is unique within the plugin (the core
// keys it as pluginId:id). `side` picks the corner —
// "left" (the default) or "right". The renderer is called
// for every card on every render, so it must be pure and
// fast, and it must escape any text it puts in the HTML.
// Returning null renders nothing.
export interface PluginCardDecoratorDef {
  id: string;
  side?: "left" | "right";
  render: (item: Item) => string | null;
}

export interface PluginToolDef {
  id: string;
  title: string;
  icon?: string;
  onMouseDown?: (world: Pt) => void;
  onMouseUp?: (world: Pt) => void;
  // Drag callbacks: a tool that draws while the pointer
  // moves — a brush, a scrubber, an orbit drag — implements
  // these instead of (or beside) onMouseDown/onMouseUp.
  // The core starts a plugin drag on pointerdown while the
  // tool is active, routes every pointermove to
  // onPointerMove, and ends the drag on pointerup
  // (onPointerUp) or pointercancel / Escape
  // (onPointerCancel). A tool that defines any of these owns
  // the gesture: the core's own drags do not run while it is
  // active. A tool that defines none of them keeps the old
  // click behaviour (onMouseDown/onMouseUp only). When both
  // are defined, the drag callbacks win and the click ones
  // are not called.
  onPointerDown?: (world: Pt, ev: PluginPointerEvent) => void;
  onPointerMove?: (world: Pt, ev: PluginPointerEvent) => void;
  onPointerUp?: (world: Pt, ev: PluginPointerEvent) => void;
  onPointerCancel?: (world: Pt, ev: PluginPointerEvent) => void;
}

// The pointer behind a plugin tool's drag callbacks: the
// fields a brush needs, in world-independent form. `pressure`
// is 0..1 (0 for a mouse, which has no pressure);
// `tiltX`/`tiltY` are the stylus tilt in degrees, 0 when the
// device reports none; `pointerType` is "mouse", "pen" or
// "touch"; `buttons` is the pressed-buttons bitmask, so a
// drag can tell a held button from a hover.
export interface PluginPointerEvent {
  pressure: number;
  tiltX: number;
  tiltY: number;
  pointerType: string;
  pointerId: number;
  buttons: number;
  isPrimary: boolean;
}

// How a drag tool's live preview stroke looks. All fields
// are optional: width defaults to 3, color to the pen
// colour, marker to false (opaque), pencil to false (no
// graphite texture).
export interface PluginPreviewStrokeOptions {
  width?: number;
  color?: string;
  marker?: boolean;
  pencil?: boolean;
}

// How a drag tool's live shape preview looks. All fields
// are optional: color defaults to the pen colour, outline
// to false (filled). An outline shape previews as a stroke
// only, a filled shape as a fill.
export interface PluginPreviewShapeOptions {
  color?: string;
  outline?: boolean;
}

// A creation action: an alternative to typing when the user
// double-clicks. The core opens the text box as always, with
// the action's icon beside it; clicking the icon runs the
// action at the note's position (the double-click point for
// a new note) instead of typing. The first registered
// action is the one shown. The action's run receives a
// world point, so the thing it creates lands where the
// user pointed.
export interface PluginCreateActionDef {
  id: string;
  label: string;
  icon?: string;
  run: (world: Pt) => void | Promise<void>;
}

export interface PluginPanelDef {
  id: string;
  title: string;
  icon?: string;
  render: (container: HTMLElement) => void;
}

export interface PluginViewDef {
  id: string;
  title: string;
  render: (container: HTMLElement, board: Board) => void;
  onShow?: () => void;
  onHide?: () => void;
}

export interface PluginCommandDef {
  id: string;
  title: string;
  run: () => void | Promise<void>;
}

export interface PluginOverlayDef {
  id: string;
  render: (container: HTMLElement) => void;
}

export interface PluginSettingsSectionDef {
  id: string;
  title: string;
  render: (container: HTMLElement) => void;
}

export interface PluginShortcutDef {
  key: string;
  title: string;
  run: () => void | Promise<void>;
}

// The bridge methods plugins need, as a structural subset of the
// preload API. main.ts passes its `api` object here; it satisfies
// this interface once preload exposes the plugin IPC methods.
export interface PluginBridge {
  platform: string;
  fileUrl(path: string): string;
  saveBoardSync(json: string): boolean;
  embedFile(path: string): Promise<string>;
  embedFileBytes(name: string, data: ArrayBuffer | Uint8Array): Promise<string>;
  readTextFile(path: string): Promise<string>;
  readFileBase64(filePath: string): Promise<{ mime: string; base64: string }>;
  fileSize(path: string): Promise<number>;
  fetchPreview(url: string): Promise<{ title: string | null; description: string | null; image: string | null; icon: string | null }>;
  aiChat(opts: { base: string; model: string; messages: Array<{ role: string; content: string }> }): Promise<string>;
  aiHasKey(): Promise<boolean>;
  aiSetKey(key: string): Promise<boolean>;
  openExternal(target: string): Promise<void>;
  listBackups(): Promise<Array<{ name: string; items: number; size: number }>>;
  listAllBackups(): Promise<Array<{ name: string; items: number; size: number; mtimeMs: number }>>;
  openBackupsFolder(): Promise<string>;
  // Crash recovery (see electron/recovery.ts): whether the
  // journal holds edits board.json does not, and dropping it.
  // Restoring goes through the host, like restoreBackup.
  recoveryStatus(): Promise<{ hasRecovery: boolean; savedAt: number | null }>;
  recoveryDiscard(): Promise<void>;
  // Export the current board as a ZIP (null when the user
  // cancels), and import a board export — a ZIP file or
  // the folder it unzips to (null on cancel). The import
  // returns the board resolved to this machine.
  exportBoard(): Promise<string | null>;
  importBoard(): Promise<{ json: string; board_path: string; board_dir: string } | null>;
  listPlugins(): Promise<PluginManifest[]>;
  readPluginFile(pluginId: string, relativePath: string): Promise<string>;
  getPluginEnabled(): Promise<Record<string, boolean>>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean>;
  installPlugin(plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string; styleCode: string }): Promise<PluginManifest>;
  pluginStorageGet(pluginId: string, key: string): Promise<unknown>;
  pluginStorageSet(pluginId: string, key: string, value: unknown): Promise<void>;
  pluginStorageDelete(pluginId: string, key: string): Promise<void>;
  listBoards: () => Promise<Array<{ name: string; current: boolean; items: number }>>;
  factoryReset(opts?: { confirmed?: boolean }): Promise<{ ok: boolean }>;
  createBoard: (name: string) => Promise<{ name: string }>;
  renameBoard: (oldName: string, newName: string) => Promise<{ name: string }>;
  deleteBoard: (name: string, opts?: { confirmed?: boolean }) => Promise<{ wasCurrent: boolean }>;
  secureStorageAvailable(): Promise<boolean>;
  secureStorageGet(pluginId: string, key: string): Promise<string | null>;
  secureStorageSet(pluginId: string, key: string, value: string): Promise<boolean>;
  secureStorageDelete(pluginId: string, key: string): Promise<void>;
  listLibrary: () => Promise<{ path: string; items: Array<{ name: string; path: string; relativePath: string; ext: string; kind: string; category: string | null; size_bytes: number; mtime_ms: number }>; categories: Array<{ name: string; count: number }>; uncategorizedCount: number }>;
  createLibraryCategory: (name: string) => Promise<string>;
  moveLibraryItem: (relativePath: string, category: string | null) => Promise<string>;
  // Window primitives: the main process owns the window and the
  // peek icon, so these are the only way a plugin can hide, show
  // or move the window. They are the existing preload bridge
  // methods, now available to plugins through api.window.
  collapse: () => Promise<void>;
  restore: () => Promise<void>;
  minimise: () => Promise<void>;
  quit: () => Promise<void>;
  fullscreen: () => Promise<boolean>;
  maximise: () => Promise<boolean>;
  windowState: () => Promise<{ maximised: boolean; fullscreen: boolean }>;
  moveWindow: (dx: number, dy: number) => void;
  getAppSettings: () => Promise<{ corner: string; panelOrder?: string[]; panelWidth?: number; dockVisible?: boolean; shortcuts?: Record<string, string>; hardwareAcceleration?: boolean }>;
  setPanelWidth: (width: number) => Promise<number>;
  setDockVisible: (visible: boolean) => Promise<boolean>;
  setCorner: (corner: string) => Promise<string>;
  setPanelOrder: (order: string[]) => Promise<string[]>;
  setShortcuts: (overrides: Record<string, string>) => Promise<Record<string, string>>;
  setHardwareAcceleration: (enabled: boolean) => Promise<boolean>;
  restart: () => Promise<void>;
}

// What the core provides to the plugin system. All board mutation
// goes through here, so plugins never touch core state directly
// and core save/render/undo-adjacent behaviour stays in one place.
export interface PluginHost {
  getBoard: () => Board;
  getSelected: () => number[];
  setSelected: (ids: number[]) => void;
  addItem: (kind: Kind, pos: Pt, size: Size) => number;
  // Add an item without saving or rendering, for a text
  // note that is about to be edited: the edit commit saves
  // it, or removes it if left empty, so a cancelled note
  // leaves no undo step and no board change behind. The
  // caller saves (or removes and saves) once the edit ends.
  addItemSilent: (kind: Kind, pos: Pt, size: Size) => number;
  // Add several items at once, in one save (one undo step).
  // A plugin that builds a structure — a mind map, a grid of
  // cards — adds them all here, so undoing it takes one undo,
  // not one per card. addItem saves after every item.
  addItems: (items: Array<{ kind: Kind; pos: Pt; size: Size }>) => number[];
  updateItem: (id: number, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown }) => boolean;
  updateItems: (patches: Array<{ id: number; pos?: Pt; size?: Size; group?: number | null; data?: unknown }>) => boolean;
  moveItem: (id: number, toIndex: number) => boolean;
  removeItem: (id: number) => boolean;
  renderBoardCard: (id: number) => string | null;
  // Render a board item exactly as the board renders it, at
  // its real position and with its selection and editing
  // state, so the board view can build the card DOM from
  // it. Unlike renderBoardCard (position 0,0, plain, for a
  // plugin embedding a card in a panel or view), this is
  // the card as it appears on the board — a PDF shows its
  // rendered page, audio shows its playback state, a
  // selected image shows whole. Strokes and connectors
  // render as null: the board draws those as SVG itself.
  renderBoardCardAt: (id: number) => string | null;
  // Hit-test: the top item id at a world point, or null.
  // Frames lose to the cards inside them (see hitTest).
  hitTest: (world: Pt) => number | null;
  // Selection queries, for the board view's drags: which
  // items a marquee rect or a lasso loop covers, and which
  // strokes an eraser circle touches. Pure reads over the
  // live board, no save, no render — the caller applies
  // the selection itself.
  marqueeSelect: (a: Pt, b: Pt) => number[];
  lassoSelect: (points: Pt[]) => number[];
  strokesNear: (point: Pt, radius: number) => number[];
  // Live-drag mutations, for the board view only: they
  // change the live board without saving or rendering, so
  // a drag can move, resize, rotate, erase or re-stack
  // on every pointermove without flooding the undo stack
  // or rebuilding the card DOM. The caller saves once at
  // drag end (save, or saveWithoutUndo for a click that
  // only re-stacked) and renders once. A plugin that wants
  // a saved, undoable change uses updateItem(s) instead.
  moveItems: (ids: number[], dx: number, dy: number) => void;
  resizeItem: (id: number, w: number, h: number) => void;
  setItemRotation: (id: number, rot: number) => void;
  removeItems: (ids: number[]) => void;
  bringToFront: (ids: number[]) => void;
  // Set a text note's text (and its height, from the text),
  // without saving or rendering. The board view's text
  // commit: it saves once after the edit, so the commit is
  // one undo step. False when the card is not a text note.
  setTextContent: (id: number, text: string) => boolean;
  // Group a set of cards: a new group id comes from the
  // board's next_group, so a later group can never collide
  // with it. One save, one undo step. Returns the group id,
  // or null when fewer than two cards were given.
  createGroup: (ids: number[]) => number | null;
  // Rename a group's label. One save, one undo
  // step. False when the group has fewer than two members
  // or the label is empty after trimming.
  setGroupLabel: (group: number, label: string) => boolean;
  // Rename a voice note: the title is shown instead of the
  // file's name. One save, one undo step. An empty title
  // clears it, so the card falls back to the file's name.
  // False when the card is not audio, or the title is
  // unchanged.
  setAudioTitle: (id: number, title: string) => boolean;
  save: () => void;
  // Save the board to disk without creating an undo step,
  // for changes the user did not make as edits: a pan's
  // camera move, a click's re-stack, a link preview
  // filling in. The file still saves, so closing the
  // window keeps the change; undo never steps to it.
  saveWithoutUndo: () => void;
  // Synchronous flush for unload: write the board only if
  // it changed since the last save (see undo.ts saveSync).
  // True when it wrote. A board that did not change is
  // not written, so the unload flush can never overwrite
  // a restore with the stale board it replaced.
  saveSync: () => boolean;
  render: () => void;
  switchBoard: (name: string, preserveUndo?: boolean) => Promise<boolean>;
  setTool: (tool: string) => void;
  getTool: () => string;
  // Choose the selection mode (plain select or lasso) and
  // activate Select with it. The mode is remembered, so
  // the V shortcut and the select button restore the mode
  // last chosen instead of always plain select.
  setSelectMode: (mode: "select" | "lasso") => void;
  getSelectMode: () => "select" | "lasso";
  getPenColor: () => string;
  setPenColor: (hex: string) => boolean;
  getCamera: () => Camera;
  setCamera: (cam: Camera) => void;
  // Set the camera without saving or rendering, for a live
  // pan or zoom drag: the drag applies the camera on every
  // pointermove through this, and saves once at drag end,
  // so a pinch does not write the board JSON per frame.
  setCameraSilent: (cam: Camera) => void;
  // Zoom around the board centre, by a factor (1.2 in,
  // 1/1.2 out). The core owns the camera math; a UI plugin
  // just says "zoom in" or "zoom out".
  zoomBy: (factor: number) => void;
  // The shape table (kind, label, key, SVG icon) for the
  // shape picker's flyout. Read-only UI data.
  listShapes: () => Array<{ kind: string; label: string; key: string; svg: string }>;
  // Drag-preview polygon points for a shape in a box from
  // (x0, y0) sized w x h. Same geometry as the shape's
  // clip-path, so the preview is the shape drawn. The board
  // view draws the live shape preview from this.
  shapePreviewPoints: (kind: string, x0: number, y0: number, w: number, h: number) => string;
  // Whether new shapes are outlines (stroke only) or
  // filled. The toolbar's shape picker sets it; the board
  // view reads it when a shape is drawn.
  getShapeOutline: () => boolean;
  setShapeOutline: (outline: boolean) => void;
  // Set the background of the given text notes, in one
  // save (one undo step). A board write. Only Text notes
  // are affected; other kinds are ignored.
  setNoteBackground: (ids: number[], hex: string) => void;
  // Search: hand the engine the search box elements (built
  // by the core-search plugin), re-run the search, clear it,
  // or jump to a match. The engine owns the matching, the
  // dimming and the results; these are its entry points.
  setSearchElements: (els: { input: HTMLInputElement; count: HTMLElement; clear: HTMLButtonElement; results: HTMLElement }) => void;
  updateSearch: () => void;
  clearSearch: () => void;
  jumpToSearchIndex: (idx: number) => void;
  centreOn: (id: number) => void;
  toast: (msg: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  isSettingsOpen: () => boolean;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;
  groupSelection: () => boolean;
  ungroupSelection: () => boolean;
  deleteSelection: () => boolean;
  restoreBackup: (name: string) => Promise<boolean>;
  restoreRecovery: () => Promise<boolean>;
  importBoard: () => Promise<boolean>;
  getBuildId: () => string;
  // ---- media (for the cards that play or preview media) ----
  getAudioState: () => { id: number | null; playing: boolean; currentTime: number; duration: number };
  getAudioDuration: (path: string) => number | undefined;
  loadAudioDuration: (id: number, path: string) => void;
  // Waveform peaks for an audio card (100 bars, 0..1), from
  // a real decode of the file. Undefined until loaded.
  getAudioPeaks: (path: string) => number[] | undefined;
  loadAudioPeaks: (id: number, path: string) => Promise<void>;
  // Transcribe a recorded audio blob to text, on-device.
  // Null when the audio cannot be decoded or the model
  // cannot run. No permission needed: the model runs
  // locally, like the search models, and no audio leaves
  // the machine.
  transcribeAudio: (blob: Blob) => Promise<string | null>;
  audioFailed: (path: string) => boolean;
  formatAudioTime: (sec: number) => string;
  // Toggle playback of an audio card: play it if it is not
  // playing, pause it if it is. The board view's play
  // button. The raw audio element is never handed out.
  toggleAudio: (id: number, path: string) => void;
  // Show the live <video> element for a video card. The
  // board view's play button on a poster. At most one card
  // is live; playing another moves it there.
  playVideo: (id: number) => void;
  getVideoState: () => { id: number | null };
  // Seek the playing audio card to a time in seconds.
  // No-op when that card is not the one playing.
  seekAudio: (id: number, time: number) => void;
  // Seek an audio card to a time in seconds, whether or
  // not it is playing: a card that is not playing loads
  // paused at that time, so play starts there.
  seekAudioTo: (id: number, path: string, time: number) => void;
  getPdfPage: (id: number) => number;
  loadPdfPage: (id: number, path: string) => void;
  // Heal a FileCard saved at the stale height: measure its
  // preview and shrink the card to the ratio of the file
  // when it is still wrong.
  loadFileCardSize: (preview: string) => void;
  loadVideoCardSize: (poster: string) => void;
  // The first page's size in points, for sizing a PDF card
  // to its page. Null when the file cannot be read.
  probePdfSize: (path: string) => Promise<{ w: number; h: number } | null>;
  // Heal a PdfCard saved at the stale fixed size: measure
  // its first page and resize the card to the ratio of the
  // page when it is still wrong.
  loadPdfCardSize: (path: string) => void;
  // Heal a UrlCard saved at the stale fixed size: measure
  // its preview image and resize the card to the ratio of
  // the image when it is still wrong.
  loadLinkCardSize: (image: string) => void;
  // Move a PDF card to a page (clamped to the document),
  // and render it. The board view's prev/next buttons.
  // False when the document is not loaded yet.
  setPdfPage: (id: number, path: string, page: number) => Promise<boolean>;
  pdfFailed: (path: string) => boolean;
  // Reset the board to a fresh welcome board (the settings
  // "Delete all board data" flow). A board write, and not
  // available to a trial plugin.
  resetBoard: (opts?: { confirmed?: boolean }) => Promise<boolean>;
  getBoardDir: () => string;
  // Board canvas (background + grid): the settings UI writes
  // these. A board-level write, so it needs board:write on
  // the plugin side, like any board mutation.
  setCanvas: (patch: { bg?: string; grid?: Board["grid"] }) => void;
  // The board area element: the mount point for board
  // overlays (the settings window, and later the board view
  // itself). A UI plugin appends its overlay DOM here; it
  // never queries core DOM by id. This is a mount point the
  // API hands out, not a back door into core internals.
  boardEl: HTMLElement;
  commitEditing: () => void;
  // Panel tab order: the core owns the persisted order, the
  // plugin system owns the tab DOM, so both sides go through
  // these two calls instead of either side keeping its own list.
  getPanelOrder: () => string[];
  setPanelOrder: (order: string[]) => void;
}

export interface PluginContext {
  version: string;
  plugin: { id: string; name: string; version: string };
  has: (capability: string) => boolean;
  board: {
    get: () => Board;
    getItems: () => Item[];
    getItem: (id: number) => Item | undefined;
    // Live reads, for the app's own UI only: the board and
    // the item as they stand, with no copy. A plugin that
    // calls these gets an error — a plugin must use get /
    // getItem, which return a copy it can hold and change
    // without touching the live board. The UI uses these
    // in its hot paths (render, drags), where cloning the
    // whole board — or a stroke's point array — on every
    // frame is the cost. The returned board and item must
    // never be mutated: writes go through moveItems,
    // resizeItem, setItemRotation and the other board
    // methods, which keep undo and saving in sync.
    getLive: () => Board;
    getItemLive: (id: number) => Item | undefined;
    renderCard: (id: number) => string | null;
    // Render a board item exactly as the board renders it,
    // at its real position and with its selection and
    // editing state. The board view builds the card DOM
    // from this. Unlike renderCard (position 0,0, plain,
    // for embedding a card in a panel or view), this is
    // the card as it appears on the board.
    renderCardAt: (id: number) => string | null;
    // Draw a drag tool's live preview stroke in the preview
    // layer above the cards, without touching the board: the
    // points are world points, the pressures (when given)
    // vary the width the way a pen stroke does. The preview
    // is drag-time only — the next full render wipes it, and
    // the core clears it when the tool's drag ends or
    // cancels — so it never lands in board JSON. A call with
    // no points clears it at once. A tool that commits a
    // finished stroke calls addItem on pointerup instead, so
    // the stroke becomes one undo step.
    previewStroke: (points: Pt[], pressures?: number[], opts?: PluginPreviewStrokeOptions) => void;
    // Draw a drag tool's live shape preview in the preview
    // layer above the cards, without touching the board: the
    // shape in its drag box, filled in the pen colour (or
    // `opts.color`) or outlined when `opts.outline` is set.
    // The preview is drag-time only — the next full render
    // wipes it, and the core clears it when the tool's drag
    // ends or cancels — so it never lands in board JSON. A
    // tool that commits the finished shape calls addItem on
    // pointerup instead, so the shape becomes one undo step.
    previewShape: (shape: string, x0: number, y0: number, w: number, h: number, opts?: PluginPreviewShapeOptions) => void;
    // Hit-test: the top item id at a world point, or null.
    // A frame is a container, not content: a card inside a
    // frame wins over the frame itself, so cards inside a
    // slide can be grabbed, moved and edited once framed.
    // Only if nothing else covers the point does the frame
    // itself win. The board view uses this for clicks,
    // drags and cursor hints.
    hitTest: (world: Pt) => number | null;
    // Selection queries, for the board view's drags: which
    // items a marquee rect or a lasso loop covers, and which
    // strokes an eraser circle touches. Pure reads over the
    // live board, no save, no render.
    marqueeSelect: (a: Pt, b: Pt) => number[];
    lassoSelect: (points: Pt[]) => number[];
    strokesNear: (point: Pt, radius: number) => number[];
    // Live-drag mutations, for the board view only: they
    // change the live board without saving or rendering, so
    // a drag can move, resize, rotate, erase or re-stack
    // on every pointermove without flooding the undo stack
    // or rebuilding the card DOM. The caller saves once at
    // drag end (save, or saveWithoutUndo for a click that
    // only re-stacked) and renders once. A plugin that wants
    // a saved, undoable change uses updateItem(s) instead.
    moveItems: (ids: number[], dx: number, dy: number) => void;
    resizeItem: (id: number, w: number, h: number) => void;
    setItemRotation: (id: number, rot: number) => void;
    removeItems: (ids: number[]) => void;
    bringToFront: (ids: number[]) => void;
    // Set a text note's text (and its height, from the text),
    // without saving or rendering. The board view's text
    // commit: it saves once after the edit, so the commit is
    // one undo step. False when the card is not a text note.
    setTextContent: (id: number, text: string) => boolean;
    // Group a set of cards: a new group id comes from the
    // board's next_group, so a later group can never collide
    // with it. One save, one undo step. Returns the group id,
    // or null when fewer than two cards were given.
    createGroup: (ids: number[]) => number | null;
    // Rename a group's label. One save, one undo
    // step. False when the group has fewer than two members
    // or the label is empty after trimming.
    setGroupLabel: (group: number, label: string) => boolean;
    // Rename a voice note: the title is shown instead of the
    // file's name. One save, one undo step. An empty title
    // clears it, so the card falls back to the file's name.
    // False when the card is not audio, or the title is
    // unchanged.
    setAudioTitle: (id: number, title: string) => boolean;
    getSelected: () => number[];
    setSelected: (ids: number[]) => void;
    // The selection after clicking a card: the card and its
    // whole group when it is grouped, or just the card.
    // `selected` is the selection to start from (empty for a
    // fresh selection); `additive` (Shift) keeps it and
    // toggles. Returns the new selection; the caller sets it
    // with setSelected. The board view calls this on a card
    // click and on keyboard navigation between cards.
    selectCard: (selected: number[], id: number, additive: boolean) => number[];
    addItem: (kind: Kind, pos: Pt, size: Size) => number;
    // Add an item without saving or rendering, for a text
    // note that is about to be edited: the edit commit saves
    // it, or removes it if left empty, so a cancelled note
    // leaves no undo step and no board change behind. The
    // caller saves (or removes and saves) once the edit ends.
    addItemSilent: (kind: Kind, pos: Pt, size: Size) => number;
    addPluginCard: (kind: string, data: unknown, pos: Pt, size: Size) => number;
    // Add several items at once, in one save (one undo step).
    // A plugin that builds a structure — a mind map, a grid
    // of cards — adds them all here, so undoing it takes one
    // undo, not one per card. addItem saves after every item.
    addItems: (items: Array<{ kind: Kind; pos: Pt; size: Size }>) => number[];
    // Arrange a set of cards: a grid, flowing columns, a
    // single row or column, or a ring around a central card
    // (a mind map). The layout math lives in the core, so a
    // caller picks the cards and the shape and the core works
    // out the positions. Applied as one undo step, anchored
    // on the cards' current bounding box, so the arrangement
    // happens in place. Returns false when there is nothing
    // to arrange (no cards, or a radial with no centre).
    arrange: (ids: number[], options: ArrangeOptions) => boolean;
    // Connect two cards with a connector, the line the
    // connector tool draws. The caller gives the two card
    // ids; the core works out the line's bounding box and
    // the anchor format, so the caller never has to. Returns
    // the new connector's id, or null when either card does
    // not exist.
    connect: (fromId: number, toId: number, options?: { color?: string }) => number | null;
    updateItem: (id: number, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown }) => boolean;
    updateItems: (patches: Array<{ id: number; pos?: Pt; size?: Size; group?: number | null; data?: unknown }>) => boolean;
    moveItem: (id: number, toIndex: number) => boolean;
    removeItem: (id: number) => boolean;
    save: () => void;
    // Save the board to disk without creating an undo step,
    // for changes the user did not make as edits: a pan's
    // camera move, a click's re-stack, a link preview
    // filling in. The file still saves, so closing the
    // window keeps the change; undo never steps to it.
    saveWithoutUndo: () => void;
    // Synchronous save, for the unload flush only: an async
    // save may not complete before the window closes. Only
    // a board that changed since the last save is written
    // (see PluginHost.saveSync): a board restored on disk
    // but not yet reloaded in memory is not written back.
    saveSync: () => void;
    render: () => void;
    commitEditing: () => void;
    groupSelected: () => boolean;
    ungroupSelected: () => boolean;
    deleteSelected: () => boolean;
    undo: () => boolean;
    redo: () => boolean;
    canUndo: () => boolean;
    canRedo: () => boolean;
    // Board canvas: background colour and grid. A board-level
    // write (the settings UI's canvas options), so it needs
    // board:write.
    setCanvas: (patch: { bg?: string; grid?: Board["grid"] }) => void;
    // Set the background of the given text notes, in one
    // save (one undo step). The toolbar's note-colour
    // flyout. A board write. Only Text notes are affected;
    // other kinds are ignored.
    setNoteBackground: (ids: number[], hex: string) => void;
    // Reset the board to a fresh welcome board. A board write,
    // and not available to a trial plugin.
    reset: (opts?: { confirmed?: boolean }) => Promise<boolean>;
    // The board's folder on disk, for display (the settings
    // "Board folder" line). Read-only.
    getDir: () => string;
    // Register this plugin as the board controller: the
    // render, selection, editing and tool functions the core
    // delegates to. The board plugin provides this; other
    // plugins do not call it. Only the app's own UI may call
    // it — a plugin that tries is rejected, so no plugin can
    // replace the board controller. This is how a UI plugin
    // becomes the thing the core delegates to, the same
    // shape as registerSettingsUI.
    registerController: (controller: BoardController) => void;
  };
  boards: {
    list: () => Promise<Array<{ name: string; current: boolean; items: number }>>;
    current: () => Promise<string>;
    create: (name: string) => Promise<{ name: string }>;
    switch: (name: string, preserveUndo?: boolean) => Promise<boolean>;
    rename: (oldName: string, newName: string) => Promise<{ name: string }>;
    delete: (name: string, opts?: { confirmed?: boolean }) => Promise<{ wasCurrent: boolean }>;
  };
  // The app itself: build id and platform. Read-only; a plugin
  // that shows a version uses these.
  // factoryReset wipes everything the app has saved (boards,
  // settings, plugins, plugin storage, secure storage) and is a
  // board write, not available to a trial plugin. The caller
  // reloads after it returns, so the fresh defaults load.
  // getAppSettings reads the persisted app settings (corner,
  // panel layout, hardware acceleration, shortcut overrides);
  // setShortcuts and setHardwareAcceleration write them back,
  // and restart relaunches the app so a new hardware
  // acceleration value takes effect. The writers are board
  // writes, like factoryReset, and are not available to a
  // trial plugin.
  app: {
    getBuildId: () => string;
    getPlatform: () => string;
    factoryReset: (opts?: { confirmed?: boolean }) => Promise<{ ok: boolean }>;
    getAppSettings: () => Promise<{ corner: string; panelOrder?: string[]; panelWidth?: number; dockVisible?: boolean; shortcuts?: Record<string, string>; hardwareAcceleration?: boolean }>;
    setShortcuts: (overrides: Record<string, string>) => Promise<Record<string, string>>;
    setHardwareAcceleration: (enabled: boolean) => Promise<boolean>;
    restart: () => Promise<void>;
  };
  // Backups: list them (newest first) and restore one. A
  // restore loads the backup's board into the app, like
  // boards.switch, so it needs board:write and is not
  // available to a trial plugin. openFolder opens the
  // backups folder in the file explorer, so an older
  // backup can be reached even though the UI lists only
  // the newest one. listAll lists every kept backup, for
  // the Versions history in the Boards panel; recoveryStatus
  // says whether the crash-recovery journal holds edits
  // board.json does not, and restoreRecovery / discardRecovery
  // restore or drop them (restoring backs the current board
  // up first, like a backup restore).
  backups: {
    list: () => Promise<Array<{ name: string; items: number; size: number }>>;
    listAll: () => Promise<Array<{ name: string; items: number; size: number; mtimeMs: number }>>;
    restore: (name: string) => Promise<boolean>;
    openFolder: () => Promise<string>;
    recoveryStatus: () => Promise<{ hasRecovery: boolean; savedAt: number | null }>;
    restoreRecovery: () => Promise<boolean>;
    discardRecovery: () => Promise<void>;
  };
  // Board export and import: export downloads the whole
  // install as a ZIP (null when the user cancels the save
  // dialog); import installs a data export — a ZIP file
  // or the folder it unzips to — and loads the board that
  // was current at export time, so it needs board:write and
  // is not available to a trial plugin. Both return the board
  // resolved to this machine.
  exportBoard: () => Promise<string | null>;
  importBoard: () => Promise<boolean>;
  window: {
    hide: () => Promise<void>;
    show: () => Promise<void>;
    minimise: () => Promise<void>;
    // Close the window. Close quits the app (the old
    // Settings Quit button did exactly this: commit,
    // save, then quit, which destroys the peek window
    // too).
    close: () => Promise<void>;
    // Toggle full screen (macOS) / maximise (Windows and
    // Linux), returning the new state. The title bar's
    // window controls.
    fullscreen: () => Promise<boolean>;
    maximise: () => Promise<boolean>;
    // Whether the window is maximised or full screen, so
    // the title bar can show the right icon (enter/exit
    // full screen, maximise/restore).
    getWindowState: () => Promise<{ maximised: boolean; fullscreen: boolean }>;
    move: (dx: number, dy: number) => void;
    getCorner: () => Promise<string>;
    setCorner: (corner: string) => Promise<string>;
  };
  view: {
    getCamera: () => Camera;
    setCamera: (cam: Camera) => void;
    // Set the camera without saving or rendering, for a live
    // pan or zoom drag: the drag applies the camera on every
    // pointermove through this, and saves once at drag end,
    // so a pinch does not write the board JSON per frame.
    setCameraSilent: (cam: Camera) => void;
    // Zoom around the board centre, by a factor (1.2 in,
    // 1/1.2 out). The toolbar's zoom buttons. The core owns
    // the camera math; a UI plugin just says "zoom in" or
    // "zoom out".
    zoomBy: (factor: number) => void;
    centreOn: (id: number) => void;
    getView: () => string;
    setView: (id: string) => void;
    listViews: () => Array<{ id: string; title: string; plugin: string | null }>;
    // Re-render the active plugin view, as after the board
    // changes. No-op when the board itself is the active
    // view. The board view calls this after a render, so a
    // plugin view showing the board stays in sync.
    refresh: () => void;
  };
  // The shape table (kind, label, key, SVG icon) for the
  // shape picker's flyout. Read-only UI data, no permission
  // needed. The toolbar plugin builds the flyout from this.
  shapes: {
    list: () => Array<{ kind: string; label: string; key: string; svg: string }>;
    // Drag-preview polygon points for a shape in a box from
    // (x0, y0) sized w x h. The board view draws the live
    // shape preview from this.
    previewPoints: (kind: string, x0: number, y0: number, w: number, h: number) => string;
    // Whether new shapes are outlines (stroke only) or
    // filled. The toolbar's shape picker sets it; the
    // board view reads it when a shape is drawn.
    getOutline: () => boolean;
    setOutline: (outline: boolean) => void;
  };
  // Search: the search engine (MiniSearch + local context
  // search). The engine owns the matching, the dimming and
  // the results; the core-search plugin builds the box and
  // hands the engine its elements. No permission needed:
  // searching is a read, and jumping only moves the camera
  // and the selection.
  search: {
    // Hand the engine the search box elements, built by
    // the core-search plugin. Attaches the input and
    // keyboard listeners. Until this is called, the search
    // engine has no box to operate on. Only the app's own
    // UI may call it; a plugin that tries is rejected.
    setElements: (els: { input: HTMLInputElement; count: HTMLElement; clear: HTMLButtonElement; results: HTMLElement }) => void;
    // Re-run the search for the current input value, as
    // after a board change.
    update: () => void;
    clear: () => void;
    jumpTo: (idx: number) => void;
  };
  // The pen's colour: one shared state, not a board item.
  // The toolbar's pen swatches and Palette both read and
  // write it, so picking a colour in Palette changes the
  // next pen stroke, and picking a toolbar swatch updates
  // Palette. No permission: like setTool, it is a tool
  // setting, not a board mutation, and a colour is not
  // a security-sensitive write. Changing it fires a
  // "pen" plugin event, so a listening plugin can follow
  // it without polling. Pen colour is session state, not
  // saved in board JSON.
  pen: {
    getColor: () => string;
    setColor: (hex: string) => boolean;
  };
  ui: {
    toast: (msg: string) => void;
    registerTool: (def: PluginToolDef) => void;
    registerPanel: (def: PluginPanelDef) => void;
    registerCommand: (def: PluginCommandDef) => void;
    // Offer an alternative to typing on double-click: the
    // core opens the text box as always, with the action's
    // icon beside it, and clicking the icon runs the action
    // at the note's position instead of typing.
    registerCreateAction: (def: PluginCreateActionDef) => void;
    // Every registered create action, with its plugin, so
    // the board view can offer them beside a new note. The
    // voice-notes plugin's Record action is one of these.
    listCreateActions: () => Array<PluginCreateActionDef & { pluginId: string }>;
    listCommands: () => Array<{ pluginId: string; pluginName: string; id: string; title: string }>;
    listTools: () => Array<{ pluginId: string; pluginName: string; id: string; title: string }>;
    // The full definition of a plugin tool by its full id
    // ("plugin:<pluginId>:<toolId>"), or null. The board
    // view reads the tool's pointer handlers from this to
    // drive a plugin tool. The current tool's id alone is
    // getTool; this is the definition behind it.
    getToolDef: (id: string) => (PluginToolDef & { pluginId: string; fullId: string }) | null;
    // Run a command by its plugin and id. A plugin runs
    // only its own commands — running another plugin's
    // command is rejected, so no plugin can make another
    // plugin act. The app's own UI is exempt: it dispatches
    // on the user's behalf. Listing commands (listCommands)
    // stays open to every plugin, so a palette can show
    // them; running them is what is restricted.
    runCommand: (pluginId: string, commandId: string) => Promise<void>;
    // Routing: the command palette is a list the user picks
    // from, not an executor. When the user picks a plugin
    // command, the palette reports the pick here and the host
    // runs the command as its owning plugin. Only the
    // command palette may call this; any other plugin gets
    // an error. A plugin runs its own commands with
    // runCommand.
    routeCommand: (pluginId: string, commandId: string) => Promise<void>;
    setTool: (id: string) => void;
    // The current tool id ("select", "pen", "connector", a
    // shape kind, or a plugin tool's full id). The toolbar
    // plugin highlights the active tool from this. Changing
    // the tool fires a "tool" plugin event.
    getTool: () => string;
    // Choose the selection mode (plain select or lasso) and
    // activate Select with it. The mode is remembered, so
    // the V shortcut and the select button restore the mode
    // last chosen instead of always plain select.
    setSelectMode: (mode: "select" | "lasso") => void;
    getSelectMode: () => "select" | "lasso";
    // Hand the plugin system the toolbar's tool container
    // (the #tools segment), so plugin tool buttons can be
    // added to it. The toolbar plugin provides this; other
    // plugins do not call it. Only the app's own UI may call
    // it — a plugin that tries is rejected.
    setToolbarToolsEl: (el: HTMLElement) => void;
    // Hand the plugin system the board DOM elements, built
    // by the core-board plugin: the board element itself,
    // the canvas layers (grid, SVG, cards, resize/rotate
    // handles), the plugin view, overlays, view switcher
    // and toast. The core reads them back through the
    // shell; it does not query them by id. The board plugin
    // provides these; other plugins do not call it. Only the
    // app's own UI may call it — a plugin that tries is
    // rejected.
    setBoardElements: (els: { board: HTMLElement; canvas: HTMLElement[]; pluginView: HTMLElement; overlays: HTMLElement; viewSwitcher: HTMLElement; toast: HTMLElement }) => void;
    // Hand the plugin system the panels toggle button, so
    // the plugin system can hide it when no plugin panels
    // exist and mark it active when a panel is open. The
    // title bar plugin provides this; other plugins do
    // not call it. Only the app's own UI may call it — a
    // plugin that tries is rejected.
    setPanelsToggleEl: (el: HTMLElement) => void;
    openSettings: () => void;
    closeSettings: () => void;
    isSettingsOpen: () => boolean;
    registerView: (def: PluginViewDef) => void;
    registerOverlay: (def: PluginOverlayDef) => void;
    registerSettingsSection: (def: PluginSettingsSectionDef) => void;
    // Re-render every registered settings section into the
    // settings container, so a settings UI can refresh after
    // a plugin is enabled or disabled.
    renderSettingsSections: () => void;
    registerShortcut: (def: PluginShortcutDef) => void;
    // Every shortcut a plugin registered, with its plugin,
    // so a settings UI can list them alongside the core's.
    listShortcuts: () => Array<{ pluginId: string; pluginName: string; key: string; title: string }>;
    // Offer a key to the shortcuts. A plugin dispatches
    // only its own: the key's owner is the plugin whose
    // handler would run, and dispatching another plugin's
    // shortcut is rejected. The board view — the app's own
    // UI — dispatches for keys no core handler claims, so a
    // plugin shortcut works anywhere on the board. False
    // when no shortcut is registered for the key.
    dispatchShortcut: (key: string) => boolean;
    // The board area element: the mount point for board
    // overlays. A UI plugin appends its overlay DOM here.
    boardEl: HTMLElement;
    // The settings plugin registers itself as the settings
    // UI here, so the core can open/close it without knowing
    // which plugin provides it. This is how a UI plugin
    // becomes the thing the core delegates to. Only the
    // app's own UI may call it — a plugin that tries is
    // rejected, so no plugin can replace the settings UI.
    registerSettingsUI: (ui: { open: () => void; close: () => void; isOpen: () => boolean; setTab: (tab: string) => void; refresh: () => void }) => void;
    // The settings plugin hands the plugin system the
    // container its settings sections render into, so
    // renderSettingsSections has somewhere to write. This
    // is how a UI plugin provides a shell element through
    // the API, instead of the core passing DOM in. Only the
    // app's own UI may call it — a plugin that tries is
    // rejected.
    setSettingsSectionsContainer: (el: HTMLElement) => void;
    // The search box container, built by the core-titlebar
    // plugin. The core-search plugin mounts its input,
    // count, clear button and results into it (read it
    // with getSearchBoxEl). Null until the title bar
    // plugin has activated. Only the app's own UI may call
    // it — a plugin that tries is rejected.
    setSearchBoxEl: (el: HTMLElement) => void;
    getSearchBoxEl: () => HTMLElement | null;
    showPanel: (id: string) => void;
    hidePanel: (id: string) => void;
    // Whether one of this plugin's panels is the active
    // (shown) panel in the dock. A plugin uses this to
    // show its board content only in the context it
    // belongs to — for example, a slide frame only while
    // its panel is open. False when the dock is closed,
    // even if the panel was last active.
    isPanelActive: (id: string) => boolean;
    getPanelElement: (id: string) => HTMLElement | null;
  };
  cards: {
    register: (def: PluginCardDef) => void;
    // Register a renderer for a built-in card kind (Text,
    // Image, Swatch, UrlCard, PdfCard, Audio, Video, Shape).
    // The core's card wrapper calls the registered renderer
    // for the kind. This is how the core-cards plugin provides
    // the built-in kinds; a user plugin could replace one.
    registerBuiltin: (def: PluginBuiltinCardDef) => void;
    // Register a decoration renderer: HTML shown under a
    // card, at its bottom edge (`{ id, side?, render(item) }`,
    // `side` "left" by default, "right" for the other corner;
    // returning HTML or null). The checklist progress is core,
    // decorator: a Text card with task lines always shows
    // n/m at the bottom right. The core calls each
    // decorator for every card on every render, so it must
    // be pure and fast, and it must escape any text it puts
    // in the HTML; the decoration never takes clicks.
    registerDecorator: (def: PluginCardDecoratorDef) => void;
    // Read the checklist progress of a Text card: how many
    // task lines are done over how many there are. Null when
    // the card is not a Text card or holds no task lines.
    // The progress is derived from the card's text, so this
    // is a pure read.
    getChecklistProgress: (item: Item) => { done: number; total: number } | null;
    // Set the checklist progress of a Text card: the first
    // `done` task lines are checked, the rest unchecked.
    // One undo step. Returns false when the card is not a
    // Text card or holds no task lines. Needs board:write.
    setChecklistProgress: (id: number, done: number) => boolean;
    // Is this card a frame (a transparent dashed border, not
    // a card)? True for a plugin card whose kind is declared
    // a frame in its manifest, or whose registered renderer
    // has frame: true. The manifest check holds even when
    // the plugin is disabled and no renderer is registered,
    // so a frame never rotates. False for built-in kinds.
    isFrame: (item: Item) => boolean;
    // Route a card action (a click on [data-plugin-action])
    // to the plugin that rendered the card. True when a
    // plugin card handled it. The board view calls this for
    // clicks on a plugin card's action button. A plugin
    // dispatches actions only on its own cards — dispatching
    // on another plugin's card is rejected, so no plugin can
    // run another plugin's action handler.
    dispatchAction: (action: string, item: Item) => boolean;
    // Route a double-click on a plugin card to the plugin
    // that rendered it. True when a plugin card handled it.
    // The board view calls this for double-clicks on a
    // plugin card. Same ownership rule as dispatchAction.
    dispatchDoubleClick: (item: Item) => boolean;
    // The Audio card's heights: a plain card (no transcript),
    // a card with a transcript hidden, and one with it shown.
    // A plugin that creates an audio card (voice notes)
    // sizes it from these instead of hardcoding them, so it
    // stays in step with the built-in renderer; the board
    // view resizes on the transcript toggle from them too.
    audioHeights: { plain: number; transcriptHidden: number; transcriptShown: number };
  };
  files: {
    // Embed a file as a board-owned copy. A File (from a
    // file input or a drop) is sent as bytes; a path must
    // already be board-local — the main process refuses any
    // other path, so a plugin cannot copy an arbitrary local
    // file into the board and then read it back.
    embedFile: (file: File | string) => Promise<string>;
    listLibrary: () => Promise<{ path: string; items: Array<{ name: string; path: string; relativePath: string; ext: string; kind: string; category: string | null; size_bytes: number; mtime_ms: number }>; categories: Array<{ name: string; count: number }>; uncategorizedCount: number }>;
    createLibraryCategory: (name: string) => Promise<string>;
    moveLibraryItem: (relativePath: string, category: string | null) => Promise<string>;
    fileUrl: (path: string) => string;
    readTextFile: (path: string) => Promise<string>;
    // Read a file as base64 with its MIME type, for the
    // board view's media fallback: when a board-local image
    // or video fails to load through the app-file scheme,
    // the card retries it once as a data URL.
    readFileBase64: (path: string) => Promise<{ mime: string; base64: string }>;
    fileSize: (path: string) => Promise<number>;
    openExternal: (target: string) => Promise<void>;
    fetchPreview: (url: string) => Promise<{ title: string | null; description: string | null; image: string | null; icon: string | null }>;
  };
  // AI chat completions, run in the main process (not the
  // renderer): a browser fetch from the renderer is subject
  // to the provider's CORS policy, and a local model server
  // is http, not https. The API key is never passed per
  // call and never held in the renderer: the main process
  // looks it up from its own store (see ai-has-key and
  // ai-set-key), so no plugin can read another plugin's
  // key through the bridge. Needs the "ai" permission.
  ai: {
    chat: (opts: { base: string; model: string; messages: Array<{ role: string; content: string }> }) => Promise<string>;
    hasKey: () => Promise<boolean>;
    setKey: (key: string) => Promise<boolean>;
  };
  storage: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  // Secure storage: for secrets, which survive restarts like
  // storage, but are encrypted by the OS keychain where the
  // OS can encrypt (macOS always can), and flagged plain
  // where it cannot. Same "storage" permission as storage:
  // a plugin that may store settings may store a secret
  // securely, but only its own secrets, never another
  // plugin's — the main process scopes by plugin id.
  secureStorage: {
    available: () => Promise<boolean>;
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<boolean>;
    delete: (key: string) => Promise<void>;
  };
  plugins: {
    // List every loaded plugin with its state, so a settings
    // UI can show them and toggle them. Read-only; no
    // permission needed.
    list: () => Array<{ id: string; name: string; version: string; description: string; core: boolean; required: boolean; active: boolean; failed: boolean; error: string | null; trial: boolean; frameKinds: string[] }>;
    // Enable or disable a plugin. This is plugin management,
    // so it needs the plugins:install permission, like
    // install. A trial plugin cannot be toggled this way.
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
    // Reset every plugin to its factory state: core plugins
    // on, extras off. A trial plugin is untouched (it is not
    // installed). This is plugin management, so it needs the
    // plugins:install permission.
    reset: () => Promise<void>;
    install: (plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string; styleCode: string }) => Promise<PluginManifest>;
    refresh: () => Promise<void>;
    // Try a plugin without installing it: it runs in memory only,
    // is never written to the plugins folder, and endTrial removes
    // it completely.
    try: (plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string; styleCode: string }) => Promise<PluginManifest>;
    endTrial: (id: string) => Promise<void>;
  };
  events: {
    on: (event: string, handler: () => void) => void;
    off: (event: string, handler: () => void) => void;
    // Fire a plugin event for every listener. The board view
    // emits "selection" and "tool" when they change, so the
    // toolbar and other UI can follow without polling. A
    // plugin may emit its own custom event the same way. A
    // core event name — board, camera, pen, saving, saved,
    // save-failed, selection, tool, view — is rejected: only
    // the core fires those, so no plugin can fake a state
    // change every other plugin and the core would act on.
    emit: (event: string) => void;
  };
  // Pure geometry, from src/backend/model.ts — no permission needed,
  // because these read nothing and write nothing. Plugins
  // used to copy these by hand (Presentation copied
  // rectCrossing and clipped ends), which drifted from
  // the core's versions; now there is one implementation.
  geometry: {
    centre: (item: Item) => Pt;
    anchorPoint: (anchor: Anchor) => Pt | null;
    rectCrossing: (from: Pt, to: Pt, pos: Pt, w: number, h: number, entry: boolean) => Pt | null;
    clippedEnds: (from: Anchor, to: Anchor) => [Pt, Pt] | null;
    segmentIntersectsRect: (a: Pt, b: Pt, rect: { x: number; y: number; w: number; h: number }) => boolean;
    rectsOverlap: (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => boolean;
    // An item's rotation in degrees (0 when it has none).
    itemRotation: (item: Item) => number;
    // An item's bounds on the board: its position and size,
    // or for a connector the box around its two ends. The
    // board view lays out and hit-tests from this.
    itemBounds: (item: Item) => [Pt, Size];
    // Rotate a point around a centre by degrees. The board
    // view rotates resize handles and corners with this.
    rotatePoint: (p: Pt, c: Pt, deg: number) => Pt;
    // The camera that fits the whole board into a viewport
    // (zoom capped at 1), or null on an empty board. The
    // board view's zoom-to-fit (F) uses this.
    fitCamera: (viewport: Size, padding?: number) => Camera | null;
  };
  // Media state, for the cards that play or preview media
  // (PdfCard, Audio). Read-only views of the core's media
  // module, plus the triggers that load a PDF page or an
  // audio duration on demand. No permission needed: these
  // read and trigger loads for board files the plugin can
  // already see. The raw audio element is never exposed;
  // getAudioState returns the derived playback state.
  media: {
    audioFailed: (path: string) => boolean;
    getAudioState: () => { id: number | null; playing: boolean; currentTime: number; duration: number };
    getAudioDuration: (path: string) => number | undefined;
    loadAudioDuration: (id: number, path: string) => void;
    // Waveform peaks for an audio card (100 bars, 0..1), from
    // a real decode of the file. Undefined until loaded.
    getAudioPeaks: (path: string) => number[] | undefined;
    loadAudioPeaks: (id: number, path: string) => Promise<void>;
    // Transcribe a recorded audio blob to text, on-device
    // (Whisper in the main process). Null when the audio
    // cannot be decoded or the model cannot run.
    transcribeAudio: (blob: Blob) => Promise<string | null>;
    formatAudioTime: (sec: number) => string;
    // Toggle playback of an audio card: play it if it is not
    // playing, pause it if it is. The board view's play button.
    toggleAudio: (id: number, path: string) => void;
    // Show the live <video> element for a video card. The
    // board view's play button on a poster. At most one card
    // is live; playing another moves it there.
    playVideo: (id: number) => void;
    getVideoState: () => { id: number | null };
    // Seek the playing audio card to a time in seconds.
    // No-op when that card is not the one playing.
    seekAudio: (id: number, time: number) => void;
    // Seek an audio card to a time in seconds, whether or
    // not it is playing: a card that is not playing loads
    // paused at that time, so play starts there.
    seekAudioTo: (id: number, path: string, time: number) => void;
    pdfFailed: (path: string) => boolean;
    getPdfPage: (id: number) => number;
    loadPdfPage: (id: number, path: string) => void;
    // Heal a FileCard saved at the stale height: measure its
    // preview and shrink the card to the ratio of the file
    // when it is still wrong.
    loadFileCardSize: (preview: string) => void;
    loadVideoCardSize: (poster: string) => void;
    // The first page's size in points, for sizing a PDF card
    // to its page. Null when the file cannot be read.
    probePdfSize: (path: string) => Promise<{ w: number; h: number } | null>;
    // Heal a PdfCard saved at the stale fixed size: measure
    // its first page and resize the card to the ratio of the
    // page when it is still wrong.
    loadPdfCardSize: (path: string) => void;
    // Heal a UrlCard saved at the stale fixed size: measure
    // its preview image and resize the card to the ratio of
    // the image when it is still wrong.
    loadLinkCardSize: (image: string) => void;
    // Move a PDF card to a page (clamped to the document),
    // and render it. The board view's prev/next buttons.
    // False when the document is not loaded yet.
    setPdfPage: (id: number, path: string, page: number) => Promise<boolean>;
  };
  // Pure text and colour helpers, from src/backend/model.ts — no
  // permission needed. A card renderer needs these to escape
  // text, render markdown, and colour link tiles, the way
  // the core's renderers did. One implementation, so a
  // plugin's cards match the core's exactly.
  text: {
    escapeHtml: (s: string) => string;
    renderMarkdownHtml: (text: string, baseSize: number) => string;
    domainOf: (url: string) => string;
    elide: (s: string, widthPx: number, textPx: number, bold: boolean) => string;
    tileColorFor: (domain: string) => string;
    tint: (hex: string, whiteMix: number) => string;
    // A hex colour to its RGB triple, or null when it is not
    // a valid 3- or 6-digit hex. The board view parses the
    // canvas background with it.
    parseHex: (hex: string) => [number, number, number] | null;
    // Toggle one task line ("- [ ]" to "- [x]" and back), or
    // null when the line is not a task line. The board view
    // toggles the line a click landed on, then writes the
    // text back through setTextContent.
    toggleTaskLine: (line: string) => string | null;
  };
}

// The shell: the DOM elements the plugin system manages
// (panels dock, toolbar tools, plugin view, view switcher,
// overlays, settings sections). These are built and owned by
// the UI plugin, not by the core. The core used to pass them
// in through PluginHost; now the UI plugin registers them
// here, so the core never owns UI DOM. Until a UI plugin
// registers them, the plugin system has nowhere to render
// panels, views or tools — that is the visible proof the
// core renders nothing on its own.
export interface ShellElements {
  // The board element (#board), built by the core-board
  // plugin. The core reads it back through the shell; it
  // does not query it by id.
  boardEl: HTMLElement;
  toolbarToolsEl: HTMLElement;
  panelsEl: HTMLElement;
  panelsToggleEl: HTMLElement;
  pluginViewEl: HTMLElement;
  boardCanvasEls: HTMLElement[];
  viewSwitcherEl: HTMLElement;
  overlaysEl: HTMLElement;
  settingsSectionsEl: HTMLElement;
  // The toast element, built by the core-board plugin.
  // The core's toast() writes into it.
  toastEl: HTMLElement;
  // The search box container, built by the core-titlebar
  // plugin. The core-search plugin mounts its input,
  // count, clear button and results into it.
  searchBoxEl: HTMLElement;
}

// The settings UI: the settings window is a plugin (see
// core-settings), so the core cannot open it directly. The
// plugin registers its open/close/isOpen here, and the core
// delegates through these functions. Until a settings plugin
// is active, opening settings is a no-op.
export interface SettingsUI {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  setTab: (tab: string) => void;
  // Re-render the canvas options (and meta) to match the
  // current board, e.g. after an undo changed the board's
  // background or grid.
  refresh: () => void;
}

// The board controller: the board view (core-board plugin)
// owns the render loop and the input loop, so the core
// cannot call them directly. The plugin registers its
// controller here, and the core delegates through these
// functions — the same shape as the settings UI above.
// Until the board plugin activates, every call is a no-op:
// the board does not exist yet, so there is nothing to
// render, select, edit or tool-switch.
export interface BoardController {
  render: () => void;
  updateSelection: () => void;
  commitEditing: () => void;
  clearEditing: () => void;
  getEditingId: () => number | null;
  setTool: (tool: string) => void;
  getTool: () => string;
  setSelectMode: (mode: "select" | "lasso") => void;
  getSelectMode: () => "select" | "lasso";
  groupSelected: () => boolean;
  ungroupSelected: () => boolean;
  deleteSelected: () => boolean;
  // Draw a plugin drag tool's live preview stroke. The core
  // calls this through api.board.previewStroke; the board
  // view owns the preview layer, so only it can draw there.
  previewStroke: (points: Pt[], pressures: number[], opts?: PluginPreviewStrokeOptions) => void;
  // Draw a plugin drag tool's live shape preview, in the
  // same layer. The core calls this through
  // api.board.previewShape; the board view owns the preview
  // layer, so only it can draw there.
  previewShape: (shape: string, x0: number, y0: number, w: number, h: number, opts?: PluginPreviewShapeOptions) => void;
}

