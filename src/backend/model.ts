// Board model: types, geometry and hit-testing, ported from the
// GPUI board so existing board.json files load unchanged.
// Markdown lives in markdown.ts.

import type { Anchor, ArrangeOptions, Block, Board, Camera, GradientStop, GroupEntry, ImportSource, Item, Kind, Layer, Pt, Segment, ShapeKind, Size, StrokeGradient } from "bowerbird-plugin-api";
export type { Anchor, ArrangeOptions, Block, Board, Camera, GradientStop, GroupEntry, ImportSource, Item, Kind, Layer, Pt, Segment, ShapeKind, Size, StrokeGradient };

// Shape outline fractions, in % of the shape's box. The single
// source of truth for a shape's geometry: cards.ts renders the
// shape from these (clip-path) and the drag preview from these,
// and hit-testing uses them too, so the clickable area is
// exactly the visible shape — never its empty corners.
const SHAPE_POLYGONS: Record<"triangle" | "diamond" | "hexagon" | "star" | "arrow", Array<[number, number]>> = {
  triangle: [[0.5, 0], [1, 1], [0, 1]],
  diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
  hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
  star: [[0.5, 0], [0.61, 0.35], [0.98, 0.35], [0.68, 0.57], [0.79, 0.91], [0.5, 0.7], [0.21, 0.91], [0.32, 0.57], [0.02, 0.35], [0.39, 0.35]],
  arrow: [[0, 0.4], [0.6, 0.4], [0.6, 0.15], [1, 0.5], [0.6, 0.85], [0.6, 0.6], [0, 0.6]],
};

// Outline polygon of a shape in board coords, or null when the
// shape has no polygon (rect fills its box; ellipse is curved).
export function shapePolygon(kind: ShapeKind, x: number, y: number, w: number, h: number): Pt[] | null {
  const fractions = SHAPE_POLYGONS[kind as keyof typeof SHAPE_POLYGONS];
  if (!fractions) return null;
  return fractions.map(([fx, fy]) => ({ x: x + fx * w, y: y + fy * h }));
}

// An audio card with a transcript is short by default —
// player, seek, and a Transcript toggle — until the toggle
// grows it to show the text. The card's height is the
// state: taller than the hidden height, the transcript
// shows; at it or below, only the toggle does. Both the
// card renderer and the toggle use these, so they agree.
export const AUDIO_TRANSCRIPT_HIDDEN_H = 164;
export const AUDIO_TRANSCRIPT_SHOWN_H = 240;
// An audio card with no transcript.
export const AUDIO_H = 104;


// A local video in a format Chromium can play inline, so it
// can be shown and played on the board itself. Remote links
// and other formats open outside the app. Shared by the video
// card (poster vs live element) and the play-video action.
export function isInlineVideo(source: string, remote: boolean): boolean {
  if (remote) return false;
  const ext = source.toLowerCase().split("?")[0].split("#")[0].split(".").pop() ?? "";
  return ["mp4", "webm", "m4v"].includes(ext);
}

// The frame to capture for a video's poster: one second in,
// so a black first frame never becomes the poster's face;
// for a very short clip, a quarter of the way in instead.
export function posterTime(duration: number): number {
  if (!isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, duration * 0.25);
}

// The poster file name for a video source: the video's own
// name with -poster.jpg. embedFileBytes dedups on collision,
// so a second capture of the same video gets -poster-1.jpg —
// fine, the item points at the path it got back.
export function posterNameFor(source: string): string {
  const base = source.split("?")[0].split("#")[0].split("/").pop() ?? "video";
  const stem = base.replace(/\.[^.]*$/, "");
  return `${stem || "video"}-poster.jpg`;
}


export const GRID = 100;

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

// The bounding box of a set of items, or null when empty.
// Shared by fitCamera and the group-centring sites (main's
// onJumpTo, and the board plugin's own copy that reads
// through api.geometry.itemBounds).
function itemsBounds(board: Board, items: Item[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    const [p, s] = itemBounds(board, it);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
export function itemsCentre(board: Board, items: Item[]): Pt | null {
  const b = itemsBounds(board, items);
  return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
}

// The bounding box of the segment between two points:
// the connector's pos/size, at both the API and the
// board tool. Floored at 1 so a degenerate line still
// has a size.
export function rectFromPoints(a: Pt, b: Pt): { pos: Pt; size: Size } {
  return {
    pos: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    size: { w: Math.max(1, Math.abs(b.x - a.x)), h: Math.max(1, Math.abs(b.y - a.y)) },
  };
}

// Zoom to fit: the camera that shows every item at once.
// The zoom is capped at 1 — a small board is centred, not
// blown up — and a margin keeps cards off the edges. An
// empty board has nothing to fit, so there is no camera.
export function fitCamera(board: Board, viewport: Size, padding = 48): Camera | null {
  const b = itemsBounds(board, board.items);
  if (!b) return null;
  const bw = Math.max(1, b.w), bh = Math.max(1, b.h);
  const availW = Math.max(1, viewport.w - padding * 2), availH = Math.max(1, viewport.h - padding * 2);
  const zoom = Math.min(1, availW / bw, availH / bh);
  return {
    x: b.x + b.w / 2 - viewport.w / 2 / zoom,
    y: b.y + b.h / 2 - viewport.h / 2 / zoom,
    zoom,
  };
}

// Camera/viewport conversions, shared by the board plugin
// and main (both had their own identical copies). The
// floor is 0.01, not 0.1: fit must reach very wide boards.
export function clampZoom(z: number): number {
  return Math.max(0.01, Math.min(8, z));
}
export function screenToWorld(s: Pt, cam: Camera): Pt {
  return { x: s.x / cam.zoom + cam.x, y: s.y / cam.zoom + cam.y };
}
export function worldToScreen(p: Pt, cam: Camera): Pt {
  return { x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom };
}
// The camera after zooming by a factor around a screen
// point: the point stays under the cursor. Pure — the
// caller applies the result (setCameraSilent in the board
// plugin, a direct assign in main).
export function zoomCamera(cam: Camera, screen: Pt, factor: number): Camera {
  const before = screenToWorld(screen, cam);
  const zoom = clampZoom(cam.zoom * factor);
  const after = { x: screen.x / zoom + cam.x, y: screen.y / zoom + cam.y };
  return { x: cam.x + before.x - after.x, y: cam.y + before.y - after.y, zoom };
}
export function elementSize(el: HTMLElement): Pt {
  return { x: el.clientWidth, y: el.clientHeight };
}
export function elementPoint(el: HTMLElement, clientX: number, clientY: number): Pt {
  const r = el.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}


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

// A rotated stroke is hit in its own frame, like a rotated
// card: rotate the point back by -rotation around the
// bounding-box centre, then test the unrotated points.
// Returns null when the point is outside the stroke's
// bounding box (grown by the tolerance) — the old code
// scanned every point of every stroke on every cursor
// move, even for strokes far from the cursor.
function strokePointInFrame(item: Item, world: Pt, tol: number): Pt | null {
  const rot = itemRotation(item);
  const p = rot !== 0 ? rotatePoint(world, centre(item), -rot) : world;
  if (p.x < item.pos.x - tol || p.x > item.pos.x + item.size.w + tol ||
    p.y < item.pos.y - tol || p.y > item.pos.y + item.size.h + tol) return null;
  return p;
}
function strokeHitTest(points: Pt[], p: Pt, tol: number): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    if (distToSegment(p, points[i], points[i + 1]) <= tol) return true;
  }
  return points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
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
    const p = strokePointInFrame(item, world, tol);
    return p !== null && strokeHitTest(points, p, tol);
  }
  // A rotated card is hit in its own frame: rotate the point
  // back by -rotation around the centre, then test the
  // unrotated rect. Without this, a rotated card's corners
  // (outside the rect, inside its axis-aligned box) would
  // still select it, and its real corners would not.
  let p = world;
  const rot = itemRotation(item);
  if (rot !== 0) p = rotatePoint(world, centre(item), -rot);
  // A shape is hit on its visible geometry, not its box: the
  // empty corners of a triangle, star or arrow must not steal
  // clicks meant for the card beneath, or block a marquee
  // starting there. Rect fills its box; an ellipse is tested
  // as an ellipse.
  if ("Shape" in item.kind) {
    const shape = item.kind.Shape.shape;
    // An outline shape is a stroked edge, not a filled
    // area: its interior is empty, so only the edge
    // selects it. The outline stroke is 4px wide; the
    // tolerance matches the stroke convention (half the
    // width + 6, floored at 8), so the edge is as easy to
    // grab as a pen stroke.
    if (item.kind.Shape.outline === true) {
      const tol = 8;
      if (shape === "rect") {
        const { x, y } = item.pos, { w, h } = item.size;
        const inOuter = p.x >= x - tol && p.x <= x + w + tol && p.y >= y - tol && p.y <= y + h + tol;
        const inInner = p.x > x + tol && p.x < x + w - tol && p.y > y + tol && p.y < y + h - tol;
        return inOuter && !inInner;
      }
      if (shape === "ellipse") {
        const rx = item.size.w / 2, ry = item.size.h / 2;
        const dx = (p.x - (item.pos.x + rx)) / rx;
        const dy = (p.y - (item.pos.y + ry)) / ry;
        return Math.abs(Math.hypot(dx, dy) - 1) * Math.min(rx, ry) <= tol;
      }
      const poly = shapePolygon(shape, item.pos.x, item.pos.y, item.size.w, item.size.h);
      if (poly) {
        for (let i = 0; i < poly.length; i++) {
          if (distToSegment(p, poly[i], poly[(i + 1) % poly.length]) <= tol) return true;
        }
        return false;
      }
    }
    if (shape === "ellipse") {
      const dx = (p.x - (item.pos.x + item.size.w / 2)) / (item.size.w / 2);
      const dy = (p.y - (item.pos.y + item.size.h / 2)) / (item.size.h / 2);
      return dx * dx + dy * dy <= 1;
    }
    const poly = shapePolygon(shape, item.pos.x, item.pos.y, item.size.w, item.size.h);
    if (poly) return pointInPolygon(p, poly);
  }
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
      // A hidden layer is not on the board: its items
      // cannot be clicked, dragged or selected.
      if (!isItemVisible(board, it)) continue;
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
// A stroke's effective opacity: its own opacity, 0–100
// (an old board has none, which means 100), multiplied
// by the marker's 0.45 — a translucent highlighter is
// fainter still. The renderer and the drag preview share
// it, so a stroke looks the same while drawing as after
// release.
export function strokeOpacity(stroke: { opacity?: number; marker: boolean }): number {
  const base = stroke.opacity ?? 100;
  // Rounded to three decimals: 0.3 × 0.45 must paint as
  // 0.135, not 0.13500000000000001.
  return Math.round((base / 100) * (stroke.marker ? 0.45 : 1) * 1000) / 1000;
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

// Smoothing a freehand stroke: fast drawing leaves sparse
// points, and a polyline through them has visible corners.
// A Catmull-Rom spline through the same points is smooth
// and passes through every point, so the line goes where
// the user drew it. Only the rendering changes — the stored
// points, hit-testing, the eraser and undo all keep the raw
// polyline, and the spline follows it closely enough that
// the hit test still matches what is drawn.

// One Catmull-Rom segment as a cubic Bézier: p1→p2, with
// control points from the neighbours p0 and p3.
function catmullRomBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt): [Pt, Pt] {
  return [
    { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
    { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
  ];
}
const round2 = (v: number): number => Math.round(v * 100) / 100;

// The smooth path through the points, as an SVG path
// string. Two points is a straight line; fewer is empty.
export function smoothStrokePath(points: Pt[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) return `M${points[0].x},${points[0].y} L${points[1].x},${points[1].y}`;
  const n = points.length;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i + 1 < n; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, n - 1)];
    const [c1, c2] = catmullRomBezier(p0, p1, p2, p3);
    d += ` C${round2(c1.x)},${round2(c1.y)} ${round2(c2.x)},${round2(c2.y)} ${p2.x},${p2.y}`;
  }
  return d;
}

// A point on the Catmull-Rom segment p1→p2 at t in [0,1].
function catmullRomPoint(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

// Sample the smooth curve through the points, so a stroke
// whose width varies can be drawn as short straight lines
// between close samples instead of long ones between the
// sparse raw points — the kinks disappear. Each original
// segment contributes `steps` samples; the shared endpoint
// is emitted once, so the result is (n−1)·steps + 1 points.
export function smoothStrokeSamples(points: Pt[], steps = 4): Pt[] {
  const n = points.length;
  if (n < 2 || steps <= 1) return [...points];
  const out: Pt[] = [points[0]];
  for (let i = 0; i + 1 < n; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, n - 1)];
    for (let s = 1; s <= steps; s++) out.push(catmullRomPoint(p0, p1, p2, p3, s / steps));
  }
  return out;
}

// The pressures at the sampled points: linear between the
// pressures of the segment's endpoints, so a sample's
// width matches the curve's position along the stroke.
// Same length as smoothStrokeSamples with the same steps.
export function smoothStrokePressures(pressures: number[], steps = 4): number[] {
  const n = pressures.length;
  if (n < 2 || steps <= 1) return [...pressures];
  const out: number[] = [pressures[0]];
  for (let i = 0; i + 1 < n; i++) {
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push(pressures[i] + (pressures[i + 1] - pressures[i]) * t);
    }
  }
  return out;
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
    if (!isItemVisible(board, it)) continue;
    const tol = radius + strokeMaxWidth(it.kind.Stroke) / 2;
    const p = strokePointInFrame(it, world, tol);
    if (p !== null && strokeHitTest(it.kind.Stroke.points, p, tol)) out.push(it.id);
  }
  return out;
}

// Split a stroke where the eraser passes, the way a real
// eraser lifts only the ink it touches: points inside the
// eraser circle (radius + half the stroke width) are gone,
// and the stroke breaks into the contiguous runs that
// remain. A run of one point cannot draw, so it is
// dropped. Pressures travel with their points, so a split
// stroke keeps its thick and thin parts. A segment that
// crosses the circle with both ends outside it still cuts
// the run, or a fast stroke would survive a sweep through
// its middle.
export function splitStrokeByEraser(
  points: Pt[],
  pressures: number[] | undefined,
  center: Pt,
  radius: number,
  halfWidth: number,
): { points: Pt[]; pressures?: number[] }[] {
  const tol = radius + halfWidth;
  const runs: { points: Pt[]; pressures?: number[] }[] = [];
  let cur: Pt[] = [];
  let curPr: number[] = [];
  const hasPr = pressures !== undefined && pressures.length === points.length;
  const flush = () => {
    if (cur.length >= 2) {
      runs.push(hasPr ? { points: cur, pressures: curPr } : { points: cur });
    }
    cur = [];
    curPr = [];
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const erased = Math.hypot(p.x - center.x, p.y - center.y) <= tol;
    if (erased) {
      flush();
      continue;
    }
    // The segment from the previous point crosses the
    // eraser circle: the run breaks here even though
    // both ends survive.
    if (cur.length > 0 && distToSegment(center, points[i - 1], p) <= tol) {
      flush();
    }
    cur.push(p);
    if (hasPr) curPr.push(pressures![i]);
  }
  flush();
  return runs;
}

export function marquee(board: Board, a: Pt, b: Pt): number[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return board.items.filter((it) => {
    if (!isItemVisible(board, it)) return false;
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
    if (!isItemVisible(board, it)) return false;
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

// A board file can carry two cards with the same id —
// a stale next_id, a bad import, hand-editing. A duplicate
// id used to kill search outright (MiniSearch throws on
// duplicate document ids), so heal it on load: the first
// card keeps the id, later ones get fresh ids. References
// to the duplicated id (a connector endpoint, a group) are
// ambiguous by construction, so they keep pointing at the
// first card, which is the one that kept the id.
export function healDuplicateIds(board: Board): void {
  // next_id is the last allocated id, so it can lag behind
  // the highest id on a corrupt board; allocating from a
  // stale next_id could hand out an id already in use.
  for (const it of board.items) {
    if (it.id > board.next_id) board.next_id = it.id;
  }
  const seen = new Set<number>();
  for (const it of board.items) {
    if (seen.has(it.id)) it.id = allocId(board);
    else seen.add(it.id);
  }
}

// ---------------------------------------------------------------- layers
// Paint order, visibility and lock of a board's items.

export const DEFAULT_LAYER_ID = "default";
export const DEFAULT_LAYER_NAME = "Default";

export function defaultLayer(): Layer {
  return { id: DEFAULT_LAYER_ID, name: DEFAULT_LAYER_NAME, visible: true, locked: false };
}

export function layerById(board: Board, id: string): Layer | undefined {
  return board.layers?.find((l) => l.id === id);
}

// The layer an item sits on: its `layer` field, or the
// default when it has none (an old board, or an item added
// before layers existed).
export function itemLayerId(item: Item): string {
  return item.layer ?? DEFAULT_LAYER_ID;
}

export function isLayerVisible(board: Board, layerId: string): boolean {
  const layer = layerById(board, layerId);
  // A layer the board does not know (a board mid-edit, or
  // one healed before its layer existed) is visible: an
  // item is never hidden by a missing record.
  return layer ? layer.visible : true;
}

export function isItemVisible(board: Board, item: Item): boolean {
  return isLayerVisible(board, itemLayerId(item));
}

export function isItemLocked(board: Board, item: Item): boolean {
  return layerById(board, itemLayerId(item))?.locked ?? false;
}

// Paint-order index of a layer: its place in the layers
// array. An unknown layer id paints with the default
// layer, so it is never lost off the bottom.
export function layerIndex(board: Board, layerId: string): number {
  const layers = board.layers ?? [];
  const i = layers.findIndex((l) => l.id === layerId);
  if (i >= 0) return i;
  const d = layers.findIndex((l) => l.id === DEFAULT_LAYER_ID);
  return d >= 0 ? d : 0;
}

// Items in paint order: layers bottom-to-top, board order
// within a layer. A stable sort, so items on one layer
// keep the order they have in board.items.
export function sortItemsByLayer(board: Board, items: Item[]): Item[] {
  return [...items].sort((a, b) => layerIndex(board, itemLayerId(a)) - layerIndex(board, itemLayerId(b)));
}

// Layers and per-board plugin data, healed on load —
// in memory only. Every item ends on a layer that exists,
// the default layer is always first, and extensions is
// always an object.
export function healLayers(board: Board): void {
  const layers = Array.isArray(board.layers) ? board.layers : [];
  const seen = new Set<string>();
  const kept: Layer[] = [];
  for (const l of layers) {
    if (!l || typeof l.id !== "string" || seen.has(l.id)) continue;
    seen.add(l.id);
    kept.push({
      id: l.id,
      name: typeof l.name === "string" && l.name.trim() ? l.name : l.id,
      visible: l.visible !== false,
      locked: l.locked === true,
    });
  }
  if (!seen.has(DEFAULT_LAYER_ID)) {
    kept.unshift(defaultLayer());
    seen.add(DEFAULT_LAYER_ID);
  }
  board.layers = kept;
  for (const it of board.items) {
    if (typeof it.layer !== "string" || !seen.has(it.layer)) it.layer = DEFAULT_LAYER_ID;
  }
  if (!board.extensions || typeof board.extensions !== "object" || Array.isArray(board.extensions)) {
    board.extensions = {};
  }
}

export function nextLayerId(board: Board): string {
  let n = 0;
  for (const l of board.layers ?? []) {
    const m = /^layer-(\d+)$/.exec(l.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `layer-${n + 1}`;
}

export function createLayer(board: Board, name?: string): Layer {
  const layers = (board.layers ??= [defaultLayer()]);
  const id = nextLayerId(board);
  const trimmed = name?.trim();
  const layer: Layer = { id, name: trimmed ? trimmed : `Layer ${layers.length + 1}`, visible: true, locked: false };
  layers.push(layer);
  return layer;
}

export function renameLayer(board: Board, id: string, name: string): boolean {
  const layer = layerById(board, id);
  const trimmed = name.trim();
  if (!layer || !trimmed) return false;
  layer.name = trimmed;
  return true;
}

export function moveLayer(board: Board, id: string, toIndex: number): boolean {
  const layers = board.layers ?? [];
  const from = layers.findIndex((l) => l.id === id);
  if (from < 0) return false;
  const [layer] = layers.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, layers.length));
  layers.splice(clamped, 0, layer);
  return true;
}

export function setLayerVisible(board: Board, id: string, visible: boolean): boolean {
  const layer = layerById(board, id);
  if (!layer) return false;
  layer.visible = visible;
  return true;
}

export function setLayerLocked(board: Board, id: string, locked: boolean): boolean {
  const layer = layerById(board, id);
  if (!layer) return false;
  layer.locked = locked;
  return true;
}

// Deleting a layer moves its items onto the default layer,
// so nothing is lost with it. The default layer cannot be
// deleted: every board keeps somewhere for its items.
export function deleteLayer(board: Board, id: string): boolean {
  if (id === DEFAULT_LAYER_ID) return false;
  const layers = board.layers ?? [];
  if (!layers.some((l) => l.id === id)) return false;
  board.layers = layers.filter((l) => l.id !== id);
  for (const it of board.items) {
    if (itemLayerId(it) === id) it.layer = DEFAULT_LAYER_ID;
  }
  return true;
}

export function setItemLayer(board: Board, id: number, layerId: string): boolean {
  if (!layerById(board, layerId)) return false;
  const it = boardGet(board, id);
  if (!it) return false;
  it.layer = layerId;
  return true;
}

// ---------------------------------------------------------------- per-board plugin data
// Namespaced by plugin id: a plugin reads and writes only
// its own entry. Data must be JSON — a value that cannot
// survive a round trip is rejected, not saved half-broken.

export function getBoardExtension(board: Board, pluginId: string): unknown {
  const ext = board.extensions?.[pluginId];
  return ext === undefined ? undefined : JSON.parse(JSON.stringify(ext)) as unknown;
}

export function setBoardExtension(board: Board, pluginId: string, data: unknown): void {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(data)) as unknown;
  } catch {
    throw new Error(`Plugin ${pluginId} extension data must be JSON`);
  }
  if (copy === undefined) throw new Error(`Plugin ${pluginId} extension data must be JSON`);
  board.extensions ??= {};
  board.extensions[pluginId] = copy;
}

export function removeBoardExtension(board: Board, pluginId: string): boolean {
  if (!board.extensions || !(pluginId in board.extensions)) return false;
  delete board.extensions[pluginId];
  return true;
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
    // A locked layer does not move: a drag that catches a
    // locked card leaves it where it is, and moves the rest.
    if (isItemLocked(board, it)) continue;
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
  // A locked layer does not resize.
  if (isItemLocked(board, it)) return;
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

// Resize a card by a drag while keeping its aspect ratio:
// the card scales by one factor, driven by whichever axis
// the pointer moved further (relatively), so a diagonal
// drag follows the pointer and a mostly-horizontal or
// mostly-vertical drag still keeps the ratio. The factor
// is floored so neither side goes below the 48px minimum
// resizeItem enforces — clamping the sides separately
// would break the ratio at the floor.
export function proportionalResize(origW: number, origH: number, dx: number, dy: number): { w: number; h: number } {
  if (!(origW > 0) || !(origH > 0)) return { w: Math.max(48, origW + dx), h: Math.max(48, origH + dy) };
  const sx = (origW + dx) / origW;
  const sy = (origH + dy) / origH;
  let s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
  s = Math.max(s, 48 / origW, 48 / origH);
  return { w: origW * s, h: origH * s };
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

// A linear gradient, validated and normalised: the angle
// is always 0 — gradients run left to right — and two
// or more stops, each an offset 0–100 with a normalised
// hex, stored in offset order. Anything else is not a
// gradient. Null is not valid here — null means "no
// gradient", and is handled by the caller. The angle
// field stays on the model for compatibility, but a
// stored gradient at any other angle renders at 0.
export function normaliseGradient(value: unknown): StrokeGradient | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { angle, stops } = value as { angle?: unknown; stops?: unknown };
  if (typeof angle !== "number" || !Number.isFinite(angle)) return null;
  if (!Array.isArray(stops) || stops.length < 2) return null;
  const clean: GradientStop[] = [];
  for (const s of stops) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    const { offset, color } = s as { offset?: unknown; color?: unknown };
    if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0 || offset > 100) return null;
    if (typeof color !== "string") return null;
    const hex = normaliseHex(color);
    if (!hex) return null;
    clean.push({ offset, color: hex });
  }
  clean.sort((a, b) => a.offset - b.offset);
  return { angle: 0, stops: clean };
}

// The userSpaceOnUse endpoints of a linear gradient at
// `angle` across a box: 0° runs left to right, 90° top to
// bottom, clockwise. The endpoints are the projections
// of the box's corners onto the direction, so the
// gradient spans exactly the box along its angle — a
// diagonal gradient reaches corner to corner, not edge
// to edge. Rounded, so two renders of the same gradient
// produce the same attribute text.
export function linearGradientCoords(angle: number, box: { x: number; y: number; w: number; h: number }): { x1: number; y1: number; x2: number; y2: number } {
  const r = (angle * Math.PI) / 180;
  const dx = Math.cos(r), dy = Math.sin(r);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let tMin = Infinity, tMax = -Infinity;
  for (const [x, y] of [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]] as const) {
    const t = (x - cx) * dx + (y - cy) * dy;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  // Rounded, so two renders of the same gradient
  // produce the same attribute text. A -0 rounds to 0:
  // cos(90°) is a hair above zero, so a vertical
  // gradient's x would otherwise come out as -0.
  const round2 = (v: number): number => {
    const r = Math.round(v * 100) / 100;
    return r === 0 ? 0 : r;
  };
  return {
    x1: round2(cx + dx * tMin), y1: round2(cy + dy * tMin),
    x2: round2(cx + dx * tMax), y2: round2(cy + dy * tMax),
  };
}

// A colour data patch: the one `data` edit a plugin may make
// on a core card. A stroke takes { color?, opacity?, gradient? } — a
// non-empty subset of the three, each validated: the colour
// is a normalised hex, the opacity a number 0–100, the
// gradient a normalised linear gradient — or null, which
// clears the gradient and leaves the stroke solid. A
// swatch takes { hex }; anything else is not a colour
// patch. A patch that leaves a field out leaves that
// field alone, so recolouring a translucent stroke at
// opacity 100 has to send opacity: 100 to restore it.
export function colourDataPatch(item: Item, data: unknown): { color?: string; opacity?: number; gradient?: StrokeGradient | null } | { hex: string } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if ("Stroke" in item.kind) {
    if (keys.length === 0 || keys.some((k) => k !== "color" && k !== "opacity" && k !== "gradient")) return null;
    const patch: { color?: string; opacity?: number; gradient?: StrokeGradient | null } = {};
    if ("color" in data) {
      const value = (data as { color?: unknown }).color;
      if (typeof value !== "string") return null;
      const hex = normaliseHex(value);
      if (!hex) return null;
      patch.color = hex;
    }
    if ("opacity" in data) {
      const value = (data as { opacity?: unknown }).opacity;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
      patch.opacity = Math.round(value);
    }
    if ("gradient" in data) {
      const value = (data as { gradient?: unknown }).gradient;
      if (value === null) {
        patch.gradient = null;
      } else {
        const gradient = normaliseGradient(value);
        if (!gradient) return null;
        patch.gradient = gradient;
      }
    }
    return patch;
  }
  if ("Swatch" in item.kind) {
    if (keys.length !== 1 || keys[0] !== "hex") return null;
    const value = (data as { hex?: unknown }).hex;
    if (typeof value !== "string") return null;
    const hex = normaliseHex(value);
    return hex ? { hex } : null;
  }
  return null;
}

// Apply a colour data patch to a core card. False when the
// patch is not a colour patch for this card, so the caller
// knows nothing changed.
export function applyColourDataPatch(item: Item, data: unknown): boolean {
  const patch = colourDataPatch(item, data);
  if (!patch) return false;
  if ("hex" in patch) {
    if (!("Swatch" in item.kind)) return false;
    item.kind.Swatch.hex = patch.hex;
  } else {
    if (!("Stroke" in item.kind)) return false;
    if (patch.color !== undefined) item.kind.Stroke.color = patch.color;
    if (patch.opacity !== undefined) item.kind.Stroke.opacity = patch.opacity;
    // A null gradient clears the field outright, so the
    // stroke goes back to solid and the board JSON carries
    // no leftover gradient — missing means solid, exactly
    // as on an old board.
    if (patch.gradient !== undefined) {
      if (patch.gradient === null) delete item.kind.Stroke.gradient;
      else item.kind.Stroke.gradient = patch.gradient;
    }
  }
  return true;
}

// Markdown lives in markdown.ts; re-exported here so existing
// imports from "./model" keep working.
export { CARD_DECORATIONS_H, checklistProgress, escapeHtml, estimateTextHeight, parseInline, parseMarkdown, renderMarkdownHtml, setChecklistDone, toggleTaskLine } from "./markdown";

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
  // The same interval test as rectCrossing: the segment
  // crosses the rect exactly when rectCrossing finds a
  // point on it (its t0 is already in [0, 1] when it does).
  return rectCrossing(a, b, { x: rect.x, y: rect.y }, rect.w, rect.h, true) !== null;
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
