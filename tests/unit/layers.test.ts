// Unit tests for the layer model and the per-board plugin
// store (src/backend/model.ts): layer defaults on load,
// hide/lock semantics, layer ordering, and the extensions
// namespace rule. Pure functions, no DOM, no Electron.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYER_ID,
  createLayer,
  deleteLayer,
  getBoardExtension,
  healLayers,
  hitTest,
  isItemLocked,
  isItemVisible,
  itemLayerId,
  lassoSelect,
  layerById,
  marquee,
  moveLayer,
  moveSelection,
  nextLayerId,
  removeBoardExtension,
  renameLayer,
  resizeItem,
  setBoardExtension,
  setItemLayer,
  setLayerLocked,
  setLayerVisible,
  sortItemsByLayer,
  strokesWithin,
  type Board,
  type Item,
} from "../../src/backend/model";

function textCard(id: number, x: number, y: number, layer?: string): Item {
  return {
    id, pos: { x, y }, size: { w: 260, h: 48 }, group: null,
    ...(layer !== undefined ? { layer } : {}),
    kind: { Text: { text: `Note ${id}`, bold: false, size: 16, color: "#1A1A1A" } },
  };
}

function strokeCard(id: number, x: number, y: number, layer?: string): Item {
  return {
    id, pos: { x, y }, size: { w: 100, h: 20 }, group: null,
    ...(layer !== undefined ? { layer } : {}),
    kind: { Stroke: { points: [{ x, y }, { x: x + 100, y }], color: "#1A1A1A", width: 3, marker: false } },
  };
}

function boardWith(items: Item[], layers?: Board["layers"], extensions?: Board["extensions"]): Board {
  return {
    items,
    camera: { x: 0, y: 0, zoom: 1 },
    next_id: items.length + 1,
    next_group: 0,
    ...(layers !== undefined ? { layers } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
    bg: "#FFFFFF",
    grid: "Dots",
  };
}

describe("healLayers", () => {
  it("gives an old board (no layers, no extensions) a default layer and empty extensions", () => {
    const board = boardWith([textCard(1, 0, 0), textCard(2, 300, 0)]);
    healLayers(board);
    expect(board.layers).toEqual([{ id: "default", name: "Default", visible: true, locked: false }]);
    expect(board.extensions).toEqual({});
    expect(board.items.map((it) => it.layer)).toEqual(["default", "default"]);
  });

  it("keeps existing layers and items, and moves an item off an unknown layer to the default", () => {
    const board = boardWith(
      [textCard(1, 0, 0, "layer-1"), textCard(2, 300, 0, "ghost"), textCard(3, 600, 0)],
      [{ id: "default", name: "Default", visible: true, locked: false }, { id: "layer-1", name: "Ink", visible: true, locked: false }],
      { "some-plugin": { frames: 3 } },
    );
    healLayers(board);
    expect(board.layers?.map((l) => l.id)).toEqual(["default", "layer-1"]);
    expect(board.items.map((it) => it.layer)).toEqual(["layer-1", "default", "default"]);
    expect(board.extensions).toEqual({ "some-plugin": { frames: 3 } });
  });

  it("drops duplicate layer ids and inserts a missing default layer first", () => {
    const board = boardWith([], [
      { id: "layer-1", name: "Ink", visible: true, locked: false },
      { id: "layer-1", name: "Ink again", visible: false, locked: true },
    ]);
    healLayers(board);
    expect(board.layers?.map((l) => l.id)).toEqual(["default", "layer-1"]);
    expect(board.layers?.[1].visible).toBe(true);
  });

  it("replaces a non-object extensions value with an empty object", () => {
    const board = boardWith([], undefined, "not-an-object" as unknown as Record<string, unknown>);
    healLayers(board);
    expect(board.extensions).toEqual({});
  });
});

describe("layer defaults without a heal", () => {
  it("an item with no layer reads as the default layer, visible and unlocked", () => {
    const board = boardWith([textCard(1, 0, 0)]);
    expect(itemLayerId(board.items[0])).toBe(DEFAULT_LAYER_ID);
    expect(isItemVisible(board, board.items[0])).toBe(true);
    expect(isItemLocked(board, board.items[0])).toBe(false);
  });
});

describe("layer operations", () => {
  it("creates layers with fresh ids, in order, on top", () => {
    const board = boardWith([]);
    healLayers(board);
    const a = createLayer(board, "Ink");
    const b = createLayer(board);
    expect(a).toEqual({ id: "layer-1", name: "Ink", visible: true, locked: false });
    expect(b.id).toBe("layer-2");
    expect(b.name).toBe("Layer 3");
    expect(nextLayerId(board)).toBe("layer-3");
    expect(board.layers?.map((l) => l.id)).toEqual(["default", "layer-1", "layer-2"]);
  });

  it("renames, reorders, hides and locks a layer, and refuses bad ids and empty names", () => {
    const board = boardWith([]);
    healLayers(board);
    const layer = createLayer(board, "Ink");
    expect(renameLayer(board, layer.id, "  ")).toBe(false);
    expect(renameLayer(board, layer.id, "Pencil")).toBe(true);
    expect(layerById(board, layer.id)?.name).toBe("Pencil");
    expect(renameLayer(board, "ghost", "Nope")).toBe(false);
    expect(moveLayer(board, layer.id, 0)).toBe(true);
    expect(board.layers?.map((l) => l.id)).toEqual(["layer-1", "default"]);
    expect(moveLayer(board, "ghost", 0)).toBe(false);
    expect(setLayerVisible(board, layer.id, false)).toBe(true);
    expect(layerById(board, layer.id)?.visible).toBe(false);
    expect(setLayerLocked(board, layer.id, true)).toBe(true);
    expect(layerById(board, layer.id)?.locked).toBe(true);
    expect(setLayerVisible(board, "ghost", false)).toBe(false);
  });

  it("deleting a layer moves its items to the default, and the default cannot be deleted", () => {
    const board = boardWith(
      [textCard(1, 0, 0, "layer-1"), textCard(2, 300, 0, "layer-1"), textCard(3, 600, 0)],
      [{ id: "default", name: "Default", visible: true, locked: false }, { id: "layer-1", name: "Ink", visible: true, locked: false }],
    );
    healLayers(board);
    expect(deleteLayer(board, "default")).toBe(false);
    expect(deleteLayer(board, "ghost")).toBe(false);
    expect(deleteLayer(board, "layer-1")).toBe(true);
    expect(board.layers?.map((l) => l.id)).toEqual(["default"]);
    expect(board.items.map((it) => it.layer)).toEqual(["default", "default", "default"]);
  });

  it("setItemLayer moves an item and refuses an unknown layer or item", () => {
    const board = boardWith([textCard(1, 0, 0)]);
    healLayers(board);
    createLayer(board, "Ink");
    expect(setItemLayer(board, 1, "layer-1")).toBe(true);
    expect(board.items[0].layer).toBe("layer-1");
    expect(setItemLayer(board, 1, "ghost")).toBe(false);
    expect(setItemLayer(board, 99, "layer-1")).toBe(false);
    expect(board.items[0].layer).toBe("layer-1");
  });

  it("sortItemsByLayer paints layers bottom-to-top and keeps board order within a layer", () => {
    const board = boardWith(
      [
        textCard(1, 0, 0, "layer-1"),
        textCard(2, 300, 0, "default"),
        textCard(3, 600, 0, "layer-1"),
        textCard(4, 900, 0, "default"),
      ],
      [{ id: "default", name: "Default", visible: true, locked: false }, { id: "layer-1", name: "Ink", visible: true, locked: false }],
    );
    healLayers(board);
    expect(sortItemsByLayer(board, board.items).map((it) => it.id)).toEqual([2, 4, 1, 3]);
    // Reordering the layers reorders the paint.
    moveLayer(board, "layer-1", 0);
    expect(sortItemsByLayer(board, board.items).map((it) => it.id)).toEqual([1, 3, 2, 4]);
  });
});

describe("hidden layers", () => {
  it("a hidden layer's items are not hit, marqueed, lassoed or erased", () => {
    const board = boardWith(
      [textCard(1, 0, 0, "layer-1"), textCard(2, 300, 0), strokeCard(3, 0, 100, "layer-1")],
      [{ id: "default", name: "Default", visible: true, locked: false }, { id: "layer-1", name: "Ink", visible: true, locked: false }],
    );
    healLayers(board);
    setLayerVisible(board, "layer-1", false);
    expect(isItemVisible(board, board.items[0])).toBe(false);
    expect(hitTest(board, { x: 10, y: 10 })).toBeNull();
    expect(hitTest(board, { x: 310, y: 10 })).toBe(2);
    expect(marquee(board, { x: -10, y: -10 }, { x: 1000, y: 1000 })).toEqual([2]);
    expect(lassoSelect(board, [{ x: -10, y: -10 }, { x: 1000, y: -10 }, { x: 1000, y: 1000 }, { x: -10, y: 1000 }])).toEqual([2]);
    expect(strokesWithin(board, { x: 50, y: 100 }, 10)).toEqual([]);
  });

  it("showing the layer again makes its items hittable", () => {
    const board = boardWith(
      [textCard(1, 0, 0, "layer-1")],
      [{ id: "default", name: "Default", visible: true, locked: false }, { id: "layer-1", name: "Ink", visible: true, locked: false }],
    );
    healLayers(board);
    setLayerVisible(board, "layer-1", false);
    expect(hitTest(board, { x: 10, y: 10 })).toBeNull();
    setLayerVisible(board, "layer-1", true);
    expect(hitTest(board, { x: 10, y: 10 })).toBe(1);
  });
});

describe("locked layers", () => {
  it("a locked layer's items do not move or resize", () => {
    const board = boardWith(
      [textCard(1, 0, 0, "layer-1"), textCard(2, 300, 0)],
      [{ id: "default", name: "Default", visible: true, locked: false }, { id: "layer-1", name: "Ink", visible: true, locked: false }],
    );
    healLayers(board);
    setLayerLocked(board, "layer-1", true);
    expect(isItemLocked(board, board.items[0])).toBe(true);
    moveSelection(board, [1, 2], 50, 25);
    expect(board.items[0].pos).toEqual({ x: 0, y: 0 });
    expect(board.items[1].pos).toEqual({ x: 350, y: 25 });
    resizeItem(board, 1, 500, 200);
    expect(board.items[0].size).toEqual({ w: 260, h: 48 });
    resizeItem(board, 2, 500, 200);
    expect(board.items[1].size).toEqual({ w: 500, h: 200 });
  });

  it("unlocking lets the items move again", () => {
    const board = boardWith(
      [textCard(1, 0, 0, "layer-1")],
      [{ id: "default", name: "Default", visible: true, locked: false }, { id: "layer-1", name: "Ink", visible: true, locked: false }],
    );
    healLayers(board);
    setLayerLocked(board, "layer-1", true);
    moveSelection(board, [1], 50, 0);
    expect(board.items[0].pos).toEqual({ x: 0, y: 0 });
    setLayerLocked(board, "layer-1", false);
    moveSelection(board, [1], 50, 0);
    expect(board.items[0].pos).toEqual({ x: 50, y: 0 });
  });
});

describe("per-board plugin extensions", () => {
  it("a plugin reads and writes only its own namespace", () => {
    const board = boardWith([]);
    healLayers(board);
    setBoardExtension(board, "anim", { frames: 3, fps: 12 });
    expect(getBoardExtension(board, "anim")).toEqual({ frames: 3, fps: 12 });
    // Another plugin's namespace is empty, and writing it
    // leaves the first plugin's data untouched.
    expect(getBoardExtension(board, "draw")).toBeUndefined();
    setBoardExtension(board, "draw", { brush: "pencil" });
    expect(getBoardExtension(board, "anim")).toEqual({ frames: 3, fps: 12 });
    expect(getBoardExtension(board, "draw")).toEqual({ brush: "pencil" });
    expect(board.extensions).toEqual({ anim: { frames: 3, fps: 12 }, draw: { brush: "pencil" } });
  });

  it("stores a copy, so later mutation of the caller's object does not corrupt the board", () => {
    const board = boardWith([]);
    const data = { frames: [1, 2] };
    setBoardExtension(board, "anim", data);
    data.frames.push(3);
    expect(getBoardExtension(board, "anim")).toEqual({ frames: [1, 2] });
    const read = getBoardExtension(board, "anim") as { frames: number[] };
    read.frames.push(4);
    expect(getBoardExtension(board, "anim")).toEqual({ frames: [1, 2] });
  });

  it("rejects data that is not JSON, and removes only the named namespace", () => {
    const board = boardWith([]);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => setBoardExtension(board, "anim", circular)).toThrow("must be JSON");
    expect(() => setBoardExtension(board, "anim", undefined)).toThrow("must be JSON");
    expect(board.extensions).toEqual(undefined);
    setBoardExtension(board, "anim", { a: 1 });
    setBoardExtension(board, "draw", { b: 2 });
    expect(removeBoardExtension(board, "ghost")).toBe(false);
    expect(removeBoardExtension(board, "anim")).toBe(true);
    expect(board.extensions).toEqual({ draw: { b: 2 } });
  });
});
