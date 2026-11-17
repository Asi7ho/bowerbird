// Unit tests for the live-import helpers
// (src/backend/live-import.ts): finding the group linked to a
// source file, and translating a fresh import onto the group's
// current position. Pure functions, no DOM.
import { describe, expect, it } from "vitest";
import { base64ToBytes, fileCardSize, findSourceGroup, groupBBox, translateImportedToAnchor } from "../../src/backend/live-import";
import type { Board } from "../../src/backend/model";

function boardWithGroups(groups: Board["groups"]): Board {
  return {
    items: [],
    camera: { x: 0, y: 0, zoom: 1 },
    next_id: 0,
    next_group: 0,
    groups,
    bg: "#ffffff",
    grid: "Dots",
  };
}

describe("base64ToBytes", () => {
  it("decodes base64 to the original bytes", () => {
    expect(base64ToBytes("aGVsbG8=")).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    expect(base64ToBytes("")).toEqual(new Uint8Array([]));
  });
});

describe("findSourceGroup", () => {
  it("finds the group linked to a source path", () => {
    const board = boardWithGroups({
      1: { label: "Section 1" },
      2: { label: "sample.svg", source: { path: "/b/assets/sample.svg", kind: "svg" } },
    });
    expect(findSourceGroup(board, "/b/assets/sample.svg")).toBe(2);
  });
  it("returns null when no group links the path", () => {
    const board = boardWithGroups({
      2: { label: "sample.svg", source: { path: "/b/assets/sample.svg", kind: "svg" } },
    });
    expect(findSourceGroup(board, "/b/assets/other.svg")).toBeNull();
    expect(findSourceGroup(boardWithGroups(undefined), "/b/assets/sample.svg")).toBeNull();
  });
});

describe("groupBBox", () => {
  it("returns null for no items", () => {
    expect(groupBBox([])).toBeNull();
  });
  it("bounds the items by pos and size", () => {
    const items = [
      { id: 1, pos: { x: 10, y: 20 }, size: { w: 30, h: 40 }, group: null, kind: { Text: { text: "a", bold: false, size: 16, color: "#000000" } } },
      { id: 2, pos: { x: 50, y: 5 }, size: { w: 10, h: 10 }, group: null, kind: { Text: { text: "b", bold: false, size: 16, color: "#000000" } } },
    ];
    expect(groupBBox(items as never)).toEqual({ x: 10, y: 5, w: 50, h: 55 });
  });
});

describe("fileCardSize", () => {
  it("is 360 wide with the preview height from the artwork's aspect, plus room for the title and sub", () => {
    // A 200x120 artwork: preview (120/200)*336 = 201.6, +70.
    expect(fileCardSize(200, 120)).toEqual({ w: 360, h: 272 });
    // A square artwork: preview 336, +70.
    expect(fileCardSize(100, 100)).toEqual({ w: 360, h: 406 });
  });
  it("caps a very tall artwork's preview at 360", () => {
    expect(fileCardSize(100, 1000)).toEqual({ w: 360, h: 430 });
  });
  it("floors a very wide artwork's preview at 80", () => {
    expect(fileCardSize(1000, 10)).toEqual({ w: 360, h: 150 });
  });
  it("falls back to the video card's size for a missing artwork", () => {
    expect(fileCardSize(0, 0)).toEqual({ w: 360, h: 264 });
    expect(fileCardSize(-5, 100)).toEqual({ w: 360, h: 264 });
  });
});

describe("translateImportedToAnchor", () => {
  const shape = (x: number, y: number, w: number, h: number) => ({
    kind: { Shape: { shape: "rect", fill: "#ff0000" } },
    pos: { x, y },
    size: { w, h },
  });
  it("moves the import so its top-left lands on the anchor", () => {
    const items = [shape(100, 100, 50, 50), shape(200, 150, 20, 20)];
    const moved = translateImportedToAnchor(items as never, { x: 1000, y: 500 });
    expect(moved[0].pos).toEqual({ x: 1000, y: 500 });
    expect(moved[1].pos).toEqual({ x: 1100, y: 550 });
    expect(moved[0].size).toEqual({ w: 50, h: 50 });
  });
  it("moves a stroke's absolute points by the same delta", () => {
    const stroke = {
      kind: { Stroke: { points: [{ x: 100, y: 100 }, { x: 150, y: 120 }], color: "#000000", width: 2, marker: false } },
      pos: { x: 100, y: 100 },
      size: { w: 50, h: 20 },
    };
    const moved = translateImportedToAnchor([stroke] as never, { x: 300, y: 400 });
    expect(moved[0].pos).toEqual({ x: 300, y: 400 });
    const kind = moved[0].kind as { Stroke: { points: Array<{ x: number; y: number }> } };
    expect(kind.Stroke.points).toEqual([{ x: 300, y: 400 }, { x: 350, y: 420 }]);
  });
  it("is a no-op when the import is already at the anchor", () => {
    const items = [shape(100, 100, 50, 50)];
    expect(translateImportedToAnchor(items as never, { x: 100, y: 100 })).toBe(items);
  });
  it("returns an empty import unchanged", () => {
    expect(translateImportedToAnchor([], { x: 0, y: 0 })).toEqual([]);
  });
});
