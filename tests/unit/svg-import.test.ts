// Unit tests for the SVG import parser
// (src/backend/svg-import.ts): colours, path flattening,
// and the element → card mapping. Pure functions, no DOM.
import { describe, expect, it } from "vitest";
import { flattenPathData, parseSvgColor, parseSvgToItems } from "../../src/backend/svg-import";

describe("parseSvgColor", () => {
  it.each([
    ["#1a2b3c", "#1a2b3c"], // 6-digit hex passes through
    ["#f00", "#ff0000"], // 3-digit hex expands
    ["#ff000080", "#ff0000"], // 8-digit hex drops its alpha
    ["#ff000000", null], // fully transparent is no colour
    ["rgb(255, 0, 128)", "#ff0080"],
    ["rgba(0, 128, 0, 0)", null],
    ["rgba(0, 128, 0, 1)", "#008000"],
    ["red", "#ff0000"], // named colours
    ["none", null],
    ["transparent", null],
    ["not-a-colour", null],
    [undefined, null],
  ])("parseSvgColor(%s) is %s", (input, expected) => {
    expect(parseSvgColor(input)).toBe(expected);
  });
});

describe("flattenPathData", () => {
  it("flattens absolute lines and closes with Z", () => {
    const pts = flattenPathData("M 0 0 L 10 0 L 10 10 Z");
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]).toEqual({ x: 10, y: 0 });
    expect(pts[2]).toEqual({ x: 10, y: 10 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 0 });
  });
  it("handles relative moves, H and V", () => {
    expect(flattenPathData("m 5 5 h 10 v 10")).toEqual([
      { x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 },
    ]);
    // A move-only path is just its point; an empty path
    // is nothing.
    expect(flattenPathData("M 5 5")).toEqual([{ x: 5, y: 5 }]);
    expect(flattenPathData("")).toEqual([]);
  });
  it("samples a cubic to its endpoint", () => {
    const pts = flattenPathData("M 0 0 C 0 10, 10 10, 10 0");
    expect(pts.length).toBeGreaterThan(2);
    expect(pts[pts.length - 1]).toEqual({ x: 10, y: 0 });
    // The curve bulges: its midpoint is near (5, 7.5),
    // the cubic's value at t=0.5 — not on the straight
    // line between the endpoints.
    const mid = pts[Math.floor(pts.length / 2)];
    expect(mid.x).toBeCloseTo(5, 0);
    expect(mid.y).toBeCloseTo(7.5, 0);
  });
  it("samples an arc to its endpoint", () => {
    const pts = flattenPathData("M 0 0 A 10 10 0 0 1 20 0");
    expect(pts.length).toBeGreaterThan(2);
    const last = pts[pts.length - 1];
    expect(Math.abs(last.x - 20)).toBeLessThan(0.01);
    expect(Math.abs(last.y)).toBeLessThan(0.01);
    // A semicircle up: its midpoint is the top (10, -10)
    // in SVG's y-down coordinates.
    const mid = pts[Math.floor(pts.length / 2)];
    expect(mid.x).toBeCloseTo(10, 0);
    expect(mid.y).toBeCloseTo(-10, 0);
  });
});

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect x="10" y="20" width="100" height="50" fill="#ff0000"/>
  <circle cx="200" cy="50" r="25" fill="blue"/>
  <ellipse cx="300" cy="50" rx="30" ry="15" fill="none" stroke="#00ff00" stroke-width="3"/>
  <line x1="10" y1="100" x2="110" y2="100" stroke="#000" stroke-width="2"/>
  <polyline points="150,100 170,120 190,100" fill="none" stroke="black"/>
  <path d="M 210 100 L 260 100 L 260 150 Z" fill="#0000ff"/>
  <text x="10" y="180" font-size="20" fill="#333333">Hello SVG</text>
  <g transform="translate(320, 100)"><rect x="0" y="0" width="40" height="40" fill="gold"/></g>
</svg>`;

describe("parseSvgToItems", () => {
  it("maps rect, circle, ellipse, line, polyline, path and text to cards", () => {
    const items = parseSvgToItems(SAMPLE_SVG, { x: 0, y: 0 });
    const kinds = items.map((it) => Object.keys(it.kind)[0]);
    expect(kinds).toEqual(["Shape", "Shape", "Shape", "Stroke", "Stroke", "Stroke", "Text", "Shape"]);
    const rect = items[0];
    // Positions are relative to the artwork's union box,
    // which lands at the origin: the top-left rect is at 0,0.
    expect(rect.pos).toEqual({ x: 0, y: 0 });
    expect(rect.size).toEqual({ w: 100, h: 50 });
    expect("Shape" in rect.kind && rect.kind.Shape.fill).toBe("#ff0000");
    // The stroked ellipse becomes an outline shape.
    const ellipse = items[2];
    expect("Shape" in ellipse.kind && ellipse.kind.Shape.outline).toBe(true);
    expect("Shape" in ellipse.kind && ellipse.kind.Shape.shape).toBe("ellipse");
    // The filled path becomes a stroke in its fill colour.
    const pathStroke = items[5];
    expect("Stroke" in pathStroke.kind && pathStroke.kind.Stroke.color).toBe("#0000ff");
    expect("Stroke" in pathStroke.kind && pathStroke.kind.Stroke.points.length).toBeGreaterThan(2);
    // Stroke points are absolute, like a hand-drawn
    // stroke's: the line runs (10,100)-(110,100) in SVG
    // units, and the union box starts at (10,20), so it
    // lands at (0,80)-(100,80) with pos (0,80).
    const line = items[3];
    expect("Stroke" in line.kind && line.kind.Stroke.points).toEqual([{ x: 0, y: 80 }, { x: 100, y: 80 }]);
    expect(line.pos).toEqual({ x: 0, y: 80 });
    // Every imported stroke obeys the board contract:
    // the min of its points is its pos.
    for (const it of items) {
      if (!("Stroke" in it.kind)) continue;
      const xs = it.kind.Stroke.points.map((p) => p.x);
      const ys = it.kind.Stroke.points.map((p) => p.y);
      expect(Math.min(...xs)).toBe(it.pos.x);
      expect(Math.min(...ys)).toBe(it.pos.y);
    }
    // The text card keeps its text, size and colour.
    const text = items[6];
    expect("Text" in text.kind && text.kind.Text.text).toBe("Hello SVG");
    expect("Text" in text.kind && text.kind.Text.size).toBe(20);
    expect("Text" in text.kind && text.kind.Text.color).toBe("#333333");
    // The grouped rect is translated by the group's transform,
    // then shifted by the union box's top-left (10, 20).
    const grouped = items[7];
    expect(grouped.pos).toEqual({ x: 310, y: 80 });
  });
  it("scales a wide SVG down to the max width", () => {
    const wide = `<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="1280" height="100" fill="red"/></svg>`;
    const items = parseSvgToItems(wide, { x: 100, y: 50 });
    expect(items).toHaveLength(1);
    expect(items[0].size.w).toBe(640);
    expect(items[0].size.h).toBe(50);
    expect(items[0].pos).toEqual({ x: 100, y: 50 });
  });
  it("returns nothing for an unparseable file or one with no mappable elements", () => {
    expect(parseSvgToItems("not xml at all", { x: 0, y: 0 })).toEqual([]);
    expect(parseSvgToItems("<svg><defs><rect id='r' width='10' height='10'/></defs><use href='#r'/></svg>", { x: 0, y: 0 })).toEqual([]);
    expect(parseSvgToItems("<html><body>no svg</body></html>", { x: 0, y: 0 })).toEqual([]);
  });
  it("embeds a data: image and skips an external one", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <image x="0" y="0" width="4" height="4" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="/>
      <image x="10" y="0" width="4" height="4" href="https://example.com/a.png"/>
    </svg>`;
    const items = parseSvgToItems(svg, { x: 0, y: 0 });
    expect(items).toHaveLength(1);
    expect("Image" in items[0].kind).toBe(true);
    expect(items[0].embed?.name).toBe("image.png");
    expect(items[0].embed?.data.length).toBeGreaterThan(0);
  });
});
