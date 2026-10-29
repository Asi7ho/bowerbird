// Electron preload API (see electron/preload.js). The renderer never
// touches Node or Electron directly; every privileged call goes through
// this bridge, which the main process exposes with context isolation on.
interface BowerbirdAPI {
  loadBoard(): Promise<{ json: string | null; board_path: string; board_dir: string; pdf_size_bytes: number; video_size_bytes: number }>;
  saveBoard(json: string): Promise<void>;
  resetBoard(): Promise<{ pdf_size_bytes: number; video_size_bytes: number }>;
  embedFile(path: string): Promise<string>;
  readTextFile(path: string): Promise<string>;
  fileSize(path: string): Promise<number>;
  fetchPreview(url: string): Promise<{ title: string | null; description: string | null; image: string | null; icon: string | null }>;
  openExternal(target: string): Promise<void>;
  getAppSettings(): Promise<{ corner: string }>;
  setCorner(corner: string): Promise<string>;
  collapse(): Promise<void>;
  minimise(): Promise<void>;
  closeWindow(): Promise<void>;
  quit(): Promise<void>;
  fullscreen(): Promise<void>;
  getPathForFile(file: File): string;
  fileUrl(path: string): string;
}
declare global {
  interface Window { bowerbird: BowerbirdAPI }
}
const api = window.bowerbird;
import {
  Anchor, Board, GRID, Item, Pt,
  anchorPoint, boardGet, centre, clippedEnds, domainOf, elide, estimateTextHeight,
  hitTest, itemBounds, marquee, moveSelection, normaliseHex, parseHex, renderMarkdownHtml,
  resizeItem, select, tileColorFor, tint,
} from "./model";

// ---------------------------------------------------------------- state

type Tool = "select" | "pen" | "connector";
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
  ["H", "Hide the board (minimise)"],
  ["?", "Open settings"],
  ["Esc", "Close settings, commit a note, or clear the selection"],
  ["Tab", "Go to the next element"],
  ["Shift + Tab", "Go to the previous element"],
  ["Double-click empty space", "New note"],
  ["Double-click a note", "Edit it in place"],
  ["Click a link card", "Open it in your browser"],
  ["Double-click a link card", "Open it in your browser"],
  ["Double-click a PDF or picture", "Open it outside Bowerbird"],
  ["Click a play tile", "Play audio / video"],
  ["Drag a card corner", "Resize the card (nwse cursor on hover)"],
  ["Click the corner button", "Hide the board into its corner"],
  ["Click the board's corner", "Open the board again"],
  ["Shift + click", "Add to the selection"],
  ["Drag on empty space", "Marquee-select"],
  ["Ctrl / Cmd + V", "Paste a link as a card"],
];

let board: Board = {
  items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 0, next_group: 0,
  bg: "#FFFFFF", grid: "Dots",
};
let boardPath = "";
let boardDir = "";
let tool: Tool = "select";
let penColor = PALETTE[0];
let selected: number[] = [];
let spaceDown = false;
let editingId: number | null = null;
let settingsOpen = false;
let cornerReveal = "bottom-left";
let drag: null
  | { kind: "pan"; last: Pt }
  | { kind: "move"; lastWorld: Pt; moved: boolean }
  | { kind: "stroke"; points: Pt[] }
  | { kind: "connector"; from: Anchor; current: Pt }
  | { kind: "marquee"; start: Pt; current: Pt }
  | { kind: "resize"; id: number; startWorld: Pt; origW: number; origH: number; moved: boolean } = null;
let audioEl: HTMLAudioElement | null = null;
let audioId: number | null = null;
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
function zoomAt(screen: Pt, factor: number): void {
  const before = toWorld(screen);
  board.camera.zoom = Math.max(0.1, Math.min(8, board.camera.zoom * factor));
  const after = toWorld(screen);
  board.camera.x += before.x - after.x;
  board.camera.y += before.y - after.y;
}
function zoomCentre(factor: number): void {
  zoomAt({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, factor);
}
function save(): void {
  api.saveBoard(JSON.stringify(board)).catch((e) => toast(`Save failed: ${String(e)}`));
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

function bringToFront(ids: number[]): void {
  // Later items paint on top, so a clicked card (and its group) comes
  // to the front.
  const front = board.items.filter((it) => ids.includes(it.id));
  const rest = board.items.filter((it) => !ids.includes(it.id));
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
  while ((window.innerWidth / cam.zoom) / step > 40 || (window.innerHeight / cam.zoom) / step > 40) step *= 2;
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

function cardHtml(item: Item): string {
  const sel = selected.includes(item.id);
  const cls = sel ? "card selected" : "card";
  // Cards live in world coordinates; the whole #cards layer is
  // transformed once by the camera (see applyCamera). Per-card
  // screen positions and per-card scale transforms used to force a
  // full reposition of every card on every pan/zoom frame — that
  // was the main source of lag. Content still scales with zoom,
  // because the layer itself is scaled.
  const ww = item.size.w, hh = item.size.h;
  const style = `left:${item.pos.x}px;top:${item.pos.y}px;width:${ww}px;height:${hh}px;`;
  if ("Text" in item.kind) {
    if (editingId === item.id) return ""; // the editor DOM is managed separately
    const { text, size, color } = item.kind.Text;
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner note-body" style="font-size:${size}px;color:${color}">${renderMarkdownHtml(text, size)}</div></div>`;
  }
  if ("Image" in item.kind) {
    const { path } = item.kind.Image;
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner"><img src="${api.fileUrl(path)}" draggable="false" style="width:100%;height:100%;object-fit:cover;border-radius:12px" alt="" /></div></div>`;
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
    const footer = `<div class="link-footer"><a class="link-domain" data-action="open-link" data-id="${item.id}">${ico ? `<img class="favicon" src="${esc(ico)}" alt="" onerror="this.style.display='none';var f=this.nextElementSibling;if(f)f.style.display='flex'" /><span class="favicon-fallback" style="display:none;background:${tint(tile, 0.85)};color:${tile}">${initial}</span>` : `<span class="favicon-fallback" style="background:${tint(tile, 0.85)};color:${tile}">${initial}</span>`}<span>${domain}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg></a></div>`;
    if (img) {
      return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner link-card">
        <a class="link-image" data-action="open-link" data-id="${item.id}"><img src="${esc(img)}" draggable="false" alt="" onerror="this.closest('.link-image').style.display='none'" /></a>
        <div class="link-body">
          <a class="link-title" data-action="open-link" data-id="${item.id}">${esc(head)}</a>
          ${description ? `<div class="link-desc">${esc(description)}</div>` : ""}
          ${footer}
        </div></div></div>`;
    }
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner link-card no-image">
      <div class="link-body">
        <a class="link-title" data-action="open-link" data-id="${item.id}">${esc(head)}</a>
        ${description ? `<div class="link-desc">${esc(description)}</div>` : ""}
        ${footer}
      </div></div></div>`;
  }
  if ("PdfCard" in item.kind) {
    const { path, size_bytes } = item.kind.PdfCard;
    const name = path.split("/").pop() ?? path;
    const kb = Math.round(size_bytes / 1024);
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner row" style="padding:12px">
      <div class="tile" style="background:${tint("#E63946", 0.88)};color:#E63946;font-size:13px">PDF</div>
      <div class="col"><div class="title" style="font-size:14px">${elide(name, ww - 92, 14, true)}</div><div class="sub" style="font-size:12px">${kb} KB</div></div></div></div>`;
  }
  if ("Swatch" in item.kind) {
    const { hex } = item.kind.Swatch;
    return `<div class="${cls}" data-id="${item.id}" style="${style};background:${hex}"><div class="swatch-pill">${hex}</div></div>`;
  }
  if ("Audio" in item.kind) {
    const { path } = item.kind.Audio;
    const name = path.split("/").pop() ?? path;
    const playing = audioId === item.id && audioEl && !audioEl.paused;
    const bars = [5, 9, 13, 7, 15, 11, 6, 13, 17, 10, 8, 14, 6, 12, 9, 5, 10, 13].map((bh, i) => `<i style="height:${bh}px;background:${i % 3 === 0 ? "#b8a6cc" : "#6a4c93"}"></i>`).join("");
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner row" style="padding:12px">
      <div class="audio-tile clickable" data-action="play-audio" data-id="${item.id}" style="background:${tint("#6A4C93", 0.88)};color:#6a4c93;font-size:18px">${playing ? "❚❚" : "▶"}</div>
      <div class="col"><div class="title" style="font-size:14px">${elide(name, ww - 92, 14, true)}</div><div class="wave">${bars}</div>${playing ? `<div class="sub" style="font-size:12px">Now playing</div>` : ""}</div></div></div>`;
  }
  if ("Video" in item.kind) {
    const { source, remote, size_bytes } = item.kind.Video;
    const name = remote ? domainOf(source) : (source.split("/").pop() ?? source);
    const sub = remote ? "Video link" : `${Math.round(size_bytes / 1024)} KB`;
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
        return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
          <video controls preload="metadata" playsinline src="${src}" style="width:${ww - 24}px;height:${thumbH}px;object-fit:cover;border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
          <div class="title" style="font-size:14px">${elide(name, ww - 24, 14, true)}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
      }
      return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner row" style="padding:12px">
        <video controls preload="metadata" playsinline src="${src}" style="width:96px;height:56px;object-fit:cover;border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
        <div class="col"><div class="title" style="font-size:14px">${elide(name, ww - 132, 14, true)}</div><div class="sub" style="font-size:12px">${sub}</div></div></div></div>`;
    }
    if (hh >= thumbH + 70) {
      return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
        <div class="video-thumb clickable" data-action="play-video" data-id="${item.id}" style="width:${ww - 24}px;height:${thumbH}px;font-size:28px">▶</div>
        <div class="title" style="font-size:14px">${elide(name, ww - 24, 14, true)}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
    }
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner row" style="padding:12px">
      <div class="video-thumb clickable" data-action="play-video" data-id="${item.id}" style="width:96px;height:56px;font-size:20px">▶</div>
      <div class="col"><div class="title" style="font-size:14px">${elide(name, ww - 132, 14, true)}</div><div class="sub" style="font-size:12px">${sub}</div></div></div></div>`;
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
    x1: cam.x + window.innerWidth / cam.zoom + m,
    y1: cam.y + window.innerHeight / cam.zoom + m,
  };
}
function isVisibleItem(item: Item, v: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const [p, s] = itemBounds(board, item);
  return p.x < v.x1 && p.x + s.w > v.x0 && p.y < v.y1 && p.y + s.h > v.y0;
}

function render(): void {
  boardEl.style.background = board.bg;
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
  if (editingHtml) cardsEl.insertAdjacentHTML("beforeend", editingHtml);
  updateToolbar();
  lastContentKey = visibleKey();
  applyCamera();
}

function updateResizeHandle(): void {
  const el = document.getElementById("resize-handle") as HTMLDivElement;
  if (selected.length !== 1 || settingsOpen || editingId !== null) { el.style.display = "none"; return; }
  const it = boardGet(board, selected[0]);
  if (!it || "Connector" in it.kind) { el.style.display = "none"; return; }
  const [p, s] = itemBounds(board, it);
  const screen = toScreen({ x: p.x + s.w, y: p.y + s.h });
  if (screen.x < 0 || screen.y < 0 || screen.x > window.innerWidth || screen.y > window.innerHeight) {
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
function updateSelection(): void {
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

function applyStacking(): void {
  const order = new Map<number, number>();
  board.items.forEach((it, i) => order.set(it.id, i));
  for (const child of Array.from(cardsEl.children)) {
    const el = child as HTMLElement;
    el.style.zIndex = String(order.get(Number(el.dataset.id)) ?? 0);
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
  if (target.closest("#toolbar, #settings-backdrop, #toast, #btn-collapse, video")) return;
  // A board click or drag must never start a native text selection
  // across the cards (bug: clicking anywhere highlighted all text).
  if (!target.closest("textarea.note-edit")) window.getSelection()?.removeAllRanges();
  if (e.button !== 0) return;
  const winPt: Pt = { x: e.clientX, y: e.clientY };
  if (editingId !== null && !target.closest("textarea.note-edit")) {
    commitEditingIfAny();
    render();
    return;
  }
  const world = toWorld(winPt);
  if (spaceDown) { drag = { kind: "pan", last: winPt }; return; }
  if (tool === "pen") {
    drag = { kind: "stroke", points: [world] };
    return;
  }
  if (tool === "connector") {
    const hit = hitTest(board, world);
    drag = { kind: "connector", from: hit !== null ? { Item: hit } : { Point: world }, current: world };
    return;
  }
  // Select tool.
  if (e.detail === 2) {
    // Without this, the browser's default mousedown focus runs after
    // this handler and steals focus from a textarea created here, so
    // typing would never land in a new or edited note.
    e.preventDefault();
    const hit = hitTest(board, world);
    if (hit !== null) {
      const it = boardGet(board, hit);
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
  const clicked = hitTest(board, world);
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
  const winPt: Pt = { x: e.clientX, y: e.clientY };
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
        } else if (hitTest(board, w) !== null) {
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
  if (!drag) return;
  const world = toWorld({ x: e.clientX, y: e.clientY });
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
    const to = hitTest(board, world);
    const toAnchor: Anchor = to !== null ? { Item: to } : { Point: world };
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
  if ((e.target as HTMLElement).closest("#settings, #toolbar")) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt({ x: e.clientX, y: e.clientY }, factor);
  } else {
    board.camera.x -= e.deltaX / board.camera.zoom;
    board.camera.y -= e.deltaY / board.camera.zoom;
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

function toggleAudio(id: number, path: string): void {
  if (audioId === id && audioEl && !audioEl.paused) {
    audioEl.pause();
    render();
    return;
  }
  if (audioEl) audioEl.pause();
  audioEl = new Audio(api.fileUrl(path));
  audioId = id;
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
  board.camera.x = c.x - window.innerWidth / 2 / board.camera.zoom;
  board.camera.y = c.y - window.innerHeight / 2 / board.camera.zoom;
  save(); render();
}

window.addEventListener("keydown", (e: KeyboardEvent) => {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA") return;
  // Tab cycles elements, unless Settings is open, where Tab keeps
  // its normal job of moving focus around the sheet.
  if (e.key === "Tab" && !settingsOpen) {
    e.preventDefault();
    navigateElements(e.shiftKey ? -1 : 1);
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === " " || e.key === " ") spaceDown = true;
  if (e.key === "h" && editingId === null && !settingsOpen) {
    api.minimise().catch(() => undefined);
    return;
  }
  if (e.key === "?") { setSettings(true); return; }
  if (e.key === "Escape") {
    if (settingsOpen) { setSettings(false); return; }
    selected = [];
    render();
    return;
  }
  if (e.key.toLowerCase() === "v" && !ctrl) setTool("select");
  else if (e.key.toLowerCase() === "p" && !ctrl) setTool("pen");
  else if (e.key.toLowerCase() === "a" && !ctrl) setTool("connector");
  else if (e.key.toLowerCase() === "g" && ctrl) {
    e.preventDefault();
    if (selected.length >= 2) {
      board.next_group += 1;
      const g = board.next_group;
      for (const it of board.items) if (selected.includes(it.id)) it.group = g;
      save(); render();
    }
  } else if (e.key.toLowerCase() === "u" && ctrl) {
    e.preventDefault();
    const groups = new Set(selected.map((id) => boardGet(board, id)?.group).filter((g): g is number => g !== null && g !== undefined));
    for (const it of board.items) if (it.group !== null && groups.has(it.group)) it.group = null;
    save(); render();
  } else if (e.key === "Backspace" || e.key === "Delete") {
    if (selected.length > 0) {
      board.items = board.items.filter((it) => !selected.includes(it.id));
      selected = [];
      save(); render();
    }
  } else if (e.key === "+" || e.key === "=") { zoomCentre(1.2); save(); render(); }
  else if (e.key === "-") { zoomCentre(1 / 1.2); save(); render(); }
  else if (e.key === "0") { board.camera = { x: 0, y: 0, zoom: 1 }; save(); render(); }
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

document.getElementById("btn-quit")?.addEventListener("click", async () => {
  // Commit any note being edited, save, then quit. closeWindow
  // closes the only window, and the main process quits on
  // window-all-closed, so this is a full app quit.
  commitEditingIfAny();
  try { await api.saveBoard(JSON.stringify(board)); } catch { /* closing anyway */ }
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
    board = welcomeBoard(showcase.pdf_size_bytes, showcase.video_size_bytes);
    board.camera = { x: 0, y: 0, zoom: 1 };
    setSettings(false);
    const confirmEl = document.getElementById("reset-confirm") as HTMLDivElement;
    const btn = document.getElementById("btn-reset") as HTMLButtonElement;
    if (confirmEl) confirmEl.style.display = "none";
    if (btn) btn.style.display = "";
    save();
    render();
    void refreshLinkPreviews();
    toast("Board data deleted — fresh welcome board restored");
  } catch (e) {
    toast(`Reset failed: ${String(e)}`);
  }
});
document.getElementById("btn-settings")?.addEventListener("click", () => setSettings(!settingsOpen));
document.getElementById("settings-close")?.addEventListener("click", () => setSettings(false));
document.getElementById("settings-backdrop")?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "settings-backdrop") setSettings(false);
});

function setSettings(open: boolean): void {
  settingsOpen = open;
  const backdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
  backdrop.classList.toggle("open", open);
  if (open) {
    const confirmEl = document.getElementById("reset-confirm") as HTMLDivElement;
    const resetBtn = document.getElementById("btn-reset") as HTMLButtonElement;
    if (confirmEl) confirmEl.style.display = "none";
    if (resetBtn) resetBtn.style.display = "";
    const table = document.getElementById("shortcuts-table") as HTMLTableElement;
    table.innerHTML = SHORTCUTS.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join("");
    const pathEl = document.getElementById("settings-board-path") as HTMLElement;
    pathEl.textContent = `Board file: ${boardPath}`;
    renderBgOpts();
    renderGridOpts();
    renderCornerOpts();
    api.getAppSettings().then((s) => { cornerReveal = s.corner; renderCornerOpts(); renderCollapseButton(); }).catch(() => undefined);
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
function renderCornerOpts(): void {
  const opts: Array<[string, string]> = [["Bottom-left", "bottom-left"], ["Bottom-right", "bottom-right"], ["Top-left", "top-left"], ["Top-right", "top-right"], ["Off", "off"]];
  const el = document.getElementById("corner-opts") as HTMLDivElement;
  if (!el) return;
  el.innerHTML = "";
  for (const [label, value] of opts) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cornerReveal === value) b.classList.add("active");
    b.addEventListener("click", async () => {
      try { cornerReveal = await api.setCorner(value); } catch { /* keep old value */ }
      renderCornerOpts(); renderCollapseButton();
    });
    el.appendChild(b);
  }
}
function renderCollapseButton(): void {
  const el = document.getElementById("btn-collapse") as HTMLButtonElement | null;
  if (!el) return;
  el.className = `corner-${cornerReveal}`;
  el.title = cornerReveal === "off" ? "Corner is off" : `Hide into the ${cornerReveal.replace("-", " ")} corner`;
  el.setAttribute("aria-label", el.title);
}
document.getElementById("btn-collapse")?.addEventListener("click", (e) => {
  e.stopPropagation();
  commitEditingIfAny();
  save();
  api.collapse().catch(() => undefined);
});
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
        board.items.push({ id, pos: at, size: { w: 300, h: 96 }, group: null, kind: { Audio: { path: stored } } });
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
  if (files && files.length > 0) {
    const paths = Array.from(files).map((f) => api.getPathForFile(f)).filter((p) => p);
    if (paths.length > 0) {
      e.preventDefault();
      void dropPaths(paths, { x: e.clientX, y: e.clientY });
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
  if (/^https?:\/\//.test(uri)) {
    void addUrlAt(toWorld({ x: e.clientX, y: e.clientY }), uri);
  }
});

window.addEventListener("paste", (e: ClipboardEvent) => {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA") return;
  const text = e.clipboardData?.getData("text")?.trim() ?? "";
  if (/^https?:\/\//.test(text)) {
    e.preventDefault();
    void addUrlAt(toWorld({ x: window.innerWidth / 2, y: window.innerHeight / 2 }), text);
  }
});

// ---------------------------------------------------------------- init

function welcomeBoard(pdfSize: number, videoSize: number): Board {
  const b: Board = {
    items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 0, next_group: 0,
    bg: "#FFFFFF", grid: "Dots",
  };
  const add = (item: Item) => { b.items.push(item); return item.id; };
  const next = () => { b.next_id += 1; return b.next_id; };
  const note = (text: string, _w: number) => ({ Text: { text, bold: false, size: 16, color: "#1A1A1A" } });
  const WIKI_ICON = "https://en.wikipedia.org/static/favicon/wikipedia.ico";
  // V3: fewer items, more space. Every capability is shown once,
  // with at least 30px between cards, and nothing overlapping.
  // Tab order is board order: title, photo, link, colours, PDF,
  // audio, video, the grouped pair, then the how-to note.
  const titleText = "# Welcome to Bowerbird\n\nAn infinite board for notes, photos, links, audio and video.";
  add({ id: next(), pos: { x: 120, y: 40 }, size: { w: 320, h: estimateTextHeight(titleText, 16, 320) }, group: null, kind: note(titleText, 320) });
  add({ id: next(), pos: { x: 480, y: 40 }, size: { w: 360, h: 225 }, group: null, kind: { Image: { path: `${boardDir}/welcome-bower.jpg` } } });
  add({ id: next(), pos: { x: 880, y: 40 }, size: { w: 320, h: 300 }, group: null, kind: { UrlCard: { url: "https://en.wikipedia.org/wiki/Japanese_garden", title: "Japanese garden", description: "Type of traditional garden", image: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Saihouji-kokedera01.jpg/330px-Saihouji-kokedera01.jpg", icon: WIKI_ICON } } });
  add({ id: next(), pos: { x: 120, y: 240 }, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex: "#2A6D09" } } });
  add({ id: next(), pos: { x: 260, y: 240 }, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex: "#007AFF" } } });
  add({ id: next(), pos: { x: 120, y: 400 }, size: { w: 260, h: 96 }, group: null, kind: { PdfCard: { path: `${boardDir}/sample.pdf`, size_bytes: pdfSize } } });
  add({ id: next(), pos: { x: 420, y: 400 }, size: { w: 300, h: 96 }, group: null, kind: { Audio: { path: `${boardDir}/welcome-birdsong.mp3` } } });
  add({ id: next(), pos: { x: 760, y: 400 }, size: { w: 360, h: 280 }, group: null, kind: { Video: { source: `${boardDir}/welcome-video.mp4`, remote: false, size_bytes: videoSize } } });
  const groupText = "Grouped — these two move together.\n\nDrag either one, and both move. Ctrl + G groups, Ctrl + U ungroups.";
  add({ id: next(), pos: { x: 120, y: 530 }, size: { w: 300, h: estimateTextHeight(groupText, 16, 300) }, group: 1, kind: note(groupText, 300) });
  add({ id: next(), pos: { x: 450, y: 530 }, size: { w: 120, h: 120 }, group: 1, kind: { Swatch: { hex: "#FF6B35" } } });
  const tryText = "## Try this\n\n- Double-click a note to edit it\n- Tab jumps to the next element\n- Space + drag to pan, Ctrl + scroll to zoom\n- Drag a file onto the board";
  add({ id: next(), pos: { x: 600, y: 710 }, size: { w: 420, h: estimateTextHeight(tryText, 16, 420) }, group: null, kind: note(tryText, 420) });
  // Pen annotation: a red circle drawn around the bowerbird photo.
  const circle: Array<{ x: number; y: number }> = [];
  for (let k = 0; k < 36; k += 1) {
    const a = (2 * Math.PI * k) / 36;
    circle.push({ x: 660 + 190 * Math.cos(a), y: 152 + 110 * Math.sin(a) });
  }
  add({ id: next(), pos: { x: 470, y: 42 }, size: { w: 380, h: 220 }, group: null, kind: { Stroke: { points: circle, color: "#E63946", width: 4, marker: false } } });
  // Connector: the photo points to the article. Short, between
  // neighbours, crossing nothing.
  add({ id: next(), pos: { x: 1, y: 1 }, size: { w: 1, h: 1 }, group: null, kind: { Connector: { from: { Item: 2 }, to: { Item: 3 }, color: "#333333" } } });
  b.next_group = 2;
  return b;
}

async function init(): Promise<void> {
  try {
    const loaded = await api.loadBoard();
    boardPath = loaded.board_path;
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
      board = welcomeBoard(loaded.pdf_size_bytes, loaded.video_size_bytes ?? 0);
      save();
    }
  } catch (err) {
    toast(`Could not load the board: ${String(err)}`);
    board = welcomeBoard(0, 0);
  }
  try { cornerReveal = (await api.getAppSettings()).corner; } catch { /* default stands */ }
  renderCollapseButton();
  render();
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
