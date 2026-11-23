// Boot: load the board, build the shell, start the plugin host.
// The boot module's mutable state is gathered into one object
// (C) so the board operations in boards.ts can take it as an
// argument.

import { api } from "./backend/api";
import {
  type BootContext,
  healBoardItem, importBoard, isFrameCard, loadBoardFromJson, refreshStaleSources, resetBoardToWelcome, restoreBoardBackup, restoreRecoveryJournal, startBackgroundIndexing, startPosterBackfill, switchToBoard, syncGroupLabels, syncWatchedSources,
} from "./boards";
import { createMedia, type Media } from "./backend/media";
import { createCardRenderer, SHAPES, shapePreviewPoints, type CardRenderer } from "./backend/cards";
import { createBoardSearch, type BoardSearch } from "./backend/search";
import { createUndoStore, type UndoStore } from "./backend/undo";
import { createDrops, type Drops } from "./backend/drops";
import * as coreBoard from "./ui/board";
import * as coreCards from "./ui/cards";
import * as corePalette from "./ui/command-palette";
import * as coreDraw from "./ui/drawing-tools";
import * as coreSearch from "./ui/search";
import * as coreSettings from "./ui/settings";
import * as coreTitlebar from "./ui/titlebar";
import * as coreToolbar from "./ui/toolbar";
import { S } from "./ui/board-state";
import { measureNoteCardHeight } from "./ui/text-measure";
import { showRecoveryOffer } from "./ui/recovery-dialog";
import {
  Board, Camera, Item, Layer, Pt, ShapeKind, Size,
  boardGet, centre, clampZoom, createLayer, defaultLayer, deleteLayer, elementPoint, elementSize,
  getBoardExtension, healDuplicateIds, healLayers, hitTest, isItemLocked, isItemVisible, itemLayerId, itemsCentre,
  lassoSelect, layerById, marquee, moveLayer, moveSelection, removeBoardExtension, renameLayer,
  resizeItem, screenToWorld, select, setBoardExtension, setItemLayer, setLayerLocked,
  setLayerVisible, strokesWithin, zoomCamera,
} from "./backend/model";
import { welcomeBoard } from "./backend/welcome";
import {
  boardClearEditing, boardCommitEditing, boardDeleteSelected,
  boardGetEditingId, boardGetSelectMode, boardGetTool, boardGroupSelected, boardRender,
  boardSetSelectMode, boardSetTool, boardUngroupSelected, boardUpdateSelection,
  closeSettingsUI, emitPluginEvent, getBoardElements,
  initPlugins, isSettingsUIOpen,
  openSettingsUI,
  refreshSettingsUI, registerShellElements,
  type PluginHost,
} from "./plugins/host";

// ---------------------------------------------------------------- state

// Core tools are select/pen/connector/eraser. Plugin tools are strings of
// the form "plugin:<pluginId>:<toolId>" (see src/plugins/host.ts); the
// type stays open so a plugin tool is a valid Tool.
const PALETTE = ["#1A1A1A", "#E63946", "#2E86AB", "#FF6B35", "#6a4c93", "#2A9D8F"];


// The boot module's mutable state, gathered into one object so
// the file can split (the board operations live in boards.ts)
// without every function reaching for module-level lets. All
// references are C.<name>; the object is created once, at module
// load. The instances (media, search, cards, undoStore, drops)
// start as undefined and are assigned by the creation calls
// below, which run at module load in the same order. Fields set
// by init() (boardEl, cardsEl, toastEl) start as undefined and
// are filled in when the board plugin activates. The toast
// callback is wired up after the toast function below.
const C: BootContext = {
  board: {
    items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 0, next_group: 0,
    bg: "#FFFFFF", grid: "Dots",
  },
  boardDir: "",
  currentBuildId: "dev",
  boardGeneration: 0,
  penColor: PALETTE[0],
  shapeOutline: false,
  selected: [],
  toastTimer: null,
  toast: undefined as unknown as (msg: string) => void,
  measureNoteCardHeight,
  boardEl: undefined as unknown as HTMLDivElement,
  cardsEl: undefined as unknown as HTMLDivElement,
  toastEl: undefined as unknown as HTMLDivElement,
  boardSearchVersion: 0,
  media: undefined as unknown as Media,
  search: undefined as unknown as BoardSearch,
  cards: undefined as unknown as CardRenderer,
  undoStore: undefined as unknown as UndoStore,
  drops: undefined as unknown as Drops,
};

// ---------------------------------------------------------------- helpers

function toast(msg: string): void {
  C.toastEl.textContent = msg;
  C.toastEl.classList.add("show");
  if (C.toastTimer) clearTimeout(C.toastTimer);
  C.toastTimer = setTimeout(() => C.toastEl.classList.remove("show"), 4000);
}
// The board operations call toast through the context, so wire
// the context up to this implementation (defined here because
// the toast DOM is owned by the boot module).
C.toast = toast;


// Media owns the PDF and audio state (see src/media.ts); the
// context below is how it reads the board and asks the core
// to re-render or re-run a search after async work lands.
C.media = createMedia({
  getBoard: () => C.board,
  getBoardGeneration: () => C.boardGeneration,
  bumpSearchVersion: () => { C.boardSearchVersion++; },
  requestSearchUpdate: () => C.search.updateSearch(),
  requestRender: () => boardRender(),
  saveWithoutUndo: () => C.undoStore.saveWithoutUndo(),
  getCardsEl: () => C.cardsEl,
  toast,
});

// Search owns the MiniSearch index and the local-ML context
// index (see src/search.ts). Jumping to a match selects it,
// centres the camera on it, and saves (the camera moved). A
// match on a hidden layer is ghosted dimmed instead — the
// layer stays hidden, and the card is not selected.
C.search = createBoardSearch({
  getBoard: () => C.board,
  getBoardGeneration: () => C.boardGeneration,
  getBoardSearchVersion: () => C.boardSearchVersion,
  media: C.media,
  getCardsEl: () => C.cardsEl,
  onJumpTo: (target) => {
    let c: Pt;
    if (!isItemVisible(C.board, target)) {
      // A hidden layer's card stays hidden: centre on it
      // and ghost it dimmed, instead of selecting a card
      // the user cannot see.
      S.searchGhost = { board: C.board, id: target.id };
      c = centre(target);
    } else {
      S.searchGhost = null;
      C.selected = select(C.board, [], target.id, false);
      if (target.group !== null) {
        const members = C.board.items.filter((it) => it.group === target.group);
        c = itemsCentre(C.board, members) ?? centre(target);
      } else {
        c = centre(target);
      }
    }
    const bs = boardSize();
    C.board.camera.x = c.x - bs.x / 2 / C.board.camera.zoom;
    C.board.camera.y = c.y - bs.y / 2 / C.board.camera.zoom;
    C.undoStore.save();
    boardRender();
  },
});


// Card HTML lives in src/cards.ts; the renderer reads the
// selection and the editing card through these two getters.
C.cards = createCardRenderer({
  media: C.media,
  isSelected: (id) => C.selected.includes(id),
  getEditingId: () => boardGetEditingId(),
});

// Undo and saving live in src/undo.ts. The store reads the
// board and the selection, and asks the core to re-render
// and refresh the Settings canvas controls after an undo.
C.undoStore = createUndoStore({
  getBoard: () => C.board,
  getSelected: () => C.selected,
  setSelected: (ids) => { C.selected = ids; },
  clearEditing: () => { boardClearEditing(); },
  bumpSearchVersion: () => { C.boardSearchVersion++; },
  requestRender: () => boardRender(),
  refreshSettings: () => { refreshSettingsUI(); },
  toast,
  onSaveRefused: () => { void reloadFromDisk("refused"); },
});

// The settings window is a first-party plugin (core-settings).
// The core does not build it; it delegates through the plugin
// system (openSettingsUI / closeSettingsUI / isSettingsUIOpen),
// and the plugin registers itself at boot. See ARCHITECTURE.md.

// Drops and link previews live in src/drops.ts.
C.drops = createDrops({
  getBoard: () => C.board,
  allocId: () => allocId(),
  allocGroup: () => { C.board.next_group += 1; return C.board.next_group; },
  syncWatchedSources: () => syncWatchedSources(C),
  clearSelection: (ids) => { C.selected = C.selected.filter((s) => !ids.includes(s)); },
  save: () => { C.undoStore.save(); },
  saveWithoutUndo: () => C.undoStore.saveWithoutUndo(),
  requestRender: () => boardRender(),
  toWorld: (s) => toWorld(s),
  toast,
  probePdfSize: (path) => C.media.probePdfSize(path),
});

// Live imports: the stale check in boards.ts reaches the
// re-import through here (boards.ts never imports drops).
C.refreshLinkedSource = (path, stat) => C.drops.refreshSource(path, stat);

function toWorld(s: Pt): Pt {
  return screenToWorld(s, C.board.camera);
}
// The board no longer fills the window: the title bar sits
// above it, so board-local size and points differ from window
// size and client points by the bar's height. Every camera
// centre, cull and input conversion below goes through these,
// never window.innerWidth/innerHeight or raw clientX/Y.
function boardSize(): Pt {
  return elementSize(C.boardEl);
}
function boardPoint(clientX: number, clientY: number): Pt {
  return elementPoint(C.boardEl, clientX, clientY);
}
// The search ghost ends when its card becomes visible
// again — unhiding (or deleting) its layer un-ghosts it —
// or when the card itself is gone.
function clearSearchGhostIfVisible(): void {
  const g = S.searchGhost;
  if (g === null || g.board !== C.board) return;
  const it = boardGet(C.board, g.id);
  if (it === undefined || isItemVisible(C.board, it)) S.searchGhost = null;
}
// Reload the board from disk, like a same-board restore —
// the undo stack survives (loadBoardFromJson keeps it for
// the same folder), the redo chain clears — and tell plugins
// the content changed. Two callers: a genuine external
// change (an agent or a script rewrote board.json), and a
// refused save (the guard found the disk changed). The
// refused case says where the local edits went: they are
// preserved in the recovery journal, restorable from the
// Boards panel's Versions section.
async function reloadFromDisk(reason: "external" | "refused"): Promise<void> {
  try {
    const reloaded = await api.loadBoard();
    if (!reloaded.json) return;
    await loadBoardFromJson(C, reloaded.json, reloaded.board_dir);
    emitPluginEvent("board");
    toast(reason === "refused"
      ? "Board updated on disk — your changes are kept in Versions"
      : "Board updated on disk");
  } catch {
    // A reload that fails leaves the current board alone.
  }
}
function zoomAt(screen: Pt, factor: number): void {
  Object.assign(C.board.camera, zoomCamera(C.board.camera, screen, factor));
}
function zoomCentre(factor: number): void {
  const s = boardSize();
  zoomAt({ x: s.x / 2, y: s.y / 2 }, factor);
}
// Apply one item patch: position, size, group, layer, and — for
// plugin cards only — data. Shared by updateItem and
// updateItems.
function applyPatch(it: Item, patch: { pos?: Pt; size?: Size; group?: number | null; layer?: string; data?: unknown }): void {
  if (patch.pos) it.pos = patch.pos;
  if (patch.size) it.size = patch.size;
  if (patch.group !== undefined) it.group = patch.group;
  if (patch.layer !== undefined) it.layer = patch.layer;
  if (patch.data !== undefined && "Plugin" in it.kind) it.kind.Plugin.data = patch.data;
}
// Render one card as HTML, or null when it has none.
// plain renders at the origin (for embedding in a panel
// or view); the board position renders as it appears.
function renderCardHtml(id: number, plain: boolean): string | null {
  const it = boardGet(C.board, id);
  if (!it) return null;
  if ("Connector" in it.kind) return null;
  const html = C.cards.cardHtml(plain ? { ...it, pos: { x: 0, y: 0 } } : it, plain);
  return html === "" ? null : html;
}
function renderNodeCardChromeHtml(id: number): string | null {
  const it = boardGet(C.board, id);
  if (!it) return null;
  if ("Connector" in it.kind) return null;
  return C.cards.cardNodeChromeHtml(it);
}
// Validate and apply a camera, clamping the zoom. The
// floor is 0.01, not 0.1: fit (F) must be able to reach a
// very wide board. Shared by setCamera (which also saves
// and renders) and setCameraSilent. Returns false when the
// camera is not finite (ignored).
function applyCamera(cam: Camera): boolean {
  if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.zoom)) return false;
  const old = C.board.camera;
  C.board.camera = { x: cam.x, y: cam.y, zoom: clampZoom(cam.zoom) };
  // The camera event fires whenever the camera moves, not
  // only when the zoom changes: a pan changes x and y with
  // the zoom untouched, and the toolbar's note colour bar
  // (and anything else following the camera) must follow
  // it live, not only after a zoom.
  if (C.board.camera.x !== old.x || C.board.camera.y !== old.y || C.board.camera.zoom !== old.zoom) emitPluginEvent("camera");
  return true;
}
// Search documents and the MiniSearch index are cached
// by board version, not rebuilt on every keystroke:
// building the old cache key alone joined every doc's
// full text (including PDF text) on every keystroke,
// and render() re-ran updateSearch() on every visible
// change. The version bumps on save, on board switch,
// and when new PDF text or context labels land, so a
// cached index is never stale for the board it covers.



function allocId(): number {
  C.board.next_id += 1;
  return C.board.next_id;
}



function hitTestWithFrames(b: Board, world: Pt): number | null {
  // A frame is a container, not content: a card inside a frame
  // must win over the frame itself, or cards inside a slide
  // could never be grabbed, moved or edited once framed.
  // Try everything except frames first; only if nothing else
  // covers the point does the frame itself win, which is
  // exactly clicking empty space inside a frame. When the
  // plugin that owns a frame is disabled, its card def is
  // gone, so it falls back to a normal card, matching its
  // placeholder rendering, which is opaque, not a frame.
  const filtered: Board = { ...b, items: b.items.filter((it) => !isFrameCard(it)) };
  const hit = hitTest(filtered, world);
  if (hit !== null) return hit;
  return hitTest(b, world);
}

function bringToFront(ids: number[]): void {
  // A permanent reorder of the board: later items paint on
  // top. This is NOT what selecting does — selection fronts
  // a card visually only (applyStacking), and deselecting
  // returns it to its place, without touching the board
  // order. This method is for an explicit front command or
  // a plugin that means to reorder. Frames never come to
  // the front: their board order is a frame-based order (a
  // presentation's slide order), and moving a frame must not
  // reorder its slides. Frames also render as transparent
  // borders, so staying behind later cards is correct
  // visually, not just for order.
  const nonFrames = ids.filter((id) => {
    const it = boardGet(C.board, id);
    // A locked layer does not re-stack either.
    return it && !isFrameCard(it) && !isItemLocked(C.board, it);
  });
  const front = C.board.items.filter((it) => nonFrames.includes(it.id));
  const rest = C.board.items.filter((it) => !nonFrames.includes(it.id));
  C.board.items = [...rest, ...front];
}

// The title bar (window controls, undo/redo, panels
// toggle, search box) is the core-titlebar plugin now;
// it wires its own buttons. The search box is the
// core-search plugin; it hands its elements to the search
// engine. Nothing here wires title-bar DOM by id.
// The settings window is a plugin (core-settings) and owns its
// own buttons (reset, tabs, close, backdrop). The toolbar
// plugin wires its Settings button to toggle it through the
// plugin system. Nothing here wires title-bar or toolbar
// DOM by id.



// File drops from the OS arrive as HTML5 files in Electron.
// They are handed to the drops flow as File objects: text is
// read and media embedded from the File itself, so no file
// path is ever handed to the main process to open.
window.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  if ((e.target as HTMLElement).closest("#title-bar")) { e.preventDefault(); return; }
  if (files && files.length > 0) {
    e.preventDefault();
    void C.drops.dropPaths(Array.from(files), boardPoint(e.clientX, e.clientY));
  }
});

// Dragging a link straight from a browser: the webview's own drop event
// carries the URL as text, which Tauri's file drop does not.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const uri = e.dataTransfer?.getData("text/uri-list")?.split("\n")[0]?.trim()
    ?? e.dataTransfer?.getData("text/plain")?.trim() ?? "";
  if ((e.target as HTMLElement).closest("#title-bar")) return;
  if (/^https?:\/\//.test(uri)) {
    void C.drops.addUrlAt(toWorld(boardPoint(e.clientX, e.clientY)), uri);
  }
});

window.addEventListener("paste", (e: ClipboardEvent) => {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA") return;
  const files = e.clipboardData?.files;
  if (files && files.length > 0) {
    // An image on the clipboard (a screenshot, a copied
    // picture), or a file copied in Finder: the same flow
    // as a drop, landing at the centre of the view. Never
    // steal a paste meant for a text field.
    if (active && (active.tagName === "INPUT" || (active as HTMLElement).isContentEditable)) return;
    e.preventDefault();
    const bs = boardSize();
    void C.drops.dropPaths(Array.from(files), { x: bs.x / 2, y: bs.y / 2 });
    return;
  }
  const text = e.clipboardData?.getData("text")?.trim() ?? "";
  if (/^https?:\/\//.test(text)) {
    e.preventDefault();
    const bs = boardSize();
    void C.drops.addUrlAt(toWorld({ x: bs.x / 2, y: bs.y / 2 }), text);
  }
});

// ---------------------------------------------------------------- init

async function init(): Promise<void> {
  let panelOrderList: string[] = [];
  // A journal that holds edits board.json does not: offer to
  // restore it once the board is up. Captured here, shown at
  // the end of init, over the live board.
  let recoveryOffer: { hasRecovery: boolean; savedAt: number | null } | null = null;
  try {
    const loaded = await api.loadBoard();
    recoveryOffer = loaded.recovery ?? null;
    C.boardDir = loaded.board_dir;
    if (Array.isArray(loaded.panelOrder)) panelOrderList = loaded.panelOrder.filter((x: unknown) => typeof x === "string");
    C.currentBuildId = loaded.buildId ?? "dev";
    if (loaded.json) {
      const parsed = JSON.parse(loaded.json) as Board;
      C.board = parsed;
      C.boardGeneration++;
      C.board.bg = C.board.bg ?? "#FFFFFF";
      C.board.grid = C.board.grid ?? "Dots";
      C.board.camera = C.board.camera ?? { x: 0, y: 0, zoom: 1 };
      // Same heal as loadBoardFromJson: startup parses the
      // board inline and never calls it.
      healDuplicateIds(C.board);
      healLayers(C.board);
      for (const it of C.board.items) {
        if ("UrlCard" in it.kind) {
          // Old boards may carry embed:true from the embedded-page era;
          // link cards are previews only now, so it is ignored.
          it.kind.UrlCard.image = it.kind.UrlCard.image ?? null;
          it.kind.UrlCard.icon = it.kind.UrlCard.icon ?? null;
        }
        healBoardItem(it, measureNoteCardHeight);
      }
    } else {
      C.board = welcomeBoard(C.boardDir, loaded.pdf_size_bytes, loaded.video_size_bytes ?? 0, loaded.model_size_bytes ?? 0, loaded.psd_size_bytes ?? 0, loaded.ai_size_bytes ?? 0);
      healLayers(C.board);
      C.undoStore.save();
    }
    // Self-heal for welcome media: if a welcome item points
    // at a board file that is missing or empty, but the
    // bundle copy exists, point the item at the bundle
    // copy and save. This fixes the board permanently,
    // instead of relying on the file handler's fallback
    // on every load, and it works even if the board
    // folder itself is the wrong or broken one.
    try {
      const WELCOME = ["welcome-bower.jpg", "welcome-birdsong.mp3", "welcome-video.mp4", "sample.pdf", "welcome-cube.glb", "welcome-garden.psd", "welcome-heron.ai", "welcome-garden-preview.png", "welcome-heron-preview.png"];
      let healed = false;
      for (const it of C.board.items) {
        // A FileCard holds two paths (source + preview); every
        // other welcome card holds one. The kind's data is
        // captured in a const so the closures below keep the
        // narrowed type (a closure over it.kind does not).
        const paths: Array<{ get: () => string; set: (p: string) => void }> = [];
        if ("Image" in it.kind) { const d = it.kind.Image; paths.push({ get: () => d.path, set: (p: string) => { d.path = p; } }); }
        else if ("Audio" in it.kind) { const d = it.kind.Audio; paths.push({ get: () => d.path, set: (p: string) => { d.path = p; } }); }
        else if ("Video" in it.kind) { const d = it.kind.Video; paths.push({ get: () => d.source, set: (p: string) => { d.source = p; } }); }
        else if ("PdfCard" in it.kind) { const d = it.kind.PdfCard; paths.push({ get: () => d.path, set: (p: string) => { d.path = p; } }); }
        else if ("Model3D" in it.kind) { const d = it.kind.Model3D; paths.push({ get: () => d.path, set: (p: string) => { d.path = p; } }); }
        else if ("FileCard" in it.kind) {
          const fc = it.kind.FileCard;
          paths.push({ get: () => fc.path, set: (p: string) => { fc.path = p; } });
          if (fc.preview) paths.push({ get: () => fc.preview as string, set: (p: string) => { fc.preview = p; } });
        }
        for (const { get, set } of paths) {
          const p = get();
          const name = p.split("/").pop() ?? "";
          if (!WELCOME.includes(name)) continue;
          const info = await api.checkFile(p);
          if ((info.exists && info.size > 0) || !info.bundleExists || info.bundleSize <= 0) continue;
          set(info.bundlePath);
          healed = true;
        }
      }
      if (healed) C.undoStore.saveWithoutUndo();
    } catch { /* a failed heal must never block startup */ }
  } catch (err) {
    toast(`Could not load the board: ${String(err)}`);
    C.board = welcomeBoard(C.boardDir, 0, 0, 0, 0, 0);
  }
  // The loaded board is the first undo baseline: nothing before
  // it is undoable, and the first saved change pushes it as step 1.
  C.undoStore.resetUndo();
  // Live follow: an agent or a script rewrote board.json on disk.
  // Reload it like a same-board restore — the undo stack survives
  // (loadBoardFromJson keeps it for the same folder), the redo
  // chain clears — and tell plugins the content changed.
  api.onExternalBoardChange(() => void reloadFromDisk("external"));
  // Live imports: a source file changed on disk — re-import
  // the group linked to it.
  api.onSourceChanged((ev) => void C.drops.refreshSource(ev.path, { exists: ev.exists, size: ev.size, mtimeMs: ev.mtimeMs }));
  // Live imports: the board is up, so tell the main process
  // which source files to watch (loadBoardFromJson does the
  // same after every later load; init parses inline).
  syncWatchedSources(C);
  // A source may be newer than its cards already (edited
  // while the app was closed): re-import the stale groups.
  void refreshStaleSources(C);
  // Panel tab order, loaded with the board: the plugin system
  // applies it once panels are registered, and saves it back
  // whenever the user drags a tab.
  const pluginHost: PluginHost = {
    getBoard: () => C.board,
    getSelected: () => C.selected,
    setSelected: (ids: number[]) => { C.selected = ids; boardUpdateSelection(); },
    addItem: (kind, pos, size) => {
      const id = allocId();
      C.board.items.push({ id, pos, size, group: null, kind });
      C.undoStore.save(); boardRender();
      return id;
    },
    // Add an item without saving or rendering, for a text
    // note that is about to be edited. The edit commit
    // saves it, or removes it if left empty.
    addItemSilent: (kind, pos, size) => {
      const id = allocId();
      C.board.items.push({ id, pos, size, group: null, kind });
      return id;
    },
    addItems: (items) => {
      // One save for the whole batch, so building a structure
      // is one undo step, not one per card: addItem saves
      // after every item, and a mind map of eleven cards
      // would otherwise take eleven undos to undo.
      const ids: number[] = [];
      for (const { kind, pos, size } of items) {
        const id = allocId();
        C.board.items.push({ id, pos, size, group: null, kind });
        ids.push(id);
      }
      if (ids.length > 0) { C.undoStore.save(); boardRender(); }
      return ids;
    },
    updateItem: (id, patch) => {
      const it = boardGet(C.board, id);
      if (!it) return false;
      // A locked layer does not edit: the patch is refused
      // whole, so a locked card never moves halfway. A layer
      // that does not exist is refused the same way, so a
      // patch can never strand an item on a missing layer.
      if (isItemLocked(C.board, it)) return false;
      if (patch.layer !== undefined && !layerById(C.board, patch.layer)) return false;
      applyPatch(it, patch);
      syncGroupLabels(C.board);
      C.undoStore.save(); boardRender();
      return true;
    },
    updateItems: (patches) => {
      // One save for the whole batch, so one tidy action
      // is one undo step, not one per card: updateItem
      // saves after every item, and a five-card align
      // would otherwise take five undos to undo.
      let changed = false;
      for (const { id, ...patch } of patches) {
        const it = boardGet(C.board, id);
        if (!it) continue;
        if (isItemLocked(C.board, it)) continue;
        if (patch.layer !== undefined && !layerById(C.board, patch.layer)) continue;
        applyPatch(it, patch);
        changed = true;
      }
      if (!changed) return false;
      syncGroupLabels(C.board);
      C.undoStore.save(); boardRender();
      return true;
    },
    moveItem: (id, toIndex) => {
      // Board order is the order things paint and, for frames,
      // the slide order, so moving an item here reorders it
      // everywhere that order matters, and saves like any
      // other board change, so it is undoable.
      const from = C.board.items.findIndex((it) => it.id === id);
      if (from < 0) return false;
      if (isItemLocked(C.board, C.board.items[from])) return false;
      const [it] = C.board.items.splice(from, 1);
      const clamped = Math.max(0, Math.min(toIndex, C.board.items.length));
      C.board.items.splice(clamped, 0, it);
      C.undoStore.save(); boardRender();
      return true;
    },
    removeItem: (id) => {
      const it = boardGet(C.board, id);
      if (it && isItemLocked(C.board, it)) return false;
      const before = C.board.items.length;
      C.board.items = C.board.items.filter((it) => it.id !== id);
      if (C.board.items.length === before) return false;
      C.selected = C.selected.filter((s) => s !== id);
      syncGroupLabels(C.board);
      C.undoStore.save(); boardRender();
      return true;
    },
    // Layers and per-board plugin data (see model.ts): each
    // layer change saves and renders, so it is one undo step.
    getLayers: () => JSON.parse(JSON.stringify(C.board.layers ?? [defaultLayer()])) as Layer[],
    createLayer: (name?: string) => {
      const layer = createLayer(C.board, name);
      C.undoStore.save(); boardRender();
      return JSON.parse(JSON.stringify(layer)) as Layer;
    },
    renameLayer: (id, name) => {
      const ok = renameLayer(C.board, id, name);
      if (ok) { C.undoStore.save(); boardRender(); }
      return ok;
    },
    moveLayer: (id, toIndex) => {
      const ok = moveLayer(C.board, id, toIndex);
      if (ok) { C.undoStore.save(); boardRender(); }
      return ok;
    },
    setLayerVisible: (id, visible) => {
      const ok = setLayerVisible(C.board, id, visible);
      if (ok) { clearSearchGhostIfVisible(); C.undoStore.save(); boardRender(); }
      return ok;
    },
    setLayerLocked: (id, locked) => {
      const ok = setLayerLocked(C.board, id, locked);
      if (ok) { C.undoStore.save(); boardRender(); }
      return ok;
    },
    deleteLayer: (id) => {
      const ok = deleteLayer(C.board, id);
      if (ok) { clearSearchGhostIfVisible(); C.undoStore.save(); boardRender(); }
      return ok;
    },
    getItemLayer: (id) => {
      const it = boardGet(C.board, id);
      return it ? itemLayerId(it) : null;
    },
    setItemLayer: (id, layerId) => {
      const it = boardGet(C.board, id);
      if (!it || isItemLocked(C.board, it)) return false;
      const ok = setItemLayer(C.board, id, layerId);
      if (ok) { C.undoStore.save(); boardRender(); }
      return ok;
    },
    getExtension: (pluginId) => getBoardExtension(C.board, pluginId),
    setExtension: (pluginId, data) => {
      // Throws when the data is not JSON: the write never
      // lands half-broken.
      setBoardExtension(C.board, pluginId, data);
      C.undoStore.save(); boardRender();
    },
    removeExtension: (pluginId) => {
      const ok = removeBoardExtension(C.board, pluginId);
      if (ok) { C.undoStore.save(); boardRender(); }
      return ok;
    },
    renderBoardCard: (id) => renderCardHtml(id, true),
    // The same card as it appears on the board: real
    // position, selection state and editing exclusion.
    // The board view builds the card DOM from this.
    renderBoardCardAt: (id) => renderCardHtml(id, false),
    renderNodeCardChromeAt: (id) => renderNodeCardChromeHtml(id),
    hitTest: (world: Pt) => hitTestWithFrames(C.board, world),
    // Selection queries for the board view's drags. Pure
    // reads over the live board, no save, no render.
    marqueeSelect: (a: Pt, b: Pt) => marquee(C.board, a, b),
    lassoSelect: (points: Pt[]) => lassoSelect(C.board, points),
    strokesNear: (point: Pt, radius: number) => strokesWithin(C.board, point, radius),
    // Live-drag mutations for the board view only. They
    // change the live board without saving or rendering;
    // the drag saves once at drag end. They fire
    // "items-moved" so a listener that follows a card —
    // the toolbar's note colour bar — can track it live,
    // instead of waiting for the save-time "board" event.
    moveItems: (ids: number[], dx: number, dy: number) => { moveSelection(C.board, ids, dx, dy); emitPluginEvent("items-moved"); },
    resizeItem: (id: number, w: number, h: number) => { resizeItem(C.board, id, w, h); emitPluginEvent("items-moved"); },
    setItemRotation: (id: number, rot: number) => {
      const it = boardGet(C.board, id);
      if (it && !isItemLocked(C.board, it)) it.rotation = rot;
    },
    removeItems: (ids: number[]) => {
      // A locked layer does not delete: its ids are dropped
      // from the removal, and the rest go as before.
      const kept = ids.filter((id) => {
        const it = boardGet(C.board, id);
        return !it || !isItemLocked(C.board, it);
      });
      C.board.items = C.board.items.filter((it) => !kept.includes(it.id));
      C.selected = C.selected.filter((s) => !kept.includes(s));
      syncGroupLabels(C.board);
    },
    bringToFront: (ids: number[]) => { bringToFront(ids); },
    // Set a text note's text (and its height, from the text),
    // without saving or rendering. The board view's text
    // commit saves once after the edit.
    setTextContent: (id: number, text: string) => {
      const it = boardGet(C.board, id);
      if (!it || !("Text" in it.kind)) return false;
      if (isItemLocked(C.board, it)) return false;
      it.kind.Text.text = text;
      // The card keeps room for its bottom row (checklist
      // progress) below the text, so the row never covers
      // the last line. The height is measured from the
      // text as rendered, not estimated, or the empty
      // space at the note's bottom grows with every
      // paragraph.
      it.size.h = measureNoteCardHeight(text, it.kind.Text.size, it.size.w);
      return true;
    },
    // Rename a group's label. One save, one undo
    // step. False when the group has fewer than two members
    // or the label is empty after trimming.
    setGroupLabel: (group: number, label: string) => {
      const members = C.board.items.filter((it) => it.group === group);
      if (members.length < 2) return false;
      const trimmed = label.trim();
      if (!trimmed) return false;
      C.board.groups = C.board.groups ?? {};
      C.board.groups[group] = { label: trimmed };
      C.undoStore.save(); boardRender();
      return true;
    },
    // Rename a voice note: the title is shown instead of
    // the file's name. One save, one undo step. An empty
    // title clears it, so the card falls back to the file's
    // name. False when the card is not audio, or the title
    // is unchanged.
    setAudioTitle: (id: number, title: string) => {
      const it = boardGet(C.board, id);
      if (!it || !("Audio" in it.kind)) return false;
      if (isItemLocked(C.board, it)) return false;
      const trimmed = title.trim();
      const current = it.kind.Audio.title ?? "";
      if (trimmed === current) return false;
      if (trimmed) it.kind.Audio.title = trimmed;
      else delete it.kind.Audio.title;
      C.undoStore.save(); boardRender();
      return true;
    },
    // Group a set of cards: a new group id comes from the
    // board's next_group, so a later group can never collide
    // with it. One save, one undo step.
    createGroup: (ids: number[]) => {
      // Locked cards do not group: they are left out, and
      // fewer than two left means no group.
      const unlocked = ids.filter((id) => {
        const it = boardGet(C.board, id);
        return it && !isItemLocked(C.board, it);
      });
      if (unlocked.length < 2) return null;
      C.board.next_group += 1;
      const g = C.board.next_group;
      for (const it of C.board.items) if (unlocked.includes(it.id)) it.group = g;
      C.board.groups = C.board.groups ?? {};
      C.board.groups[g] = { label: `Group ${g}` };
      C.undoStore.save(); boardRender();
      return g;
    },
    save: () => C.undoStore.save(),
    saveWithoutUndo: () => C.undoStore.saveWithoutUndo(),
    saveSync: () => C.undoStore.saveSync(),
    render: () => boardRender(),
    switchBoard: (name: string, preserveUndo = false) => switchToBoard(C, name, preserveUndo),
    setTool: (toolName: string) => boardSetTool(toolName),
    getTool: () => boardGetTool(),
    setSelectMode: (mode: "select" | "lasso") => boardSetSelectMode(mode),
    getSelectMode: () => boardGetSelectMode(),
    // Zoom around the board centre, by a factor. The
    // toolbar's zoom buttons. The camera math stays here;
    // the plugin just says "zoom in" or "zoom out".
    zoomBy: (factor: number) => { const z = C.board.camera.zoom; zoomCentre(factor); if (C.board.camera.zoom !== z) emitPluginEvent("camera"); boardRender(); },
    // The shape table for the toolbar's shape picker.
    listShapes: () => SHAPES.map((s) => ({ kind: s.kind, label: s.label, key: s.key, svg: s.svg })),
    // Drag-preview polygon points for a shape. The board
    // view draws the live shape preview from this.
    shapePreviewPoints: (kind: string, x0: number, y0: number, w: number, h: number) => shapePreviewPoints(kind as ShapeKind, x0, y0, w, h),
    // Whether new shapes are outlines or filled.
    getShapeOutline: () => C.shapeOutline,
    setShapeOutline: (outline: boolean) => { C.shapeOutline = outline; },
    // Set the background of the given text notes, in one
    // save (one undo step). The toolbar's note-colour
    // flyout. Only Text notes are affected.
    setNoteBackground: (ids: number[], hex: string) => {
      for (const id of ids) {
        const it = boardGet(C.board, id);
        if (it && "Text" in it.kind && !isItemLocked(C.board, it)) it.kind.Text.bg = hex;
      }
      C.undoStore.save(); boardRender();
    },
    // Search: hand the engine the search box elements
    // (built by the core-search plugin), re-run the search,
    // clear it, or jump to a match. The engine owns the
    // matching, the dimming and the results.
    setSearchElements: (els: { input: HTMLInputElement; count: HTMLElement; clear: HTMLButtonElement; results: HTMLElement }) => {
      C.search.setSearchElements(els);
    },
    updateSearch: () => { C.search.updateSearch(); },
    clearSearch: () => { C.search.clearSearch(); },
    jumpToSearchIndex: (idx: number) => { C.search.jumpToSearchIndex(idx); },
    getPenColor: () => C.penColor,
    setPenColor: (hex: string) => {
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
      C.penColor = hex.toUpperCase();
      // The toolbar plugin follows the pen colour through
      // the "pen" plugin event, so its swatches update
      // without a full board render per pick — one per
      // pointermove while dragging Palette's wheel would
      // rebuild every visible card for nothing.
      emitPluginEvent("pen");
      return true;
    },
    getCamera: () => C.board.camera,
    setCamera: (cam) => {
      if (!applyCamera(cam)) return;
      C.undoStore.save(); boardRender();
    },
    // Set the camera without saving or rendering, for a live
    // pan or zoom drag. The drag saves once at drag end.
    setCameraSilent: (cam) => {
      applyCamera(cam);
    },
    setCanvas: (patch) => {
      if (patch.bg !== undefined) C.board.bg = patch.bg;
      if (patch.grid !== undefined) C.board.grid = patch.grid;
      C.undoStore.save(); boardRender();
    },
    get boardEl(): HTMLElement {
      // The board DOM is built by the core-board plugin, so
      // this reads the module-level boardEl, which is
      // assigned from the shell after the plugin activates.
      return C.boardEl;
    },
    centreOn: (id) => {
      const it = boardGet(C.board, id);
      if (!it) return;
      C.selected = select(C.board, [], id, false);
      const c = centre(it);
      const bs = boardSize();
      C.board.camera.x = c.x - bs.x / 2 / C.board.camera.zoom;
      C.board.camera.y = c.y - bs.y / 2 / C.board.camera.zoom;
      C.undoStore.save(); boardRender();
    },
    toast: (msg: string) => toast(msg),
    commitEditing: () => boardCommitEditing(),
    openSettings: () => openSettingsUI(),
    closeSettings: () => closeSettingsUI(),
    isSettingsOpen: () => isSettingsUIOpen(),
    undo: () => C.undoStore.undo(),
    redo: () => C.undoStore.redo(),
    canUndo: () => C.undoStore.canUndo(),
    canRedo: () => C.undoStore.canRedo(),
    groupSelection: () => boardGroupSelected(),
    ungroupSelection: () => boardUngroupSelected(),
    deleteSelection: () => boardDeleteSelected(),
    restoreBackup: (name) => restoreBoardBackup(C, name),
    restoreRecovery: () => restoreRecoveryJournal(C),
    importBoard: () => importBoard(C),
    getBuildId: () => C.currentBuildId,
    // Media state, for the cards that play or preview media.
    // The raw audio element is never handed out; the plugin
    // gets the derived playback state (id, playing, time,
    // duration) instead, so it can render a play/pause button
    // and a progress bar without touching the element.
    getAudioState: () => {
      const s = C.media.getAudioState();
      const el = s.el;
      return {
        id: s.id,
        playing: !!el && !el.paused,
        currentTime: el ? el.currentTime : 0,
        duration: el && isFinite(el.duration) ? el.duration : 0,
      };
    },
    getAudioDuration: (path) => C.media.audioDurations.get(path),
    loadAudioDuration: (id, path) => C.media.loadAudioDuration(id, path),
    getAudioPeaks: (path) => C.media.getAudioPeaks(path),
    loadAudioPeaks: (id, path) => C.media.loadAudioPeaks(id, path),
    // Seek an audio card to a time in seconds, whether or
    // not it is playing. The board view's waveform: a click
    // on a card that is not playing loads it paused at that
    // time, so play starts there.
    seekAudioTo: (id, path, time) => { C.media.seekAudioTo(id, path, time); },
    transcribeAudio: (blob) => C.media.transcribeAudio(blob),
    audioFailed: (path) => C.media.audioFailed.has(path),
    formatAudioTime: (sec) => C.media.formatAudioTime(sec),
    // Toggle playback of an audio card. The board view's
    // play button.
    toggleAudio: (id, path) => { C.media.toggleAudio(id, path); },
    // Show the live <video> element for a video card. The
    // board view's play button on a poster. At most one card
    // is live; playing another moves it there.
    playVideo: (id) => { C.media.playVideo(id); },
    getVideoState: () => C.media.getVideoState(),
    // Seek the playing audio card to a time in seconds.
    // No-op when that card is not the one playing; the
    // waveform uses seekAudioTo instead.
    seekAudio: (id, time) => {
      const s = C.media.getAudioState();
      if (s.el && s.id === id) {
        s.el.currentTime = time;
        C.media.updateAudioProgress();
      }
    },
    getPdfPage: (id) => C.media.pdfPages.get(id) ?? 1,
    loadPdfPage: (id, path) => C.media.loadPdfPage(id, path),
    loadFileCardSize: (preview) => C.media.loadFileCardSize(preview),
    loadVideoCardSize: (poster) => C.media.loadVideoCardSize(poster),
    probePdfSize: (path) => C.media.probePdfSize(path),
    loadPdfCardSize: (path) => C.media.loadPdfCardSize(path),
    loadLinkCardSize: (image) => C.media.loadLinkCardSize(image),
    // Move a PDF card to a page (clamped to the document),
    // and render it. The board view's prev/next buttons.
    // False when the document is not loaded yet.
    setPdfPage: async (id, path, page) => {
      const docP = C.media.getCachedPdfDoc(path);
      if (!docP) return false;
      const doc = await docP;
      const next = Math.max(1, Math.min(page, doc.numPages));
      C.media.pdfPages.set(id, next);
      void C.media.renderPdfPage(id, path);
      return true;
    },
    pdfFailed: (path) => C.media.pdfFailed.has(path),
    resetBoard: (opts?: { confirmed?: boolean }) => resetBoardToWelcome(C, opts),
    getBoardDir: () => C.boardDir,
    getPanelOrder: () => [...panelOrderList],
    setPanelOrder: (order: string[]) => {
      panelOrderList = order.filter((x) => typeof x === "string");
      void api.setPanelOrder(panelOrderList);
    },
  };
  // The shell: the DOM the plugin system manages. The core
  // still builds this shell today (index.html), so it
  // registers the elements here; as each surface moves into
  // a plugin, that plugin registers its own elements instead
  // and the core stops building them. The plugin system only
  // ever reads them through the shell, never from the core.
  registerShellElements({
    // toolbarToolsEl is registered by the toolbar plugin
    // itself (core-toolbar), which builds the toolbar and
    // its #tools segment. panelsToggleEl is registered by
    // the title bar plugin itself (core-titlebar), which
    // builds the title bar and its toggle button. The board
    // elements (board, canvas layers, plugin view, overlays,
    // view switcher, toast) are registered by the board
    // plugin itself (core-board), which builds the board DOM.
    panelsEl: document.getElementById("plugin-panels") as HTMLElement,
    // settingsSectionsEl is registered by the settings plugin
    // itself (core-settings), which builds that container.
  });
  await initPlugins(pluginHost, api, [
    // Board first: the toolbar appends to it, the title bar
    // inserts before it, and the core reads its elements
    // from the shell after this call.
    { manifest: coreBoard.manifest, module: coreBoard },
    // Drawing tools before the toolbar: their registerTool
    // calls land first, so no second set of buttons is made —
    // the toolbar owns the buttons, this plugin the gestures.
    { manifest: coreDraw.manifest, module: coreDraw },
    // After the board: the palette's overlay mounts into
    // the board's overlay element.
    { manifest: corePalette.manifest, module: corePalette },
    { manifest: coreSettings.manifest, module: coreSettings },
    { manifest: coreCards.manifest, module: coreCards },
    { manifest: coreToolbar.manifest, module: coreToolbar },
    // Title bar before search: the search plugin mounts
    // its box into the container the title bar builds.
    { manifest: coreTitlebar.manifest, module: coreTitlebar },
    { manifest: coreSearch.manifest, module: coreSearch },
  ]);
  // The board DOM is built by the core-board plugin, so the
  // core reads its elements from the shell now, after the
  // plugin has activated. Before this they are undefined.
  // The board DOM is built by the core-board plugin, so the
  // core reads its elements from the shell now, after the
  // plugin has activated. Before this they are undefined.
  // The core keeps only the board element (the host's
  // boardEl mount point), the cards element (for the media
  // and search modules) and the toast element.
  {
    const els = getBoardElements();
    if (els.board) C.boardEl = els.board as HTMLDivElement;
    if (els.canvas) {
      const [, , c] = els.canvas;
      if (c) C.cardsEl = c as HTMLDivElement;
    }
    if (els.toast) C.toastEl = els.toast as HTMLDivElement;
  }
  // The board plugin attached its own listeners in activate().
  // Render once the board DOM exists.
  boardRender();
  // Preload the context index now, in the background,
  // so the first search does not pay the index-load
  // cost on top of everything else — and start indexing
  // the board's media once idle, for the same reason.
  void C.search.loadContextIndex();
  startBackgroundIndexing(C);
  startPosterBackfill(C);
  // Fill in previews for cards that never got one (welcome card, old
  // boards): title, description, image and icon, in the background.
  void C.drops.refreshLinkPreviews();
  // Crash recovery, offered once at launch: the journal holds
  // edits board.json does not. Restoring loads the journalled
  // board (the current board is backed up first, so the choice
  // is reversible); discarding drops the journal.
  if (recoveryOffer?.hasRecovery && typeof recoveryOffer.savedAt === "number") {
    showRecoveryOffer({
      savedAt: recoveryOffer.savedAt,
      onRestore: async () => {
        await restoreRecoveryJournal(C);
      },
      onDiscard: async () => {
        try {
          await api.recoveryDiscard();
          toast("Unsaved changes discarded");
        } catch { /* the journal is gone already */ }
      },
    });
  }
}


void init();
