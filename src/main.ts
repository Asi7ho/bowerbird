import { api } from "./api";
import { createMedia, type Media } from "./media";
import { createCardRenderer, SHAPES, type CardRenderer } from "./cards";
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
  Anchor, Board, GRID, Item, Pt, ShapeKind,
  anchorPoint, boardGet, centre, clippedEnds, estimateTextHeight,
  hitTest, itemBounds, itemRotation, marquee, moveSelection, parseHex,
  resizeItem, rotatePoint, select,
} from "./model";
import { welcomeBoard } from "./welcome";
import {
  closeSettingsUI, emitPluginEvent, getActiveView, getBoardElements, getCardRenderer,
  getPluginTool, handlePluginCardAction, handlePluginCardDoubleClick, handlePluginShortcut,
  initPlugins, isSettingsUIOpen,
  openSettingsUI,
  refreshActiveView, refreshSettingsUI, registerShellElements,
  syncPluginToolButtons,
  type PluginHost,
} from "./plugins";

// ---------------------------------------------------------------- state

// Core tools are select/pen/connector. Plugin tools are strings of
// the form "plugin:<pluginId>:<toolId>" (see src/plugins.ts); the
// type stays open so a plugin tool is a valid Tool.
type Tool = string;
const PALETTE = ["#1A1A1A", "#E63946", "#2E86AB", "#FF6B35", "#6a4c93", "#2A9D8F"];
const ACCENT = "#007AFF";


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
let tool: Tool = "select";
let penColor = PALETTE[0];
let selected: number[] = [];
let spaceDown = false;
let editingId: number | null = null;
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

// The board DOM is built by the core-board plugin, so these
// start unassigned and are read from the shell after the
// plugin activates in init(). Before that they must not be
// used: the board does not exist yet.
let boardEl: HTMLDivElement = null as unknown as HTMLDivElement;
let worldEl: SVGGElement = null as unknown as SVGGElement;
let cardsEl: HTMLDivElement = null as unknown as HTMLDivElement;
let gridEl: HTMLDivElement = null as unknown as HTMLDivElement;
// Key of the card/stroke content currently built in the DOM. Camera
// moves that leave this key unchanged must not rebuild anything:
// panning then is one GPU transform, not a DOM rebuild per frame.
let lastContentKey = 0;
let cursorRaf = 0;
let pendingCursor: Pt | null = null;
let toastEl: HTMLDivElement = null as unknown as HTMLDivElement;

// ---------------------------------------------------------------- helpers

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4000);
}

// Media owns the PDF and audio state (see src/media.ts); the
// context below is how it reads the board and asks the core
// to re-render or re-run a search after async work lands.
const media: Media = createMedia({
  getBoard: () => board,
  getBoardGeneration: () => boardGeneration,
  bumpSearchVersion: () => { boardSearchVersion++; },
  requestSearchUpdate: () => search.updateSearch(),
  requestRender: () => render(),
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
    render();
  },
});


// Card HTML lives in src/cards.ts; the renderer reads the
// selection and the editing card through these two getters.
const cards: CardRenderer = createCardRenderer({
  media,
  isSelected: (id) => selected.includes(id),
  getEditingId: () => editingId,
});

// Undo and saving live in src/undo.ts. The store reads the
// board and the selection, and asks the core to re-render
// and refresh the Settings canvas controls after an undo.
const undoStore: UndoStore = createUndoStore({
  getBoard: () => board,
  getSelected: () => selected,
  setSelected: (ids) => { selected = ids; },
  clearEditing: () => { editingId = null; },
  isDemo: () => DEMO,
  bumpSearchVersion: () => { boardSearchVersion++; },
  requestRender: () => render(),
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
  requestRender: () => render(),
  toWorld: (s) => toWorld(s),
  toast,
});

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
  commitEditingIfAny();
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
  for (const it of parsed.items) {
    if (isFrameCard(it)) delete (it as { rotation?: number }).rotation;
  }
  board = parsed;
  boardGeneration++;
  boardSearchVersion++;
  boardDir = dir;
  selected = [];
  editingId = null;
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
  render();
  void search.loadContextIndex();
}
async function switchToBoard(name: string, preserveUndo = false): Promise<boolean> {
  if (DEMO) { toast("Demo — boards do not switch in demo mode"); return false; }
  try {
    commitEditingIfAny();
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
// Reset the board to a fresh welcome board (the settings
// "Delete all board data" flow). The settings plugin calls
// this through the API; the core owns the reset itself.
// Delete first, then build the fresh welcome board in memory
// and save that — never save the old board after the wipe,
// or it would come straight back. The corner setting is
// untouched: reset-board only deletes board data, not app
// settings.
async function resetBoardToWelcome(): Promise<boolean> {
  commitEditingIfAny();
  if (wheelSaveTimer) { clearTimeout(wheelSaveTimer); wheelSaveTimer = null; }
  media.stopAudio();
  selected = [];
  editingId = null;
  try {
    const showcase = await api.resetBoard();
    board = welcomeBoard(boardDir, showcase.pdf_size_bytes, showcase.video_size_bytes);
    board.camera = { x: 0, y: 0, zoom: 1 };
    closeSettingsUI();
    undoStore.save();
    render();
    void drops.refreshLinkPreviews();
    toast(DEMO ? "Demo board reset — nothing was saved" : "Board data deleted — fresh welcome board restored");
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
function openExternal(target: string): void {
  api.openExternal(target).catch((e) => toast(`Could not open ${target}: ${String(e)}`));
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

// A numeric hash, not a joined string: this runs on
// every wheel tick, and the old version allocated a
// comma-joined string over all visible ids (plus the
// selection) just to compare it with the last one.
// FNV-1a over the visible ids in board order, then the
// selection and editing state: a changed visible set
// hashes differently, and the hash is only ever compared
// with the previous hash, never persisted.
function visibleKey(): number {
  const v = visibleRect();
  let h = 2166136261;
  const mix = (n: number): void => {
    h ^= n & 0xffffffff;
    h = Math.imul(h, 16777619);
  };
  for (const item of board.items) if (isVisibleItem(item, v)) mix(item.id);
  mix(0x9e3779b9);
  for (const id of selected) mix(id);
  mix(editingId ?? -1);
  return h;
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

// A stroke's SVG path string is rebuilt from its
// points on every render — and renderSvgOnly runs on
// every mousemove while dragging, so a few long strokes
// meant rebuilding thousands of coordinates per frame
// for strokes that had not moved. Cache it per item
// object, like the markdown cache below: the key is the
// point count plus the first and last points, which is
// exactly what changes when a stroke is drawn (points
// appended) or moved (all points translated). There is
// no operation that rewrites middle points alone.
const strokePathCache = new WeakMap<object, { key: string; d: string }>();
function strokePath(item: Item, points: Pt[], color: string, width: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  const key = `${points.length}:${first.x},${first.y}:${last.x},${last.y}:${color}:${width}`;
  const hit = strokePathCache.get(item);
  if (hit && hit.key === key) return hit.d;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  strokePathCache.set(item, { key, d });
  return d;
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
      const d = strokePath(item, points, color, width);
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
  // The board DOM is built by the core-board plugin, and the
  // core reads its elements from the shell only after the
  // plugins have activated — so a render requested during
  // plugin activation (a panel registering, a view switching)
  // finds no board yet. There is nothing to draw, and init()
  // renders once the elements exist; skip, do not throw.
  // Without this, the first panel plugin to activate at boot
  // failed with "Cannot read properties of null".
  if (!boardEl) return;
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
    html += cards.cardHtml(item);
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
  lastContentKey = visibleKey();
  applyCamera();
  search.updateSearch();
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
  if (getActiveView() !== "board" || selected.length !== 1 || isSettingsUIOpen() || editingId !== null) {
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
  // Selection changes without a full render (a plain click) still
  // need the resize handle to appear / disappear immediately.
  updateResizeHandle();
}

function updateSelection(): void {
  updateSelectionInner();
  // The toolbar plugin follows the selection through the
  // "selection" plugin event, so its note-colours flyout
  // appears when a text note is selected.
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
      undoStore.save();
      render();
      return;
    }
    const it = boardGet(board, id);
    if (it && "Text" in it.kind) {
      it.kind.Text.text = text;
      it.size.h = Math.max(40, estimateTextHeight(text, it.kind.Text.size, it.size.w));
    }
    editingId = null;
    undoStore.save();
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
  // The toolbar plugin follows the tool through the "tool"
  // plugin event, so it can highlight the active tool and
  // show the right flyout without polling. The plugin tool
  // buttons are the plugin system's own DOM, so the core
  // syncs them here.
  emitPluginEvent("tool");
  syncPluginToolButtons(t);
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
  undoStore.save(); render();
  return true;
}

function ungroupSelected(): boolean {
  const groups = new Set(selected.map((id) => boardGet(board, id)?.group).filter((g): g is number => g !== null && g !== undefined));
  if (groups.size === 0) return false;
  for (const it of board.items) if (it.group !== null && groups.has(it.group)) it.group = null;
  undoStore.save(); render();
  return true;
}

function deleteSelected(): boolean {
  if (selected.length === 0) return false;
  board.items = board.items.filter((it) => !selected.includes(it.id));
  selected = [];
  undoStore.save(); render();
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
  undoStore.save(); render();
  return true;
}

// The board DOM is built by the core-board plugin, so the
// board listeners attach here, called from init() after
// the board elements are read from the shell. Attaching
// them at module load would throw: the board does not
// exist yet.
function attachBoardListeners(): void {
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
  if (cards.isShapeTool(tool)) {
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
  if (action === "play-audio" && "Audio" in it.kind) media.toggleAudio(id, it.kind.Audio.path);
  if ((action === "pdf-prev" || action === "pdf-next") && "PdfCard" in it.kind) {
    const pdfPath = it.kind.PdfCard.path;
    const docPromise = media.getCachedPdfDoc(pdfPath);
    if (!docPromise) return;
    void docPromise.then((doc) => {
      const cur = media.pdfPages.get(id) ?? 1;
      const nextPage = action === "pdf-prev" ? cur - 1 : cur + 1;
      if (nextPage < 1 || nextPage > doc.numPages) return;
      media.pdfPages.set(id, nextPage);
      void media.renderPdfPage(id, pdfPath);
    });
  }

  if (action === "play-video" && "Video" in it.kind) openExternal(it.kind.Video.source);
});

cardsEl.addEventListener("input", (e: Event) => {
  const seek = (e.target as HTMLElement).closest("[data-audio-seek]") as HTMLInputElement | null;
  if (!seek) return;
  const id = Number(seek.dataset.audioSeek);
  const audio = media.getAudioState();
  if (!audio.el || audio.id !== id || !isFinite(audio.el.duration) || audio.el.duration <= 0) return;
  audio.el.currentTime = (Number(seek.value) / 1000) * audio.el.duration;
  media.updateAudioProgress();
});


// ---------------------------------------------------------------- keyboard

// Find elements one by one on an infinite board: Tab steps through
// the board's elements in board order, selecting each in turn and
// centring the camera on it, so an element far from the current
// view is found without hunting. Shift+Tab steps backwards, and
// the cycle wraps. Pen strokes and connectors are skipped: they
// are drawings and lines, not elements to find. A grouped item
// selects its whole group and centres on the group's bounds.
}

// ---------------------------------------------------------------- mouse

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
        if (isSettingsUIOpen() || editingId !== null) {
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
    const it = boardGet(board, drag.id);
    resizeItem(board, drag.id, drag.origW + (world.x - drag.startWorld.x), drag.origH + (world.y - drag.startWorld.y));
    if (Math.hypot(world.x - drag.startWorld.x, world.y - drag.startWorld.y) > 2) drag.moved = true;
    updateDraggedCards([drag.id]);
    // Strokes have no card element to resize live, so rebuild
    // the SVG layer instead: the stroke visibly follows the
    // handle, like a card does. Same as the rotate drag below.
    if (it && "Stroke" in it.kind) renderSvgOnly();
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
      el.setAttribute("points", cards.shapePreviewPoints(drag.shape, x0, y0, w, h));
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
      undoStore.save();
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
      undoStore.save();
    }
  } else if (d.kind === "shape") {
    const w = Math.abs(world.x - d.start.x), h = Math.abs(world.y - d.start.y);
    if (w >= 10 && h >= 10) {
      const id = allocId();
      board.items.push({ id, pos: { x: Math.min(d.start.x, world.x), y: Math.min(d.start.y, world.y) }, size: { w, h }, group: null, kind: { Shape: { shape: d.shape, fill: penColor } } });
      undoStore.save();
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
    if (d.moved) undoStore.save();
  } else if (d.kind === "marquee") {
    selected = marquee(board, d.start, world);
  } else if (d.kind === "pan") {
    // A Space+drag pan changes only the camera, so it must not
    // become an undo step — but it must reach disk, or closing
    // the window without another save loses the view.
    undoStore.saveWithoutUndo();
  } else if (d.kind === "move" || d.kind === "resize") {
    // A drag that actually moved is a board change and an undo
    // step. A click that never moved only brought a card to the
    // front: that stacking change still saves to disk, but it
    // must not become an undo step, or every click would take
    // a Ctrl+Z to get past before the real change undoes.
    if (d.moved) undoStore.save();
    else undoStore.saveWithoutUndo();
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
  // A marquee drag ends in render(), not updateSelection(),
  // so without this the selection event never fires after
  // marquee-selecting — and anything listening for it, like
  // a plugin panel enabling its buttons for the selection,
  // stays stale. The toolbar and resize handle update here
  // too, for the same reason.
  if (d.kind === "marquee") updateSelection();
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
      undoStore.save();
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
  wheelSaveTimer = setTimeout(() => undoStore.save(), 400);
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
  // A remote image (a link card's preview or favicon) has no
  // data-path: it is not a board file, so there is nothing to
  // retry and no missing file to report. Leave it alone — the
  // card's own error handling hides the image area and shows
  // the title and description. Only board-local media gets
  // the missing tile below.
  if (!path) return;
  if (el.dataset?.fallback !== "1") {
    el.dataset.fallback = "1";
    void api.readFileBase64(path).then(({ mime, base64 }) => {
      el.src = `data:${mime};base64,${base64}`;
    }).catch(() => {
      // The read failed, so the data URL never loads
      // and no second error event ever fires — the
      // comment's "next error event" never comes. Swap
      // the element for the missing tile right here
      // instead of leaving a broken image forever.
      const name = el.dataset?.name ?? "media file";
      const div = document.createElement("div");
      div.className = "missing-media";
      div.textContent = `File missing: ${name}`;
      if (el.parentElement) el.parentElement.replaceChild(div, el);
    });
    return;
  }
  // The data-URL retry also failed, so the file is genuinely
  // unreadable — this is the only case that gets the tile.
  const name = el.dataset?.name ?? "media file";
  const div = document.createElement("div");
  div.className = "missing-media";
  div.textContent = `File missing: ${name}`;
  if (t.parentElement) t.parentElement.replaceChild(div, t);
}, true);

// Card button / link clicks (delegated; cards are pointer-events:none
// except these controls, so clicks here never start a board drag).
// Audio seek slider (delegated; the slider lives in the card DOM,
// which render() rebuilds, so a direct listener would be lost).
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
  undoStore.save(); render();
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
  if (isSettingsUIOpen() && e.key !== "Escape" && e.key !== "Tab") return;
  // Tab cycles elements, unless Settings is open, where Tab keeps
  // its normal job of moving focus around the sheet.
  if (e.key === "Tab" && !isSettingsUIOpen()) {
    e.preventDefault();
    navigateElements(e.shiftKey ? -1 : 1);
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === " " || e.key === " ") spaceDown = true;
  // Ctrl/Cmd+, is the standard preferences shortcut on the
  // Mac (and in many apps elsewhere). Guarded the same way
  // as the other board keys: Settings being open already
  // returns above, and textareas and the search box return
  // before this, so typing a comma never opens the sheet.
  if (ctrl && e.key === ",") { openSettingsUI(); return; }
  if (e.key === "Escape") {
    if (isSettingsUIOpen()) { closeSettingsUI(); return; }
    // An active search is cleared first; the next Esc clears the
    // selection, as before. Searching must not eat the selection
    // clear entirely, and clearing the selection must not eat a
    // search the user is still looking at.
    const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
    if (searchInput && searchInput.value.trim() !== "") { search.clearSearch(); return; }
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
    undoStore.undo();
  } else if (e.key.toLowerCase() === "z" && ctrl && e.shiftKey && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    undoStore.redo();
  } else if (e.key.toLowerCase() === "y" && ctrl && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    undoStore.redo();
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
  } else if (e.key === "+" || e.key === "=") { zoomCentre(1.2); undoStore.save(); render(); }
  else if (e.key === "-") { zoomCentre(1 / 1.2); undoStore.save(); render(); }
  else if (e.key === "0") { board.camera = { x: 0, y: 0, zoom: 1 }; undoStore.save(); render(); }
  // Plugin shortcuts, last: core keys above win, so a plugin cannot
  // steal V, P, A, Ctrl+G/U, Delete, zoom or reset. The core guards
  // above (textarea, search box, Settings open) already applied.
  else if (editingId === null && !isSettingsUIOpen() && !ctrl && handlePluginShortcut(e.key)) { /* plugin handled it */ }
});
window.addEventListener("keyup", (e: KeyboardEvent) => {
  if (e.key === " ") spaceDown = false;
});

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



// File drops from the OS arrive as HTML5 files in Electron; the
// preload bridge turns each File into its real path via webUtils.
window.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  if ((e.target as HTMLElement).closest("#title-bar")) { e.preventDefault(); return; }
  if (files && files.length > 0) {
    const paths = Array.from(files).map((f) => api.getPathForFile(f)).filter((p) => p);
    if (paths.length > 0) {
      e.preventDefault();
      void drops.dropPaths(paths, boardPoint(e.clientX, e.clientY));
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
    void drops.addUrlAt(toWorld(boardPoint(e.clientX, e.clientY)), uri);
  }
});

window.addEventListener("paste", (e: ClipboardEvent) => {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA") return;
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
        if ("UrlCard" in it.kind) {
          // Old boards may carry embed:true from the embedded-page era;
          // link cards are previews only now, so it is ignored.
          it.kind.UrlCard.image = it.kind.UrlCard.image ?? null;
          it.kind.UrlCard.icon = it.kind.UrlCard.icon ?? null;
        }
        // Frames never rotate; see loadBoardFromJson.
        if (isFrameCard(it)) delete (it as { rotation?: number }).rotation;
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
      undoStore.save(); render();
      return id;
    },
    updateItem: (id, patch) => {
      const it = boardGet(board, id);
      if (!it) return false;
      if (patch.pos) it.pos = patch.pos;
      if (patch.size) it.size = patch.size;
      if (patch.group !== undefined) it.group = patch.group;
      if (patch.data !== undefined && "Plugin" in it.kind) it.kind.Plugin.data = patch.data;
      undoStore.save(); render();
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
      undoStore.save(); render();
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
      undoStore.save(); render();
      return true;
    },
    removeItem: (id) => {
      const before = board.items.length;
      board.items = board.items.filter((it) => it.id !== id);
      if (board.items.length === before) return false;
      selected = selected.filter((s) => s !== id);
      undoStore.save(); render();
      return true;
    },
    renderBoardCard: (id) => {
      const it = boardGet(board, id);
      if (!it) return null;
      if ("Stroke" in it.kind || "Connector" in it.kind) return null;
      const html = cards.cardHtml({ ...it, pos: { x: 0, y: 0 } }, true);
      return html === "" ? null : html;
    },
    hitTest: (world: Pt) => hitTestWithFrames(board, world),
    save: () => undoStore.save(),
    render: () => render(),
    switchBoard: (name: string, preserveUndo = false) => switchToBoard(name, preserveUndo),
    setTool: (toolName: string) => setTool(toolName),
    getTool: () => tool,
    // Zoom around the board centre, by a factor. The
    // toolbar's zoom buttons. The camera math stays here;
    // the plugin just says "zoom in" or "zoom out".
    zoomBy: (factor: number) => { zoomCentre(factor); render(); },
    // The shape table for the toolbar's shape picker.
    listShapes: () => SHAPES.map((s) => ({ kind: s.kind, label: s.label, key: s.key, svg: s.svg })),
    // Set the background of the given text notes, in one
    // save (one undo step). The toolbar's note-colour
    // flyout. Only Text notes are affected.
    setNoteBackground: (ids: number[], hex: string) => {
      for (const id of ids) {
        const it = boardGet(board, id);
        if (it && "Text" in it.kind) it.kind.Text.bg = hex;
      }
      undoStore.save(); render();
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
      if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.zoom)) return;
      board.camera = { x: cam.x, y: cam.y, zoom: Math.max(0.1, Math.min(8, cam.zoom)) };
      undoStore.save(); render();
    },
    setCanvas: (patch) => {
      if (patch.bg !== undefined) board.bg = patch.bg;
      if (patch.grid !== undefined) board.grid = patch.grid;
      undoStore.save(); render();
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
      undoStore.save(); render();
    },
    toast: (msg: string) => toast(msg),
    commitEditing: () => commitEditingIfAny(),
    openSettings: () => openSettingsUI(),
    closeSettings: () => closeSettingsUI(),
    isSettingsOpen: () => isSettingsUIOpen(),
    undo: () => undoStore.undo(),
    redo: () => undoStore.redo(),
    canUndo: () => undoStore.canUndo(),
    canRedo: () => undoStore.canRedo(),
    groupSelection: () => groupSelected(),
    ungroupSelection: () => ungroupSelected(),
    deleteSelection: () => deleteSelected(),
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
    audioFailed: (path) => media.audioFailed.has(path),
    formatAudioTime: (sec) => media.formatAudioTime(sec),
    getPdfPage: (id) => media.pdfPages.get(id) ?? 1,
    loadPdfPage: (id, path) => media.loadPdfPage(id, path),
    pdfFailed: (path) => media.pdfFailed.has(path),
    resetBoard: () => resetBoardToWelcome(),
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
  {
    const els = getBoardElements();
    if (els.board) boardEl = els.board as HTMLDivElement;
    if (els.canvas) {
      const [g, svg, c] = els.canvas;
      if (g) gridEl = g as HTMLDivElement;
      if (svg) {
        const w = svg.querySelector("#world") as unknown as SVGGElement | null;
        if (w) worldEl = w;
      }
      if (c) cardsEl = c as HTMLDivElement;
    }
    if (els.toast) toastEl = els.toast as HTMLDivElement;
  }
  // The board listeners attach now, once the board DOM exists.
  attachBoardListeners();
  render();
  // Preload the context index now, in the background,
  // so the first search does not pay the index-load
  // cost on top of everything else.
  void search.loadContextIndex();
  if (DEMO) toast("Demo \u2014 try anything, nothing is saved");
  // Fill in previews for cards that never got one (welcome card, old
  // boards): title, description, image and icon, in the background.
  void drops.refreshLinkPreviews();
}


void init();
