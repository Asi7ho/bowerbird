// Unit tests for the AI vector extractor
// (src/backend/ai-vector.ts): operator-list → cards, with
// hand-built operator lists (no pdf.js needed). Pure
// functions, no DOM. The op codes here are built from the
// module's own AI_OPS constants, and one test asserts those
// still match the installed pdf.js, so a pdf.js upgrade that
// renumbers OPS fails loudly instead of silently misreading
// a file.
import { describe, expect, it } from "vitest";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { AI_OPS, extractAiPage, type AiOpList } from "../../src/backend/ai-vector";

describe("AI_OPS matches pdf.js", () => {
  it("every constant still equals pdf.js's OPS value", () => {
    for (const [name, value] of Object.entries(AI_OPS)) {
      expect((OPS as Record<string, number>)[name], name).toBe(value);
    }
  });
});

// A tiny builder for operator lists, in the shape pdf.js
// returns: fnArray of op codes, argsArray of arg lists.
function opsList(entries: Array<[number, unknown[]]>): AiOpList {
  return {
    fnArray: entries.map(([fn]) => fn),
    argsArray: entries.map(([, args]) => args),
  };
}

const FILL = 22; // pdf.js paint op carried by constructPath
const STROKE = 20;
const FILL_STROKE = 24;

// A rectangle as pdf.js compiles `re`: moveTo + 3 lineTo +
// closePath. DrawOPS: moveTo 0, lineTo 1, curveTo 2, closePath 4.
function rectDrawOps(x: number, y: number, w: number, h: number): number[] {
  return [0, x, y, 1, x + w, y, 1, x + w, y + h, 1, x, y + h, 4];
}

// A circle as Illustrator writes one: moveTo + 4 cubics,
// ending back at the start. kappa = 0.5522847498.
function circleDrawOps(cx: number, cy: number, r: number): number[] {
  const k = 0.5522847498 * r;
  return [
    0, cx + r, cy,
    2, cx + r, cy + k, cx + k, cy + r, cx, cy + r,
    2, cx - k, cy + r, cx - r, cy + k, cx - r, cy,
    2, cx - r, cy - k, cx - k, cy - r, cx, cy - r,
    2, cx + k, cy - r, cx + r, cy - k, cx + r, cy,
  ];
}

function glyph(ch: string, width: number): { unicode: string; width: number; isSpace: boolean } {
  return { unicode: ch, width, isSpace: ch === " " };
}

describe("extractAiPage paths", () => {
  it("a filled rectangle becomes a red Shape rect", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFillRGBColor, ["#ff0000"]],
      [AI_OPS.constructPath, [FILL, rectDrawOps(20, 140, 80, 40), {}]],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(1);
    const it = r.items[0];
    expect(it.kind).toEqual({ Shape: { shape: "rect", fill: "#ff0000" } });
    // PDF y-up (20,140)-(100,180) on a 200-high page flips
    // to board (20,20), 80x40.
    expect(it.pos).toEqual({ x: 20, y: 20 });
    expect(it.size).toEqual({ w: 80, h: 40 });
  });

  it("reads a path the way pdf.js actually emits it: one Float32Array", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFillRGBColor, ["#ff0000"]],
      [AI_OPS.constructPath, [FILL, [new Float32Array(rectDrawOps(20, 140, 80, 40))], new Float32Array([20, 140, 100, 180])]],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].kind).toEqual({ Shape: { shape: "rect", fill: "#ff0000" } });
    expect(r.items[0].pos).toEqual({ x: 20, y: 20 });
    expect(r.items[0].size).toEqual({ w: 80, h: 40 });
  });

  it("a circle drawn as four Beziers becomes an ellipse Shape", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFillRGBColor, ["#0000ff"]],
      [AI_OPS.constructPath, [FILL, circleDrawOps(200, 160, 25), {}]],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].kind).toEqual({ Shape: { shape: "ellipse", fill: "#0000ff" } });
    expect(r.items[0].pos).toEqual({ x: 175, y: 15 });
    expect(r.items[0].size).toEqual({ w: 50, h: 50 });
  });

  it("a stroked polyline becomes a Stroke card in its colour and width", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setStrokeRGBColor, ["#008000"]],
      [AI_OPS.setLineWidth, [2]],
      [AI_OPS.constructPath, [STROKE, [0, 20, 20, 1, 60, 80, 1, 100, 30], {}]],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(1);
    const kind = r.items[0].kind;
    expect(kind).toMatchObject({ Stroke: { color: "#008000", width: 2, marker: false } });
    expect(r.items[0].pos).toEqual({ x: 20, y: 120 });
    expect(r.items[0].size).toEqual({ w: 80, h: 60 });
    expect((kind as { Stroke: { points: Array<{ x: number; y: number }> } }).Stroke.points).toEqual([
      { x: 0, y: 60 }, { x: 40, y: 0 }, { x: 80, y: 50 },
    ]);
  });

  it("a filled arbitrary path becomes an outline Stroke in its fill colour", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFillRGBColor, ["#ff0000"]],
      [AI_OPS.constructPath, [FILL, [0, 10, 10, 1, 50, 10, 1, 30, 50, 4], {}]],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].kind).toMatchObject({ Stroke: { color: "#ff0000" } });
  });

  it("a filled-and-stroked rect lands as a Shape plus its edge Stroke", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFillRGBColor, ["#ff0000"]],
      [AI_OPS.setStrokeRGBColor, ["#000000"]],
      [AI_OPS.setLineWidth, [3]],
      [AI_OPS.constructPath, [FILL_STROKE, rectDrawOps(0, 0, 40, 30), {}]],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(2);
    expect(r.items[0].kind).toEqual({ Shape: { shape: "rect", fill: "#ff0000" } });
    expect(r.items[1].kind).toMatchObject({ Stroke: { color: "#000000", width: 3 } });
  });

  it("a path under a transform lands offset and scaled", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.transform, [2, 0, 0, 2, 10, 10]],
      [AI_OPS.setFillRGBColor, ["#ff0000"]],
      [AI_OPS.constructPath, [FILL, rectDrawOps(20, 140, 80, 40), {}]],
    ]), 400);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].pos).toEqual({ x: 50, y: 30 });
    expect(r.items[0].size).toEqual({ w: 160, h: 80 });
  });

  it("a rect inside save/transform/restore (a Form XObject) lands translated", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.save, []],
      [AI_OPS.transform, [1, 0, 0, 1, 150, 20]],
      [AI_OPS.setFillRGBColor, ["#ff8000"]],
      [AI_OPS.constructPath, [FILL, rectDrawOps(0, 0, 40, 30), {}]],
      [AI_OPS.restore, []],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].pos).toEqual({ x: 150, y: 150 });
    expect(r.items[0].size).toEqual({ w: 40, h: 30 });
  });

  it("a gray fill converts to a gray hex", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFillGray, [0.5]],
      [AI_OPS.constructPath, [FILL, rectDrawOps(0, 0, 10, 10), {}]],
    ]), 200);
    expect(r.items[0].kind).toEqual({ Shape: { shape: "rect", fill: "#808080" } });
  });
});

describe("extractAiPage text", () => {
  it("showText becomes an editable Text card at the baseline", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.beginText, []],
      [AI_OPS.setFont, ["F1", 18]],
      [AI_OPS.moveText, [20, 50]],
      [AI_OPS.showText, [[glyph("H", 722), glyph("i", 222)]]],
      [AI_OPS.endText, []],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(1);
    const kind = r.items[0].kind;
    expect(kind).toMatchObject({ Text: { text: "Hi", bold: false, size: 18, color: "#000000" } });
    // Baseline (20,50) on a 200-high page: top is 200-50-18.
    expect(r.items[0].pos).toEqual({ x: 20, y: 132 });
  });

  it("text takes the current fill colour", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFillRGBColor, ["#123456"]],
      [AI_OPS.setFont, ["F1", 14]],
      [AI_OPS.moveText, [10, 100]],
      [AI_OPS.showText, [[glyph("A", 667)]]],
    ]), 200);
    expect(r.items[0].kind).toMatchObject({ Text: { text: "A", color: "#123456", size: 14 } });
  });

  it("a bold font name marks the Text card bold", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFont, ["Helvetica-Bold", 12]],
      [AI_OPS.moveText, [0, 100]],
      [AI_OPS.showText, [[glyph("B", 667)]]],
    ]), 200);
    expect(r.items[0].kind).toMatchObject({ Text: { bold: true } });
  });

  it("invisible text (rendering mode 3) lands nothing", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFont, ["F1", 12]],
      [AI_OPS.setTextRenderingMode, [3]],
      [AI_OPS.moveText, [0, 100]],
      [AI_OPS.showText, [[glyph("B", 667)]]],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(0);
  });
});

describe("extractAiPage images", () => {
  it("paintImageXObject becomes an image request at the CTM rect", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.save, []],
      [AI_OPS.transform, [100, 0, 0, 60, 50, 100]],
      [AI_OPS.paintImageXObject, ["img1", 2, 2]],
      [AI_OPS.restore, []],
    ]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(0);
    expect(r.images).toHaveLength(1);
    expect(r.images[0].objId).toBe("img1");
    expect(r.images[0].pos).toEqual({ x: 50, y: 40 });
    expect(r.images[0].size).toEqual({ w: 100, h: 60 });
  });
});

describe("extractAiPage unmappable content", () => {
  it("a shading fill flags the page", () => {
    const r = extractAiPage(opsList([[AI_OPS.shadingFill, ["sh1"]]]), 200);
    expect(r.unmappable).toBe(true);
    expect(r.reasons[0]).toMatch(/gradient/);
  });

  it("a clipping path flags the page", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.constructPath, [28, rectDrawOps(0, 0, 10, 10), {}]],
      [AI_OPS.clip, []],
    ]), 200);
    expect(r.unmappable).toBe(true);
    expect(r.reasons[0]).toMatch(/clipping/);
  });

  it("an ExtGState with alpha < 1 flags the page", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setGState, [[["ca", 0.5], ["CA", 0.5]]]],
    ]), 200);
    expect(r.unmappable).toBe(true);
    expect(r.reasons[0]).toMatch(/transparency/);
  });

  it("a pattern fill flags the page", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setFillColorN, ["TilingPattern", null, {}, [1, 0, 0, 1, 0, 0], [0, 0, 10, 10], 10, 10, 1, 1, false]],
      [AI_OPS.constructPath, [FILL, rectDrawOps(0, 0, 10, 10), {}]],
    ]), 200);
    expect(r.unmappable).toBe(true);
    expect(r.reasons[0]).toMatch(/pattern/);
  });

  it("a dashed stroke flags the page", () => {
    const r = extractAiPage(opsList([
      [AI_OPS.setStrokeRGBColor, ["#000000"]],
      [AI_OPS.setDash, [[3, 3], 0]],
      [AI_OPS.constructPath, [STROKE, [0, 0, 0, 1, 10, 10], {}]],
    ]), 200);
    expect(r.unmappable).toBe(true);
    expect(r.reasons[0]).toMatch(/dashed/);
  });

  it("an empty operator list is mappable and yields nothing", () => {
    const r = extractAiPage(opsList([]), 200);
    expect(r.unmappable).toBe(false);
    expect(r.items).toHaveLength(0);
    expect(r.images).toHaveLength(0);
  });
});
