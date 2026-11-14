// Board model: types, geometry and markdown, ported from the GPUI
// board so existing board.json files load unchanged. The JSON shape is
// serde's externally-tagged enum: a text note is
// {"Text": {"text": "...", "bold": false, "size": 16, "color": "#1A1A1A"}}
// and a connector endpoint is {"Item": 3} or {"Point": {"x": 1, "y": 2}}.

export interface Pt { x: number; y: number }
export interface Size { w: number; h: number }

// An audio card with a transcript is short by default —
// player, seek, and a Transcript toggle — until the toggle
// grows it to show the text. The card's height is the
// state: taller than the hidden height, the transcript
// shows; at it or below, only the toggle does. Both the
// card renderer and the toggle use these, so they agree.
export const AUDIO_TRANSCRIPT_HIDDEN_H = 164;
export const AUDIO_TRANSCRIPT_SHOWN_H = 240;
export type Anchor = { Point: Pt } | { Item: number };
export type ShapeKind = "rect" | "ellipse" | "triangle" | "diamond" | "hexagon" | "star" | "arrow";

export type Kind =
  | { Text: { text: string; bold: boolean; size: number; color: string; bg?: string } }
  | { Shape: { shape: ShapeKind; fill: string } }
  | { Image: { path: string } }
  | { UrlCard: { url: string; title: string | null; description: string | null; image?: string | null; icon?: string | null; embed?: boolean } }
  | { PdfCard: { path: string; size_bytes: number } }
  | { Swatch: { hex: string } }
  | { Audio: { path: string; title?: string; transcript?: string } }
  | { Video: { source: string; remote: boolean; size_bytes: number } }
  | { Stroke: { points: Pt[]; color: string; width: number; marker: boolean; pressures?: number[] } }
  | { Connector: { from: Anchor; to: Anchor; color: string } }
  // Plugin cards (see PLUGIN_API.md): namespaced so the core never
  // has to know a plugin's data shape. `data` is always JSON. If
  // the plugin is missing or disabled, the core renders a
  // placeholder and carries `data` through load and save verbatim
  // — uninstalling a plugin never deletes its cards' data.
  | { Plugin: { plugin: string; kind: string; data: unknown } };

export interface Item {
  id: number;
  pos: Pt;
  size: Size;
  group: number | null;
  kind: Kind;
  // Tags, set by the Tags plugin through updateItem: short
  // labels shown under the card. Optional so old boards load
  // unchanged: missing means no tags.
  tags?: string[];
  // Rotation in degrees, clockwise, around the item's centre
  // (card centre, or stroke bounding-box centre).
  // Optional so old boards load unchanged: missing means 0.
  // Cards and strokes rotate; connectors never carry it,
  // and slide frames are excluded by the rotate action.
  rotation?: number;
}

export interface Camera { x: number; y: number; zoom: number }

export interface Board {
  items: Item[];
  camera: Camera;
  next_id: number;
  next_group: number;
  // Labels for groups: a group is a section, so each group
  // carries the label its frame shows. Optional so old
  // boards load unchanged: a group with no entry gets
  // "Section <id>" on load.
  groups?: Record<number, { label: string }>;
  bg: string;
  grid: "Lines" | "Dots" | "Off";
}

export const GRID = 100;

export function kindName(item: Item): string {
  return Object.keys(item.kind)[0];
}

// Id lookup is the hot path for hit-testing: every
// connector hit-test used to call boardGet per endpoint,
// which is a linear scan, so a connector-heavy board
// paid O(items) per connector per hover frame. The index
// is a WeakMap keyed by the board object, so a board
// load drops the old index with the old board. It is
// rebuilt when the items array is replaced (filter,
// spread, restore) or its length changes (push, splice
// add/remove); a splice move keeps the same items, so
// the index stays valid across reorders.
const indexByBoard = new WeakMap<Board, { items: Item[]; byId: Map<number, Item> }>();
function indexFor(board: Board): Map<number, Item> {
  const cached = indexByBoard.get(board);
  if (cached && cached.items === board.items && cached.byId.size === board.items.length) return cached.byId;
  const byId = new Map<number, Item>();
  for (const it of board.items) byId.set(it.id, it);
  indexByBoard.set(board, { items: board.items, byId });
  return byId;
}

export function get(item: Item, board: Board): Item | undefined {
  return indexFor(board).get(item.id);
}

export function boardGet(board: Board, id: number): Item | undefined {
  return indexFor(board).get(id);
}

export function centre(item: Item): Pt {
  return { x: item.pos.x + item.size.w / 2, y: item.pos.y + item.size.h / 2 };
}

export function anchorPoint(board: Board, a: Anchor): Pt | null {
  if ("Point" in a) return a.Point;
  const it = boardGet(board, a.Item);
  return it ? centre(it) : null;
}

export function itemBounds(board: Board, item: Item): [Pt, Size] {
  if ("Connector" in item.kind) {
    const a = anchorPoint(board, item.kind.Connector.from);
    const b = anchorPoint(board, item.kind.Connector.to);
    if (a && b) {
      const m = 8;
      const x = Math.min(a.x, b.x) - m;
      const y = Math.min(a.y, b.y) - m;
      return [{ x, y }, { w: Math.max(a.x, b.x) - x + m, h: Math.max(a.y, b.y) - y + m }];
    }
  }
  return [item.pos, item.size];
}

// Zoom to fit: the camera that shows every item at once.
// The zoom is capped at 1 — a small board is centred, not
// blown up — and a margin keeps cards off the edges. An
// empty board has nothing to fit, so there is no camera.
export function fitCamera(board: Board, viewport: Size, padding = 48): Camera | null {
  if (board.items.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of board.items) {
    const [p, s] = itemBounds(board, it);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const availW = Math.max(1, viewport.w - padding * 2), availH = Math.max(1, viewport.h - padding * 2);
  const zoom = Math.min(1, availW / bw, availH / bh);
  return {
    x: (minX + maxX) / 2 - viewport.w / 2 / zoom,
    y: (minY + maxY) / 2 - viewport.h / 2 / zoom,
    zoom,
  };
}

// Arranging cards: the layout math for api.board.arrange.
// Given the board and a set of item ids, compute where each
// card goes. The caller applies the positions (one undo step
// via updateItems). Every layout anchors on the bounding box
// of the cards' current positions, so the arrangement happens
// in place — "tidy these" keeps them where they are,
// organised. Connectors are not cards to lay out, so they
// are skipped. A single card has nowhere to go, so it stays.
export type ArrangeOptions =
  | { type: "grid"; columns: number; gap?: number }
  | { type: "columns"; columns: number; gap?: number }
  | { type: "row"; gap?: number }
  | { type: "column"; gap?: number }
  | { type: "radial"; center: number; radius?: number };

export function arrangeItems(board: Board, ids: number[], options: ArrangeOptions): Array<{ id: number; pos: Pt }> {
  const items = ids
    .map((id) => boardGet(board, id))
    .filter((it): it is Item => !!it && !("Connector" in it.kind));
  if (items.length === 0) return [];
  const gap = options.type === "radial" ? 0 : (options.gap ?? 24);
  const origin = {
    x: Math.min(...items.map((it) => it.pos.x)),
    y: Math.min(...items.map((it) => it.pos.y)),
  };
  const maxW = Math.max(...items.map((it) => it.size.w));
  const maxH = Math.max(...items.map((it) => it.size.h));

  if (options.type === "radial") {
    const centerItem = boardGet(board, options.center);
    if (!centerItem) return [];
    const satellites = items.filter((it) => it.id !== options.center);
    if (satellites.length === 0) return [];
    const c = centre(centerItem);
    // Default radius: wide enough that neighbours do not
    // overlap. The arc between two neighbours should fit
    // the widest card, so the circumference must hold them.
    const radius =
      options.radius ?? Math.max(160, (satellites.length * (maxW + 40)) / (2 * Math.PI));
    return satellites.map((it, i) => {
      // Start at the top and go clockwise, evenly spaced.
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / satellites.length;
      return {
        id: it.id,
        pos: {
          x: c.x + radius * Math.cos(angle) - it.size.w / 2,
          y: c.y + radius * Math.sin(angle) - it.size.h / 2,
        },
      };
    });
  }

  if (options.type === "row") {
    let x = origin.x;
    return items.map((it) => {
      const pos = { x, y: origin.y + (maxH - it.size.h) / 2 };
      x += it.size.w + gap;
      return { id: it.id, pos };
    });
  }

  if (options.type === "column") {
    let y = origin.y;
    return items.map((it) => {
      const pos = { x: origin.x + (maxW - it.size.w) / 2, y };
      y += it.size.h + gap;
      return { id: it.id, pos };
    });
  }

  // grid and columns both take a column count. A grid is a
  // strict grid: every cell is the size of the largest card,
  // so rows and columns align. Columns are flowing stacks:
  // each column is independent, so column heights vary and
  // no row aligns across columns. Cards are centred in
  // their cell or column, so mixed sizes still look tidy.
  const columns = Math.max(1, Math.floor(options.columns) || 1);
  if (options.type === "grid") {
    return items.map((it, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      return {
        id: it.id,
        pos: {
          x: origin.x + col * (maxW + gap) + (maxW - it.size.w) / 2,
          y: origin.y + row * (maxH + gap) + (maxH - it.size.h) / 2,
        },
      };
    });
  }
  // columns: round-robin into columns, so the columns stay
  // balanced instead of filling one before the next.
  const colHeights = new Array<number>(columns).fill(0);
  return items.map((it, i) => {
    const col = i % columns;
    const pos = {
      x: origin.x + col * (maxW + gap) + (maxW - it.size.w) / 2,
      y: origin.y + colHeights[col],
    };
    colHeights[col] += it.size.h + gap;
    return { id: it.id, pos };
  });
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function rotatePoint(p: Pt, c: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}
export function itemRotation(item: Item): number {
  const r = Number(item.rotation ?? 0);
  return Number.isFinite(r) ? r : 0;
}
function itemHit(board: Board, item: Item, world: Pt): boolean {
  if ("Connector" in item.kind) {
    const a = anchorPoint(board, item.kind.Connector.from);
    const b = anchorPoint(board, item.kind.Connector.to);
    if (a && b) return distToSegment(world, a, b) <= 8;
  }
  if ("Stroke" in item.kind) {
    const { points } = item.kind.Stroke;
    const tol = Math.max(strokeMaxWidth(item.kind.Stroke) / 2 + 6, 8);
    // A rotated stroke is hit in its own frame, like a
    // rotated card: rotate the point back by -rotation
    // around the bounding-box centre, then test the
    // unrotated points. Without this, a rotated stroke
    // could only be selected in its old position.
    const rot = itemRotation(item);
    const p = rot !== 0 ? rotatePoint(world, centre(item), -rot) : world;
    // Bounding-box reject first: the old code scanned
    // every point of every stroke on every cursor move,
    // even for strokes far from the cursor. Cards get
    // a rect test; strokes did not.
    if (p.x < item.pos.x - tol || p.x > item.pos.x + item.size.w + tol ||
        p.y < item.pos.y - tol || p.y > item.pos.y + item.size.h + tol) return false;
    for (let i = 0; i + 1 < points.length; i++) {
      if (distToSegment(p, points[i], points[i + 1]) <= tol) return true;
    }
    return points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
  }
  // A rotated card is hit in its own frame: rotate the point
  // back by -rotation around the centre, then test the
  // unrotated rect. Without this, a rotated card's corners
  // (outside the rect, inside its axis-aligned box) would
  // still select it, and its real corners would not.
  let p = world;
  const rot = itemRotation(item);
  if (rot !== 0) p = rotatePoint(world, centre(item), -rot);
  return (
    p.x >= item.pos.x && p.x <= item.pos.x + item.size.w &&
    p.y >= item.pos.y && p.y <= item.pos.y + item.size.h
  );
}

export function hitTest(board: Board, world: Pt): number | null {
  // Cards first, then strokes, then connectors — in that order, each
  // pass topmost-first. Strokes and connectors live in the SVG layer
  // UNDER the cards, and a connector's hit line runs centre-to-centre
  // through the cards it joins, so the old single-pass order let a
  // connector steal clicks from the very card it was attached to:
  // clicking a photo's centre selected the connector, not the photo,
  // which broke shift-click grouping and could start a connector
  // drag from a connector itself. A stroke or connector is only
  // selectable in open space, where no card covers it — exactly
  // where it is actually visible.
  const isCard = (it: Item) => !("Stroke" in it.kind) && !("Connector" in it.kind);
  const isStroke = (it: Item) => "Stroke" in it.kind;
  for (const pass of [isCard, isStroke, (it: Item) => "Connector" in it.kind]) {
    for (let i = board.items.length - 1; i >= 0; i--) {
      const it = board.items[i];
      if (!pass(it)) continue;
      if (itemHit(board, it, world)) return it.id;
    }
  }
  return null;
}

// A stylus reports pressure 0..1; a mouse reports 0.5 while a
// button is down, so a mouse stroke is exactly its base width.
// Width follows pressure around the base width, floored so a
// light touch still draws, capped so a hard press stays sane.
export function pressureWidth(base: number, pressure: number): number {
  return Math.min(8, Math.max(1, 2 * base * pressure));
}
// The widest a stroke gets, for hit-testing and the eraser:
// its base width, or the widest its pressures make it.
export function strokeMaxWidth(stroke: { width: number; pressures?: number[] }): number {
  const p = stroke.pressures;
  if (!p || p.length === 0) return stroke.width;
  let max = stroke.width;
  for (const v of p) {
    const w = pressureWidth(stroke.width, v);
    if (w > max) max = w;
  }
  return max;
}
// Whether a stroke's pressures actually vary: a pen held at
// one pressure draws a uniform stroke, and it renders as a
// single path like a mouse stroke.
export function strokePressuresVary(stroke: { pressures?: number[] }): boolean {
  const p = stroke.pressures;
  if (!p || p.length < 2) return false;
  let min = p[0], max = p[0];
  for (const v of p) { if (v < min) min = v; if (v > max) max = v; }
  return max - min > 0.02;
}

// Every stroke the eraser touches: all stroke ids whose
// segments come within `radius` of the point, in world
// units. The test is the same as the stroke branch of
// itemHit — the eraser circle overlaps the stroke when
// a segment passes within radius plus half the stroke
// width — but it collects every hit, not just the
// topmost one, so one sweep can erase several strokes.
export function strokesWithin(board: Board, world: Pt, radius: number): number[] {
  const out: number[] = [];
  for (const it of board.items) {
    if (!("Stroke" in it.kind)) continue;
    const { points } = it.kind.Stroke;
    const tol = radius + strokeMaxWidth(it.kind.Stroke) / 2;
    const rot = itemRotation(it);
    const p = rot !== 0 ? rotatePoint(world, centre(it), -rot) : world;
    if (p.x < it.pos.x - tol || p.x > it.pos.x + it.size.w + tol ||
        p.y < it.pos.y - tol || p.y > it.pos.y + it.size.h + tol) continue;
    let hit = false;
    for (let i = 0; i + 1 < points.length; i++) {
      if (distToSegment(p, points[i], points[i + 1]) <= tol) { hit = true; break; }
    }
    if (!hit) hit = points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
    if (hit) out.push(it.id);
  }
  return out;
}

export function marquee(board: Board, a: Pt, b: Pt): number[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return board.items.filter((it) => {
    const [p, s] = itemBounds(board, it);
    return p.x < x1 && p.x + s.w > x0 && p.y < y1 && p.y + s.h > y0;
  }).map((it) => it.id);
}

// Whether a point is inside a polygon (ray casting). The
// lasso loop is closed implicitly: the last point connects
// back to the first.
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Freehand selection: every item whose bounds touch the
// loop. An item counts when its centre or any corner is
// inside, or when a loop edge crosses its bounds — the
// same intersection semantics as the rectangular marquee,
// so a long stroke crossing the loop is selected, not
// just one whose centre happens to fall inside it.
export function lassoSelect(board: Board, points: Pt[]): number[] {
  if (points.length < 3) return [];
  return board.items.filter((it) => {
    const [p, s] = itemBounds(board, it);
    if (pointInPolygon({ x: p.x + s.w / 2, y: p.y + s.h / 2 }, points)) return true;
    const corners = [
      { x: p.x, y: p.y }, { x: p.x + s.w, y: p.y },
      { x: p.x, y: p.y + s.h }, { x: p.x + s.w, y: p.y + s.h },
    ];
    if (corners.some((c) => pointInPolygon(c, points))) return true;
    const rect = { x: p.x, y: p.y, w: s.w, h: s.h };
    for (let i = 0; i < points.length; i++) {
      if (segmentIntersectsRect(points[i], points[(i + 1) % points.length], rect)) return true;
    }
    return false;
  }).map((it) => it.id);
}

export function allocId(board: Board): number {
  board.next_id += 1;
  return board.next_id;
}

export function select(board: Board, selected: number[], id: number, additive: boolean): number[] {
  const out = additive ? [...selected] : [];
  const it = boardGet(board, id);
  if (it && it.group !== null) {
    for (const m of board.items) {
      if (m.group === it.group && !out.includes(m.id)) out.push(m.id);
    }
  } else if (!out.includes(id)) {
    out.push(id);
  }
  return out;
}

export function moveSelection(board: Board, selected: number[], dx: number, dy: number): void {
  // Called on every move-drag mousemove: an includes()
  // scan per item made this O(items x selection) per
  // event. One Set for the whole drag is O(items).
  const sel = new Set(selected);
  for (const it of board.items) {
    if (!sel.has(it.id)) continue;
    it.pos.x += dx; it.pos.y += dy;
    if ("Stroke" in it.kind) for (const p of it.kind.Stroke.points) { p.x += dx; p.y += dy; }
    if ("Connector" in it.kind) {
      const { from, to } = it.kind.Connector;
      if ("Point" in from) { from.Point.x += dx; from.Point.y += dy; }
      if ("Point" in to) { to.Point.x += dx; to.Point.y += dy; }
    }
  }
}

export function resizeItem(board: Board, id: number, newW: number, newH: number): void {
  newW = Math.max(48, newW); newH = Math.max(48, newH);
  const it = boardGet(board, id);
  if (!it) return;
  const { x: ox, y: oy } = it.pos; const ow = it.size.w, oh = it.size.h;
  if ("Stroke" in it.kind && ow > 0 && oh > 0) {
    const sx = newW / ow, sy = newH / oh;
    for (const p of it.kind.Stroke.points) {
      p.x = ox + (p.x - ox) * sx; p.y = oy + (p.y - oy) * sy;
    }
  }
  if ("Connector" in it.kind && ow > 0 && oh > 0) {
    const sx = newW / ow, sy = newH / oh;
    const { from, to } = it.kind.Connector;
    if ("Point" in from) { from.Point.x = ox + (from.Point.x - ox) * sx; from.Point.y = oy + (from.Point.y - oy) * sy; }
    if ("Point" in to) { to.Point.x = ox + (to.Point.x - ox) * sx; to.Point.y = oy + (to.Point.y - oy) * sy; }
  }
  it.size = { w: newW, h: newH };
}

export function domainOf(url: string): string {
  const after = url.split("://")[1] ?? url;
  let host = after.split("/")[0].split("?")[0].split(":")[0];
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

export function parseHex(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function normaliseHex(hex: string): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("");
}

// --- Markdown (same subset as the GPUI board) ---------------------------

export interface Segment { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: boolean; strike?: boolean }
export type Block =
  | { Heading: { level: number; segments: Segment[] } }
  | { Bullet: { segments: Segment[] } }
  | { Ordered: { n: number; segments: Segment[] } }
  | { Quote: { segments: Segment[] } }
  | { Code: { lines: string[] } }
  | { Paragraph: { segments: Segment[] } };

export function parseInline(s: string): Segment[] {
  const out: Segment[] = [];
  let i = 0, buf = "";
  const flush = (extra: Partial<Segment> = {}) => {
    if (buf) { out.push({ text: buf, ...extra }); buf = ""; }
  };
  // Deliberately flat: markers stay literal when unclosed, and
  // "2 * 3 * 4" is not emphasis. Backslash escapes one character.
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
    const rest = s.slice(i);
    const tryMark = (mark: string, extra: Partial<Segment>): boolean => {
      if (!rest.startsWith(mark)) return false;
      const end = s.indexOf(mark, i + mark.length);
      if (end === -1) return false;
      const inner = s.slice(i + mark.length, end);
      if (!inner || inner.includes("\n")) return false;
      flush(); out.push({ text: inner, ...extra }); i = end + mark.length; return true;
    };
    if (tryMark("**", { bold: true })) continue;
    if (tryMark("~~", { strike: true })) continue;
    if (tryMark("`", { code: true })) continue;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
    if (link) { flush(); out.push({ text: link[1], link: true }); i += link[0].length; continue; }
    if (c === "*" && rest.length > 1) {
      const end = s.indexOf("*", i + 1);
      if (end !== -1 && end > i + 1) {
        const inner = s.slice(i + 1, end);
        if (!inner.includes(" ") || inner.trim().length > 0) {
          // Only treat a lone *...* as italic when it is not part of
          // an arithmetic-looking expression: require the char before
          // and after to not both be digits/spaces in "a * b" form.
          const before = i === 0 ? " " : s[i - 1];
          const after = end + 1 >= s.length ? " " : s[end + 1];
          if (!(before.trim() !== "" && after.trim() !== "" && /\d/.test(before) && /\d/.test(after))) {
            flush(); out.push({ text: inner, italic: true }); i = end + 1; continue;
          }
        }
      }
    }
    buf += c; i++;
  }
  flush();
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      blocks.push({ Code: { lines: codeLines } });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ Heading: { level: heading[1].length, segments: parseInline(heading[2]) } }); i++; continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { blocks.push({ Bullet: { segments: parseInline(bullet[1]) } }); i++; continue; }
    const ordered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ordered) { blocks.push({ Ordered: { n: parseInt(ordered[1], 10), segments: parseInline(ordered[2]) } }); i++; continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { blocks.push({ Quote: { segments: parseInline(quote[1]) } }); i++; continue; }
    blocks.push({ Paragraph: { segments: parseInline(line) } });
    i++;
  }
  return blocks;
}

// The height reserved at a card's bottom for its bottom
// row (tag pills, the "+ tag" button, the transcript
// toggle): the row itself is 24 tall, plus 12 of padding
// between the row and the card's contents, so the pills
// never sit on the text.
export const CARD_DECORATIONS_H = 36;

export function estimateTextHeight(text: string, fontSize: number, width: number): number {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return 48;
  const charsFit = Math.max(20, (width - 24) / (fontSize * 0.55));
  let h = 24;
  blocks.forEach((block, idx) => {
    if (idx > 0) h += 4;
    if ("Heading" in block) {
      const len = block.Heading.segments.reduce((a, s) => a + s.text.length, 0);
      const lines = Math.max(1, Math.ceil(len / charsFit));
      const extra = block.Heading.level === 1 ? 6 : block.Heading.level === 2 ? 3 : 1;
      h += lines * (fontSize + extra) * 1.62;
    } else if ("Code" in block) {
      h += Math.max(1, block.Code.lines.length) * fontSize * 1.62 + 12;
    } else {
      const segs = ("Bullet" in block ? block.Bullet.segments : "Ordered" in block ? block.Ordered.segments : "Quote" in block ? block.Quote.segments : block.Paragraph.segments);
      const len = segs.reduce((a, s) => a + s.text.length, 0);
      h += Math.max(1, Math.ceil(len / charsFit)) * fontSize * 1.62;
    }
  });
  return Math.max(48, h);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Notes render with link URLs intact: parseInline drops URLs (it is
// only used for height estimation, where text length is what matters),
// so rendering walks the raw lines with a link-aware pass instead.
export function renderMarkdownHtml(text: string, _baseSize: number): string {
  return renderNoteHtml(text);
}

// Syntax highlighting for fenced code blocks in text cards.
// A small built-in tokenizer, no dependency: a handful of
// languages, everything else gets strings, comments and
// numbers. Colours are the app's own palette, kept muted.
interface CodeLang {
  keywords: string[];
  lineComments: string[];
  blockComments: [string, string][];
  strings: string[];
  tripleStrings?: string[];
  tagNames?: boolean;
  cssProps?: boolean;
}
const JS_KEYWORDS = ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "extends", "new", "typeof", "import", "from", "export", "default", "async", "await", "try", "catch", "finally", "throw", "switch", "case", "break", "continue", "this", "super", "null", "undefined", "true", "false", "of", "in", "instanceof", "void", "delete", "yield", "static", "get", "set"];
const CODE_LANGS: Record<string, CodeLang> = {
  js: { keywords: JS_KEYWORDS, lineComments: ["//"], blockComments: [["/*", "*/"]], strings: ["\"", "'", "`"] },
  ts: { keywords: [...JS_KEYWORDS, "interface", "type", "enum", "namespace", "implements", "readonly", "private", "public", "protected", "abstract", "declare"], lineComments: ["//"], blockComments: [["/*", "*/"]], strings: ["\"", "'", "`"] },
  python: { keywords: ["def", "return", "if", "elif", "else", "for", "while", "class", "import", "from", "as", "pass", "None", "True", "False", "and", "or", "not", "in", "is", "lambda", "with", "try", "except", "finally", "raise", "global", "nonlocal", "assert", "del", "yield", "async", "await"], lineComments: ["#"], blockComments: [], strings: ["\"", "'"], tripleStrings: ["\"\"\"", "'''"] },
  json: { keywords: ["true", "false", "null"], lineComments: [], blockComments: [], strings: ["\""] },
  sh: { keywords: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "in", "echo", "cd", "export", "local", "read", "exit"], lineComments: ["#"], blockComments: [], strings: ["\"", "'"] },
  css: { keywords: [], lineComments: [], blockComments: [["/*", "*/"]], strings: ["\"", "'"], cssProps: true },
  html: { keywords: [], lineComments: [], blockComments: [["<!--", "-->"]], strings: ["\"", "'"], tagNames: true },
};
const CODE_LANG_ALIASES: Record<string, string> = {
  javascript: "js", typescript: "ts", py: "python", bash: "sh", shell: "sh", xml: "html",
};
function highlightCode(code: string, langRaw: string): string {
  const key = CODE_LANG_ALIASES[langRaw.toLowerCase()] ?? langRaw.toLowerCase();
  const lang: CodeLang = CODE_LANGS[key] ?? { keywords: [], lineComments: ["//", "#"], blockComments: [["/*", "*/"]], strings: ["\"", "'"] };
  const span = (cls: string, s: string): string => `<span class="tok-${cls}">${escapeHtml(s)}</span>`;
  let out = "", i = 0;
  const n = code.length;
  while (i < n) {
    if (lang.tripleStrings) {
      const t = lang.tripleStrings.find((q) => code.startsWith(q, i));
      if (t) { const end = code.indexOf(t, i + 3); const j = end === -1 ? n : end + 3; out += span("str", code.slice(i, j)); i = j; continue; }
    }
    const bc = lang.blockComments.find(([o]) => code.startsWith(o, i));
    if (bc) { const end = code.indexOf(bc[1], i + bc[0].length); const j = end === -1 ? n : end + bc[1].length; out += span("com", code.slice(i, j)); i = j; continue; }
    const lc = lang.lineComments.find((c) => code.startsWith(c, i));
    if (lc) { let j = code.indexOf("\n", i); if (j === -1) j = n; out += span("com", code.slice(i, j)); i = j; continue; }
    const q = lang.strings.find((qq) => code[i] === qq);
    if (q) {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === q) { j++; break; }
        if (code[j] === "\n" && q !== "`") break;
        j++;
      }
      out += span("str", code.slice(i, j)); i = j; continue;
    }
    if (lang.tagNames && code[i] === "<") {
      const m = /^<\/?([a-zA-Z][\w-]*)/.exec(code.slice(i));
      if (m) { out += escapeHtml(code.slice(i, i + m[0].length - m[1].length)) + span("kw", m[1]); i += m[0].length; continue; }
    }
    const hex = /^0x[0-9a-fA-F]+/.exec(code.slice(i));
    if (hex && (i === 0 || !/[\w$]/.test(code[i - 1]))) { out += span("num", hex[0]); i += hex[0].length; continue; }
    const num = /^\d+(?:\.\d+)?/.exec(code.slice(i));
    if (num && (i === 0 || !/[\w$]/.test(code[i - 1]))) { out += span("num", num[0]); i += num[0].length; continue; }
    const id = /^[A-Za-z_$][\w$-]*/.exec(code.slice(i));
    if (id) {
      const word = id[0];
      if (lang.keywords.includes(word)) out += span("kw", word);
      else if (lang.cssProps && code[i + word.length] === ":") out += span("kw", word);
      else if (code[i + word.length] === "(") out += span("fn", word);
      else out += escapeHtml(word);
      i += word.length; continue;
    }
    out += escapeHtml(code[i]); i++;
  }
  return out;
}

// A checklist line: a bullet or dash, then [ ] or [x].
// The state lives in the markdown text itself, so a toggle
// or a progress change is a text edit and one undo step.
// One shape, used by toggleTaskLine, checklistProgress and
// setChecklistDone, so the count always agrees with what
// a click toggles.
const TASK_LINE = /^([-*]\s+)\[([ xX])\](\s+.*|)$/;

// Flip one checklist line ([ ] <-> [x]); the state lives in
// the markdown text itself, so a toggle is a text edit and
// one undo step. Returns the new line, or null when the
// line is not a task.
export function toggleTaskLine(line: string): string | null {
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  return `${m[1]}[${m[2] === " " ? "x" : " "}]${m[3]}`;
}

// The checklist progress of a note's text: how many task
// lines are done over how many there are. Null when the
// text holds no task lines. The core renders it under the
// card, and plugins read and set it through api.cards.
export function checklistProgress(text: string): { done: number; total: number } | null {
  let total = 0;
  let done = 0;
  for (const line of text.split("\n")) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    total += 1;
    if (m[2] !== " ") done += 1;
  }
  return total === 0 ? null : { done, total };
}

// Set the progress of a note's text: the first `done`
// task lines are checked, the rest unchecked. Returns the
// new text, or null when the text holds no task lines.
// `done` is clamped to the number of task lines.
export function setChecklistDone(text: string, done: number): string | null {
  const lines = text.split("\n");
  const taskCount = lines.filter((line) => TASK_LINE.test(line)).length;
  if (taskCount === 0) return null;
  const want = Math.max(0, Math.min(done, taskCount));
  let seen = 0;
  const next = lines.map((line) => {
    const m = TASK_LINE.exec(line);
    if (!m) return line;
    seen += 1;
    return `${m[1]}[${seen <= want ? "x" : " "}]${m[3]}`;
  });
  return next.join("\n");
}

function renderNoteHtml(text: string): string {
  // Render blocks, keeping link URLs: walk the raw lines and render
  // inline markup with a link-aware pass instead of parseInline's
  // text-only segments.
  const inlineHtml = (s: string): string => {
    let out = "", i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
      if (link) { out += `<a href="#" data-url="${escapeHtml(link[2])}">${escapeHtml(link[1])}</a>`; i += link[0].length; continue; }
      const bold = /^\*\*([^*]+)\*\*/.exec(rest);
      if (bold) { out += `<strong>${escapeHtml(bold[1])}</strong>`; i += bold[0].length; continue; }
      const code = /^`([^`]+)`/.exec(rest);
      if (code) { out += `<code>${escapeHtml(code[1])}</code>`; i += code[0].length; continue; }
      const strike = /^~~([^~]+)~~/.exec(rest);
      if (strike) { out += `<s>${escapeHtml(strike[1])}</s>`; i += strike[0].length; continue; }
      const ital = /^\*([^*]+)\*/.exec(rest);
      if (ital) { out += `<em>${escapeHtml(ital[1])}</em>`; i += ital[0].length; continue; }
      if (s[i] === "\\" && i + 1 < s.length) { out += escapeHtml(s[i + 1]); i += 2; continue; }
      out += escapeHtml(s[i]); i++;
    }
    return out;
  };
  const lines = text.split("\n");
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      html += `<pre>${highlightCode(codeLines.join("\n"), lang)}</pre>`;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { const lvl = heading[1].length; html += `<h${lvl}>${inlineHtml(heading[2])}</h${lvl}>`; i++; continue; }
    const task = /^[-*]\s+\[([ xX])\](?:\s+(.*))?$/.exec(line);
    if (task) {
      const checked = task[1] !== " ";
      const label = task[2] === undefined ? "" : `<span>${inlineHtml(task[2])}</span>`;
      html += `<p class="task"><input type="checkbox" data-action="toggle-task" data-line="${i}"${checked ? " checked" : ""}>${label}</p>`;
      i++; continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { html += `<p>• ${inlineHtml(bullet[1])}</p>`; i++; continue; }
    const ordered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ordered) { html += `<p>${ordered[1]}. ${inlineHtml(ordered[2])}</p>`; i++; continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { html += `<blockquote>${inlineHtml(quote[1])}</blockquote>`; i++; continue; }
    html += `<p>${inlineHtml(line)}</p>`; i++;
  }
  return html;
}

// Where a segment from `from` to `to` crosses a rectangle: entry point
// for the target item, exit point for the source item.
export function rectCrossing(from: Pt, to: Pt, pos: Pt, w: number, h: number, entry: boolean): Pt | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  let t0 = 0, t1 = 1;
  for (const [o, d, lo, hi] of [[from.x, dx, pos.x, pos.x + w], [from.y, dy, pos.y, pos.y + h]] as const) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
  }
  const t = entry ? t0 : t1;
  if (t < 0 || t > 1) return null;
  return { x: from.x + dx * t, y: from.y + dy * t };
}

// Whether a segment enters a rectangle at all, however
// briefly: its Liang-Barsky interval must overlap [0, 1].
// A segment that only touches an edge, with no length
// inside, still counts as entering — the clipped interval
// is a single point, and t0 <= t1 still holds.
export function segmentIntersectsRect(a: Pt, b: Pt, rect: { x: number; y: number; w: number; h: number }): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  for (const [o, d, lo, hi] of [[a.x, dx, rect.x, rect.x + rect.w], [a.y, dy, rect.y, rect.y + rect.h]] as const) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return t0 <= t1;
}

export function clippedEnds(board: Board, from: Anchor, to: Anchor): [Pt, Pt] | null {
  const aRaw = anchorPoint(board, from);
  const bRaw = anchorPoint(board, to);
  if (!aRaw || !bRaw) return null;
  let a = aRaw, b = bRaw;
  if ("Item" in from) {
    const it = boardGet(board, from.Item);
    if (it) { const p = rectCrossing(aRaw, bRaw, it.pos, it.size.w, it.size.h, false); if (p) a = p; }
  }
  if ("Item" in to) {
    const it = boardGet(board, to.Item);
    if (it) { const p = rectCrossing(aRaw, bRaw, it.pos, it.size.w, it.size.h, true); if (p) b = p; }
  }
  return [a, b];
}

export function tileColorFor(domain: string): string {
  const tiles = ["#2E86AB", "#6A4C93", "#2A9D8F", "#FF6B35", "#E63946", "#B56576"];
  let h = 0;
  for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return tiles[h % tiles.length];
}

export function tint(hex: string, whiteMix: number): string {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  const m = (c: number) => Math.round(c * (1 - whiteMix) + 255 * whiteMix);
  return `rgb(${m(rgb[0])},${m(rgb[1])},${m(rgb[2])})`;
}

export function elide(s: string, widthPx: number, textPx: number, bold: boolean): string {
  const perChar = textPx * (bold ? 0.55 : 0.5);
  const budget = Math.floor(widthPx / perChar);
  const chars = [...s];
  if (chars.length <= budget || budget < 2) return s;
  return chars.slice(0, budget - 1).join("").trimEnd() + "…";
}
