// Electron preload API (see electron/preload.js). The renderer never
// touches Node or Electron directly; every privileged call goes through
// this bridge, which the main process exposes with context isolation on.
interface BowerbirdAPI {
  loadBoard(): Promise<{ json: string | null; board_path: string; board_dir: string; pdf_size_bytes: number }>;
  saveBoard(json: string): Promise<void>;
  embedFile(path: string): Promise<string>;
  readTextFile(path: string): Promise<string>;
  fileSize(path: string): Promise<number>;
  fetchPreview(url: string): Promise<{ title: string | null; description: string | null }>;
  createEmbed(label: string, url: string, x: number, y: number, w: number, h: number): Promise<void>;
  moveEmbed(label: string, x: number, y: number, w: number, h: number): Promise<void>;
  hideEmbed(label: string): Promise<void>;
  destroyEmbed(label: string): Promise<void>;
  openExternal(target: string): Promise<void>;
  minimise(): Promise<void>;
  closeWindow(): Promise<void>;
  getPathForFile(file: File): string;
  fileUrl(path: string): string;
}
declare global {
  interface Window { bowerbird: BowerbirdAPI }
}
const api = window.bowerbird;
import {
  Anchor, Board, GRID, HEADER_H, Item, Pt,
  anchorPoint, boardGet, centre, clippedEnds, domainOf, elide, estimateTextHeight,
  hitTest, itemBounds, marquee, moveSelection, normaliseHex, parseHex, renderMarkdownHtml,
  resizeItem, select, shouldEmbedUrl, tileColorFor, tint,
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
  ["Double-click empty space", "New note"],
  ["Double-click a note", "Edit it in place"],
  ["Double-click a link, PDF or picture", "Open it outside Bowerbird"],
  ["Click a play tile", "Play or pause audio / open a video"],
  ["Drag a card corner", "Resize the card"],
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
let drag: null
  | { kind: "pan"; last: Pt }
  | { kind: "move"; lastWorld: Pt }
  | { kind: "stroke"; points: Pt[] }
  | { kind: "connector"; from: Anchor; current: Pt }
  | { kind: "marquee"; start: Pt; current: Pt }
  | { kind: "resize"; id: number; startWorld: Pt; origW: number; origH: number } = null;
let liveStroke: Pt[] | null = null;
let audioEl: HTMLAudioElement | null = null;
let audioId: number | null = null;
let embedRects = new Map<number, { x: number; y: number; w: number; h: number }>();
let toastTimer: ReturnType<typeof setTimeout> | null = null;

const boardEl = document.getElementById("board") as HTMLDivElement;
const worldEl = document.getElementById("world") as unknown as SVGGElement;
const cardsEl = document.getElementById("cards") as HTMLDivElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;
const zoomLabelEl = document.getElementById("zoom-label") as HTMLElement;

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
function isEmbedded(item: Item): boolean {
  return "UrlCard" in item.kind && item.kind.UrlCard.embed === true;
}
function openExternal(target: string): void {
  api.openExternal(target).catch((e) => toast(`Could not open ${target}: ${String(e)}`));
}

function bringToFront(ids: number[]): void {
  // Later items paint on top, so a clicked card (and its group) comes
  // to the front. Without this, an overlapping card can hide an
  // embedded card's header buttons, as the welcome board does.
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

function renderGrid(): void {
  const cam = board.camera;
  const w = window.innerWidth, h = window.innerHeight;
  const x0 = cam.x, x1 = cam.x + w / cam.zoom;
  const y0 = cam.y, y1 = cam.y + h / cam.zoom;
  const rgb = parseHex(board.bg) ?? [247, 245, 240];
  const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const gridColor = lum > 140 ? "#d8d8de" : "#55555a";
  let step = GRID;
  while ((x1 - x0) / step > 40 || (y1 - y0) / step > 40) step *= 2;
  const g = svgEl2("g", {});
  if (board.grid === "Dots") {
    for (let gx = Math.floor(x0 / step) * step; gx <= x1; gx += step) {
      for (let gy = Math.floor(y0 / step) * step; gy <= y1; gy += step) {
        g.appendChild(svgEl2("circle", { cx: String(gx), cy: String(gy), r: "1.5", fill: gridColor }));
      }
    }
  } else if (board.grid === "Lines") {
    for (let gx = Math.floor(x0 / step) * step; gx <= x1; gx += step) {
      g.appendChild(svgEl2("line", { x1: String(gx), y1: String(y0), x2: String(gx), y2: String(y1), stroke: gridColor, "stroke-width": "1" }));
    }
    for (let gy = Math.floor(y0 / step) * step; gy <= y1; gy += step) {
      g.appendChild(svgEl2("line", { x1: String(x0), y1: String(gy), x2: String(x1), y2: String(gy), stroke: gridColor, "stroke-width": "1" }));
    }
  }
  worldEl.appendChild(g);
}

function renderStrokesAndConnectors(): void {
  const cam = board.camera;
  for (const item of board.items) {
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
  if (liveStroke && liveStroke.length >= 2) {
    const d = liveStroke.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
    worldEl.appendChild(svgEl2("path", { d, fill: "none", stroke: penColor, "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  }
  if (drag && drag.kind === "connector") {
    const a = anchorPoint(board, drag.from);
    if (a) {
      worldEl.appendChild(svgEl2("line", { x1: String(a.x), y1: String(a.y), x2: String(drag.current.x), y2: String(drag.current.y), stroke: "#333333", "stroke-width": "2" }));
    }
  }
  if (drag && drag.kind === "marquee") {
    const x0 = Math.min(drag.start.x, drag.current.x), y0 = Math.min(drag.start.y, drag.current.y);
    worldEl.appendChild(svgEl2("rect", { x: String(x0), y: String(y0), width: String(Math.abs(drag.current.x - drag.start.x)), height: String(Math.abs(drag.current.y - drag.start.y)), fill: "none", stroke: ACCENT, "stroke-width": "1" }));
  }
  if (selected.length === 1) {
    const it = boardGet(board, selected[0]);
    if (it && !("Connector" in it.kind)) {
      const [p, s] = itemBounds(board, it);
      const hx = p.x + s.w, hy = p.y + s.h;
      const hs = 16 / cam.zoom;
      worldEl.appendChild(svgEl2("rect", { x: String(hx - hs), y: String(hy - hs), width: String(hs), height: String(hs), fill: "#fff", stroke: "#8e8e93", "stroke-width": String(1 / cam.zoom) }));
    }
  }
}

function cardHtml(item: Item, screen: Pt, w: number, h: number): string {
  const sel = selected.includes(item.id);
  const cls = sel ? "card selected" : "card";
  const style = `left:${screen.x}px;top:${screen.y}px;width:${w}px;height:${h}px;`;
  const cam = board.camera;
  if ("Text" in item.kind) {
    if (editingId === item.id) return ""; // the editor DOM is managed separately
    const { text, size, color } = item.kind.Text;
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner note-body" style="font-size:${size * cam.zoom}px;color:${color}">${renderMarkdownHtml(text, size)}</div></div>`;
  }
  if ("Image" in item.kind) {
    const { path } = item.kind.Image;
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner"><img src="${api.fileUrl(path)}" style="width:100%;height:100%;object-fit:cover;border-radius:12px" alt="" /></div></div>`;
  }
  if ("UrlCard" in item.kind) {
    const { url, title, description } = item.kind.UrlCard;
    const domain = domainOf(url);
    const head = title ?? domain;
    const tile = tileColorFor(domain);
    const initial = (domain[0] ?? "?").toUpperCase();
    if (isEmbedded(item)) {
      return `<div class="${cls}" data-id="${item.id}" style="${style}">
        <div class="embed-header" data-embed-header="${item.id}"><span class="drag">⠿</span><span class="domain">${head}</span><button data-action="open-url" data-id="${item.id}">Open</button><button data-action="to-simple" data-id="${item.id}">Simple</button></div>
        <div class="embed-body-note">This page lives in its own webview below this header. Drag the header to move the card.</div>
      </div>`;
    }
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner row" style="padding:16px">
      <div class="tile" style="background:${tint(tile, 0.85)};color:${tile};font-size:24px">${initial}</div>
      <div class="col">
        <div class="title" style="font-size:${14 * Math.max(cam.zoom, 0.7)}px">${elide(head, w - 100, 14, true)}</div>
        <div class="sub" style="font-size:12px;color:#2e86ab">${elide(url, w - 100, 12, false)}</div>
        ${description ? `<div class="desc" style="font-size:12px">${elide(description, (w - 100) * 2, 12, false)}</div>` : ""}
        <div class="simple-actions"><button data-action="open-url" data-id="${item.id}">Open</button><button data-action="to-embed" data-id="${item.id}">Embed page</button></div>
      </div></div></div>`;
  }
  if ("PdfCard" in item.kind) {
    const { path, size_bytes } = item.kind.PdfCard;
    const name = path.split("/").pop() ?? path;
    const kb = Math.round(size_bytes / 1024);
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner row" style="padding:12px">
      <div class="tile" style="background:${tint("#E63946", 0.88)};color:#E63946;font-size:13px">PDF</div>
      <div class="col"><div class="title" style="font-size:14px">${elide(name, w - 92, 14, true)}</div><div class="sub" style="font-size:12px">${kb} KB</div></div></div></div>`;
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
      <div class="col"><div class="title" style="font-size:14px">${elide(name, w - 92, 14, true)}</div><div class="wave">${bars}</div>${playing ? `<div class="sub" style="font-size:12px">Now playing</div>` : ""}</div></div></div>`;
  }
  if ("Video" in item.kind) {
    const { source, remote, size_bytes } = item.kind.Video;
    const name = remote ? domainOf(source) : (source.split("/").pop() ?? source);
    const sub = remote ? "Video link" : `${Math.round(size_bytes / 1024)} KB`;
    const thumbH = (w - 24) * 9 / 16;
    if (h >= thumbH + 70) {
      return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
        <div class="video-thumb clickable" data-action="play-video" data-id="${item.id}" style="width:${w - 24}px;height:${thumbH}px;font-size:28px">▶</div>
        <div class="title" style="font-size:14px">${elide(name, w - 24, 14, true)}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
    }
    return `<div class="${cls}" data-id="${item.id}" style="${style}"><div class="inner row" style="padding:12px">
      <div class="video-thumb clickable" data-action="play-video" data-id="${item.id}" style="width:96px;height:56px;font-size:20px">▶</div>
      <div class="col"><div class="title" style="font-size:14px">${elide(name, w - 132, 14, true)}</div><div class="sub" style="font-size:12px">${sub}</div></div></div></div>`;
  }
  return "";
}

function render(): void {
  boardEl.style.background = board.bg;
  const cam = board.camera;
  worldEl.setAttribute("transform", `translate(${-cam.x * cam.zoom},${-cam.y * cam.zoom}) scale(${cam.zoom})`);
  worldEl.innerHTML = "";
  renderGrid();
  renderStrokesAndConnectors();
  // Cards: rebuild, except the note being edited (its textarea stays).
  const editingEl = editingId !== null ? cardsEl.querySelector(`[data-id="${editingId}"]`) : null;
  const editingHtml = editingEl ? editingEl.outerHTML : null;
  let html = "";
  for (const item of board.items) {
    if ("Stroke" in item.kind || "Connector" in item.kind) continue;
    if (editingId === item.id) continue;
    const screen = toScreen(item.pos);
    html += cardHtml(item, screen, item.size.w * cam.zoom, item.size.h * cam.zoom);
  }
  cardsEl.innerHTML = html;
  applyStacking();
  if (editingHtml) cardsEl.insertAdjacentHTML("beforeend", editingHtml);
  zoomLabelEl.textContent = `${Math.round(cam.zoom * 100)}%`;
  updateToolbar();
  void syncEmbeds();
}

function updateToolbar(): void {
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
}

function applyStacking(): void {
  const order = new Map<number, number>();
  board.items.forEach((it, i) => order.set(it.id, i));
  for (const child of Array.from(cardsEl.children)) {
    const el = child as HTMLElement;
    el.style.zIndex = String(order.get(Number(el.dataset.id)) ?? 0);
  }
}

// ---------------------------------------------------------------- embeds

async function syncEmbeds(): Promise<void> {
  const cam = board.camera;
  const wanted = new Map<number, { x: number; y: number; w: number; h: number; url: string }>();
  for (const item of board.items) {
    if (!isEmbedded(item) || !("UrlCard" in item.kind)) continue;
    const screen = toScreen(item.pos);
    const w = item.size.w * cam.zoom, h = item.size.h * cam.zoom;
    const headerH = HEADER_H * cam.zoom;
    const rect = { x: Math.round(screen.x), y: Math.round(screen.y + headerH), w: Math.round(w), h: Math.round(h - headerH) };
    if (settingsOpen || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w < 0 || rect.y + rect.h < 0 || rect.x > window.innerWidth || rect.y > window.innerHeight) {
      continue;
    }
    wanted.set(item.id, { ...rect, url: item.kind.UrlCard.url });
  }
  // Destroy webviews that are no longer wanted.
  for (const id of Array.from(embedRects.keys())) {
    if (!wanted.has(id)) {
      embedRects.delete(id);
      api.destroyEmbed(`embed-${id}`).catch(() => undefined);
    }
  }
  for (const [id, rect] of wanted) {
    const prev = embedRects.get(id);
    if (prev && prev.x === rect.x && prev.y === rect.y && prev.w === rect.w && prev.h === rect.h) continue;
    embedRects.set(id, rect);
    if (prev) {
      api.moveEmbed(`embed-${id}`, rect.x, rect.y, rect.w, rect.h).catch(() => undefined);
    } else {
      api.createEmbed(`embed-${id}`, rect.url, rect.x, rect.y, rect.w, rect.h).catch((e) => toast(`Embedded page failed: ${String(e)}`));
    }
  }
}

function destroyAllEmbeds(): void {
  for (const id of Array.from(embedRects.keys())) {
    api.destroyEmbed(`embed-${id}`).catch(() => undefined);
  }
  embedRects.clear();
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
  ta.style.fontSize = `${size * board.camera.zoom}px`;
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
  liveStroke = null;
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
  if (target.closest("#toolbar, #settings-backdrop, #toast")) return;
  if (e.button !== 0) return;
  const winPt: Pt = { x: e.clientX, y: e.clientY };
  if (editingId !== null && !target.closest("textarea.note-edit")) {
    commitEditingIfAny();
    render();
    return;
  }
  const world = toWorld(winPt);
  if (spaceDown) { drag = { kind: "pan", last: winPt }; return; }
  // Embedded card header drag: the header is DOM, the page below it is
  // a native webview, so the header is the card's drag handle.
  const header = target.closest("[data-embed-header]") as HTMLElement | null;
  if (header) {
    const id = Number(header.dataset.embedHeader);
    selected = select(board, selected, id, e.shiftKey);
    bringToFront(selected);
    applyStacking();
    updateSelection();
    drag = { kind: "move", lastWorld: world };
    return;
  }
  if (tool === "pen") {
    drag = { kind: "stroke", points: [world] };
    liveStroke = [world];
    render();
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
    drag = { kind: "resize", id: sel, startWorld: world, origW: it?.size.w ?? 100, origH: it?.size.h ?? 100 };
    return;
  }
  if (clicked !== null && cornerHit(clicked, world)) {
    selected = select(board, selected, clicked, false);
    bringToFront(selected);
    applyStacking();
    updateSelection();
    const it = boardGet(board, clicked);
    drag = { kind: "resize", id: clicked, startWorld: world, origW: it?.size.w ?? 100, origH: it?.size.h ?? 100 };
    return;
  }
  if (clicked !== null) {
    selected = select(board, selected, clicked, e.shiftKey);
    bringToFront(selected);
    applyStacking();
    updateSelection();
    drag = { kind: "move", lastWorld: world };
    return;
  }
  if (!e.shiftKey) selected = [];
  drag = { kind: "marquee", start: world, current: world };
  render();
});

window.addEventListener("mousemove", (e: MouseEvent) => {
  if (!drag) return;
  const winPt: Pt = { x: e.clientX, y: e.clientY };
  const world = toWorld(winPt);
  if (drag.kind === "pan") {
    board.camera.x -= (winPt.x - drag.last.x) / board.camera.zoom;
    board.camera.y -= (winPt.y - drag.last.y) / board.camera.zoom;
    drag.last = winPt;
    render();
  } else if (drag.kind === "move") {
    moveSelection(board, selected, world.x - drag.lastWorld.x, world.y - drag.lastWorld.y);
    drag.lastWorld = world;
    render();
  } else if (drag.kind === "resize") {
    resizeItem(board, drag.id, drag.origW + (world.x - drag.startWorld.x), drag.origH + (world.y - drag.startWorld.y));
    render();
  } else if (drag.kind === "stroke") {
    const last = drag.points[drag.points.length - 1];
    if (Math.hypot(world.x - last.x, world.y - last.y) > 2 / board.camera.zoom) {
      drag.points.push(world);
      liveStroke = [...drag.points];
      render();
    }
  } else if (drag.kind === "connector") {
    drag.current = world;
    render();
  } else if (drag.kind === "marquee") {
    drag.current = world;
    render();
  }
});

window.addEventListener("mouseup", (e: MouseEvent) => {
  if (!drag) return;
  const world = toWorld({ x: e.clientX, y: e.clientY });
  const d = drag;
  drag = null;
  liveStroke = null;
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
  // Do not rebuild here for a move/resize: mousemove already rendered
  // during the drag, and rebuilding on mouseup would destroy a card
  // button the user just pressed, so its click would never fire.
  if (d.kind === "stroke" || d.kind === "connector" || d.kind === "marquee") {
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
    save();
  } else {
    board.camera.x -= e.deltaX / board.camera.zoom;
    board.camera.y -= e.deltaY / board.camera.zoom;
    save();
  }
  render();
}, { passive: false });

window.addEventListener("resize", () => render());

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
  if (action === "open-url" && "UrlCard" in it.kind) openExternal(it.kind.UrlCard.url);
  if (action === "to-embed" && "UrlCard" in it.kind) {
    it.kind.UrlCard.embed = true;
    it.size = { w: Math.max(it.size.w, 480), h: Math.max(it.size.h, 360) };
    save(); render();
  }
  if (action === "to-simple" && "UrlCard" in it.kind) {
    it.kind.UrlCard.embed = false;
    it.size = { w: 300, h: 108 };
    save(); render();
  }
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
  audioEl.play().catch((err) => toast(`Could not play audio: ${String(err)}`));
  audioEl.onended = () => { audioId = null; render(); };
  render();
}

// ---------------------------------------------------------------- keyboard

window.addEventListener("keydown", (e: KeyboardEvent) => {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA") return;
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
zoomLabelEl.addEventListener("click", () => { board.camera.zoom = 1; save(); render(); });
document.getElementById("btn-delete")?.addEventListener("click", () => {
  if (selected.length === 0) return;
  board.items = board.items.filter((it) => !selected.includes(it.id));
  selected = [];
  save(); render();
});
document.getElementById("btn-minimise")?.addEventListener("click", () => api.minimise().catch(() => undefined));
document.getElementById("btn-close")?.addEventListener("click", () => api.closeWindow().catch(() => undefined));
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
    const table = document.getElementById("shortcuts-table") as HTMLTableElement;
    table.innerHTML = SHORTCUTS.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join("");
    const pathEl = document.getElementById("settings-board-path") as HTMLElement;
    pathEl.textContent = `Board file: ${boardPath}`;
    renderBgOpts();
    renderGridOpts();
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
  const embed = shouldEmbedUrl(url);
  const id = allocId();
  board.items.push({ id, pos: at, size: embed ? { w: 480, h: 360 } : { w: 300, h: 108 }, group: null, kind: { UrlCard: { url: url.trim(), title: null, description: null, embed } } });
  save(); render();
  try {
    const preview = await api.fetchPreview(url);
    const it = boardGet(board, id);
    if (it && "UrlCard" in it.kind) {
      it.kind.UrlCard.title = preview.title;
      it.kind.UrlCard.description = preview.description;
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

function welcomeBoard(pdfSize: number): Board {
  const b: Board = {
    items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 0, next_group: 0,
    bg: "#FFFFFF", grid: "Dots",
  };
  const add = (item: Item) => { b.items.push(item); return item.id; };
  const next = () => { b.next_id += 1; return b.next_id; };
  const welcomeText = "Welcome to Bowerbird\nEvery element, on one board:\na note, a link card, a swatch,\na PDF card and a picture.\nDrop your own files onto the canvas.";
  add({ id: next(), pos: { x: 40, y: 40 }, size: { w: 260, h: estimateTextHeight(welcomeText, 16, 260) }, group: null, kind: { Text: { text: welcomeText, bold: false, size: 16, color: "#1A1A1A" } } });
  add({ id: next(), pos: { x: 40, y: 240 }, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex: "#FF6B35" } } });
  add({ id: next(), pos: { x: 180, y: 240 }, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex: "#2E86AB" } } });
  add({ id: next(), pos: { x: 340, y: 240 }, size: { w: 300, h: 108 }, group: null, kind: { UrlCard: { url: "https://example.com", title: null, description: null, embed: false } } });
  add({ id: next(), pos: { x: 660, y: 240 }, size: { w: 260, h: 96 }, group: null, kind: { PdfCard: { path: `${boardDir}/sample.pdf`, size_bytes: pdfSize } } });
  add({ id: next(), pos: { x: 40, y: 400 }, size: { w: 360, h: 225 }, group: null, kind: { Image: { path: `${boardDir}/welcome.png` } } });
  add({ id: next(), pos: { x: 40, y: 40 }, size: { w: 300, h: 200 }, group: null, kind: { Connector: { from: { Item: 1 }, to: { Item: 4 }, color: "#333333" } } });
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
        if ("UrlCard" in it.kind && it.kind.UrlCard.embed === undefined) it.kind.UrlCard.embed = false;
      }
    } else {
      board = welcomeBoard(loaded.pdf_size_bytes);
      save();
    }
  } catch (err) {
    toast(`Could not load the board: ${String(err)}`);
    board = welcomeBoard(0);
  }
  render();
  window.addEventListener("beforeunload", () => destroyAllEmbeds());
}

void init();
