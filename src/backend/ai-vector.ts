// AI vector extraction: turn one PDF page's operator list
// (pdf.js `page.getOperatorList()`) into editable board cards.
//
// Pure module — no DOM, no canvas, no pdf.js import — so it is
// unit-testable in Node. The caller (ai-import.ts) loads pdf.js,
// opens the document and hands each page's operator list here;
// embedded images come back as requests the caller resolves
// through `page.objs`, and a page with anything this cannot
// represent comes back flagged `unmappable`, so the caller
// renders that page as one Image card instead (never a PdfCard).
//
// What lands: filled/stroked paths become Shape cards where the
// path is a rectangle or an ellipse (a circle drawn as four
// cubic Beziers, the way Illustrator writes one), otherwise
// Stroke cards with the path flattened to points (curves
// sampled, like the SVG import); text (showText) becomes Text
// cards; embedded images (paintImageXObject) become Image
// cards. The graphics state is tracked throughout — current
// transform matrix, fill/stroke colours, line width, dash,
// text state — so nested transforms (including Form XObjects,
// which pdf.js inlines with a transform op) land in the right
// place. Coordinates are PDF user space (y-up); items come
// back in board page coordinates (y-down from the page top).
//
// What does NOT map, and sends the whole page to the raster
// fallback: gradients/shadings, pattern fills, clipping paths,
// transparency (alpha < 1, soft masks, non-Normal blend modes),
// dashed strokes, image masks, inline images, and text in a
// clipping rendering mode. A filled arbitrary path is an
// outline-only Stroke card in its fill colour — the board has
// no filled-polygon card — and a path that is both filled and
// stroked lands as two cards (the fill shape plus the edge).
// Transparency groups (beginGroup/endGroup) are treated as
// no-ops: their contents extract normally, blend modes and
// knockout inside them are not reproduced.
//
// Operator numbers are pdf.js's OPS enum (pdfjs-dist 6.5.438,
// pinned in package.json); the unit test asserts they still
// match the installed pdf.js, so a pdf.js upgrade that
// renumbers them fails loudly instead of silently misreading
// a file. The path-segment numbers inside a constructPath are
// pdf.js's DrawOPS enum (moveTo 0, lineTo 1, curveTo 2,
// quadraticCurveTo 3, closePath 4).
import type { Kind, Pt, Size } from "bowerbird-plugin-api";
import { estimateTextHeight } from "./model";
import type { ImportedItem } from "./import-types";
import { multiplyMatrix, type Matrix } from "./svg-import";

// pdf.js OPS numbers (see the module header).
export const AI_OPS = {
  dependency: 1,
  setLineWidth: 2,
  setLineCap: 3,
  setLineJoin: 4,
  setMiterLimit: 5,
  setDash: 6,
  setRenderingIntent: 7,
  setFlatness: 8,
  setGState: 9,
  save: 10,
  restore: 11,
  transform: 12,
  clip: 29,
  eoClip: 30,
  beginText: 31,
  endText: 32,
  setCharSpacing: 33,
  setWordSpacing: 34,
  setHScale: 35,
  setLeading: 36,
  setFont: 37,
  setTextRenderingMode: 38,
  setTextRise: 39,
  moveText: 40,
  setLeadingMoveText: 41,
  setTextMatrix: 42,
  nextLine: 43,
  showText: 44,
  showSpacedText: 45,
  nextLineShowText: 46,
  nextLineSetSpacingShowText: 47,
  setCharWidth: 48,
  setCharWidthAndBounds: 49,
  setStrokeColorSpace: 50,
  setFillColorSpace: 51,
  setStrokeColor: 52,
  setStrokeColorN: 53,
  setFillColor: 54,
  setFillColorN: 55,
  setStrokeGray: 56,
  setFillGray: 57,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  setStrokeCMYKColor: 60,
  setFillCMYKColor: 61,
  shadingFill: 62,
  beginInlineImage: 63,
  beginImageData: 64,
  endInlineImage: 65,
  paintXObject: 66,
  markPoint: 67,
  markPointProps: 68,
  beginMarkedContent: 69,
  beginMarkedContentProps: 70,
  endMarkedContent: 71,
  beginCompat: 72,
  endCompat: 73,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  beginAnnotation: 80,
  endAnnotation: 81,
  paintImageMaskXObject: 83,
  paintImageMaskXObjectGroup: 84,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87,
  paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89,
  paintSolidColorImageMask: 90,
  constructPath: 91,
  setStrokeTransparent: 92,
  setFillTransparent: 93,
  rawFillPath: 94,
} as const;

// DrawOPS numbers inside a constructPath's path array.
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

// The paint operator carried as a constructPath's first arg.
const PAINT = {
  stroke: 20, closeStroke: 21, fill: 22, eoFill: 23,
  fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27,
  endPath: 28,
} as const;

export interface AiOpList {
  fnArray: number[];
  argsArray: unknown[][];
}

export interface AiImageRequest {
  objId: string;
  pos: Pt;
  size: Size;
  rotation?: number;
}

export interface AiRawItem extends ImportedItem {
  // Text cards carry their font size separately while the
  // import is still in page units, so the final scale step
  // can shrink it with the card (same pattern as the SVG
  // import's RawItem).
  fontSize?: number;
}

export interface AiExtractResult {
  // Items in board page coordinates: y-down, origin at the
  // page's top-left. The caller stacks pages and scales the
  // union to the board (see ai-import.ts).
  items: AiRawItem[];
  // Embedded images, with their placement. The caller
  // resolves each objId through page.objs and turns it into
  // an Image card; if one cannot be resolved, the whole page
  // falls back to a raster (the caller decides that).
  images: AiImageRequest[];
  // True when the page holds something this extractor cannot
  // represent: the caller renders the whole page as one Image
  // card and discards `items`/`images` for the page.
  unmappable: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------- colours

type Paint = string | null | "pattern";

const hexOf = (r: number, g: number, b: number): string => {
  const h = (c: number): string => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
};

const grayHex = (g: number): string => hexOf(g, g, g);

const cmykHex = (c: number, m: number, y: number, k: number): string =>
  hexOf((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

// A colour operator's numeric args to a hex, in the given
// colour space. Null when the args do not fit the space.
function colorArgsToHex(args: unknown[], space: string): string | null {
  const nums = args.filter((a): a is number => typeof a === "number");
  if (nums.length !== args.length) return null;
  if (space === "DeviceGray" && nums.length === 1) return grayHex(nums[0]);
  if (space === "DeviceRGB" && nums.length === 3) return hexOf(nums[0], nums[1], nums[2]);
  if (space === "DeviceCMYK" && nums.length === 4) return cmykHex(nums[0], nums[1], nums[2], nums[3]);
  return null;
}

// ---------------------------------------------------------------- geometry

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function applyMatrix(m: Matrix, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

// Uniform scale of a matrix's linear part (exact for the
// translate/uniform-scale CTMs Illustrator writes; an
// approximation for a sheared one).
function matrixScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

function matrixRotation(m: Matrix): number | undefined {
  if (Math.abs(m[1]) > 0.001 || Math.abs(m[2]) > 0.001) {
    return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  }
  return undefined;
}

// Flatten one cubic / quadratic Bezier to points (same
// sampling as the SVG import: cubics 8 steps, quadratics 6).
function cubicPoints(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt[] {
  const out: Pt[] = [];
  for (let s = 1; s <= 8; s++) {
    const t = s / 8, u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

function quadPoints(p0: Pt, p1: Pt, p2: Pt): Pt[] {
  const out: Pt[] = [];
  for (let s = 1; s <= 6; s++) {
    const t = s / 6, u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
  }
  return out;
}

// ---------------------------------------------------------------- paths

interface Subpath {
  // Flattened points in PDF user space (already CTM'd), in
  // draw order; the first point repeats at the end when the
  // path is closed.
  points: Pt[];
  closed: boolean;
  // True when the subpath is exactly four cubic segments.
  fourCubics: boolean;
}

function parseDrawOps(ops: ArrayLike<number>, ctm: Matrix): Subpath[] {
  const subs: Subpath[] = [];
  let cur: Pt[] = [];
  let start: Pt | null = null;
  let curves = 0;
  let closed = false;
  const flush = (): void => {
    if (cur.length > 0) {
      // A path that ends where it started is closed even
      // without an explicit closePath (Illustrator's circles
      // do this).
      const first = cur[0], last = cur[cur.length - 1];
      const endsAtStart = Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01;
      subs.push({ points: cur, closed: closed || endsAtStart, fourCubics: curves === 4 && (closed || endsAtStart) });
      cur = [];
      start = null;
      curves = 0;
      closed = false;
    }
  };
  const push = (p: Pt): void => {
    const last = cur[cur.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.001 || Math.abs(last.y - p.y) > 0.001) cur.push(p);
  };
  let i = 0;
  const num = (): number => (typeof ops[i] === "number" ? (ops[i++] as number) : (i++, 0));
  while (i < ops.length) {
    const op = ops[i++];
    if (op === DRAW.moveTo) {
      flush();
      const p = applyMatrix(ctm, { x: num(), y: num() });
      cur = [p];
      start = p;
    } else if (op === DRAW.lineTo) {
      push(applyMatrix(ctm, { x: num(), y: num() }));
    } else if (op === DRAW.curveTo) {
      const p1 = applyMatrix(ctm, { x: num(), y: num() });
      const p2 = applyMatrix(ctm, { x: num(), y: num() });
      const p3 = applyMatrix(ctm, { x: num(), y: num() });
      const from = cur[cur.length - 1] ?? p3;
      for (const p of cubicPoints(from, p1, p2, p3)) push(p);
      curves++;
    } else if (op === DRAW.quadraticCurveTo) {
      const p1 = applyMatrix(ctm, { x: num(), y: num() });
      const p2 = applyMatrix(ctm, { x: num(), y: num() });
      const from = cur[cur.length - 1] ?? p2;
      for (const p of quadPoints(from, p1, p2)) push(p);
    } else if (op === DRAW.closePath) {
      if (start) push(start);
      closed = true;
    } else {
      // An op code this extractor does not know: stop
      // parsing this path rather than misreading the rest
      // of its coordinate stream.
      break;
    }
  }
  flush();
  return subs;
}

function bboxOf(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

// Four distinct corners, in order, that form a rectangle:
// the diagonals share a midpoint and have equal length.
function rectCorners(pts: Pt[]): Pt[] | null {
  const corners: Pt[] = [];
  for (const p of pts) {
    if (!corners.some((c) => Math.abs(c.x - p.x) < 0.01 && Math.abs(c.y - p.y) < 0.01)) corners.push(p);
  }
  if (corners.length !== 4) return null;
  const [p0, p1, p2, p3] = corners;
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
  const m02 = mid(p0, p2), m13 = mid(p1, p3);
  const tol = Math.max(1, dist(p0, p2) * 0.01);
  if (Math.hypot(m02.x - m13.x, m02.y - m13.y) > tol) return null;
  if (Math.abs(dist(p0, p2) - dist(p1, p3)) > tol) return null;
  return corners;
}

// A closed four-cubic path whose flattened points all lie on
// the ellipse of its bounding box: a circle/ellipse drawn
// the way Illustrator draws one.
function isEllipse(sub: Subpath): boolean {
  if (!sub.fourCubics || sub.points.length < 8) return false;
  const box = bboxOf(sub.points);
  const rx = (box.maxX - box.minX) / 2, ry = (box.maxY - box.minY) / 2;
  if (rx < 0.5 || ry < 0.5) return false;
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  for (const p of sub.points) {
    const v = ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2;
    if (Math.abs(v - 1) > 0.04) return false;
  }
  return true;
}

// ---------------------------------------------------------------- extractor

interface GState {
  ctm: Matrix;
  fill: Paint;
  stroke: Paint;
  fillSpace: string;
  strokeSpace: string;
  lineWidth: number;
  dashSolid: boolean;
  // Text state.
  fontSize: number;
  fontBold: boolean;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  textRise: number;
  textMode: number;
  leading: number;
  textMatrix: Matrix;
  lineMatrix: Matrix;
}

function freshState(): GState {
  return {
    ctm: IDENTITY,
    fill: "#000000",
    stroke: "#000000",
    fillSpace: "DeviceGray",
    strokeSpace: "DeviceGray",
    lineWidth: 1,
    dashSolid: true,
    fontSize: 0,
    fontBold: false,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    textRise: 0,
    textMode: 0,
    leading: 0,
    textMatrix: IDENTITY,
    lineMatrix: IDENTITY,
  };
}

export function extractAiPage(ops: AiOpList, pageHeight: number): AiExtractResult {
  const items: AiRawItem[] = [];
  const images: AiImageRequest[] = [];
  const reasons: string[] = [];
  let unmappable = false;
  const flag = (reason: string): void => {
    if (!unmappable) reasons.push(reason);
    unmappable = true;
  };

  let s = freshState();
  const stack: GState[] = [];

  // PDF user space (y-up) to board page coordinates (y-down
  // from the page top).
  const flip = (p: Pt): Pt => ({ x: p.x, y: pageHeight - p.y });
  const flipBox = (box: { minX: number; minY: number; maxX: number; maxY: number }): { x: number; y: number; w: number; h: number } => ({
    x: box.minX,
    y: pageHeight - box.maxY,
    w: Math.max(1, box.maxX - box.minX),
    h: Math.max(1, box.maxY - box.minY),
  });

  const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // ---- paths ----

  const emitStroke = (sub: Subpath, color: string, width: number): void => {
    if (sub.points.length < 2) return;
    const box = bboxOf(sub.points);
    const r = flipBox(box);
    const pts = sub.points.map((p) => flip(p));
    // Points are absolute in the flipped page frame, like a
    // hand-drawn stroke's points are absolute in world
    // coords: pos is just their bounding-box min. The
    // renderer and hit-testing both read the points raw and
    // never add pos, so relative points would draw at the
    // origin.
    items.push({
      kind: { Stroke: { points: pts, color, width: Math.max(0.5, width), marker: false } },
      pos: { x: r.x, y: r.y },
      size: { w: r.w, h: r.h },
    });
  };

  const emitPath = (sub: Subpath, paintOp: number): void => {
    const doFill = paintOp === PAINT.fill || paintOp === PAINT.eoFill || paintOp === PAINT.fillStroke ||
      paintOp === PAINT.eoFillStroke || paintOp === PAINT.closeFillStroke || paintOp === PAINT.closeEOFillStroke;
    const doStroke = paintOp === PAINT.stroke || paintOp === PAINT.closeStroke || paintOp === PAINT.fillStroke ||
      paintOp === PAINT.eoFillStroke || paintOp === PAINT.closeFillStroke || paintOp === PAINT.closeEOFillStroke;
    if (sub.points.length < 2) return;
    if (doFill && s.fill === "pattern") { flag("pattern fill"); return; }
    if (doStroke && s.stroke === "pattern") { flag("pattern stroke"); return; }
    if (doStroke && !s.dashSolid) { flag("dashed stroke"); return; }
    const fill = doFill && typeof s.fill === "string" ? s.fill : null;
    const stroke = doStroke && typeof s.stroke === "string" ? s.stroke : null;
    if (!fill && !stroke) return;
    const box = bboxOf(sub.points);
    const r = flipBox(box);
    const rotation = matrixRotation(s.ctm);
    const rect = sub.closed ? rectCorners(sub.points) : null;
    const ellipse = sub.closed && isEllipse(sub);
    if (fill && (rect || ellipse)) {
      const kind: Kind = { Shape: { shape: rect ? "rect" : "ellipse", fill } };
      items.push({
        kind,
        pos: { x: r.x, y: r.y },
        size: { w: r.w, h: r.h },
        ...(rotation !== undefined ? { rotation } : {}),
      });
      if (stroke) emitStroke(sub, stroke, s.lineWidth * matrixScale(s.ctm));
      return;
    }
    // A filled arbitrary path has no filled-polygon card on
    // the board: it lands as an outline-only Stroke card in
    // its fill colour (an approximation, said so in the
    // module header). A path that is both filled and stroked
    // lands as two Stroke cards, one per paint.
    if (fill) emitStroke(sub, fill, 2 * matrixScale(s.ctm));
    if (stroke) emitStroke(sub, stroke, s.lineWidth * matrixScale(s.ctm));
  };

  // ---- text ----

  interface Glyph { unicode?: string; width?: number; isSpace?: boolean }

  const glyphText = (glyphs: unknown): { text: string; advance: number } => {
    if (!Array.isArray(glyphs)) return { text: "", advance: 0 };
    let text = "";
    let advance = 0;
    for (const g of glyphs as Glyph[]) {
      if (typeof g !== "object" || g === null) continue;
      text += typeof g.unicode === "string" ? g.unicode : "";
      const w = typeof g.width === "number" ? g.width : 0;
      advance += (w / 1000) * s.fontSize * s.hScale + s.charSpacing;
      if (g.isSpace) advance += s.wordSpacing;
    }
    return { text, advance };
  };

  const emitText = (text: string, advance: number): void => {
    if (s.fontSize <= 0 || !text.trim()) return;
    if (s.textMode === 3) return; // Invisible text: nothing to draw.
    if (s.textMode >= 4) { flag("text in a clipping rendering mode"); return; }
    const color = s.textMode === 1
      ? (typeof s.stroke === "string" ? s.stroke : null)
      : (typeof s.fill === "string" ? s.fill : null);
    if (s.textMode === 1 && s.stroke === "pattern") { flag("pattern stroke text"); return; }
    if (s.textMode !== 1 && s.fill === "pattern") { flag("pattern fill text"); return; }
    if (color === null) return;
    // The text rendering matrix: the text matrix under the
    // current transform, with the font size folded in (the
    // text matrix itself carries no size — setFont is a
    // separate scale). Its first column is the advance
    // direction; its second column's length is the font size
    // on the page.
    const fontMatrix: Matrix = [s.fontSize * s.hScale, 0, 0, s.fontSize, 0, s.textRise];
    const trm = multiplyMatrix(s.ctm, multiplyMatrix(s.textMatrix, fontMatrix));
    const origin = applyMatrix(trm, { x: 0, y: 0 });
    const fontSize = Math.max(1, Math.hypot(trm[2], trm[3]));
    // The advance, in text-space points, carried through the
    // text matrix and CTM (without the font-size scale).
    const tmCtm = multiplyMatrix(s.ctm, s.textMatrix);
    const advVec = { x: tmCtm[0] * advance, y: tmCtm[1] * advance };
    const adv = Math.hypot(advVec.x, advVec.y);
    const advLen = Math.hypot(trm[0], trm[1]) || 1;
    const unit = { x: trm[0] / advLen, y: trm[1] / advLen };
    // The run's box in user space: baseline from the origin
    // along the advance, up by the font size.
    const up = { x: -unit.y * fontSize, y: unit.x * fontSize };
    const end = { x: origin.x + advVec.x, y: origin.y + advVec.y };
    const corners = [
      origin,
      end,
      { x: end.x + up.x, y: end.y + up.y },
      { x: origin.x + up.x, y: origin.y + up.y },
    ];
    const box = bboxOf(corners);
    const r = flipBox(box);
    const rotation = Math.abs(unit.y) > 0.001 ? (Math.atan2(-unit.y, unit.x) * 180) / Math.PI : undefined;
    const width = Math.min(480, Math.max(120, adv + 28));
    const height = estimateTextHeight(text, fontSize, width);
    items.push({
      kind: { Text: { text, bold: s.fontBold, size: fontSize, color } },
      pos: { x: r.x, y: r.y },
      size: { w: width, h: height },
      fontSize,
      ...(rotation !== undefined ? { rotation } : {}),
    });
  };

  const advanceTextMatrix = (advance: number): void => {
    // The text matrix advances by (advance, 0) in text space.
    s.textMatrix = multiplyMatrix(s.textMatrix, [1, 0, 0, 1, advance, 0]);
  };

  const showGlyphs = (glyphs: unknown): { text: string; advance: number } => {
    const got = glyphText(glyphs);
    if (got.text) emitText(got.text, got.advance);
    advanceTextMatrix(got.advance);
    return got;
  };

  // ---- operator walk ----

  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] ?? [];
    const arg0 = args[0];
    switch (fn) {
      case AI_OPS.save: stack.push({ ...s, ctm: [...s.ctm], textMatrix: [...s.textMatrix], lineMatrix: [...s.lineMatrix] }); break;
      case AI_OPS.restore: { const prev = stack.pop(); if (prev) s = prev; break; }
      case AI_OPS.transform: {
        const nums = (args as unknown[]).filter((a): a is number => typeof a === "number");
        if (nums.length === 6) s.ctm = multiplyMatrix(s.ctm, [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]]);
        break;
      }
      case AI_OPS.setLineWidth: { const w = asNumber(arg0); if (w !== null && w > 0) s.lineWidth = w; break; }
      case AI_OPS.setDash: {
        const dash = Array.isArray(arg0) ? arg0 : [];
        s.dashSolid = dash.length === 0;
        break;
      }
      case AI_OPS.setGState: {
        const pairs = Array.isArray(arg0) ? arg0 : [];
        for (const pair of pairs as unknown[][]) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const [key, value] = pair as [string, unknown];
          if ((key === "ca" || key === "CA") && typeof value === "number" && value < 1) flag("transparency (alpha < 1)");
          if (key === "SMask" && value !== null && value !== undefined && value !== false) flag("soft mask");
          if (key === "BM" && value !== "Normal" && value !== undefined) flag("blend mode");
        }
        break;
      }
      case AI_OPS.setFillRGBColor: if (typeof arg0 === "string") { s.fill = arg0; s.fillSpace = "DeviceRGB"; } break;
      case AI_OPS.setStrokeRGBColor: if (typeof arg0 === "string") { s.stroke = arg0; s.strokeSpace = "DeviceRGB"; } break;
      case AI_OPS.setFillGray: { const g = asNumber(arg0); if (g !== null) { s.fill = grayHex(g); s.fillSpace = "DeviceGray"; } break; }
      case AI_OPS.setStrokeGray: { const g = asNumber(arg0); if (g !== null) { s.stroke = grayHex(g); s.strokeSpace = "DeviceGray"; } break; }
      case AI_OPS.setFillCMYKColor: {
        const nums = (args as unknown[]).filter((a): a is number => typeof a === "number");
        if (nums.length === 4) { s.fill = cmykHex(nums[0], nums[1], nums[2], nums[3]); s.fillSpace = "DeviceCMYK"; }
        break;
      }
      case AI_OPS.setStrokeCMYKColor: {
        const nums = (args as unknown[]).filter((a): a is number => typeof a === "number");
        if (nums.length === 4) { s.stroke = cmykHex(nums[0], nums[1], nums[2], nums[3]); s.strokeSpace = "DeviceCMYK"; }
        break;
      }
      case AI_OPS.setFillColorSpace: {
        const name = typeof arg0 === "string" ? arg0 : Array.isArray(arg0) ? "Pattern" : "";
        if (name === "Pattern") s.fill = "pattern";
        else if (name === "DeviceGray" || name === "DeviceRGB" || name === "DeviceCMYK") s.fillSpace = name;
        else if (name !== "") flag("unsupported fill colour space");
        break;
      }
      case AI_OPS.setStrokeColorSpace: {
        const name = typeof arg0 === "string" ? arg0 : Array.isArray(arg0) ? "Pattern" : "";
        if (name === "Pattern") s.stroke = "pattern";
        else if (name === "DeviceGray" || name === "DeviceRGB" || name === "DeviceCMYK") s.strokeSpace = name;
        else if (name !== "") flag("unsupported stroke colour space");
        break;
      }
      case AI_OPS.setFillColor: { const hex = colorArgsToHex(args, s.fillSpace); if (hex) s.fill = hex; break; }
      case AI_OPS.setStrokeColor: { const hex = colorArgsToHex(args, s.strokeSpace); if (hex) s.stroke = hex; break; }
      case AI_OPS.setFillColorN: {
        if (typeof arg0 === "string" && (arg0 === "TilingPattern" || arg0 === "ShadingPattern")) s.fill = "pattern";
        else { const hex = colorArgsToHex(args, s.fillSpace); if (hex) s.fill = hex; }
        break;
      }
      case AI_OPS.setStrokeColorN: {
        if (typeof arg0 === "string" && (arg0 === "TilingPattern" || arg0 === "ShadingPattern")) s.stroke = "pattern";
        else { const hex = colorArgsToHex(args, s.strokeSpace); if (hex) s.stroke = hex; }
        break;
      }
      case AI_OPS.setFillTransparent: s.fill = null; break;
      case AI_OPS.setStrokeTransparent: s.stroke = null; break;
      case AI_OPS.constructPath: {
        const paintOp = asNumber(arg0);
        // pdf.js carries the path as [paintOp, [drawOps],
        // bbox], where drawOps is ONE Float32Array of
        // interleaved DrawOPS codes and coordinates — not a
        // plain array (see the module header). A plain flat
        // array is accepted too, for hand-built lists.
        const rawPath = args[1];
        let drawOps: ArrayLike<number> = [];
        if (Array.isArray(rawPath)) {
          const first = rawPath[0];
          if (Array.isArray(first) || ArrayBuffer.isView(first)) drawOps = first as unknown as ArrayLike<number>;
          else drawOps = rawPath as number[];
        } else if (ArrayBuffer.isView(rawPath)) {
          drawOps = rawPath as unknown as ArrayLike<number>;
        }
        if (paintOp === null) { flag("path with no paint operator"); break; }
        if (paintOp === PAINT.endPath) break;
        for (const sub of parseDrawOps(drawOps, s.ctm)) emitPath(sub, paintOp);
        break;
      }
      case AI_OPS.shadingFill: flag("gradient / shading"); break;
      case AI_OPS.clip: case AI_OPS.eoClip: flag("clipping path"); break;
      case AI_OPS.paintImageXObject: {
        const objId = typeof arg0 === "string" ? arg0 : null;
        if (!objId) { flag("image with no object id"); break; }
        // An image paints the unit square under the CTM.
        const corners = [
          applyMatrix(s.ctm, { x: 0, y: 0 }),
          applyMatrix(s.ctm, { x: 1, y: 0 }),
          applyMatrix(s.ctm, { x: 0, y: 1 }),
          applyMatrix(s.ctm, { x: 1, y: 1 }),
        ];
        const r = flipBox(bboxOf(corners));
        const rotation = matrixRotation(s.ctm);
        images.push({ objId, pos: { x: r.x, y: r.y }, size: { w: r.w, h: r.h }, ...(rotation !== undefined ? { rotation } : {}) });
        break;
      }
      case AI_OPS.paintImageMaskXObject: case AI_OPS.paintImageMaskXObjectGroup:
      case AI_OPS.paintInlineImageXObject: case AI_OPS.paintInlineImageXObjectGroup:
      case AI_OPS.paintImageXObjectRepeat: case AI_OPS.paintImageMaskXObjectRepeat:
      case AI_OPS.paintSolidColorImageMask: case AI_OPS.paintXObject:
      case AI_OPS.beginInlineImage: case AI_OPS.beginImageData: case AI_OPS.endInlineImage:
      case AI_OPS.rawFillPath:
        flag(`unsupported operator ${fn}`);
        break;
      case AI_OPS.setFont: {
        const size = asNumber(args[1]);
        if (size !== null && size > 0) s.fontSize = size;
        s.fontBold = typeof arg0 === "string" && arg0.toLowerCase().includes("bold");
        break;
      }
      case AI_OPS.setTextMatrix: {
        const nums = (args as unknown[]).filter((a): a is number => typeof a === "number");
        if (nums.length === 6) { s.textMatrix = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]]; s.lineMatrix = [...s.textMatrix]; }
        break;
      }
      case AI_OPS.moveText: {
        const tx = asNumber(args[0]) ?? 0, ty = asNumber(args[1]) ?? 0;
        s.textMatrix = multiplyMatrix(s.lineMatrix, [1, 0, 0, 1, tx, ty]);
        s.lineMatrix = [...s.textMatrix];
        break;
      }
      case AI_OPS.setLeadingMoveText: {
        const tx = asNumber(args[0]) ?? 0, ty = asNumber(args[1]) ?? 0;
        s.leading = -ty;
        s.textMatrix = multiplyMatrix(s.lineMatrix, [1, 0, 0, 1, tx, ty]);
        s.lineMatrix = [...s.textMatrix];
        break;
      }
      case AI_OPS.setLeading: { const l = asNumber(arg0); if (l !== null) s.leading = l; break; }
      case AI_OPS.nextLine: {
        s.textMatrix = multiplyMatrix(s.lineMatrix, [1, 0, 0, 1, 0, -s.leading]);
        s.lineMatrix = [...s.textMatrix];
        break;
      }
      case AI_OPS.setCharSpacing: { const v = asNumber(arg0); if (v !== null) s.charSpacing = v; break; }
      case AI_OPS.setWordSpacing: { const v = asNumber(arg0); if (v !== null) s.wordSpacing = v; break; }
      case AI_OPS.setHScale: { const v = asNumber(arg0); if (v !== null && v > 0) s.hScale = v / 100; break; }
      case AI_OPS.setTextRise: { const v = asNumber(arg0); if (v !== null) s.textRise = v; break; }
      case AI_OPS.setTextRenderingMode: { const v = asNumber(arg0); if (v !== null) s.textMode = v; break; }
      case AI_OPS.showText: showGlyphs(arg0); break;
      case AI_OPS.showSpacedText: {
        if (!Array.isArray(arg0)) break;
        let text = "";
        let advance = 0;
        for (const el of arg0 as unknown[]) {
          if (Array.isArray(el)) {
            const got = glyphText(el);
            text += got.text;
            advance += got.advance;
          } else if (typeof el === "number") {
            advance -= (el / 1000) * s.fontSize * s.hScale;
          }
        }
        if (text) emitText(text, advance);
        advanceTextMatrix(advance);
        break;
      }
      case AI_OPS.nextLineShowText: {
        s.textMatrix = multiplyMatrix(s.lineMatrix, [1, 0, 0, 1, 0, -s.leading]);
        s.lineMatrix = [...s.textMatrix];
        showGlyphs(arg0);
        break;
      }
      case AI_OPS.nextLineSetSpacingShowText: {
        const aw = asNumber(args[0]) ?? 0, ac = asNumber(args[1]) ?? 0;
        s.wordSpacing = aw; s.charSpacing = ac;
        s.textMatrix = multiplyMatrix(s.lineMatrix, [1, 0, 0, 1, 0, -s.leading]);
        s.lineMatrix = [...s.textMatrix];
        showGlyphs(args[2]);
        break;
      }
      // No-ops: dependency declarations, marked content,
      // groups (contents extract normally; blend modes and
      // knockout inside them are not reproduced), Form
      // XObject begin/end markers (the form's contents are
      // inlined after a transform op, which the CTM tracking
      // already applies), text begin/end markers, and
      // caps/joins/miter, which the board's strokes do not
      // carry.
      case AI_OPS.dependency: case AI_OPS.beginText: case AI_OPS.endText:
      case AI_OPS.beginGroup: case AI_OPS.endGroup:
      case AI_OPS.paintFormXObjectBegin: case AI_OPS.paintFormXObjectEnd:
      case AI_OPS.setLineCap: case AI_OPS.setLineJoin: case AI_OPS.setMiterLimit:
      case AI_OPS.setRenderingIntent: case AI_OPS.setFlatness:
      case AI_OPS.markPoint: case AI_OPS.markPointProps:
      case AI_OPS.beginMarkedContent: case AI_OPS.beginMarkedContentProps:
      case AI_OPS.endMarkedContent: case AI_OPS.beginCompat: case AI_OPS.endCompat:
      case AI_OPS.beginAnnotation: case AI_OPS.endAnnotation:
      case AI_OPS.setCharWidth: case AI_OPS.setCharWidthAndBounds:
        break;
      default:
        flag(`unsupported operator ${fn}`);
        break;
    }
    if (unmappable) break;
  }

  return { items, images, unmappable, reasons };
}
