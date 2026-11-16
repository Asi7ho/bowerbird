// Unit tests for the PSD import (src/backend/psd-import.ts):
// real-file parsing against the committed fixture, and the
// layer → card mapping against hand-built layers.
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import type { Layer, Psd } from "ag-psd";
import { parsePsd, psdLayersToItems } from "../../src/backend/psd-import";

const FIXTURE = new URL("../e2e/fixtures/sample.psd", import.meta.url);

// A Node Buffer's .buffer is a pooled ArrayBuffer: slice it
// to the file's own bytes before handing it to the parser.
function fixtureBytes(): ArrayBuffer {
  const bytes = readFileSync(FIXTURE);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function pixels(w: number, h: number) {
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
}

function layer(partial: Partial<Layer>): Layer {
  return { ...partial } as Layer;
}

function psd(partial: Partial<Psd>): Psd {
  return { width: 200, height: 120, ...partial } as Psd;
}

describe("parsePsd (fixture)", () => {
  it("reads the fixture's size, layers, text and group", () => {
    const parsed = parsePsd(fixtureBytes());
    expect(parsed.width).toBe(200);
    expect(parsed.height).toBe(120);
    expect((parsed.children ?? []).map((l) => l.name)).toEqual(["Red square", "Title", "Group", "Hidden layer"]);
    const title = (parsed.children ?? [])[1];
    expect(title.text?.text).toBe("Hello PSD");
    expect(title.text?.style?.fontSize).toBe(24);
    expect(title.text?.style?.fillColor).toEqual({ r: 0, g: 0, b: 0 });
    expect((parsed.children ?? [])[3].hidden).toBe(true);
    const group = (parsed.children ?? [])[2];
    expect((group.children ?? []).map((l) => l.name)).toEqual(["Green square"]);
    const red = (parsed.children ?? [])[0];
    expect(red.imageData?.width).toBe(80);
    expect(red.imageData?.height).toBe(60);
    expect(red.imageData?.data[0]).toBe(255);
  });
  it("throws on a file that is not a PSD", () => {
    expect(() => parsePsd(new TextEncoder().encode("not a psd file at all").buffer)).toThrow();
  });
});

describe("psdLayersToItems", () => {
  it("maps a raster layer to an Image card at its bounds", () => {
    const items = psdLayersToItems(psd({
      children: [layer({ name: "Photo", left: 10, top: 20, right: 110, bottom: 70, imageData: pixels(100, 50) })],
    }), { x: 0, y: 0 });
    expect(items).toHaveLength(1);
    expect(items[0].pos).toEqual({ x: 10, y: 20 });
    expect(items[0].size).toEqual({ w: 100, h: 50 });
    expect("Image" in items[0].kind).toBe(true);
    expect(items[0].pixels?.width).toBe(100);
  });
  it("maps a text layer to a Text card with its size and colour", () => {
    const items = psdLayersToItems(psd({
      children: [layer({
        name: "Title", left: 5, top: 5, right: 205, bottom: 35,
        text: { text: "Hello", style: { fontSize: 24, fauxBold: true, fillColor: { r: 255, g: 0, b: 0 } } },
      })],
    }), { x: 0, y: 0 });
    expect(items).toHaveLength(1);
    expect("Text" in items[0].kind && items[0].kind.Text.text).toBe("Hello");
    expect("Text" in items[0].kind && items[0].kind.Text.size).toBe(24);
    expect("Text" in items[0].kind && items[0].kind.Text.bold).toBe(true);
    expect("Text" in items[0].kind && items[0].kind.Text.color).toBe("#ff0000");
  });
  it("skips hidden, empty and adjustment layers, and flattens groups", () => {
    const items = psdLayersToItems(psd({
      children: [
        layer({ name: "Hidden", left: 0, top: 0, right: 10, bottom: 10, hidden: true, imageData: pixels(10, 10) }),
        layer({ name: "Empty", left: 0, top: 0, right: 0, bottom: 0 }),
        layer({ name: "Curves", left: 0, top: 0, right: 10, bottom: 10 }),
        layer({
          name: "Group", children: [
            layer({ name: "Inside", left: 30, top: 30, right: 50, bottom: 50, imageData: pixels(20, 20) }),
          ],
        }),
      ],
    }), { x: 0, y: 0 });
    expect(items).toHaveLength(1);
    expect(items[0].pos).toEqual({ x: 30, y: 30 });
  });
  it("reverses the layer order so the topmost layer lands on top", () => {
    const items = psdLayersToItems(psd({
      children: [
        layer({ name: "Top", left: 0, top: 0, right: 10, bottom: 10, imageData: pixels(10, 10) }),
        layer({ name: "Bottom", left: 0, top: 0, right: 10, bottom: 10, imageData: pixels(10, 10) }),
      ],
    }), { x: 0, y: 0 });
    // "Top" was first in the file (topmost); it must land
    // last in the board, on top of "Bottom".
    expect(items).toHaveLength(2);
    expect(items[1].pixels).toBeDefined();
    expect(items[0].pos).toEqual({ x: 0, y: 0 });
  });
  it("scales a wide canvas down to the max width", () => {
    const items = psdLayersToItems(psd({
      width: 2560, height: 1440,
      children: [layer({ name: "Photo", left: 1280, top: 0, right: 2560, bottom: 720, imageData: pixels(1280, 720) })],
    }), { x: 100, y: 50 });
    expect(items).toHaveLength(1);
    expect(items[0].pos).toEqual({ x: 740, y: 50 });
    expect(items[0].size).toEqual({ w: 640, h: 360 });
  });
  it("lands the composite as one card when a PSD has no layers", () => {
    const items = psdLayersToItems(psd({ children: [], imageData: pixels(200, 120) }), { x: 10, y: 20 });
    expect(items).toHaveLength(1);
    expect(items[0].pos).toEqual({ x: 10, y: 20 });
    expect(items[0].size).toEqual({ w: 200, h: 120 });
  });
  it("maps the whole fixture: two images and a text, hidden skipped", () => {
    const parsed = parsePsd(fixtureBytes());
    const items = psdLayersToItems(parsed, { x: 0, y: 0 });
    expect(items).toHaveLength(3);
    const kinds = items.map((it) => Object.keys(it.kind)[0]);
    expect(kinds).toEqual(["Image", "Text", "Image"]);
    const text = items.find((it) => "Text" in it.kind);
    expect(text && "Text" in text.kind && text.kind.Text.text).toBe("Hello PSD");
    const red = items.find((it) => it.size.w === 80);
    expect(red?.pos).toEqual({ x: 10, y: 10 });
    const green = items.find((it) => it.size.w === 40);
    expect(green?.pos).toEqual({ x: 120, y: 70 });
  });
});
