// Electron preload API (see electron/preload.js). The renderer never
// touches Node or Electron directly; every privileged call goes through
// this bridge, which the main process exposes with context isolation on.
interface BowerbirdAPI {
  isDemo: boolean;
  loadBoard(): Promise<{ json: string | null; board_path: string; board_dir: string; pdf_size_bytes: number; video_size_bytes: number }>;
  saveBoard(json: string): Promise<void>;
  resetBoard(): Promise<{ pdf_size_bytes: number; video_size_bytes: number }>;
  embedFile(path: string): Promise<string>;
  listLibrary(): Promise<{ path: string; items: Array<{ name: string; path: string; relativePath: string; ext: string; kind: string; category: string | null; size_bytes: number; mtime_ms: number }>; categories: Array<{ name: string; count: number }>; uncategorizedCount: number }>;
  addToLibrary(path: string): Promise<string>;
  createLibraryCategory(name: string): Promise<string>;
  moveLibraryItem(relativePath: string, category: string | null): Promise<string>;
  readTextFile(path: string): Promise<string>;
  fileSize(path: string): Promise<number>;
  fetchPreview(url: string): Promise<{ title: string | null; description: string | null; image: string | null; icon: string | null }>;
  openExternal(target: string): Promise<void>;
  getAppSettings(): Promise<{ corner: string }>;
  setCorner(corner: string): Promise<string>;
  collapse(): Promise<void>;
  restore(): Promise<void>;
  moveWindow(dx: number, dy: number): void;
  minimise(): Promise<void>;
  closeWindow(): Promise<void>;
  quit(): Promise<void>;
  fullscreen(): Promise<void>;
  getPathForFile(file: File): string;
  fileUrl(path: string): string;
  listPlugins(): Promise<PluginManifest[]>;
  readPluginFile(pluginId: string, relativePath: string): Promise<string>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean>;
  pluginStorageGet(pluginId: string, key: string): Promise<unknown>;
  pluginStorageSet(pluginId: string, key: string, value: unknown): Promise<void>;
  pluginStorageDelete(pluginId: string, key: string): Promise<void>;
}
declare global {
  interface Window { bowerbird: BowerbirdAPI }
}
const api = window.bowerbird;
import {
  Anchor, Board, GRID, Item, Pt,
  anchorPoint, boardGet, centre, clippedEnds, domainOf, elide, escapeHtml, estimateTextHeight,
  hitTest, itemBounds, marquee, moveSelection, normaliseHex, parseHex, renderMarkdownHtml,
  resizeItem, select, tileColorFor, tint,
} from "./model";
import { welcomeBoard } from "./welcome";
import {
  emitPluginEvent, getActiveView, getCardHtml, getCardRenderer, getPluginCardSearchText,
  getPluginTool, handlePluginCardAction, handlePluginCardDoubleClick, handlePluginShortcut,
  initPlugins, listLoadedPlugins, listPluginCommands, listPluginShortcuts,
  refreshActiveView, renderSettingsSections, runPluginCommand,
  setPluginEnabled, syncPluginToolButtons,
  type PluginHost, type PluginManifest,
} from "./plugins";

// ---------------------------------------------------------------- state

// Core tools are select/pen/connector. Plugin tools are strings of
// the form "plugin:<pluginId>:<toolId>" (see src/plugins.ts); the
// type stays open so a plugin tool is a valid Tool.
type Tool = string;
const PALETTE = ["#1A1A1A", "#E63946", "#2E86AB", "#FF6B35", "#6A4C93", "#2A9D8F"];
const ACCENT = "#007AFF";

const SHORTCUTS: Array<[string, string]> = [
  ["V", "Select tool"],
  ["P", "Pen tool"],
  ["A", "Arrow (connector) tool"],
  ["Delete / Backspace", "Delete the selection"],
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
  | { kind: "resize"; id: number; startWorld: Pt; origW: number; origH: number; moved: boolean } = null;
let pluginToolDown = false;
let audioEl: HTMLAudioElement | null = null;
let audioId: number | null = null;
const audioDurations = new Map<string, number>();
const audioProbing = new Set<string>();
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
function loadAudioDuration(id: number, path: string): void {
  if (audioDurations.has(path) || audioProbing.has(path)) return;
  audioProbing.add(path);
  const probe = new Audio(api.fileUrl(path));
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
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let wheelSaveTimer: ReturnType<typeof setTimeout> | null = null;
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
  // Demo mode saves nothing: not even an IPC call, so a main-process
  // guard failure alone could never write. The main process also
  // no-ops save-board in demo mode, as a second guard.
  if (DEMO) return;
  api.saveBoard(JSON.stringify(board)).catch((e) => toast(`Save failed: ${String(e)}`));
  emitPluginEvent("board");
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
    if (!isVisibleItem(item, v)) continue;
    if ("Stroke" in item.kind) {
      const { points, color, width, marker } = item.kind.Stroke;
      if (points.length < 2) continue;
      const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
      const sel = selected.includes(item.id);
      if (sel) {
        worldEl.appendChild(svgEl2("path", { d, fill: "none", stroke: ACCENT, "stroke-width": String(width + 6), "stroke-linecap": "round", "stroke-linejoin": "round" }));
      }
      const path = svgEl2("path", { d, fill: "none", stroke: color, "stroke-width": String(width), "stroke-linecap": "round", "stroke-linejoin": "round" });
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
    const style0 = `left:${num(item.pos.x, 0)}px;top:${num(item.pos.y, 0)}px;width:${ww0}px;height:${hh0}px;`;
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
  const style = `left:${num(item.pos.x, 0)}px;top:${num(item.pos.y, 0)}px;width:${ww}px;height:${hh}px;`;
  if ("Text" in item.kind) {
    if (!plain && editingId === id) return ""; // the editor DOM is managed separately
    const { text, size, color } = item.kind.Text;
    const safeSize = num(size, 16);
    return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner note-body" style="font-size:${safeSize}px;color:${safeColor(color, "#1A1A1A")}">${cachedMarkdown(item, text, safeSize)}</div></div>`;
  }
  if ("Image" in item.kind) {
    const { path } = item.kind.Image;
    return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner"><img src="${api.fileUrl(path)}" draggable="false" style="width:100%;height:100%;object-fit:cover;border-radius:12px" alt="" /></div></div>`;
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
  if ("PdfCard" in item.kind) {
    const { path, size_bytes } = item.kind.PdfCard;
    const name = path.split("/").pop() ?? path;
    const kb = Math.round(num(size_bytes, 0) / 1024);
    return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">
      <div class="tile" style="background:${tint("#E63946", 0.88)};color:#E63946;font-size:13px">PDF</div>
      <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 92, 14, true))}</div><div class="sub" style="font-size:12px">${kb} KB</div></div></div></div>`;
  }
  if ("Swatch" in item.kind) {
    const { hex } = item.kind.Swatch;
    return `<div class="${cls}" data-id="${id}" style="${style};background:${safeColor(hex, "#1A1A1A")}"><div class="swatch-pill">${escapeHtml(safeColor(hex, "#1A1A1A"))}</div></div>`;
  }
  if ("Audio" in item.kind) {
    const { path } = item.kind.Audio;
    const name = path.split("/").pop() ?? path;
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
          <video controls preload="metadata" playsinline src="${src}" style="width:${ww - 24}px;height:${thumbH}px;object-fit:cover;border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
          <div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 24, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
      }
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">
        <video controls preload="metadata" playsinline src="${src}" style="width:96px;height:56px;object-fit:cover;border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
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

function updateResizeHandle(): void {
  const el = document.getElementById("resize-handle") as HTMLDivElement;
  if (selected.length !== 1 || settingsOpen || editingId !== null) { el.style.display = "none"; return; }
  const it = boardGet(board, selected[0]);
  if (!it || "Connector" in it.kind) { el.style.display = "none"; return; }
  const [p, s] = itemBounds(board, it);
  const screen = toScreen({ x: p.x + s.w, y: p.y + s.h });
  const bs = boardSize();
  if (screen.x < 0 || screen.y < 0 || screen.x > bs.x || screen.y > bs.y) {
    el.style.display = "none"; return;
  }
  el.style.left = `${screen.x}px`;
  el.style.top = `${screen.y}px`;
  el.style.display = "block";
}

function updateToolbar(): void {
  // render() runs on every mousemove; rebuilding the toolbar's DOM
  // every time is wasted work when nothing about it changed.
  const key = `${tool}|${selected.length}|${penColor}`;
  if (key === lastToolbarKey) return;
  lastToolbarKey = key;
  const setActive = (id: string, on: boolean) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", on);
  };
  setActive("tool-select", tool === "select");
  setActive("tool-pen", tool === "pen");
  setActive("tool-connector", tool === "connector");
  syncPluginToolButtons(tool);
  const palette = document.getElementById("palette") as HTMLDivElement;
  palette.style.display = tool === "pen" ? "flex" : "none";
  if (tool === "pen" && palette.childElementCount === 0) {
    for (const hex of PALETTE) {
      const b = document.createElement("div");
      b.className = "swatch" + (hex === penColor ? " active" : "");
      b.style.background = hex;
      b.title = hex;
      b.addEventListener("click", () => { penColor = hex; render(); });
      palette.appendChild(b);
    }
  }
  if (tool === "pen") {
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
    el.classList.toggle("selected", selected.includes(Number(el.dataset.id)));
  }
  const del = document.getElementById("btn-delete") as HTMLButtonElement;
  del.classList.toggle("dim", selected.length === 0);
  // Selection changes without a full render (a plain click) still
  // need the resize handle to appear / disappear immediately.
  updateResizeHandle();
}

function updateSelection(): void {
  updateSelectionInner();
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
  editingId = id;
  render();
  const card = cardsEl.querySelector(`[data-id="${id}"]`);
  if (!card) return;
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
  const tol = 16 / cam.zoom;
  return world.x >= p.x + s.w - tol && world.x <= p.x + s.w + tol &&
    world.y >= p.y + s.h - tol && world.y <= p.y + s.h + tol;
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
      save();
      startTextEdit(id);
      return;
    }
  }
  const clicked = hitTestWithFrames(board, world);
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
        } else if (tool === "pen" || tool === "connector") {
          boardEl.style.cursor = "crosshair";
        } else if (spaceDown) {
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
  boardEl.style.cursor = drag.kind === "resize" ? "nwse-resize" : drag.kind === "pan" ? "grabbing" : drag.kind === "move" ? "move" : "default";
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
    if (!degenerate) {
      const id = allocId();
      const aPt = a ?? { x: 0, y: 0 };
      const bPt = "Point" in toAnchor ? toAnchor.Point : (boardGet(board, toAnchor.Item) ? centre(boardGet(board, toAnchor.Item) as Item) : { x: 0, y: 0 });
      board.items.push({ id, pos: { x: Math.min(aPt.x, bPt.x), y: Math.min(aPt.y, bPt.y) }, size: { w: Math.max(1, Math.abs(bPt.x - aPt.x)), h: Math.max(1, Math.abs(bPt.y - aPt.y)) }, group: null, kind: { Connector: { from: d.from, to: toAnchor, color: "#333333" } } });
      save();
    }
  } else if (d.kind === "marquee") {
    selected = marquee(board, d.start, world);
  } else if (d.kind === "move" || d.kind === "resize") {
    save();
  }
  // A move/resize that actually moved is safe to rebuild once at
  // the end (it refreshes truncation and connector endpoints with
  // their final geometry). A move/resize that never moved was a
  // click, not a drag: rebuilding here would destroy the card
  // button just pressed, so its click would never fire.
  if (d.kind === "stroke" || d.kind === "connector" || d.kind === "marquee") {
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
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(boardPoint(e.clientX, e.clientY), factor);
  } else {
    // Pan follows standard Mac scrolling: scrolling down moves
    // the content up, as in Safari, Notes and every other Mac
    // app. The previous code moved the content with the scroll,
    // which is the opposite of what a Mac trackpad user expects.
    // (Dragging with Space still grabs the paper and moves it
    // with the pointer — that is a grab, not a scroll, and stays.)
    board.camera.x += e.deltaX / board.camera.zoom;
    board.camera.y += e.deltaY / board.camera.zoom;
  }
  // Wheel events fire many times a second; writing the whole board
  // JSON on every tick is the worst save cost for a large board.
  // Save once, 400ms after the last wheel event instead. Content
  // edits still save immediately (move/resize mouseup, note commit),
  // and Quit saves explicitly before closing.
  if (wheelSaveTimer) clearTimeout(wheelSaveTimer);
  wheelSaveTimer = setTimeout(() => save(), 400);
  applyCamera();
  refreshContentIfVisibleChanged();
}, { passive: false });

window.addEventListener("resize", () => { applyCamera(); refreshContentIfVisibleChanged(); });

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
  audioEl = new Audio(api.fileUrl(path));
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
  if (e.key.toLowerCase() === "v" && !ctrl) setTool("select");
  else if (e.key.toLowerCase() === "p" && !ctrl) setTool("pen");
  else if (e.key.toLowerCase() === "a" && !ctrl) setTool("connector");
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
document.getElementById("zoom-in")?.addEventListener("click", () => { zoomCentre(1.2); save(); render(); });
document.getElementById("zoom-out")?.addEventListener("click", () => { zoomCentre(1 / 1.2); save(); render(); });
document.getElementById("btn-delete")?.addEventListener("click", () => {
  if (selected.length === 0) return;
  board.items = board.items.filter((it) => !selected.includes(it.id));
  selected = [];
  save(); render();
});

// ---------------------------------------------------------------- search

function searchText(item: Item): string {
  const k = item.kind;
  const base = (p: string) => p.split("/").pop() ?? p;
  if ("Text" in k) return k.Text.text;
  if ("UrlCard" in k) return [k.UrlCard.title ?? "", k.UrlCard.description ?? "", k.UrlCard.url].join(" ");
  if ("Image" in k) return base(k.Image.path);
  if ("PdfCard" in k) return base(k.PdfCard.path);
  if ("Audio" in k) return base(k.Audio.path);
  if ("Video" in k) return base(k.Video.source);
  if ("Swatch" in k) return k.Swatch.hex;
  if ("Plugin" in k) {
    const pt = getPluginCardSearchText(item);
    return pt ?? `${k.Plugin.plugin} ${k.Plugin.kind}`;
  }
  return "";
}

function updateSearch(): void {
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  const countEl = document.getElementById("search-count") as HTMLSpanElement | null;
  const clearEl = document.getElementById("search-clear") as HTMLButtonElement | null;
  if (!input || !countEl || !clearEl) return;
  const query = input.value.trim().toLowerCase();
  clearEl.style.display = query === "" ? "none" : "flex";
  if (query === "") {
    const hadMatches = searchMatches.length > 0;
    searchMatches = [];
    searchIndex = -1;
    countEl.textContent = "";
    if (!hadMatches) return;
    for (const child of Array.from(cardsEl.children)) {
      (child as HTMLElement).classList.remove("search-match", "search-dim");
    }
    return;
  }
  searchMatches = board.items
    .filter((it) => !("Stroke" in it.kind) && !("Connector" in it.kind) && searchText(it).toLowerCase().includes(query))
    .map((it) => it.id);
  if (searchIndex >= searchMatches.length) searchIndex = -1;
  const matchSet = new Set(searchMatches);
  for (const child of Array.from(cardsEl.children)) {
    const el = child as HTMLElement;
    const id = Number(el.dataset.id);
    el.classList.toggle("search-match", matchSet.has(id));
    el.classList.toggle("search-dim", !matchSet.has(id));
  }
  if (searchMatches.length === 0) countEl.textContent = "No matches";
  else if (searchIndex >= 0) countEl.textContent = `${searchIndex + 1} of ${searchMatches.length}`;
  else countEl.textContent = searchMatches.length === 1 ? "1 match" : `${searchMatches.length} matches`;
}

function clearSearch(): void {
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (input) input.value = "";
  searchMatches = [];
  searchIndex = -1;
  updateSearch();
}

function jumpToSearch(dir: 1 | -1): void {
  if (searchMatches.length === 0) return;
  const next = searchIndex === -1
    ? (dir === 1 ? 0 : searchMatches.length - 1)
    : (searchIndex + dir + searchMatches.length) % searchMatches.length;
  searchIndex = next;
  const target = boardGet(board, searchMatches[next]);
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

document.getElementById("search-input")?.addEventListener("input", () => {
  // A new query restarts the jump position: Enter always starts
  // from the first match of what is actually typed now.
  searchIndex = -1;
  updateSearch();
});
document.getElementById("search-input")?.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    jumpToSearch(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    clearSearch();
    (e.target as HTMLInputElement).blur();
  }
});
document.getElementById("search-clear")?.addEventListener("click", () => {
  clearSearch();
  document.getElementById("search-input")?.focus();
});

document.getElementById("btn-quit")?.addEventListener("click", async () => {
  // Commit any note being edited, save, then quit. closeWindow
  // closes the only window, and the main process quits on
  // window-all-closed, so this is a full app quit.
  commitEditingIfAny();
  if (!DEMO) { try { await api.saveBoard(JSON.stringify(board)); } catch { /* closing anyway */ } }
  setSettings(false);
  api.quit().catch(() => undefined);
});
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
  const commands = listPluginCommands();
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
  };
  let html = "";
  for (const lp of plugins) {
    const m = lp.manifest;
    const state = lp.failed ? "Failed" : lp.active ? "On" : "Off";
    const cmds = commands.filter((c) => c.pluginId === m.id);
    html += `<div class="plugin-row"><div class="plugin-row-text"><div><strong>${escapeHtml(m.name)}</strong> <span class="meta">${state}</span></div>`;
    const desc = descriptions[m.id];
    if (desc) html += `<p class="meta">${desc}</p>`;
    if (lp.failed && lp.error) html += `<p class="meta"><strong>${escapeHtml(lp.error)}</strong></p>`;
    html += `</div><button data-plugin-toggle="${m.id}">${lp.active ? "Disable" : "Enable"}</button>`;
    for (const c of cmds) {
      if (!lp.active) continue;
      html += ` <button data-plugin-command="${m.id}:${c.id}">Run: ${escapeHtml(c.title)}</button>`;
    }
    html += `</div>`;
  }
  list.innerHTML = html;
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
  for (const btn of Array.from(list.querySelectorAll("[data-plugin-command]"))) {
    btn.addEventListener("click", async () => {
      const [pid, cid] = ((btn as HTMLElement).dataset.pluginCommand ?? "").split(":");
      if (!pid || !cid) return;
      await runPluginCommand(pid, cid);
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
    renderPluginSettingsSections();
    renderPluginSettings();
    setSettingsTab("general");
  }
  render();
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
      save(); render();
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
        board.items.push({ id, pos: at, size: { w: 260, h: 96 }, group: null, kind: { PdfCard: { path: stored, size_bytes: size } } });
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
  try {
    const loaded = await api.loadBoard();
    boardDir = loaded.board_dir;
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
  } catch (err) {
    toast(`Could not load the board: ${String(err)}`);
    board = welcomeBoard(boardDir, 0, 0);
  }
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
    setTool: (toolName: string) => setTool(toolName),
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
    ],
    viewSwitcherEl: document.getElementById("view-switcher") as HTMLElement,
    overlaysEl: document.getElementById("plugin-overlays") as HTMLElement,
    settingsSectionsEl: document.getElementById("plugin-settings-sections") as HTMLElement,
  };
  await initPlugins(pluginHost, api);
  render();
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
        if (changed) { save(); render(); }
      } catch { /* keep the domain card */ }
    })());
  }
  await Promise.all(jobs);
}

void init();
