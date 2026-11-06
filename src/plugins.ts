// Bowerbird Plugin API v1 — renderer side (see PLUGIN_API.md).
//
// A plugin is a folder with a manifest.json and a single-file
// main.js module. The main process discovers plugins and serves
// their files through IPC; this module loads them, builds the
// per-plugin API object, and owns the registries for cards, tools,
// panels, views and commands. The core (src/main.ts) owns the board
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

import type { Anchor, Board, Camera, Item, Kind, Pt, Size } from "./model";
import { anchorPoint, centre, clippedEnds, rectCrossing, segmentIntersectsRect } from "./model";

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
  contributions?: {
    cards?: Array<{ kind: string; title: string }>;
    tools?: Array<{ id: string; title: string }>;
    panels?: Array<{ id: string; title: string }>;
    views?: Array<{ id: string; title: string }>;
    commands?: Array<{ id: string; title: string }>;
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
  render: (item: Item, data: unknown) => string;
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

export interface PluginToolDef {
  id: string;
  title: string;
  icon?: string;
  onMouseDown?: (world: Pt) => void;
  onMouseUp?: (world: Pt) => void;
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
  isDemo: boolean;
  platform: string;
  fileUrl(path: string): string;
  embedFile(path: string): Promise<string>;
  readTextFile(path: string): Promise<string>;
  fileSize(path: string): Promise<number>;
  fetchPreview(url: string): Promise<{ title: string | null; description: string | null; image: string | null; icon: string | null }>;
  openExternal(target: string): Promise<void>;
  listBackups(): Promise<Array<{ name: string; items: number; size: number }>>;
  listPlugins(): Promise<PluginManifest[]>;
  readPluginFile(pluginId: string, relativePath: string): Promise<string>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean>;
  installPlugin(plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string; styleCode: string }): Promise<PluginManifest>;
  pluginStorageGet(pluginId: string, key: string): Promise<unknown>;
  pluginStorageSet(pluginId: string, key: string, value: unknown): Promise<void>;
  pluginStorageDelete(pluginId: string, key: string): Promise<void>;
  listBoards: () => Promise<Array<{ name: string; current: boolean; items: number }>>;
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
  addToLibrary: (filePath: string) => Promise<string>;
  // Window primitives: the main process owns the window and the
  // peek icon, so these are the only way a plugin can hide, show
  // or move the window. They are the existing preload bridge
  // methods, now available to plugins through api.window.
  collapse: () => Promise<void>;
  restore: () => Promise<void>;
  minimise: () => Promise<void>;
  moveWindow: (dx: number, dy: number) => void;
  getAppSettings: () => Promise<{ corner: string }>;
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
  updateItem: (id: number, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown }) => boolean;
  updateItems: (patches: Array<{ id: number; pos?: Pt; size?: Size; group?: number | null; data?: unknown }>) => boolean;
  moveItem: (id: number, toIndex: number) => boolean;
  removeItem: (id: number) => boolean;
  renderBoardCard: (id: number) => string | null;
  save: () => void;
  render: () => void;
  switchBoard: (name: string, preserveUndo?: boolean) => Promise<boolean>;
  setTool: (tool: string) => void;
  getPenColor: () => string;
  setPenColor: (hex: string) => boolean;
  getCamera: () => Camera;
  setCamera: (cam: Camera) => void;
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
    getSelected: () => number[];
    setSelected: (ids: number[]) => void;
    addItem: (kind: Kind, pos: Pt, size: Size) => number;
    addPluginCard: (kind: string, data: unknown, pos: Pt, size: Size) => number;
    updateItem: (id: number, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown }) => boolean;
    updateItems: (patches: Array<{ id: number; pos?: Pt; size?: Size; group?: number | null; data?: unknown }>) => boolean;
    moveItem: (id: number, toIndex: number) => boolean;
    removeItem: (id: number) => boolean;
    save: () => void;
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
    switch: (name: string) => Promise<boolean>;
    rename: (oldName: string, newName: string) => Promise<{ name: string }>;
    delete: (name: string) => Promise<{ wasCurrent: boolean }>;
  };
  // The app itself: build id, platform and demo mode. Read-only;
  // a plugin that shows a version or a demo notice uses these.
  app: {
    getBuildId: () => string;
    getPlatform: () => string;
    isDemo: () => boolean;
  };
  // Backups: list them (newest first) and restore one. A
  // restore loads the backup's board into the app, like
  // boards.switch, so it needs board:write and is not
  // available to a trial plugin.
  backups: {
    list: () => Promise<Array<{ name: string; items: number; size: number }>>;
    restore: (name: string) => Promise<boolean>;
  };
  window: {
    hide: () => Promise<void>;
    show: () => Promise<void>;
    minimise: () => Promise<void>;
    move: (dx: number, dy: number) => void;
    getCorner: () => Promise<string>;
    setCorner: (corner: string) => Promise<string>;
  };
  view: {
    getCamera: () => Camera;
    setCamera: (cam: Camera) => void;
    centreOn: (id: number) => void;
    getView: () => string;
    setView: (id: string) => void;
    listViews: () => Array<{ id: string; title: string; plugin: string | null }>;
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
    listCommands: () => Array<{ pluginId: string; pluginName: string; id: string; title: string }>;
    listTools: () => Array<{ pluginId: string; pluginName: string; id: string; title: string }>;
    runCommand: (pluginId: string, commandId: string) => Promise<void>;
    setTool: (id: string) => void;
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
    showPanel: (id: string) => void;
    hidePanel: (id: string) => void;
    getPanelElement: (id: string) => HTMLElement | null;
  };
  cards: {
    register: (def: PluginCardDef) => void;
  };
  files: {
    embedFile: (path: string) => Promise<string>;
    listLibrary: () => Promise<{ path: string; items: Array<{ name: string; path: string; relativePath: string; ext: string; kind: string; category: string | null; size_bytes: number; mtime_ms: number }>; categories: Array<{ name: string; count: number }>; uncategorizedCount: number }>;
  createLibraryCategory: (name: string) => Promise<string>;
  moveLibraryItem: (relativePath: string, category: string | null) => Promise<string>;
    addToLibrary: (path: string) => Promise<string>;
    fileUrl: (path: string) => string;
    readTextFile: (path: string) => Promise<string>;
    fileSize: (path: string) => Promise<number>;
    openExternal: (target: string) => Promise<void>;
    fetchPreview: (url: string) => Promise<{ title: string | null; description: string | null; image: string | null; icon: string | null }>;
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
    list: () => Array<{ id: string; name: string; version: string; description: string; active: boolean; failed: boolean; error: string | null; trial: boolean }>;
    // Enable or disable a plugin. This is plugin management,
    // so it needs the plugins:install permission, like
    // install. A trial plugin cannot be toggled this way.
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
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
  };
}

interface LoadedPlugin {
  manifest: PluginManifest;
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
const tools = new Map<string, PluginToolDef & { pluginId: string; fullId: string }>();
const panels = new Map<string, PluginPanelDef & { pluginId: string; el: HTMLElement; body: HTMLElement; tab: HTMLElement; hidden: boolean }>();
const views = new Map<string, PluginViewDef & { pluginId: string }>();
const commands = new Map<string, PluginCommandDef & { pluginId: string }>();
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
  toolbarToolsEl: HTMLElement;
  panelsEl: HTMLElement;
  panelsToggleEl: HTMLElement;
  pluginViewEl: HTMLElement;
  boardCanvasEls: HTMLElement[];
  viewSwitcherEl: HTMLElement;
  overlaysEl: HTMLElement;
  settingsSectionsEl: HTMLElement;
}
const shell: Partial<ShellElements> = {};
export function registerShellElements(els: Partial<ShellElements>): void {
  Object.assign(shell, els);
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

// Panel tabs state: one panel shown at a time, switched by
// its tab. `hidden` is the showPanel/hidePanel state (a
// panel with no tab); `activePanelKey` is which shown panel
// is on screen. `dockVisible` is the tab-bar close and
// title-bar toggle state — the dock can be closed while
// panels are still shown, so it can be reopened with its
// tabs and active panel intact.
let activePanelKey: string | null = null;
let dockVisible = true;
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
  if (shell.panelsEl) shell.panelsEl.style.width = open ? "290px" : "0px";
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
  activePanelKey = key;
  updatePanelDock();
}

function setDockVisible(visible: boolean): void {
  dockVisible = visible;
  updatePanelDock();
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
    version: "1",
    plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
    has: (capability: string) => {
      // Capabilities in v1: every domain documented in PLUGIN_API.md.
      // A future core may add more; a plugin should check before
      // using a capability that was added after v1.
      return ["board", "boards", "app", "backups", "view", "window", "ui", "cards", "files", "storage", "events", "tools", "panels", "commands", "views", "overlays", "settingsSections", "shortcuts", "library", "plugins", "pen"].includes(capability);
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
      getSelected: () => host!.getSelected(),
      setSelected: (ids: number[]) => host!.setSelected(ids),
      addItem: (kind: Kind, pos: Pt, size: Size) => {
        require("board:write");
        const id = host!.addItem(kind, pos, size);
        return id;
      },
      addPluginCard: (kind: string, data: unknown, pos: Pt, size: Size) => {
        require("board:write");
        const id = host!.addItem({ Plugin: { plugin: pluginId, kind, data } }, pos, size);
        return id;
      },
      updateItem: (id: number, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown }) => {
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
      updateItems: (patches: Array<{ id: number; pos?: Pt; size?: Size; group?: number | null; data?: unknown }>) => {
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
      isDemo: () => bridge!.isDemo,
    },
    backups: {
      list: async () => bridge!.listBackups(),
      restore: async (name: string) => {
        require("board:write");
        requireNotTrial("restore a backup");
        return host!.restoreBackup(name);
      },
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
      centreOn: (id: number) => host!.centreOn(id),
      getView: () => activeView,
      setView: (id: string) => setActiveView(id),
      listViews: () => {
        const out: Array<{ id: string; title: string; plugin: string | null }> = [{ id: "board", title: "Board", plugin: null }];
        for (const v of views.values()) out.push({ id: v.id, title: v.title, plugin: v.pluginId });
        return out;
      },
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
      // Commands are user actions, not code: listing and running
      // them is what Settings' Run buttons already do, so a
      // palette plugin can do the same without a permission.
      // A command still runs with its own plugin's API object,
      // so it cannot do anything its plugin could not do itself.
      listCommands: () => listPluginCommands().map((c) => ({ pluginId: c.pluginId, pluginName: c.pluginName, id: c.id, title: c.title })),
      listTools: () => Array.from(tools.values()).map((t) => ({ pluginId: t.pluginId, pluginName: loaded.get(t.pluginId)?.manifest.name ?? t.pluginId, id: t.fullId, title: t.title })),
      runCommand: (pid: string, cid: string) => runPluginCommand(pid, cid),
      setTool: (id: string) => host!.setTool(id),
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
      boardEl: host!.boardEl,
      registerSettingsUI: (ui: { open: () => void; close: () => void; isOpen: () => boolean; setTab: (tab: string) => void; refresh: () => void }) => registerSettingsUI(ui),
      setSettingsSectionsContainer: (el: HTMLElement) => registerShellElements({ settingsSectionsEl: el }),
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
      getPanelElement: (id: string) => {
        const p = panels.get(`${pluginId}:${id}`);
        return p ? p.body : null;
      },
    },
    cards: {
      register: (def: PluginCardDef) => {
        cards.set(`${pluginId}:${def.kind}`, { ...def, pluginId });
      },
    },
    files: {
      embedFile: async (path: string) => {
        require("files:embed");
        return bridge!.embedFile(path);
      },
      listLibrary: async () => {
        require("files:read");
        return bridge!.listLibrary();
      },
      addToLibrary: async (path: string) => {
        require("files:embed");
        return bridge!.addToLibrary(path);
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
        active: lp.active,
        failed: lp.failed,
        error: lp.error,
        trial: !!lp.trial,
      })),
      setEnabled: async (id: string, enabled: boolean) => {
        require("plugins:install");
        requireNotTrial("enable or disable a plugin");
        await setPluginEnabled(id, enabled);
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
    },
  };
}

// ---------------------------------------------------------------- registration

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
    // Header row: title plus a Disable button, so a plugin can
    // be turned off from its own settings without switching
    // back to the Plugins tab to find its row.
    const headRow = document.createElement("div");
    headRow.className = "plugin-settings-head";
    const head = document.createElement("h3");
    head.textContent = s.title;
    const toggle = document.createElement("button");
    toggle.className = "plugin-settings-toggle";
    toggle.textContent = "Disable";
    toggle.title = `Disable ${s.title}`;
    toggle.addEventListener("click", () => {
      void setPluginEnabled(s.pluginId, false);
      host?.render();
    });
    headRow.appendChild(head);
    headRow.appendChild(toggle);
    const body = document.createElement("div");
    wrap.appendChild(headRow);
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
    return `<div style="padding:12px"><div class="title" style="font-size:14px">Plugin card</div><div class="sub" style="font-size:12px">${escapeHtml(plugin)} — ${escapeHtml(kind)}</div><div class="sub" style="font-size:12px">Install the plugin to view this card. Your data is kept.</div></div>`;
  }
  try {
    return def.render(item, item.kind.Plugin.data);
  } catch (e) {
    return `<div style="padding:12px"><div class="title" style="font-size:14px">Plugin card failed to render</div><div class="sub" style="font-size:12px">${escapeHtml(String(e))}</div></div>`;
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
  const code = source ? source.mainCode : await bridge.readPluginFile(manifest.id, manifest.main);
  const blob = new Blob([code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
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
    URL.revokeObjectURL(url);
  }
}

// First-party plugins: bundled UI plugins that ship with the
// app. They are ES modules imported by the core, not single-file
// main.js loaded from a blob URL — that is the only difference
// from a user plugin. They get the same PluginContext, the same
// permission checks, and the same manifest, and they appear in
// the plugin list the same way. A first-party plugin has no back
// door: if it needs something, that something is in the API.
export async function activateFirstPartyPlugin(
  manifest: PluginManifest,
  mod: { activate?: (api: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> },
): Promise<void> {
  if (!bridge || !host) throw new Error("plugins are not ready yet");
  if (loaded.has(manifest.id)) throw new Error(`a plugin called ${manifest.id} already exists`);
  if (typeof mod.activate !== "function") {
    throw new Error(`Plugin ${manifest.id} does not export activate(api)`);
  }
  loaded.set(manifest.id, { manifest, active: false, failed: false, error: null, module: null });
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
    apiVersion: "1",
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
  // First-party UI plugins first, so the UI exists before user
  // plugins register panels, views, tools and settings sections
  // into it. A first-party plugin that fails to load is a
  // broken app, so the failure is surfaced, not swallowed.
  for (const fp of firstParty) {
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
    if (m.apiVersion !== "1") {
      const lp = loaded.get(m.id)!;
      lp.failed = true;
      lp.error = `Requires plugin API ${m.apiVersion}, this app provides 1`;
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
    if (m.apiVersion !== "1") {
      const lp = loaded.get(m.id)!;
      lp.failed = true;
      lp.error = `Requires plugin API ${m.apiVersion}, this app provides 1`;
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
