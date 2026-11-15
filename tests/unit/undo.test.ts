// Unit tests for the undo store (src/backend/undo.ts): snapshots,
// no-op saves and refused saves. The store touches window at
// import time (api = window.bowerbird) and document for the undo
// buttons (guarded), so the bridge is stubbed and the module is
// imported fresh per test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../../src/backend/model";

function emptyBoard(): Board {
  return {
    items: [],
    camera: { x: 0, y: 0, zoom: 1 },
    next_id: 1,
    next_group: 0,
    bg: "#FFFFFF",
    grid: "Dots",
  };
}

function textItem(id: number, text: string) {
  return {
    id,
    pos: { x: 0, y: 0 },
    size: { w: 320, h: 80 },
    group: null,
    kind: { Text: { text, bold: false, size: 16, color: "#1A1A1A" } },
  };
}

describe("createUndoStore", () => {
  let board: Board;
  let selected: number[];
  let saveBoard: ReturnType<typeof vi.fn>;
  let ctx: {
    getBoard: () => Board;
    getSelected: () => number[];
    setSelected: (ids: number[]) => void;
    clearEditing: () => void;
    bumpSearchVersion: () => void;
    requestRender: () => void;
    refreshSettings: () => void;
    toast: (msg: string) => void;
  };
  let store: import("../../src/backend/undo").UndoStore;

  beforeEach(async () => {
    vi.resetModules();
    board = emptyBoard();
    selected = [];
    saveBoard = vi.fn(async () => true);
    vi.stubGlobal("window", { bowerbird: { saveBoard } });
    ctx = {
      getBoard: () => board,
      getSelected: () => selected,
      setSelected: (ids: number[]) => {
        selected = ids;
      },
      clearEditing: vi.fn(),
      bumpSearchVersion: vi.fn(),
      requestRender: vi.fn(),
      refreshSettings: vi.fn(),
      toast: vi.fn(),
    };
    const mod = await import("../../src/backend/undo");
    store = mod.createUndoStore(ctx);
  });

  it("undoes and redoes a change in one step each", () => {
    store.save();
    expect(store.canUndo()).toBe(false);
    board.items.push(textItem(1, "hello"));
    board.next_id = 2;
    store.save();
    expect(store.canUndo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(board.items).toHaveLength(0);
    expect(store.canRedo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(board.items).toHaveLength(1);
    expect((board.items[0].kind as { Text: { text: string } }).Text.text).toBe("hello");
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
  });

  it("a no-op save writes nothing and creates no undo step", () => {
    store.save();
    expect(saveBoard).toHaveBeenCalledTimes(1);
    expect(store.canUndo()).toBe(false);
    store.save();
    store.save();
    expect(saveBoard).toHaveBeenCalledTimes(1);
    expect(store.canUndo()).toBe(false);
  });

  it("a refused save retries on the next save instead of skipping", async () => {
    saveBoard.mockResolvedValueOnce(false);
    store.save();
    expect(saveBoard).toHaveBeenCalledTimes(1);
    // The refusal lands asynchronously; wait for it.
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.toast).toHaveBeenCalledWith("Save failed: save was refused");
    // Nothing changed since, but the seen keys were cleared,
    // so this save must attempt the write again.
    store.save();
    expect(saveBoard).toHaveBeenCalledTimes(2);
  });

  it("saveWithoutUndo saves the change but creates no undo step", () => {
    store.save();
    board.items.push(textItem(1, "hello"));
    board.next_id = 2;
    store.saveWithoutUndo();
    expect(saveBoard).toHaveBeenCalledTimes(2);
    expect(store.canUndo()).toBe(false);
  });
});
