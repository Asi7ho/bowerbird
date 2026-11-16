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
  let saveBoardSync: ReturnType<typeof vi.fn>;
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
    saveBoardSync = vi.fn(() => true);
    vi.stubGlobal("window", {
      bowerbird: {
        saveBoard,
        saveBoardSync,
        recoveryWriteSync: vi.fn(() => true),
        recoveryClear: vi.fn(async () => true),
      },
    });
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

  it("journals the board synchronously before the save, and clears it once the save lands", async () => {
    const bridge = (window as unknown as { bowerbird: { recoveryWriteSync: ReturnType<typeof vi.fn>; recoveryClear: ReturnType<typeof vi.fn> } }).bowerbird;
    board.items.push(textItem(1, "hello"));
    board.next_id = 2;
    store.save();
    // Synchronous: the journal is on disk before save() returns.
    expect(bridge.recoveryWriteSync).toHaveBeenCalledTimes(1);
    expect(bridge.recoveryWriteSync).toHaveBeenCalledWith(JSON.stringify(board));
    expect(saveBoard).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.recoveryClear).toHaveBeenCalledTimes(1);
    expect(bridge.recoveryClear).toHaveBeenCalledWith(JSON.stringify(board));
  });

  it("keeps the journal when the save is refused", async () => {
    const bridge = (window as unknown as { bowerbird: { recoveryWriteSync: ReturnType<typeof vi.fn>; recoveryClear: ReturnType<typeof vi.fn> } }).bowerbird;
    saveBoard.mockResolvedValueOnce(false);
    board.items.push(textItem(1, "hello"));
    board.next_id = 2;
    store.save();
    expect(bridge.recoveryWriteSync).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.recoveryClear).not.toHaveBeenCalled();
  });

  it("saveSync writes a board that changed since the last save", () => {
    store.save();
    board.items.push(textItem(1, "hello"));
    board.next_id = 2;
    expect(store.saveSync()).toBe(true);
    expect(saveBoardSync).toHaveBeenCalledTimes(1);
    expect(saveBoardSync).toHaveBeenCalledWith(JSON.stringify(board));
  });

  it("saveSync does not write a board that did not change", async () => {
    // The restore case: after a backup restore the disk board
    // is the snapshot while memory still holds the board it
    // replaced — memory equals the last saved state, so the
    // unload flush must not write the stale board back.
    // Let the async save from save() land first: while it is
    // in flight the flush writes (see the test above), so the
    // no-write assertion only holds once it has settled.
    store.save();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.saveSync()).toBe(false);
    expect(saveBoardSync).not.toHaveBeenCalled();
  });

  it("saveSync writes while an async save is still in flight", async () => {
    // A close during an in-flight async save: save() marked
    // the change as seen at dispatch, but the write has not
    // landed, so the flush must write it synchronously
    // instead of trusting the seen keys — otherwise the
    // board on disk keeps the old camera and the change
    // survives only in the journal.
    let resolveSave!: (v: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolveSave = resolve; });
    saveBoard.mockReturnValueOnce(pending);
    board.items.push(textItem(1, "hello"));
    board.next_id = 2;
    store.save();
    expect(store.saveSync()).toBe(true);
    expect(saveBoardSync).toHaveBeenCalledTimes(1);
    expect(saveBoardSync).toHaveBeenCalledWith(JSON.stringify(board));
    // Once the async save lands, the flush has nothing to do.
    resolveSave(true);
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    expect(store.saveSync()).toBe(false);
    expect(saveBoardSync).toHaveBeenCalledTimes(1);
  });

  it("saveSync writes a camera-only change", () => {
    store.save();
    board.camera = { x: 10, y: 20, zoom: 1.5 };
    expect(store.saveSync()).toBe(true);
    expect(saveBoardSync).toHaveBeenCalledTimes(1);
    expect(saveBoardSync).toHaveBeenCalledWith(JSON.stringify(board));
  });

  it("saveSync does not throw when the bridge has no saveBoardSync", () => {
    const bridge = (window as unknown as { bowerbird: Record<string, unknown> }).bowerbird;
    delete bridge.saveBoardSync;
    board.items.push(textItem(1, "hello"));
    board.next_id = 2;
    expect(store.saveSync()).toBe(false);
  });

  it("a board loaded from disk becomes the save baseline", async () => {
    store.save();
    // An external change arrives by load (watcher reload,
    // restore): the board is replaced without a save.
    board.items.push(textItem(1, "hello"));
    board.next_id = 2;
    store.restoreUndoForBoard("/tmp/board", true);
    // The loaded board is the baseline now: neither the
    // async save nor the unload flush rewrites it, so a
    // restore is never undone by a later save or reload.
    // Let the first async save land first (see above).
    store.save();
    expect(saveBoard).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.saveSync()).toBe(false);
    expect(saveBoardSync).not.toHaveBeenCalled();
  });
});
