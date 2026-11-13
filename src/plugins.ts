// Bowerbird Plugin API v1 — renderer side (see PLUGIN_API.md).
//
// A plugin is a folder with a manifest.json and a main.js
// module. A plugin may be multiple files: main.js is loaded
// as an ES module over the plugin: scheme, so its relative
// imports resolve against its own folder, exactly like a
// first-party plugin. The main process discovers plugins and
// serves their files through IPC and the plugin: scheme; this
// module loads them, builds the per-plugin API object, and owns
// the registries for cards, tools, panels, views and commands. The core (src/main.ts) owns the board
// state and the DOM; it passes a Host with closures over that state
// into initPlugins, and calls back into this module at the points
// where a plugin can contribute (card rendering, tool clicks,
// double-clicks, card actions, search text, toolbar state, render).
//
// Trust model, stated honestly: a locally installed plugin runs in
// the renderer with this API object. It does not get Node or the
// filesystem directly — every privileged call goes through the
// preload bridge — but it does run in the same renderer as the
// core, so installing a plugin is trusting its code, like an
// Obsidian or VS Code extension. The API is the supported
// contract; reaching past it into core DOM is unsupported and may
// break. A future version may sandbox panels and views harder;
// v1 does not pretend otherwise.

import type { Anchor, ArrangeOptions, Board, Camera, Item, Kind, Pt, Size } from "./model";
import { anchorPoint, arrangeItems, boardGet, centre, checklistProgress, clippedEnds, domainOf, elide, escapeHtml, itemRotation, rectCrossing, renderMarkdownHtml, segmentIntersectsRect, setChecklistDone, tileColorFor, tint } from "./model";

// ---------------------------------------------------------------- types

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
  openBackupsFolder(): Promise<string>;
  listPlugins(): Promise<PluginManifest[]>;
  readPluginFile(pluginId: string, relativePath: string): Promise<string>;
  getPluginEnabled(): Promise<Record<string, boolean>>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean>;
  installPlugin(plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string; styleCode: string }): Promise<PluginManifest>;
  pluginStorageGet(pluginId: string, key: string): Promise<unknown>;
  pluginStorageSet(pluginId: string, key: string, value: unknown): Promise<void>;
  pluginStorageDelete(pluginId: string, key: string): Promise<void>;
  listBoards: () => Promise<Array<{ name: string; current: boolean; items: number }>>;
  factoryReset(): Promise<{ ok: boolean }>;
  createBoard: (name: string) => Promise<{ name: string }>;
  renameBoard: (oldName: string, newName: string) => Promise<{ name: string }>;
  deleteBoard: (name: string) => Promise<{ wasCurrent: boolean }>;
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
  getAppSettings: () => Promise<{ corner: string; panelOrder?: string[]; panelWidth?: number }>;
  setPanelWidth: (width: number) => Promise<number>;
  setCorner: (corner: string) => Promise<string>;
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
  updateItem: (id: number, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown; tags?: string[] }) => boolean;
  updateItems: (patches: Array<{ id: number; pos?: Pt; size?: Size; group?: number | null; data?: unknown; tags?: string[] }>) => boolean;
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
  // Rename a group's section label. One save, one undo
  // step. False when the group has fewer than two members
  // or the label is empty after trimming.
  setGroupLabel: (group: number, label: string) => boolean;
  save: () => void;
  // Save the board to disk without creating an undo step,
  // for changes the user did not make as edits: a pan's
  // camera move, a click's re-stack, a link preview
  // filling in. The file still saves, so closing the
  // window keeps the change; undo never steps to it.
  saveWithoutUndo: () => void;
  render: () => void;
  switchBoard: (name: string, preserveUndo?: boolean) => Promise<boolean>;
  setTool: (tool: string) => void;
  getTool: () => string;
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
  getBuildId: () => string;
  // ---- media (for the cards that play or preview media) ----
  getAudioState: () => { id: number | null; playing: boolean; currentTime: number; duration: number };
  getAudioDuration: (path: string) => number | undefined;
  loadAudioDuration: (id: number, path: string) => void;
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
  // Seek the playing audio card to a time in seconds. The
  // board view's seek slider. No-op when that card is not
  // the one playing.
  seekAudio: (id: number, time: number) => void;
  getPdfPage: (id: number) => number;
  loadPdfPage: (id: number, path: string) => void;
  // Move a PDF card to a page (clamped to the document),
  // and render it. The board view's prev/next buttons.
  // False when the document is not loaded yet.
  setPdfPage: (id: number, path: string, page: number) => Promise<boolean>;
  pdfFailed: (path: string) => boolean;
  // Reset the board to a fresh welcome board (the settings
  // "Delete all board data" flow). A board write, and not
  // available to a trial plugin.
  resetBoard: () => Promise<boolean>;
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
    renderCard: (id: number) => string | null;
    // Render a board item exactly as the board renders it,
    // at its real position and with its selection and
    // editing state. The board view builds the card DOM
    // from this. Unlike renderCard (position 0,0, plain,
    // for embedding a card in a panel or view), this is
    // the card as it appears on the board.
    renderCardAt: (id: number) => string | null;
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
    // Rename a group's section label. One save, one undo
    // step. False when the group has fewer than two members
    // or the label is empty after trimming.
    setGroupLabel: (group: number, label: string) => boolean;
    getSelected: () => number[];
    setSelected: (ids: number[]) => void;
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
    updateItem: (id: number, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown; tags?: string[] }) => boolean;
    updateItems: (patches: Array<{ id: number; pos?: Pt; size?: Size; group?: number | null; data?: unknown; tags?: string[] }>) => boolean;
    moveItem: (id: number, toIndex: number) => boolean;
    removeItem: (id: number) => boolean;
    save: () => void;
    // Save the board to disk without creating an undo step,
    // for changes the user did not make as edits: a pan's
    // camera move, a click's re-stack, a link preview
    // filling in. The file still saves, so closing the
    // window keeps the change; undo never steps to it.
    saveWithoutUndo: () => void;
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
    reset: () => Promise<boolean>;
    // The board's folder on disk, for display (the settings
    // "Board folder" line). Read-only.
    getDir: () => string;
  };
  boards: {
    list: () => Promise<Array<{ name: string; current: boolean; items: number }>>;
    current: () => Promise<string>;
    create: (name: string) => Promise<{ name: string }>;
    switch: (name: string, preserveUndo?: boolean) => Promise<boolean>;
    rename: (oldName: string, newName: string) => Promise<{ name: string }>;
    delete: (name: string) => Promise<{ wasCurrent: boolean }>;
  };
  // The app itself: build id and platform. Read-only; a plugin
  // that shows a version uses these.
  // factoryReset wipes everything the app has saved (boards,
  // settings, plugins, plugin storage, secure storage) and is a
  // board write, not available to a trial plugin. The caller
  // reloads after it returns, so the fresh defaults load.
  app: {
    getBuildId: () => string;
    getPlatform: () => string;
    factoryReset: () => Promise<{ ok: boolean }>;
  };
  // Backups: list them (newest first) and restore one. A
  // restore loads the backup's board into the app, like
  // boards.switch, so it needs board:write and is not
  // available to a trial plugin. openFolder opens the
  // backups folder in the file explorer, so an older
  // backup can be reached even though the UI lists only
  // the newest one.
  backups: {
    list: () => Promise<Array<{ name: string; items: number; size: number }>>;
    restore: (name: string) => Promise<boolean>;
    openFolder: () => Promise<string>;
  };
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
    // engine has no box to operate on.
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
    listCommands: () => Array<{ pluginId: string; pluginName: string; id: string; title: string }>;
    listTools: () => Array<{ pluginId: string; pluginName: string; id: string; title: string }>;
    runCommand: (pluginId: string, commandId: string) => Promise<void>;
    setTool: (id: string) => void;
    // The current tool id ("select", "pen", "connector", a
    // shape kind, or a plugin tool's full id). The toolbar
    // plugin highlights the active tool from this. Changing
    // the tool fires a "tool" plugin event.
    getTool: () => string;
    // Hand the plugin system the toolbar's tool container
    // (the #tools segment), so plugin tool buttons can be
    // added to it. The toolbar plugin provides this; other
    // plugins do not call it.
    setToolbarToolsEl: (el: HTMLElement) => void;
    // Hand the plugin system the board DOM elements, built
    // by the core-board plugin: the board element itself,
    // the canvas layers (grid, SVG, cards, resize/rotate
    // handles), the plugin view, overlays, view switcher
    // and toast. The core reads them back through the
    // shell; it does not query them by id. The board plugin
    // provides these; other plugins do not call it.
    setBoardElements: (els: { board: HTMLElement; canvas: HTMLElement[]; pluginView: HTMLElement; overlays: HTMLElement; viewSwitcher: HTMLElement; toast: HTMLElement }) => void;
    // Hand the plugin system the panels toggle button, so
    // the plugin system can hide it when no plugin panels
    // exist and mark it active when a panel is open. The
    // title bar plugin provides this; other plugins do
    // not call it.
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
    // The board area element: the mount point for board
    // overlays. A UI plugin appends its overlay DOM here.
    boardEl: HTMLElement;
    // The settings plugin registers itself as the settings
    // UI here, so the core can open/close it without knowing
    // which plugin provides it. This is how a UI plugin
    // becomes the thing the core delegates to.
    registerSettingsUI: (ui: { open: () => void; close: () => void; isOpen: () => boolean; setTab: (tab: string) => void; refresh: () => void }) => void;
    // The settings plugin hands the plugin system the
    // container its settings sections render into, so
    // renderSettingsSections has somewhere to write. This
    // is how a UI plugin provides a shell element through
    // the API, instead of the core passing DOM in.
    setSettingsSectionsContainer: (el: HTMLElement) => void;
    // The search box container, built by the core-titlebar
    // plugin. The core-search plugin mounts its input,
    // count, clear button and results into it (read it
    // with getSearchBoxEl). Null until the title bar
    // plugin has activated.
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
    // card, at its bottom edge — tags bottom-left
    // (`{ id, side?, render(item) }`, `side` "left" by
    // default, "right" for the other corner; returning HTML
    // or null). The checklist progress is core, not a
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
  };
  tags: {
    // Every tag used on the board, sorted.
    list: () => string[];
    // The tags on one card, in the order they were added.
    get: (id: number) => string[];
    // Add a tag to one card. Validated the same way as an
    // updateItem tags patch (trimmed, de-duplicated, at most
    // 20); an empty tag or a duplicate adds nothing. One
    // undo step. Needs board:write.
    add: (id: number, tag: string) => boolean;
    // Remove a tag from one card. One undo step. False when
    // the card has no such tag. Needs board:write.
    remove: (id: number, tag: string) => boolean;
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
  };
  // Pure geometry, from src/model.ts — no permission needed,
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
    // Transcribe a recorded audio blob to text, on-device
    // (Whisper in the main process). Null when the audio
    // cannot be decoded or the model cannot run.
    transcribeAudio: (blob: Blob) => Promise<string | null>;
    formatAudioTime: (sec: number) => string;
    // Toggle playback of an audio card: play it if it is not
    // playing, pause it if it is. The board view's play button.
    toggleAudio: (id: number, path: string) => void;
    // Seek the playing audio card to a time in seconds. The
    // board view's seek slider. No-op when that card is not
    // the one playing.
    seekAudio: (id: number, time: number) => void;
    pdfFailed: (path: string) => boolean;
    getPdfPage: (id: number) => number;
    loadPdfPage: (id: number, path: string) => void;
    // Move a PDF card to a page (clamped to the document),
    // and render it. The board view's prev/next buttons.
    // False when the document is not loaded yet.
    setPdfPage: (id: number, path: string, page: number) => Promise<boolean>;
  };
  // Pure text and colour helpers, from src/model.ts — no
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
  };
}

interface LoadedPlugin {
  manifest: PluginManifest;
  // First-party (core) plugins are bundled with the app and
  // build the app's own UI; the rest are user plugins. The
  // flag is exposed in plugins.list() so Settings can group
  // them, and so a plugin can tell core UI apart from extras.
  firstParty?: boolean;
  // A first-party plugin's module is a bundled import, not
  // a file on disk, so it cannot be re-loaded from the
  // plugin: scheme. It is kept here across deactivation so
  // re-enabling the plugin re-activates the same module
  // instead of fetching a URL that does not exist.
  firstPartyModule?: { activate?: (api: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> } | null;
  // Trial plugins run in memory only (see tryPlugin): they are
  // never written to disk, and endTrial removes them entirely.
  trial?: boolean;
  active: boolean;
  failed: boolean;
  error: string | null;
  module: { activate?: (api: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> } | null;
}

// ---------------------------------------------------------------- state

const cards = new Map<string, PluginCardDef & { pluginId: string }>();
const builtinCards = new Map<string, PluginBuiltinCardDef & { pluginId: string }>();
// Card decorations: a plugin registers a renderer that
// returns HTML shown inside a card, at its bottom edge
// (tags bottom-left, checklist progress bottom-right).
// Decorations are display only — they never take clicks
// (pointer-events: none in styles.css) and never write. A
// renderer that throws renders nothing.
const cardDecorators = new Map<string, PluginCardDecoratorDef & { pluginId: string }>();
export function getCardDecorations(item: Item): { left: string; right: string } {
  let left = "";
  let right = "";
  for (const def of cardDecorators.values()) {
    try {
      const html = def.render(item);
      if (!html) continue;
      if (def.side === "right") right += html; else left += html;
    } catch { /* a broken decorator renders nothing */ }
  }
  return { left, right };
}

// Whether a card decorator is registered, by its full id
// ("<pluginId>:<decoratorId>"). The core uses this for
// affordances that belong to a decorator: the "+ tag"
// button shows only while the Tags plugin's decorator is
// registered, so disabling Tags hides it too.
export function hasCardDecorator(id: string): boolean {
  return cardDecorators.has(id);
}
const tools = new Map<string, PluginToolDef & { pluginId: string; fullId: string }>();
const panels = new Map<string, PluginPanelDef & { pluginId: string; el: HTMLElement; body: HTMLElement; tab: HTMLElement; hidden: boolean }>();
const views = new Map<string, PluginViewDef & { pluginId: string }>();
const commands = new Map<string, PluginCommandDef & { pluginId: string }>();
const createActions = new Map<string, PluginCreateActionDef & { pluginId: string }>();
const overlays = new Map<string, PluginOverlayDef & { pluginId: string; el: HTMLElement }>();
const settingsSections = new Map<string, PluginSettingsSectionDef & { pluginId: string }>();
const shortcuts = new Map<string, PluginShortcutDef & { pluginId: string }>();
const loaded = new Map<string, LoadedPlugin>();
const listeners = new Map<string, Set<() => void>>();

let host: PluginHost | null = null;
let bridge: PluginBridge | null = null;
let activeView = "board";
let pluginsReady = false;

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
const shell: Partial<ShellElements> = {};
export function registerShellElements(els: Partial<ShellElements>): void {
  Object.assign(shell, els);
}

// Read the board DOM elements the core-board plugin built
// (the board element, the canvas layers, the plugin view,
// overlays, view switcher and toast). The core reads them
// after the board plugin activates; before that they are
// undefined. The core never queries them by id.
export function getBoardElements(): { board?: HTMLElement; canvas?: HTMLElement[]; pluginView?: HTMLElement; overlays?: HTMLElement; viewSwitcher?: HTMLElement; toast?: HTMLElement } {
  return {
    board: shell.boardEl,
    canvas: shell.boardCanvasEls,
    pluginView: shell.pluginViewEl,
    overlays: shell.overlaysEl,
    viewSwitcher: shell.viewSwitcherEl,
    toast: shell.toastEl,
  };
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
let settingsUI: SettingsUI | null = null;
export function registerSettingsUI(ui: SettingsUI): void {
  settingsUI = ui;
}
export function openSettingsUI(): void {
  settingsUI?.open();
}
export function closeSettingsUI(): void {
  settingsUI?.close();
}
export function isSettingsUIOpen(): boolean {
  return settingsUI?.isOpen() ?? false;
}
export function setSettingsUITab(tab: string): void {
  settingsUI?.setTab(tab);
}
export function refreshSettingsUI(): void {
  settingsUI?.refresh();
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
  groupSelected: () => boolean;
  ungroupSelected: () => boolean;
  deleteSelected: () => boolean;
}
let boardController: BoardController | null = null;
export function registerBoardController(c: BoardController): void {
  boardController = c;
}
export function getBoardController(): BoardController | null {
  return boardController;
}
export function boardRender(): void {
  boardController?.render();
}
export function boardUpdateSelection(): void {
  boardController?.updateSelection();
}
export function boardCommitEditing(): void {
  boardController?.commitEditing();
}
export function boardClearEditing(): void {
  boardController?.clearEditing();
}
export function boardGetEditingId(): number | null {
  return boardController?.getEditingId() ?? null;
}
export function boardSetTool(tool: string): void {
  boardController?.setTool(tool);
}
export function boardGetTool(): string {
  return boardController?.getTool() ?? "select";
}
export function boardGroupSelected(): boolean {
  return boardController?.groupSelected() ?? false;
}
export function boardUngroupSelected(): boolean {
  return boardController?.ungroupSelected() ?? false;
}
export function boardDeleteSelected(): boolean {
  return boardController?.deleteSelected() ?? false;
}

// Panel tabs state: one panel shown at a time, switched by
// its tab. `hidden` is the showPanel/hidePanel state (a
// panel with no tab); `activePanelKey` is which shown panel
// is on screen. `dockVisible` is the tab-bar close and
// title-bar toggle state — the dock can be closed while
// panels are still shown, so it can be reopened with its
// tabs and active panel intact.
let activePanelKey: string | null = null;
let dockVisible = true;
let panelWidth = 290;
let tabsEl: HTMLElement | null = null;
let tabsListEl: HTMLElement | null = null;
let tabsToggleWired = false;
// Tab drag state: a tab drag is a reorder, not a click, so
// the click that fires after mouseup must be suppressed when
// the pointer actually moved. The saved order is the tab
// DOM order, so a dragged tab stays where the user left it
// across restarts, and a new panel appends at the end.
let tabDrag: { key: string; startX: number; dragged: boolean } | null = null;
let suppressTabClick = false;

function applyPanelOrder(): void {
  if (!host || !tabsListEl) return;
  const order = host.getPanelOrder();
  if (order.length === 0) return;
  const sorted = Array.from(panels.entries()).sort((a, b) => {
    const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
    if (ia < 0 && ib < 0) return 0;
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
  panels.clear();
  for (const [key, p] of sorted) {
    panels.set(key, p);
    tabsListEl.appendChild(p.tab);
  }
}

function panelDomOrder(): string[] {
  if (!tabsListEl) return [];
  const keys: string[] = [];
  for (const child of Array.from(tabsListEl.children)) {
    for (const [key, p] of panels.entries()) {
      if (p.tab === child) keys.push(key);
    }
  }
  return keys;
}

function wirePanelsToggle(): void {
  // Title-bar toggle, wired once: it lives outside the
  // dock, so it is still there when the dock is closed,
  // and is how a closed dock comes back.
  if (!host || !shell.panelsToggleEl || tabsToggleWired) return;
  tabsToggleWired = true;
  shell.panelsToggleEl.addEventListener("click", () => {
    if (Array.from(panels.values()).every((p) => p.hidden)) return;
    setDockVisible(!dockVisible);
    host?.render();
  });
}

// The dock is resizable: a thin handle on its left edge. Drag
// left to widen, right to narrow; the width is clamped to
// 200–600px and saved when the drag ends, so it survives a
// restart. The handle lives inside the dock, so the board's
// own mousedown never sees it.
function ensureResizeHandle(): void {
  if (!host || !shell.panelsEl || shell.panelsEl.querySelector(".panel-resize-handle")) return;
  const handle = document.createElement("div");
  handle.className = "panel-resize-handle";
  handle.title = "Drag to resize panels";
  handle.setAttribute("aria-label", "Resize panels");
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMove = (ev: MouseEvent) => {
      // The dock is on the right edge: dragging left widens it.
      const next = Math.min(600, Math.max(200, startWidth - (ev.clientX - startX)));
      panelWidth = next;
      if (shell.panelsEl) shell.panelsEl.style.width = `${next}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      void bridge?.setPanelWidth(panelWidth);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  shell.panelsEl.appendChild(handle);
}

function ensureTabsBar(): void {
  if (!host || tabsEl) return;
  tabsEl = document.createElement("div");
  tabsEl.id = "plugin-tabs";
  tabsEl.className = "plugin-tabs";
  tabsListEl = document.createElement("div");
  tabsListEl.className = "plugin-tabs-list";
  const close = document.createElement("button");
  close.className = "plugin-tabs-close";
  close.textContent = "×";
  close.title = "Hide panels";
  close.setAttribute("aria-label", "Hide panels");
  close.addEventListener("click", () => {
    setDockVisible(false);
    host?.render();
  });
  tabsEl.appendChild(tabsListEl);
  tabsEl.appendChild(close);
  shell.panelsEl?.appendChild(tabsEl);
  wirePanelsToggle();
}

function visiblePanels(): Array<[string, PluginPanelDef & { pluginId: string; el: HTMLElement; body: HTMLElement; tab: HTMLElement; hidden: boolean }]> {
  return Array.from(panels.entries()).filter(([, p]) => !p.hidden);
}

function updatePanelDock(): void {
  if (!host) return;
  const visible = visiblePanels();
  const open = dockVisible && visible.length > 0;
  if (shell.panelsEl) shell.panelsEl.style.width = open ? `${panelWidth}px` : "0px";
  if (tabsEl) tabsEl.style.display = open ? "" : "none";
  for (const [key, p] of panels.entries()) {
    const active = !p.hidden && key === activePanelKey;
    p.tab.style.display = p.hidden ? "none" : "";
    p.tab.classList.toggle("active", active);
    p.el.style.display = active ? "" : "none";
  }
  if (shell.panelsToggleEl) {
    shell.panelsToggleEl.classList.toggle("active", open);
    // No plugin panels at all: the toggle has nothing to
    // show, so it is hidden, not dimmed. A dimmed button
    // that does nothing reads as broken; and the toggle
    // stays visible whenever panels exist, even with the
    // dock closed — that is how a closed dock comes back.
    shell.panelsToggleEl.style.display = visible.length === 0 ? "none" : "";
  }
}

function setActivePanel(key: string): void {
  const p = panels.get(key);
  if (!p || p.hidden) return;
  // The board re-renders when the active panel changes,
  // so a plugin whose board content depends on its panel
  // being open — a slide frame, for example — appears and
  // disappears with the panel. Clicking the already-active
  // tab changes nothing, so it renders nothing. No render
  // while plugins are still loading: the board renders once
  // after they all activate.
  const prev = activePanelKey;
  activePanelKey = key;
  updatePanelDock();
  if (pluginsReady && prev !== key) host?.render();
}

function setDockVisible(visible: boolean): void {
  // Same as setActivePanel: closing the dock leaves no
  // panel open, so panel-dependent board content hides,
  // and opening it shows it again.
  const prev = dockVisible;
  dockVisible = visible;
  updatePanelDock();
  if (pluginsReady && prev !== visible) host?.render();
}

export function pluginsLoaded(): boolean {
  return pluginsReady;
}

export function listLoadedPlugins(): LoadedPlugin[] {
  return Array.from(loaded.values());
}

// ---------------------------------------------------------------- events

export function emitPluginEvent(event: string): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try {
      fn();
    } catch {
      // A plugin event handler must never break the core.
    }
  }
}

function onEvent(event: string, handler: () => void): void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(handler);
}

function offEvent(event: string, handler: () => void): void {
  listeners.get(event)?.delete(handler);
}

// ---------------------------------------------------------------- helpers

function domId(pluginId: string, kind: string, id: string): string {
  return `${kind}-plugin-${pluginId}-${id}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

function requirePerm(manifest: PluginManifest, perm: string): void {
  const perms = manifest.permissions ?? [];
  if (perms.includes(perm)) return;
  throw new Error(`Plugin ${manifest.id} lacks permission ${perm}`);
}

function isPluginCard(item: Item): item is Item & { kind: { Plugin: { plugin: string; kind: string; data: unknown } } } {
  return "Plugin" in item.kind;
}

// ---------------------------------------------------------------- API builder

function createContext(manifest: PluginManifest, opts?: { trial?: boolean }): PluginContext {
  const pluginId = manifest.id;
  const trial = !!opts?.trial;
  const require = (perm: string) => requirePerm(manifest, perm);
  // A trial plugin is still a plugin, so it runs with the same
  // permission checks as an installed one — but it must not be
  // able to make anything permanent while it is only being
  // tried: no installing other plugins, and no creating,
  // renaming, switching or deleting boards. Board writes it
  // does make (adding or deleting cards) are undoable, like
  // any board write, and the Builder panel says so while
  // a trial is running.
  const requireNotTrial = (what: string) => {
    if (trial) throw new Error(`a plugin being tried cannot ${what}`);
  };
  return {
    version: "2",
    plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
    has: (capability: string) => {
      // Capabilities in v1: every domain documented in PLUGIN_API.md.
      // A future core may add more; a plugin should check before
      // using a capability that was added after v1.
      return ["board", "boards", "app", "backups", "view", "window", "ui", "cards", "files", "storage", "events", "tools", "panels", "commands", "views", "overlays", "settingsSections", "shortcuts", "library", "plugins", "pen", "media", "text", "geometry", "shapes"].includes(capability);
    },
    board: {
      get: () => {
        const b = host!.getBoard();
        return JSON.parse(JSON.stringify(b)) as Board;
      },
      getItems: () => JSON.parse(JSON.stringify(host!.getBoard().items)) as Item[],
      getItem: (id: number) => {
        const it = host!.getBoard().items.find((i) => i.id === id);
        return it ? (JSON.parse(JSON.stringify(it)) as Item) : undefined;
      },
      // Render a board item exactly as the board renders it, at
      // position 0,0 and with no selection or editing state, so a
      // plugin can show the same card in a panel or view. A plugin
      // can already read the item via getItems, so this needs no
      // extra permission; strokes and connectors render as null.
      renderCard: (id: number) => host!.renderBoardCard(id),
      // The same card as it appears on the board: real position,
      // selection state and editing exclusion. The board view
      // builds the card DOM from this; a plugin embedding a card
      // elsewhere uses renderCard instead.
      renderCardAt: (id: number) => host!.renderBoardCardAt(id),
      hitTest: (world: Pt) => host!.hitTest(world),
      marqueeSelect: (a: Pt, b: Pt) => host!.marqueeSelect(a, b),
      lassoSelect: (points: Pt[]) => host!.lassoSelect(points),
      strokesNear: (point: Pt, radius: number) => host!.strokesNear(point, radius),
      moveItems: (ids: number[], dx: number, dy: number) => {
        require("board:write");
        host!.moveItems(ids, dx, dy);
      },
      resizeItem: (id: number, w: number, h: number) => {
        require("board:write");
        host!.resizeItem(id, w, h);
      },
      setItemRotation: (id: number, rot: number) => {
        require("board:write");
        host!.setItemRotation(id, rot);
      },
      removeItems: (ids: number[]) => {
        require("board:write");
        host!.removeItems(ids);
      },
      bringToFront: (ids: number[]) => {
        require("board:write");
        host!.bringToFront(ids);
      },
      setTextContent: (id: number, text: string) => {
        require("board:write");
        return host!.setTextContent(id, text);
      },
      createGroup: (ids: number[]) => {
        require("board:write");
        return host!.createGroup(ids);
      },
      setGroupLabel: (group: number, label: string) => {
        require("board:write");
        return host!.setGroupLabel(group, label);
      },
      getSelected: () => host!.getSelected(),
      setSelected: (ids: number[]) => host!.setSelected(ids),
      addItem: (kind: Kind, pos: Pt, size: Size) => {
        require("board:write");
        const id = host!.addItem(kind, pos, size);
        return id;
      },
      addItemSilent: (kind: Kind, pos: Pt, size: Size) => {
        require("board:write");
        return host!.addItemSilent(kind, pos, size);
      },
      addPluginCard: (kind: string, data: unknown, pos: Pt, size: Size) => {
        require("board:write");
        const id = host!.addItem({ Plugin: { plugin: pluginId, kind, data } }, pos, size);
        return id;
      },
      addItems: (items: Array<{ kind: Kind; pos: Pt; size: Size }>) => {
        require("board:write");
        return host!.addItems(items);
      },
      arrange: (ids: number[], options: ArrangeOptions) => {
        require("board:write");
        const patches = arrangeItems(host!.getBoard(), ids, options);
        if (patches.length === 0) return false;
        return host!.updateItems(patches);
      },
      connect: (fromId: number, toId: number, options?: { color?: string }) => {
        require("board:write");
        const board = host!.getBoard();
        const from = boardGet(board, fromId);
        const to = boardGet(board, toId);
        if (!from || !to) return null;
        // The connector's pos/size is the bounding box of the
        // line between the two card centres, the same box the
        // connector tool uses when it draws one by hand.
        const a = centre(from);
        const b = centre(to);
        const pos = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
        const size = { w: Math.max(1, Math.abs(b.x - a.x)), h: Math.max(1, Math.abs(b.y - a.y)) };
        return host!.addItem(
          { Connector: { from: { Item: fromId }, to: { Item: toId }, color: options?.color ?? "#333333" } },
          pos,
          size
        );
      },
      updateItem: (id: number, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown; tags?: string[] }) => {
        require("board:write");
        // A plugin may only rewrite its own plugin card data. Core
        // pos/size/group edits are allowed for any card, because
        // moving a card is not editing its content.
        if (patch.data !== undefined) {
          const it = host!.getBoard().items.find((i) => i.id === id);
          if (!it || !isPluginCard(it) || it.kind.Plugin.plugin !== pluginId) {
            throw new Error(`Plugin ${pluginId} cannot edit another plugin's card data`);
          }
        }
        const ok = host!.updateItem(id, patch);
        return ok;
      },
      updateItems: (patches: Array<{ id: number; pos?: Pt; size?: Size; group?: number | null; data?: unknown; tags?: string[] }>) => {
        require("board:write");
        // Same data rule as updateItem, per patch: a plugin
        // may only rewrite its own plugin card data.
        for (const patch of patches) {
          if (patch.data !== undefined) {
            const it = host!.getBoard().items.find((i) => i.id === patch.id);
            if (!it || !isPluginCard(it) || it.kind.Plugin.plugin !== pluginId) {
              throw new Error(`Plugin ${pluginId} cannot edit another plugin's card data`);
            }
          }
        }
        return host!.updateItems(patches);
      },
      moveItem: (id: number, toIndex: number) => {
        require("board:write");
        return host!.moveItem(id, toIndex);
      },
      removeItem: (id: number) => {
        require("board:write");
        const ok = host!.removeItem(id);
        return ok;
      },
      save: () => {
        require("board:write");
        host!.save();
      },
      saveWithoutUndo: () => {
        require("board:write");
        host!.saveWithoutUndo();
      },
      render: () => host!.render(),
      commitEditing: () => {
        require("board:write");
        host!.commitEditing();
      },
      groupSelected: () => {
        require("board:write");
        return host!.groupSelection();
      },
      ungroupSelected: () => {
        require("board:write");
        return host!.ungroupSelection();
      },
      deleteSelected: () => {
        require("board:write");
        return host!.deleteSelection();
      },
      // Undo is a board change, so it needs board:write, like any
      // other board write. canUndo/canRedo only read stack state.
      undo: () => {
        require("board:write");
        return host!.undo();
      },
      redo: () => {
        require("board:write");
        return host!.redo();
      },
      canUndo: () => host!.canUndo(),
      canRedo: () => host!.canRedo(),
      setCanvas: (patch: { bg?: string; grid?: Board["grid"] }) => {
        require("board:write");
        host!.setCanvas(patch);
      },
      setNoteBackground: (ids: number[], hex: string) => {
        require("board:write");
        host!.setNoteBackground(ids, hex);
      },
      reset: async () => {
        require("board:write");
        requireNotTrial("reset the board");
        return host!.resetBoard();
      },
      getDir: () => host!.getBoardDir(),
    },
    boards: {
      list: async () => bridge!.listBoards(),
      current: async () => {
        const list = await bridge!.listBoards();
        return list.find((b) => b.current)?.name ?? "Main";
      },
      create: async (name: string) => {
        require("board:write");
        requireNotTrial("create a board");
        return bridge!.createBoard(name);
      },
      switch: async (name: string, preserveUndo = false) => {
        require("board:write");
        requireNotTrial("switch boards");
        return host!.switchBoard(name, preserveUndo);
      },
      rename: async (oldName: string, newName: string) => {
        require("board:write");
        requireNotTrial("rename a board");
        return bridge!.renameBoard(oldName, newName);
      },
      delete: async (name: string) => {
        require("board:write");
        requireNotTrial("delete a board");
        return bridge!.deleteBoard(name);
      },
    },
    app: {
      getBuildId: () => host!.getBuildId(),
      getPlatform: () => bridge!.platform,
      factoryReset: async () => {
        require("board:write");
        requireNotTrial("factory reset");
        return bridge!.factoryReset();
      },
    },
    backups: {
      list: async () => bridge!.listBackups(),
      restore: async (name: string) => {
        require("board:write");
        requireNotTrial("restore a backup");
        return host!.restoreBackup(name);
      },
      openFolder: async () => bridge!.openBackupsFolder(),
    },
    window: {
      hide: async () => {
        require("window");
        return bridge!.collapse();
      },
      show: async () => {
        require("window");
        return bridge!.restore();
      },
      minimise: async () => {
        require("window");
        return bridge!.minimise();
      },
      close: async () => {
        require("window");
        return bridge!.quit();
      },
      fullscreen: async () => {
        require("window");
        return bridge!.fullscreen();
      },
      maximise: async () => {
        require("window");
        return bridge!.maximise();
      },
      getWindowState: async () => {
        require("window");
        return bridge!.windowState();
      },
      move: (dx: number, dy: number) => {
        require("window");
        bridge!.moveWindow(dx, dy);
      },
      getCorner: async () => {
        require("window");
        return (await bridge!.getAppSettings()).corner;
      },
      setCorner: async (corner: string) => {
        require("window");
        return bridge!.setCorner(corner);
      },
    },
    view: {
      getCamera: () => ({ ...host!.getCamera() }),
      setCamera: (cam: Camera) => host!.setCamera(cam),
      setCameraSilent: (cam: Camera) => host!.setCameraSilent(cam),
      zoomBy: (factor: number) => host!.zoomBy(factor),
      centreOn: (id: number) => host!.centreOn(id),
      getView: () => activeView,
      setView: (id: string) => setActiveView(id),
      listViews: () => {
        const out: Array<{ id: string; title: string; plugin: string | null }> = [{ id: "board", title: "Board", plugin: null }];
        for (const v of views.values()) out.push({ id: v.id, title: v.title, plugin: v.pluginId });
        return out;
      },
    },
    shapes: {
      list: () => host!.listShapes(),
      previewPoints: (kind: string, x0: number, y0: number, w: number, h: number) => host!.shapePreviewPoints(kind, x0, y0, w, h),
    },
    search: {
      setElements: (els: { input: HTMLInputElement; count: HTMLElement; clear: HTMLButtonElement; results: HTMLElement }) => {
        host!.setSearchElements(els);
      },
      update: () => host!.updateSearch(),
      clear: () => host!.clearSearch(),
      jumpTo: (idx: number) => host!.jumpToSearchIndex(idx),
    },
    pen: {
      getColor: () => host!.getPenColor(),
      setColor: (hex: string) => host!.setPenColor(hex),
    },
    ui: {
      toast: (msg: string) => host!.toast(msg),
      registerTool: (def: PluginToolDef) => registerTool(pluginId, def),
      registerPanel: (def: PluginPanelDef) => registerPanel(pluginId, def),
      registerCommand: (def: PluginCommandDef) => registerCommand(pluginId, def),
      registerCreateAction: (def: PluginCreateActionDef) => registerCreateAction(pluginId, def),
      // Commands are user actions, not code: listing and running
      // them is what Settings' Run buttons already do, so a
      // palette plugin can do the same without a permission.
      // A command still runs with its own plugin's API object,
      // so it cannot do anything its plugin could not do itself.
      listCommands: () => listPluginCommands().map((c) => ({ pluginId: c.pluginId, pluginName: c.pluginName, id: c.id, title: c.title })),
      listTools: () => Array.from(tools.values()).map((t) => ({ pluginId: t.pluginId, pluginName: loaded.get(t.pluginId)?.manifest.name ?? t.pluginId, id: t.fullId, title: t.title })),
      runCommand: (pid: string, cid: string) => runPluginCommand(pid, cid),
      setTool: (id: string) => host!.setTool(id),
      getTool: () => host!.getTool(),
      setToolbarToolsEl: (el: HTMLElement) => {
        shell.toolbarToolsEl = el;
      },
      setBoardElements: (els: { board: HTMLElement; canvas: HTMLElement[]; pluginView: HTMLElement; overlays: HTMLElement; viewSwitcher: HTMLElement; toast: HTMLElement }) => {
        registerShellElements({
          boardEl: els.board,
          boardCanvasEls: els.canvas,
          pluginViewEl: els.pluginView,
          overlaysEl: els.overlays,
          viewSwitcherEl: els.viewSwitcher,
          toastEl: els.toast,
        });
      },
      setPanelsToggleEl: (el: HTMLElement) => {
        registerShellElements({ panelsToggleEl: el });
      },
      openSettings: () => host!.openSettings(),
      closeSettings: () => host!.closeSettings(),
      isSettingsOpen: () => host!.isSettingsOpen(),
      registerView: (def: PluginViewDef) => {
        require("view:replace");
        registerView(pluginId, def);
      },
      registerOverlay: (def: PluginOverlayDef) => registerOverlay(pluginId, def),
      registerSettingsSection: (def: PluginSettingsSectionDef) => registerSettingsSection(pluginId, def),
      renderSettingsSections: () => renderSettingsSections(),
      registerShortcut: (def: PluginShortcutDef) => registerShortcut(pluginId, def),
      listShortcuts: () => listPluginShortcuts(),
      // The board element, built by the core-board plugin.
      // Read from the shell (set by the board plugin when it
      // activates) so a plugin activating after the board
      // plugin — the title bar, which inserts before it —
      // sees it even before the core has read it back.
      boardEl: (shell.boardEl ?? host!.boardEl) as HTMLElement,
      registerSettingsUI: (ui: { open: () => void; close: () => void; isOpen: () => boolean; setTab: (tab: string) => void; refresh: () => void }) => registerSettingsUI(ui),
      setSettingsSectionsContainer: (el: HTMLElement) => registerShellElements({ settingsSectionsEl: el }),
      // The search box container, built by the core-titlebar
      // plugin. The core-search plugin mounts its input,
      // count, clear button and results into it.
      setSearchBoxEl: (el: HTMLElement) => registerShellElements({ searchBoxEl: el }),
      getSearchBoxEl: () => shell.searchBoxEl ?? null,
      showPanel: (id: string) => {
        // Showing a panel activates its tab, so the user
        // actually sees it — a new tab in the background
        // would be easy to miss.
        const key = `${pluginId}:${id}`;
        const p = panels.get(key);
        if (p) { p.hidden = false; setActivePanel(key); host?.render(); }
      },
      hidePanel: (id: string) => {
        const key = `${pluginId}:${id}`;
        const p = panels.get(key);
        if (!p) return;
        p.hidden = true;
        if (activePanelKey === key) {
          const next = visiblePanels()[0];
          activePanelKey = next ? next[0] : null;
        }
        updatePanelDock();
        host?.render();
      },
      isPanelActive: (id: string) => dockVisible && activePanelKey === `${pluginId}:${id}`,
      getPanelElement: (id: string) => {
        const p = panels.get(`${pluginId}:${id}`);
        return p ? p.body : null;
      },
    },
    cards: {
      register: (def: PluginCardDef) => {
        cards.set(`${pluginId}:${def.kind}`, { ...def, pluginId });
      },
      registerBuiltin: (def: PluginBuiltinCardDef) => {
        registerBuiltinCard(pluginId, def);
      },
      registerDecorator: (def: PluginCardDecoratorDef) => {
        cardDecorators.set(`${pluginId}:${def.id}`, { ...def, pluginId });
      },
      getChecklistProgress: (item: Item) => {
        if (!("Text" in item.kind)) return null;
        return checklistProgress(item.kind.Text.text);
      },
      setChecklistProgress: (id: number, done: number) => {
        require("board:write");
        const board = host!.getBoard();
        const it = boardGet(board, id);
        if (!it || !("Text" in it.kind)) return false;
        const next = setChecklistDone(it.kind.Text.text, done);
        if (next === null) return false;
        return host!.setTextContent(id, next);
      },
    },
    tags: {
      list: () => {
        const tags = new Set<string>();
        for (const it of host!.getBoard().items) {
          for (const t of it.tags ?? []) tags.add(t);
        }
        return Array.from(tags).sort((a, b) => a.localeCompare(b));
      },
      get: (id: number) => {
        const it = host!.getBoard().items.find((i) => i.id === id);
        return it ? [...(it.tags ?? [])] : [];
      },
      add: (id: number, tag: string) => {
        require("board:write");
        const clean = tag.trim();
        if (!clean) return false;
        const board = host!.getBoard();
        const it = boardGet(board, id);
        if (!it) return false;
        const tags = [...(it.tags ?? [])];
        if (tags.includes(clean)) return false;
        tags.push(clean);
        return host!.updateItem(id, { tags });
      },
      remove: (id: number, tag: string) => {
        require("board:write");
        const board = host!.getBoard();
        const it = boardGet(board, id);
        if (!it) return false;
        const tags = (it.tags ?? []).filter((t) => t !== tag);
        if (tags.length === (it.tags ?? []).length) return false;
        return host!.updateItem(id, { tags });
      },
    },
    media: {
      audioFailed: (path: string) => host!.audioFailed(path),
      getAudioState: () => host!.getAudioState(),
      getAudioDuration: (path: string) => host!.getAudioDuration(path),
      loadAudioDuration: (id: number, path: string) => host!.loadAudioDuration(id, path),
      transcribeAudio: (blob: Blob) => host!.transcribeAudio(blob),
      formatAudioTime: (sec: number) => host!.formatAudioTime(sec),
      toggleAudio: (id: number, path: string) => host!.toggleAudio(id, path),
      seekAudio: (id: number, time: number) => host!.seekAudio(id, time),
      pdfFailed: (path: string) => host!.pdfFailed(path),
      getPdfPage: (id: number) => host!.getPdfPage(id),
      loadPdfPage: (id: number, path: string) => host!.loadPdfPage(id, path),
      setPdfPage: (id: number, path: string, page: number) => host!.setPdfPage(id, path, page),
    },
    text: {
      escapeHtml,
      renderMarkdownHtml,
      domainOf,
      elide,
      tileColorFor,
      tint,
    },
    files: {
      embedFile: async (file: File | string) => {
        require("files:embed");
        if (typeof file !== "string") {
          return bridge!.embedFileBytes(file.name, await file.arrayBuffer());
        }
        return bridge!.embedFile(file);
      },
      listLibrary: async () => {
        require("files:read");
        return bridge!.listLibrary();
      },
      createLibraryCategory: async (name: string) => {
        require("files:embed");
        return bridge!.createLibraryCategory(name);
      },
      moveLibraryItem: async (relativePath: string, category: string | null) => {
        require("files:embed");
        return bridge!.moveLibraryItem(relativePath, category);
      },
      fileUrl: (path: string) => bridge!.fileUrl(path),
      readTextFile: async (path: string) => {
        require("files:read");
        return bridge!.readTextFile(path);
      },
      readFileBase64: async (path: string) => {
        require("files:read");
        return bridge!.readFileBase64(path);
      },
      fileSize: async (path: string) => {
        require("files:read");
        return bridge!.fileSize(path);
      },
      openExternal: async (target: string) => {
        require("files:read");
        return bridge!.openExternal(target);
      },
      fetchPreview: async (url: string) => {
        require("files:read");
        return bridge!.fetchPreview(url);
      },
    },
    ai: {
      chat: async (opts: { base: string; model: string; messages: Array<{ role: string; content: string }> }) => {
        require("ai");
        return bridge!.aiChat(opts);
      },
      hasKey: async () => {
        require("ai");
        return bridge!.aiHasKey();
      },
      setKey: async (key: string) => {
        require("ai");
        return bridge!.aiSetKey(key);
      },
    },
    storage: {
      get: async (key: string) => {
        require("storage");
        return bridge!.pluginStorageGet(pluginId, key);
      },
      set: async (key: string, value: unknown) => {
        require("storage");
        return bridge!.pluginStorageSet(pluginId, key, value);
      },
      delete: async (key: string) => {
        require("storage");
        return bridge!.pluginStorageDelete(pluginId, key);
      },
    },
    secureStorage: {
      available: async () => bridge!.secureStorageAvailable(),
      get: async (key: string) => {
        require("storage");
        return bridge!.secureStorageGet(pluginId, key);
      },
      set: async (key: string, value: string) => {
        require("storage");
        return bridge!.secureStorageSet(pluginId, key, value);
      },
      delete: async (key: string) => {
        require("storage");
        return bridge!.secureStorageDelete(pluginId, key);
      },
    },
    plugins: {
      list: () => Array.from(loaded.values()).map((lp) => ({
        id: lp.manifest.id,
        name: lp.manifest.name,
        version: lp.manifest.version,
        description: lp.manifest.description ?? "",
        core: !!lp.firstParty,
        required: !!lp.manifest.required,
        active: lp.active,
        failed: lp.failed,
        error: lp.error,
        trial: !!lp.trial,
        // The card kinds that are frames, from the manifest:
        // a frame hides when its plugin is disabled instead
        // of showing a placeholder, so a settings UI can say
        // so. Empty when the plugin has no frame cards.
        frameKinds: (lp.manifest.contributions?.cards ?? [])
          .filter((c) => c.frame === true)
          .map((c) => c.kind),
      })),
      setEnabled: async (id: string, enabled: boolean) => {
        require("plugins:install");
        requireNotTrial("enable or disable a plugin");
        await setPluginEnabled(id, enabled);
      },
      reset: async () => {
        require("plugins:install");
        requireNotTrial("reset plugins");
        // Factory state: core plugins on, extras off. A
        // required plugin is on by definition, so it is never
        // turned off here. Trial plugins are not installed, so
        // they are untouched.
        for (const lp of Array.from(loaded.values())) {
          if (lp.trial) continue;
          await setPluginEnabled(lp.manifest.id, !!lp.firstParty);
        }
      },
      install: async (plugin) => {
        require("plugins:install");
        requireNotTrial("install a plugin");
        return bridge!.installPlugin(plugin);
      },
      refresh: async () => {
        require("plugins:install");
        requireNotTrial("install a plugin");
        await refreshPlugins();
      },
      try: async (plugin) => {
        require("plugins:install");
        requireNotTrial("try a plugin");
        return tryPlugin(plugin);
      },
      endTrial: async (id: string) => {
        require("plugins:install");
        requireNotTrial("end a trial");
        await endTrial(id);
      },
    },
    events: {
      on: (event: string, handler: () => void) => onEvent(event, handler),
      off: (event: string, handler: () => void) => offEvent(event, handler),
    },
    geometry: {
      centre: (item: Item) => centre(item),
      anchorPoint: (anchor: Anchor) => anchorPoint(host!.getBoard(), anchor),
      rectCrossing: (from: Pt, to: Pt, pos: Pt, w: number, h: number, entry: boolean) => rectCrossing(from, to, pos, w, h, entry),
      clippedEnds: (from: Anchor, to: Anchor) => clippedEnds(host!.getBoard(), from, to),
      segmentIntersectsRect: (a: Pt, b: Pt, rect: { x: number; y: number; w: number; h: number }) => segmentIntersectsRect(a, b, rect),
      rectsOverlap: (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,
      itemRotation: (item: Item) => itemRotation(item),
    },
  };
}

// ---------------------------------------------------------------- registration

function registerCreateAction(pluginId: string, def: PluginCreateActionDef): void {
  if (def.icon && /<script/i.test(def.icon)) throw new Error(`Plugin ${pluginId} create action icon contains <script>`);
  createActions.set(`${pluginId}:${def.id}`, { ...def, pluginId });
}

// Every registered creation action, for the core's text
// editor (the first one's icon sits beside the text box).
// In registration order.
export function getCreateActions(): Array<PluginCreateActionDef & { pluginId: string }> {
  return Array.from(createActions.values());
}

function registerTool(pluginId: string, def: PluginToolDef): void {
  const fullId = `plugin:${pluginId}:${def.id}`;
  tools.set(fullId, { ...def, pluginId, fullId });
  if (!host) return;
  const btn = document.createElement("button");
  btn.id = domId(pluginId, "tool", def.id);
  btn.title = def.title;
  btn.setAttribute("aria-label", def.title);
  if (def.icon) {
    if (/<script/i.test(def.icon)) throw new Error(`Plugin ${pluginId} tool icon contains <script>`);
    btn.innerHTML = def.icon;
  } else {
    btn.textContent = def.title.slice(0, 1).toUpperCase();
  }
  btn.addEventListener("click", () => host!.setTool(fullId));
  shell.toolbarToolsEl?.appendChild(btn);
}

function registerPanel(pluginId: string, def: PluginPanelDef): void {
  if (!host) return;
  ensureTabsBar();
  // No per-panel header: the tab is the header. A panel
  // is a body only; the tab bar, with one tab per panel,
  // sits above the active panel and switches between them.
  const wrap = document.createElement("div");
  wrap.className = "plugin-panel";
  wrap.dataset.plugin = pluginId;
  wrap.dataset.panel = def.id;
  const body = document.createElement("div");
  body.className = "plugin-panel-body";
  wrap.appendChild(body);
  shell.panelsEl?.appendChild(wrap);
  const tab = document.createElement("button");
  tab.className = "plugin-tab";
  // Tabs are icons only: the title stays as the tooltip
  // and aria-label, so the panel is still named on hover
  // and to screen readers, without text in the tab bar.
  // A panel with no icon falls back to its title text,
  // as tabs did before, so an icon is optional, not
  // required for a panel to be usable.
  if (def.icon) {
    if (/<script/i.test(def.icon)) throw new Error(`Plugin ${pluginId} panel icon contains <script>`);
    tab.innerHTML = def.icon;
    tab.classList.add("has-icon");
  } else {
    tab.textContent = def.title;
  }
  tab.title = `${def.title} — drag to reorder`;
  tab.setAttribute("aria-label", def.title);
  const key = `${pluginId}:${def.id}`;
  tab.addEventListener("click", () => {
    if (suppressTabClick) { suppressTabClick = false; return; }
    setActivePanel(key);
  });
  // Drag a tab left or right to reorder the tabs. A drag is
  // any pointer move over 4px; a smaller move is a click.
  // The tab follows the pointer live, and the new order is
  // saved on mouseup, so it survives a restart.
  tab.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0) return;
    tabDrag = { key, startX: e.clientX, dragged: false };
    const onMove = (ev: MouseEvent) => {
      if (!tabDrag || tabDrag.key !== key) return;
      if (Math.abs(ev.clientX - tabDrag.startX) <= 4) return;
      tabDrag.dragged = true;
      tab.classList.add("dragging");
      if (!tabsListEl) return;
      const visible = Array.from(tabsListEl.children).filter((c) => (c as HTMLElement).style.display !== "none");
      let target: Element | null = null;
      for (const c of visible) {
        if (c === tab) continue;
        const r = c.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) { target = c; break; }
      }
      if (target) tabsListEl.insertBefore(tab, target);
      else tabsListEl.appendChild(tab);
      // DOM order is the order that gets saved on mouseup;
      // the panel map order does not affect what is shown.
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      tab.classList.remove("dragging");
      if (tabDrag && tabDrag.dragged) {
        // Suppress only the click that belongs to this drag:
        // it fires right after mouseup, before the timeout
        // below runs. A drag that ends outside a tab fires
        // no click at all, and without the timeout the flag
        // would stay set and swallow the user's next real
        // tab click — the extra click this fix removes.
        suppressTabClick = true;
        setTimeout(() => { suppressTabClick = false; }, 0);
        host?.setPanelOrder(panelDomOrder());
      }
      tabDrag = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  tabsListEl!.appendChild(tab);
  panels.set(key, { ...def, pluginId, el: wrap, body, tab, hidden: false });
  applyPanelOrder();
  try {
    def.render(body);
  } catch (e) {
    body.textContent = `Panel failed to render: ${String(e)}`;
  }
  // First panel becomes active; later panels do not steal
  // focus from the panel the user is already looking at.
  if (activePanelKey === null) activePanelKey = key;
  updatePanelDock();
  host.render();
}

function registerCommand(pluginId: string, def: PluginCommandDef): void {
  commands.set(`${pluginId}:${def.id}`, { ...def, pluginId });
}

function registerView(pluginId: string, def: PluginViewDef): void {
  views.set(def.id, { ...def, pluginId });
  renderViewSwitcher();
}

function registerOverlay(pluginId: string, def: PluginOverlayDef): void {
  if (!host) return;
  // An overlay container covers the board area but takes no
  // clicks itself (pointer-events: none in CSS). Interactive
  // elements a plugin puts inside it must set pointer-events:
  // auto on themselves, so board clicks pass through everywhere
  // except on the plugin's own controls. That is how a corner
  // button can sit in a corner without blocking the board.
  const wrap = document.createElement("div");
  wrap.className = "plugin-overlay";
  wrap.dataset.plugin = pluginId;
  wrap.dataset.overlay = def.id;
  shell.overlaysEl?.appendChild(wrap);
  overlays.set(`${pluginId}:${def.id}`, { ...def, pluginId, el: wrap });
  try {
    def.render(wrap);
  } catch (e) {
    wrap.textContent = `Overlay failed to render: ${String(e)}`;
  }
}

function registerSettingsSection(pluginId: string, def: PluginSettingsSectionDef): void {
  // Stored only; the core renders sections when Settings opens
  // (see renderSettingsSections), so a section registered while
  // Settings is already open appears on the next open, or when
  // the core re-renders sections after a plugin toggle.
  settingsSections.set(`${pluginId}:${def.id}`, { ...def, pluginId });
}

export function renderSettingsSections(): void {
  if (!host) return;
  const el = shell.settingsSectionsEl;
  if (!el) return;
  el.innerHTML = "";
  for (const s of settingsSections.values()) {
    const wrap = document.createElement("div");
    wrap.className = "plugin-settings-section";
    wrap.dataset.plugin = s.pluginId;
    // The section title is just a heading now: the Disable
    // button used to sit beside it, so a plugin could be
    // turned off from its own settings, but it duplicated
    // the Plugins tab's toggle and cluttered the section.
    // Enabling and disabling lives in the Plugins tab only.
    const head = document.createElement("h3");
    head.textContent = s.title;
    const body = document.createElement("div");
    wrap.appendChild(head);
    wrap.appendChild(body);
    el.appendChild(wrap);
    try {
      s.render(body);
    } catch (e) {
      body.textContent = `Settings section failed to render: ${String(e)}`;
    }
  }
}

function registerShortcut(pluginId: string, def: PluginShortcutDef): void {
  // Shortcuts in v1 are single keys, no modifiers. Core keys win:
  // the core checks its own shortcuts first, and handlePluginShortcut
  // is only called for keys the core did not handle, with Ctrl/Cmd
  // held keys excluded, so a plugin cannot steal Ctrl+G or similar.
  shortcuts.set(`${pluginId}:${def.key.toLowerCase()}`, { ...def, pluginId });
}

export function listPluginShortcuts(): Array<PluginShortcutDef & { pluginId: string; pluginName: string }> {
  const out: Array<PluginShortcutDef & { pluginId: string; pluginName: string }> = [];
  for (const s of shortcuts.values()) {
    const lp = loaded.get(s.pluginId);
    out.push({ ...s, pluginName: lp?.manifest.name ?? s.pluginId });
  }
  return out;
}

export function handlePluginShortcut(key: string): boolean {
  // The core has already applied its guards (not in a textarea or
  // search box, Settings closed, not editing). Tab, Escape and
  // Space are core-owned and never reach here from the core handler.
  const lower = key.toLowerCase();
  if (lower === "tab" || lower === "escape" || lower === " ") return false;
  for (const s of shortcuts.values()) {
    if (s.key.toLowerCase() !== lower) continue;
    try {
      const r = s.run();
      if (r instanceof Promise) r.catch(() => undefined);
    } catch (e) {
      host?.toast(`Plugin shortcut failed: ${String(e)}`);
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- views

export function getActiveView(): string {
  return activeView;
}

export function listViewsForUI(): Array<{ id: string; title: string; plugin: string | null }> {
  const out: Array<{ id: string; title: string; plugin: string | null }> = [{ id: "board", title: "Board", plugin: null }];
  for (const v of views.values()) out.push({ id: v.id, title: v.title, plugin: v.pluginId });
  return out;
}

function renderViewSwitcher(): void {
  if (!host) return;
  const el = shell.viewSwitcherEl;
  if (!el) return;
  el.innerHTML = "";
  if (views.size === 0) {
    el.style.display = "none";
    return;
  }
  el.style.display = "flex";
  const mk = (id: string, title: string) => {
    const b = document.createElement("button");
    b.textContent = title;
    b.classList.toggle("active", activeView === id);
    b.addEventListener("click", () => setActiveView(id));
    el.appendChild(b);
  };
  mk("board", "Board");
  for (const v of views.values()) mk(v.id, v.title);
}

export function setActiveView(id: string): void {
  if (!host) return;
  if (id !== "board" && !views.has(id)) return;
  const prev = views.get(activeView);
  if (prev?.onHide) {
    try {
      prev.onHide();
    } catch {
      // A view's onHide must never trap the user in the view.
    }
  }
  activeView = id;
  const viewEl = shell.pluginViewEl;
  const canvasEls = shell.boardCanvasEls;
  if (id === "board") {
    for (const el of canvasEls ?? []) el.style.display = "";
    if (viewEl) {
      viewEl.style.display = "none";
      viewEl.innerHTML = "";
    }
  } else if (viewEl) {
    for (const el of canvasEls ?? []) el.style.display = "none";
    viewEl.style.display = "";
    const v = views.get(id)!;
    viewEl.innerHTML = "";
    viewEl.dataset.plugin = v.pluginId;
    try {
      v.render(viewEl, host.getBoard());
    } catch (e) {
      viewEl.textContent = `View failed to render: ${String(e)}`;
    }
    if (v.onShow) {
      try {
        v.onShow();
      } catch {
        // See onHide above.
      }
    }
  }
  renderViewSwitcher();
  emitPluginEvent("view");
  host.render();
}

export function refreshActiveView(): void {
  if (!host || activeView === "board") return;
  const v = views.get(activeView);
  if (!v) {
    setActiveView("board");
    return;
  }
  const viewEl = shell.pluginViewEl;
  if (!viewEl) return;
  try {
    v.render(viewEl, host.getBoard());
  } catch (e) {
    viewEl.textContent = `View failed to render: ${String(e)}`;
  }
}

// ---------------------------------------------------------------- core callbacks

export function getCardRenderer(item: Item): PluginCardDef | null {
  if (!isPluginCard(item)) return null;
  return cards.get(`${item.kind.Plugin.plugin}:${item.kind.Plugin.kind}`) ?? null;
}

export function getCardHtml(item: Item): string | null {
  if (!isPluginCard(item)) return null;
  const def = getCardRenderer(item);
  // Selection class and card chrome are applied by the core
  // wrapper in main.ts; this returns inner HTML only.
  if (!def) {
    const { plugin, kind } = item.kind.Plugin;
    // A frame card is a container, not content: when its
    // plugin is disabled, the frame itself goes away rather
    // than showing a placeholder. The frame is declared in
    // the plugin's manifest, so the core knows it is a frame
    // even though the plugin was never activated in this
    // session — the card's data stays in the board, and
    // re-enabling the plugin brings the frame back.
    const manifest = loaded.get(plugin)?.manifest;
    const isFrame = manifest?.contributions?.cards?.some(
      (c) => c.kind === kind && c.frame === true
    );
    if (isFrame) return null;
    return `<div style="padding:12px"><div class="title" style="font-size:14px">Plugin card</div><div class="sub" style="font-size:12px">${escapeHtml(plugin)} — ${escapeHtml(kind)}</div><div class="sub" style="font-size:12px">Install the plugin to view this card. Your data is kept.</div></div>`;
  }
  try {
    return def.render(item, item.kind.Plugin.data);
  } catch (e) {
    return `<div style="padding:12px"><div class="title" style="font-size:14px">Plugin card failed to render</div><div class="sub" style="font-size:12px">${escapeHtml(String(e))}</div></div>`;
  }
}

// ---------------------------------------------------------------- built-in card kinds

// The built-in card kinds (Text, Image, Swatch, UrlCard,
// PdfCard, Audio, Video, Shape). Strokes and connectors are
// not cards — they are drawn on the canvas, not rendered
// as card HTML — so they have no builtin renderer.
export function builtinKindName(item: Item): string | null {
  if (isPluginCard(item)) return null;
  if ("Text" in item.kind) return "Text";
  if ("Image" in item.kind) return "Image";
  if ("Swatch" in item.kind) return "Swatch";
  if ("UrlCard" in item.kind) return "UrlCard";
  if ("PdfCard" in item.kind) return "PdfCard";
  if ("Audio" in item.kind) return "Audio";
  if ("Video" in item.kind) return "Video";
  if ("Shape" in item.kind) return "Shape";
  return null;
}

export function registerBuiltinCard(pluginId: string, def: PluginBuiltinCardDef): void {
  builtinCards.set(def.kind, { ...def, pluginId });
}

export function getBuiltinCardRenderer(kind: string): (PluginBuiltinCardDef & { pluginId: string }) | null {
  return builtinCards.get(kind) ?? null;
}

// Render a built-in card through the plugin that registered
// a renderer for its kind, or null when no plugin provides
// one (the core then falls back to its own renderer, during
// migration, or a placeholder). The renderer returns the
// complete card HTML — outer div, position, size, selection
// ring and all — exactly as the core's renderer did.
export function getBuiltinCardHtml(item: Item, plain = false): string | null {
  const kindName = builtinKindName(item);
  if (!kindName) return null;
  const def = builtinCards.get(kindName);
  if (!def) return null;
  try {
    return def.render(item, (item.kind as Record<string, unknown>)[kindName], plain);
  } catch (e) {
    return `<div style="padding:12px"><div class="title" style="font-size:14px">Card failed to render</div><div class="sub" style="font-size:12px">${escapeHtml(String(e))}</div></div>`;
  }
}

export function getPluginCardSearchText(item: Item): string | null {
  if (!isPluginCard(item)) return null;
  const def = getCardRenderer(item);
  if (def?.searchText) {
    try {
      return def.searchText(item.kind.Plugin.data);
    } catch {
      return null;
    }
  }
  return `${item.kind.Plugin.plugin} ${item.kind.Plugin.kind} ${JSON.stringify(item.kind.Plugin.data ?? "")}`;
}

export function handlePluginCardDoubleClick(item: Item): boolean {
  if (!isPluginCard(item)) return false;
  const def = getCardRenderer(item);
  if (!def?.onDoubleClick) return false;
  try {
    def.onDoubleClick(item, item.kind.Plugin.data);
  } catch (e) {
    host?.toast(`Plugin card failed: ${String(e)}`);
  }
  return true;
}

export function handlePluginCardAction(action: string, item: Item): boolean {
  if (!isPluginCard(item)) return false;
  const def = getCardRenderer(item);
  if (!def?.onAction) return false;
  try {
    def.onAction(action, item, item.kind.Plugin.data);
  } catch (e) {
    host?.toast(`Plugin action failed: ${String(e)}`);
  }
  return true;
}

export function getPluginTool(fullId: string): (PluginToolDef & { pluginId: string; fullId: string }) | null {
  return tools.get(fullId) ?? null;
}

export function syncPluginToolButtons(activeTool: string): void {
  for (const t of tools.values()) {
    const btn = document.getElementById(domId(t.pluginId, "tool", t.id));
    if (btn) btn.classList.toggle("active", activeTool === t.fullId);
  }
}

export function listPluginCommands(): Array<PluginCommandDef & { pluginId: string; pluginName: string }> {
  const out: Array<PluginCommandDef & { pluginId: string; pluginName: string }> = [];
  for (const c of commands.values()) {
    const lp = loaded.get(c.pluginId);
    out.push({ ...c, pluginName: lp?.manifest.name ?? c.pluginId });
  }
  return out;
}

export async function runPluginCommand(pluginId: string, commandId: string): Promise<void> {
  const c = commands.get(`${pluginId}:${commandId}`);
  if (!c) return;
  try {
    await c.run();
  } catch (e) {
    host?.toast(`Plugin command failed: ${String(e)}`);
  }
}

// ---------------------------------------------------------------- loading

function unregisterPlugin(pluginId: string): void {
  for (const key of Array.from(cards.keys())) {
    if (key.startsWith(`${pluginId}:`)) cards.delete(key);
  }
  for (const key of Array.from(cardDecorators.keys())) {
    if (key.startsWith(`${pluginId}:`)) cardDecorators.delete(key);
  }
  for (const [fullId, t] of Array.from(tools.entries())) {
    if (t.pluginId === pluginId) {
      tools.delete(fullId);
      document.getElementById(domId(pluginId, "tool", t.id))?.remove();
    }
  }
  for (const [key, p] of Array.from(panels.entries())) {
    if (p.pluginId === pluginId) {
      panels.delete(key);
      p.tab.remove();
      p.el.remove();
    }
  }
  if (activePanelKey && !panels.has(activePanelKey)) {
    const next = visiblePanels()[0];
    activePanelKey = next ? next[0] : null;
  }
  updatePanelDock();
  for (const [key, v] of Array.from(views.entries())) {
    if (v.pluginId === pluginId) views.delete(key);
  }
  for (const key of Array.from(createActions.keys())) {
    if (key.startsWith(`${pluginId}:`)) createActions.delete(key);
  }
  for (const key of Array.from(commands.keys())) {
    if (key.startsWith(`${pluginId}:`)) commands.delete(key);
  }
  for (const [key, o] of Array.from(overlays.entries())) {
    if (o.pluginId === pluginId) {
      overlays.delete(key);
      o.el.remove();
    }
  }
  for (const key of Array.from(settingsSections.keys())) {
    if (key.startsWith(`${pluginId}:`)) settingsSections.delete(key);
  }
  for (const [key, s] of Array.from(shortcuts.entries())) {
    if (s.pluginId === pluginId) shortcuts.delete(key);
  }
  if (host && activeView !== "board") {
    const v = views.get(activeView);
    if (!v) setActiveView("board");
  }
  renderViewSwitcher();
  host?.render();
}

async function activatePlugin(manifest: PluginManifest, source?: { mainCode: string; styleCode: string }): Promise<void> {
  const lp = loaded.get(manifest.id);
  if (!lp || !bridge) return;
  // A first-party plugin's module is a bundled import, not a
  // file on disk: re-activate the retained module instead of
  // fetching plugin://<id>/main.js, which does not exist.
  // This is what makes disabling and re-enabling a core
  // plugin (toolbar, title bar, search, cards) work at
  // runtime; without it the re-enable 404s and the plugin
  // is left failed.
  if (lp.firstPartyModule) {
    const mod = lp.firstPartyModule;
    if (typeof mod.activate !== "function") {
      throw new Error(`Plugin ${manifest.id} does not export activate(api)`);
    }
    lp.module = mod;
    const api = createContext(manifest, { trial: !!lp.trial });
    await mod.activate(api);
    lp.active = true;
    lp.failed = false;
    lp.error = null;
    return;
  }
  // Styles first, so the plugin's first render already looks right.
  // A trial plugin has no files on disk, so its stylesheet comes
  // from the supplied code instead of the bridge.
  if (source) {
    if (source.styleCode.trim()) {
      const style = document.createElement("style");
      style.dataset.plugin = manifest.id;
      style.textContent = source.styleCode;
      document.head.appendChild(style);
    }
  } else {
    for (const stylePath of manifest.styles ?? []) {
      try {
        const css = await bridge.readPluginFile(manifest.id, stylePath);
        const style = document.createElement("style");
        style.dataset.plugin = manifest.id;
        style.textContent = css;
        document.head.appendChild(style);
      } catch (e) {
        // A missing stylesheet must not block the plugin.
        console.warn(`Plugin ${manifest.id} stylesheet ${stylePath} failed: ${String(e)}`);
      }
    }
  }
  // A user plugin loads as an ES module over the plugin:
  // scheme, so its main.js has a real URL base and its
  // relative imports resolve against its own folder — the
  // same as a first-party plugin. A blob URL has no base,
  // so a relative import cannot resolve at all; that is
  // why user plugins were single-file until now. A trial
  // plugin has no files on disk, so it still loads from a
  // blob URL — a single-file plugin is the special case.
  let url: string | null = null;
  if (source) {
    const blob = new Blob([source.mainCode], { type: "text/javascript" });
    url = URL.createObjectURL(blob);
  } else {
    const mainPath = manifest.main.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    url = `plugin://${encodeURIComponent(manifest.id)}/${mainPath}`;
  }
  try {
    const mod = (await import(/* @vite-ignore */ url)) as {
      activate?: (api: PluginContext) => void | Promise<void>;
      deactivate?: () => void | Promise<void>;
    };
    if (typeof mod.activate !== "function") {
      throw new Error(`Plugin ${manifest.id} main.js does not export activate(api)`);
    }
    lp.module = mod;
    const api = createContext(manifest, { trial: !!lp.trial });
    await mod.activate(api);
    lp.active = true;
    lp.failed = false;
    lp.error = null;
  } finally {
    if (source && url) URL.revokeObjectURL(url);
  }
}

// First-party plugins: bundled UI plugins that ship with the
// app. They are ES modules imported by the core. A user plugin
// is the same: an ES module loaded over the plugin: scheme, so
// it can be multiple files with relative imports. The only
// difference is loading (bundled import vs plugin: URL). They
// get the same PluginContext, the same permission checks, and
// the same manifest, and they appear in the plugin list the
// same way. A first-party plugin has no back door: if it needs
// something, that something is in the API.
export async function activateFirstPartyPlugin(
  manifest: PluginManifest,
  mod: { activate?: (api: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> },
): Promise<void> {
  if (!bridge || !host) throw new Error("plugins are not ready yet");
  if (loaded.has(manifest.id)) throw new Error(`a plugin called ${manifest.id} already exists`);
  if (typeof mod.activate !== "function") {
    throw new Error(`Plugin ${manifest.id} does not export activate(api)`);
  }
  loaded.set(manifest.id, { manifest, firstParty: true, firstPartyModule: mod, active: false, failed: false, error: null, module: null });
  const lp = loaded.get(manifest.id)!;
  try {
    lp.module = mod;
    const api = createContext(manifest, {});
    await mod.activate(api);
    lp.active = true;
    lp.failed = false;
    lp.error = null;
  } catch (e) {
    lp.failed = true;
    lp.error = String(e);
    lp.active = false;
    lp.module = null;
    unregisterPlugin(manifest.id);
    throw e;
  }
  renderViewSwitcher();
  updatePanelDock();
}

async function deactivatePlugin(manifest: PluginManifest): Promise<void> {
  const lp = loaded.get(manifest.id);
  if (!lp) return;
  if (lp.module?.deactivate) {
    try {
      await lp.module.deactivate();
    } catch {
      // Deactivate failures must not trap the user with the plugin on.
    }
  }
  lp.module = null;
  lp.active = false;
  unregisterPlugin(manifest.id);
  document.querySelectorAll(`style[data-plugin="${manifest.id}"]`).forEach((el) => el.remove());
}

// ---------------------------------------------------------------- trial plugins
//
// A trial plugin is activated from the supplied code, in memory
// only — nothing is written to the plugins folder, so ending the
// trial (or quitting the app) removes it completely. This is a
// reversibility trial, not a code sandbox: the plugin still runs
// in the renderer with the same permission checks as an installed
// plugin, and the trial guards in createContext only stop it
// making permanent changes (installing plugins, creating or
// deleting boards). A trial plugin's own storage writes, if it
// has the storage permission, are scoped by its id and inert
// once the trial ends, because no plugin with that id exists
// to read them again. The Builder panel says all of this in
// plain language while a trial is running; it must not be
// presented to the user as a security sandbox.
export async function tryPlugin(plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string; styleCode: string }): Promise<PluginManifest> {
  if (!bridge || !host) throw new Error("plugins are not ready yet");
  if (typeof plugin.id !== "string" || !/^[a-z0-9-]+$/.test(plugin.id)) throw new Error("plugin id must be lowercase letters, digits and hyphens");
  if (typeof plugin.name !== "string" || !plugin.name.trim() || typeof plugin.mainCode !== "string" || !plugin.mainCode.trim()) throw new Error("plugin name and code are required");
  if (plugin.mainCode.length > 200000 || (typeof plugin.styleCode === "string" && plugin.styleCode.length > 200000)) throw new Error("plugin code is too large");
  if (!Array.isArray(plugin.permissions) || plugin.permissions.some((p) => typeof p !== "string")) throw new Error("plugin permissions must be strings");
  if (loaded.has(plugin.id)) throw new Error(`a plugin called ${plugin.id} already exists`);
  const manifest: PluginManifest = {
    apiVersion: "2",
    id: plugin.id,
    name: plugin.name.trim(),
    description: typeof plugin.description === "string" ? plugin.description : "",
    version: "1.0.0",
    main: "main.js",
    styles: typeof plugin.styleCode === "string" && plugin.styleCode.trim() ? ["style.css"] : [],
    permissions: plugin.permissions,
  };
  loaded.set(plugin.id, { manifest, trial: true, active: false, failed: false, error: null, module: null });
  try {
    await activatePlugin(manifest, { mainCode: plugin.mainCode, styleCode: plugin.styleCode ?? "" });
  } catch (e) {
    loaded.delete(plugin.id);
    throw e;
  }
  renderViewSwitcher();
  host.render();
  return manifest;
}

export async function endTrial(id: string): Promise<void> {
  const lp = loaded.get(id);
  if (!lp || !lp.trial) return;
  await deactivatePlugin(lp.manifest);
  loaded.delete(id);
  host?.render();
}

export async function initPlugins(
  h: PluginHost,
  b: PluginBridge,
  firstParty: Array<{ manifest: PluginManifest; module: { activate?: (api: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> } }> = [],
): Promise<void> {
  host = h;
  bridge = b;
  wirePanelsToggle();
  ensureResizeHandle();
  try {
    const settings = await b.getAppSettings();
    if (typeof settings.panelWidth === "number") {
      panelWidth = Math.min(600, Math.max(200, Math.round(settings.panelWidth)));
    }
  } catch {
    // No saved width: keep the default.
  }
  // First-party UI plugins first, so the UI exists before user
  // plugins register panels, views, tools and settings sections
  // into it. A first-party plugin that fails to load is a
  // broken app, so the failure is surfaced, not swallowed.
  // A first-party plugin is enabled unless the user explicitly
  // disabled it in Settings → Plugins: the same enabled map
  // that gates user plugins gates these too, so the core
  // plugins and user plugins behave the same. (Absent from the
  // map means enabled — the built-in UI is on by default.)
  let enabledMap: Record<string, boolean> = {};
  try {
    enabledMap = await b.getPluginEnabled();
  } catch {
    // No map yet: everything is enabled.
  }
  for (const fp of firstParty) {
    // A required plugin is always enabled, whatever the
    // enabled map says: a stale "false" in plugins.json
    // (from before the plugin became required, or from a
    // hand edit) must not lock the app out of its own
    // board or its Settings window.
    if (enabledMap[fp.manifest.id] === false && !fp.manifest.required) {
      // Still register it as loaded-but-inactive, so it
      // shows in Settings and can be re-enabled there. A
      // plugin skipped here never entered the loaded map,
      // so it vanished from the list entirely and the only
      // way back was editing plugins.json by hand. Its
      // bundled module is retained, so re-enabling it
      // re-activates the same module.
      loaded.set(fp.manifest.id, { manifest: fp.manifest, firstParty: true, firstPartyModule: fp.module, active: false, failed: false, error: null, module: null });
      continue;
    }
    try {
      await activateFirstPartyPlugin(fp.manifest, fp.module);
    } catch (e) {
      h.toast(`Built-in plugin ${fp.manifest.name} failed to load: ${String(e)}`);
    }
  }
  let manifests: PluginManifest[] = [];
  try {
    manifests = await b.listPlugins();
  } catch (e) {
    h.toast(`Could not list plugins: ${String(e)}`);
    pluginsReady = true;
    return;
  }
  for (const m of manifests) {
    loaded.set(m.id, { manifest: m, active: false, failed: false, error: null, module: null });
  }
  for (const m of manifests) {
    if (m.enabled === false) continue;
    if (m.apiVersion !== "2") {
      const lp = loaded.get(m.id)!;
      lp.failed = true;
      lp.error = `Requires plugin API ${m.apiVersion}, this app provides 2`;
      continue;
    }
    try {
      await activatePlugin(m);
    } catch (e) {
      const lp = loaded.get(m.id)!;
      lp.failed = true;
      lp.error = String(e);
      lp.active = false;
      unregisterPlugin(m.id);
      h.toast(`Plugin ${m.name} failed to load: ${String(e)}`);
    }
  }
  renderViewSwitcher();
  updatePanelDock();
  pluginsReady = true;
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  if (!bridge || !host) return;
  const lp = loaded.get(id);
  if (!lp) return;
  // A required plugin cannot be disabled: it is the
  // foundation (board, Settings) whose absence would
  // remove the only way to re-enable it.
  if (!enabled && lp.manifest.required) throw new Error(`${lp.manifest.name} is required and cannot be disabled`);
  // A trial plugin is owned by the Builder panel (Install/Clean),
  // not by the Settings toggle, so a toggle must not desync it
  // or write a persisted enabled state for a plugin that is
  // not on disk.
  if (lp.trial) return;
  await bridge.setPluginEnabled(id, enabled);
  lp.manifest.enabled = enabled;
  if (enabled && !lp.active && !lp.failed) {
    // A previously failed plugin gets one retry on re-enable; a
    // plugin that failed to load is not retried silently on every
    // toggle — the user re-enabling it is the retry.
    try {
      await activatePlugin(lp.manifest);
    } catch (e) {
      lp.failed = true;
      lp.error = String(e);
      lp.active = false;
      unregisterPlugin(id);
      host.toast(`Plugin ${lp.manifest.name} failed to load: ${String(e)}`);
    }
  } else if (!enabled && lp.active) {
    await deactivatePlugin(lp.manifest);
  } else if (enabled && lp.failed) {
    lp.failed = false;
    lp.error = null;
    try {
      await activatePlugin(lp.manifest);
    } catch (e) {
      lp.failed = true;
      lp.error = String(e);
      lp.active = false;
      unregisterPlugin(id);
      host.toast(`Plugin ${lp.manifest.name} failed to load: ${String(e)}`);
    }
  }
  host.render();
}

// Re-scan for plugins installed since startup, and activate
// any new ones that are enabled. Used after an install, so
// a new plugin runs without restarting the app. Existing
// plugins are untouched: this only adds manifests that are
// not already in the loaded map.
export async function refreshPlugins(): Promise<void> {
  if (!bridge || !host) return;
  let manifests: PluginManifest[] = [];
  try {
    manifests = await bridge.listPlugins();
  } catch {
    return;
  }
  for (const m of manifests) {
    if (loaded.has(m.id)) continue;
    loaded.set(m.id, { manifest: m, active: false, failed: false, error: null, module: null });
    if (m.enabled === false) continue;
    if (m.apiVersion !== "2") {
      const lp = loaded.get(m.id)!;
      lp.failed = true;
      lp.error = `Requires plugin API ${m.apiVersion}, this app provides 2`;
      continue;
    }
    try {
      await activatePlugin(m);
    } catch (e) {
      const lp = loaded.get(m.id)!;
      lp.failed = true;
      lp.error = String(e);
      lp.active = false;
      unregisterPlugin(m.id);
      host.toast(`Plugin ${m.name} failed to load: ${String(e)}`);
    }
  }
  renderViewSwitcher();
  updatePanelDock();
  host.render();
}
