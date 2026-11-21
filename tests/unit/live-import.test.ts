// Unit tests for the live-import helpers
// (src/backend/live-import.ts): finding the group linked to a
// source file, and translating a fresh import onto the group's
// current position. Pure functions, no DOM.
import { describe, expect, it } from "vitest";
import { base64ToBytes, fileCardHeightForWidth, fileCardSize, findSourceGroup, groupBBox, translateImportedToAnchor, videoCardHeightForWidth, videoCardSize } from "../../src/backend/live-import";
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
      1: { label: "Group 1" },
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
  it.each([
    // [artwork w, h, card w, h] — 360 wide, preview height
    // from the aspect (the preview fills the card), capped
    // at 360, floored at 80.
    [200, 120, 360, 216], // (120/200)*360 = 216
    [100, 100, 360, 360], // square: preview 360, capped
    [100, 1000, 360, 360], // very tall: preview capped at 360
    [1000, 10, 360, 80], // very wide: preview floored at 80
    [600, 400, 360, 240], // 3:2, the welcome previews
    [0, 0, 360, 203], // missing artwork: the video card's size
    [-5, 100, 360, 203],
  ])("fileCardSize(%i, %i) is %ix%i", (w, h, cw, ch) => {
    expect(fileCardSize(w, h)).toEqual({ w: cw, h: ch });
  });
});

describe("fileCardHeightForWidth", () => {
  it("scales the preview with the card width, keeping the ratio", () => {
    // A 3:2 artwork in a 360-wide card is 240 tall; the same
    // artwork in a 480-wide card is 320 tall.
    expect(fileCardHeightForWidth(600, 400, 360)).toBe(240);
    expect(fileCardHeightForWidth(600, 400, 480)).toBe(320);
  });
});

describe("videoCardSize", () => {
  it.each([
    // [video w, h, card w, h] — 360 wide, height from the
    // video's own ratio, capped at 360, floored at 80.
    [384, 288, 360, 270], // 4:3, the welcome video
    [1920, 1080, 360, 203], // 16:9
    [1080, 1920, 360, 360], // portrait: height capped at 360
    [1000, 10, 360, 80], // very wide: floored at 80
    [0, 0, 360, 203], // unknown dimensions: 16:9 fallback
    [-5, 100, 360, 203],
  ])("videoCardSize(%i, %i) is %ix%i", (w, h, cw, ch) => {
    expect(videoCardSize(w, h)).toEqual({ w: cw, h: ch });
  });
});

describe("videoCardHeightForWidth", () => {
  it("scales the video with the card width, keeping the ratio", () => {
    // A 4:3 video in a 360-wide card is 270 tall; the same
    // video in a 480-wide card is 360 tall.
    expect(videoCardHeightForWidth(384, 288, 360)).toBe(270);
    expect(videoCardHeightForWidth(384, 288, 480)).toBe(360);
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
    // Deep equality, not identity: the function may return
    // a fresh array holding the same items.
    expect(translateImportedToAnchor(items as never, { x: 100, y: 100 })).toEqual(items);
    expect(translateImportedToAnchor([], { x: 0, y: 0 })).toEqual([]);
  });
});
