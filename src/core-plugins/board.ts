// The board view is a first-party plugin (core-board):
// it builds the board DOM — the canvas, grid, SVG layer,
// cards layer, plugin view, overlays, view switcher,
// resize/rotate handles and toast — and it owns the render
// loop and the input loop (pan, zoom, drag, resize/rotate,
// text edit). It uses only the public API, plus the pure
// board-model functions in src/model.ts (geometry over the
// board data it reads through the API). The core never owns
// board DOM and renders nothing itself.
//
// The board plugin keeps no live board reference: the core
// owns the board, and the plugin reads it through
// api.board.get() (a copy, for rendering) and mutates it
// through the API's live-drag methods (which change the
// live board without saving, so a drag saves once at drag
// end). The camera, tool, pen colour and selection are
// core state, read and written through api.view, api.ui,
// api.pen and api.board. Text editing state (editingId)
// lives here, because the board view owns text editing;
// the core clears it through the board controller below
// (undo, board switch, reset).
import type { PluginContext, PluginManifest } from "../plugins";
import {
  emitPluginEvent,
  getActiveView,
  getCardRenderer,
  getPluginTool,
  handlePluginCardAction,
  handlePluginCardDoubleClick,
  handlePluginShortcut,
  isSettingsUIOpen,
  openSettingsUI,
  closeSettingsUI,
  refreshActiveView,
  registerBoardController,
  syncPluginToolButtons,
} from "../plugins";
import {
  Anchor, Board, GRID, Item, Pt, ShapeKind,
  boardGet, centre, clippedEnds, fitCamera,
  itemBounds, itemRotation, parseHex, pressureWidth, rotatePoint, select,
  strokeMaxWidth, strokePressuresVary, toggleTaskLine,
} from "../model";

export const manifest: PluginManifest = {
  id: "core-board",
  name: "Board",
  description: "The board itself: canvas, grid, cards and handles.",
  version: "1.0.0",
  apiVersion: "2",
  main: "board.js",
  permissions: ["board:read", "board:write"],
  required: true,
};

// Core tools are select/pen/connector/eraser. Plugin tools are strings of
// the form "plugin:<pluginId>:<toolId>" (see src/plugins.ts); the
// type stays open so a plugin tool is a valid Tool.
type Tool = string;
const ACCENT = "#007AFF";

// The eraser's reach, in world units: a stroke is erased
// when the eraser circle overlaps it. 12 is big enough
// that a sweep feels forgiving, small enough to pick one
// stroke out of a cluster.
const ERASER_RADIUS = 12;

let api!: PluginContext;

// The board DOM, built by this plugin in activate().
let boardEl!: HTMLDivElement;
let gridEl!: HTMLDivElement;
let worldEl!: SVGGElement;
let cardsEl!: HTMLDivElement;

// The board as last rendered (a copy from api.board.get()).
// The render loop reads bg/grid/items from this; the
// visible-set check reads it too, so panning does not pay
// a fresh board copy per mousemove (items do not change
// while panning, only the camera does). It is refreshed by
// render(), which is called after every board change.
let cachedBoard: Board | null = null;
// Key of the card/stroke content currently built in the DOM. Camera
// moves that leave this key unchanged must not rebuild anything:
// panning then is one GPU transform, not a DOM rebuild per frame.
let lastContentKey = 0;

// Lasso is not a tool of its own — it is a mode of Select,
// toggled by L, with no toolbar button. While it is on, a
// drag on the board draws a lasso loop instead of the
// rectangular marquee.
let lassoMode = false;
let tool: Tool = "select";
let editingId: number | null = null;
let spaceDown = false;
let drag: null
  | { kind: "pan"; last: Pt }
  | { kind: "move"; lastWorld: Pt; moved: boolean }
  | { kind: "stroke"; points: Pt[]; pressures: number[] }
  | { kind: "lasso"; points: Pt[] }
  | { kind: "erase"; erased: boolean }
  | { kind: "connector"; from: Anchor; current: Pt }
  | { kind: "marquee"; start: Pt; current: Pt }
  | { kind: "shape"; shape: ShapeKind; start: Pt; current: Pt }
  | { kind: "rotate"; id: number; origRot: number; moved: boolean }
  | { kind: "resize"; id: number; startWorld: Pt; origW: number; origH: number; moved: boolean } = null;
let pluginToolDown = false;
// Double-click tracking: pointer events carry no click count
// (detail is always 0 in Chrome), so the old mouse-event
// `e.detail === 2` check never fired after the input switch
// to pointer events, and double-click silently stopped opening
// notes. A double-click is two presses close in time and space.
let lastPointerDown = { x: 0, y: 0, t: 0 };
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
let wheelSaveTimer: ReturnType<typeof setTimeout> | null = null;
let cursorRaf = 0;
let pendingCursor: Pt | null = null;
// The ring that shows the eraser's reach at the cursor.
// It is a body-level div, not part of the board SVG, so
// renderSvgOnly() never wipes it mid-drag.
let eraserRing: HTMLDivElement | null = null;
let listenersAttached = false;

// ---------------------------------------------------------------- helpers

function toScreen(p: Pt): Pt {
  const cam = api.view.getCamera();
  return { x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom };
}
function toWorld(s: Pt): Pt {
  const cam = api.view.getCamera();
  return { x: s.x / cam.zoom + cam.x, y: s.y / cam.zoom + cam.y };
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
  const cam = api.view.getCamera();
  const zoom = Math.max(0.1, Math.min(8, cam.zoom * factor));
  const after = { x: screen.x / zoom + cam.x, y: screen.y / zoom + cam.y };
  api.view.setCameraSilent({ x: cam.x + before.x - after.x, y: cam.y + before.y - after.y, zoom });
}
function zoomCentre(factor: number): void {
  const s = boardSize();
  zoomAt({ x: s.x / 2, y: s.y / 2 }, factor);
}
// F: zoom to fit — every item on screen at once. A no-op on
// an empty board. Like the 0 reset, this only moves the view;
// it does not save.
function zoomToFit(): void {
  const bs = boardSize();
  const cam = fitCamera(api.board.get(), { w: bs.x, h: bs.y });
  if (cam) api.view.setCamera(cam);
}

function ensureEraserRing(): HTMLDivElement {
  if (!eraserRing) {
    eraserRing = document.createElement("div");
    eraserRing.id = "eraser-ring";
    document.body.appendChild(eraserRing);
  }
  return eraserRing;
}
function updateEraserRing(clientX: number, clientY: number, show: boolean): void {
  const ring = ensureEraserRing();
  if (!show) { ring.style.display = "none"; return; }
  const d = ERASER_RADIUS * 2 * api.view.getCamera().zoom;
  ring.style.display = "block";
  ring.style.width = `${d}px`;
  ring.style.height = `${d}px`;
  ring.style.left = `${clientX - d / 2}px`;
  ring.style.top = `${clientY - d / 2}px`;
}
// Remove every stroke the eraser touches at this point.
// Returns true when at least one stroke went. The board
// is not saved here: the drag saves once, on mouseup, so
// a whole sweep is one undo step.
function eraseAt(world: Pt): boolean {
  const ids = api.board.strokesNear(world, ERASER_RADIUS);
  if (ids.length === 0) return false;
  api.board.removeItems(ids);
  renderSvgOnly();
  return true;
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
  const cam = api.view.getCamera();
  const b = cachedBoard;
  const bg = b?.bg ?? "#FFFFFF";
  const grid = b?.grid ?? "Dots";
  if (grid === "Off") { gridEl.style.backgroundImage = "none"; return; }
  const rgb = parseHex(bg) ?? [247, 245, 240];
  const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const color = lum > 140 ? "#d8d8de" : "#55555a";
  let step = GRID;
  const bs = boardSize();
  while ((bs.x / cam.zoom) / step > 40 || (bs.y / cam.zoom) / step > 40) step *= 2;
  const size = step * cam.zoom;
  const offX = (Math.floor(cam.x / step) * step - cam.x) * cam.zoom;
  const offY = (Math.floor(cam.y / step) * step - cam.y) * cam.zoom;
  if (grid === "Dots") {
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
  const cam = api.view.getCamera();
  worldEl.setAttribute("transform", `translate(${-cam.x * cam.zoom},${-cam.y * cam.zoom}) scale(${cam.zoom})`);
  cardsEl.style.transform = `translate(${-cam.x * cam.zoom}px,${-cam.y * cam.zoom}px) scale(${cam.zoom})`;
  applyGrid();
  updateResizeHandle();
}

// Visible world rect, with a margin so cards at the edge do not pop
// in and out while panning. Everything else is culled: for a board
// with thousands of items, render() only builds DOM for what is on
// screen, instead of rebuilding every card on every mousemove.
function visibleRect(): { x0: number; y0: number; x1: number; y1: number } {
  const cam = api.view.getCamera();
  const m = 200;
  return {
    x0: cam.x - m, y0: cam.y - m,
    x1: cam.x + boardSize().x / cam.zoom + m,
    y1: cam.y + boardSize().y / cam.zoom + m,
  };
}
function isVisibleItem(item: Item, v: { x0: number; y0: number; x1: number; y1: number }, board: Board): boolean {
  const [p, s] = itemBounds(board, item);
  return p.x < v.x1 && p.x + s.w > v.x0 && p.y < v.y1 && p.y + s.h > v.y0;
}

// A numeric hash, not a joined string: this runs on
// every wheel tick, and the old version allocated a
// comma-joined string over all visible ids (plus the
// selection) just to compare it with the last one.
// FNV-1a over the visible ids in board order, then the
// selection and editing state: a changed visible set
// hashes differently, and the hash is only ever compared
// with the previous hash, never persisted. It reads the
// cached board (see cachedBoard): items do not change
// while panning or zooming, only the camera does, so the
// cache is fresh wherever this runs.
function visibleKey(): number {
  const b = cachedBoard;
  if (!b) return 0;
  const v = visibleRect();
  let h = 2166136261;
  const mix = (n: number): void => {
    h ^= n & 0xffffffff;
    h = Math.imul(h, 16777619);
  };
  for (const item of b.items) if (isVisibleItem(item, v, b)) mix(item.id);
  mix(0x9e3779b9);
  for (const id of api.board.getSelected()) mix(id);
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
  // Fresh board: a drag may have moved items since the last
  // render, and the SVG layer must follow the live board.
  renderStrokesAndConnectors(api.board.get());
}

// A stroke's SVG path string is rebuilt from its
// points on every render — and renderSvgOnly runs on
// every mousemove while dragging, so a few long strokes
// meant rebuilding thousands of coordinates per frame
// for strokes that had not moved. Cache it per item id:
// the key is the point count plus the first and last
// points, which is exactly what changes when a stroke
// is drawn (points appended) or moved (all points
// translated). There is no operation that rewrites
// middle points alone.
const strokePathCache = new Map<number, { key: string; d: string }>();
function strokePath(item: Item, points: Pt[], color: string, width: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  const key = `${points.length}:${first.x},${first.y}:${last.x},${last.y}:${color}:${width}`;
  const hit = strokePathCache.get(item.id);
  if (hit && hit.key === key) return hit.d;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  strokePathCache.set(item.id, { key, d });
  return d;
}

function renderStrokesAndConnectors(board: Board): void {
  const items = board.items;
  const selected = api.board.getSelected();
  const v = visibleRect();
  for (const item of items) {
    // A rotated stroke's extent can exceed its unrotated
    // bounding box, so culling it by that box would hide
    // it at the viewport edge: rotated strokes are always
    // drawn. The count is small, so this costs nothing.
    if (!("Stroke" in item.kind && itemRotation(item) !== 0) && !isVisibleItem(item, v, board)) continue;
    if ("Stroke" in item.kind) {
      const { points, color, width, marker, pressures } = item.kind.Stroke;
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
        const selPath = svgEl2("path", { d, fill: "none", stroke: ACCENT, "stroke-width": String(strokeMaxWidth(item.kind.Stroke) + 6), "stroke-linecap": "round", "stroke-linejoin": "round" });
        if (transform) selPath.setAttribute("transform", transform);
        worldEl.appendChild(selPath);
      }
      if (pressures && strokePressuresVary(item.kind.Stroke)) {
        // A pen stroke is one line per segment, each at
        // the width its pressure makes; a uniform stroke
        // stays a single path, as before.
        for (let i = 0; i + 1 < points.length; i++) {
          const w = pressureWidth(width, (pressures[i] + pressures[i + 1]) / 2);
          const line = svgEl2("line", { x1: String(points[i].x), y1: String(points[i].y), x2: String(points[i + 1].x), y2: String(points[i + 1].y), stroke: color, "stroke-width": String(w), "stroke-linecap": "round" });
          if (transform) line.setAttribute("transform", transform);
          if (marker) line.setAttribute("opacity", "0.45");
          worldEl.appendChild(line);
        }
      } else {
        const path = svgEl2("path", { d, fill: "none", stroke: color, "stroke-width": String(width), "stroke-linecap": "round", "stroke-linejoin": "round" });
        if (transform) path.setAttribute("transform", transform);
        if (marker) path.setAttribute("opacity", "0.45");
        worldEl.appendChild(path);
      }
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

function render(): void {
  // A render requested before the board DOM exists (during
  // plugin activation) finds nothing to draw; init() renders
  // once the elements exist. Skip, do not throw.
  if (!boardEl) return;
  const board = api.board.get();
  cachedBoard = board;
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
  renderStrokesAndConnectors(board);
  // Cards: rebuild, except the note being edited (its textarea stays).
  // Only visible cards are built (see visibleRect).
  const editingEl = editingId !== null ? cardsEl.querySelector(`[data-id="${editingId}"]`) : null;
  const editingHtml = editingEl ? editingEl.outerHTML : null;
  const v = visibleRect();
  let html = "";
  for (const item of board.items) {
    if ("Stroke" in item.kind || "Connector" in item.kind) continue;
    if (editingId === item.id) continue;
    if (!isVisibleItem(item, v, board)) continue;
    html += api.board.renderCardAt(item.id) ?? "";
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
  api.search.update();
}

function isRotatable(it: Item | undefined): boolean {
  if (!it || "Connector" in it.kind) return false;
  return !isFrameCard(it);
}
function rotateHandleWorld(it: Item): Pt {
  const c = centre(it);
  const cam = api.view.getCamera();
  const top = { x: c.x, y: it.pos.y - 28 / cam.zoom };
  return rotatePoint(top, c, itemRotation(it));
}
function updateResizeHandle(): void {
  const el = document.getElementById("resize-handle") as HTMLDivElement;
  const rotEl = document.getElementById("rotate-handle") as HTMLDivElement | null;
  const selected = api.board.getSelected();
  // A plugin view owns the screen: the board's resize handle is
  // not part of that view, so it must never float over it — it
  // did, at the selected card's corner, while playing a slide.
  if (getActiveView() !== "board" || selected.length !== 1 || isSettingsUIOpen() || editingId !== null) {
    el.style.display = "none";
    if (rotEl) rotEl.style.display = "none";
    return;
  }
  // The board, fresh: the selected item's position is what
  // the handle follows, and it moves during a drag.
  const board = api.board.get();
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
  const selected = api.board.getSelected();
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
  const board = api.board.get();
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
      // Remove without saving, then save once: the empty
      // note leaves no board change and no undo step.
      api.board.removeItems([id]);
      editingId = null;
      api.board.save();
      render();
      return;
    }
    api.board.setTextContent(id, text);
    editingId = null;
    api.board.save();
    render();
  };
  ta.addEventListener("blur", commit);
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); ta.blur(); }
  });
  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
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
  // Every tool switch leaves lasso mode: it belongs to
  // Select only. The L handler turns it back on after
  // switching to Select.
  lassoMode = false;
  drag = null;
  updateEraserRing(0, 0, false);
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
// These are the board controller's group/ungroup/delete: the host
// delegates its groupSelection/ungroupSelection/deleteSelection
// here, so a plugin groups exactly as the keyboard does.
function groupSelected(): boolean {
  const selected = api.board.getSelected();
  if (selected.length < 2) return false;
  // The group id comes from the board's next_group, which
  // the core owns: createGroup bumps it, assigns it, and
  // saves, so a later group can never collide with it.
  return api.board.createGroup(selected) !== null;
}

function ungroupSelected(): boolean {
  const selected = api.board.getSelected();
  const board = api.board.get();
  const groups = new Set(selected.map((id) => boardGet(board, id)?.group).filter((g): g is number => g !== null && g !== undefined));
  if (groups.size === 0) return false;
  const patches = board.items
    .filter((it) => it.group !== null && groups.has(it.group))
    .map((it) => ({ id: it.id, group: null as number | null }));
  api.board.updateItems(patches);
  return true;
}

function deleteSelected(): boolean {
  const selected = api.board.getSelected();
  if (selected.length === 0) return false;
  api.board.removeItems(selected);
  api.board.setSelected([]);
  api.board.save();
  render();
  return true;
}

function cornerHit(id: number, world: Pt): boolean {
  const cam = api.view.getCamera();
  const board = api.board.get();
  const it = boardGet(board, id);
  if (!it || "Connector" in it.kind) return false;
  const [p, s] = itemBounds(board, it);
  const corner = rotatePoint({ x: p.x + s.w, y: p.y + s.h }, centre(it), itemRotation(it));
  const tol = 16 / cam.zoom;
  return Math.hypot(world.x - corner.x, world.y - corner.y) <= tol;
}
function rotateHit(id: number, world: Pt): boolean {
  const cam = api.view.getCamera();
  const board = api.board.get();
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
  const selected = api.board.getSelected();
  const board = api.board.get();
  let changed = false;
  for (const id of selected) {
    const it = boardGet(board, id);
    if (!it || !isRotatable(it)) continue;
    api.board.setItemRotation(id, normAngle(itemRotation(it) + delta));
    changed = true;
  }
  if (!changed) return false;
  api.board.save();
  render();
  return true;
}

// Find elements one by one on an infinite board: Tab steps through
// the board's elements in board order, selecting each in turn and
// centring the camera on it, so an element far from the current
// view is found without hunting. Shift+Tab steps backwards, and
// the cycle wraps. Pen strokes and connectors are skipped: they
// are drawings and lines, not elements to find. A grouped item
// selects its whole group and centres on the group's bounds.
function navigateElements(dir: 1 | -1): void {
  const board = api.board.get();
  const navigable = board.items.filter((it) => !("Stroke" in it.kind) && !("Connector" in it.kind));
  if (navigable.length === 0) return;
  const selected = api.board.getSelected();
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
  api.board.setSelected(select(board, [], target.id, false));
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
  const cam = api.view.getCamera();
  api.view.setCamera({ x: c.x - bs.x / 2 / cam.zoom, y: c.y - bs.y / 2 / cam.zoom, zoom: cam.zoom });
}

// ---------------------------------------------------------------- input

function attachBoardListeners(): void {
boardEl.addEventListener("pointerdown", (e: PointerEvent) => {
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
      try { pt.onMouseDown(world); } catch (e) { api.ui.toast(`Plugin tool failed: ${String(e)}`); }
      pluginToolDown = true;
      return;
    }
    return;
  }
  if (spaceDown) { drag = { kind: "pan", last: winPt }; return; }
  if (isShapeTool(tool)) {
    drag = { kind: "shape", shape: tool as ShapeKind, start: world, current: world };
    return;
  }
  if (tool === "pen") {
    // A stylus records its pressure per point, so the
    // stroke can thicken and thin with the press; a mouse
    // or finger records none, and draws a uniform stroke.
    drag = { kind: "stroke", points: [world], pressures: e.pointerType === "pen" ? [e.pressure] : [] };
    return;
  }
  if (tool === "select" && lassoMode) {
    drag = { kind: "lasso", points: [world] };
    return;
  }
  if (tool === "eraser") {
    drag = { kind: "erase", erased: false };
    if (eraseAt(world)) drag.erased = true;
    return;
  }
  if (tool === "connector") {
    const hit = api.board.hitTest(world);
    const board = api.board.get();
    const hitItem = hit !== null ? boardGet(board, hit) : null;
    const anchorable = hitItem && !("Stroke" in hitItem.kind) && !("Connector" in hitItem.kind);
    drag = { kind: "connector", from: hitItem && anchorable ? { Item: hitItem.id } : { Point: world }, current: world };
    return;
  }
  // Select tool.
  const now = Date.now();
  const isDoubleClick =
    now - lastPointerDown.t < 500 &&
    Math.hypot(winPt.x - lastPointerDown.x, winPt.y - lastPointerDown.y) < 5;
  lastPointerDown = { x: winPt.x, y: winPt.y, t: now };
  if (isDoubleClick) {
    // Without this, the browser's default mousedown focus runs after
    // this handler and steals focus from a textarea created here, so
    // typing would never land in a new or edited note.
    e.preventDefault();
    const hit = api.board.hitTest(world);
    if (hit !== null) {
      const board = api.board.get();
      const it = boardGet(board, hit);
      if (it && "Plugin" in it.kind && handlePluginCardDoubleClick(it)) return;
      if (it && "Text" in it.kind) { startTextEdit(hit); return; }
      if (it && "UrlCard" in it.kind) { openExternal(it.kind.UrlCard.url); return; }
      if (it && "PdfCard" in it.kind) { openExternal(it.kind.PdfCard.path); return; }
      if (it && "Image" in it.kind) { openExternal(it.kind.Image.path); return; }
    } else {
      const id = api.board.addItemSilent({ Text: { text: "", bold: false, size: 16, color: "#1A1A1A" } }, world, { w: 260, h: 48 });
      // No save here: the commit saves the typed text, or
      // removes the note if it is empty, so an empty note
      // leaves no board change and no undo step behind.
      startTextEdit(id);
      return;
    }
  }
  const clicked = api.board.hitTest(world);
  const selected = api.board.getSelected();
  if (selected.length === 1 && rotateHit(selected[0], world)) {
    const board = api.board.get();
    const it = boardGet(board, selected[0]);
    drag = { kind: "rotate", id: selected[0], origRot: it ? itemRotation(it) : 0, moved: false };
    return;
  }
  if (selected.length === 1 && cornerHit(selected[0], world)) {
    const sel = selected[0];
    const board = api.board.get();
    const it = boardGet(board, sel);
    drag = { kind: "resize", id: sel, startWorld: world, origW: it?.size.w ?? 100, origH: it?.size.h ?? 100, moved: false };
    return;
  }
  if (clicked !== null && cornerHit(clicked, world)) {
    const board = api.board.get();
    api.board.setSelected(select(board, api.board.getSelected(), clicked, false));
    api.board.bringToFront(api.board.getSelected());
    applyStacking();
    updateSelection();
    const it = boardGet(board, clicked);
    drag = { kind: "resize", id: clicked, startWorld: world, origW: it?.size.w ?? 100, origH: it?.size.h ?? 100, moved: false };
    return;
  }
  if (clicked !== null) {
    const board = api.board.get();
    api.board.setSelected(select(board, api.board.getSelected(), clicked, e.shiftKey));
    api.board.bringToFront(api.board.getSelected());
    applyStacking();
    updateSelection();
    drag = { kind: "move", lastWorld: world, moved: false };
    return;
  }
  if (!e.shiftKey) api.board.setSelected([]);
  drag = { kind: "marquee", start: world, current: world };
});

cardsEl.addEventListener("click", (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const link = target.closest("a[data-url]") as HTMLElement | null;
  if (link) { e.preventDefault(); openExternal(link.dataset.url ?? ""); return; }
  const pbtn = target.closest("[data-plugin-action]") as HTMLElement | null;
  if (pbtn) {
    const pid = Number(pbtn.dataset.id);
    const board = api.board.get();
    const pit = boardGet(board, pid);
    if (pit && handlePluginCardAction(pbtn.dataset.pluginAction ?? "", pit)) return;
  }
  const task = target.closest("[data-action=\"toggle-task\"]") as HTMLElement | null;
  if (task) {
    // The browser would toggle the checkbox itself after
    // this click; the re-render below replaces the node, so
    // suppress that and let the text be the state instead.
    e.preventDefault();
    const cardEl = task.closest(".card") as HTMLElement | null;
    const board = api.board.get();
    const it = boardGet(board, Number(cardEl?.dataset.id));
    if (!it || !("Text" in it.kind)) return;
    const lineNo = Number(task.dataset.line);
    const lines = it.kind.Text.text.split("\n");
    const next = toggleTaskLine(lines[lineNo] ?? "");
    if (next === null) return;
    lines[lineNo] = next;
    api.board.setTextContent(it.id, lines.join("\n"));
    api.board.save();
    render();
    return;
  }
  const btn = target.closest("[data-action]") as HTMLElement | null;
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const action = btn.dataset.action;
  const board = api.board.get();
  const it = boardGet(board, id);
  if (!it) return;
  if (action === "open-link" && "UrlCard" in it.kind) openExternal(it.kind.UrlCard.url);
  if (action === "play-audio" && "Audio" in it.kind) api.media.toggleAudio(id, it.kind.Audio.path);
  if ((action === "pdf-prev" || action === "pdf-next") && "PdfCard" in it.kind) {
    const pdfPath = it.kind.PdfCard.path;
    const cur = api.media.getPdfPage(id);
    const nextPage = action === "pdf-prev" ? cur - 1 : cur + 1;
    void api.media.setPdfPage(id, pdfPath, nextPage);
  }
  if (action === "play-video" && "Video" in it.kind) openExternal(it.kind.Video.source);
});

cardsEl.addEventListener("input", (e: Event) => {
  const seek = (e.target as HTMLElement).closest("[data-audio-seek]") as HTMLInputElement | null;
  if (!seek) return;
  const id = Number(seek.dataset.audioSeek);
  const state = api.media.getAudioState();
  if (state.id !== id || !isFinite(state.duration) || state.duration <= 0) return;
  api.media.seekAudio(id, (Number(seek.value) / 1000) * state.duration);
});
}

// Whether a tool id is a shape kind, from the shape table
// the API hands out. The toolbar's shape picker and this
// drag check both read the same table.
function isShapeTool(t: string): boolean {
  return api.shapes.list().some((s) => s.kind === t);
}

function openExternal(target: string): void {
  api.files.openExternal(target).catch((e) => api.ui.toast(`Could not open ${target}: ${String(e)}`));
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
// The live stroke, drawn while the pen is down. A uniform
// stroke is one path; a pen stroke whose pressure varies is
// one line per segment, each at the width its pressure makes,
// so the stroke visibly thickens as it is drawn.
function updateLiveStroke(points: Pt[], pressures: number[]): void {
  const el = dragPreview("live-stroke", "g");
  while (el.firstChild) el.removeChild(el.firstChild);
  if (pressures.length === points.length && strokePressuresVary({ pressures })) {
    for (let i = 0; i + 1 < points.length; i++) {
      const w = pressureWidth(3, (pressures[i] + pressures[i + 1]) / 2);
      el.appendChild(svgEl2("line", { x1: String(points[i].x), y1: String(points[i].y), x2: String(points[i + 1].x), y2: String(points[i + 1].y), stroke: api.pen.getColor(), "stroke-width": String(w), "stroke-linecap": "round" }));
    }
  } else {
    el.appendChild(svgEl2("path", { d: points.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x},${pt.y}`).join(" "), fill: "none", stroke: api.pen.getColor(), "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  }
}
// The lasso loop, drawn live while dragging. The path is
// closed (the Z joins the last point back to the first),
// so the fill shows the region the loop will select.
function updateLassoPreview(points: Pt[]): void {
  const el = dragPreview("lasso-preview", "path");
  el.setAttribute("d", points.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x},${pt.y}`).join(" ") + " Z");
  el.setAttribute("fill", "rgba(0,122,255,0.08)");
  el.setAttribute("stroke", ACCENT);
  el.setAttribute("stroke-width", "1");
}
function updateDraggedCards(ids: number[]): void {
  // Cards are world-space now, so moving one is a style change on
  // its own node — no markdown, no image re-parse, no rebuild.
  const board = api.board.get();
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

function attachWindowListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;

window.addEventListener("pointermove", (e: PointerEvent) => {
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
        const selected = api.board.getSelected();
        if (isSettingsUIOpen() || editingId !== null) {
          boardEl.style.cursor = "default";
        } else if (tool === "pen" || tool === "connector" || isShapeTool(tool) || (tool === "select" && lassoMode)) {
          boardEl.style.cursor = "crosshair";
        } else if (tool === "eraser") {
          // The ring is the cursor while erasing.
          boardEl.style.cursor = "none";
        } else if (spaceDown) {
          boardEl.style.cursor = "grab";
        } else if (selected.length === 1 && rotateHit(selected[0], w)) {
          boardEl.style.cursor = "grab";
        } else if (selected.length === 1 && cornerHit(selected[0], w)) {
          boardEl.style.cursor = "nwse-resize";
        } else if (api.board.hitTest(w) !== null) {
          boardEl.style.cursor = "move";
        } else {
          boardEl.style.cursor = "default";
        }
      });
    }
    // The eraser ring follows the mouse directly, not
    // through the rAF above: it is the cursor, so it must
    // not lag a frame. It shows only over the board itself,
    // never over the toolbar, panels, title bar or settings.
    const overBoard = !(e.target as HTMLElement).closest("#toolbar, #settings-backdrop, #plugin-panels, #title-bar, #plugin-overlays, #plugin-view, input, textarea, select");
    const showRing = tool === "eraser" && overBoard && !isSettingsUIOpen() && editingId === null && getActiveView() === "board";
    updateEraserRing(e.clientX, e.clientY, showRing);
    return;
  }
  boardEl.style.cursor = drag.kind === "resize" ? "nwse-resize" : drag.kind === "rotate" ? "grabbing" : drag.kind === "pan" ? "grabbing" : drag.kind === "move" ? "move" : drag.kind === "erase" ? "none" : "default";
  if (drag.kind === "pan") {
    const cam = api.view.getCamera();
    api.view.setCameraSilent({
      x: cam.x - (winPt.x - drag.last.x) / cam.zoom,
      y: cam.y - (winPt.y - drag.last.y) / cam.zoom,
      zoom: cam.zoom,
    });
    drag.last = winPt;
    applyCamera();
    refreshContentIfVisibleChanged();
  } else if (drag.kind === "move") {
    const dx = world.x - drag.lastWorld.x, dy = world.y - drag.lastWorld.y;
    if (Math.hypot(dx, dy) > 0.5) drag.moved = true;
    api.board.moveItems(api.board.getSelected(), dx, dy);
    drag.lastWorld = world;
    updateDraggedCards(api.board.getSelected());
    renderSvgOnly();
    updateResizeHandle();
  } else if (drag.kind === "resize") {
    const board = api.board.get();
    const it = boardGet(board, drag.id);
    api.board.resizeItem(drag.id, drag.origW + (world.x - drag.startWorld.x), drag.origH + (world.y - drag.startWorld.y));
    if (Math.hypot(world.x - drag.startWorld.x, world.y - drag.startWorld.y) > 2) drag.moved = true;
    updateDraggedCards([drag.id]);
    // Strokes have no card element to resize live, so rebuild
    // the SVG layer instead: the stroke visibly follows the
    // handle, like a card does. Same as the rotate drag below.
    if (it && "Stroke" in it.kind) renderSvgOnly();
    updateResizeHandle();
  } else if (drag.kind === "stroke") {
    const cam = api.view.getCamera();
    const last = drag.points[drag.points.length - 1];
    if (Math.hypot(world.x - last.x, world.y - last.y) > 2 / cam.zoom) {
      drag.points.push(world);
      if (e.pointerType === "pen") drag.pressures.push(e.pressure);
      updateLiveStroke(drag.points, drag.pressures);
    }
  } else if (drag.kind === "lasso") {
    const cam = api.view.getCamera();
    const last = drag.points[drag.points.length - 1];
    if (Math.hypot(world.x - last.x, world.y - last.y) > 2 / cam.zoom) {
      drag.points.push(world);
      updateLassoPreview(drag.points);
    }
  } else if (drag.kind === "erase") {
    if (eraseAt(world)) drag.erased = true;
    updateEraserRing(e.clientX, e.clientY, true);
  } else if (drag.kind === "connector") {
    drag.current = world;
    const a = api.geometry.anchorPoint(drag.from);
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
    const penColor = api.pen.getColor();
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
      el.setAttribute("points", api.shapes.previewPoints(drag.shape, x0, y0, w, h));
      el.setAttribute("fill", penColor); el.setAttribute("fill-opacity", "0.85");
    }
  } else if (drag.kind === "rotate") {
    const board = api.board.get();
    const it = boardGet(board, drag.id);
    if (it) {
      const c = centre(it);
      let deg = Math.atan2(world.y - c.y, world.x - c.x) * 180 / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      const rot = normAngle(deg);
      if (Math.abs(rot - drag.origRot) > 1) drag.moved = true;
      api.board.setItemRotation(drag.id, rot);
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

window.addEventListener("pointerup", (e: PointerEvent) => {
  if (pluginToolDown) {
    pluginToolDown = false;
    const pt = getPluginTool(tool);
    if (pt?.onMouseUp) {
      try { pt.onMouseUp(toWorld(boardPoint(e.clientX, e.clientY))); } catch (err) { api.ui.toast(`Plugin tool failed: ${String(err)}`); }
    }
    return;
  }
  if (!drag) return;
  const world = toWorld(boardPoint(e.clientX, e.clientY));
  const d = drag;
  drag = null;
  if (d.kind === "stroke") {
    if (d.points.length >= 2) {
      const xs = d.points.map((p) => p.x), ys = d.points.map((p) => p.y);
      const pos = { x: Math.min(...xs), y: Math.min(...ys) };
      const size = { w: Math.max(1, Math.max(...xs) - pos.x), h: Math.max(1, Math.max(...ys) - pos.y) };
      api.board.addItem({ Stroke: { points: d.points, color: api.pen.getColor(), width: 3, marker: false, ...(d.pressures.length > 0 ? { pressures: d.pressures } : {}) } }, pos, size);
    }
  } else if (d.kind === "lasso") {
    // A click, not a loop: select what is under the cursor,
    // the way the select tool does. A real loop selects
    // everything it touches. Either way it is only a
    // selection change, never an undo step.
    const xs = d.points.map((p) => p.x), ys = d.points.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    if (d.points.length < 3 || (w < 4 && h < 4)) {
      const hit = api.board.hitTest(world);
      api.board.setSelected(hit !== null ? [hit] : []);
    } else {
      api.board.setSelected(api.board.lassoSelect(d.points));
    }
  } else if (d.kind === "erase") {
    // A sweep that erased anything is one undo step. A
    // click that erased nothing leaves no step behind.
    if (d.erased) api.board.save();
  } else if (d.kind === "connector") {
    const board = api.board.get();
    const to = api.board.hitTest(world);
    const toItem = to !== null ? boardGet(board, to) : null;
    const toAnchorable = toItem && !("Stroke" in toItem.kind) && !("Connector" in toItem.kind);
    const toAnchor: Anchor = toItem && toAnchorable ? { Item: toItem.id } : { Point: world };
    const a = api.geometry.anchorPoint(d.from);
    const degenerate = a !== null && "Point" in toAnchor && Math.hypot(a.x - toAnchor.Point.x, a.y - toAnchor.Point.y) < 4;
    // A connector from a card to itself is a click, not a connection:
    // it renders as a 1x1 invisible item that can never be selected
    // or deleted except by undo, and it pollutes the board JSON.
    const selfConnector = "Item" in d.from && "Item" in toAnchor && d.from.Item === toAnchor.Item;
    if (!degenerate && !selfConnector) {
      const aPt = a ?? { x: 0, y: 0 };
      const bPt = "Point" in toAnchor ? toAnchor.Point : (boardGet(board, toAnchor.Item) ? centre(boardGet(board, toAnchor.Item) as Item) : { x: 0, y: 0 });
      const pos = { x: Math.min(aPt.x, bPt.x), y: Math.min(aPt.y, bPt.y) };
      const size = { w: Math.max(1, Math.abs(bPt.x - aPt.x)), h: Math.max(1, Math.abs(bPt.y - aPt.y)) };
      api.board.addItem({ Connector: { from: d.from, to: toAnchor, color: "#333333" } }, pos, size);
    }
  } else if (d.kind === "shape") {
    const w = Math.abs(world.x - d.start.x), h = Math.abs(world.y - d.start.y);
    if (w >= 10 && h >= 10) {
      const pos = { x: Math.min(d.start.x, world.x), y: Math.min(d.start.y, world.y) };
      api.board.addItem({ Shape: { shape: d.shape, fill: api.pen.getColor() } }, pos, { w, h });
    }
  } else if (d.kind === "rotate") {
    // Apply the final point too: a drag's last mousemove
    // may not be at the mouseup point, so the rotation
    // would otherwise stop one step short of where the
    // user actually released.
    const board = api.board.get();
    const it = boardGet(board, d.id);
    if (it) {
      const c = centre(it);
      let deg = Math.atan2(world.y - c.y, world.x - c.x) * 180 / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      const rot = normAngle(deg);
      if (Math.abs(rot - d.origRot) > 1) d.moved = true;
      api.board.setItemRotation(d.id, rot);
    }
    if (d.moved) api.board.save();
  } else if (d.kind === "marquee") {
    api.board.setSelected(api.board.marqueeSelect(d.start, world));
  } else if (d.kind === "pan") {
    // A Space+drag pan changes only the camera, so it must not
    // become an undo step — but it must reach disk, or closing
    // the window without another save loses the view.
    api.board.saveWithoutUndo();
  } else if (d.kind === "move" || d.kind === "resize") {
    // A drag that actually moved is a board change and an undo
    // step. A click that never moved only brought a card to the
    // front: that stacking change still saves to disk, but it
    // must not become an undo step, or every click would take
    // a Ctrl+Z to get past before the real change undoes.
    if (d.moved) api.board.save();
    else api.board.saveWithoutUndo();
  }
  // A move/resize that actually moved is safe to rebuild once at
  // the end (it refreshes truncation and connector endpoints with
  // their final geometry). A move/resize that never moved was a
  // click, not a drag: rebuilding here would destroy the card
  // button just pressed, so its click would never fire.
  if (d.kind === "stroke" || d.kind === "connector" || d.kind === "marquee" || d.kind === "shape" || d.kind === "lasso" || (d.kind === "erase" && d.erased) || (d.kind === "rotate" && d.moved)) {
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
  // too, for the same reason. A lasso drag ends the same way.
  if (d.kind === "marquee" || d.kind === "lasso") updateSelection();
});

// The ring must not freeze at the edge when the pointer
// leaves the window mid-erase.
document.addEventListener("mouseleave", () => updateEraserRing(0, 0, false));
document.addEventListener("pointerleave", () => updateEraserRing(0, 0, false));

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
        const cam = api.view.getCamera();
        const ratio = cam.zoom / lastZoomRefreshZoom;
        if (now - lastZoomRefreshTime > 250 || ratio > 1.25 || ratio < 0.8) {
          refreshContentIfVisibleChanged();
          lastZoomRefreshZoom = cam.zoom;
          lastZoomRefreshTime = now;
        }
      });
    }
    if (zoomSettleTimer) clearTimeout(zoomSettleTimer);
    zoomSettleTimer = setTimeout(() => {
      refreshContentIfVisibleChanged();
      const cam = api.view.getCamera();
      lastZoomRefreshZoom = cam.zoom;
      lastZoomRefreshTime = performance.now();
      api.board.save();
    }, 120);
    return;
  }
  // Pan follows standard Mac scrolling: scrolling down moves
  // the content up, as in Safari, Notes and every other Mac
  // app. The previous code moved the content with the scroll,
  // which is the opposite of what a Mac trackpad user expects.
  // (Dragging with Space still grabs the paper and moves it
  // with the pointer — that is a grab, not a scroll, and stays.)
  const cam = api.view.getCamera();
  api.view.setCameraSilent({
    x: cam.x + e.deltaX / cam.zoom,
    y: cam.y + e.deltaY / cam.zoom,
    zoom: cam.zoom,
  });
  // Wheel events fire many times a second; writing the whole board
  // JSON on every tick is the worst save cost for a large board.
  // Save once, 400ms after the last wheel event instead. Content
  // edits still save immediately (move/resize mouseup, note commit),
  // and Close saves explicitly before closing.
  if (wheelSaveTimer) clearTimeout(wheelSaveTimer);
  wheelSaveTimer = setTimeout(() => api.board.save(), 400);
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
    void api.files.readFileBase64(path).then(({ mime, base64 }) => {
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

// ---------------------------------------------------------------- keyboard

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
  // Typing in any text input (a plugin's chat or search box,
  // not just the board search) must never trigger board
  // shortcuts: without this, typing "v" in the AI chat
  // switched tools, Backspace deleted the selected card,
  // and a space started panning. Ctrl/Cmd shortcuts,
  // Escape and Tab still work in inputs.
  if (active && active.tagName === "INPUT" && !ctrl0 && e.key !== "Escape" && e.key !== "Tab") return;
  // Settings open means the board is not listening: without this,
  // Delete deleted the selected card behind the sheet, v/p/a
  // switched tools, and +/- zoomed, all while the user thought
  // they were in Settings. Esc still closes the sheet (handled
  // below), and Tab keeps its normal focus job in the sheet.
  if (isSettingsUIOpen() && e.key !== "Escape" && e.key !== "Tab") return;
  // Tab cycles elements, unless Settings is open, where Tab keeps
  // its normal job of moving focus around the sheet.
  if (e.key === "Tab" && !isSettingsUIOpen()) {
    // Tab in a text input keeps its normal focus job too: a
    // panel input (a section rename, a tag box, a search)
    // commits on blur, and Tab is how the user leaves it.
    // Cycling here would steal the blur — the rename would
    // never commit — and the selection with it.
    if (active && active.tagName === "INPUT") return;
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
    if (searchInput && searchInput.value.trim() !== "") { api.search.clear(); return; }
    api.board.setSelected([]);
    render();
    return;
  }
  // Ctrl+Z in a text input is text undo, not board undo: the
  // search box is already guarded above, and this covers plugin
  // inputs like the Visual Library search. Without the guard,
  // Ctrl+Z there would undo a board change instead of the text.
  if (e.key.toLowerCase() === "z" && ctrl && !e.shiftKey && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    api.board.undo();
  } else if (e.key.toLowerCase() === "z" && ctrl && e.shiftKey && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    api.board.redo();
  } else if (e.key.toLowerCase() === "y" && ctrl && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    api.board.redo();
  } else if (e.key.toLowerCase() === "v" && !ctrl) setTool("select");
  else if (e.key.toLowerCase() === "p" && !ctrl) setTool("pen");
  else if (e.key.toLowerCase() === "a" && !ctrl) setTool("connector");
  else if (e.key.toLowerCase() === "r" && !ctrl) setTool("rect");
  else if (e.key.toLowerCase() === "e" && !ctrl) setTool("ellipse");
  else if (e.key.toLowerCase() === "l" && !ctrl) {
    // L toggles lasso mode on the select tool: from any
    // other tool it switches to Select with lasso on; on
    // Select it flips the mode. V, or any other tool
    // switch, turns it off again (setTool clears it).
    const next = tool !== "select" || !lassoMode;
    setTool("select");
    lassoMode = next;
  }
  else if (e.key.toLowerCase() === "x" && !ctrl) setTool("eraser");
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
  } else if (e.key === "+" || e.key === "=") { zoomCentre(1.2); api.board.save(); render(); }
  else if (e.key === "-") { zoomCentre(1 / 1.2); api.board.save(); render(); }
  else if (e.key === "0") { api.view.setCamera({ x: 0, y: 0, zoom: 1 }); }
  else if (e.key.toLowerCase() === "f" && !ctrl) zoomToFit();
  // Plugin shortcuts, last: core keys above win, so a plugin cannot
  // steal V, P, A, Ctrl+G/U, Delete, zoom or reset. The core guards
  // above (textarea, search box, Settings open) already applied.
  else if (editingId === null && !isSettingsUIOpen() && !ctrl && handlePluginShortcut(e.key)) { /* plugin handled it */ }
});
window.addEventListener("keyup", (e: KeyboardEvent) => {
  if (e.key === " ") spaceDown = false;
});
}

// ---------------------------------------------------------------- activation

export function activate(a: PluginContext): void {
  api = a;
  boardEl = document.createElement("div");
  boardEl.id = "board";
  boardEl.innerHTML = `
    <div id="grid"></div>
    <svg id="canvas-svg"><g id="world"></g></svg>
    <div id="cards"></div>
    <div id="plugin-view" style="display:none"></div>
    <div id="plugin-overlays"></div>
    <div id="view-switcher" style="display:none"></div>
    <div id="resize-handle" aria-hidden="true"></div>
    <div id="rotate-handle" aria-hidden="true"></div>
    <div id="toast"></div>`;
  // The board sits inside the main column, below the title
  // bar (which the core-titlebar plugin inserts before it).
  // Append it to the main column element.
  const mainColumn = document.getElementById("main-column");
  if (mainColumn) mainColumn.appendChild(boardEl);
  else document.body.appendChild(boardEl);

  const grid = boardEl.querySelector<HTMLElement>("#grid");
  const canvasSvg = boardEl.querySelector<HTMLElement>("#canvas-svg");
  const cards = boardEl.querySelector<HTMLElement>("#cards");
  const resizeHandle = boardEl.querySelector<HTMLElement>("#resize-handle");
  const rotateHandle = boardEl.querySelector<HTMLElement>("#rotate-handle");
  const pluginView = boardEl.querySelector<HTMLElement>("#plugin-view");
  const overlays = boardEl.querySelector<HTMLElement>("#plugin-overlays");
  const viewSwitcher = boardEl.querySelector<HTMLElement>("#view-switcher");
  const toast = boardEl.querySelector<HTMLElement>("#toast");
  if (grid && canvasSvg && cards && resizeHandle && rotateHandle && pluginView && overlays && viewSwitcher && toast) {
    gridEl = grid as HTMLDivElement;
    // The SVG world group, inside the canvas SVG.
    const w = canvasSvg.querySelector("#world") as unknown as SVGGElement | null;
    if (w) worldEl = w;
    cardsEl = cards as HTMLDivElement;
    // Hand the plugin system the board DOM elements, so the
    // core reads them back through the shell instead of
    // querying them by id.
    api.ui.setBoardElements({
      board: boardEl,
      canvas: [grid, canvasSvg, cards, resizeHandle, rotateHandle],
      pluginView,
      overlays,
      viewSwitcher,
      toast,
    });
  }

  // The board controller: the core delegates its render,
  // selection, editing and tool calls here (see
  // src/plugins.ts). Registered now, so the core's host
  // methods and the undo store reach this plugin from the
  // first render after activation.
  registerBoardController({
    render,
    updateSelection,
    commitEditing: commitEditingIfAny,
    clearEditing: () => { editingId = null; },
    getEditingId: () => editingId,
    setTool,
    getTool: () => tool,
    groupSelected,
    ungroupSelected,
    deleteSelected,
  });

  // The board's own listeners: the board DOM exists now,
  // and the window listeners attach once, here, so they
  // never run before the board does.
  attachBoardListeners();
  attachWindowListeners();
}

export function deactivate(): void {
  boardEl?.remove();
}
