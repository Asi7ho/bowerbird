// Unit tests for the drawing plugin's pure logic
// (src/ui/drawing-tools.ts): tool ids and the commit math
// for each tool. Gestures run against the live board, so
// the e2e checks cover them instead.
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_TOOL_ID,
  ERASER_RADIUS,
  ERASER_TOOL_ID,
  PEN_TOOL_ID,
  buildConnectorItem,
  buildShapeItem,
  buildStrokeItem,
  drawKindOf,
  drawToolId,
  eraserSplitItems,
  isDrawToolId,
  isShapeToolId,
  shapeBox,
  shapeKindOf,
  shapeToolId,
} from "../../src/ui/drawing-tools";

describe("tool ids", () => {
  it("builds plugin tool ids from the kinds", () => {
    expect(drawToolId("pen")).toBe("plugin:core-draw:pen");
    expect(drawToolId("eraser")).toBe("plugin:core-draw:eraser");
    expect(shapeToolId("rect")).toBe("plugin:core-draw:rect");
    expect(shapeToolId("triangle")).toBe("plugin:core-draw:triangle");
    expect(PEN_TOOL_ID).toBe("plugin:core-draw:pen");
    expect(ERASER_TOOL_ID).toBe("plugin:core-draw:eraser");
    expect(CONNECTOR_TOOL_ID).toBe("plugin:core-draw:connector");
  });
  it("reads the draw kind back off a tool id", () => {
    expect(drawKindOf("plugin:core-draw:pen")).toBe("pen");
    expect(drawKindOf("plugin:core-draw:eraser")).toBe("eraser");
    // Pencil and highlighter are gone: the ids no longer
    // belong to a tool, so they read back as nothing.
    expect(drawKindOf("plugin:core-draw:pencil")).toBe(null);
    expect(drawKindOf("plugin:core-draw:highlighter")).toBe(null);
    expect(drawKindOf("plugin:core-draw:rect")).toBe(null);
    expect(drawKindOf("plugin:core-draw:connector")).toBe(null);
    expect(drawKindOf("pen")).toBe(null);
    expect(drawKindOf("select")).toBe(null);
  });
  it("tells draw tools from shape tools", () => {
    expect(isDrawToolId("plugin:core-draw:pen")).toBe(true);
    expect(isDrawToolId("plugin:core-draw:eraser")).toBe(true);
    expect(isDrawToolId("plugin:core-draw:rect")).toBe(false);
    expect(isDrawToolId("plugin:core-draw:connector")).toBe(false);
    expect(isShapeToolId("plugin:core-draw:triangle")).toBe(true);
    expect(isShapeToolId("plugin:core-draw:star")).toBe(true);
    expect(isShapeToolId("plugin:core-draw:pen")).toBe(false);
    expect(isShapeToolId("plugin:core-draw:connector")).toBe(false);
    expect(isShapeToolId("plugin:other-plugin:rect")).toBe(false);
    expect(isShapeToolId("select")).toBe(false);
  });
  it("reads the shape kind back off a shape tool id", () => {
    expect(shapeKindOf("plugin:core-draw:star")).toBe("star");
    expect(shapeKindOf("plugin:core-draw:pen")).toBe(null);
    expect(shapeKindOf("rect")).toBe(null);
  });
  it("keeps the eraser radius the ring and the erase agree on", () => {
    expect(ERASER_RADIUS).toBe(12);
  });
});

describe("buildStrokeItem", () => {
  it("returns null for a one-point drag", () => {
    expect(buildStrokeItem([{ x: 10, y: 20 }], [], "#1A1A1A", 3, false, false)).toBe(null);
  });
  it("builds the stroke in the pen colour at the tool width", () => {
    const item = buildStrokeItem(
      [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }],
      [], "#E63946", 3, false, false,
    );
    expect(item).not.toBe(null);
    expect(item?.pos).toEqual({ x: 10, y: 20 });
    expect(item?.size).toEqual({ w: 20, h: 20 });
    expect(item?.kind).toEqual({
      Stroke: { points: [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }], color: "#E63946", width: 3, marker: false },
    });
  });
  it("keeps pressures and the pencil flag when the stroke has them", () => {
    const item = buildStrokeItem(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [0.5, 0.8], "#1A1A1A", 2, false, true,
    );
    expect(item?.kind).toEqual({
      Stroke: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], color: "#1A1A1A", width: 2, marker: false, pressures: [0.5, 0.8], pencil: true },
    });
  });
  it("stores a non-100 opacity, and stores nothing at 100", () => {
    const faint = buildStrokeItem(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [], "#E63946", 3, false, false, 50,
    );
    expect(faint?.kind).toEqual({
      Stroke: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], color: "#E63946", width: 3, marker: false, opacity: 50 },
    });
    const full = buildStrokeItem(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [], "#E63946", 3, false, false, 100,
    );
    expect(full?.kind).toEqual({
      Stroke: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], color: "#E63946", width: 3, marker: false },
    });
    expect("opacity" in (full?.kind as { Stroke: object }).Stroke).toBe(false);
  });
  it("stores a gradient, and stores nothing for a null one", () => {
    const gradient = { angle: 90, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#0000FF" }] };
    const item = buildStrokeItem(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [], "#FF0000", 3, false, false, 100, gradient,
    );
    expect(item?.kind).toEqual({
      Stroke: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], color: "#FF0000", width: 3, marker: false, gradient },
    });
    const solid = buildStrokeItem(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [], "#FF0000", 3, false, false, 100, null,
    );
    expect("gradient" in (solid?.kind as { Stroke: object }).Stroke).toBe(false);
  });
  it("carries a brush texture, beside the pencil flag", () => {
    const item = buildStrokeItem(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [], "#1A1A1A", 2, false, true, 100, null, "graphite",
    );
    expect(item?.kind).toEqual({
      Stroke: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], color: "#1A1A1A", width: 2, marker: false, pencil: true, texture: "graphite" },
    });
  });
});

describe("shapeBox and buildShapeItem", () => {
  it("normalises a reversed drag to a top-left box", () => {
    expect(shapeBox({ x: 30, y: 40 }, { x: 10, y: 10 })).toEqual({ x0: 10, y0: 10, w: 20, h: 30 });
    expect(shapeBox({ x: 10, y: 10 }, { x: 30, y: 40 })).toEqual({ x0: 10, y0: 10, w: 20, h: 30 });
  });
  it("returns null for a drag smaller than 10x10", () => {
    expect(buildShapeItem("rect", { x: 0, y: 0 }, { x: 5, y: 5 }, "#1A1A1A", false)).toBe(null);
    expect(buildShapeItem("rect", { x: 0, y: 0 }, { x: 30, y: 5 }, "#1A1A1A", false)).toBe(null);
    expect(buildShapeItem("ellipse", { x: 0, y: 0 }, { x: 5, y: 30 }, "#1A1A1A", false)).toBe(null);
  });
  it("builds a filled shape in the pen colour", () => {
    const item = buildShapeItem("rect", { x: 10, y: 10 }, { x: 50, y: 40 }, "#1A1A1A", false);
    expect(item).toEqual({
      kind: { Shape: { shape: "rect", fill: "#1A1A1A" } },
      pos: { x: 10, y: 10 },
      size: { w: 40, h: 30 },
    });
  });
  it("builds an outlined shape from the same drag, reversed", () => {
    const item = buildShapeItem("triangle", { x: 50, y: 40 }, { x: 10, y: 10 }, "#2E86AB", true, 9);
    expect(item).toEqual({
      kind: { Shape: { shape: "triangle", fill: "#2E86AB", outline: true, width: 9 } },
      pos: { x: 10, y: 10 },
      size: { w: 40, h: 30 },
    });
  });
  it("an outlined shape without a width keeps the 4px default", () => {
    const item = buildShapeItem("rect", { x: 10, y: 10 }, { x: 50, y: 40 }, "#1A1A1A", true);
    expect(item?.kind).toEqual({ Shape: { shape: "rect", fill: "#1A1A1A", outline: true, width: 4 } });
  });
});

describe("buildConnectorItem", () => {
  it("builds a point-to-point connector in the pen colour", () => {
    const item = buildConnectorItem({ Point: { x: 0, y: 0 } }, { Point: { x: 100, y: 0 } }, { x: 0, y: 0 }, { x: 100, y: 0 }, "#1A1A1A", 9);
    expect(item).toEqual({
      kind: { Connector: { from: { Point: { x: 0, y: 0 } }, to: { Point: { x: 100, y: 0 } }, color: "#1A1A1A", width: 9 } },
      pos: { x: 0, y: 0 },
      size: { w: 100, h: 1 },
    });
  });
  it("returns null for a degenerate point-to-point line", () => {
    expect(buildConnectorItem({ Point: { x: 0, y: 0 } }, { Point: { x: 2, y: 0 } }, { x: 0, y: 0 }, { x: 2, y: 0 }, "#1A1A1A")).toBe(null);
  });
  it("returns null for a connector from a card to itself", () => {
    expect(buildConnectorItem({ Item: 5 }, { Item: 5 }, { x: 0, y: 0 }, { x: 10, y: 10 }, "#1A1A1A")).toBe(null);
  });
  it("builds the connector when the start anchor is unknown", () => {
    const item = buildConnectorItem({ Point: { x: 0, y: 0 } }, { Point: { x: 10, y: 0 } }, null, { x: 10, y: 0 }, "#1A1A1A");
    expect(item?.pos).toEqual({ x: 0, y: 0 });
    expect(item?.size).toEqual({ w: 10, h: 1 });
  });
});

describe("eraserSplitItems", () => {
  const line = (n: number): { x: number; y: number }[] =>
    Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0 }));
  it("splits a stroke into the pieces either side of the eraser", () => {
    const pieces = eraserSplitItems(
      { points: line(11), color: "#1A1A1A", width: 3, marker: false },
      { x: 50, y: 0 }, ERASER_RADIUS,
    );
    expect(pieces).toHaveLength(2);
    expect(pieces[0].kind).toEqual({ Stroke: { points: line(4), color: "#1A1A1A", width: 3, marker: false } });
    expect(pieces[0].pos).toEqual({ x: 0, y: 0 });
    expect(pieces[0].size).toEqual({ w: 30, h: 1 });
    expect(pieces[1].kind).toEqual({
      Stroke: { points: [{ x: 70, y: 0 }, { x: 80, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 0 }], color: "#1A1A1A", width: 3, marker: false },
    });
    expect(pieces[1].pos).toEqual({ x: 70, y: 0 });
  });
  it("leaves nothing when the eraser covers the whole stroke", () => {
    const pieces = eraserSplitItems(
      { points: line(5), color: "#1A1A1A", width: 3, marker: false },
      { x: 20, y: 0 }, ERASER_RADIUS,
    );
    expect(pieces).toHaveLength(0);
  });
  it("leaves the stroke whole when the eraser misses it", () => {
    const pieces = eraserSplitItems(
      { points: line(5), color: "#1A1A1A", width: 3, marker: false },
      { x: 200, y: 0 }, ERASER_RADIUS,
    );
    expect(pieces).toHaveLength(1);
    expect(pieces[0].kind).toEqual({ Stroke: { points: line(5), color: "#1A1A1A", width: 3, marker: false } });
  });
  it("keeps pressures with their points and the pencil flag", () => {
    const pressures = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 0.9, 0.8, 0.7, 0.6, 0.5];
    const pieces = eraserSplitItems(
      { points: line(11), pressures, color: "#1A1A1A", width: 2, marker: false, pencil: true },
      { x: 50, y: 0 }, ERASER_RADIUS,
    );
    expect(pieces).toHaveLength(2);
    expect(pieces[0].kind).toEqual({
      Stroke: { points: line(4), pressures: [0.5, 0.6, 0.7, 0.8], color: "#1A1A1A", width: 2, marker: false, pencil: true },
    });
    expect(pieces[1].kind).toEqual({
      Stroke: { points: [{ x: 70, y: 0 }, { x: 80, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 0 }], pressures: [0.8, 0.7, 0.6, 0.5], color: "#1A1A1A", width: 2, marker: false, pencil: true },
    });
  });
  it("keeps the stroke's opacity in both pieces", () => {
    const pieces = eraserSplitItems(
      { points: line(11), color: "#1A1A1A", width: 3, marker: false, opacity: 50 },
      { x: 50, y: 0 }, ERASER_RADIUS,
    );
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      expect((piece.kind as { Stroke: { opacity?: number } }).Stroke.opacity).toBe(50);
    }
  });
  it("keeps the stroke's gradient in both pieces", () => {
    const gradient = { angle: 90, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#0000FF" }] };
    const pieces = eraserSplitItems(
      { points: line(11), color: "#FF0000", width: 3, marker: false, gradient },
      { x: 50, y: 0 }, ERASER_RADIUS,
    );
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      expect((piece.kind as { Stroke: { gradient?: unknown } }).Stroke.gradient).toEqual(gradient);
    }
  });
  it("keeps the texture on the pieces", () => {
    const pieces = eraserSplitItems(
      { points: line(11), color: "#1A1A1A", width: 2, marker: false, texture: "graphite" },
      { x: 50, y: 0 }, ERASER_RADIUS,
    );
    expect(pieces).toHaveLength(2);
    expect(pieces.map((p) => "Stroke" in p.kind ? p.kind.Stroke.texture : null)).toEqual(["graphite", "graphite"]);
  });
});
