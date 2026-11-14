// Unit tests for the board model (src/model.ts): the pure core
// every tool, drag and plugin builds on. No DOM, no Electron,
// so these run in plain vitest on every push and PR.
import { describe, expect, it } from "vitest";
import {
  allocId,
  anchorPoint,
  arrangeItems,
  centre,
  checklistProgress,
  clippedEnds,
  domainOf,
  escapeHtml,
  estimateTextHeight,
  fitCamera,
  hitTest,
  itemBounds,
  itemRotation,
  lassoSelect,
  marquee,
  moveSelection,
  normaliseHex,
  parseHex,
  parseInline,
  parseMarkdown,
  pointInPolygon,
  pressureWidth,
  rectCrossing,
  renderMarkdownHtml,
  resizeItem,
  rotatePoint,
  segmentIntersectsRect,
  select,
  setChecklistDone,
  strokeMaxWidth,
  strokePressuresVary,
  strokesWithin,
  toggleTaskLine,
  type Board,
  type Item,
} from "../../src/model";

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

function strokeKind(item: Item) {
  if (!("Stroke" in item.kind)) throw new Error("expected a stroke item");
  return item.kind.Stroke;
}

function board(items: Item[]): Board {
  return { items, camera: { x: 0, y: 0, zoom: 1 }, next_id: 100, next_group: 0, bg: "#FFFFFF", grid: "Dots" };
}

describe("stylus pressure", () => {
  it("a mouse (pressure 0.5) draws at the base width", () => {
    expect(pressureWidth(3, 0.5)).toBe(3);
  });
  it("a light touch draws thin, a hard press draws thick, capped at 8", () => {
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
  it("strokePressuresVary needs a real spread, not jitter", () => {
    expect(strokePressuresVary({})).toBe(false);
    expect(strokePressuresVary({ pressures: [0.5] })).toBe(false);
    expect(strokePressuresVary({ pressures: [0.5, 0.5, 0.51] })).toBe(false);
    expect(strokePressuresVary({ pressures: [0.1, 0.5, 1] })).toBe(true);
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
});

describe("marquee and lasso", () => {
  it("marquee selects what its rect touches, in either drag direction", () => {
    const b = board([textCard(1, 100, 100), textCard(2, 400, 100), textCard(3, 100, 400)]);
    expect(marquee(b, { x: 90, y: 90 }, { x: 300, y: 200 })).toEqual([1]);
    expect(marquee(b, { x: 300, y: 200 }, { x: 90, y: 90 })).toEqual([1]);
    expect(marquee(b, { x: 0, y: 0 }, { x: 700, y: 500 })).toEqual([1, 2, 3]);
  });
  it("pointInPolygon is true inside, false outside", () => {
    const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
  });
  it("lassoSelect needs at least 3 points and selects what the loop touches", () => {
    const b = board([textCard(1, 100, 100), textCard(2, 400, 100)]);
    expect(lassoSelect(b, [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual([]);
    const loop = [{ x: 90, y: 90 }, { x: 370, y: 90 }, { x: 370, y: 160 }, { x: 90, y: 160 }];
    expect(lassoSelect(b, loop)).toEqual([1]);
  });
  it("segmentIntersectsRect detects a crossing and a miss", () => {
    expect(segmentIntersectsRect({ x: 0, y: 50 }, { x: 200, y: 50 }, { x: 100, y: 0, w: 50, h: 100 })).toBe(true);
    expect(segmentIntersectsRect({ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 100, y: 0, w: 50, h: 100 })).toBe(false);
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
});

describe("arrangeItems", () => {
  it("row lines cards up from the leftmost, vertically centred", () => {
    const b = board([textCard(1, 100, 100), textCard(2, 500, 300, 100, 48)]);
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
  it("returns nothing when there is nothing to arrange", () => {
    const b = board([textCard(1, 100, 100)]);
    expect(arrangeItems(b, [], { type: "row" })).toEqual([]);
    expect(arrangeItems(b, [99], { type: "row" })).toEqual([]);
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
  it("allocId hands out increasing ids", () => {
    const b = board([]);
    expect(allocId(b)).toBe(101);
    expect(allocId(b)).toBe(102);
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
  it("estimateTextHeight never goes below 48 and grows with text", () => {
    expect(estimateTextHeight("", 16, 260)).toBe(48);
    const short = estimateTextHeight("Hi", 16, 260);
    const long = estimateTextHeight("word ".repeat(200), 16, 260);
    expect(short).toBeGreaterThanOrEqual(48);
    expect(long).toBeGreaterThan(short);
  });
  it("escapeHtml escapes the four characters", () => {
    expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
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
  it("centre is the middle of the card", () => {
    expect(centre(textCard(1, 100, 100, 260, 48))).toEqual({ x: 230, y: 124 });
  });
  it("anchorPoint returns a Point anchor as-is", () => {
    expect(anchorPoint(board([]), { Point: { x: 5, y: 6 } })).toEqual({ x: 5, y: 6 });
  });
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
