import { api } from "./api";
import { createMedia, type Media } from "./media";
import { createCardRenderer, SHAPES, shapePreviewPoints, type CardRenderer } from "./cards";
import { createBoardSearch, type BoardSearch } from "./search";
import { createUndoStore, type UndoStore } from "./undo";
import { createDrops, type Drops } from "./drops";
import * as coreBoard from "./core-plugins/board";
import * as coreCards from "./core-plugins/cards";
import * as coreSearch from "./core-plugins/search";
import * as coreSettings from "./core-plugins/settings";
import * as coreTitlebar from "./core-plugins/titlebar";
import * as coreToolbar from "./core-plugins/toolbar";
import {
  Board, Camera, Item, Pt, ShapeKind,
  AUDIO_TRANSCRIPT_HIDDEN_H, boardGet, CARD_DECORATIONS_H, centre, clampZoom, elementPoint, elementSize,
  estimateTextHeight, hitTest, itemBounds, lassoSelect, marquee, moveSelection,
  resizeItem, screenToWorld, select, strokesWithin, zoomCamera,
} from "./model";
import { welcomeBoard } from "./welcome";
import {
  boardClearEditing, boardCommitEditing, boardDeleteSelected,
  boardGetEditingId, boardGetTool, boardGroupSelected, boardRender,
  boardSetTool, boardUngroupSelected, boardUpdateSelection,
  closeSettingsUI, emitPluginEvent, getBoardElements, getCardRenderer,
  initPlugins, isSettingsUIOpen,
  openSettingsUI,
  refreshSettingsUI, registerShellElements,
  type PluginHost,
} from "./plugins";

// ---------------------------------------------------------------- state

// Core tools are select/pen/connector/eraser. Plugin tools are strings of
// the form "plugin:<pluginId>:<toolId>" (see src/plugins.ts); the
// type stays open so a plugin tool is a valid Tool.
const PALETTE = ["#1A1A1A", "#E63946", "#2E86AB", "#FF6B35", "#6a4c93", "#2A9D8F"];


let board: Board = {
  items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 0, next_group: 0,
  bg: "#FFFFFF", grid: "Dots",
};
let boardDir = "";
// Build id for this run (git short hash in a packaged build,
// "dev" from source). Set at board load; the feedback mail
// carries it so a report can be matched to the exact build.
let currentBuildId = "dev";
// Board generation: bumped on every board load, so async
// work started for one board (a PDF render, a search
// index, an audio probe) can tell, after an await, that
// the user has switched boards and must not write its
// result into the new board's card with the same id.
let boardGeneration = 0;
let penColor = PALETTE[0];
let selected: number[] = [];
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// The board DOM is built by the core-board plugin, so these
// start unassigned and are read from the shell after the
// plugin activates in init(). Before that they must not be
// used: the board does not exist yet. The core keeps the
// board element (for the host's boardEl mount point), the
// cards element (for the media and search modules, which
// query the card DOM for PDF canvases and search dimming)
// and the toast element (for toast()). The render and input
// loops live in the board plugin now, so the core does not
// keep the SVG world or grid elements.
let boardEl: HTMLDivElement = null as unknown as HTMLDivElement;
let cardsEl: HTMLDivElement = null as unknown as HTMLDivElement;
let toastEl: HTMLDivElement = null as unknown as HTMLDivElement;

// ---------------------------------------------------------------- helpers

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4000);
}

// Groups are sections: each group carries the label its
// frame shows. Keep the label map in step with membership:
// a group with fewer than two members is not a section,
// so its entry goes; a group with members and no entry
// gets "Section <id>". Called after every mutation that
// can change membership, and on load for old boards.
function syncGroupLabels(b: Board): void {
  const counts = new Map<number, number>();
  for (const it of b.items) {
    if (it.group === null) continue;
    counts.set(it.group, (counts.get(it.group) ?? 0) + 1);
  }
  const labels: Record<number, { label: string }> = b.groups ?? {};
  for (const key of Object.keys(labels)) {
    if ((counts.get(Number(key)) ?? 0) < 2) delete labels[Number(key)];
  }
  for (const [g, n] of counts) {
    if (n >= 2 && !labels[g]) labels[g] = { label: `Section ${g}` };
  }
  if (Object.keys(labels).length > 0) b.groups = labels; else delete b.groups;
}

// Media owns the PDF and audio state (see src/media.ts); the
// context below is how it reads the board and asks the core
// to re-render or re-run a search after async work lands.
const media: Media = createMedia({
  getBoard: () => board,
  getBoardGeneration: () => boardGeneration,
  bumpSearchVersion: () => { boardSearchVersion++; },
  requestSearchUpdate: () => search.updateSearch(),
  requestRender: () => boardRender(),
  getCardsEl: () => cardsEl,
  toast,
});

// Search owns the MiniSearch index and the local-ML context
// index (see src/search.ts). Jumping to a match selects it,
// centres the camera on it, and saves (the camera moved).
const search: BoardSearch = createBoardSearch({
  getBoard: () => board,
  getBoardGeneration: () => boardGeneration,
  getBoardSearchVersion: () => boardSearchVersion,
  media,
  getCardsEl: () => cardsEl,
  onJumpTo: (target) => {
    selected = select(board, [], target.id, false);
    let c: Pt;
    if (target.group !== null) {
      const members = board.items.filter((it) => it.group === target.group);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of members) {
        const [p, s] = itemBounds(board, m);
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
      }
      c = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    } else {
      c = centre(target);
    }
    const bs = boardSize();
    board.camera.x = c.x - bs.x / 2 / board.camera.zoom;
    board.camera.y = c.y - bs.y / 2 / board.camera.zoom;
    undoStore.save();
    boardRender();
  },
});


// Card HTML lives in src/cards.ts; the renderer reads the
// selection and the editing card through these two getters.
const cards: CardRenderer = createCardRenderer({
  media,
  isSelected: (id) => selected.includes(id),
  getEditingId: () => boardGetEditingId(),
});

// Undo and saving live in src/undo.ts. The store reads the
// board and the selection, and asks the core to re-render
// and refresh the Settings canvas controls after an undo.
const undoStore: UndoStore = createUndoStore({
  getBoard: () => board,
  getSelected: () => selected,
  setSelected: (ids) => { selected = ids; },
  clearEditing: () => { boardClearEditing(); },
  bumpSearchVersion: () => { boardSearchVersion++; },
  requestRender: () => boardRender(),
  refreshSettings: () => { refreshSettingsUI(); },
  toast,
});

// The settings window is a first-party plugin (core-settings).
// The core does not build it; it delegates through the plugin
// system (openSettingsUI / closeSettingsUI / isSettingsUIOpen),
// and the plugin registers itself at boot. See ARCHITECTURE.md.

// Drops and link previews live in src/drops.ts.
const drops: Drops = createDrops({
  getBoard: () => board,
  allocId: () => allocId(),
  save: () => { undoStore.save(); },
  saveWithoutUndo: () => undoStore.saveWithoutUndo(),
  requestRender: () => boardRender(),
  toWorld: (s) => toWorld(s),
  toast,
});

function toWorld(s: Pt): Pt {
  return screenToWorld(s, board.camera);
}
// The board no longer fills the window: the title bar sits
// above it, so board-local size and points differ from window
// size and client points by the bar's height. Every camera
// centre, cull and input conversion below goes through these,
// never window.innerWidth/innerHeight or raw clientX/Y.
function boardSize(): Pt {
  return elementSize(boardEl);
}
function boardPoint(clientX: number, clientY: number): Pt {
  return elementPoint(boardEl, clientX, clientY);
}
function zoomAt(screen: Pt, factor: number): void {
  Object.assign(board.camera, zoomCamera(board.camera, screen, factor));
}
function zoomCentre(factor: number): void {
  const s = boardSize();
  zoomAt({ x: s.x / 2, y: s.y / 2 }, factor);
}
// Validate and apply a camera, clamping the zoom. The
// floor is 0.01, not 0.1: fit (F) must be able to reach a
// very wide board. Shared by setCamera (which also saves
// and renders) and setCameraSilent. Returns false when the
// camera is not finite (ignored).
function applyCamera(cam: Camera): boolean {
  if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.zoom)) return false;
  const z = board.camera.zoom;
  board.camera = { x: cam.x, y: cam.y, zoom: clampZoom(cam.zoom) };
  if (board.camera.zoom !== z) emitPluginEvent("camera");
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
let boardSearchVersion = 0;

// Replace the board in place, from a JSON string the main
// process just handed over (a board switch, or a backup
// restore). The old board's undo, search, context index and
// media caches are all per-board, so they are cleared, not
// carried over — a restored board must not undo back into
// the board it replaced, and its context index is its own
// file in its own folder.
async function loadBoardFromJson(json: string, dir: string, preserveUndo = false): Promise<void> {
  // Discard an in-progress edit, do not commit it: the incoming
  // board replaces the outgoing one, and committing would save
  // the outgoing board to disk after the incoming content was
  // already read — overwriting a restore or an external change
  // and leaving disk and memory diverged. (A board switch
  // commits and saves the edit before calling this, so nothing
  // is lost there.)
  boardClearEditing();
  const oldDir = boardDir;
  const sameBoard = oldDir !== "" && oldDir === dir;
  // Save the outgoing board's stack before replacing it,
  // unless this is the same board reloaded (a restore or
  // a rename): then the stack is kept, not filed away.
  if (!sameBoard && !preserveUndo && oldDir !== "") {
    undoStore.stashUndoForBoard(oldDir);
  }
  const parsed = JSON.parse(json) as Board;
  parsed.bg = parsed.bg ?? "#FFFFFF";
  parsed.grid = parsed.grid ?? "Dots";
  parsed.camera = parsed.camera ?? { x: 0, y: 0, zoom: 1 };
  // Frames never rotate: a frame carrying rotation from
  // an older board, or set while Presentation was
  // disabled, is healed on load, so what is drawn always
  // matches the unrotated rect Presentation plays.
  // Text cards keep room for their bottom row below the
  // text: a card saved before that room existed is grown
  // on load, so the checklist progress never sits on its
  // text.
  for (const it of parsed.items) {
    // Tags are gone: drop any the board still carries,
    // so they never come back.
    delete (it as { tags?: unknown }).tags;
    if (isFrameCard(it)) delete (it as { rotation?: number }).rotation;
    if ("Text" in it.kind) {
      const need = estimateTextHeight(it.kind.Text.text, it.kind.Text.size, it.size.w) + CARD_DECORATIONS_H;
      if (it.size.h < need) it.size.h = need;
    }
    // A voice note with a transcript keeps room for its
    // toggle below the seek: a card saved at the old
    // hidden height is grown on load, so the toggle fits.
    if ("Audio" in it.kind && typeof it.kind.Audio.transcript === "string" && it.kind.Audio.transcript.trim().length > 0) {
      if (it.size.h < AUDIO_TRANSCRIPT_HIDDEN_H) it.size.h = AUDIO_TRANSCRIPT_HIDDEN_H;
    }
  }
  // Groups are sections: give every group its label, and
  // drop labels for groups that no longer have members.
  syncGroupLabels(parsed);
  board = parsed;
  boardGeneration++;
  boardSearchVersion++;
  boardDir = dir;
  selected = [];
  boardClearEditing();
  search.reset();
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (input) input.value = "";
  // A pending debounced save belongs to the outgoing
  // board: flush it only if the main process is still on
  // that board (same-board reload/restore); on a switch
  // the main process has already moved on, so flushing
  // would write the old index into the new board's file
  // — discard it instead, the new board re-indexes.
  if (oldDir !== "" && oldDir === dir) search.flushContextIndex(); else search.cancelContextIndexSave();
  search.clearBoardCaches();
  media.clearBoardCaches();
  undoStore.restoreUndoForBoard(dir, sameBoard || preserveUndo);
  boardRender();
  void search.loadContextIndex();
}
async function switchToBoard(name: string, preserveUndo = false): Promise<boolean> {
  try {
    boardCommitEditing();
    await api.saveBoard(JSON.stringify(board));
    search.flushContextIndex();
    const loaded = await api.switchBoard(name);
    await loadBoardFromJson(loaded.json, loaded.board_dir, preserveUndo);
    toast(`Board: ${name}`);
    return true;
  } catch (e) {
    toast(`Could not switch boards: ${String(e)}`);
    return false;
  }
}
async function restoreBoardBackup(name: string): Promise<boolean> {
  try {
    const loaded = await api.restoreBackup(name);
    await loadBoardFromJson(loaded.json, loaded.board_dir);
    toast("Backup restored");
    return true;
  } catch (e) {
    toast(`Could not restore backup: ${String(e)}`);
    return false;
  }
}
// Reset the board to a fresh welcome board (the settings
// "Delete all board data" flow). The settings plugin calls
// this through the API; the core owns the reset itself.
// Delete first, then build the fresh welcome board in memory
// and save that — never save the old board after the wipe,
// or it would come straight back. The corner setting is
// untouched: reset-board only deletes board data, not app
// settings.
async function resetBoardToWelcome(opts?: { confirmed?: boolean }): Promise<boolean> {
  boardCommitEditing();
  media.stopAudio();
  selected = [];
  boardClearEditing();
  try {
    const showcase = await api.resetBoard(opts);
    board = welcomeBoard(boardDir, showcase.pdf_size_bytes, showcase.video_size_bytes);
    board.camera = { x: 0, y: 0, zoom: 1 };
    closeSettingsUI();
    undoStore.save();
    boardRender();
    void drops.refreshLinkPreviews();
    toast("Board data deleted — fresh welcome board restored");
    return true;
  } catch (e) {
    toast(`Reset failed: ${String(e)}`);
    return false;
  }
}
function allocId(): number {
  board.next_id += 1;
  return board.next_id;
}

function isFrameCard(it: Item | undefined): boolean {
  if (!it || !("Plugin" in it.kind)) return false;
  // A slide is a frame by its stored kind, not only by its
  // renderer: frames must never rotate, even if the
  // Presentation plugin is disabled and no renderer is
  // registered for them. Other frame kinds still come
  // from their renderer.
  if (it.kind.Plugin.plugin === "presentation" && it.kind.Plugin.kind === "slide") return true;
  return getCardRenderer(it)?.frame === true;
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
  // Later items paint on top, so a clicked card (and its group) comes
  // to the front. Frames never come to the front: their board order
  // is a frame-based order (a presentation's slide order), and
  // clicking a frame to move it must not reorder its slides.
  // Frames also render as transparent borders, so staying behind
  // later cards is correct visually, not just for order.
  const nonFrames = ids.filter((id) => !isFrameCard(boardGet(board, id)));
  const front = board.items.filter((it) => nonFrames.includes(it.id));
  const rest = board.items.filter((it) => !nonFrames.includes(it.id));
  board.items = [...rest, ...front];
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
    void drops.dropPaths(Array.from(files), boardPoint(e.clientX, e.clientY));
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
    void drops.addUrlAt(toWorld(boardPoint(e.clientX, e.clientY)), uri);
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
    void drops.dropPaths(Array.from(files), { x: bs.x / 2, y: bs.y / 2 });
    return;
  }
  const text = e.clipboardData?.getData("text")?.trim() ?? "";
  if (/^https?:\/\//.test(text)) {
    e.preventDefault();
    const bs = boardSize();
    void drops.addUrlAt(toWorld({ x: bs.x / 2, y: bs.y / 2 }), text);
  }
});

// ---------------------------------------------------------------- init

async function init(): Promise<void> {
  let panelOrderList: string[] = [];
  try {
    const loaded = await api.loadBoard();
    boardDir = loaded.board_dir;
    if (Array.isArray(loaded.panelOrder)) panelOrderList = loaded.panelOrder.filter((x: unknown) => typeof x === "string");
    currentBuildId = loaded.buildId ?? "dev";
    if (loaded.json) {
      const parsed = JSON.parse(loaded.json) as Board;
      board = parsed;
      boardGeneration++;
      board.bg = board.bg ?? "#FFFFFF";
      board.grid = board.grid ?? "Dots";
      board.camera = board.camera ?? { x: 0, y: 0, zoom: 1 };
      for (const it of board.items) {
        // Tags are gone: drop any the board still carries.
        delete (it as { tags?: unknown }).tags;
        if ("UrlCard" in it.kind) {
          // Old boards may carry embed:true from the embedded-page era;
          // link cards are previews only now, so it is ignored.
          it.kind.UrlCard.image = it.kind.UrlCard.image ?? null;
          it.kind.UrlCard.icon = it.kind.UrlCard.icon ?? null;
        }
        // Frames never rotate; see loadBoardFromJson.
        if (isFrameCard(it)) delete (it as { rotation?: number }).rotation;
        // Text cards keep room for their bottom row below the
        // text; see loadBoardFromJson.
        if ("Text" in it.kind) {
          const need = estimateTextHeight(it.kind.Text.text, it.kind.Text.size, it.size.w) + CARD_DECORATIONS_H;
          if (it.size.h < need) it.size.h = need;
        }
        // A voice note with a transcript keeps room for its
        // toggle below the seek; see loadBoardFromJson.
        if ("Audio" in it.kind && typeof it.kind.Audio.transcript === "string" && it.kind.Audio.transcript.trim().length > 0) {
          if (it.size.h < AUDIO_TRANSCRIPT_HIDDEN_H) it.size.h = AUDIO_TRANSCRIPT_HIDDEN_H;
        }
      }
    } else {
      board = welcomeBoard(boardDir, loaded.pdf_size_bytes, loaded.video_size_bytes ?? 0);
      undoStore.save();
    }
    // Self-heal for welcome media: if a welcome item points
    // at a board file that is missing or empty, but the
    // bundle copy exists, point the item at the bundle
    // copy and save. This fixes the board permanently,
    // instead of relying on the file handler's fallback
    // on every load, and it works even if the board
    // folder itself is the wrong or broken one.
    try {
      const WELCOME = ["welcome-bower.jpg", "welcome-birdsong.mp3", "welcome-video.mp4", "sample.pdf"];
      let healed = false;
      for (const it of board.items) {
        const getPath = (): string | null =>
          ("Image" in it.kind) ? it.kind.Image.path
          : ("Audio" in it.kind) ? it.kind.Audio.path
          : ("Video" in it.kind) ? it.kind.Video.source
          : ("PdfCard" in it.kind) ? it.kind.PdfCard.path : null;
        const p = getPath();
        if (!p) continue;
        const name = p.split("/").pop() ?? "";
        if (!WELCOME.includes(name)) continue;
        const info = await api.checkFile(p);
        if ((info.exists && info.size > 0) || !info.bundleExists || info.bundleSize <= 0) continue;
        if ("Image" in it.kind) it.kind.Image.path = info.bundlePath;
        else if ("Audio" in it.kind) it.kind.Audio.path = info.bundlePath;
        else if ("Video" in it.kind) it.kind.Video.source = info.bundlePath;
        else if ("PdfCard" in it.kind) it.kind.PdfCard.path = info.bundlePath;
        healed = true;
      }
      if (healed) undoStore.saveWithoutUndo();
    } catch { /* a failed heal must never block startup */ }
  } catch (err) {
    toast(`Could not load the board: ${String(err)}`);
    board = welcomeBoard(boardDir, 0, 0);
  }
  // The loaded board is the first undo baseline: nothing before
  // it is undoable, and the first saved change pushes it as step 1.
  undoStore.resetUndo();
  // Live follow: an agent or a script rewrote board.json on disk.
  // Reload it like a same-board restore — the undo stack survives
  // (loadBoardFromJson keeps it for the same folder), the redo
  // chain clears — and tell plugins the content changed.
  api.onExternalBoardChange(async () => {
    try {
      const reloaded = await api.loadBoard();
      if (!reloaded.json) return;
      await loadBoardFromJson(reloaded.json, reloaded.board_dir);
      emitPluginEvent("board");
      toast("Board updated on disk");
    } catch {
      // A reload that fails leaves the current board alone.
    }
  });
  // Panel tab order, loaded with the board: the plugin system
  // applies it once panels are registered, and saves it back
  // whenever the user drags a tab.
  const pluginHost: PluginHost = {
    getBoard: () => board,
    getSelected: () => selected,
    setSelected: (ids: number[]) => { selected = ids; boardUpdateSelection(); },
    addItem: (kind, pos, size) => {
      const id = allocId();
      board.items.push({ id, pos, size, group: null, kind });
      undoStore.save(); boardRender();
      return id;
    },
    // Add an item without saving or rendering, for a text
    // note that is about to be edited. The edit commit
    // saves it, or removes it if left empty.
    addItemSilent: (kind, pos, size) => {
      const id = allocId();
      board.items.push({ id, pos, size, group: null, kind });
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
        board.items.push({ id, pos, size, group: null, kind });
        ids.push(id);
      }
      if (ids.length > 0) { undoStore.save(); boardRender(); }
      return ids;
    },
    updateItem: (id, patch) => {
      const it = boardGet(board, id);
      if (!it) return false;
      if (patch.pos) it.pos = patch.pos;
      if (patch.size) it.size = patch.size;
      if (patch.group !== undefined) it.group = patch.group;
      if (patch.data !== undefined && "Plugin" in it.kind) it.kind.Plugin.data = patch.data;
      syncGroupLabels(board);
      undoStore.save(); boardRender();
      return true;
    },
    updateItems: (patches) => {
      // One save for the whole batch, so one tidy action
      // is one undo step, not one per card: updateItem
      // saves after every item, and a five-card align
      // would otherwise take five undos to undo.
      let changed = false;
      for (const { id, ...patch } of patches) {
        const it = boardGet(board, id);
        if (!it) continue;
        if (patch.pos) it.pos = patch.pos;
        if (patch.size) it.size = patch.size;
        if (patch.group !== undefined) it.group = patch.group;
        if (patch.data !== undefined && "Plugin" in it.kind) it.kind.Plugin.data = patch.data;
        changed = true;
      }
      if (!changed) return false;
      syncGroupLabels(board);
      undoStore.save(); boardRender();
      return true;
    },
    moveItem: (id, toIndex) => {
      // Board order is the order things paint and, for frames,
      // the slide order, so moving an item here reorders it
      // everywhere that order matters, and saves like any
      // other board change, so it is undoable.
      const from = board.items.findIndex((it) => it.id === id);
      if (from < 0) return false;
      const [it] = board.items.splice(from, 1);
      const clamped = Math.max(0, Math.min(toIndex, board.items.length));
      board.items.splice(clamped, 0, it);
      undoStore.save(); boardRender();
      return true;
    },
    removeItem: (id) => {
      const before = board.items.length;
      board.items = board.items.filter((it) => it.id !== id);
      if (board.items.length === before) return false;
      selected = selected.filter((s) => s !== id);
      syncGroupLabels(board);
      undoStore.save(); boardRender();
      return true;
    },
    renderBoardCard: (id) => {
      const it = boardGet(board, id);
      if (!it) return null;
      if ("Stroke" in it.kind || "Connector" in it.kind) return null;
      const html = cards.cardHtml({ ...it, pos: { x: 0, y: 0 } }, true);
      return html === "" ? null : html;
    },
    // The same card as it appears on the board: real
    // position, selection state and editing exclusion.
    // The board view builds the card DOM from this.
    renderBoardCardAt: (id) => {
      const it = boardGet(board, id);
      if (!it) return null;
      if ("Stroke" in it.kind || "Connector" in it.kind) return null;
      const html = cards.cardHtml(it);
      return html === "" ? null : html;
    },
    hitTest: (world: Pt) => hitTestWithFrames(board, world),
    // Selection queries for the board view's drags. Pure
    // reads over the live board, no save, no render.
    marqueeSelect: (a: Pt, b: Pt) => marquee(board, a, b),
    lassoSelect: (points: Pt[]) => lassoSelect(board, points),
    strokesNear: (point: Pt, radius: number) => strokesWithin(board, point, radius),
    // Live-drag mutations for the board view only. They
    // change the live board without saving or rendering;
    // the drag saves once at drag end.
    moveItems: (ids: number[], dx: number, dy: number) => { moveSelection(board, ids, dx, dy); },
    resizeItem: (id: number, w: number, h: number) => { resizeItem(board, id, w, h); },
    setItemRotation: (id: number, rot: number) => {
      const it = boardGet(board, id);
      if (it) it.rotation = rot;
    },
    removeItems: (ids: number[]) => {
      board.items = board.items.filter((it) => !ids.includes(it.id));
      selected = selected.filter((s) => !ids.includes(s));
      syncGroupLabels(board);
    },
    bringToFront: (ids: number[]) => { bringToFront(ids); },
    // Set a text note's text (and its height, from the text),
    // without saving or rendering. The board view's text
    // commit saves once after the edit.
    setTextContent: (id: number, text: string) => {
      const it = boardGet(board, id);
      if (!it || !("Text" in it.kind)) return false;
      it.kind.Text.text = text;
      // The card keeps room for its bottom row (checklist
      // progress) below the text, so the row never covers
      // the last line.
      it.size.h = Math.max(40, estimateTextHeight(text, it.kind.Text.size, it.size.w) + CARD_DECORATIONS_H);
      return true;
    },
    // Rename a group's section label. One save, one undo
    // step. False when the group has fewer than two members
    // or the label is empty after trimming.
    setGroupLabel: (group: number, label: string) => {
      const members = board.items.filter((it) => it.group === group);
      if (members.length < 2) return false;
      const trimmed = label.trim();
      if (!trimmed) return false;
      board.groups = board.groups ?? {};
      board.groups[group] = { label: trimmed };
      undoStore.save(); boardRender();
      return true;
    },
    // Rename a voice note: the title is shown instead of
    // the file's name. One save, one undo step. An empty
    // title clears it, so the card falls back to the file's
    // name. False when the card is not audio, or the title
    // is unchanged.
    setAudioTitle: (id: number, title: string) => {
      const it = boardGet(board, id);
      if (!it || !("Audio" in it.kind)) return false;
      const trimmed = title.trim();
      const current = it.kind.Audio.title ?? "";
      if (trimmed === current) return false;
      if (trimmed) it.kind.Audio.title = trimmed;
      else delete it.kind.Audio.title;
      undoStore.save(); boardRender();
      return true;
    },
    // Group a set of cards: a new group id comes from the
    // board's next_group, so a later group can never collide
    // with it. One save, one undo step.
    createGroup: (ids: number[]) => {
      if (ids.length < 2) return null;
      board.next_group += 1;
      const g = board.next_group;
      for (const it of board.items) if (ids.includes(it.id)) it.group = g;
      board.groups = board.groups ?? {};
      board.groups[g] = { label: `Section ${g}` };
      undoStore.save(); boardRender();
      return g;
    },
    save: () => undoStore.save(),
    saveWithoutUndo: () => undoStore.saveWithoutUndo(),
    render: () => boardRender(),
    switchBoard: (name: string, preserveUndo = false) => switchToBoard(name, preserveUndo),
    setTool: (toolName: string) => boardSetTool(toolName),
    getTool: () => boardGetTool(),
    // Zoom around the board centre, by a factor. The
    // toolbar's zoom buttons. The camera math stays here;
    // the plugin just says "zoom in" or "zoom out".
    zoomBy: (factor: number) => { const z = board.camera.zoom; zoomCentre(factor); if (board.camera.zoom !== z) emitPluginEvent("camera"); boardRender(); },
    // The shape table for the toolbar's shape picker.
    listShapes: () => SHAPES.map((s) => ({ kind: s.kind, label: s.label, key: s.key, svg: s.svg })),
    // Drag-preview polygon points for a shape. The board
    // view draws the live shape preview from this.
    shapePreviewPoints: (kind: string, x0: number, y0: number, w: number, h: number) => shapePreviewPoints(kind as ShapeKind, x0, y0, w, h),
    // Set the background of the given text notes, in one
    // save (one undo step). The toolbar's note-colour
    // flyout. Only Text notes are affected.
    setNoteBackground: (ids: number[], hex: string) => {
      for (const id of ids) {
        const it = boardGet(board, id);
        if (it && "Text" in it.kind) it.kind.Text.bg = hex;
      }
      undoStore.save(); boardRender();
    },
    // Search: hand the engine the search box elements
    // (built by the core-search plugin), re-run the search,
    // clear it, or jump to a match. The engine owns the
    // matching, the dimming and the results.
    setSearchElements: (els: { input: HTMLInputElement; count: HTMLElement; clear: HTMLButtonElement; results: HTMLElement }) => {
      search.setSearchElements(els);
    },
    updateSearch: () => { search.updateSearch(); },
    clearSearch: () => { search.clearSearch(); },
    jumpToSearchIndex: (idx: number) => { search.jumpToSearchIndex(idx); },
    getPenColor: () => penColor,
    setPenColor: (hex: string) => {
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
      penColor = hex.toUpperCase();
      // The toolbar plugin follows the pen colour through
      // the "pen" plugin event, so its swatches update
      // without a full board render per pick — one per
      // pointermove while dragging Palette's wheel would
      // rebuild every visible card for nothing.
      emitPluginEvent("pen");
      return true;
    },
    getCamera: () => board.camera,
    setCamera: (cam) => {
      if (!applyCamera(cam)) return;
      undoStore.save(); boardRender();
    },
    // Set the camera without saving or rendering, for a live
    // pan or zoom drag. The drag saves once at drag end.
    setCameraSilent: (cam) => {
      applyCamera(cam);
    },
    setCanvas: (patch) => {
      if (patch.bg !== undefined) board.bg = patch.bg;
      if (patch.grid !== undefined) board.grid = patch.grid;
      undoStore.save(); boardRender();
    },
    get boardEl(): HTMLElement {
      // The board DOM is built by the core-board plugin, so
      // this reads the module-level boardEl, which is
      // assigned from the shell after the plugin activates.
      return boardEl;
    },
    centreOn: (id) => {
      const it = boardGet(board, id);
      if (!it) return;
      selected = select(board, [], id, false);
      const c = centre(it);
      const bs = boardSize();
      board.camera.x = c.x - bs.x / 2 / board.camera.zoom;
      board.camera.y = c.y - bs.y / 2 / board.camera.zoom;
      undoStore.save(); boardRender();
    },
    toast: (msg: string) => toast(msg),
    commitEditing: () => boardCommitEditing(),
    openSettings: () => openSettingsUI(),
    closeSettings: () => closeSettingsUI(),
    isSettingsOpen: () => isSettingsUIOpen(),
    undo: () => undoStore.undo(),
    redo: () => undoStore.redo(),
    canUndo: () => undoStore.canUndo(),
    canRedo: () => undoStore.canRedo(),
    groupSelection: () => boardGroupSelected(),
    ungroupSelection: () => boardUngroupSelected(),
    deleteSelection: () => boardDeleteSelected(),
    restoreBackup: (name) => restoreBoardBackup(name),
    getBuildId: () => currentBuildId,
    // Media state, for the cards that play or preview media.
    // The raw audio element is never handed out; the plugin
    // gets the derived playback state (id, playing, time,
    // duration) instead, so it can render a play/pause button
    // and a progress bar without touching the element.
    getAudioState: () => {
      const s = media.getAudioState();
      const el = s.el;
      return {
        id: s.id,
        playing: !!el && !el.paused,
        currentTime: el ? el.currentTime : 0,
        duration: el && isFinite(el.duration) ? el.duration : 0,
      };
    },
    getAudioDuration: (path) => media.audioDurations.get(path),
    loadAudioDuration: (id, path) => media.loadAudioDuration(id, path),
    transcribeAudio: (blob) => media.transcribeAudio(blob),
    audioFailed: (path) => media.audioFailed.has(path),
    formatAudioTime: (sec) => media.formatAudioTime(sec),
    // Toggle playback of an audio card. The board view's
    // play button.
    toggleAudio: (id, path) => { media.toggleAudio(id, path); },
    // Seek the playing audio card to a time in seconds. The
    // board view's seek slider. No-op when that card is not
    // the one playing.
    seekAudio: (id, time) => {
      const s = media.getAudioState();
      if (s.el && s.id === id) {
        s.el.currentTime = time;
        media.updateAudioProgress();
      }
    },
    getPdfPage: (id) => media.pdfPages.get(id) ?? 1,
    loadPdfPage: (id, path) => media.loadPdfPage(id, path),
    // Move a PDF card to a page (clamped to the document),
    // and render it. The board view's prev/next buttons.
    // False when the document is not loaded yet.
    setPdfPage: async (id, path, page) => {
      const docP = media.getCachedPdfDoc(path);
      if (!docP) return false;
      const doc = await docP;
      const next = Math.max(1, Math.min(page, doc.numPages));
      media.pdfPages.set(id, next);
      void media.renderPdfPage(id, path);
      return true;
    },
    pdfFailed: (path) => media.pdfFailed.has(path),
    resetBoard: (opts?: { confirmed?: boolean }) => resetBoardToWelcome(opts),
    getBoardDir: () => boardDir,
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
    if (els.board) boardEl = els.board as HTMLDivElement;
    if (els.canvas) {
      const [, , c] = els.canvas;
      if (c) cardsEl = c as HTMLDivElement;
    }
    if (els.toast) toastEl = els.toast as HTMLDivElement;
  }
  // The board plugin attached its own listeners in activate().
  // Render once the board DOM exists.
  boardRender();
  // Preload the context index now, in the background,
  // so the first search does not pay the index-load
  // cost on top of everything else.
  void search.loadContextIndex();
  // Fill in previews for cards that never got one (welcome card, old
  // boards): title, description, image and icon, in the background.
  void drops.refreshLinkPreviews();
}


void init();
