// Unit tests for the board model (src/backend/model.ts): the pure core
// every tool, drag and plugin builds on. No DOM, no Electron,
// so these run in plain vitest on every push and PR.
import { describe, expect, it } from "vitest";
import {
  anchorPoint,
  applyColourDataPatch,
  arrangeItems,
  checklistProgress,
  clampZoom,
  clippedEnds,
  colourDataPatch,
  domainOf,
  escapeHtml,
  estimateTextHeight,
  fitCamera,
  healDuplicateIds,
  hitTest,
  isInlineVideo,
  itemBounds,
  posterNameFor,
  posterTime,
  itemRotation,
  lassoSelect,
  marquee,
  moveSelection,
  linearGradientCoords,
  normaliseGradient,
  normaliseHex,
  parseHex,
  parseInline,
  parseMarkdown,
  pointInPolygon,
  pressureWidth,
  proportionalResize,
  rectCrossing,
  renderMarkdownHtml,
  screenToWorld,
  resizeItem,
  worldToScreen,
  zoomCamera,
  rotatePoint,
  segmentIntersectsRect,
  select,
  setChecklistDone,
  smoothStrokePath,
  smoothStrokePressures,
  smoothStrokeSamples,
  splitStrokeByEraser,
  strokeMaxWidth,
  strokeOpacity,
  strokePressuresVary,
  strokesWithin,
  toggleTaskLine,
  type Board,
  type Item,
  type ShapeKind,
} from "../../src/backend/model";

function textCard(id: number, x: number, y: number, w = 260, h = 48, text = "Note"): Item {
  return {
    id, pos: { x, y }, size: { w, h }, group: null,
    kind: { Text: { text, bold: false, size: 16, color: "#1A1A1A" } },
  };
}

function stroke(id: number, points: Array<{ x: number; y: number }>, pressures?: number[]): Item {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  return {
    id,
    pos: { x: Math.min(...xs), y: Math.min(...ys) },
    size: { w: Math.max(1, Math.max(...xs) - Math.min(...xs)), h: Math.max(1, Math.max(...ys) - Math.min(...ys)) },
    group: null,
    kind: { Stroke: { points, color: "#1A1A1A", width: 3, marker: false, ...(pressures ? { pressures } : {}) } },
  };
}

function shape(id: number, kind: ShapeKind, x: number, y: number, w = 200, h = 100, rotation?: number, outline?: boolean): Item {
  return {
    id, pos: { x, y }, size: { w, h }, group: null,
    kind: { Shape: { shape: kind, fill: "#1A1A1A", ...(outline ? { outline: true } : {}) } },
    ...(rotation !== undefined ? { rotation } : {}),
  };
}

function strokeKind(item: Item) {
  if (!("Stroke" in item.kind)) throw new Error("expected a stroke item");
  return item.kind.Stroke;
}

function board(items: Item[]): Board {
  return { items, camera: { x: 0, y: 0, zoom: 1 }, next_id: 100, next_group: 0, bg: "#FFFFFF", grid: "Dots" };
}

describe("stylus pressure", () => {
  it("a light touch draws thin, a hard press draws thick, capped at 8", () => {
    // A mouse (pressure 0.5) draws at the base width.
    expect(pressureWidth(3, 0.5)).toBe(3);
    expect(pressureWidth(3, 0.1)).toBe(1);
    expect(pressureWidth(3, 1)).toBe(6);
    expect(pressureWidth(3, 2)).toBe(8);
    expect(pressureWidth(3, 0)).toBe(1);
  });
  it("strokeMaxWidth is the base width without pressures, the widest pressure with them", () => {
    expect(strokeMaxWidth({ width: 3 })).toBe(3);
    expect(strokeMaxWidth({ width: 3, pressures: [] })).toBe(3);
    expect(strokeMaxWidth({ width: 3, pressures: [0.1, 0.5, 1] })).toBe(6);
  });
  it("strokeOpacity is 1 without an opacity, and multiplies with the marker's 0.45", () => {
    expect(strokeOpacity({ marker: false })).toBe(1);
    expect(strokeOpacity({ marker: true })).toBe(0.45);
    expect(strokeOpacity({ opacity: 50, marker: false })).toBe(0.5);
    expect(strokeOpacity({ opacity: 50, marker: true })).toBe(0.225);
    expect(strokeOpacity({ opacity: 100, marker: false })).toBe(1);
    expect(strokeOpacity({ opacity: 30, marker: true })).toBe(0.135);
    expect(strokeOpacity({ opacity: 0, marker: false })).toBe(0);
  });
  it("strokePressuresVary needs a real spread, not jitter", () => {
    expect(strokePressuresVary({})).toBe(false);
    expect(strokePressuresVary({ pressures: [0.5] })).toBe(false);
    expect(strokePressuresVary({ pressures: [0.5, 0.5, 0.51] })).toBe(false);
    expect(strokePressuresVary({ pressures: [0.1, 0.5, 1] })).toBe(true);
  });
});

describe("stroke smoothing", () => {
  const zigzag = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }];
  it("smoothStrokePath is empty below two points and a line for two", () => {
    expect(smoothStrokePath([])).toBe("");
    expect(smoothStrokePath([{ x: 0, y: 0 }])).toBe("");
    expect(smoothStrokePath([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe("M0,0 L10,10");
  });
  it("smoothStrokePath draws curves through every point, not a polyline", () => {
    const d = smoothStrokePath(zigzag);
    expect(d.startsWith("M0,0")).toBe(true);
    expect(d).toContain(" C");
    expect(d).not.toContain(" L");
    expect(d.endsWith("200,100")).toBe(true);
    expect(d.split(" C").length).toBe(4);
  });
  it("smoothStrokePath is a straight line for collinear points", () => {
    const d = smoothStrokePath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]);
    // A Catmull-Rom spline through collinear points is the
    // line itself: every y in the path is 0.
    const nums = d.replace(/[MLC]/g, " ").split(/[\s,]+/).filter(Boolean).map(Number);
    for (let i = 1; i < nums.length; i += 2) expect(nums[i]).toBe(0);
    expect(d).toContain("100,0");
  });
  it("smoothStrokeSamples densifies each segment and keeps the endpoints", () => {
    const pts = smoothStrokeSamples(zigzag);
    expect(pts.length).toBe(3 * 4 + 1);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 200, y: 100 });
    // Every raw point is one of the samples.
    for (const p of zigzag) expect(pts).toContainEqual(p);
    // Samples on a straight run stay on the line, just denser.
    const straight = smoothStrokeSamples([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(straight.length).toBe(5);
    expect(straight[0]).toEqual({ x: 0, y: 0 });
    expect(straight[4]).toEqual({ x: 100, y: 0 });
    for (const p of straight) expect(p.y).toBe(0);
  });
  it("smoothStrokePressures matches the samples and lerps between endpoints", () => {
    const prs = smoothStrokePressures([0.2, 0.8, 0.4], 2);
    expect(prs.length).toBe(2 * 2 + 1);
    expect(prs[0]).toBe(0.2);
    expect(prs[2]).toBe(0.8);
    expect(prs[4]).toBe(0.4);
    expect(prs[1]).toBeCloseTo(0.5, 9);
    expect(prs[3]).toBeCloseTo(0.6, 9);
  });
});

describe("isInlineVideo", () => {
  it("plays local mp4, webm and m4v inline", () => {
    expect(isInlineVideo("/b/clip.mp4", false)).toBe(true);
    expect(isInlineVideo("/b/clip.WEBM", false)).toBe(true);
    expect(isInlineVideo("/b/clip.m4v", false)).toBe(true);
  });
  it("rejects remote links and unplayable formats, but a query string on a local clip still plays", () => {
    expect(isInlineVideo("https://example.com/clip.mp4", true)).toBe(false);
    expect(isInlineVideo("/b/clip.mov", false)).toBe(false);
    expect(isInlineVideo("/b/clip.mkv", false)).toBe(false);
    expect(isInlineVideo("/b/clip.mp4?x=1", false)).toBe(true);
  });
});

describe("video poster helpers", () => {
  it("posterTime is one second in, or a quarter in for short clips", () => {
    expect(posterTime(10)).toBe(1);
    expect(posterTime(2)).toBe(0.5);
    expect(posterTime(0)).toBe(0);
    expect(posterTime(NaN)).toBe(0);
  });
  it("posterNameFor keeps the video's name with a -poster.jpg suffix", () => {
    expect(posterNameFor("/b/welcome-video.mp4")).toBe("welcome-video-poster.jpg");
    expect(posterNameFor("/b/clip.webm?x=1")).toBe("clip-poster.jpg");
    expect(posterNameFor("/b/noext")).toBe("noext-poster.jpg");
  });
});

describe("hitTest", () => {
  it("hits a card inside its rect and misses outside it", () => {
    const b = board([textCard(1, 100, 100)]);
    expect(hitTest(b, { x: 150, y: 120 })).toBe(1);
    expect(hitTest(b, { x: 50, y: 50 })).toBeNull();
  });
  it("the topmost card wins an overlap", () => {
    const b = board([textCard(1, 100, 100), textCard(2, 150, 100)]);
    expect(hitTest(b, { x: 200, y: 120 })).toBe(2);
  });
  it("hits a stroke within tolerance and misses far from it", () => {
    const b = board([stroke(1, [{ x: 100, y: 100 }, { x: 200, y: 100 }])]);
    expect(hitTest(b, { x: 150, y: 104 })).toBe(1);
    expect(hitTest(b, { x: 150, y: 200 })).toBeNull();
  });
  it("hits a rotated stroke where it actually is, not where it was", () => {
    const s = stroke(1, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    s.rotation = 90;
    const b = board([s]);
    // Rotated 90 degrees around its centre, the stroke runs
    // vertically through x=50: (50, 50) is on it, (0, 0) is not.
    expect(hitTest(b, { x: 50, y: 50 })).toBe(1);
    expect(hitTest(b, { x: 0, y: 0 })).toBeNull();
  });
  it("a connector never steals a click from the card it joins", () => {
    const b = board([
      textCard(1, 100, 100),
      textCard(2, 400, 100),
      { id: 3, pos: { x: 100, y: 100 }, size: { w: 300, h: 48 }, group: null, kind: { Connector: { from: { Item: 1 }, to: { Item: 2 }, color: "#333333" } } },
    ]);
    expect(hitTest(b, { x: 150, y: 120 })).toBe(1);
  });
  it("a shape is hit on its geometry, not its box", () => {
    // Triangle (100,100) 200x100: the top corners are empty.
    const tri = board([shape(1, "triangle", 100, 100)]);
    expect(hitTest(tri, { x: 200, y: 130 })).toBe(1);
    expect(hitTest(tri, { x: 110, y: 110 })).toBeNull();
    // Arrow (100,100) 200x100: the shaft and head hit, the
    // top-left corner above the shaft does not.
    const arr = board([shape(1, "arrow", 100, 100)]);
    expect(hitTest(arr, { x: 150, y: 150 })).toBe(1);
    expect(hitTest(arr, { x: 280, y: 150 })).toBe(1);
    expect(hitTest(arr, { x: 150, y: 110 })).toBeNull();
    expect(hitTest(arr, { x: 280, y: 110 })).toBeNull();
    // Ellipse (100,100) 200x100: the centre and the top
    // middle hit, the corners do not.
    const ell = board([shape(1, "ellipse", 100, 100)]);
    expect(hitTest(ell, { x: 200, y: 150 })).toBe(1);
    expect(hitTest(ell, { x: 200, y: 105 })).toBe(1);
    expect(hitTest(ell, { x: 110, y: 110 })).toBeNull();
    // Star (100,100) 200x100: the centre hits, the top-left
    // corner above the star's left point does not.
    const star = board([shape(1, "star", 100, 100)]);
    expect(hitTest(star, { x: 200, y: 150 })).toBe(1);
    expect(hitTest(star, { x: 110, y: 110 })).toBeNull();
    // Rect fills its box, so a corner still hits.
    const rect = board([shape(1, "rect", 100, 100)]);
    expect(hitTest(rect, { x: 110, y: 110 })).toBe(1);
  });
  it("a shape's empty corner does not steal a click from the card beneath it", () => {
    const b = board([textCard(1, 100, 100), shape(2, "triangle", 100, 100)]);
    expect(hitTest(b, { x: 110, y: 110 })).toBe(1);
    expect(hitTest(b, { x: 200, y: 130 })).toBe(2);
  });
  it("a rotated shape is hit where it actually is", () => {
    // Triangle rotated 180 degrees: the apex is at the
    // bottom, so the bottom corners are empty and the
    // middle still hits.
    const b = board([shape(1, "triangle", 100, 100, 200, 100, 180)]);
    expect(hitTest(b, { x: 200, y: 170 })).toBe(1);
    expect(hitTest(b, { x: 110, y: 190 })).toBeNull();
  });
  it("an outline shape is hit only on its edge, never its empty interior", () => {
    // An outline shape is a stroked edge: the interior is
    // empty, so a point inside it must not select it, but
    // a point on the edge must. All shapes at (100,100),
    // 200x100; the edge points sit 2px inside the edge,
    // well within the 8px hit tolerance.
    const rect = board([shape(1, "rect", 100, 100, 200, 100, undefined, true)]);
    expect(hitTest(rect, { x: 200, y: 150 })).toBeNull();
    expect(hitTest(rect, { x: 200, y: 102 })).toBe(1);
    const ell = board([shape(1, "ellipse", 100, 100, 200, 100, undefined, true)]);
    expect(hitTest(ell, { x: 200, y: 150 })).toBeNull();
    expect(hitTest(ell, { x: 200, y: 102 })).toBe(1);
    const tri = board([shape(1, "triangle", 100, 100, 200, 100, undefined, true)]);
    expect(hitTest(tri, { x: 200, y: 150 })).toBeNull();
    expect(hitTest(tri, { x: 200, y: 198 })).toBe(1);
    const dia = board([shape(1, "diamond", 100, 100, 200, 100, undefined, true)]);
    expect(hitTest(dia, { x: 200, y: 150 })).toBeNull();
    expect(hitTest(dia, { x: 200, y: 102 })).toBe(1);
    const hex = board([shape(1, "hexagon", 100, 100, 200, 100, undefined, true)]);
    expect(hitTest(hex, { x: 200, y: 150 })).toBeNull();
    expect(hitTest(hex, { x: 200, y: 102 })).toBe(1);
    const star = board([shape(1, "star", 100, 100, 200, 100, undefined, true)]);
    expect(hitTest(star, { x: 200, y: 150 })).toBeNull();
    expect(hitTest(star, { x: 150, y: 120 })).toBeNull();
    expect(hitTest(star, { x: 200, y: 102 })).toBe(1);
    const arr = board([shape(1, "arrow", 100, 100, 200, 100, undefined, true)]);
    expect(hitTest(arr, { x: 200, y: 150 })).toBeNull();
    expect(hitTest(arr, { x: 160, y: 140 })).toBe(1);
  });
});

describe("marquee and lasso", () => {
  it("marquee selects what its rect touches, in either drag direction", () => {
    const b = board([textCard(1, 100, 100), textCard(2, 400, 100), textCard(3, 100, 400)]);
    expect(marquee(b, { x: 90, y: 90 }, { x: 300, y: 200 })).toEqual([1]);
    expect(marquee(b, { x: 300, y: 200 }, { x: 90, y: 90 })).toEqual([1]);
    expect(marquee(b, { x: 0, y: 0 }, { x: 700, y: 500 })).toEqual([1, 2, 3]);
  });
  it("lassoSelect needs at least 3 points and selects what the loop touches", () => {
    // The loop test itself: a point inside the loop is in,
    // one outside is out.
    const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
    const b = board([textCard(1, 100, 100), textCard(2, 400, 100)]);
    expect(lassoSelect(b, [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual([]);
    const loop = [{ x: 90, y: 90 }, { x: 370, y: 90 }, { x: 370, y: 160 }, { x: 90, y: 160 }];
    expect(lassoSelect(b, loop)).toEqual([1]);
  });
  it("strokesWithin finds strokes near a point, in eraser radius", () => {
    const b = board([
      stroke(1, [{ x: 100, y: 100 }, { x: 200, y: 100 }]),
      stroke(2, [{ x: 100, y: 300 }, { x: 200, y: 300 }]),
    ]);
    expect(strokesWithin(b, { x: 150, y: 105 }, 12)).toEqual([1]);
    expect(strokesWithin(b, { x: 150, y: 105 }, 1)).toEqual([]);
    expect(strokesWithin(b, { x: 150, y: 200 }, 12)).toEqual([]);
  });
  it("splitStrokeByEraser breaks a stroke at the eraser, keeping both sides", () => {
    const pts = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200].map((x) => ({ x, y: 100 }));
    const runs = splitStrokeByEraser(pts, undefined, { x: 150, y: 100 }, 12, 1.5);
    expect(runs.map((r) => r.points.map((p) => p.x))).toEqual([
      [100, 110, 120, 130],
      [170, 180, 190, 200],
    ]);
  });
  it("splitStrokeByEraser leaves nothing when the whole stroke is under the eraser", () => {
    const pts = [{ x: 100, y: 100 }, { x: 150, y: 100 }, { x: 200, y: 100 }];
    expect(splitStrokeByEraser(pts, undefined, { x: 150, y: 100 }, 100, 1.5)).toEqual([]);
  });
  it("splitStrokeByEraser trims a stroke when the eraser takes one end", () => {
    const pts = [100, 110, 120, 130, 140, 150].map((x) => ({ x, y: 100 }));
    const runs = splitStrokeByEraser(pts, undefined, { x: 100, y: 100 }, 12, 1.5);
    expect(runs.map((r) => r.points.map((p) => p.x))).toEqual([[120, 130, 140, 150]]);
  });
  it("splitStrokeByEraser keeps pressures aligned with their points", () => {
    const pts = [100, 110, 120, 130, 140, 150, 160, 170].map((x) => ({ x, y: 100 }));
    const prs = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const runs = splitStrokeByEraser(pts, prs, { x: 135, y: 100 }, 14, 1.5);
    expect(runs.map((r) => r.points.map((p) => p.x))).toEqual([[100, 110], [160, 170]]);
    expect(runs.map((r) => r.pressures)).toEqual([[0.3, 0.4], [0.9, 1.0]]);
  });
  it("splitStrokeByEraser cuts a run when a segment crosses the circle, ends outside it", () => {
    // The segment test underneath: a segment crossing the
    // rect counts, one stopping short does not.
    expect(segmentIntersectsRect({ x: 0, y: 50 }, { x: 200, y: 50 }, { x: 100, y: 0, w: 50, h: 100 })).toBe(true);
    expect(segmentIntersectsRect({ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 100, y: 0, w: 50, h: 100 })).toBe(false);
    // A fast stroke: sparse points, the segment between
    // them passes through the eraser while both ends are
    // clear of it. Without the segment test the stroke
    // would survive the sweep whole.
    const pts = [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 160, y: 100 }, { x: 200, y: 100 }];
    const runs = splitStrokeByEraser(pts, undefined, { x: 150, y: 100 }, 5, 1.5);
    expect(runs.map((r) => r.points.map((p) => p.x))).toEqual([
      [100, 140],
      [160, 200],
    ]);
  });
});

describe("arrangeItems", () => {
  it("row lines cards up from the leftmost, vertically centred", () => {
    const b = board([textCard(1, 100, 100), textCard(2, 500, 300, 100, 48)]);
    // Nothing to arrange — no ids, or ids that match
    // nothing — returns nothing.
    expect(arrangeItems(b, [], { type: "row" })).toEqual([]);
    expect(arrangeItems(b, [99], { type: "row" })).toEqual([]);
    const out = arrangeItems(b, [1, 2], { type: "row", gap: 10 });
    expect(out).toEqual([
      { id: 1, pos: { x: 100, y: 100 } },
      { id: 2, pos: { x: 370, y: 100 } },
    ]);
  });
  it("column stacks cards from the topmost, horizontally centred", () => {
    const b = board([textCard(1, 100, 100), textCard(2, 500, 300, 100, 48)]);
    const out = arrangeItems(b, [1, 2], { type: "column", gap: 10 });
    expect(out).toEqual([
      { id: 1, pos: { x: 100, y: 100 } },
      { id: 2, pos: { x: 180, y: 158 } },
    ]);
  });
  it("grid fills row by row in the largest cell size", () => {
    const b = board([textCard(1, 0, 0, 100, 50), textCard(2, 0, 0, 100, 50), textCard(3, 0, 0, 100, 50)]);
    const out = arrangeItems(b, [1, 2, 3], { type: "grid", columns: 2, gap: 10 });
    expect(out[0].pos).toEqual({ x: 0, y: 0 });
    expect(out[1].pos).toEqual({ x: 110, y: 0 });
    expect(out[2].pos).toEqual({ x: 0, y: 60 });
  });
  it("radial puts satellites around the centre card", () => {
    const b = board([textCard(1, 100, 100, 100, 50), textCard(2, 0, 0, 100, 50), textCard(3, 0, 0, 100, 50)]);
    const out = arrangeItems(b, [2, 3], { type: "radial", center: 1, radius: 200 });
    expect(out).toHaveLength(2);
    // First satellite starts at the top, second opposite it.
    expect(out[0].pos.y).toBeLessThan(100);
    expect(out[1].pos.y).toBeGreaterThan(100);
  });
});

describe("selection and mutation", () => {
  it("select picks one card, additive keeps the rest, a group selects together", () => {
    const b = board([textCard(1, 100, 100), textCard(2, 400, 100)]);
    expect(select(b, [], 1, false)).toEqual([1]);
    expect(select(b, [1], 2, true)).toEqual([1, 2]);
    expect(select(b, [1], 2, false)).toEqual([2]);
    const g1 = textCard(3, 100, 300); g1.group = 1;
    const g2 = textCard(4, 400, 300); g2.group = 1;
    const bg = board([g1, g2]);
    expect(select(bg, [], 3, false)).toEqual([3, 4]);
  });
  it("moveSelection moves cards and stroke points together", () => {
    const b = board([textCard(1, 100, 100), stroke(2, [{ x: 200, y: 200 }, { x: 300, y: 200 }])]);
    moveSelection(b, [1, 2], 10, -5);
    expect(b.items[0].pos).toEqual({ x: 110, y: 95 });
    expect(strokeKind(b.items[1]).points).toEqual([{ x: 210, y: 195 }, { x: 310, y: 195 }]);
  });
  it("resizeItem clamps to 48 and scales stroke points", () => {
    const b = board([stroke(1, [{ x: 100, y: 100 }, { x: 200, y: 200 }])]);
    resizeItem(b, 1, 10, 10);
    expect(b.items[0].size).toEqual({ w: 48, h: 48 });
    resizeItem(b, 1, 200, 100);
    expect(strokeKind(b.items[0]).points[1]).toEqual({ x: 300, y: 200 });
  });
  it("proportionalResize keeps the ratio whichever axis drives", () => {
    // A diagonal drag: the wider relative move wins, and
    // both sides scale by that one factor.
    expect(proportionalResize(360, 203, 180, 10)).toEqual({ w: 540, h: 304.5 });
    // A mostly-vertical drag: the height move drives, and
    // the width follows it.
    expect(proportionalResize(360, 203, 5, 203)).toEqual({ w: 720, h: 406 });
    // Shrinking stops at the 48px floor without breaking
    // the ratio: the floor is on the scale, not the sides.
    const small = proportionalResize(360, 203, -350, -200);
    expect(small.w).toBeCloseTo(85.1, 1);
    expect(small.h).toBeCloseTo(48, 1);
    expect(small.w / small.h).toBeCloseTo(360 / 203, 5);
  });
});

describe("healDuplicateIds", () => {
  it("leaves a board with unique ids alone", () => {
    const b = board([textCard(1, 0, 0), textCard(2, 300, 0)]);
    healDuplicateIds(b);
    expect(b.items.map((it) => it.id)).toEqual([1, 2]);
    expect(b.next_id).toBe(100);
    // An empty board is a no-op too.
    const empty = board([]);
    healDuplicateIds(empty);
    expect(empty.items).toEqual([]);
    expect(empty.next_id).toBe(100);
  });

  it("first card keeps the id, later duplicates get fresh ids", () => {
    const b = board([textCard(1, 0, 0), textCard(2, 300, 0), textCard(2, 600, 0), textCard(1, 900, 0)]);
    healDuplicateIds(b);
    expect(b.items[0].id).toBe(1);
    expect(b.items[1].id).toBe(2);
    expect(b.items[2].id).toBe(101);
    expect(b.items[3].id).toBe(102);
    expect(new Set(b.items.map((it) => it.id)).size).toBe(4);
  });

  it("bumps a stale next_id before allocating, so the fresh id cannot collide", () => {
    const b = board([textCard(5, 0, 0), textCard(5, 300, 0)]);
    b.next_id = 4;
    healDuplicateIds(b);
    expect(b.items.map((it) => it.id)).toEqual([5, 6]);
    expect(b.next_id).toBe(6);
  });

});

describe("text cards: markdown, checklists, height", () => {
  it("parseMarkdown splits headings, bullets, code and paragraphs", () => {
    const blocks = parseMarkdown("# Title\n\n- one\n\n```js\nconst x = 1;\n```\n\nPlain");
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ Heading: { level: 1, segments: [{ text: "Title" }] } });
    expect(blocks[1]).toEqual({ Bullet: { segments: [{ text: "one" }] } });
    expect(blocks[2]).toEqual({ Code: { lines: ["const x = 1;"] } });
    expect(blocks[3]).toEqual({ Paragraph: { segments: [{ text: "Plain" }] } });
  });
  it("renderMarkdownHtml highlights code and renders checklists as checkboxes", () => {
    const html = renderMarkdownHtml("```js\nconst x = 1; // hi\n```\n\n- [ ] Buy milk\n- [x] Done", 16);
    expect(html).toContain("<pre>");
    expect(html).toContain('class="tok-kw">const</span>');
    expect(html).toContain('class="tok-num">1</span>');
    expect(html).toContain('data-action="toggle-task"');
    expect(html).toContain("Buy milk");
  });
  it("renderMarkdownHtml escapes HTML instead of rendering it", () => {
    expect(renderMarkdownHtml("<script>alert(1)</script>", 16)).toContain("&lt;script&gt;");
    expect(renderMarkdownHtml("<script>alert(1)</script>", 16)).not.toContain("<script>");
    // The escaping itself covers all four characters.
    expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
  it("toggleTaskLine flips a task and leaves other lines alone", () => {
    expect(toggleTaskLine("- [ ] Buy milk")).toBe("- [x] Buy milk");
    expect(toggleTaskLine("- [x] Buy milk")).toBe("- [ ] Buy milk");
    expect(toggleTaskLine("- [X] Buy milk")).toBe("- [ ] Buy milk");
    expect(toggleTaskLine("Just a line")).toBeNull();
  });
  it("checklistProgress counts done over total, null without tasks", () => {
    expect(checklistProgress("Buy milk\n- [ ] first\n- [x] second")).toEqual({ done: 1, total: 2 });
    expect(checklistProgress("- [X] Done\n* [ ] Todo")).toEqual({ done: 1, total: 2 });
    expect(checklistProgress("No tasks here")).toBeNull();
    expect(checklistProgress("")).toBeNull();
  });
  it("setChecklistDone checks the first n tasks and clamps", () => {
    const text = "- [ ] first\n- [ ] second\n- [x] third";
    expect(setChecklistDone(text, 2)).toBe("- [x] first\n- [x] second\n- [ ] third");
    expect(setChecklistDone(text, 0)).toBe("- [ ] first\n- [ ] second\n- [ ] third");
    expect(setChecklistDone(text, 99)).toBe("- [x] first\n- [x] second\n- [x] third");
    expect(setChecklistDone(text, -1)).toBe("- [ ] first\n- [ ] second\n- [ ] third");
    expect(setChecklistDone("No tasks here", 1)).toBeNull();
  });
  it("estimateTextHeight counts blank lines and matches the note-body line-height", () => {
    // Never below 48, and grows with the text.
    expect(estimateTextHeight("", 16, 260)).toBe(48);
    const short = estimateTextHeight("Hi", 16, 260);
    const long = estimateTextHeight("word ".repeat(200), 16, 260);
    expect(short).toBeGreaterThanOrEqual(48);
    expect(long).toBeGreaterThan(short);
    // A trailing newline is a blank line: it grows the note,
    // or pressing Enter never grows it.
    expect(estimateTextHeight("Hi\n", 16, 260)).toBeGreaterThan(estimateTextHeight("Hi", 16, 260));
    // One line costs one line-height (16 * 1.55, the note
    // body's line-height) plus the paragraph's 6px bottom
    // margin — no more, or the empty space at a note's
    // bottom grows with every line typed.
    const two = estimateTextHeight("a\nb", 16, 260);
    const three = estimateTextHeight("a\nb\nc", 16, 260);
    expect(three - two).toBeCloseTo(16 * 1.55 + 6, 5);
  });
});

describe("fitCamera", () => {
  it("returns null for an empty board", () => {
    expect(fitCamera(board([]), { w: 1280, h: 802 })).toBeNull();
  });
  it("centres a small board at zoom 1, never zooming in", () => {
    // One 260x48 card at (100, 100): centre (230, 124).
    const cam = fitCamera(board([textCard(1, 100, 100)]), { w: 1280, h: 802 });
    expect(cam).not.toBeNull();
    expect(cam!.zoom).toBe(1);
    expect(cam!.x).toBe(230 - 1280 / 2);
    expect(cam!.y).toBe(124 - 802 / 2);
  });
  it("zooms out to fit a board wider than the viewport", () => {
    // Cards spanning x 0..2000, y 0..48: the width binds.
    const b = board([textCard(1, 0, 0), textCard(2, 1740, 0)]);
    const cam = fitCamera(b, { w: 1280, h: 802 });
    expect(cam).not.toBeNull();
    expect(cam!.zoom).toBeCloseTo((1280 - 96) / 2000, 6);
    // The content centre (1000, 24) lands on the viewport centre.
    expect(cam!.x + 640 / cam!.zoom).toBeCloseTo(1000, 6);
    expect(cam!.y + 401 / cam!.zoom).toBeCloseTo(24, 6);
  });
  it("zooms out to fit a board taller than the viewport", () => {
    const b = board([textCard(1, 0, 0), textCard(2, 0, 1952)]);
    const cam = fitCamera(b, { w: 1280, h: 802 });
    expect(cam).not.toBeNull();
    expect(cam!.zoom).toBeCloseTo((802 - 96) / 2000, 6);
  });
});

describe("camera math", () => {
  it("clampZoom keeps the zoom inside 0.01 to 8", () => {
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(0)).toBe(0.01);
    expect(clampZoom(-3)).toBe(0.01);
    expect(clampZoom(100)).toBe(8);
  });
  it("screenToWorld and worldToScreen round-trip", () => {
    const cam = { x: 100, y: -50, zoom: 2 };
    const world = { x: 340, y: 120 };
    const screen = worldToScreen(world, cam);
    expect(screen).toEqual({ x: 480, y: 340 });
    expect(screenToWorld(screen, cam)).toEqual(world);
    // The other direction: screen -> world -> screen.
    const s2 = { x: 480, y: 340 };
    expect(worldToScreen(screenToWorld(s2, cam), cam)).toEqual(s2);
  });
  it("zoomCamera keeps the zoomed point under the cursor", () => {
    const cam = { x: 100, y: -50, zoom: 1 };
    const cursor = { x: 640, y: 400 };
    const before = screenToWorld(cursor, cam);
    const zoomed = zoomCamera(cam, cursor, 2);
    expect(zoomed.zoom).toBe(2);
    const after = screenToWorld(cursor, zoomed);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    // Zooming out moves the camera the other way, but the
    // anchor still holds.
    const out = zoomCamera(cam, cursor, 0.5);
    expect(out.zoom).toBe(0.5);
    const afterOut = screenToWorld(cursor, out);
    expect(afterOut.x).toBeCloseTo(before.x, 9);
    expect(afterOut.y).toBeCloseTo(before.y, 9);
  });
  it("zoomCamera clamps at the zoom limits", () => {
    expect(zoomCamera({ x: 0, y: 0, zoom: 4 }, { x: 100, y: 100 }, 10).zoom).toBe(8);
    expect(zoomCamera({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, 0.001).zoom).toBe(0.01);
  });
});

describe("helpers", () => {
  it("domainOf strips scheme, www and path", () => {
    expect(domainOf("https://www.example.com/path?q=1")).toBe("example.com");
    expect(domainOf("example.com/x")).toBe("example.com");
  });
  it("parseHex and normaliseHex round-trip a colour", () => {
    expect(parseHex("#1A2b3C")).toEqual([26, 43, 60]);
    expect(parseHex("not a colour")).toBeNull();
    expect(normaliseHex("#1a2B3c")).toBe("#1A2B3C");
    expect(normaliseHex("xyz")).toBeNull();
  });
  it("clippedEnds joins two cards along their centres", () => {
    const b = board([textCard(1, 100, 100), textCard(2, 400, 100)]);
    const ends = clippedEnds(b, { Item: 1 }, { Item: 2 });
    expect(ends).not.toBeNull();
    const [a, c] = ends!;
    // Both endpoints sit on the horizontal line between the centres.
    expect(a.y).toBe(124);
    expect(c.y).toBe(124);
    expect(a.x).toBeGreaterThanOrEqual(100);
    expect(c.x).toBeLessThanOrEqual(660);
    expect(c.x).toBeGreaterThan(a.x);
  });
});

describe("geometry helpers", () => {
  it("anchorPoint returns an Item anchor's centre, null when missing", () => {
    const b = board([textCard(1, 100, 100, 260, 48)]);
    expect(anchorPoint(b, { Item: 1 })).toEqual({ x: 230, y: 124 });
    expect(anchorPoint(b, { Item: 99 })).toBeNull();
  });
  it("itemBounds is pos and size for a plain card", () => {
    const card = textCard(1, 100, 100, 260, 48);
    expect(itemBounds(board([card]), card)).toEqual([{ x: 100, y: 100 }, { w: 260, h: 48 }]);
  });
  it("itemBounds spans a connector's anchors with an 8px margin", () => {
    const conn: Item = {
      id: 3, pos: { x: 0, y: 0 }, size: { w: 0, h: 0 }, group: null,
      kind: { Connector: { from: { Point: { x: 10, y: 20 } }, to: { Point: { x: 110, y: 60 } }, color: "#333333" } },
    };
    expect(itemBounds(board([conn]), conn)).toEqual([{ x: 2, y: 12 }, { w: 116, h: 56 }]);
  });
  it("itemBounds follows a connector's item anchors", () => {
    const a = textCard(1, 100, 100, 260, 48);
    const b = textCard(2, 400, 100, 260, 48);
    const conn: Item = {
      id: 3, pos: { x: 0, y: 0 }, size: { w: 0, h: 0 }, group: null,
      kind: { Connector: { from: { Item: 1 }, to: { Item: 2 }, color: "#333333" } },
    };
    // Centres are (230,124) and (530,124); margin 8 each side.
    expect(itemBounds(board([a, b, conn]), conn)).toEqual([{ x: 222, y: 116 }, { w: 316, h: 16 }]);
  });
  it("itemBounds falls back to pos and size when a connector anchor is missing", () => {
    const conn: Item = {
      id: 3, pos: { x: 40, y: 50 }, size: { w: 10, h: 10 }, group: null,
      kind: { Connector: { from: { Item: 99 }, to: { Point: { x: 1, y: 2 } }, color: "#333333" } },
    };
    expect(itemBounds(board([conn]), conn)).toEqual([{ x: 40, y: 50 }, { w: 10, h: 10 }]);
  });
  it("rotatePoint turns around the centre", () => {
    expect(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 0)).toEqual({ x: 10, y: 0 });
    const q = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    expect(q.x).toBeCloseTo(0, 9);
    expect(q.y).toBeCloseTo(10, 9);
    expect(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 180).x).toBeCloseTo(-10, 9);
    const m = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, -90);
    expect(m.x).toBeCloseTo(0, 9);
    expect(m.y).toBeCloseTo(-10, 9);
    // Around a non-origin centre: (12,10) about (10,10) by 90 is (10,12).
    const c = rotatePoint({ x: 12, y: 10 }, { x: 10, y: 10 }, 90);
    expect(c.x).toBeCloseTo(10, 9);
    expect(c.y).toBeCloseTo(12, 9);
  });
  it("itemRotation is 0 by default, the angle when set, 0 when invalid", () => {
    expect(itemRotation(textCard(1, 0, 0))).toBe(0);
    expect(itemRotation({ ...textCard(1, 0, 0), rotation: 45 })).toBe(45);
    expect(itemRotation({ ...textCard(1, 0, 0), rotation: NaN })).toBe(0);
  });
  it("rectCrossing finds where a segment enters and leaves a rect", () => {
    expect(rectCrossing({ x: 0, y: 50 }, { x: 200, y: 50 }, { x: 100, y: 0 }, 50, 100, true)).toEqual({ x: 100, y: 50 });
    expect(rectCrossing({ x: 0, y: 50 }, { x: 200, y: 50 }, { x: 100, y: 0 }, 50, 100, false)).toEqual({ x: 150, y: 50 });
    expect(rectCrossing({ x: 0, y: 200 }, { x: 200, y: 200 }, { x: 100, y: 0 }, 50, 100, true)).toBeNull();
  });
  it("parseInline keeps plain text, bold and code, and leaves unclosed markers literal", () => {
    expect(parseInline("hello")).toEqual([{ text: "hello" }]);
    expect(parseInline("a **bold** b")).toEqual([{ text: "a " }, { text: "bold", bold: true }, { text: " b" }]);
    expect(parseInline("a `code` b")).toEqual([{ text: "a " }, { text: "code", code: true }, { text: " b" }]);
    expect(parseInline("2*3*4")).toEqual([{ text: "2*3*4" }]);
    expect(parseInline("a *b* c")).toEqual([{ text: "a " }, { text: "b", italic: true }, { text: " c" }]);
  });
});

describe("colour data patches", () => {
  function stroke(id: number): Item {
    return {
      id, pos: { x: 0, y: 0 }, size: { w: 100, h: 20 }, group: null,
      kind: { Stroke: { points: [{ x: 0, y: 0 }], color: "#1A1A1A", width: 3, marker: false } },
    };
  }
  function swatch(id: number): Item {
    return {
      id, pos: { x: 0, y: 0 }, size: { w: 120, h: 120 }, group: null,
      kind: { Swatch: { hex: "#1A1A1A" } },
    };
  }
  it("accepts { color } on a stroke and { hex } on a swatch, normalised", () => {
    expect(colourDataPatch(stroke(1), { color: "#f00" })).toEqual({ color: "#FF0000" });
    expect(colourDataPatch(swatch(2), { hex: "#00ff00" })).toEqual({ hex: "#00FF00" });
  });
  it("accepts { opacity } and { color, opacity } on a stroke, normalised and rounded", () => {
    expect(colourDataPatch(stroke(1), { opacity: 50 })).toEqual({ opacity: 50 });
    expect(colourDataPatch(stroke(1), { color: "#f00", opacity: 50.6 })).toEqual({ color: "#FF0000", opacity: 51 });
    expect(colourDataPatch(stroke(1), { opacity: 0 })).toEqual({ opacity: 0 });
    expect(colourDataPatch(stroke(1), { opacity: 100 })).toEqual({ opacity: 100 });
  });
  it("refuses a bad opacity, an empty patch, or opacity on a swatch", () => {
    expect(colourDataPatch(stroke(1), { opacity: 150 })).toBeNull();
    expect(colourDataPatch(stroke(1), { opacity: -1 })).toBeNull();
    expect(colourDataPatch(stroke(1), { opacity: "50" })).toBeNull();
    expect(colourDataPatch(stroke(1), { opacity: Number.NaN })).toBeNull();
    expect(colourDataPatch(stroke(1), { color: "#FF0000", opacity: 150 })).toBeNull();
    expect(colourDataPatch(stroke(1), {})).toBeNull();
    expect(colourDataPatch(swatch(2), { opacity: 50 })).toBeNull();
    expect(colourDataPatch(textCard(3, 0, 0), { opacity: 50 })).toBeNull();
  });
  it("applyColourDataPatch applies opacity alone and with a colour, leaving the other field alone", () => {
    const s = stroke(1);
    expect(applyColourDataPatch(s, { opacity: 50 })).toBe(true);
    expect((s.kind as { Stroke: { color: string; opacity?: number } }).Stroke.opacity).toBe(50);
    expect((s.kind as { Stroke: { color: string } }).Stroke.color).toBe("#1A1A1A");
    expect(applyColourDataPatch(s, { color: "#0000ff", opacity: 100 })).toBe(true);
    expect((s.kind as { Stroke: { color: string; opacity?: number } }).Stroke).toEqual(
      expect.objectContaining({ color: "#0000FF", opacity: 100 }),
    );
  });
  it("refuses any other key, a bad hex, or a non-colour card", () => {
    expect(colourDataPatch(stroke(1), { width: 5 })).toBeNull();
    expect(colourDataPatch(stroke(1), { color: "#FF0000", width: 5 })).toBeNull();
    expect(colourDataPatch(stroke(1), { color: "red" })).toBeNull();
    expect(colourDataPatch(stroke(1), { hex: "#FF0000" })).toBeNull();
    expect(colourDataPatch(swatch(2), { color: "#FF0000" })).toBeNull();
    expect(colourDataPatch(textCard(3, 0, 0), { color: "#FF0000" })).toBeNull();
    expect(colourDataPatch(stroke(1), null)).toBeNull();
    expect(colourDataPatch(stroke(1), ["#FF0000"])).toBeNull();
  });
  it("applyColourDataPatch recolours the card and leaves the rest alone", () => {
    const s = stroke(1);
    expect(applyColourDataPatch(s, { color: "#0000ff" })).toBe(true);
    expect((s.kind as { Stroke: { color: string } }).Stroke.color).toBe("#0000FF");
    const w = swatch(2);
    expect(applyColourDataPatch(w, { hex: "#0000ff" })).toBe(true);
    expect((w.kind as { Swatch: { hex: string } }).Swatch.hex).toBe("#0000FF");
    expect(applyColourDataPatch(s, { width: 5 })).toBe(false);
    expect((s.kind as { Stroke: { color: string } }).Stroke.color).toBe("#0000FF");
  });
  it("accepts a gradient alone and with a colour, normalised and sorted by offset", () => {
    expect(colourDataPatch(stroke(1), { gradient: { angle: 90, stops: [{ offset: 100, color: "#00ff00" }, { offset: 0, color: "#f00" }] } }))
      .toEqual({ gradient: { angle: 90, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#00FF00" }] } });
    expect(colourDataPatch(stroke(1), { color: "#f00", gradient: { angle: 0, stops: [{ offset: 0, color: "#f00" }, { offset: 100, color: "#00f" }] } }))
      .toEqual({ color: "#FF0000", gradient: { angle: 0, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#0000FF" }] } });
    expect(colourDataPatch(stroke(1), { gradient: null })).toEqual({ gradient: null });
  });
  it("refuses a bad gradient: too few stops, a bad offset, a bad colour, a bad angle", () => {
    expect(colourDataPatch(stroke(1), { gradient: { angle: 0, stops: [{ offset: 0, color: "#FF0000" }] } })).toBeNull();
    expect(colourDataPatch(stroke(1), { gradient: { angle: 0, stops: [{ offset: -1, color: "#FF0000" }, { offset: 100, color: "#00FF00" }] } })).toBeNull();
    expect(colourDataPatch(stroke(1), { gradient: { angle: 0, stops: [{ offset: 0, color: "red" }, { offset: 100, color: "#00FF00" }] } })).toBeNull();
    expect(colourDataPatch(stroke(1), { gradient: { angle: "90", stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#00FF00" }] } })).toBeNull();
    expect(colourDataPatch(stroke(1), { gradient: { angle: 0, stops: "no" } })).toBeNull();
    expect(colourDataPatch(swatch(2), { gradient: { angle: 0, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#00FF00" }] } })).toBeNull();
  });
  it("applyColourDataPatch sets the gradient and clears it back to solid with null", () => {
    const s = stroke(1);
    expect(applyColourDataPatch(s, { gradient: { angle: 45, stops: [{ offset: 0, color: "#f00" }, { offset: 100, color: "#00f" }] } })).toBe(true);
    expect((s.kind as { Stroke: { gradient?: unknown } }).Stroke.gradient).toEqual(
      { angle: 45, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#0000FF" }] },
    );
    expect(applyColourDataPatch(s, { gradient: null })).toBe(true);
    expect((s.kind as { Stroke: { gradient?: unknown } }).Stroke.gradient).toBeUndefined();
  });
});

describe("gradients", () => {
  it("normaliseGradient wraps the angle, normalises colours and sorts the stops", () => {
    expect(normaliseGradient({ angle: 450, stops: [{ offset: 100, color: "#00f" }, { offset: 0, color: "#f00" }] }))
      .toEqual({ angle: 90, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#0000FF" }] });
    expect(normaliseGradient({ angle: -90, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#00FF00" }] })?.angle).toBe(270);
    expect(normaliseGradient(null)).toBeNull();
    expect(normaliseGradient({ angle: 0, stops: [] })).toBeNull();
  });
  it("linearGradientCoords spans the box along the angle", () => {
    const box = { x: 0, y: 0, w: 100, h: 40 };
    expect(linearGradientCoords(0, box)).toEqual({ x1: 0, y1: 20, x2: 100, y2: 20 });
    expect(linearGradientCoords(90, box)).toEqual({ x1: 50, y1: 0, x2: 50, y2: 40 });
    expect(linearGradientCoords(180, box)).toEqual({ x1: 100, y1: 20, x2: 0, y2: 20 });
    // A diagonal reaches corner to corner, not edge to edge.
    const d = linearGradientCoords(45, box);
    expect(d.x1).toBeCloseTo(15, 0);
    expect(d.y1).toBeCloseTo(-15, 0);
    expect(d.x2).toBeCloseTo(85, 0);
    expect(d.y2).toBeCloseTo(55, 0);
  });
});
