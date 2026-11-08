// Undo and saving: snapshots, not operations. Every save()
// compares the board content with the last saved content, and
// if it changed, the previous content becomes one undo step.
// That covers every mutation without hunting for it: core
// drags, text commits, drops, plugin actions, Settings canvas
// changes and delete-all all save, so all are undoable.
// The module also owns the change detection that makes a
// no-op save free: one serialisation of the items, shared by
// the undo key, the undo snapshot and the change check, and
// no disk write, no search re-index and no board event when
// neither content nor camera changed. A failed write clears
// the seen keys so the next save retries instead of skipping.
import { api } from "./api";
import { boardGet, type Board, type Item } from "./model";
import { emitPluginEvent } from "./plugins";

export interface UndoState {
  items: Item[];
  next_id: number;
  next_group: number;
  bg: string;
  grid: Board["grid"];
  selected: number[];
}

export interface UndoContext {
  getBoard(): Board;
  getSelected(): number[];
  setSelected(ids: number[]): void;
  clearEditing(): void;
  bumpSearchVersion(): void;
  requestRender(): void;
  refreshSettings(): void;
  toast(msg: string): void;
}

export interface UndoStore {
  save(): { itemsJson: string; contentKey: string };
  saveWithoutUndo(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  resetUndo(): void;
  stashUndoForBoard(dir: string): void;
  restoreUndoForBoard(dir: string, preserve: boolean): void;
}

export function createUndoStore(ctx: UndoContext): UndoStore {
  // What save() last saw, so a save that changed nothing
  // costs no disk write and no search re-index. These are
  // deliberately separate from lastSnapshotKey (the undo
  // stack's key): undo() and redo() set lastSnapshot to the
  // restored content without touching these, so an undo
  // still counts as a change here and still writes to disk.
  let lastSeenContentKey: string | null = null;
  let lastSeenCameraJson: string | null = null;
  // The content key for the current board, built from one
  // serialisation of the items: identical to contentKey()
  // of a snapshot (same fields, same order), without
  // stringifying the items a second time.
  function contentKeyFor(itemsJson: string): string {
    return `{"items":${itemsJson},"next_id":${ctx.getBoard().next_id},"next_group":${ctx.getBoard().next_group},"bg":${JSON.stringify(ctx.getBoard().bg)},"grid":${JSON.stringify(ctx.getBoard().grid)}}`;
  }
  function save(): { itemsJson: string; contentKey: string } {
    // One serialisation of the items, shared by the undo
    // key, the undo snapshot and the change check below.
    // The old save() serialised the board three times
    // (snapshot, key, payload) and saveWithoutUndo added
    // a fourth stringify plus a second deep copy.
    const itemsJson = JSON.stringify(ctx.getBoard().items);
    const contentKey = contentKeyFor(itemsJson);
    const cameraJson = JSON.stringify(ctx.getBoard().camera);
    const contentChanged = contentKey !== lastSeenContentKey;
    const cameraChanged = cameraJson !== lastSeenCameraJson;
    // Nothing changed since the last save: a plain click
    // on an already-top card, a pan back to the same view,
    // a save() call with no mutation behind it. No disk
    // write, no search re-index, no board event — the file
    // on disk already holds exactly this board.
    if (!contentChanged && !cameraChanged) return { itemsJson, contentKey };
    if (contentChanged) {
      lastSeenContentKey = contentKey;
      // Search only re-indexes when the searchable content
      // actually changed: camera-only saves and no-op
      // saves used to invalidate the whole index.
      ctx.bumpSearchVersion();
      captureUndoStep(itemsJson, contentKey);
    }
    if (cameraChanged) lastSeenCameraJson = cameraJson;
    // The board event fires so plugins refresh from it
    // (library, slides, board list, tidy counts). A
    // camera-only save does not emit: no plugin refreshes
    // from a camera move, and emitting would make every
    // pan pay a full-board copy in each listening plugin.
    if (contentChanged) emitPluginEvent("board");
    api.saveBoard(JSON.stringify(ctx.getBoard())).catch((e) => {
      // A failed write must not be remembered as saved:
      // clear the seen keys so the next save retries
      // instead of skipping on "nothing changed".
      lastSeenContentKey = null;
      lastSeenCameraJson = null;
      ctx.toast(`Save failed: ${String(e)}`);
    });
    return { itemsJson, contentKey };
  }

  // ---------------------------------------------------------------- undo / redo
  //
  // Undo is snapshots, not operations. Every save() compares the
  // board content with the last saved content, and if it changed,
  // the previous content becomes one undo step. That covers every
  // mutation without hunting for it: core drags, text commits,
  // drops, plugin actions, Settings canvas changes and delete-all
  // all save, so all are undoable, including plugin actions, which
  // is why PLUGIN_API.md no longer says plugin actions have no undo.
  //
  // What a snapshot holds, and what it does not:
  // - Items, next_id, next_group, bg and grid: restored on undo.
  // - Camera: not stored, so panning and zooming never create an
  //   undo step, and undoing never jumps the view.
  // - Selection at the time of the change: restored, so undoing a
  //   delete re-selects the restored cards.
  // - One save is one step, however many items it changed: a drag
  //   that moved five cards, or a drop that added three files, is
  //   one Ctrl+Z, because those saves happen once, at mouseup.
  // - Background link-preview fills save without undo (see
  //   saveWithoutUndo), or adding one link would take two undos:
  //   one to un-fill its preview, one to remove the card.
  // - Clicking a card brings it to the front, and the move drag's
  //   mouseup saves even when nothing moved, but through
  //   saveWithoutUndo, so that stacking change never becomes
  //   an undo step on its own.
  // - 50 steps, oldest dropped. Items are paths, not image bytes,
  //   so a snapshot is board JSON, not media.
  const UNDO_LIMIT = 50;
  let undoStack: UndoState[] = [];
  let redoStack: UndoState[] = [];
  let lastSnapshot: UndoState | null = null;
  // The content key of lastSnapshot, cached alongside it:
  // recomputing it on every capture used to re-stringify the
  // whole board a second time per save, for a snapshot that
  // had not changed since the last capture.
  let lastSnapshotKey: string | null = null;
  function setLastSnapshot(s: UndoState): void {
    lastSnapshot = s;
    lastSnapshotKey = contentKey(s);
  }
  let suppressUndoCapture = false;

  function contentSnapshot(): UndoState {
    return {
      items: JSON.parse(JSON.stringify(ctx.getBoard().items)) as Item[],
      next_id: ctx.getBoard().next_id,
      next_group: ctx.getBoard().next_group,
      bg: ctx.getBoard().bg,
      grid: ctx.getBoard().grid,
      selected: [...ctx.getSelected()],
    };
  }

  function contentKey(s: UndoState): string {
    // Selection is restored by undo, but a selection change alone
    // is not a board change, so it is not part of the key.
    return JSON.stringify({ items: s.items, next_id: s.next_id, next_group: s.next_group, bg: s.bg, grid: s.grid });
  }

  function updateUndoButtons(): void {
    const undoBtn = document.getElementById("btn-undo") as HTMLButtonElement | null;
    const redoBtn = document.getElementById("btn-redo") as HTMLButtonElement | null;
    if (undoBtn) undoBtn.classList.toggle("dim", undoStack.length === 0);
    if (redoBtn) redoBtn.classList.toggle("dim", redoStack.length === 0);
  }

  function captureUndoStep(itemsJson?: string, key?: string): void {
    if (suppressUndoCapture) return;
    // Reuse save()'s serialisation when it is offered:
    // otherwise a save paid for a deep copy and a key
    // stringify here on top of the one in save().
    const curKey = key ?? contentKeyFor(itemsJson ?? JSON.stringify(ctx.getBoard().items));
    if (lastSnapshot !== null && lastSnapshotKey === curKey) return;
    const cur: UndoState = itemsJson !== undefined
      ? { items: JSON.parse(itemsJson) as Item[], next_id: ctx.getBoard().next_id, next_group: ctx.getBoard().next_group, bg: ctx.getBoard().bg, grid: ctx.getBoard().grid, selected: [...ctx.getSelected()] }
      : contentSnapshot();
    if (lastSnapshot !== null) {
      undoStack.push(lastSnapshot);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      // A new change after an undo discards the redo chain, as in
      // every editor: redo only redoes the change just undone.
      redoStack = [];
    }
    lastSnapshot = cur;
    lastSnapshotKey = curKey;
    updateUndoButtons();
  }

  function saveWithoutUndo(): void {
    // No search bump here: save() bumps only when the
    // content actually changed. This used to bump on every
    // call — including camera-only pans — and then save()
    // bumped again.
    // For changes that should save but not become an undo step:
    // background changes the user did not make, like a link
    // preview filling in, and a click's stacking change. The
    // file still saves, but no undo step is created, and
    // lastSnapshot moves to the new content, so the next user
    // change is still one step from here.
    suppressUndoCapture = true;
    let ser: { itemsJson: string; contentKey: string };
    try {
      ser = save();
    } finally {
      suppressUndoCapture = false;
    }
    // Move lastSnapshot to the new content, reusing save()'s
    // serialisation instead of snapshotting the board again.
    if (ser.contentKey !== lastSnapshotKey) {
      lastSnapshot = { items: JSON.parse(ser.itemsJson) as Item[], next_id: ctx.getBoard().next_id, next_group: ctx.getBoard().next_group, bg: ctx.getBoard().bg, grid: ctx.getBoard().grid, selected: [...ctx.getSelected()] };
      lastSnapshotKey = ser.contentKey;
    }
    updateUndoButtons();
  }

  function restoreUndoState(s: UndoState): void {
    ctx.getBoard().items = JSON.parse(JSON.stringify(s.items)) as Item[];
    ctx.getBoard().next_id = s.next_id;
    ctx.getBoard().next_group = s.next_group;
    ctx.getBoard().bg = s.bg;
    ctx.getBoard().grid = s.grid;
    ctx.setSelected(s.selected.filter((id) => boardGet(ctx.getBoard(), id) !== undefined));
    ctx.clearEditing();
  }

  function undo(): boolean {
    if (undoStack.length === 0) return false;
    redoStack.push(contentSnapshot());
    const prev = undoStack.pop() as UndoState;
    restoreUndoState(prev);
    // Set lastSnapshot before save, so save's capture sees the
    // restored content as already known and does not push a step
    // or clear the redo chain we just built.
    setLastSnapshot(contentSnapshot());
    save(); ctx.requestRender();
    ctx.refreshSettings();
    updateUndoButtons();
    return true;
  }

  function redo(): boolean {
    if (redoStack.length === 0) return false;
    undoStack.push(contentSnapshot());
    const next = redoStack.pop() as UndoState;
    restoreUndoState(next);
    setLastSnapshot(contentSnapshot());
    save(); ctx.requestRender();
    ctx.refreshSettings();
    updateUndoButtons();
    return true;
  }

  function resetUndo(): void {
    undoStack = [];
    redoStack = [];
    setLastSnapshot(contentSnapshot());
    updateUndoButtons();
  }
  // Undo is per board, not per app: each board keeps its own
  // stack in this map, keyed by its folder, so creating a new
  // board, or switching away and back, never wipes another
  // board's history. Undo is in-session only — nothing here
  // is written to disk, so a fresh app start still starts
  // with an empty stack for every board.
  const undoByBoard = new Map<string, { undo: UndoState[]; redo: UndoState[]; last: UndoState | null }>();
  function restoreUndoForBoard(dir: string, preserve: boolean): void {
    if (preserve) {
      // Same board, reloaded (a backup restore, or a rename
      // followed by a switch to the new name): the stack
      // stays, so undo can step back to before the reload,
      // but the redo chain is for the old content, so it goes.
      redoStack = [];
      setLastSnapshot(contentSnapshot());
      updateUndoButtons();
      return;
    }
    const saved = undoByBoard.get(dir);
    if (saved) {
      undoStack = saved.undo;
      redoStack = saved.redo;
      if (saved.last) setLastSnapshot(saved.last);
      else setLastSnapshot(contentSnapshot());
    } else {
      undoStack = [];
      redoStack = [];
      setLastSnapshot(contentSnapshot());
    }
    updateUndoButtons();
  }

  // File the current board's stack away before a switch,
  // so switching back restores its history. 50 snapshots
  // per board, unbounded across boards, is 250 full-board
  // copies for 5 boards: keep at most 3 filed boards and
  // evict the oldest (never the board being loaded).
  function stashUndoForBoard(dir: string): void {
    undoByBoard.set(dir, { undo: undoStack, redo: redoStack, last: lastSnapshot });
    while (undoByBoard.size > 3) {
      const first = undoByBoard.keys().next().value as string | undefined;
      if (first === undefined || first === dir) break;
      undoByBoard.delete(first);
    }
  }

  function canUndo(): boolean {
    return undoStack.length > 0;
  }

  function canRedo(): boolean {
    return redoStack.length > 0;
  }

  return {
    save,
    saveWithoutUndo,
    undo,
    redo,
    canUndo,
    canRedo,
    resetUndo,
    stashUndoForBoard,
    restoreUndoForBoard,
  };
}
