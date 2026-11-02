// Electron preload API (see electron/preload.js). The renderer never
// touches Node or Electron directly; every privileged call goes through
// this bridge, which the main process exposes with context isolation on.
interface BowerbirdAPI {
  isDemo: boolean;
  platform: string;
  loadBoard(): Promise<{ json: string | null; board_path: string; board_dir: string; pdf_size_bytes: number; video_size_bytes: number; panelOrder?: string[]; buildId?: string }>;
  saveBoard(json: string): Promise<void>;
  listBoards(): Promise<Array<{ name: string; current: boolean; items: number }>>;
  createBoard(name: string): Promise<{ name: string }>;
  switchBoard(name: string): Promise<{ json: string; board_path: string; board_dir: string }>;
  renameBoard(oldName: string, newName: string): Promise<{ name: string }>;
  deleteBoard(name: string): Promise<{ wasCurrent: boolean }>;
  listBackups(): Promise<Array<{ name: string; items: number; size: number }>>;
  restoreBackup(name: string): Promise<{ json: string; board_path: string; board_dir: string }>;
  resetBoard(): Promise<{ pdf_size_bytes: number; video_size_bytes: number }>;
  checkFile(filePath: string): Promise<{ path: string; exists: boolean; size: number; bundlePath: string; bundleExists: boolean; bundleSize: number }>;
  readFileBase64(filePath: string): Promise<{ mime: string; base64: string }>;
  contextEmbedImage(filePath: string): Promise<number[]>;
  contextEmbedFrame(dataUrl: string): Promise<number[]>;
  contextEmbedText(text: string): Promise<number[]>;
  contextClassifyAudio(pcm: Float32Array): Promise<{ label: string; score: number }[]>;
  contextIndexLoad(): Promise<Record<string, unknown>>;
  contextIndexSave(index: Record<string, unknown>): Promise<boolean>;
  embedFile(path: string): Promise<string>;
  listLibrary(): Promise<{ path: string; items: Array<{ name: string; path: string; relativePath: string; ext: string; kind: string; category: string | null; size_bytes: number; mtime_ms: number }>; categories: Array<{ name: string; count: number }>; uncategorizedCount: number }>;
  addToLibrary(path: string): Promise<string>;
  createLibraryCategory(name: string): Promise<string>;
  moveLibraryItem(relativePath: string, category: string | null): Promise<string>;
  readTextFile(path: string): Promise<string>;
  fileSize(path: string): Promise<number>;
  fetchPreview(url: string): Promise<{ title: string | null; description: string | null; image: string | null; icon: string | null }>;
  openExternal(target: string): Promise<void>;
  getAppSettings(): Promise<{ corner: string; panelOrder?: string[] }>;
  setCorner(corner: string): Promise<string>;
  setPanelOrder(order: string[]): Promise<string[]>;
  collapse(): Promise<void>;
  restore(): Promise<void>;
  moveWindow(dx: number, dy: number): void;
  minimise(): Promise<void>;
  closeWindow(): Promise<void>;
  quit(): Promise<void>;
  fullscreen(): Promise<boolean>;
  maximise(): Promise<boolean>;
  windowState(): Promise<{ maximised: boolean; fullscreen: boolean }>;
  getPathForFile(file: File): string;
  fileUrl(path: string): string;
  listPlugins(): Promise<PluginManifest[]>;
  readPluginFile(pluginId: string, relativePath: string): Promise<string>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean>;
  installPlugin(plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string; styleCode: string }): Promise<PluginManifest>;
  llmChat(req: { baseUrl: string; model: string; key: string; messages: Array<{ role: string; content: string }> }): Promise<string>;
  pluginStorageGet(pluginId: string, key: string): Promise<unknown>;
  pluginStorageSet(pluginId: string, key: string, value: unknown): Promise<void>;
  pluginStorageDelete(pluginId: string, key: string): Promise<void>;
  secureStorageAvailable(): Promise<boolean>;
  secureStorageGet(pluginId: string, key: string): Promise<string | null>;
  secureStorageSet(pluginId: string, key: string, value: string): Promise<boolean>;
  secureStorageDelete(pluginId: string, key: string): Promise<void>;
}
declare global {
  interface Window { bowerbird: BowerbirdAPI }
}
const api = window.bowerbird;
import {
  Anchor, Board, GRID, Item, Pt, ShapeKind,
  anchorPoint, boardGet, centre, clippedEnds, domainOf, elide, escapeHtml, estimateTextHeight,
  hitTest, itemBounds, itemRotation, marquee, moveSelection, normaliseHex, parseHex, renderMarkdownHtml,
  resizeItem, rotatePoint, select, tileColorFor, tint,
} from "./model";
import { welcomeBoard } from "./welcome";
import MiniSearch from "minisearch";
// PDF.js is loaded lazily, not statically imported: it
// used to sit in the main chunk (533 KB) and every launch
// paid for it, including boards with no PDFs. It is now
// imported on first PDF render or PDF search indexing,
// with its parser in a worker so a large PDF never
// blocks the board. The worker is bundled by Vite from
// the ?worker import below.
let pdfjsLibPromise: Promise<typeof import("pdfjs-dist")> | null = null;
async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const lib = await import("pdfjs-dist");
      const { default: PdfWorker } = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker");
      lib.GlobalWorkerOptions.workerPort = new PdfWorker();
      return lib;
    })();
  }
  return pdfjsLibPromise;
}
import {
  emitPluginEvent, getActiveView, getCardHtml, getCardRenderer, getPluginCardSearchText,
  getPluginTool, handlePluginCardAction, handlePluginCardDoubleClick, handlePluginShortcut,
  initPlugins, listLoadedPlugins, listPluginShortcuts,
  refreshActiveView, renderSettingsSections,
  setPluginEnabled, syncPluginToolButtons,
  type PluginHost, type PluginManifest,
} from "./plugins";

// ---------------------------------------------------------------- state

// Core tools are select/pen/connector. Plugin tools are strings of
// the form "plugin:<pluginId>:<toolId>" (see src/plugins.ts); the
// type stays open so a plugin tool is a valid Tool.
type Tool = string;
const PALETTE = ["#1A1A1A", "#E63946", "#2E86AB", "#FF6B35", "#6a4c93", "#2A9D8F"];
// Note background colours: light pastels only, so dark note text
// stays readable on every one. White is the default (no bg set).
const NOTE_COLOURS = ["#FFFFFF", "#FEF3C7", "#FCE7F3", "#DCFCE7", "#DBEAFE", "#FFEDD5", "#EDE9FE", "#F3F4F6"];
const ACCENT = "#007AFF";

const SHORTCUTS: Array<[string, string]> = [
  ["V", "Select tool"],
  ["P", "Pen tool"],
  ["A", "Arrow (connector) tool"],
  ["Delete / Backspace", "Delete the selection"],
  ["Ctrl / Cmd + Z", "Undo"],
  ["Ctrl / Cmd + Shift + Z", "Redo"],
  ["Ctrl / Cmd + Y", "Redo"],
  ["Ctrl / Cmd + G", "Group the selection"],
  ["Ctrl / Cmd + U", "Ungroup the selection"],
  ["+ / =", "Zoom in"],
  ["−", "Zoom out"],
  ["0", "Reset the view"],
  ["Ctrl / Cmd + scroll", "Zoom at the cursor"],
  ["Scroll", "Pan the canvas"],
  ["Space + drag", "Pan the canvas"],
  ["?", "Open settings"],
  ["Esc", "Close settings, commit a note, or clear the selection"],
  ["Tab", "Go to the next element"],
  ["Shift + Tab", "Go to the previous element"],
  ["Ctrl / Cmd + F", "Search the board"],
  ["Enter in search", "Jump to the next match"],
  ["Shift + Enter in search", "Jump to the previous match"],
  ["Esc in search", "Clear the search"],
  ["Double-click empty space", "New note"],
  ["Double-click a note", "Edit it in place"],
  ["Click a link card", "Open it in your browser"],
  ["Double-click a link card", "Open it in your browser"],
  ["Double-click a PDF or picture", "Open it outside Bowerbird"],
  ["Click a play tile", "Play audio / video"],
  ["Drag a card corner", "Resize the card (nwse cursor on hover)"],
  ["Click the board's corner", "Open the board again"],
  ["Shift + click", "Add to the selection"],
  ["Drag on empty space", "Marquee-select"],
  ["Ctrl / Cmd + V", "Paste a link as a card"],
];

let board: Board = {
  items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 0, next_group: 0,
  bg: "#FFFFFF", grid: "Dots",
};
let boardDir = "";
let tool: Tool = "select";
let penColor = PALETTE[0];
let selected: number[] = [];
let spaceDown = false;
let editingId: number | null = null;
let settingsOpen = false;
// Search: matches are board item ids in board order, in the same
// spirit as Tab navigation (strokes and connectors are skipped:
// they carry no searchable text). searchIndex is -1 until the user
// presses Enter, so typing only highlights and counts — it does
// not yank the camera on every keystroke.
let searchMatches: number[] = [];
let searchIndex = -1;
let drag: null
  | { kind: "pan"; last: Pt }
  | { kind: "move"; lastWorld: Pt; moved: boolean }
  | { kind: "stroke"; points: Pt[] }
  | { kind: "connector"; from: Anchor; current: Pt }
  | { kind: "marquee"; start: Pt; current: Pt }
  | { kind: "shape"; shape: ShapeKind; start: Pt; current: Pt }
  | { kind: "rotate"; id: number; origRot: number; moved: boolean }
  | { kind: "resize"; id: number; startWorld: Pt; origW: number; origH: number; moved: boolean } = null;
let pluginToolDown = false;
let audioEl: HTMLAudioElement | null = null;
let audioId: number | null = null;
const audioDurations = new Map<string, number>();
const audioProbing = new Set<string>();
// PDF rendering, like audio durations: a PDF card is built as
// HTML first, then its page is drawn into the canvas in it,
// because PDF.js loads and renders asynchronously. The
// document is cached by path, the current page by card id,
// so flipping pages and re-rendering after a board change
// do not reload the file, and a failed PDF falls back to
// its name and size instead of an empty card.
type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;
const pdfDocs = new Map<string, Promise<PdfDoc>>();
const pdfFailed = new Set<string>();
// Extracted PDF text for search, keyed by path. Filled
// lazily on the first search that could match a PDF, so
// board load is never slowed by text extraction.
const pdfSearchText = new Map<string, string>();
const pdfSearchIndexing = new Set<string>();
function getPdfDoc(path: string): Promise<PdfDoc> {
  let docPromise = pdfDocs.get(path);
  if (!docPromise) {
    docPromise = (async () => {
      const pdfjsLib = await loadPdfjs();
      try {
        const res = await fetch(api.fileUrl(path));
        if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`);
        const data = await res.arrayBuffer();
        return pdfjsLib.getDocument({ data }).promise;
      } catch {
        const { base64 } = await api.readFileBase64(path);
        const binary = atob(base64);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
        return pdfjsLib.getDocument({ data }).promise;
      }
    })();
    pdfDocs.set(path, docPromise);
  }
  return docPromise;
}
function indexPdfForSearch(path: string): void {
  if (pdfSearchText.has(path) || pdfSearchIndexing.has(path)) return;
  pdfSearchIndexing.add(path);
  void getPdfDoc(path).then(async (doc) => {
    try {
      const parts: string[] = [];
      const pages = Math.min(doc.numPages, 50);
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        for (const it of content.items) {
          if (typeof (it as { str?: unknown }).str === "string") parts.push((it as { str: string }).str);
        }
      }
      pdfSearchText.set(path, parts.join(" "));
      boardSearchVersion++;
    } catch { /* search falls back to the filename */ }
    pdfSearchIndexing.delete(path);
    const input = document.getElementById("search-input") as HTMLInputElement | null;
    if (input && input.value.trim() !== "") updateSearch();
  }).catch(() => { pdfSearchIndexing.delete(path); });
}
const pdfPages = new Map<number, number>();
const pdfRendering = new Set<number>();
function formatAudioTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "–:––";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function updateAudioProgress(): void {
  if (!audioEl || audioId === null) return;
  const dur = audioEl.duration;
  const cur = audioEl.currentTime;
  const timeEl = cardsEl.querySelector(`[data-audio-time="${audioId}"]`);
  if (timeEl) timeEl.textContent = formatAudioTime(cur);
  const durEl = cardsEl.querySelector(`[data-audio-dur="${audioId}"]`);
  if (durEl && isFinite(dur)) durEl.textContent = formatAudioTime(dur);
  const seekEl = cardsEl.querySelector(`[data-audio-seek="${audioId}"]`) as HTMLInputElement | null;
  if (seekEl && isFinite(dur) && dur > 0) {
    seekEl.style.setProperty("--seek-pct", `${Math.round((cur / dur) * 100)}%`);
    if (document.activeElement !== seekEl) seekEl.value = String(Math.round((cur / dur) * 1000));
  }
}
const audioFailed = new Set<string>();
// Data-URL fallbacks for files whose app-file load failed,
// keyed by board path. Audio playback uses this map too,
// so a file that only loads as a data URL still plays.
const mediaDataUrls = new Map<string, string>();
function loadAudioDuration(id: number, path: string): void {
  if (audioDurations.has(path) || audioProbing.has(path) || audioFailed.has(path)) return;
  audioProbing.add(path);
  const probe = new Audio(api.fileUrl(path));
  probe.onerror = () => {
    // Same app-file fallback as images and video: try
    // once as a data URL before calling the file missing.
    void api.readFileBase64(path).then(({ mime, base64 }) => {
      const dataUrl = `data:${mime};base64,${base64}`;
      mediaDataUrls.set(path, dataUrl);
      const retry = new Audio(dataUrl);
      retry.preload = "metadata";
      retry.onloadedmetadata = () => {
        audioProbing.delete(path);
        if (isFinite(retry.duration)) {
          audioDurations.set(path, retry.duration);
          const durEl = cardsEl.querySelector(`[data-audio-dur="${id}"]`);
          if (durEl) durEl.textContent = formatAudioTime(retry.duration);
        }
      };
      retry.onerror = () => {
        audioProbing.delete(path);
        audioFailed.add(path);
        render();
      };
    }).catch(() => {
      audioProbing.delete(path);
      audioFailed.add(path);
      render();
    });
  };
  probe.preload = "metadata";
  probe.onloadedmetadata = () => {
    audioProbing.delete(path);
    if (isFinite(probe.duration)) {
      audioDurations.set(path, probe.duration);
      const durEl = cardsEl.querySelector(`[data-audio-dur="${id}"]`);
      if (durEl) durEl.textContent = formatAudioTime(probe.duration);
    }
  };
}
async function renderPdfPage(id: number, path: string): Promise<void> {
  if (pdfRendering.has(id) || pdfFailed.has(path)) return;
  pdfRendering.add(id);
  let canvas: HTMLCanvasElement | null = null;
  let renderedPage = 0;
  try {
    // The canvas is queried after the document loads, not
    // before: loadPdfPage runs while cardHtml is still
    // building the new HTML, so a canvas queried here
    // would be the old render's, about to be discarded.
    // Every await below yields past the synchronous render
    // that puts the new canvas in the DOM.
    // One shared promise per path, so two cards showing the
    // same PDF wait on the same load instead of racing it.
    const doc = await getPdfDoc(path);
    canvas = cardsEl.querySelector(`[data-pdf-canvas="${id}"]`) as HTMLCanvasElement | null;
    if (!canvas) return;
    const pageNum = pdfPages.get(id) ?? 1;
    renderedPage = pageNum;
    const page = await doc.getPage(Math.max(1, Math.min(pageNum, doc.numPages)));
    // Render at device scale, then let CSS fit the canvas to
    // its box: a portrait page in a wide card letterboxes,
    // a landscape page fills it, and zoom scales the layer.
    const viewport = page.getViewport({ scale: 2 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    await page.render({ canvas, viewport }).promise;
    const countEl = cardsEl.querySelector(`[data-pdf-count="${id}"]`);
    if (countEl) countEl.textContent = `${pageNum} / ${doc.numPages}`;
    const prev = cardsEl.querySelector(`[data-action="pdf-prev"][data-id="${id}"]`) as HTMLButtonElement | null;
    const next = cardsEl.querySelector(`[data-action="pdf-next"][data-id="${id}"]`) as HTMLButtonElement | null;
    if (prev) prev.disabled = pageNum <= 1;
    if (next) next.disabled = pageNum >= doc.numPages;
  } catch {
    pdfFailed.add(path);
    const wrap = cardsEl.querySelector(`[data-pdf-wrap="${id}"]`);
    if (wrap) wrap.textContent = "Could not render this PDF. Double-click to open it.";
  } finally {
    pdfRendering.delete(id);
    // If a board render replaced the canvas while this page
    // was loading, the new canvas is still blank, and if
    // the user flipped pages while this render was in
    // flight, the page shown is now stale: render again.
    const current = cardsEl.querySelector(`[data-pdf-canvas="${id}"]`) as HTMLCanvasElement | null;
    const stale = renderedPage !== 0 && (pdfPages.get(id) ?? 1) !== renderedPage;
    if (current && (current !== canvas || stale) && !pdfFailed.has(path)) void renderPdfPage(id, path);
  }
}
function loadPdfPage(id: number, path: string): void {
  // Fire and forget from cardHtml, like loadAudioDuration:
  // the canvas is already in the DOM, renderPdfPage fills
  // it, and a later render re-runs this for the new canvas.
  void renderPdfPage(id, path);
}
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let wheelSaveTimer: ReturnType<typeof setTimeout> | null = null;
// Trackpad zoom coalescing: a pinch sends wheel events at
// ~120 Hz, and every tick used to rebuild the card DOM
// whenever the visible set changed — re-creating images
// and videos mid-pinch, which is what made zoom feel
// stepped instead of smooth. Now ticks only accumulate
// a factor, one frame applies it as a GPU transform, and
// content rebuilds once, when the pinch settles.
let pendingZoomFactor = 1;
let pendingZoomAnchor: Pt | null = null;
let zoomFrame: number | null = null;
let zoomSettleTimer: ReturnType<typeof setTimeout> | null = null;
// Content refresh during a long pinch: without this, cards
// that scroll into view while zooming only appear after
// the gesture ends, which feels frozen and rigid.
let lastZoomRefreshZoom = 1;
let lastZoomRefreshTime = 0;
let lastToolbarKey = "";

const boardEl = document.getElementById("board") as HTMLDivElement;
const worldEl = document.getElementById("world") as unknown as SVGGElement;
const cardsEl = document.getElementById("cards") as HTMLDivElement;
const gridEl = document.getElementById("grid") as HTMLDivElement;
// Key of the card/stroke content currently built in the DOM. Camera
// moves that leave this key unchanged must not rebuild anything:
// panning then is one GPU transform, not a DOM rebuild per frame.
let lastContentKey = "";
let cursorRaf = 0;
let pendingCursor: Pt | null = null;
const toastEl = document.getElementById("toast") as HTMLDivElement;

// ---------------------------------------------------------------- helpers

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4000);
}

function toScreen(p: Pt): Pt {
  return { x: (p.x - board.camera.x) * board.camera.zoom, y: (p.y - board.camera.y) * board.camera.zoom };
}
function toWorld(s: Pt): Pt {
  return { x: s.x / board.camera.zoom + board.camera.x, y: s.y / board.camera.zoom + board.camera.y };
}
// The board no longer fills the window: the title bar sits
// above it, so board-local size and points differ from window
// size and client points by the bar's height. Every camera
// centre, cull and input conversion below goes through these,
// never window.innerWidth/innerHeight or raw clientX/Y.
function boardSize(): Pt {
  return { x: boardEl.clientWidth, y: boardEl.clientHeight };
}
function boardPoint(clientX: number, clientY: number): Pt {
  const r = boardEl.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}
function zoomAt(screen: Pt, factor: number): void {
  const before = toWorld(screen);
  board.camera.zoom = Math.max(0.1, Math.min(8, board.camera.zoom * factor));
  const after = toWorld(screen);
  board.camera.x += before.x - after.x;
  board.camera.y += before.y - after.y;
}
function zoomCentre(factor: number): void {
  const s = boardSize();
  zoomAt({ x: s.x / 2, y: s.y / 2 }, factor);
}
const DEMO = api.isDemo === true;
function save(): void {
  boardSearchVersion++;
  // Undo capture runs before the demo return, so undo works in
  // demo too, in memory, even though nothing is written to disk.
  captureUndoStep();
  // Demo mode saves nothing: not even an IPC call, so a main-process
  // guard failure alone could never write. The main process also
  // no-ops save-board in demo mode, as a second guard.
  if (DEMO) return;
  api.saveBoard(JSON.stringify(board)).catch((e) => toast(`Save failed: ${String(e)}`));
  emitPluginEvent("board");
}

// ---------------------------------------------------------------- undo / redo
//
// Undo is snapshots, not operations. Every save() compares the
// board content with the last saved content, and if it changed,
// the previous content becomes one undo step. That covers every
// mutation without hunting for it: core drags, text commits,
// drops, plugin actions, Settings canvas changes and delete-all
// all save, so all are undoable, including plugin actions, which
// is why PLUGIN_API.md no longer says plugin actions have no undo.
//
// What a snapshot holds, and what it does not:
// - Items, next_id, next_group, bg and grid: restored on undo.
// - Camera: not stored, so panning and zooming never create an
//   undo step, and undoing never jumps the view.
// - Selection at the time of the change: restored, so undoing a
//   delete re-selects the restored cards.
// - One save is one step, however many items it changed: a drag
//   that moved five cards, or a drop that added three files, is
//   one Ctrl+Z, because those saves happen once, at mouseup.
// - Background link-preview fills save without undo (see
//   saveWithoutUndo), or adding one link would take two undos:
//   one to un-fill its preview, one to remove the card.
// - Clicking a card brings it to the front, and the move drag's
//   mouseup saves even when nothing moved, but through
//   saveWithoutUndo, so that stacking change never becomes
//   an undo step on its own.
// - 50 steps, oldest dropped. Items are paths, not image bytes,
//   so a snapshot is board JSON, not media.
const UNDO_LIMIT = 50;
interface UndoState {
  items: Item[];
  next_id: number;
  next_group: number;
  bg: string;
  grid: Board["grid"];
  selected: number[];
}
let undoStack: UndoState[] = [];
let redoStack: UndoState[] = [];
let lastSnapshot: UndoState | null = null;
// The content key of lastSnapshot, cached alongside it:
// recomputing it on every capture used to re-stringify the
// whole board a second time per save, for a snapshot that
// had not changed since the last capture.
let lastSnapshotKey: string | null = null;
function setLastSnapshot(s: UndoState): void {
  lastSnapshot = s;
  lastSnapshotKey = contentKey(s);
}
let suppressUndoCapture = false;

function contentSnapshot(): UndoState {
  return {
    items: JSON.parse(JSON.stringify(board.items)) as Item[],
    next_id: board.next_id,
    next_group: board.next_group,
    bg: board.bg,
    grid: board.grid,
    selected: [...selected],
  };
}

function contentKey(s: UndoState): string {
  // Selection is restored by undo, but a selection change alone
  // is not a board change, so it is not part of the key.
  return JSON.stringify({ items: s.items, next_id: s.next_id, next_group: s.next_group, bg: s.bg, grid: s.grid });
}

function updateUndoButtons(): void {
  const undoBtn = document.getElementById("btn-undo") as HTMLButtonElement | null;
  const redoBtn = document.getElementById("btn-redo") as HTMLButtonElement | null;
  if (undoBtn) undoBtn.classList.toggle("dim", undoStack.length === 0);
  if (redoBtn) redoBtn.classList.toggle("dim", redoStack.length === 0);
}

function captureUndoStep(): void {
  if (suppressUndoCapture) return;
  const cur = contentSnapshot();
  const curKey = contentKey(cur);
  if (lastSnapshot !== null && lastSnapshotKey === curKey) return;
  if (lastSnapshot !== null) {
    undoStack.push(lastSnapshot);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    // A new change after an undo discards the redo chain, as in
    // every editor: redo only redoes the change just undone.
    redoStack = [];
  }
  lastSnapshot = cur;
  lastSnapshotKey = curKey;
  updateUndoButtons();
}

function saveWithoutUndo(): void {
  boardSearchVersion++;
  // For changes that should save but not become an undo step:
  // background changes the user did not make, like a link
  // preview filling in, and a click's stacking change. The
  // file still saves, but no undo step is created, and
  // lastSnapshot moves to the new content, so the next user
  // change is still one step from here.
  suppressUndoCapture = true;
  try {
    save();
  } finally {
    suppressUndoCapture = false;
  }
  setLastSnapshot(contentSnapshot());
  updateUndoButtons();
}

function restoreUndoState(s: UndoState): void {
  board.items = JSON.parse(JSON.stringify(s.items)) as Item[];
  board.next_id = s.next_id;
  board.next_group = s.next_group;
  board.bg = s.bg;
  board.grid = s.grid;
  selected = s.selected.filter((id) => boardGet(board, id) !== undefined);
  editingId = null;
}

function undo(): boolean {
  if (undoStack.length === 0) return false;
  redoStack.push(contentSnapshot());
  const prev = undoStack.pop() as UndoState;
  restoreUndoState(prev);
  // Set lastSnapshot before save, so save's capture sees the
  // restored content as already known and does not push a step
  // or clear the redo chain we just built.
  setLastSnapshot(contentSnapshot());
  save(); render();
  renderBgOpts(); renderGridOpts();
  updateUndoButtons();
  return true;
}

function redo(): boolean {
  if (redoStack.length === 0) return false;
  undoStack.push(contentSnapshot());
  const next = redoStack.pop() as UndoState;
  restoreUndoState(next);
  setLastSnapshot(contentSnapshot());
  save(); render();
  renderBgOpts(); renderGridOpts();
  updateUndoButtons();
  return true;
}

function resetUndo(): void {
  undoStack = [];
  redoStack = [];
  setLastSnapshot(contentSnapshot());
  updateUndoButtons();
}
// Undo is per board, not per app: each board keeps its own
// stack in this map, keyed by its folder, so creating a new
// board, or switching away and back, never wipes another
// board's history. Undo is in-session only — nothing here
// is written to disk, so a fresh app start still starts
// with an empty stack for every board.
const undoByBoard = new Map<string, { undo: UndoState[]; redo: UndoState[]; last: UndoState | null }>();
function restoreUndoForBoard(dir: string, preserve: boolean): void {
  if (preserve) {
    // Same board, reloaded (a backup restore, or a rename
    // followed by a switch to the new name): the stack
    // stays, so undo can step back to before the reload,
    // but the redo chain is for the old content, so it goes.
    redoStack = [];
    setLastSnapshot(contentSnapshot());
    updateUndoButtons();
    return;
  }
  const saved = undoByBoard.get(dir);
  if (saved) {
    undoStack = saved.undo;
    redoStack = saved.redo;
    if (saved.last) setLastSnapshot(saved.last);
    else setLastSnapshot(contentSnapshot());
  } else {
    undoStack = [];
    redoStack = [];
    setLastSnapshot(contentSnapshot());
  }
  updateUndoButtons();
}
// Replace the board in place, from a JSON string the main
// process just handed over (a board switch, or a backup
// restore). The old board's undo, search, context index and
// media caches are all per-board, so they are cleared, not
// carried over — a restored board must not undo back into
// the board it replaced, and its context index is its own
// file in its own folder.
async function loadBoardFromJson(json: string, dir: string, preserveUndo = false): Promise<void> {
  commitEditingIfAny();
  const oldDir = boardDir;
  const sameBoard = oldDir !== "" && oldDir === dir;
  // Save the outgoing board's stack before replacing it,
  // unless this is the same board reloaded (a restore or
  // a rename): then the stack is kept, not filed away.
  if (!sameBoard && !preserveUndo && oldDir !== "") {
    undoByBoard.set(oldDir, { undo: undoStack, redo: redoStack, last: lastSnapshot });
    // 50 snapshots per board, unbounded across boards,
    // is 250 full-board copies for 5 boards. Keep at
    // most 3 filed boards; evict the oldest filed one
    // (never the board being loaded).
    while (undoByBoard.size > 3) {
      const first = undoByBoard.keys().next().value as string | undefined;
      if (first === undefined || first === dir) break;
      undoByBoard.delete(first);
    }
  }
  const parsed = JSON.parse(json) as Board;
  parsed.bg = parsed.bg ?? "#FFFFFF";
  parsed.grid = parsed.grid ?? "Dots";
  parsed.camera = parsed.camera ?? { x: 0, y: 0, zoom: 1 };
  board = parsed;
  boardSearchVersion++;
  boardDir = dir;
  selected = [];
  editingId = null;
  searchMatches = [];
  searchRows = [];
  searchIndex = -1;
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (input) input.value = "";
  // A pending debounced save belongs to the outgoing
  // board: flush it only if the main process is still on
  // that board (same-board reload/restore); on a switch
  // the main process has already moved on, so flushing
  // would write the old index into the new board's file
  // — discard it instead, the new board re-indexes.
  if (oldDir !== "" && oldDir === dir) flushContextIndex(); else cancelContextIndexSave();
  contextIndex.clear();
  contextIndexLoaded = false;
  contextIndexFailed = false;
  contextQueryCache.clear();
  contextQueryEmbedding = null;
  pdfSearchText.clear();
  pdfSearchIndexing.clear();
  pdfPages.clear();
  // These two were NOT cleared on board switch, unlike
  // every other per-board cache above: parsed PDF
  // documents and full base64 data URLs (each up to
  // 50 MB) survived for the app lifetime, so switching
  // boards often leaked memory. They are caches only
  // and re-load on demand for the new board.
  pdfDocs.clear();
  pdfFailed.clear();
  mediaDataUrls.clear();
  audioDurations.clear();
  audioFailed.clear();
  const boardDirEl = document.getElementById("board-dir-meta");
  if (boardDirEl) boardDirEl.textContent = `Board folder: ${boardDir}`;
  restoreUndoForBoard(dir, sameBoard || preserveUndo);
  render();
  void loadContextIndex();
}
async function switchToBoard(name: string, preserveUndo = false): Promise<boolean> {
  if (DEMO) { toast("Demo — boards do not switch in demo mode"); return false; }
  try {
    commitEditingIfAny();
    await api.saveBoard(JSON.stringify(board));
    flushContextIndex();
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
  if (DEMO) { toast("Demo — backups are not available in demo mode"); return false; }
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
function allocId(): number {
  board.next_id += 1;
  return board.next_id;
}
function openExternal(target: string): void {
  api.openExternal(target).catch((e) => toast(`Could not open ${target}: ${String(e)}`));
}

// Link cards are previews only: clicking one opens it in the browser.
// The preview (image, icon, title) comes from the site itself, via
// fetchPreview in the main process.
function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function isFrameCard(it: Item | undefined): boolean {
  if (!it || !("Plugin" in it.kind)) return false;
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

// ---------------------------------------------------------------- rendering

function svgEl2(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// The grid is a CSS background, not SVG nodes: a repeating dot or
// line pattern whose size and offset follow the camera. Panning
// then costs two style properties, not rebuilding hundreds of
// circles on every frame.
function applyGrid(): void {
  const cam = board.camera;
  if (board.grid === "Off") { gridEl.style.backgroundImage = "none"; return; }
  const rgb = parseHex(board.bg) ?? [247, 245, 240];
  const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const color = lum > 140 ? "#d8d8de" : "#55555a";
  let step = GRID;
  const bs = boardSize();
  while ((bs.x / cam.zoom) / step > 40 || (bs.y / cam.zoom) / step > 40) step *= 2;
  const size = step * cam.zoom;
  const offX = (Math.floor(cam.x / step) * step - cam.x) * cam.zoom;
  const offY = (Math.floor(cam.y / step) * step - cam.y) * cam.zoom;
  if (board.grid === "Dots") {
    gridEl.style.backgroundImage = `radial-gradient(circle, ${color} 1.5px, transparent 1.6px)`;
    gridEl.style.backgroundSize = `${size}px ${size}px`;
    gridEl.style.backgroundPosition = `${offX}px ${offY}px`;
    gridEl.style.backgroundRepeat = "repeat";
  } else {
    gridEl.style.backgroundImage = `linear-gradient(to right, ${color} 0 1px, transparent 1px), linear-gradient(to bottom, ${color} 0 1px, transparent 1px)`;
    gridEl.style.backgroundSize = `${size}px ${size}px, ${size}px ${size}px`;
    gridEl.style.backgroundPosition = `${offX}px ${offY}px, ${offX}px ${offY}px`;
    gridEl.style.backgroundRepeat = "repeat";
  }
}

// Camera-only update: one GPU transform on the SVG world and on the
// cards layer (cards live in world coordinates now), plus the grid
// offset and the resize-handle position. No DOM rebuild, no markdown,
// no image re-parse — this is what makes pan and zoom feel smooth.
function applyCamera(): void {
  const cam = board.camera;
  worldEl.setAttribute("transform", `translate(${-cam.x * cam.zoom},${-cam.y * cam.zoom}) scale(${cam.zoom})`);
  cardsEl.style.transform = `translate(${-cam.x * cam.zoom}px,${-cam.y * cam.zoom}px) scale(${cam.zoom})`;
  applyGrid();
  updateResizeHandle();
}

function visibleKey(): string {
  const v = visibleRect();
  const ids: number[] = [];
  for (const item of board.items) if (isVisibleItem(item, v)) ids.push(item.id);
  return `${ids.join(",")}|${selected.join(",")}|${editingId ?? ""}`;
}

// After a camera move, rebuild content only if the visible set
// actually changed (new cards scrolled into view). Panning inside
// the same visible set is applyCamera() alone.
function refreshContentIfVisibleChanged(): void {
  if (visibleKey() !== lastContentKey) render();
}

// Rebuild only the SVG layer (strokes/connectors), without touching
// card DOM. Used while dragging a card, so connectors attached to
// it follow in real time without re-parsing every card.
function renderSvgOnly(): void {
  worldEl.innerHTML = "";
  renderStrokesAndConnectors();
}

function renderStrokesAndConnectors(): void {
  const v = visibleRect();
  for (const item of board.items) {
    // A rotated stroke's extent can exceed its unrotated
    // bounding box, so culling it by that box would hide
    // it at the viewport edge: rotated strokes are always
    // drawn. The count is small, so this costs nothing.
    if (!("Stroke" in item.kind && itemRotation(item) !== 0) && !isVisibleItem(item, v)) continue;
    if ("Stroke" in item.kind) {
      const { points, color, width, marker } = item.kind.Stroke;
      if (points.length < 2) continue;
      const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
      const sel = selected.includes(item.id);
      // Rotation is an SVG transform around the stroke's
      // bounding-box centre, in world coords: the points
      // themselves are never rewritten, so undo, resize
      // and hit-testing all keep working in the local
      // frame, and rotation is just item.rotation.
      const rot = itemRotation(item);
      const c = centre(item);
      const transform = rot !== 0 ? `rotate(${rot} ${c.x} ${c.y})` : undefined;
      if (sel) {
        const selPath = svgEl2("path", { d, fill: "none", stroke: ACCENT, "stroke-width": String(width + 6), "stroke-linecap": "round", "stroke-linejoin": "round" });
        if (transform) selPath.setAttribute("transform", transform);
        worldEl.appendChild(selPath);
      }
      const path = svgEl2("path", { d, fill: "none", stroke: color, "stroke-width": String(width), "stroke-linecap": "round", "stroke-linejoin": "round" });
      if (transform) path.setAttribute("transform", transform);
      if (marker) path.setAttribute("opacity", "0.45");
      worldEl.appendChild(path);
    }
    if ("Connector" in item.kind) {
      const ends = clippedEnds(board, item.kind.Connector.from, item.kind.Connector.to);
      if (!ends) continue;
      const [a, b] = ends;
      const sel = selected.includes(item.id);
      worldEl.appendChild(svgEl2("line", { x1: String(a.x), y1: String(a.y), x2: String(b.x), y2: String(b.y), stroke: sel ? ACCENT : "#333333", "stroke-width": sel ? "3" : "2" }));
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / len, uy = dy / len;
      const head = 12, spread = 0.45;
      const c1 = Math.cos(spread), s1 = Math.sin(spread), c2 = Math.cos(-spread), s2 = Math.sin(-spread);
      const p1 = { x: b.x - head * (ux * c1 - uy * s1), y: b.y - head * (ux * s1 + uy * c1) };
      const p2 = { x: b.x - head * (ux * c2 - uy * s2), y: b.y - head * (ux * s2 + uy * c2) };
      worldEl.appendChild(svgEl2("polyline", { points: `${p1.x},${p1.y} ${b.x},${b.y} ${p2.x},${p2.y}`, fill: "none", stroke: sel ? ACCENT : "#333333", "stroke-width": sel ? "3" : "2" }));
    }
  }
  // Live stroke, connector preview and marquee are fast-path SVG
  // nodes updated directly during the drag (see mousemove); they
  // are not part of a content rebuild, or every pen point would
  // rebuild every card.
}

// Markdown is a per-character regex walk, so re-parsing every note
// on every render is the most expensive part of a rebuild for a
// text-heavy board. Cache it per item object, invalidated by the
// text and size themselves — an edit changes the text, so the
// cache misses exactly when it should.
const mdCache = new WeakMap<object, { text: string; size: number; html: string }>();
function cachedMarkdown(item: Item, text: string, size: number): string {
  const hit = mdCache.get(item);
  if (hit && hit.text === text && hit.size === size) return hit.html;
  const html = renderMarkdownHtml(text, size);
  mdCache.set(item, { text, size, html });
  return html;
}

function cardHtml(item: Item, plain = false): string {
  // Board JSON is untrusted input for this function: a board
  // shared by someone else, or a file dropped with a crafted
  // name, can carry any string in any field. This HTML is
  // inserted with innerHTML, so every value that lands in
  // an attribute or as text must be coerced or escaped
  // here, not trusted from the board. Numbers are forced
  // through Number() (a string like `0" onmouseover="…`
  // becomes NaN, then the fallback, instead of breaking
  // out of the style attribute), colours must match a
  // strict hex pattern, and names, domains and titles are
  // escaped with escapeHtml() before they are interpolated.
  // Markdown text is already escaped by renderMarkdownHtml;
  // image/video sources go through fileUrl(), which
  // encodes each path segment.
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const safeColor = (v: unknown, fallback: string): string =>
    typeof v === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? v : fallback;
  const id = num(item.id, 0);
  const sel = plain ? false : selected.includes(id);
  const cls = sel ? "card selected" : "card";
  if ("Plugin" in item.kind) {
    const ww0 = num(item.size.w, 0), hh0 = num(item.size.h, 0);
    const rot0 = itemRotation(item);
    const style0 = `left:${num(item.pos.x, 0)}px;top:${num(item.pos.y, 0)}px;width:${ww0}px;height:${hh0}px;${rot0 ? `transform:rotate(${rot0}deg);` : ""}`;
    const inner = getCardHtml(item) ?? "";
    const frameCls = getCardRenderer(item)?.frame === true ? " plugin-frame" : "";
    return `<div class="${cls}${frameCls}" data-id="${id}" style="${style0}"><div class="inner">${inner}</div></div>`;
  }
  // Cards live in world coordinates; the whole #cards layer is
  // transformed once by the camera (see applyCamera). Per-card
  // screen positions and per-card scale transforms used to force a
  // full reposition of every card on every pan/zoom frame — that
  // was the main source of lag. Content still scales with zoom,
  // because the layer itself is scaled.
  const ww = num(item.size.w, 0), hh = num(item.size.h, 0);
  const rot = itemRotation(item);
  const style = `left:${num(item.pos.x, 0)}px;top:${num(item.pos.y, 0)}px;width:${ww}px;height:${hh}px;${rot ? `transform:rotate(${rot}deg);` : ""}`;
  if ("Text" in item.kind) {
    if (!plain && editingId === id) return ""; // the editor DOM is managed separately
    const { text, size, color, bg } = item.kind.Text;
    const safeSize = num(size, 16);
    const noteBg = safeColor(bg, "#FFFFFF");
    return `<div class="${cls}" data-id="${id}" style="${style}background:${noteBg}"><div class="inner note-body" style="font-size:${safeSize}px;color:${safeColor(color, "#1A1A1A")}">${cachedMarkdown(item, text, safeSize)}</div></div>`;
  }
  if ("Shape" in item.kind) {
    const fill = safeColor(item.kind.Shape.fill, "#1A1A1A");
    const shape = item.kind.Shape.shape;
    const radius = shape === "ellipse" ? "50%" : shape === "rect" ? "12px" : "0px";
    // Polygon shapes are cut with clip-path on the inner
    // fill, so a triangle is really a triangle, not a
    // rectangle with a triangle drawn on it. Outer card
    // is transparent with no hairline border, so an
    // ellipse is really an ellipse: a filled outer rect
    // would show its corners outside the ellipse, and a
    // rectangular hairline would frame it. The selected
    // ring follows the outer border-radius for rect and
    // ellipse; for polygons it is the bounding rect,
    // which is how a polygon selection reads.
    const clip = shapeClipPath(shape);
    const clipStyle = clip ? `clip-path:${clip};` : "";
    return `<div class="${cls}" data-id="${id}" style="${style}background:transparent;border:none;border-radius:${radius}"><div class="inner" style="background:${fill};border-radius:${radius};${clipStyle}width:100%;height:100%;box-shadow:var(--shadow-sm)"></div></div>`;
  }
  if ("Image" in item.kind) {
    const { path } = item.kind.Image;
    const name = path.split("/").pop() ?? path;
    // A selected image shows whole, not cropped: the board
    // crops images to fill the card, which is the right look
    // for a board, but a poor preview of what you just
    // selected. Selecting switches to contain, so the full
    // image is visible; deselecting goes back to cover.
    const fit = sel ? "contain" : "cover";
    return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="background:var(--bg-system)"><img src="${api.fileUrl(path)}" data-name="${escapeHtml(name)}" data-path="${escapeHtml(path)}" draggable="false" style="width:100%;height:100%;object-fit:${fit};border-radius:12px" alt="" /></div></div>`;
  }
  if ("UrlCard" in item.kind) {
    const { url, title, description, image, icon } = item.kind.UrlCard;
    const domain = domainOf(url);
    const head = title ?? domain;
    const tile = tileColorFor(domain);
    const initial = (domain[0] ?? "?").toUpperCase();
    const img = safeHttpUrl(image);
    const ico = safeHttpUrl(icon);
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const footer = `<div class="link-footer"><a class="link-domain" data-action="open-link" data-id="${id}">${ico ? `<img class="favicon" src="${esc(ico)}" alt="" onerror="this.style.display='none';var f=this.nextElementSibling;if(f)f.style.display='flex'" /><span class="favicon-fallback" style="display:none;background:${tint(tile, 0.85)};color:${tile}">${esc(initial)}</span>` : `<span class="favicon-fallback" style="background:${tint(tile, 0.85)};color:${tile}">${esc(initial)}</span>`}<span>${esc(domain)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg></a></div>`;
    if (img) {
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner link-card">
        <a class="link-image" data-action="open-link" data-id="${id}"><img src="${esc(img)}" draggable="false" alt="" onerror="this.closest('.link-image').style.display='none'" /></a>
        <div class="link-body">
          <a class="link-title" data-action="open-link" data-id="${id}">${esc(head)}</a>
          ${description ? `<div class="link-desc">${esc(description)}</div>` : ""}
          ${footer}
        </div></div></div>`;
    }
    return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner link-card no-image">
      <div class="link-body">
        <a class="link-title" data-action="open-link" data-id="${id}">${esc(head)}</a>
        ${description ? `<div class="link-desc">${esc(description)}</div>` : ""}
        ${footer}
      </div></div></div>`;
  }
  // PDF tiles use red as the PDF file-type colour (the
  // Adobe/document red), not the destructive-action red:
  // it is a kind colour, like audio purple, not a warning.
  if ("PdfCard" in item.kind) {
    const { path, size_bytes } = item.kind.PdfCard;
    const name = path.split("/").pop() ?? path;
    const kb = Math.round(num(size_bytes, 0) / 1024);
    const tile = `<div class="tile" style="background:${tint("#E63946", 0.88)};color:#E63946;font-size:13px">PDF</div>
      <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 92, 14, true))}</div><div class="sub" style="font-size:12px">${kb} KB</div></div>`;
    // Plain rendering (slides, library, export) stays a tile:
    // a canvas drawn by PDF.js does not survive as HTML, so
    // a rendered page there would export as a blank box.
    if (plain) {
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">${tile}</div></div>`;
    }
    if (pdfFailed.has(path)) {
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">${tile}</div></div>`;
    }
    loadPdfPage(id, path);
    const pageNum = pdfPages.get(id) ?? 1;
    if (hh < 200) {
      // A short card, like the old 96px tile: a small page
      // preview on the left, name and page count on the right,
      // the same row shape as audio and video cards.
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px" data-pdf-wrap="${id}">
        <div style="width:56px;height:${hh - 24}px;flex:none;background:var(--bg-system);border-radius:6px;overflow:hidden"><canvas data-pdf-canvas="${id}" style="width:100%;height:100%;object-fit:contain;display:block"></canvas></div>
        <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 92, 14, true))}</div><div class="sub" style="font-size:12px">${kb} KB · <span data-pdf-count="${id}">…</span></div></div></div></div>`;
    }
    return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px" data-pdf-wrap="${id}">
      <div style="flex:1 1 auto;min-height:0;background:var(--bg-system);border-radius:8px;overflow:hidden"><canvas data-pdf-canvas="${id}" style="width:100%;height:100%;object-fit:contain;display:block"></canvas></div>
      <div style="display:flex;align-items:center;gap:8px"><div class="title" style="font-size:14px;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>
      <button class="pdf-nav" data-action="pdf-prev" data-id="${id}" title="Previous page" aria-label="Previous page" ${pageNum <= 1 ? "disabled" : ""}>‹</button><span class="sub" data-pdf-count="${id}">…</span><button class="pdf-nav" data-action="pdf-next" data-id="${id}" title="Next page" aria-label="Next page">›</button></div>
      <div class="sub" style="font-size:12px">${kb} KB</div></div></div>`;
  }
  if ("Swatch" in item.kind) {
    const { hex } = item.kind.Swatch;
    return `<div class="${cls}" data-id="${id}" style="${style};background:${safeColor(hex, "#1A1A1A")}"><div class="swatch-pill">${escapeHtml(safeColor(hex, "#1A1A1A"))}</div></div>`;
  }
  if ("Audio" in item.kind) {
    const { path } = item.kind.Audio;
    const name = path.split("/").pop() ?? path;
    if (audioFailed.has(path)) {
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px"><div class="missing-media" style="flex:1 1 auto">File missing: ${escapeHtml(name)}</div></div></div>`;
    }
    const playing = !plain && audioId === id && audioEl && !audioEl.paused;
    const isCurrent = !plain && audioId === id && audioEl;
    const dur = isCurrent && isFinite(audioEl!.duration) ? audioEl!.duration : (audioDurations.get(path) ?? NaN);
    const cur = isCurrent ? audioEl!.currentTime : 0;
    const seekVal = isFinite(dur) && dur > 0 ? Math.round((cur / dur) * 1000) : 0;
    const seekPct = isFinite(dur) && dur > 0 ? Math.round((cur / dur) * 100) : 0;
    if (!isCurrent) loadAudioDuration(id, path);
    // Like the other media cards: a tile, a title, and the time as
    // a quiet grey sub-line — the same shape as the PDF card's
    // "1 KB". The seek control is a thin track in the tile's own
    // purple, not a chunky browser slider in blue.
    const tile = hh >= 104 ? 56 : 48;
    return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="audio-tile clickable" data-action="play-audio" data-id="${id}" style="width:${tile}px;height:${tile}px;background:${tint("#6A4C93", 0.88)};color:#6a4c93;font-size:${tile === 56 ? 18 : 16}px">${playing ? "\u275a\u275a" : "\u25b6"}</div>
        <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 92, 14, true))}</div><div class="sub" style="font-size:12px"><span data-audio-time="${id}">${formatAudioTime(cur)}</span> / <span data-audio-dur="${id}">${formatAudioTime(dur)}</span></div></div>
      </div>
      <input class="audio-seek" type="range" min="0" max="1000" value="${seekVal}" style="--seek-pct:${seekPct}%" data-audio-seek="${id}" aria-label="Seek">
    </div></div>`;
  }
  if ("Video" in item.kind) {
    const { source, remote, size_bytes } = item.kind.Video;
    const name = remote ? domainOf(source) : (source.split("/").pop() ?? source);
    const sub = remote ? "Video link" : `${Math.round(num(size_bytes, 0) / 1024)} KB`;
    const thumbH = (ww - 24) * 9 / 16;
    // A local video in a format Chromium can play plays right here
    // in the board, with its real first frame as the thumbnail —
    // no black box, no trip out to a browser or system player.
    // Remote links (YouTube, Vimeo, …) and formats Chromium cannot
    // play still open outside the app, as before.
    const ext = source.toLowerCase().split("?")[0].split("#")[0].split(".").pop() ?? "";
    const inline = !remote && ["mp4", "webm", "m4v"].includes(ext);
    if (inline) {
      const src = api.fileUrl(source);
      if (hh >= thumbH + 70) {
        return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
          <video controls preload="metadata" playsinline src="${src}" data-name="${escapeHtml(name)}" data-path="${escapeHtml(source)}" style="width:${ww - 24}px;height:${thumbH}px;object-fit:${sel ? "contain" : "cover"};border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
          <div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 24, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
      }
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">
        <video controls preload="metadata" playsinline src="${src}" data-name="${escapeHtml(name)}" data-path="${escapeHtml(source)}" style="width:96px;height:56px;object-fit:${sel ? "contain" : "cover"};border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
        <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 132, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div></div>`;
    }
    if (hh >= thumbH + 70) {
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
        <div class="video-thumb clickable" data-action="play-video" data-id="${id}" style="width:${ww - 24}px;height:${thumbH}px;font-size:28px">▶</div>
        <div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 24, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
    }
    return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">
      <div class="video-thumb clickable" data-action="play-video" data-id="${id}" style="width:96px;height:56px;font-size:20px">▶</div>
      <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 132, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div></div>`;
  }
  return "";
}

// Visible world rect, with a margin so cards at the edge do not pop
// in and out while panning. Everything else is culled: for a board
// with thousands of items, render() only builds DOM for what is on
// screen, instead of rebuilding every card on every mousemove.
function visibleRect(): { x0: number; y0: number; x1: number; y1: number } {
  const cam = board.camera;
  const m = 200;
  return {
    x0: cam.x - m, y0: cam.y - m,
    x1: cam.x + boardSize().x / cam.zoom + m,
    y1: cam.y + boardSize().y / cam.zoom + m,
  };
}
function isVisibleItem(item: Item, v: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const [p, s] = itemBounds(board, item);
  return p.x < v.x1 && p.x + s.w > v.x0 && p.y < v.y1 && p.y + s.h > v.y0;
}

function render(): void {
  boardEl.style.background = board.bg;
  // A playing (or paused mid-way) video used to restart from 0 on
  // every render, because render() rebuilds the card DOM and the
  // <video> node with it. Capture position and playing state first,
  // and restore them onto the rebuilt nodes below.
  const videoState = new Map<number, { t: number; playing: boolean }>();
  for (const v of Array.from(cardsEl.querySelectorAll("video"))) {
    const card = v.closest(".card") as HTMLElement | null;
    if (!card || !card.dataset.id) continue;
    if (!v.paused || (isFinite(v.currentTime) && v.currentTime > 0)) {
      videoState.set(Number(card.dataset.id), { t: v.currentTime, playing: !v.paused });
    }
  }
  worldEl.innerHTML = "";
  renderStrokesAndConnectors();
  // Cards: rebuild, except the note being edited (its textarea stays).
  // Only visible cards are built (see visibleRect).
  const editingEl = editingId !== null ? cardsEl.querySelector(`[data-id="${editingId}"]`) : null;
  const editingHtml = editingEl ? editingEl.outerHTML : null;
  const v = visibleRect();
  let html = "";
  for (const item of board.items) {
    if ("Stroke" in item.kind || "Connector" in item.kind) continue;
    if (editingId === item.id) continue;
    if (!isVisibleItem(item, v)) continue;
    html += cardHtml(item);
  }
  cardsEl.innerHTML = html;
  applyStacking();
  for (const [id, st] of videoState) {
    const v = cardsEl.querySelector(`[data-id="${id}"] video`) as HTMLVideoElement | null;
    if (!v) continue;
    const restore = () => {
      try { v.currentTime = st.t; } catch { /* not ready yet */ }
      if (st.playing) v.play().catch(() => undefined);
    };
    if (v.readyState >= 1) restore();
    else v.addEventListener("loadedmetadata", restore, { once: true });
  }
  if (editingHtml) cardsEl.insertAdjacentHTML("beforeend", editingHtml);
  refreshActiveView();
  updateToolbar();
  lastContentKey = visibleKey();
  applyCamera();
  updateSearch();
}

function isRotatable(it: Item | undefined): boolean {
  if (!it || "Connector" in it.kind) return false;
  return !isFrameCard(it);
}
function rotateHandleWorld(it: Item): Pt {
  const c = centre(it);
  const top = { x: c.x, y: it.pos.y - 28 / board.camera.zoom };
  return rotatePoint(top, c, itemRotation(it));
}
function updateResizeHandle(): void {
  const el = document.getElementById("resize-handle") as HTMLDivElement;
  const rotEl = document.getElementById("rotate-handle") as HTMLDivElement | null;
  // A plugin view owns the screen: the board's resize handle is
  // not part of that view, so it must never float over it — it
  // did, at the selected card's corner, while playing a slide.
  if (getActiveView() !== "board" || selected.length !== 1 || settingsOpen || editingId !== null) {
    el.style.display = "none";
    if (rotEl) rotEl.style.display = "none";
    return;
  }
  const it = boardGet(board, selected[0]);
  if (!it || "Connector" in it.kind) {
    el.style.display = "none";
    if (rotEl) rotEl.style.display = "none";
    return;
  }
  const [p, s] = itemBounds(board, it);
  const c = centre(it);
  const rot = itemRotation(it);
  // Corners follow the rotation, so the handles sit on the
  // card as drawn, not on its unrotated bounding box.
  const corner = rotatePoint({ x: p.x + s.w, y: p.y + s.h }, c, rot);
  const screen = toScreen(corner);
  const bs = boardSize();
  if (screen.x < 0 || screen.y < 0 || screen.x > bs.x || screen.y > bs.y) {
    el.style.display = "none";
  } else {
    el.style.left = `${screen.x}px`;
    el.style.top = `${screen.y}px`;
    el.style.display = "block";
  }
  if (rotEl) {
    if (!isRotatable(it)) { rotEl.style.display = "none"; return; }
    const rs = toScreen(rotateHandleWorld(it));
    if (rs.x < 0 || rs.y < 0 || rs.x > bs.x || rs.y > bs.y) {
      rotEl.style.display = "none"; return;
    }
    rotEl.style.left = `${rs.x}px`;
    rotEl.style.top = `${rs.y}px`;
    // The grip's position already follows the rotation, but
    // its stem did not: it always pointed straight down, so
    // at 180° the stem pointed away from the card instead
    // of back to it, and the handle looked detached. Rotate
    // the grip itself with the card, around its centre, so
    // the stem always points at the card's centre — down
    // at 0°, up at 180°, sideways at 90°.
    rotEl.style.transform = rot ? `rotate(${rot}deg)` : "";
    rotEl.style.display = "block";
  }
}

function noteBgOfSelected(): string | null {
  for (const id of selected) {
    const it = boardGet(board, id);
    if (it && "Text" in it.kind) return it.kind.Text.bg ?? "#FFFFFF";
  }
  return null;
}
// Shapes: one toolbar button, like the pen, with a flyout
// beside it to choose the shape. The table is the single
// source for the flyout, the toolbar button icon, search
// labels and drag previews, so adding a shape means one
// row here, not edits in four places. Keyboard shortcuts
// stay R/E only: the flyout is how the new shapes are
// picked, and no new key is stolen from plugins or text.
const SHAPES: { kind: ShapeKind; label: string; key: string; svg: string }[] = [
  { kind: "rect", label: "Rectangle", key: "R", svg: '<rect x="4" y="5" width="16" height="14" rx="2" />' },
  { kind: "ellipse", label: "Ellipse", key: "E", svg: '<ellipse cx="12" cy="12" rx="8" ry="6.5" />' },
  { kind: "triangle", label: "Triangle", key: "", svg: '<path d="M12 4 L20 20 L4 20 Z" />' },
  { kind: "diamond", label: "Diamond", key: "", svg: '<path d="M12 3 L21 12 L12 21 L3 12 Z" />' },
  { kind: "hexagon", label: "Hexagon", key: "", svg: '<path d="M8 3 L16 3 L21 12 L16 21 L8 21 L3 12 Z" />' },
  { kind: "star", label: "Star", key: "", svg: '<path d="M12 3 L14.7 9 L21 9.5 L16.2 13.8 L17.8 20 L12 16.5 L6.2 20 L7.8 13.8 L3 9.5 L9.3 9 Z" />' },
  { kind: "arrow", label: "Block arrow", key: "", svg: '<path d="M3 10 H15 V5 L21 12 L15 19 V14 H3 Z" />' },
];
function shapeMeta(kind: ShapeKind): { label: string; key: string; svg: string } {
  return SHAPES.find((s) => s.kind === kind) ?? SHAPES[0];
}
function shapeLabel(kind: ShapeKind): string { return shapeMeta(kind).label; }
function isShapeTool(t: string): t is ShapeKind {
  return SHAPES.some((s) => s.kind === t);
}
// clip-path polygons, in % of the shape's box. The arrow
// points right; rotate it (handle or [ ]) to point
// anywhere else, like any other shape.
function shapeClipPath(kind: ShapeKind): string | null {
  switch (kind) {
    case "triangle": return "polygon(50% 0, 100% 100%, 0 100%)";
    case "diamond": return "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)";
    case "hexagon": return "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)";
    case "star": return "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)";
    case "arrow": return "polygon(0 40%, 60% 40%, 60% 15%, 100% 50%, 60% 85%, 60% 60%, 0 60%)";
    default: return null;
  }
}
// Drag-preview polygon points, in board coords for a
// box from (x0, y0) sized w x h. Same geometry as the
// clip-paths above, so the preview is the shape drawn.
function shapePreviewPoints(kind: ShapeKind, x0: number, y0: number, w: number, h: number): string {
  const px = (fx: number, fy: number) => `${x0 + fx * w},${y0 + fy * h}`;
  switch (kind) {
    case "triangle": return [px(0.5, 0), px(1, 1), px(0, 1)].join(" ");
    case "diamond": return [px(0.5, 0), px(1, 0.5), px(0.5, 1), px(0, 0.5)].join(" ");
    case "hexagon": return [px(0.25, 0), px(0.75, 0), px(1, 0.5), px(0.75, 1), px(0.25, 1), px(0, 0.5)].join(" ");
    case "star": return [[0.5, 0], [0.61, 0.35], [0.98, 0.35], [0.68, 0.57], [0.79, 0.91], [0.5, 0.7], [0.21, 0.91], [0.32, 0.57], [0.02, 0.35], [0.39, 0.35]].map(([fx, fy]) => px(fx, fy)).join(" ");
    case "arrow": return [px(0, 0.4), px(0.6, 0.4), px(0.6, 0.15), px(1, 0.5), px(0.6, 0.85), px(0.6, 0.6), px(0, 0.6)].join(" ");
    default: return "";
  }
}
function updateToolbar(): void {
  // render() runs on every mousemove; rebuilding the toolbar's DOM
  // every time is wasted work when nothing about it changed.
  const noteBg = noteBgOfSelected();
  const key = `${tool}|${selected.join(",")}|${penColor}|${noteBg ?? ""}`;
  if (key === lastToolbarKey) return;
  lastToolbarKey = key;
  const setActive = (id: string, on: boolean) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", on);
  };
  setActive("tool-select", tool === "select");
  setActive("tool-pen", tool === "pen");
  setActive("tool-connector", tool === "connector");
  // Shapes are one toolbar button, like the pen: the button
  // shows the shape last chosen, and the flyout beside the
  // toolbar (same .palette surface as the pen colours)
  // chooses between all shapes in the SHAPES table.
  const shapeBtn = document.getElementById("tool-shape") as HTMLButtonElement | null;
  const isShape = isShapeTool(tool);
  if (shapeBtn) {
    setActive("tool-shape", isShape);
    if (isShapeTool(tool) && shapeBtn.dataset.shape !== tool) {
      const meta = shapeMeta(tool);
      shapeBtn.dataset.shape = tool;
      shapeBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${meta.svg}</svg>`;
      shapeBtn.title = meta.key ? `${meta.label} (${meta.key})` : meta.label;
      shapeBtn.setAttribute("aria-label", meta.label);
    }
  }
  const shapePicker = document.getElementById("shape-picker") as HTMLDivElement | null;
  if (shapePicker) {
    shapePicker.style.display = isShape ? "flex" : "none";
    if (isShape && shapePicker.childElementCount === 0) {
      for (const meta of SHAPES) {
        const b = document.createElement("button");
        b.className = "shape-option";
        b.dataset.shape = meta.kind;
        b.title = meta.key ? `${meta.label} (${meta.key})` : meta.label;
        b.setAttribute("aria-label", meta.label);
        b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${meta.svg}</svg>`;
        b.addEventListener("click", () => setTool(meta.kind));
        shapePicker.appendChild(b);
      }
    }
    if (isShape) {
      for (const child of Array.from(shapePicker.children)) {
        (child as HTMLButtonElement).classList.toggle("active", (child as HTMLButtonElement).dataset.shape === tool);
      }
    }
  }
  // Note colours: shown when at least one selected card is a
  // text note and the pen flyout is not showing (pen tool).
  // Clicking a colour sets the background of every selected
  // text note, and saves, so it is undoable like any edit.
  const noteEl = document.getElementById("note-colours") as HTMLDivElement | null;
  if (noteEl) {
    const showNotes = noteBg !== null && tool !== "pen";
    noteEl.style.display = showNotes ? "flex" : "none";
    if (showNotes && noteEl.childElementCount === 0) {
      for (const hex of NOTE_COLOURS) {
        const b = document.createElement("div");
        b.className = "swatch";
        b.style.background = hex;
        b.title = hex;
        b.addEventListener("click", () => {
          for (const id of selected) {
            const it = boardGet(board, id);
            if (it && "Text" in it.kind) it.kind.Text.bg = hex;
          }
          save(); render();
        });
        noteEl.appendChild(b);
      }
    }
    if (showNotes) {
      for (const child of Array.from(noteEl.children)) {
        const sw = child as HTMLDivElement;
        sw.classList.toggle("active", sw.title.toUpperCase() === (noteBg ?? "#FFFFFF").toUpperCase());
      }
    }
  }
  syncPluginToolButtons(tool);
  const palette = document.getElementById("palette") as HTMLDivElement;
  palette.style.display = tool === "pen" ? "flex" : "none";
  if (tool === "pen" && palette.childElementCount === 0) {
    for (const hex of PALETTE) {
      const b = document.createElement("div");
      b.className = "swatch" + (hex === penColor ? " active" : "");
      b.style.background = hex;
      b.title = hex;
      b.addEventListener("click", () => { penColor = hex; render(); emitPluginEvent("pen"); });
      palette.appendChild(b);
    }
  }
  if (tool === "pen") {
    // A pen colour set elsewhere — Palette's wheel, for
    // example — is not one of the six fixed swatches, so
    // without this it would show no active swatch at all,
    // and the toolbar would not say what the pen is.
    // Keep at most one such custom swatch: drop a stale
    // one, add the current colour if it is not fixed.
    for (const child of Array.from(palette.children)) {
      const sw = child as HTMLDivElement;
      if (!PALETTE.includes(sw.title) && sw.title.toUpperCase() !== penColor.toUpperCase()) sw.remove();
    }
    const hasCurrent = Array.from(palette.children).some((c) => (c as HTMLDivElement).title.toUpperCase() === penColor.toUpperCase());
    if (!hasCurrent) {
      const b = document.createElement("div");
      b.className = "swatch";
      b.style.background = penColor;
      b.title = penColor;
      b.addEventListener("click", () => { penColor = penColor; render(); emitPluginEvent("pen"); });
      palette.prepend(b);
    }
    for (const child of Array.from(palette.children)) {
      const sw = child as HTMLDivElement;
      sw.classList.toggle("active", sw.style.background === penColor || sw.title === penColor);
    }
  }
  const del = document.getElementById("btn-delete") as HTMLButtonElement;
  del.classList.toggle("dim", selected.length === 0);
}

// Selection changes must not rebuild the card DOM: rebuilding on
// mousedown destroys the very element the user pressed, so its click
// (a card button, or a double-click to edit) never fires. Bringing a
// card to the front must not move its DOM node either: appendChild
// removes and re-inserts it, which cancels the pending click in
// Chromium. Stacking is therefore done with z-index, which changes
// paint order without touching the node at all.
function updateSelectionInner(): void {
  for (const child of Array.from(cardsEl.children)) {
    const el = child as HTMLElement;
    const isSel = selected.includes(Number(el.dataset.id));
    el.classList.toggle("selected", isSel);
    // A selected image or video shows whole (contain), not
    // cropped (cover): cardHtml sets this at render time,
    // but a plain click only toggles the class here, without
    // a full render — and a full render would restart a
    // playing video — so update the fit here too.
    for (const media of Array.from(el.querySelectorAll("img, video"))) {
      (media as HTMLElement).style.objectFit = isSel ? "contain" : "cover";
    }
  }
  const del = document.getElementById("btn-delete") as HTMLButtonElement;
  del.classList.toggle("dim", selected.length === 0);
  // Selection changes without a full render (a plain click) still
  // need the resize handle to appear / disappear immediately.
  updateResizeHandle();
}

function updateSelection(): void {
  updateSelectionInner();
  // Toolbar state now depends on selection (note colours
  // show only when a text note is selected), and a click
  // only calls updateSelection, not render, so the toolbar
  // must refresh here or the flyout would never appear.
  updateToolbar();
  emitPluginEvent("selection");
}

function applyStacking(): void {
  // Only relative order matters for paint: cards are built
  // into #cards in board order by render(), so a child's
  // DOM index already is its stacking order among the
  // cards that are actually on screen. The old version
  // built a Map over every board item on every render,
  // including thousands of off-screen items that have no
  // DOM node and need no z-index at all.
  let i = 0;
  for (const child of Array.from(cardsEl.children)) {
    (child as HTMLElement).style.zIndex = String(i++);
  }
}

// ---------------------------------------------------------------- editing

function startTextEdit(id: number): void {
  const item = boardGet(board, id);
  if (!item || !("Text" in item.kind)) return;
  // Render first, then mark the note as editing: render() skips
  // the editing note, so setting editingId before it would
  // leave a brand-new note with no card in the DOM to edit —
  // double-clicking empty space created a note that only
  // appeared after the next click. A later render preserves
  // the textarea through editingHtml, as before.
  render();
  editingId = id;
  const card = cardsEl.querySelector(`[data-id="${id}"]`);
  if (!card) { editingId = null; return; }
  const { size } = item.kind.Text;
  const ta = document.createElement("textarea");
  ta.className = "note-edit";
  ta.value = item.kind.Text.text;
  ta.style.fontSize = `${size}px`;
  ta.style.color = item.kind.Text.color;
  card.innerHTML = "";
  card.appendChild(ta);
  card.classList.add("selected");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const commit = () => {
    if (editingId !== id) return;
    const text = ta.value;
    // An empty note is not a note: double-clicking empty
    // space creates a text box, and if nothing is typed
    // before it is committed, it must vanish, not stay as
    // a blank card on the board. Whitespace only counts
    // as empty. Removing here is undoable, like any edit.
    if (text.trim() === "") {
      board.items = board.items.filter((it) => it.id !== id);
      selected = selected.filter((s) => s !== id);
      editingId = null;
      save();
      render();
      return;
    }
    const it = boardGet(board, id);
    if (it && "Text" in it.kind) {
      it.kind.Text.text = text;
      it.size.h = Math.max(40, estimateTextHeight(text, it.kind.Text.size, it.size.w));
    }
    editingId = null;
    save();
    render();
  };
  ta.addEventListener("blur", commit);
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); ta.blur(); }
  });
  ta.addEventListener("mousedown", (e) => e.stopPropagation());
}

function commitEditingIfAny(): void {
  if (editingId === null) return;
  const ta = cardsEl.querySelector("textarea.note-edit") as HTMLTextAreaElement | null;
  if (ta) ta.blur();
  else { editingId = null; render(); }
}

// ---------------------------------------------------------------- tools

function setTool(t: Tool): void {
  tool = t;
  drag = null;
  render();
}

// Selection actions, shared by the keyboard shortcuts and by the
// plugin API (so a palette plugin can group, ungroup or delete
// exactly as Ctrl+G / Ctrl+U / Delete do, instead of reimplementing
// them and drifting — in particular, group ids must come from
// board.next_group, or a later core group can collide with them).
function groupSelected(): boolean {
  if (selected.length < 2) return false;
  board.next_group += 1;
  const g = board.next_group;
  for (const it of board.items) if (selected.includes(it.id)) it.group = g;
  save(); render();
  return true;
}

function ungroupSelected(): boolean {
  const groups = new Set(selected.map((id) => boardGet(board, id)?.group).filter((g): g is number => g !== null && g !== undefined));
  if (groups.size === 0) return false;
  for (const it of board.items) if (it.group !== null && groups.has(it.group)) it.group = null;
  save(); render();
  return true;
}

function deleteSelected(): boolean {
  if (selected.length === 0) return false;
  board.items = board.items.filter((it) => !selected.includes(it.id));
  selected = [];
  save(); render();
  return true;
}

function cornerHit(id: number, world: Pt): boolean {
  const cam = board.camera;
  const it = boardGet(board, id);
  if (!it || "Connector" in it.kind) return false;
  const [p, s] = itemBounds(board, it);
  const corner = rotatePoint({ x: p.x + s.w, y: p.y + s.h }, centre(it), itemRotation(it));
  const tol = 16 / cam.zoom;
  return Math.hypot(world.x - corner.x, world.y - corner.y) <= tol;
}
function rotateHit(id: number, world: Pt): boolean {
  const cam = board.camera;
  const it = boardGet(board, id);
  if (!it || !isRotatable(it)) return false;
  const h = rotateHandleWorld(it);
  const tol = 18 / cam.zoom;
  return Math.hypot(world.x - h.x, world.y - h.y) <= tol;
}
function normAngle(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
function rotateSelected(delta: number): boolean {
  let changed = false;
  for (const id of selected) {
    const it = boardGet(board, id);
    if (!it || !isRotatable(it)) continue;
    it.rotation = normAngle(itemRotation(it) + delta);
    changed = true;
  }
  if (!changed) return false;
  save(); render();
  return true;
}

// ---------------------------------------------------------------- mouse

boardEl.addEventListener("mousedown", (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.closest("#toolbar, #settings-backdrop, #toast, #plugin-overlays, #search-box, #title-bar, video, input")) return;
  // A board click or drag must never start a native text selection
  // across the cards (bug: clicking anywhere highlighted all text).
  if (!target.closest("textarea.note-edit")) window.getSelection()?.removeAllRanges();
  if (e.button !== 0) return;
  const winPt: Pt = boardPoint(e.clientX, e.clientY);
  if (editingId !== null && !target.closest("textarea.note-edit")) {
    commitEditingIfAny();
    render();
    return;
  }
  const world = toWorld(winPt);
  // A plugin view owns its own viewport: core board clicks, pan and
  // tools must not run while it is active. The plugin's own
  // listeners on its container handle clicks there.
  if (getActiveView() !== "board" && target.closest("#plugin-view")) return;
  if (tool.startsWith("plugin:")) {
    const pt = getPluginTool(tool);
    if (pt?.onMouseDown) {
      try { pt.onMouseDown(world); } catch (e) { toast(`Plugin tool failed: ${String(e)}`); }
      pluginToolDown = true;
      return;
    }
    return;
  }
  if (spaceDown) { drag = { kind: "pan", last: winPt }; return; }
  if (isShapeTool(tool)) {
    drag = { kind: "shape", shape: tool, start: world, current: world };
    return;
  }
  if (tool === "pen") {
    drag = { kind: "stroke", points: [world] };
    return;
  }
  if (tool === "connector") {
    const hit = hitTestWithFrames(board, world);
    const hitItem = hit !== null ? boardGet(board, hit) : null;
    const anchorable = hitItem && !("Stroke" in hitItem.kind) && !("Connector" in hitItem.kind);
    drag = { kind: "connector", from: hitItem && anchorable ? { Item: hitItem.id } : { Point: world }, current: world };
    return;
  }
  // Select tool.
  if (e.detail === 2) {
    // Without this, the browser's default mousedown focus runs after
    // this handler and steals focus from a textarea created here, so
    // typing would never land in a new or edited note.
    e.preventDefault();
    const hit = hitTestWithFrames(board, world);
    if (hit !== null) {
      const it = boardGet(board, hit);
      if (it && "Plugin" in it.kind && handlePluginCardDoubleClick(it)) return;
      if (it && "Text" in it.kind) { startTextEdit(hit); return; }
      if (it && "UrlCard" in it.kind) { openExternal(it.kind.UrlCard.url); return; }
      if (it && "PdfCard" in it.kind) { openExternal(it.kind.PdfCard.path); return; }
      if (it && "Image" in it.kind) { openExternal(it.kind.Image.path); return; }
    } else {
      const id = allocId();
      board.items.push({ id, pos: world, size: { w: 260, h: 48 }, group: null, kind: { Text: { text: "", bold: false, size: 16, color: "#1A1A1A" } } });
      // No save here: the commit saves the typed text, or
      // removes the note if it is empty, so an empty note
      // leaves no board change and no undo step behind.
      startTextEdit(id);
      return;
    }
  }
  const clicked = hitTestWithFrames(board, world);
  if (selected.length === 1 && rotateHit(selected[0], world)) {
    const it = boardGet(board, selected[0]);
    drag = { kind: "rotate", id: selected[0], origRot: it ? itemRotation(it) : 0, moved: false };
    return;
  }
  if (selected.length === 1 && cornerHit(selected[0], world)) {
    const sel = selected[0];
    const it = boardGet(board, sel);
    drag = { kind: "resize", id: sel, startWorld: world, origW: it?.size.w ?? 100, origH: it?.size.h ?? 100, moved: false };
    return;
  }
  if (clicked !== null && cornerHit(clicked, world)) {
    selected = select(board, selected, clicked, false);
    bringToFront(selected);
    applyStacking();
    updateSelection();
    const it = boardGet(board, clicked);
    drag = { kind: "resize", id: clicked, startWorld: world, origW: it?.size.w ?? 100, origH: it?.size.h ?? 100, moved: false };
    return;
  }
  if (clicked !== null) {
    selected = select(board, selected, clicked, e.shiftKey);
    bringToFront(selected);
    applyStacking();
    updateSelection();
    drag = { kind: "move", lastWorld: world, moved: false };
    return;
  }
  if (!e.shiftKey) selected = [];
  drag = { kind: "marquee", start: world, current: world };
});

// Fast-path drag previews: a single SVG node updated in place,
// instead of rebuilding every card and stroke on every mousemove.
// The node is cleared by the next full render (mouseup), so it never
// needs its own removal.
function dragPreview(id: string, tag: string): SVGElement {
  let el = worldEl.querySelector(`#${id}`) as SVGElement | null;
  if (!el) {
    el = svgEl2(tag, { id }) as SVGElement;
    worldEl.appendChild(el);
  }
  return el;
}
function updateLiveStroke(points: Pt[]): void {
  const el = dragPreview("live-stroke", "path");
  el.setAttribute("d", points.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x},${pt.y}`).join(" "));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", penColor);
  el.setAttribute("stroke-width", "3");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
}
function updateDraggedCards(ids: number[]): void {
  // Cards are world-space now, so moving one is a style change on
  // its own node — no markdown, no image re-parse, no rebuild.
  for (const id of ids) {
    const it = boardGet(board, id);
    const el = cardsEl.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
    if (!it || !el) continue;
    el.style.left = `${it.pos.x}px`;
    el.style.top = `${it.pos.y}px`;
    el.style.width = `${it.size.w}px`;
    el.style.height = `${it.size.h}px`;
  }
}

window.addEventListener("mousemove", (e: MouseEvent) => {
  const winPt: Pt = boardPoint(e.clientX, e.clientY);
  const world = toWorld(winPt);
  if (!drag) {
    // Cursor hints run at most once per frame: hitTest walks every
    // item, and mousemove can fire far faster than the display.
    pendingCursor = world;
    if (!cursorRaf) {
      cursorRaf = requestAnimationFrame(() => {
        cursorRaf = 0;
        const w = pendingCursor;
        if (!w) return;
        if (settingsOpen || editingId !== null) {
          boardEl.style.cursor = "default";
        } else if (tool === "pen" || tool === "connector" || tool === "rect" || tool === "ellipse") {
          boardEl.style.cursor = "crosshair";
        } else if (spaceDown) {
          boardEl.style.cursor = "grab";
        } else if (selected.length === 1 && rotateHit(selected[0], w)) {
          boardEl.style.cursor = "grab";
        } else if (selected.length === 1 && cornerHit(selected[0], w)) {
          boardEl.style.cursor = "nwse-resize";
        } else if (hitTestWithFrames(board, w) !== null) {
          boardEl.style.cursor = "move";
        } else {
          boardEl.style.cursor = "default";
        }
      });
    }
    return;
  }
  boardEl.style.cursor = drag.kind === "resize" ? "nwse-resize" : drag.kind === "rotate" ? "grabbing" : drag.kind === "pan" ? "grabbing" : drag.kind === "move" ? "move" : "default";
  if (drag.kind === "pan") {
    board.camera.x -= (winPt.x - drag.last.x) / board.camera.zoom;
    board.camera.y -= (winPt.y - drag.last.y) / board.camera.zoom;
    drag.last = winPt;
    applyCamera();
    refreshContentIfVisibleChanged();
  } else if (drag.kind === "move") {
    const dx = world.x - drag.lastWorld.x, dy = world.y - drag.lastWorld.y;
    if (Math.hypot(dx, dy) > 0.5) drag.moved = true;
    moveSelection(board, selected, dx, dy);
    drag.lastWorld = world;
    updateDraggedCards(selected);
    renderSvgOnly();
    updateResizeHandle();
  } else if (drag.kind === "resize") {
    resizeItem(board, drag.id, drag.origW + (world.x - drag.startWorld.x), drag.origH + (world.y - drag.startWorld.y));
    if (Math.hypot(world.x - drag.startWorld.x, world.y - drag.startWorld.y) > 2) drag.moved = true;
    updateDraggedCards([drag.id]);
    updateResizeHandle();
  } else if (drag.kind === "stroke") {
    const last = drag.points[drag.points.length - 1];
    if (Math.hypot(world.x - last.x, world.y - last.y) > 2 / board.camera.zoom) {
      drag.points.push(world);
      updateLiveStroke(drag.points);
    }
  } else if (drag.kind === "connector") {
    drag.current = world;
    const a = anchorPoint(board, drag.from);
    if (a) {
      const el = dragPreview("connector-preview", "line");
      el.setAttribute("x1", String(a.x));
      el.setAttribute("y1", String(a.y));
      el.setAttribute("x2", String(world.x));
      el.setAttribute("y2", String(world.y));
      el.setAttribute("stroke", "#333333");
      el.setAttribute("stroke-width", "2");
    }
  } else if (drag.kind === "shape") {
    drag.current = world;
    const x0 = Math.min(drag.start.x, world.x), y0 = Math.min(drag.start.y, world.y);
    const w = Math.abs(world.x - drag.start.x), h = Math.abs(world.y - drag.start.y);
    if (drag.shape === "rect") {
      const el = dragPreview("shape-preview", "rect");
      el.setAttribute("x", String(x0)); el.setAttribute("y", String(y0));
      el.setAttribute("width", String(w)); el.setAttribute("height", String(h));
      el.setAttribute("rx", "12");
      el.setAttribute("fill", penColor); el.setAttribute("fill-opacity", "0.85");
    } else if (drag.shape === "ellipse") {
      const el = dragPreview("shape-preview", "ellipse");
      el.setAttribute("cx", String(x0 + w / 2)); el.setAttribute("cy", String(y0 + h / 2));
      el.setAttribute("rx", String(w / 2)); el.setAttribute("ry", String(h / 2));
      el.setAttribute("fill", penColor); el.setAttribute("fill-opacity", "0.85");
    } else {
      const el = dragPreview("shape-preview", "polygon");
      el.setAttribute("points", shapePreviewPoints(drag.shape, x0, y0, w, h));
      el.setAttribute("fill", penColor); el.setAttribute("fill-opacity", "0.85");
    }
  } else if (drag.kind === "rotate") {
    const it = boardGet(board, drag.id);
    if (it) {
      const c = centre(it);
      let deg = Math.atan2(world.y - c.y, world.x - c.x) * 180 / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      const rot = normAngle(deg);
      if (Math.abs(rot - drag.origRot) > 1) drag.moved = true;
      it.rotation = rot;
      const el = cardsEl.querySelector(`[data-id="${drag.id}"]`) as HTMLElement | null;
      if (el) el.style.transform = rot ? `rotate(${rot}deg)` : "";
      // Strokes have no card element to transform live,
      // so rebuild the SVG layer instead: the stroke
      // visibly follows the handle, like a card does.
      if ("Stroke" in it.kind) renderSvgOnly();
      updateResizeHandle();
    }
  } else if (drag.kind === "marquee") {
    drag.current = world;
    const el = dragPreview("marquee-preview", "rect");
    const x0 = Math.min(drag.start.x, world.x), y0 = Math.min(drag.start.y, world.y);
    el.setAttribute("x", String(x0));
    el.setAttribute("y", String(y0));
    el.setAttribute("width", String(Math.abs(world.x - drag.start.x)));
    el.setAttribute("height", String(Math.abs(world.y - drag.start.y)));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", ACCENT);
    el.setAttribute("stroke-width", "1");
  }
});

window.addEventListener("mouseup", (e: MouseEvent) => {
  if (pluginToolDown) {
    pluginToolDown = false;
    const pt = getPluginTool(tool);
    if (pt?.onMouseUp) {
      try { pt.onMouseUp(toWorld(boardPoint(e.clientX, e.clientY))); } catch (err) { toast(`Plugin tool failed: ${String(err)}`); }
    }
    return;
  }
  if (!drag) return;
  const world = toWorld(boardPoint(e.clientX, e.clientY));
  const d = drag;
  drag = null;
  if (d.kind === "stroke") {
    if (d.points.length >= 2) {
      const id = allocId();
      board.items.push({ id, pos: { x: 0, y: 0 }, size: { w: 0, h: 0 }, group: null, kind: { Stroke: { points: d.points, color: penColor, width: 3, marker: false } } });
      const it = boardGet(board, id);
      if (it) {
        const xs = d.points.map((p) => p.x), ys = d.points.map((p) => p.y);
        it.pos = { x: Math.min(...xs), y: Math.min(...ys) };
        it.size = { w: Math.max(1, Math.max(...xs) - it.pos.x), h: Math.max(1, Math.max(...ys) - it.pos.y) };
      }
      save();
    }
  } else if (d.kind === "connector") {
    const to = hitTestWithFrames(board, world);
    const toItem = to !== null ? boardGet(board, to) : null;
    const toAnchorable = toItem && !("Stroke" in toItem.kind) && !("Connector" in toItem.kind);
    const toAnchor: Anchor = toItem && toAnchorable ? { Item: toItem.id } : { Point: world };
    const a = anchorPoint(board, d.from);
    const degenerate = a !== null && "Point" in toAnchor && Math.hypot(a.x - toAnchor.Point.x, a.y - toAnchor.Point.y) < 4;
    // A connector from a card to itself is a click, not a connection:
    // it renders as a 1x1 invisible item that can never be selected
    // or deleted except by undo, and it pollutes the board JSON.
    const selfConnector = "Item" in d.from && "Item" in toAnchor && d.from.Item === toAnchor.Item;
    if (!degenerate && !selfConnector) {
      const id = allocId();
      const aPt = a ?? { x: 0, y: 0 };
      const bPt = "Point" in toAnchor ? toAnchor.Point : (boardGet(board, toAnchor.Item) ? centre(boardGet(board, toAnchor.Item) as Item) : { x: 0, y: 0 });
      board.items.push({ id, pos: { x: Math.min(aPt.x, bPt.x), y: Math.min(aPt.y, bPt.y) }, size: { w: Math.max(1, Math.abs(bPt.x - aPt.x)), h: Math.max(1, Math.abs(bPt.y - aPt.y)) }, group: null, kind: { Connector: { from: d.from, to: toAnchor, color: "#333333" } } });
      save();
    }
  } else if (d.kind === "shape") {
    const w = Math.abs(world.x - d.start.x), h = Math.abs(world.y - d.start.y);
    if (w >= 10 && h >= 10) {
      const id = allocId();
      board.items.push({ id, pos: { x: Math.min(d.start.x, world.x), y: Math.min(d.start.y, world.y) }, size: { w, h }, group: null, kind: { Shape: { shape: d.shape, fill: penColor } } });
      save();
    }
  } else if (d.kind === "rotate") {
    // Apply the final point too: a drag's last mousemove
    // may not be at the mouseup point, so the rotation
    // would otherwise stop one step short of where the
    // user actually released.
    const it = boardGet(board, d.id);
    if (it) {
      const c = centre(it);
      let deg = Math.atan2(world.y - c.y, world.x - c.x) * 180 / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      const rot = normAngle(deg);
      if (Math.abs(rot - d.origRot) > 1) d.moved = true;
      it.rotation = rot;
    }
    if (d.moved) save();
  } else if (d.kind === "marquee") {
    selected = marquee(board, d.start, world);
  } else if (d.kind === "pan") {
    // A Space+drag pan changes only the camera, so it must not
    // become an undo step — but it must reach disk, or closing
    // the window without another save loses the view.
    saveWithoutUndo();
  } else if (d.kind === "move" || d.kind === "resize") {
    // A drag that actually moved is a board change and an undo
    // step. A click that never moved only brought a card to the
    // front: that stacking change still saves to disk, but it
    // must not become an undo step, or every click would take
    // a Ctrl+Z to get past before the real change undoes.
    if (d.moved) save();
    else saveWithoutUndo();
  }
  // A move/resize that actually moved is safe to rebuild once at
  // the end (it refreshes truncation and connector endpoints with
  // their final geometry). A move/resize that never moved was a
  // click, not a drag: rebuilding here would destroy the card
  // button just pressed, so its click would never fire.
  if (d.kind === "stroke" || d.kind === "connector" || d.kind === "marquee" || d.kind === "shape" || (d.kind === "rotate" && d.moved)) {
    render();
  } else if ((d.kind === "move" || d.kind === "resize") && d.moved) {
    render();
  } else {
    updateSelection();
  }
});

window.addEventListener("wheel", (e: WheelEvent) => {
  // A wheel over a plugin panel or a plugin view must scroll
  // that panel or view, not pan the board behind it. The
  // handler below calls preventDefault, so without this guard
  // scrolling the Visual Library panel (or its whiteboard
  // view, which is itself a scroll container) moved the
  // whiteboard and the panel never scrolled. Ctrl/Cmd+wheel
  // over a panel or view is blocked, not zoomed: zooming the
  // board from over a panel is confusing, and in view mode
  // the board is hidden anyway. A wheel over a panel header
  // or search row has no scrollable ancestor — the sections
  // list is the scroller, and the header sits outside it —
  // so scroll that list by hand instead of doing nothing.
  // The command palette is an overlay, not a panel or a
  // view, so it needs its own guard here: without it, a
  // wheel over its list panned the board behind it, and
  // the preventDefault below stopped the list scrolling
  // at all. Over the palette, let the list scroll natively
  // and never pan or zoom the board; Ctrl/Cmd+wheel is
  // still blocked, so it does not zoom the page either.
  if ((e.target as HTMLElement).closest(".cmd-palette")) {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
    return;
  }
  const panelOrView = (e.target as HTMLElement).closest("#plugin-panels, #plugin-view");
  if (panelOrView) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); return; }
    if (panelOrView.closest("#plugin-panels")) {
      const panel = (e.target as HTMLElement).closest(".plugin-panel");
      const sections = panel?.querySelector(".vl-sections") as HTMLElement | null;
      if (sections && !(e.target as HTMLElement).closest(".vl-sections")) {
        sections.scrollTop += e.deltaY;
        e.preventDefault();
      }
    }
    return;
  }
  if ((e.target as HTMLElement).closest("#settings, #toolbar, #title-bar")) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    // Pinch / Ctrl+wheel zoom: accumulate, apply once per
    // frame, rebuild content when the gesture settles and
    // periodically during a long gesture, so cards that
    // come into view appear while zooming, not only after.
    // Sensitivity: 0.003, not 0.0015 — a full trackpad
    // pinch used to give only ~1.35x and felt slow, and a
    // mouse-wheel notch almost nothing. deltaMode is
    // normalised first, so a line-based wheel (deltaY in
    // lines) and a pixel-based trackpad pinch both land
    // on the same scale.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    pendingZoomFactor *= Math.exp(-dy * 0.003);
    pendingZoomAnchor = boardPoint(e.clientX, e.clientY);
    if (zoomFrame === null) {
      zoomFrame = requestAnimationFrame(() => {
        zoomFrame = null;
        if (pendingZoomAnchor && pendingZoomFactor !== 1) {
          zoomAt(pendingZoomAnchor, pendingZoomFactor);
        }
        pendingZoomFactor = 1;
        pendingZoomAnchor = null;
        applyCamera();
        const now = performance.now();
        const ratio = board.camera.zoom / lastZoomRefreshZoom;
        if (now - lastZoomRefreshTime > 250 || ratio > 1.25 || ratio < 0.8) {
          refreshContentIfVisibleChanged();
          lastZoomRefreshZoom = board.camera.zoom;
          lastZoomRefreshTime = now;
        }
      });
    }
    if (zoomSettleTimer) clearTimeout(zoomSettleTimer);
    zoomSettleTimer = setTimeout(() => {
      refreshContentIfVisibleChanged();
      lastZoomRefreshZoom = board.camera.zoom;
      lastZoomRefreshTime = performance.now();
      save();
    }, 120);
    return;
  }
  // Pan follows standard Mac scrolling: scrolling down moves
  // the content up, as in Safari, Notes and every other Mac
  // app. The previous code moved the content with the scroll,
  // which is the opposite of what a Mac trackpad user expects.
  // (Dragging with Space still grabs the paper and moves it
  // with the pointer — that is a grab, not a scroll, and stays.)
  board.camera.x += e.deltaX / board.camera.zoom;
  board.camera.y += e.deltaY / board.camera.zoom;
  // Wheel events fire many times a second; writing the whole board
  // JSON on every tick is the worst save cost for a large board.
  // Save once, 400ms after the last wheel event instead. Content
  // edits still save immediately (move/resize mouseup, note commit),
  // and Close saves explicitly before closing.
  if (wheelSaveTimer) clearTimeout(wheelSaveTimer);
  wheelSaveTimer = setTimeout(() => save(), 400);
  applyCamera();
  refreshContentIfVisibleChanged();
}, { passive: false });

window.addEventListener("resize", () => { applyCamera(); refreshContentIfVisibleChanged(); });
// A media file that is missing shows as a blank card, which
// looks like a rendering bug and tells the user nothing.
// Catch load errors in the capture phase (img/video errors
// do not bubble). First, try once to load the same file as
// a data URL through the main process: if the app-file
// scheme itself is what fails in a given run (files exist
// and open in Preview, but never render in the board),
// the data URL still renders, and the user never sees a
// missing tile for a file that is actually there. Only
// if that also fails is the element swapped for a plain
// tile naming the missing file, so a broken board is
// diagnosable instead of silently blank.
window.addEventListener("error", (e: Event) => {
  const t = e.target as HTMLElement | null;
  if (!t || (t.tagName !== "IMG" && t.tagName !== "VIDEO")) return;
  const el = t as HTMLImageElement | HTMLVideoElement;
  const path = el.dataset?.path;
  if (path && el.dataset?.fallback !== "1") {
    el.dataset.fallback = "1";
    void api.readFileBase64(path).then(({ mime, base64 }) => {
      el.src = `data:${mime};base64,${base64}`;
    }).catch(() => {
      // Fall through to the missing tile below on the
      // next error event, which will have fallback set.
    });
    return;
  }
  const name = el.dataset?.name ?? "media file";
  const div = document.createElement("div");
  div.className = "missing-media";
  div.textContent = `File missing: ${name}`;
  if (t.parentElement) t.parentElement.replaceChild(div, t);
}, true);

// Card button / link clicks (delegated; cards are pointer-events:none
// except these controls, so clicks here never start a board drag).
cardsEl.addEventListener("click", (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const link = target.closest("a[data-url]") as HTMLElement | null;
  if (link) { e.preventDefault(); openExternal(link.dataset.url ?? ""); return; }
  const pbtn = target.closest("[data-plugin-action]") as HTMLElement | null;
  if (pbtn) {
    const pid = Number(pbtn.dataset.id);
    const pit = boardGet(board, pid);
    if (pit && handlePluginCardAction(pbtn.dataset.pluginAction ?? "", pit)) return;
  }
  const btn = target.closest("[data-action]") as HTMLElement | null;
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const action = btn.dataset.action;
  const it = boardGet(board, id);
  if (!it) return;
  if (action === "open-link" && "UrlCard" in it.kind) openExternal(it.kind.UrlCard.url);
  if (action === "play-audio" && "Audio" in it.kind) toggleAudio(id, it.kind.Audio.path);
  if ((action === "pdf-prev" || action === "pdf-next") && "PdfCard" in it.kind) {
    const pdfPath = it.kind.PdfCard.path;
    const docPromise = pdfDocs.get(pdfPath);
    if (!docPromise) return;
    void docPromise.then((doc) => {
      const cur = pdfPages.get(id) ?? 1;
      const nextPage = action === "pdf-prev" ? cur - 1 : cur + 1;
      if (nextPage < 1 || nextPage > doc.numPages) return;
      pdfPages.set(id, nextPage);
      void renderPdfPage(id, pdfPath);
    });
  }

  if (action === "play-video" && "Video" in it.kind) openExternal(it.kind.Video.source);
});

// Audio seek slider (delegated; the slider lives in the card DOM,
// which render() rebuilds, so a direct listener would be lost).
cardsEl.addEventListener("input", (e: Event) => {
  const seek = (e.target as HTMLElement).closest("[data-audio-seek]") as HTMLInputElement | null;
  if (!seek) return;
  const id = Number(seek.dataset.audioSeek);
  if (!audioEl || audioId !== id || !isFinite(audioEl.duration) || audioEl.duration <= 0) return;
  audioEl.currentTime = (Number(seek.value) / 1000) * audioEl.duration;
  updateAudioProgress();
});

function toggleAudio(id: number, path: string): void {
  if (audioId === id && audioEl && !audioEl.paused) {
    audioEl.pause();
    render();
    return;
  }
  if (audioEl) audioEl.pause();
  // If the app-file probe already fell back to a data
  // URL for this file, play from that URL, not the
  // scheme that failed.
  audioEl = new Audio(mediaDataUrls.get(path) ?? api.fileUrl(path));
  audioId = id;
  audioEl.onloadedmetadata = () => {
    if (audioEl && isFinite(audioEl.duration)) audioDurations.set(path, audioEl.duration);
    updateAudioProgress();
  };
  audioEl.ontimeupdate = () => updateAudioProgress();
  audioEl.play().catch((err) => {
    // Do not leave the card saying "Now playing" for a file that
    // failed to load.
    audioId = null;
    toast(`Could not play audio: ${String(err)}`);
    render();
  });
  audioEl.onended = () => { audioId = null; render(); };
  render();
}

// ---------------------------------------------------------------- keyboard

// Find elements one by one on an infinite board: Tab steps through
// the board's elements in board order, selecting each in turn and
// centring the camera on it, so an element far from the current
// view is found without hunting. Shift+Tab steps backwards, and
// the cycle wraps. Pen strokes and connectors are skipped: they
// are drawings and lines, not elements to find. A grouped item
// selects its whole group and centres on the group's bounds.
function navigateElements(dir: 1 | -1): void {
  const navigable = board.items.filter((it) => !("Stroke" in it.kind) && !("Connector" in it.kind));
  if (navigable.length === 0) return;
  let idx = -1;
  if (selected.length === 1) idx = navigable.findIndex((it) => it.id === selected[0]);
  if (idx === -1 && selected.length > 0) {
    const first = navigable.findIndex((it) => selected.includes(it.id));
    if (first !== -1) idx = first;
  }
  const next = idx === -1
    ? (dir === 1 ? 0 : navigable.length - 1)
    : (idx + dir + navigable.length) % navigable.length;
  const target = navigable[next];
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
  save(); render();
}

window.addEventListener("keydown", (e: KeyboardEvent) => {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA") return;
  // Typing in the search box must never trigger board shortcuts:
  // without this, typing "h" would minimise the app, "v" would
  // switch tools, and so on. The search input has its own key
  // handler below, and this window handler stays out of its way.
  if (active && active.id === "search-input") return;
  const ctrl0 = e.ctrlKey || e.metaKey;
  if (ctrl0 && e.key.toLowerCase() === "f") {
    e.preventDefault();
    const input = document.getElementById("search-input") as HTMLInputElement | null;
    if (input) { input.focus(); input.select(); }
    return;
  }
  // Settings open means the board is not listening: without this,
  // Delete deleted the selected card behind the sheet, v/p/a
  // switched tools, and +/- zoomed, all while the user thought
  // they were in Settings. Esc still closes the sheet (handled
  // below), and Tab keeps its normal focus job in the sheet.
  if (settingsOpen && e.key !== "Escape" && e.key !== "Tab") return;
  // Tab cycles elements, unless Settings is open, where Tab keeps
  // its normal job of moving focus around the sheet.
  if (e.key === "Tab" && !settingsOpen) {
    e.preventDefault();
    navigateElements(e.shiftKey ? -1 : 1);
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === " " || e.key === " ") spaceDown = true;
  if (e.key === "?") { setSettings(true); return; }
  if (e.key === "Escape") {
    if (settingsOpen) { setSettings(false); return; }
    // An active search is cleared first; the next Esc clears the
    // selection, as before. Searching must not eat the selection
    // clear entirely, and clearing the selection must not eat a
    // search the user is still looking at.
    const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
    if (searchInput && searchInput.value.trim() !== "") { clearSearch(); return; }
    selected = [];
    render();
    return;
  }
  // Ctrl+Z in a text input is text undo, not board undo: the
  // search box is already guarded above, and this covers plugin
  // inputs like the Visual Library search. Without the guard,
  // Ctrl+Z there would undo a board change instead of the text.
  if (e.key.toLowerCase() === "z" && ctrl && !e.shiftKey && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    undo();
  } else if (e.key.toLowerCase() === "z" && ctrl && e.shiftKey && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    redo();
  } else if (e.key.toLowerCase() === "y" && ctrl && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    redo();
  } else if (e.key.toLowerCase() === "v" && !ctrl) setTool("select");
  else if (e.key.toLowerCase() === "p" && !ctrl) setTool("pen");
  else if (e.key.toLowerCase() === "a" && !ctrl) setTool("connector");
  else if (e.key.toLowerCase() === "r" && !ctrl) setTool("rect");
  else if (e.key.toLowerCase() === "e" && !ctrl) setTool("ellipse");
  else if (e.key === "[" && !ctrl) rotateSelected(-15);
  else if (e.key === "]" && !ctrl) rotateSelected(15);
  else if (e.key.toLowerCase() === "g" && ctrl) {
    e.preventDefault();
    groupSelected();
  } else if (e.key.toLowerCase() === "u" && ctrl) {
    e.preventDefault();
    ungroupSelected();
  } else if (e.key === "Backspace" || e.key === "Delete") {
    deleteSelected();
  } else if (e.key === "+" || e.key === "=") { zoomCentre(1.2); save(); render(); }
  else if (e.key === "-") { zoomCentre(1 / 1.2); save(); render(); }
  else if (e.key === "0") { board.camera = { x: 0, y: 0, zoom: 1 }; save(); render(); }
  // Plugin shortcuts, last: core keys above win, so a plugin cannot
  // steal V, P, A, Ctrl+G/U, Delete, zoom or reset. The core guards
  // above (textarea, search box, Settings open) already applied.
  else if (editingId === null && !settingsOpen && !ctrl && handlePluginShortcut(e.key)) { /* plugin handled it */ }
});
window.addEventListener("keyup", (e: KeyboardEvent) => {
  if (e.key === " ") spaceDown = false;
});

// ---------------------------------------------------------------- toolbar

document.getElementById("tool-select")?.addEventListener("click", () => setTool("select"));
document.getElementById("tool-pen")?.addEventListener("click", () => setTool("pen"));
document.getElementById("tool-connector")?.addEventListener("click", () => setTool("connector"));
document.getElementById("tool-shape")?.addEventListener("click", () => {
  const btn = document.getElementById("tool-shape") as HTMLButtonElement | null;
  const last = btn?.dataset.shape ?? "rect";
  setTool(isShapeTool(last) ? last : "rect");
});
document.getElementById("zoom-in")?.addEventListener("click", () => { zoomCentre(1.2); save(); render(); });
document.getElementById("zoom-out")?.addEventListener("click", () => { zoomCentre(1 / 1.2); save(); render(); });
document.getElementById("btn-delete")?.addEventListener("click", () => {
  deleteSelected();
});
document.getElementById("btn-undo")?.addEventListener("click", () => { undo(); });
document.getElementById("btn-redo")?.addEventListener("click", () => { redo(); });

// ---------------------------------------------------------------- context search
// Local ML index, keyed by media path, persisted next to
// the board in context-index.json so a board that is
// already indexed does not re-run the models.
// - Image: one CLIP embedding (512 floats).
// - Video: CLIP embeddings of sampled frames, plus audio
//   labels if the video file decodes as audio.
// - Audio: AST labels, e.g. "Bird vocalization, bird
//   call, bird song" — searching "bird" matches them.
// Indexing runs in parallel (up to 4 items at once, so
// CLIP and AST load together instead of one after the
// other), and the index is preloaded at board load, so
// a search never pays the index-load cost. Until an item
// is indexed, search falls back to its filename and
// type, as before. The search count only ever says
// "Indexing" while unindexed media is actually being
// indexed — never on a search where everything is
// already indexed, which was the old misleading status.
// Query embeddings are also persisted (as __query:
// entries in the same file), so a repeated word after
// restart does not need the CLIP model at all.
type ContextEntry = { embedding?: number[]; frames?: number[][]; labels?: string[] };
const contextIndex = new Map<string, ContextEntry>();
let contextIndexLoaded = false;
let contextIndexing = false;
let contextIndexTotal = 0;
let contextIndexDone = 0;
let contextIndexFailed = false;
let contextQueryEmbedding: { query: string; embedding: number[] } | null = null;
const contextQueryCache = new Map<string, number[]>();
async function loadContextIndex(): Promise<void> {
  if (contextIndexLoaded) return;
  contextIndexLoaded = true;
  try {
    const raw = await api.contextIndexLoad();
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("__query:")) {
        const e = v as ContextEntry;
        if (e && Array.isArray(e.embedding)) contextQueryCache.set(k.slice("__query:".length), e.embedding);
        continue;
      }
      const e = v as ContextEntry;
      if (e && (Array.isArray(e.embedding) || Array.isArray(e.frames) || Array.isArray(e.labels))) contextIndex.set(k, e);
    }
  } catch { /* no saved index yet */ }
}
// Context-index saves used to rewrite the whole index
// (every 512-float CLIP embedding) after every single
// indexed item, and on every new query word — O(N^2)
// bytes for a media-heavy board, each write blocking
// the main process. Now saves are debounced to 1s, and
// flushed at batch end and before a board switch; the
// in-memory maps are the source of truth during the
// session, so a delayed write loses nothing.
let contextIndexSaveTimer: ReturnType<typeof setTimeout> | undefined;
function doSaveContextIndex(): void {
  const obj: Record<string, ContextEntry> = {};
  for (const [k, v] of contextIndex.entries()) obj[k] = v;
  for (const [q, embedding] of contextQueryCache.entries()) obj[`__query:${q}`] = { embedding };
  void api.contextIndexSave(obj).catch(() => undefined);
}
function saveContextIndex(): void {
  if (contextIndexSaveTimer) return;
  contextIndexSaveTimer = setTimeout(() => { contextIndexSaveTimer = undefined; doSaveContextIndex(); }, 1000);
}
function flushContextIndex(): void {
  if (!contextIndexSaveTimer) return;
  clearTimeout(contextIndexSaveTimer);
  contextIndexSaveTimer = undefined;
  doSaveContextIndex();
}
function cancelContextIndexSave(): void {
  if (!contextIndexSaveTimer) return;
  clearTimeout(contextIndexSaveTimer);
  contextIndexSaveTimer = undefined;
}
window.addEventListener("beforeunload", () => { flushContextIndex(); });
async function getQueryEmbedding(query: string): Promise<number[] | null> {
  if (contextQueryEmbedding && contextQueryEmbedding.query === query) return contextQueryEmbedding.embedding;
  const cached = contextQueryCache.get(query);
  if (cached) {
    contextQueryEmbedding = { query, embedding: cached };
    return cached;
  }
  try {
    const embedding = await api.contextEmbedText(`a photo of ${query}`);
    contextQueryEmbedding = { query, embedding };
    contextQueryCache.set(query, embedding);
    saveContextIndex();
    return embedding;
  } catch { return null; }
}
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
async function decodeAudio16k(fileUrl: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(buf);
      const targetRate = 16000;
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
      const src = offline.createBufferSource();
      src.buffer = decoded;
      src.connect(offline.destination);
      src.start();
      const rendered = await offline.startRendering();
      const data = rendered.getChannelData(0);
      // AST's input window is 10 seconds: decoding more
      // than that only costs time, IPC size and inference
      // time, and the model never sees it.
      const maxSamples = targetRate * 10;
      return data.length > maxSamples ? data.slice(0, maxSamples) : data;
    } finally {
      void ctx.close().catch(() => undefined);
    }
  } catch { return null; }
}
async function captureVideoFrames(source: string): Promise<string[]> {
  const urls: string[] = [];
  try {
    const video = document.createElement("video");
    video.src = api.fileUrl(source);
    video.muted = true;
    video.preload = "auto";
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => resolve();
      setTimeout(resolve, 5000);
    });
    if (!isFinite(video.duration) || video.duration <= 0) return urls;
    const times = [Math.min(1, video.duration * 0.25), video.duration * 0.5, video.duration * 0.75];
    const canvas = document.createElement("canvas");
    canvas.width = 224; canvas.height = 224;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return urls;
    for (const t of times) {
      try {
        video.currentTime = t;
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
          setTimeout(resolve, 2000);
        });
        ctx2d.drawImage(video, 0, 0, 224, 224);
        urls.push(canvas.toDataURL("image/jpeg", 0.8));
      } catch { /* skip this frame */ }
    }
  } catch { /* video frames are a bonus, not a failure */ }
  return urls;
}
async function indexContextItem(item: Item): Promise<void> {
  const k = item.kind;
  try {
    if ("Image" in k) {
      if (contextIndex.get(k.Image.path)?.embedding) return;
      const embedding = await api.contextEmbedImage(k.Image.path);
      contextIndex.set(k.Image.path, { embedding });
    } else if ("Audio" in k) {
      if (contextIndex.get(k.Audio.path)?.labels) return;
      const pcm = await decodeAudio16k(api.fileUrl(k.Audio.path));
      if (!pcm) return;
      const out = await api.contextClassifyAudio(pcm);
      const labels = out.map((o) => o.label.toLowerCase());
      contextIndex.set(k.Audio.path, { labels });
    } else if ("Video" in k && !k.Video.remote) {
      const existing = contextIndex.get(k.Video.source);
      if (existing?.frames) return;
      const frameUrls = await captureVideoFrames(k.Video.source);
      const frames: number[][] = (await Promise.all(frameUrls.map(async (url) => {
        try { return await api.contextEmbedFrame(url); } catch { return null; }
      }))).filter((f): f is number[] => f !== null);
      const labels: string[] = [];
      const pcm = await decodeAudio16k(api.fileUrl(k.Video.source));
      if (pcm) {
        try {
          const out = await api.contextClassifyAudio(pcm);
          labels.push(...out.map((o) => o.label.toLowerCase()));
        } catch { /* visual frames alone are enough */ }
      }
      if (frames.length > 0 || labels.length > 0) contextIndex.set(k.Video.source, { frames, labels });
    } else {
      return;
    }
    saveContextIndex();
  } catch {
    // One failed item must not stop the rest, and must
    // not break ordinary search — but it must be visible,
    // otherwise context search silently does nothing (e.g.
    // sharp's install script was skipped on a Mac, so
    // image indexing fails on every item).
    contextIndexFailed = true;
  }
}
function hasUnindexedMedia(): boolean {
  return board.items.some((it) => {
    if ("Image" in it.kind) return !contextIndex.get(it.kind.Image.path)?.embedding;
    if ("Audio" in it.kind) return !contextIndex.get(it.kind.Audio.path)?.labels;
    if ("Video" in it.kind && !it.kind.Video.remote) {
      const e = contextIndex.get(it.kind.Video.source);
      return !(e?.frames || e?.labels);
    }
    return false;
  });
}
async function startContextIndexing(): Promise<void> {
  if (contextIndexing) return;
  await loadContextIndex();
  // Only ever show "Indexing" when there is actually
  // unindexed media. Previously this flag was set on
  // every search, before the already-indexed check, so
  // every search flashed "Indexing context…" even
  // though nothing was being indexed — which is why
  // it looked like it reindexed all the time.
  if (!hasUnindexedMedia()) return;
  contextIndexing = true;
  // Refresh the count now that indexing is really
  // running, so the status appears during the model
  // load itself, not only after the first item lands.
  {
    const input = document.getElementById("search-input") as HTMLInputElement | null;
    if (input && input.value.trim() !== "") updateSearch();
  }
  contextIndexFailed = false;
  const isUnindexed = (it: Item): boolean => {
    const k = it.kind;
    if ("Image" in k) return !contextIndex.get(k.Image.path)?.embedding;
    if ("Audio" in k) return !contextIndex.get(k.Audio.path)?.labels;
    if ("Video" in k && !k.Video.remote) {
      const e = contextIndex.get(k.Video.source);
      return !(e?.frames || e?.labels);
    }
    return false;
  };
  const items = board.items.filter(isUnindexed);
  contextIndexTotal = items.length;
  contextIndexDone = 0;
  // Parallel, capped at 4 at once: CLIP and AST load
  // together, and image/audio/video decoding overlaps,
  // instead of everything queuing behind one model
  // load. For the 3-item welcome board this is roughly
  // the slowest single item, not the sum of all three.
  let next = 0;
  const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const it = items[next++];
      try { await indexContextItem(it); } catch { contextIndexFailed = true; }
      contextIndexDone++;
      const input = document.getElementById("search-input") as HTMLInputElement | null;
      if (input && input.value.trim() !== "") updateSearch();
    }
  });
  await Promise.all(workers);
  contextIndexing = false;
  flushContextIndex();
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (input && input.value.trim() !== "") updateSearch();
}
async function contextMatches(item: Item, query: string, words: string[]): Promise<boolean> {
  const k = item.kind;
  if ("Image" in k) {
    const e = contextIndex.get(k.Image.path)?.embedding;
    if (!e) return false;
    const qe = await getQueryEmbedding(query);
    if (!qe) return false;
    return cosineSim(e, qe) >= 0.23;
  }
  if ("Video" in k && !k.Video.remote) {
    const entry = contextIndex.get(k.Video.source);
    if (entry?.labels && words.every((w) => entry.labels!.join(" ").includes(w))) return true;
    if (!entry?.frames || entry.frames.length === 0) return false;
    const qe = await getQueryEmbedding(query);
    if (!qe) return false;
    return entry.frames.some((f) => cosineSim(f, qe) >= 0.23);
  }
  if ("Audio" in k) {
    const labels = contextIndex.get(k.Audio.path)?.labels;
    if (!labels) return false;
    const joined = labels.join(" ");
    return words.every((w) => joined.includes(w));
  }
  return false;
}

// ---------------------------------------------------------------- search

// Search normalisation: separators become spaces, so
// "welcome bower" matches "welcome-bower.jpg", and a
// query is split into words that must all match (AND),
// so "bird song" finds the bird audio, not everything
// containing either word.
// Colour names: a swatch's hex is expanded to its plain
// colour name, so "blue" finds #007AFF and "orange"
// finds the orange swatch, not just a hex string.
// Type words: every kind carries its plain type words,
// so "image", "audio", "video", "pdf", "link", "text"
// and "color" find all cards of that kind, not just
// cards whose filename happens to contain the word.
function normaliseSearch(s: string): string {
  // Diacritics first (café -> cafe, like Omnisearch),
  // then separators become spaces.
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").replace(/\s+/g, " ").trim();
}
function colorNameForHex(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : l < 0.5 ? (max - min) / (max + min) : (max - min) / (2 - max - min);
  if (l < 0.15) return "black";
  if (l > 0.92) return "white";
  if (s < 0.15) return "grey gray";
  let h = 0;
  if (max === r) h = ((g - b) / (max - min) + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / (max - min) + 2) * 60;
  else h = ((r - g) / (max - min) + 4) * 60;
  if (h >= 345 || h < 12) return l < 0.45 ? "red brown" : "red pink";
  if (h < 45) return l < 0.55 && s > 0.3 ? "orange brown" : "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "cyan teal blue";
  if (h < 260) return "blue";
  if (h < 300) return "purple violet";
  if (h < 330) return "pink purple";
  return "pink red";
}
// ---------------------------------------------------------------- Omnisearch-style search
// Omnisearch (Obsidian) is MiniSearch with BM25 scoring:
// filename boosted over headings over body, typo-tolerant
// fuzzy matching, prefix matching, results as you type in
// a ranked list with excerpts, keyboard-first, and a query
// language of "exact phrases", -exclusions and .ext filters.
// Bowerbird uses the same engine (MiniSearch, zero
// dependencies) with the same weights, and maps Obsidian's
// fields onto cards: filename -> card title/filename,
// headings -> text-card headings, body -> card text, PDF
// text, link description, colour name, and audio labels.
// What does not map: Obsidian's path: filter (a board
// has no folders), backlinks, and in-file search (cards
// are short; jumping to the card is the in-file view).
type SearchDoc = { id: number; title: string; headings: string; body: string; typeLabel: string; excerptText: string; ext: string };
function searchDoc(item: Item): SearchDoc | null {
  const k = item.kind;
  const fileName = (p: string) => p.split("/").pop() ?? p;
  const extOf = (p: string) => { const n = fileName(p); return n.includes(".") ? (n.split(".").pop() ?? "").toLowerCase() : ""; };
  const labels = (p: string) => contextIndex.get(p)?.labels ?? [];
  if ("Text" in k) {
    const lines = k.Text.text.split("\n");
    const headings = lines.filter((l) => l.trim().startsWith("#")).map((l) => l.replace(/^#+\s*/, "")).join(" ");
    const title = lines.map((l) => l.trim()).find((l) => l !== "")?.replace(/^#+\s*/, "") ?? "Note";
    const excerptText = lines.map((l) => l.replace(/^#+\s*/, "")).join("\n");
    const bgName = k.Text.bg && k.Text.bg.toUpperCase() !== "#FFFFFF" ? colorNameForHex(k.Text.bg) : "";
    return { id: item.id, title, headings, body: `${k.Text.text} ${bgName}`, typeLabel: "Note", excerptText, ext: "md" };
  }
  if ("Shape" in k) {
    const name = colorNameForHex(k.Shape.fill).split(" ")[0];
    const label = shapeLabel(k.Shape.shape);
    return { id: item.id, title: `${name} ${label}`, headings: "", body: `${k.Shape.shape} ${label} shape ${k.Shape.fill} ${colorNameForHex(k.Shape.fill)} color colour`, typeLabel: "Shape", excerptText: `${name} ${label}`, ext: "" };
  }
  if ("UrlCard" in k) {
    let domain = "";
    try { domain = new URL(k.UrlCard.url).hostname.replace(/^www\./, ""); } catch { /* keep empty */ }
    const title = k.UrlCard.title ?? domain ?? k.UrlCard.url;
    // Excerpt is the description only: the title is
    // already the row's title, so repeating it in the
    // excerpt would duplicate the first line.
    return { id: item.id, title, headings: "", body: [k.UrlCard.title ?? "", k.UrlCard.description ?? "", k.UrlCard.url, domain, "link"].join(" "), typeLabel: "Link", excerptText: k.UrlCard.description ?? "", ext: "" };
  }
  if ("Image" in k) return { id: item.id, title: fileName(k.Image.path), headings: "", body: `${fileName(k.Image.path)} image picture photo`, typeLabel: "Image", excerptText: fileName(k.Image.path), ext: extOf(k.Image.path) };
  if ("PdfCard" in k) {
    indexPdfForSearch(k.PdfCard.path);
    const pdfText = pdfSearchText.get(k.PdfCard.path) ?? "";
    return { id: item.id, title: fileName(k.PdfCard.path), headings: "", body: `${fileName(k.PdfCard.path)} pdf document ${pdfText}`, typeLabel: "PDF", excerptText: pdfText || fileName(k.PdfCard.path), ext: "pdf" };
  }
  if ("Audio" in k) {
    const lab = labels(k.Audio.path).join(" ");
    return { id: item.id, title: fileName(k.Audio.path), headings: "", body: `${fileName(k.Audio.path)} audio sound music ${lab}`, typeLabel: "Audio", excerptText: lab, ext: extOf(k.Audio.path) };
  }
  if ("Video" in k) {
    if (k.Video.remote) return { id: item.id, title: k.Video.source, headings: "", body: `${k.Video.source} video remote link`, typeLabel: "Video", excerptText: "", ext: "" };
    const lab = labels(k.Video.source).join(" ");
    return { id: item.id, title: fileName(k.Video.source), headings: "", body: `${fileName(k.Video.source)} video ${lab}`, typeLabel: "Video", excerptText: lab, ext: extOf(k.Video.source) };
  }
  if ("Swatch" in k) {
    const name = colorNameForHex(k.Swatch.hex).split(" ")[0];
    return { id: item.id, title: name, headings: "", body: `${k.Swatch.hex} ${colorNameForHex(k.Swatch.hex)} color colour swatch`, typeLabel: "Colour", excerptText: `${name} ${k.Swatch.hex}`, ext: "" };
  }
  if ("Plugin" in k) {
    const pt = getPluginCardSearchText(item);
    return { id: item.id, title: k.Plugin.kind, headings: "", body: pt ?? `${k.Plugin.plugin} ${k.Plugin.kind}`, typeLabel: "Plugin", excerptText: pt ?? k.Plugin.kind, ext: "" };
  }
  return null;
}
type ParsedQuery = { terms: string[]; phrases: string[]; exclusions: string[]; exts: string[] };
function parseSearchQuery(raw: string): ParsedQuery {
  const phrases: string[] = [];
  const exclusions: string[] = [];
  const exts: string[] = [];
  // Excluded phrases first, so -"foo bar" is not read as a phrase.
  let s = raw.replace(/-\s*"([^"]+)"/g, (_m, p) => { exclusions.push(normaliseSearch(p)); return " "; });
  s = s.replace(/"([^"]+)"/g, (_m, p) => { const n = normaliseSearch(p); if (n) phrases.push(n); return " "; });
  s = s.replace(/-\s*([^\s]+)/g, (_m, t) => { const n = normaliseSearch(t); if (n) exclusions.push(n); return " "; });
  s = s.replace(/(^|\s)\.(jpg|jpeg|png|gif|webp|mp3|wav|mp4|mov|pdf|md)\b/gi, (_m, _sp, e) => { exts.push(e.toLowerCase()); return " "; });
  const terms = normaliseSearch(s).split(" ").filter((w) => w !== "");
  return { terms, phrases: phrases.filter(Boolean), exclusions: exclusions.filter(Boolean), exts };
}
function splitCamel(s: string): string {
  // Omnisearch's tokenizer splits CamelCase: Bowerbird
  // becomes Bower + bird, so "bird" finds it. Keep the
  // full word too, so "bowerbird" still matches.
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}
function docPassesFilters(doc: SearchDoc, q: ParsedQuery): boolean {
  if (q.exts.length > 0 && !q.exts.includes(doc.ext)) return false;
  const hay = normaliseSearch([doc.title, doc.headings, doc.body, splitCamel(doc.title), splitCamel(doc.headings), splitCamel(doc.body)].join(" "));
  for (const p of q.phrases) if (!hay.includes(p)) return false;
  for (const e of q.exclusions) {
    // Exclusion is prefix-based for single words: -bird
    // removes birdsong, but keeps Bowerbird (bird is
    // not at the start of that word). Phrases exclude
    // on an exact substring, as they are quoted.
    if (e.includes(" ")) { if (hay.includes(e)) return false; }
    else if (hay.split(" ").some((w) => w.startsWith(e))) return false;
  }
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
let searchDocsCache: { version: number; docs: SearchDoc[]; ms: MiniSearch<SearchDoc> } | null = null;
function buildMiniSearch(docs: SearchDoc[]): MiniSearch<SearchDoc> {
  const ms = new MiniSearch<SearchDoc>({
    fields: ["title", "headings", "body"],
    storeFields: ["id"],
    searchOptions: { boost: { title: 3, headings: 2, body: 1 }, fuzzy: 0.2, prefix: true, combineWith: "AND" },
  });
  // Feed MiniSearch already-normalised text, so its
  // tokenizer sees the same diacritic-free words the
  // rest of Bowerbird search uses, plus CamelCase splits.
  ms.addAll(docs.map((d) => ({
    ...d,
    title: normaliseSearch(`${d.title} ${splitCamel(d.title)}`),
    headings: normaliseSearch(`${d.headings} ${splitCamel(d.headings)}`),
    body: normaliseSearch(`${d.body} ${splitCamel(d.body)}`),
  })));
  return ms;
}
function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// Excerpt: ~40 chars before the first matched term, ~80
// after, with matched terms in <strong>. Diacritics are
// stripped for finding the position, but the snippet
// itself is cut from the original text.
function excerptFor(doc: SearchDoc, matchedTerms: string[]): string {
  const text = doc.excerptText;
  if (!text) return doc.title;
  const stripped = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  let pos = -1;
  for (const t of matchedTerms) {
    const p = stripped.indexOf(t.toLowerCase());
    if (p >= 0 && (pos === -1 || p < pos)) pos = p;
  }
  const start = pos === -1 ? 0 : Math.max(0, pos - 40);
  const end = pos === -1 ? Math.min(text.length, 120) : Math.min(text.length, pos + 80);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  let html = escapeHtml(snippet);
  const terms = [...new Set(matchedTerms.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (terms.length > 0) {
    const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
    html = html.replace(re, "<strong>$1</strong>");
  }
  return html;
}
type SearchRow = { id: number; title: string; typeLabel: string; excerptHtml: string; isContext: boolean };
let searchRows: SearchRow[] = [];
let searchResultsOpen = false;
function renderSearchResults(): void {
  const box = document.getElementById("search-results") as HTMLElement | null;
  if (!box) return;
  if (!searchResultsOpen || searchRows.length === 0) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = searchRows.slice(0, 30).map((r, i) => {
    const sel = i === searchIndex ? " search-result-selected" : "";
    // No excerpt line when it would just repeat the
    // title (a filename-only image, a link with no
    // description, a video with no labels): a row with
    // the same text twice reads like a bug, not a result.
    const plain = r.excerptHtml.replace(/<[^>]+>/g, "").trim();
    const excerpt = plain && plain !== r.title ? `<div class="search-result-excerpt">${r.excerptHtml}</div>` : "";
    return `<div class="search-result${sel}" data-id="${r.id}" data-index="${i}"><div class="search-result-top"><span class="search-result-type">${escapeHtml(r.typeLabel)}${r.isContext ? " · Visual" : ""}</span><span class="search-result-title">${escapeHtml(r.title)}</span></div>${excerpt}</div>`;
  }).join("");
  const selected = box.querySelector(".search-result-selected") as HTMLElement | null;
  selected?.scrollIntoView({ block: "nearest" });
}
function closeSearchResults(): void {
  searchResultsOpen = false;
  renderSearchResults();
}

let searchGeneration = 0;
function applySearchMatches(countEl: HTMLElement): void {
  if (searchIndex >= searchMatches.length) searchIndex = -1;
  const matchSet = new Set(searchMatches);
  for (const child of Array.from(cardsEl.children)) {
    const el = child as HTMLElement;
    const id = Number(el.dataset.id);
    el.classList.toggle("search-match", matchSet.has(id));
    el.classList.toggle("search-dim", !matchSet.has(id));
  }
  let text = "";
  if (searchMatches.length === 0) text = "No matches";
  // While the results list is open, the selection is
  // just the top result, not a jump — show the count,
  // not "1 of N". After a jump (list closed), show position.
  else if (searchIndex >= 0 && !searchResultsOpen) text = `${searchIndex + 1} of ${searchMatches.length}`;
  else text = searchMatches.length === 1 ? "1 match" : `${searchMatches.length} matches`;
  if (contextIndexing) text += contextIndexTotal > 0 ? ` · Indexing context ${contextIndexDone}/${contextIndexTotal}` : " · Indexing context…";
  else if (contextIndexFailed) text += " · Context unavailable";
  countEl.textContent = text;
}
function updateSearch(): void {
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  const countEl = document.getElementById("search-count") as HTMLSpanElement | null;
  const clearEl = document.getElementById("search-clear") as HTMLButtonElement | null;
  if (!input || !countEl || !clearEl) return;
  const raw = input.value;
  const query = normaliseSearch(raw);
  clearEl.style.display = query === "" ? "none" : "flex";
  if (query === "") {
    const hadMatches = searchMatches.length > 0;
    searchMatches = [];
    searchRows = [];
    searchIndex = -1;
    closeSearchResults();
    countEl.textContent = "";
    if (!hadMatches) return;
    for (const child of Array.from(cardsEl.children)) {
      (child as HTMLElement).classList.remove("search-match", "search-dim");
    }
    return;
  }
  const parsed = parseSearchQuery(raw);
  let docs: SearchDoc[];
  let ms: MiniSearch<SearchDoc>;
  if (searchDocsCache && searchDocsCache.version === boardSearchVersion) {
    docs = searchDocsCache.docs;
    ms = searchDocsCache.ms;
  } else {
    docs = board.items.map(searchDoc).filter((d): d is SearchDoc => d !== null);
    ms = buildMiniSearch(docs);
    searchDocsCache = { version: boardSearchVersion, docs, ms };
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  let results: { id: number; terms: string[] }[];
  if (parsed.terms.length === 0) {
    // Phrase / filter only: no BM25 terms, so rank by
    // board order among cards passing the filters.
    results = docs.filter((d) => docPassesFilters(d, parsed)).map((d) => ({ id: d.id, terms: parsed.phrases.flatMap((p) => p.split(" ")) }));
  } else {
    results = ms.search(parsed.terms.join(" "))
      .map((r) => ({ id: Number(r.id), terms: r.terms }))
      .filter((r) => { const d = byId.get(r.id); return d ? docPassesFilters(d, parsed) : false; });
  }
  searchMatches = results.map((r) => r.id);
  // Excerpts are only ever shown for the first 30 rows
  // (renderSearchResults slices there); building them
  // for every match, with a regex per row, was pure
  // waste on a many-match query. Later rows carry the
  // title, which render omits as a duplicate excerpt.
  searchRows = results.map((r, i) => {
    const d = byId.get(r.id)!;
    return { id: r.id, title: d.title, typeLabel: d.typeLabel, excerptHtml: i < 30 ? excerptFor(d, r.terms) : d.title, isContext: false };
  });
  if (searchIndex >= searchMatches.length) searchIndex = searchMatches.length > 0 ? 0 : -1;
  searchResultsOpen = searchMatches.length > 0;
  renderSearchResults();
  applySearchMatches(countEl);
  // Context search, in the background: index media that
  // is not indexed yet, then check the rest of the board
  // against the query's CLIP embedding / audio labels.
  // Results merge in as they arrive; a stale query (the
  // user kept typing) discards its own context results.
  const gen = ++searchGeneration;
  void startContextIndexing();
  applySearchMatches(countEl);
  void (async () => {
    // Wait for indexing to finish, then check context.
    // startContextIndexing is already running above; this
    // waits for it by polling its flag, so a new search
    // (new generation) supersedes this one cleanly.
    while (contextIndexing) await new Promise((r) => setTimeout(r, 200));
    if (gen !== searchGeneration) return;
    const inputNow = document.getElementById("search-input") as HTMLInputElement | null;
    if (!inputNow || normaliseSearch(inputNow.value) !== query) return;
    const extra: number[] = [];
    const contextQuery = [...parsed.terms, ...parsed.phrases].join(" ");
    const matchSet = new Set(searchMatches);
    for (const it of board.items) {
      if (("Stroke" in it.kind) || ("Connector" in it.kind)) continue;
      if (matchSet.has(it.id)) continue;
      if (await contextMatches(it, contextQuery, parsed.terms)) extra.push(it.id);
    }
    if (gen !== searchGeneration) return;
    if (extra.length > 0) {
      searchMatches = [...searchMatches, ...extra];
      const byId2 = new Map(docs.map((d) => [d.id, d]));
      for (const id of extra) {
        const d = byId2.get(id);
        if (!d) continue;
        searchRows.push({ id, title: d.title, typeLabel: d.typeLabel, excerptHtml: excerptFor(d, parsed.terms), isContext: true });
      }
      if (searchIndex < 0 && searchMatches.length > 0) searchIndex = 0;
      searchResultsOpen = true;
      renderSearchResults();
    }
    // Always refresh the count, even with no extra matches:
    // otherwise the "Indexing context…" text stays stuck
    // after indexing finishes with nothing new to add.
    const countNow = document.getElementById("search-count") as HTMLElement | null;
    if (countNow) applySearchMatches(countNow);
  })().catch(() => { contextIndexFailed = true; });
}

function clearSearch(): void {
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (input) input.value = "";
  searchMatches = [];
  searchRows = [];
  searchIndex = -1;
  closeSearchResults();
  updateSearch();
}

function jumpToSearchIndex(idx: number): void {
  if (searchMatches.length === 0) return;
  searchIndex = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
  const target = boardGet(board, searchMatches[searchIndex]);
  if (!target) return;
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
  save();
  render();
}

// Search input is debounced 150 ms: without it, every
// keystroke rebuilt the search documents and index.
// Enter flushes immediately, so it still opens the
// top result for the text just typed, not a stale one.
let searchInputTimer: ReturnType<typeof setTimeout> | undefined;
document.getElementById("search-input")?.addEventListener("input", () => {
  // A new query selects the top-ranked result, like
  // Omnisearch: Enter opens it, arrows move selection.
  searchIndex = 0;
  if (searchInputTimer) clearTimeout(searchInputTimer);
  searchInputTimer = setTimeout(() => { searchInputTimer = undefined; updateSearch(); }, 150);
});
document.getElementById("search-input")?.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    // A debounced search may not have run yet for the
    // text just typed: run it now, so Enter opens the
    // top result for that text, not a stale list.
    if (searchInputTimer) { clearTimeout(searchInputTimer); searchInputTimer = undefined; updateSearch(); }
    if (searchResultsOpen) {
      // List open: open the selected result, close list.
      jumpToSearchIndex(e.shiftKey ? searchIndex - 1 : searchIndex);
      closeSearchResults();
      const countEl = document.getElementById("search-count") as HTMLElement | null;
      if (countEl) applySearchMatches(countEl);
    } else {
      // List closed (after a jump): cycle, as before.
      jumpToSearchIndex(searchIndex + (e.shiftKey ? -1 : 1));
      const countEl = document.getElementById("search-count") as HTMLElement | null;
      if (countEl) applySearchMatches(countEl);
    }
  } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) {
    // Omnisearch supports Vim Ctrl+j/k as well as arrows.
    e.preventDefault();
    if (searchMatches.length === 0) return;
    searchIndex = (searchIndex + 1) % searchMatches.length;
    renderSearchResults();
  } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) {
    e.preventDefault();
    if (searchMatches.length === 0) return;
    searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
    renderSearchResults();
  } else if (e.key === "Escape") {
    e.preventDefault();
    clearSearch();
    (e.target as HTMLInputElement).blur();
  }
});
document.getElementById("search-input")?.addEventListener("blur", () => {
  // Delay so a mousedown on a result lands first.
  setTimeout(() => closeSearchResults(), 150);
});
document.getElementById("search-results")?.addEventListener("mousedown", (e: MouseEvent) => {
  const row = (e.target as HTMLElement).closest(".search-result") as HTMLElement | null;
  if (!row) return;
  e.preventDefault();
  const idx = Number(row.dataset.index ?? "0");
  jumpToSearchIndex(idx);
  closeSearchResults();
  const countEl = document.getElementById("search-count") as HTMLElement | null;
  if (countEl) applySearchMatches(countEl);
});
document.getElementById("search-clear")?.addEventListener("click", () => {
  clearSearch();
  document.getElementById("search-input")?.focus();
});

// Window controls: the window is frameless, so these
// are the only window controls, and they are drawn the
// way the OS the app is running on draws them — macOS
// traffic lights on the left, Windows caption buttons
// on the right, GNOME-style round buttons on the right
// on Linux (see the per-platform CSS). The platform
// comes from the preload bridge, with a user-agent
// fallback for a renderer that predates it, and the
// group is moved to the right-hand actions only on
// non-macOS platforms; on macOS it stays where the
// HTML puts it, at the far left. Close quits the app
// (the old Settings Quit button did exactly this:
// commit, save, then api.quit, which destroys the peek
// window too), minimise minimises, full screen toggles
// full screen on macOS, maximise toggles maximise on
// Windows/Linux. The buttons opt out of the title
// bar's drag region in CSS, so a click acts instead
// of moving the window.
const osPlatform = ((): "darwin" | "win32" | "linux" => {
  const p = typeof api.platform === "string" ? api.platform : "";
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  if (ua === "macOS") return "darwin";
  if (ua === "Windows") return "win32";
  return "linux";
})();
document.body.classList.add(`platform-${osPlatform}`);
if (osPlatform !== "darwin") {
  const controls = document.getElementById("window-controls");
  const actions = document.getElementById("title-bar-actions");
  if (controls && actions) actions.appendChild(controls);
}
const syncWindowState = async () => {
  try {
    const state = await api.windowState();
    document.getElementById("win-maximise")?.classList.toggle("is-maximised", state.maximised);
    document.getElementById("win-fullscreen")?.classList.toggle("is-fullscreen", state.fullscreen);
  } catch { /* icons keep their last state */ }
};
document.getElementById("win-close")?.addEventListener("click", async () => {
  commitEditingIfAny();
  if (!DEMO) { try { await api.saveBoard(JSON.stringify(board)); } catch { /* closing anyway */ } }
  api.quit().catch(() => undefined);
});
document.getElementById("win-minimise")?.addEventListener("click", () => {
  api.minimise().catch(() => undefined);
});
document.getElementById("win-fullscreen")?.addEventListener("click", async () => {
  try {
    const fullscreen = await api.fullscreen();
    document.getElementById("win-fullscreen")?.classList.toggle("is-fullscreen", fullscreen);
  } catch { /* state sync on resize will correct the icon */ }
});
document.getElementById("win-maximise")?.addEventListener("click", async () => {
  try {
    const maximised = await api.maximise();
    document.getElementById("win-maximise")?.classList.toggle("is-maximised", maximised);
  } catch { /* state sync on resize will correct the icon */ }
});
// A maximise or full screen done outside the buttons
// (an OS shortcut, a snap) still has to flip the icon,
// so re-read the real window state after resizes settle
// and once at startup.
let windowStateTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => { void syncWindowState(); }, 200);
});
void syncWindowState();
document.getElementById("btn-reset")?.addEventListener("click", () => {
  const confirmEl = document.getElementById("reset-confirm") as HTMLDivElement;
  const btn = document.getElementById("btn-reset") as HTMLButtonElement;
  if (confirmEl) confirmEl.style.display = "block";
  if (btn) btn.style.display = "none";
});
document.getElementById("btn-reset-confirm")?.addEventListener("click", async () => {
  // Delete first, then build the fresh welcome board in memory and
  // save that — never save the old board after the wipe, or it
  // would come straight back. The corner setting is untouched:
  // reset-board only deletes board data, not app settings.
  commitEditingIfAny();
  if (wheelSaveTimer) { clearTimeout(wheelSaveTimer); wheelSaveTimer = null; }
  if (audioEl) { audioEl.pause(); audioEl = null; audioId = null; }
  selected = [];
  editingId = null;
  try {
    const showcase = await api.resetBoard();
    board = welcomeBoard(boardDir, showcase.pdf_size_bytes, showcase.video_size_bytes);
    board.camera = { x: 0, y: 0, zoom: 1 };
    setSettings(false);
    const confirmEl = document.getElementById("reset-confirm") as HTMLDivElement;
    const btn = document.getElementById("btn-reset") as HTMLButtonElement;
    if (confirmEl) confirmEl.style.display = "none";
    if (btn) btn.style.display = "";
    save();
    render();
    void refreshLinkPreviews();
    toast(DEMO ? "Demo board reset — nothing was saved" : "Board data deleted — fresh welcome board restored");
  } catch (e) {
    toast(`Reset failed: ${String(e)}`);
  }
});
document.getElementById("btn-settings")?.addEventListener("click", () => setSettings(!settingsOpen));
for (const btn of Array.from(document.querySelectorAll("[data-settings-tab]"))) {
  (btn as HTMLElement).addEventListener("click", () => setSettingsTab((btn as HTMLElement).dataset.settingsTab ?? "general"));
}
document.getElementById("settings-close")?.addEventListener("click", () => setSettings(false));
document.getElementById("settings-backdrop")?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "settings-backdrop") setSettings(false);
});

function renderPluginSettings(): void {
  const list = document.getElementById("plugin-list") as HTMLDivElement | null;
  if (!list) return;
  const plugins = listLoadedPlugins();
  if (plugins.length === 0) {
    list.innerHTML = `<p class="meta">No plugins found. Drop a plugin folder into your plugins folder, then reopen Settings. See PLUGIN_API.md in the repo for the format.</p>`;
    return;
  }
  const descriptions: Record<string, string> = {
    hide: "Hides the board into a corner.",
    "visual-library": "The board's cards, as a library.",
    palette: "Colour palettes to place as swatches.",
    presentation: "Slides on the board, played in order.",
    "command-palette": "Every command, from one place.",
    "plugin-builder": "Describe a plugin, and an AI writes it for you to try, then keep or discard.",
  };
  let html = "";
  for (const lp of plugins) {
    const m = lp.manifest;
    // A trial plugin is not installed yet: the Builder panel
    // owns it, so it shows as Trying and gets no toggle.
    const state = lp.trial ? "Trying" : lp.failed ? "Failed" : lp.active ? "On" : "Off";
    html += `<div class="plugin-row"><div class="plugin-row-text"><div><strong>${escapeHtml(m.name)}</strong> <span class="meta">${state}</span></div>`;
    const desc = descriptions[m.id];
    if (desc) html += `<p class="meta">${desc}</p>`;
    if (lp.failed && lp.error) html += `<p class="meta"><strong>${escapeHtml(lp.error)}</strong></p>`;
    // No Run buttons: commands are run from the command
    // palette (Cmd/Ctrl+K), not from Settings, and the
    // palette's own Open command was the only command any
    // plugin registered, so a Run button here was just a
    // second way to open the palette.
    // A Settings button, when the plugin has a settings
    // section: it jumps to the Plugin settings tab and
    // scrolls to that plugin's section, so settings are
    // reachable from the plugin list, not only by tab.
    const hasSettings = document.querySelector(`#plugin-settings-sections [data-plugin="${m.id}"]`) !== null;
    html += `</div><span style="display:flex;gap:8px;flex:none">`;
    if (lp.active && hasSettings) html += `<button data-plugin-settings="${m.id}">Settings</button>`;
    if (!lp.trial) html += `<button data-plugin-toggle="${m.id}">${lp.active ? "Disable" : "Enable"}</button></span>`;
    else html += `</span>`;
    html += `</div>`;
  }
  list.innerHTML = html;
  for (const btn of Array.from(list.querySelectorAll("[data-plugin-settings]"))) {
    btn.addEventListener("click", () => {
      const id = (btn as HTMLElement).dataset.pluginSettings ?? "";
      setSettingsTab("plugin-settings");
      const section = document.querySelector(`#plugin-settings-sections [data-plugin="${id}"]`);
      if (section) section.scrollIntoView({ block: "start" });
    });
  }
  for (const btn of Array.from(list.querySelectorAll("[data-plugin-toggle]"))) {
    btn.addEventListener("click", async () => {
      const id = (btn as HTMLElement).dataset.pluginToggle ?? "";
      const lp = listLoadedPlugins().find((x) => x.manifest.id === id);
      if (!lp) return;
      await setPluginEnabled(id, !lp.active);
      renderShortcutsTable();
      renderPluginSettingsSections();
      renderPluginSettings();
      render();
    });
  }
}

function renderPluginSettingsSections(): void {
  renderSettingsSections();
  const empty = document.getElementById("plugin-settings-empty") as HTMLElement | null;
  const el = document.getElementById("plugin-settings-sections") as HTMLElement | null;
  if (empty && el) empty.style.display = el.children.length > 0 ? "none" : "";
}

function setSettingsTab(tab: string): void {
  for (const btn of Array.from(document.querySelectorAll("[data-settings-tab]"))) {
    (btn as HTMLElement).classList.toggle("active", (btn as HTMLElement).dataset.settingsTab === tab);
  }
  const sections: Record<string, string> = {
    general: "settings-section-general",
    plugins: "settings-section-plugins",
    "plugin-settings": "settings-section-plugin-settings",
  };
  for (const [key, id] of Object.entries(sections)) {
    const el = document.getElementById(id) as HTMLElement | null;
    if (el) el.style.display = key === tab ? "" : "none";
  }
  const content = document.getElementById("settings-content") as HTMLElement | null;
  if (content) content.scrollTop = 0;
}

function renderShortcutsTable(): void {
  const table = document.getElementById("shortcuts-table") as HTMLTableElement;
  if (!table) return;
  const allShortcuts: Array<[string, string]> = [...SHORTCUTS];
  for (const s of listPluginShortcuts()) allShortcuts.push([s.key.toUpperCase(), `${s.title} (${s.pluginName})`]);
  table.innerHTML = allShortcuts.map(([k, v]) => `<tr><td><kbd>${escapeHtml(k)}</kbd></td><td>${escapeHtml(v)}</td></tr>`).join("");
}

function setSettings(open: boolean): void {
  settingsOpen = open;
  const backdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
  backdrop.classList.toggle("open", open);
  if (open) {
    const confirmEl = document.getElementById("reset-confirm") as HTMLDivElement;
    const resetBtn = document.getElementById("btn-reset") as HTMLButtonElement;
    if (confirmEl) confirmEl.style.display = "none";
    if (resetBtn) resetBtn.style.display = "";
    renderShortcutsTable();
    renderBgOpts();
    renderGridOpts();
    void renderBackups();
    renderPluginSettingsSections();
    renderPluginSettings();
    setSettingsTab("general");
  }
  render();
}

async function renderBackups(): Promise<void> {
  const el = document.getElementById("backups-list") as HTMLElement | null;
  if (!el) return;
  if (DEMO) { el.innerHTML = `<p class="meta">Backups are not available in demo mode.</p>`; return; }
  let list: Array<{ name: string; items: number; size: number }> = [];
  try { list = await api.listBackups(); } catch { list = []; }
  if (list.length === 0) {
    el.innerHTML = `<p class="meta">No backups yet. The first one is made within an hour of working on this board.</p>`;
    return;
  }
  const fmtSize = (n: number): string => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const fmtName = (n: string): string => {
    // Backup folders are YYYY-MM-DD-HHMMSS: show them as a date and time.
    const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(n);
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : n;
  };
  // Only the last backup is shown: listBackups is newest
  // first, so that is list[0]. Older backups are still
  // kept on disk, but they are not listed here.
  const b = list[0];
  el.innerHTML = "";
  const row = document.createElement("div");
  row.className = "backup-row";
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${fmtName(b.name)} · ${b.items} items · ${fmtSize(b.size)}`;
  const btn = document.createElement("button");
  btn.textContent = "Restore";
  let armed = false;
  btn.addEventListener("click", async () => {
    // Two-click confirm, like Delete all data: the first
    // click arms the button, the second restores. The app
    // never uses a native confirm dialog.
    if (!armed) {
      armed = true;
      btn.textContent = "Confirm restore?";
      btn.classList.add("armed");
      setTimeout(() => { if (btn.isConnected) { armed = false; btn.textContent = "Restore"; btn.classList.remove("armed"); } }, 4000);
      return;
    }
    const ok = await restoreBoardBackup(b.name);
    if (ok) { setSettings(false); void renderBackups(); }
  });
  row.appendChild(meta);
  row.appendChild(btn);
  el.appendChild(row);
}

function renderBgOpts(): void {
  const opts: Array<[string, string]> = [["White", "#FFFFFF"], ["Paper", "#F7F5F0"], ["Sage", "#EAF3EC"], ["Sky", "#E8F0F7"], ["Ink", "#1C1C1E"]];
  const el = document.getElementById("bg-opts") as HTMLDivElement;
  el.innerHTML = "";
  for (const [label, hex] of opts) {
    const b = document.createElement("button");
    b.textContent = label;
    if (board.bg.toUpperCase() === hex) b.classList.add("active");
    b.addEventListener("click", () => { board.bg = hex; save(); render(); renderBgOpts(); });
    el.appendChild(b);
  }
}
function renderGridOpts(): void {
  const opts: Array<[string, Board["grid"]]> = [["Dots", "Dots"], ["Lines", "Lines"], ["Off", "Off"]];
  const el = document.getElementById("grid-opts") as HTMLDivElement;
  el.innerHTML = "";
  for (const [label, mode] of opts) {
    const b = document.createElement("button");
    b.textContent = label;
    if (board.grid === mode) b.classList.add("active");
    b.addEventListener("click", () => { board.grid = mode; save(); render(); renderGridOpts(); });
    el.appendChild(b);
  }
}

// ---------------------------------------------------------------- drops

function dropKindForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(e)) return "image";
  if (e === "pdf") return "pdf";
  if (["mp3", "wav", "flac", "ogg", "m4a"].includes(e)) return "audio";
  if (["mp4", "mov", "webm", "mkv", "avi", "m4v"].includes(e)) return "video";
  if (["txt", "md"].includes(e)) return "text";
  if (["url", "webloc"].includes(e)) return "shortcut";
  return "unknown";
}

function extractShortcutUrl(content: string): string | null {
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t.startsWith("URL=")) {
      const url = t.slice(4).trim();
      if (url.startsWith("http://") || url.startsWith("https://")) return url;
    }
  }
  for (const needle of ["https://", "http://"]) {
    const pos = content.indexOf(needle);
    if (pos !== -1) {
      const rest = content.slice(pos);
      const end = rest.search(/[\s<"']/);
      const url = end === -1 ? rest : rest.slice(0, end);
      if (url.length > needle.length + 1) return url;
    }
  }
  return null;
}

async function addUrlAt(at: Pt, url: string): Promise<void> {
  const isVideo = (() => {
    const host = domainOf(url.toLowerCase());
    if (["youtube.com", "youtu.be", "vimeo.com"].includes(host)) return true;
    const path = url.toLowerCase().split("?")[0].split("#")[0];
    return ["mp4", "mov", "webm", "mkv", "avi", "m4v"].some((ext) => path.endsWith("." + ext));
  })();
  if (isVideo) {
    const id = allocId();
    board.items.push({ id, pos: at, size: { w: 360, h: 264 }, group: null, kind: { Video: { source: url, remote: true, size_bytes: 0 } } });
    save(); render();
    return;
  }
  const id = allocId();
  board.items.push({ id, pos: at, size: { w: 320, h: 132 }, group: null, kind: { UrlCard: { url: url.trim(), title: null, description: null, image: null, icon: null } } });
  save(); render();
  try {
    const preview = await api.fetchPreview(url);
    const it = boardGet(board, id);
    if (it && "UrlCard" in it.kind) {
      it.kind.UrlCard.title = preview.title;
      it.kind.UrlCard.description = preview.description;
      it.kind.UrlCard.image = preview.image;
      it.kind.UrlCard.icon = preview.icon;
      // A preview image makes the card taller: banner on top, text below.
      if (preview.image) it.size = { w: 320, h: 300 };
      // A preview fill is background work, not a user change: it
      // must not become its own undo step (see saveWithoutUndo).
      saveWithoutUndo(); render();
    }
  } catch { /* domain-only card is fine */ }
}

async function dropPaths(paths: string[], atScreen: Pt): Promise<void> {
  let at = toWorld(atScreen);
  let added = 0;
  for (const path of paths) {
    const ext = path.split(".").pop() ?? "";
    const kind = dropKindForExt(ext);
    try {
      if (kind === "image") {
        const stored = await api.embedFile(path);
        const img = new Image();
        await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); img.src = api.fileUrl(stored); });
        const nw = img.naturalWidth || 320, nh = img.naturalHeight || 240;
        const scale = nw > 320 ? 320 / nw : 1;
        const id = allocId();
        board.items.push({ id, pos: at, size: { w: Math.max(40, nw * scale), h: Math.max(40, nh * scale) }, group: null, kind: { Image: { path: stored } } });
        added++;
      } else if (kind === "pdf") {
        const stored = await api.embedFile(path);
        const size = await api.fileSize(stored).catch(() => 0);
        const id = allocId();
        // Tall enough to show a page, not just a tile: the
        // page preview needs height, and a user can still
        // resize it smaller, where it falls back to a row.
        board.items.push({ id, pos: at, size: { w: 260, h: 360 }, group: null, kind: { PdfCard: { path: stored, size_bytes: size } } });
        added++;
      } else if (kind === "audio") {
        const stored = await api.embedFile(path);
        const id = allocId();
        board.items.push({ id, pos: at, size: { w: 300, h: 104 }, group: null, kind: { Audio: { path: stored } } });
        added++;
      } else if (kind === "video") {
        const stored = await api.embedFile(path);
        const size = await api.fileSize(stored).catch(() => 0);
        const id = allocId();
        board.items.push({ id, pos: at, size: { w: 360, h: 264 }, group: null, kind: { Video: { source: stored, remote: false, size_bytes: size } } });
        added++;
      } else if (kind === "text") {
        const text = await api.readTextFile(path);
        const hex = normaliseHex(text.trim());
        const id = allocId();
        if (hex) {
          board.items.push({ id, pos: at, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex } } });
        } else {
          board.items.push({ id, pos: at, size: { w: 260, h: estimateTextHeight(text.slice(0, 2000), 16, 260) }, group: null, kind: { Text: { text: text.slice(0, 2000), bold: false, size: 16, color: "#1A1A1A" } } });
        }
        added++;
      } else if (kind === "shortcut") {
        const text = await api.readTextFile(path);
        const url = extractShortcutUrl(text);
        if (url) { await addUrlAt(at, url); added++; }
      }
    } catch (err) {
      toast(`Could not add ${path.split("/").pop()}: ${String(err)}`);
    }
    at = { x: at.x + 24, y: at.y + 24 };
  }
  if (added > 0) { save(); render(); }
}

// File drops from the OS arrive as HTML5 files in Electron; the
// preload bridge turns each File into its real path via webUtils.
window.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  if ((e.target as HTMLElement).closest("#title-bar")) { e.preventDefault(); return; }
  if (files && files.length > 0) {
    const paths = Array.from(files).map((f) => api.getPathForFile(f)).filter((p) => p);
    if (paths.length > 0) {
      e.preventDefault();
      void dropPaths(paths, boardPoint(e.clientX, e.clientY));
    }
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
    void addUrlAt(toWorld(boardPoint(e.clientX, e.clientY)), uri);
  }
});

window.addEventListener("paste", (e: ClipboardEvent) => {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA") return;
  const text = e.clipboardData?.getData("text")?.trim() ?? "";
  if (/^https?:\/\//.test(text)) {
    e.preventDefault();
    const bs = boardSize();
    void addUrlAt(toWorld({ x: bs.x / 2, y: bs.y / 2 }), text);
  }
});

// ---------------------------------------------------------------- init

async function init(): Promise<void> {
  let panelOrderList: string[] = [];
  try {
    const loaded = await api.loadBoard();
    boardDir = loaded.board_dir;
    if (Array.isArray(loaded.panelOrder)) panelOrderList = loaded.panelOrder.filter((x: unknown) => typeof x === "string");
    const boardDirEl = document.getElementById("board-dir-meta");
    if (boardDirEl) boardDirEl.textContent = `Board folder: ${boardDir}`;
    const buildEl = document.getElementById("build-meta");
    if (buildEl) buildEl.textContent = `Build: ${loaded.buildId ?? "dev"}`;
    if (loaded.json) {
      const parsed = JSON.parse(loaded.json) as Board;
      board = parsed;
      board.bg = board.bg ?? "#FFFFFF";
      board.grid = board.grid ?? "Dots";
      board.camera = board.camera ?? { x: 0, y: 0, zoom: 1 };
      for (const it of board.items) {
        if ("UrlCard" in it.kind) {
          // Old boards may carry embed:true from the embedded-page era;
          // link cards are previews only now, so it is ignored.
          it.kind.UrlCard.image = it.kind.UrlCard.image ?? null;
          it.kind.UrlCard.icon = it.kind.UrlCard.icon ?? null;
        }
      }
    } else {
      board = welcomeBoard(boardDir, loaded.pdf_size_bytes, loaded.video_size_bytes ?? 0);
      save();
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
      if (healed) saveWithoutUndo();
    } catch { /* a failed heal must never block startup */ }
  } catch (err) {
    toast(`Could not load the board: ${String(err)}`);
    board = welcomeBoard(boardDir, 0, 0);
  }
  // The loaded board is the first undo baseline: nothing before
  // it is undoable, and the first saved change pushes it as step 1.
  resetUndo();
  // Panel tab order, loaded with the board: the plugin system
  // applies it once panels are registered, and saves it back
  // whenever the user drags a tab.
  const pluginHost: PluginHost = {
    getBoard: () => board,
    getSelected: () => selected,
    setSelected: (ids: number[]) => { selected = ids; updateSelection(); },
    addItem: (kind, pos, size) => {
      const id = allocId();
      board.items.push({ id, pos, size, group: null, kind });
      save(); render();
      return id;
    },
    updateItem: (id, patch) => {
      const it = boardGet(board, id);
      if (!it) return false;
      if (patch.pos) it.pos = patch.pos;
      if (patch.size) it.size = patch.size;
      if (patch.group !== undefined) it.group = patch.group;
      if (patch.data !== undefined && "Plugin" in it.kind) it.kind.Plugin.data = patch.data;
      save(); render();
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
      save(); render();
      return true;
    },
    removeItem: (id) => {
      const before = board.items.length;
      board.items = board.items.filter((it) => it.id !== id);
      if (board.items.length === before) return false;
      selected = selected.filter((s) => s !== id);
      save(); render();
      return true;
    },
    renderBoardCard: (id) => {
      const it = boardGet(board, id);
      if (!it) return null;
      if ("Stroke" in it.kind || "Connector" in it.kind) return null;
      const html = cardHtml({ ...it, pos: { x: 0, y: 0 } }, true);
      return html === "" ? null : html;
    },
    save: () => save(),
    render: () => render(),
    switchBoard: (name: string, preserveUndo = false) => switchToBoard(name, preserveUndo),
    setTool: (toolName: string) => setTool(toolName),
    getPenColor: () => penColor,
    setPenColor: (hex: string) => {
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
      penColor = hex.toUpperCase();
      render();
      emitPluginEvent("pen");
      return true;
    },
    getCamera: () => board.camera,
    setCamera: (cam) => {
      if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.zoom)) return;
      board.camera = { x: cam.x, y: cam.y, zoom: Math.max(0.1, Math.min(8, cam.zoom)) };
      save(); render();
    },
    centreOn: (id) => {
      const it = boardGet(board, id);
      if (!it) return;
      selected = select(board, [], id, false);
      const c = centre(it);
      const bs = boardSize();
      board.camera.x = c.x - bs.x / 2 / board.camera.zoom;
      board.camera.y = c.y - bs.y / 2 / board.camera.zoom;
      save(); render();
    },
    toast: (msg: string) => toast(msg),
    commitEditing: () => commitEditingIfAny(),
    openSettings: () => setSettings(true),
    closeSettings: () => setSettings(false),
    isSettingsOpen: () => settingsOpen,
    undo: () => undo(),
    redo: () => redo(),
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    groupSelection: () => groupSelected(),
    ungroupSelection: () => ungroupSelected(),
    deleteSelection: () => deleteSelected(),
    toolbarToolsEl: document.getElementById("tools") as HTMLElement,
    panelsEl: document.getElementById("plugin-panels") as HTMLElement,
    panelsToggleEl: document.getElementById("panels-toggle") as HTMLElement,
    pluginViewEl: document.getElementById("plugin-view") as HTMLElement,
    boardCanvasEls: [
      gridEl,
      document.getElementById("canvas-svg") as HTMLElement,
      cardsEl,
      // The resize handle is board chrome, not view chrome: a view
      // must hide it, and returning to the board restores its
      // CSS default (hidden until updateResizeHandle shows it).
      document.getElementById("resize-handle") as HTMLElement,
      document.getElementById("rotate-handle") as HTMLElement,
    ],
    viewSwitcherEl: document.getElementById("view-switcher") as HTMLElement,
    overlaysEl: document.getElementById("plugin-overlays") as HTMLElement,
    settingsSectionsEl: document.getElementById("plugin-settings-sections") as HTMLElement,
    getPanelOrder: () => [...panelOrderList],
    setPanelOrder: (order: string[]) => {
      panelOrderList = order.filter((x) => typeof x === "string");
      void api.setPanelOrder(panelOrderList);
    },
  };
  await initPlugins(pluginHost, api);
  render();
  // Preload the context index now, in the background,
  // so the first search does not pay the index-load
  // cost on top of everything else.
  void loadContextIndex();
  if (DEMO) toast("Demo \u2014 try anything, nothing is saved");
  // Fill in previews for cards that never got one (welcome card, old
  // boards): title, description, image and icon, in the background.
  void refreshLinkPreviews();
}

async function refreshLinkPreviews(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const it of board.items) {
    if (!("UrlCard" in it.kind)) continue;
    if (it.kind.UrlCard.title !== null && it.kind.UrlCard.image !== undefined) continue;
    const url = it.kind.UrlCard.url;
    const id = it.id;
    jobs.push((async () => {
      try {
        const preview = await api.fetchPreview(url);
        const current = boardGet(board, id);
        if (!current || !("UrlCard" in current.kind)) return;
        let changed = false;
        if (preview.title && current.kind.UrlCard.title !== preview.title) { current.kind.UrlCard.title = preview.title; changed = true; }
        if (preview.description && current.kind.UrlCard.description !== preview.description) { current.kind.UrlCard.description = preview.description; changed = true; }
        if (preview.image && current.kind.UrlCard.image !== preview.image) { current.kind.UrlCard.image = preview.image; current.size = { w: 320, h: 300 }; changed = true; }
        if (preview.icon && current.kind.UrlCard.icon !== preview.icon) { current.kind.UrlCard.icon = preview.icon; changed = true; }
        if (changed) { saveWithoutUndo(); render(); }
      } catch { /* keep the domain card */ }
    })());
  }
  await Promise.all(jobs);
}

void init();
