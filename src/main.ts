import { api } from "./backend/api";
import { createMedia, type Media } from "./backend/media";
import { createCardRenderer, SHAPES, shapePreviewPoints, type CardRenderer } from "./backend/cards";
import { createBoardSearch, type BoardSearch } from "./backend/search";
import { createUndoStore, type UndoStore } from "./backend/undo";
import { createDrops, type Drops } from "./backend/drops";
import { ensureVideoPoster } from "./backend/poster";
import * as coreBoard from "./ui/board";
import * as coreCards from "./ui/cards";
import * as coreSearch from "./ui/search";
import * as coreSettings from "./ui/settings";
import * as coreTitlebar from "./ui/titlebar";
import * as coreToolbar from "./ui/toolbar";
import {
  Board, Camera, Item, Pt, ShapeKind, Size,
  AUDIO_TRANSCRIPT_HIDDEN_H, boardGet, CARD_DECORATIONS_H, centre, clampZoom, elementPoint, elementSize,
  estimateTextHeight, healDuplicateIds, hitTest, itemsCentre, lassoSelect, marquee, moveSelection,
  resizeItem, screenToWorld, select, strokesWithin, zoomCamera,
} from "./backend/model";
import { welcomeBoard } from "./backend/welcome";
import {
  boardClearEditing, boardCommitEditing, boardDeleteSelected,
  boardGetEditingId, boardGetTool, boardGroupSelected, boardRender,
  boardSetTool, boardUngroupSelected, boardUpdateSelection,
  closeSettingsUI, emitPluginEvent, getBoardElements, getCardRenderer,
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
// the file can split (the board operations move to boards.ts)
// without every function reaching for module-level lets. All
// references are C.<name>; the object is created once, at module
// load. The instances (media, search, cards, undoStore, drops)
// start as undefined and are assigned by the creation calls
// below, which run at module load in the same order. Fields set
// by init() (boardEl, cardsEl, toastEl) start as undefined and
// are filled in when the board plugin activates.
export interface BootContext {
  board: Board;
  boardDir: string;
  // Build id for this run (git short hash in a packaged build,
  // "dev" from source). Set at board load; the feedback mail
  // carries it so a report can be matched to the exact build.
  currentBuildId: string;
  // Board generation: bumped on every board load, so async
  // work started for one board (a PDF render, a search
  // index, an audio probe) can tell, after an await, that
  // the user has switched boards and must not write its
  // result into the new board's card with the same id.
  boardGeneration: number;
  penColor: string;
  selected: number[];
  toastTimer: ReturnType<typeof setTimeout> | null;
  // The board DOM is built by the core-board plugin, so these
  // start unassigned and are read from the shell after the
  // plugin activates in init(). Before that they must not be
  // used: the board does not exist yet.
  boardEl: HTMLDivElement;
  cardsEl: HTMLDivElement;
  toastEl: HTMLDivElement;
  boardSearchVersion: number;
  media: Media;
  search: BoardSearch;
  cards: CardRenderer;
  undoStore: UndoStore;
  drops: Drops;
}

const C: BootContext = {
  board: {
    items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 0, next_group: 0,
    bg: "#FFFFFF", grid: "Dots",
  },
  boardDir: "",
  currentBuildId: "dev",
  boardGeneration: 0,
  penColor: PALETTE[0],
  selected: [],
  toastTimer: null,
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
C.media = createMedia({
  getBoard: () => C.board,
  getBoardGeneration: () => C.boardGeneration,
  bumpSearchVersion: () => { C.boardSearchVersion++; },
  requestSearchUpdate: () => C.search.updateSearch(),
  requestRender: () => boardRender(),
  getCardsEl: () => C.cardsEl,
  toast,
});

// Search owns the MiniSearch index and the local-ML context
// index (see src/search.ts). Jumping to a match selects it,
// centres the camera on it, and saves (the camera moved).
C.search = createBoardSearch({
  getBoard: () => C.board,
  getBoardGeneration: () => C.boardGeneration,
  getBoardSearchVersion: () => C.boardSearchVersion,
  media: C.media,
  getCardsEl: () => C.cardsEl,
  onJumpTo: (target) => {
    C.selected = select(C.board, [], target.id, false);
    let c: Pt;
    if (target.group !== null) {
      const members = C.board.items.filter((it) => it.group === target.group);
      c = itemsCentre(C.board, members) ?? centre(target);
    } else {
      c = centre(target);
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
});

// The settings window is a first-party plugin (core-settings).
// The core does not build it; it delegates through the plugin
// system (openSettingsUI / closeSettingsUI / isSettingsUIOpen),
// and the plugin registers itself at boot. See ARCHITECTURE.md.

// Drops and link previews live in src/drops.ts.
C.drops = createDrops({
  getBoard: () => C.board,
  allocId: () => allocId(),
  save: () => { C.undoStore.save(); },
  saveWithoutUndo: () => C.undoStore.saveWithoutUndo(),
  requestRender: () => boardRender(),
  toWorld: (s) => toWorld(s),
  toast,
});

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
function zoomAt(screen: Pt, factor: number): void {
  Object.assign(C.board.camera, zoomCamera(C.board.camera, screen, factor));
}
function zoomCentre(factor: number): void {
  const s = boardSize();
  zoomAt({ x: s.x / 2, y: s.y / 2 }, factor);
}
// Apply one item patch: position, size, group, and — for
// plugin cards only — data. Shared by updateItem and
// updateItems.
function applyPatch(it: Item, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown }): void {
  if (patch.pos) it.pos = patch.pos;
  if (patch.size) it.size = patch.size;
  if (patch.group !== undefined) it.group = patch.group;
  if (patch.data !== undefined && "Plugin" in it.kind) it.kind.Plugin.data = patch.data;
}
// Render one card as HTML, or null when it has none.
// plain renders at the origin (for embedding in a panel
// or view); the board position renders as it appears.
function renderCardHtml(id: number, plain: boolean): string | null {
  const it = boardGet(C.board, id);
  if (!it) return null;
  if ("Stroke" in it.kind || "Connector" in it.kind) return null;
  const html = C.cards.cardHtml(plain ? { ...it, pos: { x: 0, y: 0 } } : it, plain);
  return html === "" ? null : html;
}
// Validate and apply a camera, clamping the zoom. The
// floor is 0.01, not 0.1: fit (F) must be able to reach a
// very wide board. Shared by setCamera (which also saves
// and renders) and setCameraSilent. Returns false when the
// camera is not finite (ignored).
function applyCamera(cam: Camera): boolean {
  if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.zoom)) return false;
  const z = C.board.camera.zoom;
  C.board.camera = { x: cam.x, y: cam.y, zoom: clampZoom(cam.zoom) };
  if (C.board.camera.zoom !== z) emitPluginEvent("camera");
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

// Replace the board in place, from a JSON string the main
// process just handed over (a board switch, or a backup
// restore). The old board's undo, search, context index and
// media caches are all per-board, so they are cleared, not
// carried over — a restored board must not undo back into
// the board it replaced, and its context index is its own
// file in its own folder.
// Start indexing the board's media in the background,
// once the renderer is idle — so the model loads don't
// compete with the board's first render and the user's
// first interactions. requestIdleCallback fires when the
// main thread is quiet; the 10s timeout is the backstop
// so indexing still starts on a busy board. A search
// starts indexing at once (see updateSearch), so this
// delay only ever costs a few seconds of background time.
function startBackgroundIndexing(): void {
  const start = () => { void C.search.startContextIndexing(); };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 10000 });
  } else {
    setTimeout(start, 2000);
  }
}

// Fill in poster frames for videos that predate them — old
// boards, and the welcome board — so every video card shows
// its frame instead of a dark tile. One video at a time, in
// the background once the renderer is idle, like the context
// indexing: a capture loads a decoder briefly, and doing
// them all at once would compete with the board's first
// render. A board switch stops the run: the guard compares
// the board object, which a load replaces.
function startPosterBackfill(): void {
  const start = () => { void runPosterBackfill(); };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 10000 });
  } else {
    setTimeout(start, 2000);
  }
}

async function runPosterBackfill(): Promise<void> {
  const boardAtStart = C.board;
  const pending: Array<{ id: number; source: string }> = [];
  for (const it of boardAtStart.items) {
    if ("Video" in it.kind && !it.kind.Video.remote && !it.kind.Video.poster) {
      pending.push({ id: it.id, source: it.kind.Video.source });
    }
  }
  if (pending.length === 0) return;
  let filledAny = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Save and re-render at most once every two seconds while
  // posters land, so a board of many videos is not saved
  // and rebuilt once per poster.
  const flushSoon = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (C.board !== boardAtStart) return;
      C.undoStore.saveWithoutUndo();
      boardRender();
    }, 2000);
  };
  for (const { id, source } of pending) {
    if (C.board !== boardAtStart) return;
    const filled = await ensureVideoPoster(source);
    if (!filled) continue;
    if (C.board !== boardAtStart) return;
    // The item may have been deleted or replaced while the
    // frame was captured: only fill the same video.
    const current = boardGet(boardAtStart, id);
    if (!current || !("Video" in current.kind) || current.kind.Video.source !== source || current.kind.Video.poster) continue;
    current.kind.Video.poster = filled.poster;
    current.kind.Video.duration = filled.duration;
    filledAny = true;
    flushSoon();
  }
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (filledAny && C.board === boardAtStart) {
    C.undoStore.saveWithoutUndo();
    boardRender();
  }
}
async function loadBoardFromJson(json: string, dir: string, preserveUndo = false): Promise<void> {
  // Discard an in-progress edit, do not commit it: the incoming
  // board replaces the outgoing one, and committing would save
  // the outgoing board to disk after the incoming content was
  // already read — overwriting a restore or an external change
  // and leaving disk and memory diverged. (A board switch
  // commits and saves the edit before calling this, so nothing
  // is lost there.)
  boardClearEditing();
  const oldDir = C.boardDir;
  const sameBoard = oldDir !== "" && oldDir === dir;
  // Save the outgoing board's stack before replacing it,
  // unless this is the same board reloaded (a restore or
  // a rename): then the stack is kept, not filed away.
  if (!sameBoard && !preserveUndo && oldDir !== "") {
    C.undoStore.stashUndoForBoard(oldDir);
  }
  const parsed = JSON.parse(json) as Board;
  parsed.bg = parsed.bg ?? "#FFFFFF";
  parsed.grid = parsed.grid ?? "Dots";
  parsed.camera = parsed.camera ?? { x: 0, y: 0, zoom: 1 };
  // A board file can carry two cards with the same id; the
  // first keeps it and later ones get fresh ids, so search
  // and every id lookup see a consistent board.
  healDuplicateIds(parsed);
  // Frames never rotate: a frame carrying rotation from
  // an older board, or set while Presentation was
  // disabled, is healed on load, so what is drawn always
  // matches the unrotated rect Presentation plays.
  // Text cards keep room for their bottom row below the
  // text: a card saved before that room existed is grown
  // on load, so the checklist progress never sits on its
  // text.
  for (const it of parsed.items) {
    healBoardItem(it);
  }
  // Groups are sections: give every group its label, and
  // drop labels for groups that no longer have members.
  syncGroupLabels(parsed);
  C.board = parsed;
  C.boardGeneration++;
  C.boardSearchVersion++;
  C.boardDir = dir;
  C.selected = [];
  boardClearEditing();
  C.search.reset();
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (input) input.value = "";
  // A pending debounced save belongs to the outgoing
  // board: flush it only if the main process is still on
  // that board (same-board reload/restore); on a switch
  // the main process has already moved on, so flushing
  // would write the old index into the new board's file
  // — discard it instead, the new board re-indexes.
  if (oldDir !== "" && oldDir === dir) C.search.flushContextIndex(); else C.search.cancelContextIndexSave();
  C.search.clearBoardCaches();
  C.media.clearBoardCaches();
  C.undoStore.restoreUndoForBoard(dir, sameBoard || preserveUndo);
  boardRender();
  void C.search.loadContextIndex();
  // Index the board's media in the background, so the
  // first search does not pay the model-load and embedding
  // cost. It is async and guarded: nothing happens when
  // everything is already indexed.
  startBackgroundIndexing();
  // Fill in poster frames for videos that predate them
  // (old boards, the welcome board), in the background.
  startPosterBackfill();
}
async function switchToBoard(name: string, preserveUndo = false): Promise<boolean> {
  try {
    boardCommitEditing();
    await api.saveBoard(JSON.stringify(C.board));
    C.search.flushContextIndex();
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
  C.media.stopAudio();
  C.selected = [];
  boardClearEditing();
  try {
    const showcase = await api.resetBoard(opts);
    C.board = welcomeBoard(C.boardDir, showcase.pdf_size_bytes, showcase.video_size_bytes);
    C.board.camera = { x: 0, y: 0, zoom: 1 };
    closeSettingsUI();
    C.undoStore.save();
    boardRender();
    void C.drops.refreshLinkPreviews();
    toast("Board data deleted — fresh welcome board restored");
    return true;
  } catch (e) {
    toast(`Reset failed: ${String(e)}`);
    return false;
  }
}
function allocId(): number {
  C.board.next_id += 1;
  return C.board.next_id;
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

// Heal one loaded item: drop stale tags, un-rotate frames,
// grow text cards to fit their text plus the bottom row,
// and grow transcript voice notes so the toggle fits.
// Shared by loadBoardFromJson and init (which adds its own
// UrlCard branch on top).
function healBoardItem(it: Item): void {
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
  const nonFrames = ids.filter((id) => !isFrameCard(boardGet(C.board, id)));
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
  try {
    const loaded = await api.loadBoard();
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
      for (const it of C.board.items) {
        if ("UrlCard" in it.kind) {
          // Old boards may carry embed:true from the embedded-page era;
          // link cards are previews only now, so it is ignored.
          it.kind.UrlCard.image = it.kind.UrlCard.image ?? null;
          it.kind.UrlCard.icon = it.kind.UrlCard.icon ?? null;
        }
        healBoardItem(it);
      }
    } else {
      C.board = welcomeBoard(C.boardDir, loaded.pdf_size_bytes, loaded.video_size_bytes ?? 0);
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
      const WELCOME = ["welcome-bower.jpg", "welcome-birdsong.mp3", "welcome-video.mp4", "sample.pdf"];
      let healed = false;
      for (const it of C.board.items) {
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
      if (healed) C.undoStore.saveWithoutUndo();
    } catch { /* a failed heal must never block startup */ }
  } catch (err) {
    toast(`Could not load the board: ${String(err)}`);
    C.board = welcomeBoard(C.boardDir, 0, 0);
  }
  // The loaded board is the first undo baseline: nothing before
  // it is undoable, and the first saved change pushes it as step 1.
  C.undoStore.resetUndo();
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
      const [it] = C.board.items.splice(from, 1);
      const clamped = Math.max(0, Math.min(toIndex, C.board.items.length));
      C.board.items.splice(clamped, 0, it);
      C.undoStore.save(); boardRender();
      return true;
    },
    removeItem: (id) => {
      const before = C.board.items.length;
      C.board.items = C.board.items.filter((it) => it.id !== id);
      if (C.board.items.length === before) return false;
      C.selected = C.selected.filter((s) => s !== id);
      syncGroupLabels(C.board);
      C.undoStore.save(); boardRender();
      return true;
    },
    renderBoardCard: (id) => renderCardHtml(id, true),
    // The same card as it appears on the board: real
    // position, selection state and editing exclusion.
    // The board view builds the card DOM from this.
    renderBoardCardAt: (id) => renderCardHtml(id, false),
    hitTest: (world: Pt) => hitTestWithFrames(C.board, world),
    // Selection queries for the board view's drags. Pure
    // reads over the live board, no save, no render.
    marqueeSelect: (a: Pt, b: Pt) => marquee(C.board, a, b),
    lassoSelect: (points: Pt[]) => lassoSelect(C.board, points),
    strokesNear: (point: Pt, radius: number) => strokesWithin(C.board, point, radius),
    // Live-drag mutations for the board view only. They
    // change the live board without saving or rendering;
    // the drag saves once at drag end.
    moveItems: (ids: number[], dx: number, dy: number) => { moveSelection(C.board, ids, dx, dy); },
    resizeItem: (id: number, w: number, h: number) => { resizeItem(C.board, id, w, h); },
    setItemRotation: (id: number, rot: number) => {
      const it = boardGet(C.board, id);
      if (it) it.rotation = rot;
    },
    removeItems: (ids: number[]) => {
      C.board.items = C.board.items.filter((it) => !ids.includes(it.id));
      C.selected = C.selected.filter((s) => !ids.includes(s));
      syncGroupLabels(C.board);
    },
    bringToFront: (ids: number[]) => { bringToFront(ids); },
    // Set a text note's text (and its height, from the text),
    // without saving or rendering. The board view's text
    // commit saves once after the edit.
    setTextContent: (id: number, text: string) => {
      const it = boardGet(C.board, id);
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
      if (ids.length < 2) return null;
      C.board.next_group += 1;
      const g = C.board.next_group;
      for (const it of C.board.items) if (ids.includes(it.id)) it.group = g;
      C.board.groups = C.board.groups ?? {};
      C.board.groups[g] = { label: `Section ${g}` };
      C.undoStore.save(); boardRender();
      return g;
    },
    save: () => C.undoStore.save(),
    saveWithoutUndo: () => C.undoStore.saveWithoutUndo(),
    render: () => boardRender(),
    switchBoard: (name: string, preserveUndo = false) => switchToBoard(name, preserveUndo),
    setTool: (toolName: string) => boardSetTool(toolName),
    getTool: () => boardGetTool(),
    // Zoom around the board centre, by a factor. The
    // toolbar's zoom buttons. The camera math stays here;
    // the plugin just says "zoom in" or "zoom out".
    zoomBy: (factor: number) => { const z = C.board.camera.zoom; zoomCentre(factor); if (C.board.camera.zoom !== z) emitPluginEvent("camera"); boardRender(); },
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
        const it = boardGet(C.board, id);
        if (it && "Text" in it.kind) it.kind.Text.bg = hex;
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
    restoreBackup: (name) => restoreBoardBackup(name),
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
    // Seek the playing audio card to a time in seconds. The
    // board view's seek slider. No-op when that card is not
    // the one playing.
    seekAudio: (id, time) => {
      const s = C.media.getAudioState();
      if (s.el && s.id === id) {
        s.el.currentTime = time;
        C.media.updateAudioProgress();
      }
    },
    getPdfPage: (id) => C.media.pdfPages.get(id) ?? 1,
    loadPdfPage: (id, path) => C.media.loadPdfPage(id, path),
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
    resetBoard: (opts?: { confirmed?: boolean }) => resetBoardToWelcome(opts),
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
  startBackgroundIndexing();
  startPosterBackfill();
  // Fill in previews for cards that never got one (welcome card, old
  // boards): title, description, image and icon, in the background.
  void C.drops.refreshLinkPreviews();
}


void init();
