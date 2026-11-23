// Undo and saving: snapshots, not operations. Every save()
// compares content with the last saved content; a change makes
// the previous content one undo step. That covers every
// mutation without hunting for it.

import { api } from "./api";
import { boardGet, type Board, type GroupEntry, type Item, type Layer } from "./model";
import { emitPluginEvent } from "../plugins/host";

interface UndoState {
  items: Item[];
  next_id: number;
  next_group: number;
  groups: Record<number, GroupEntry>;
  // Layers and per-board plugin data: a layer change or an
  // extension write is a board change like any other, so it
  // is snapshotted, keyed and restored with the rest.
  layers: Layer[];
  extensions: Record<string, unknown>;
  bg: string;
  grid: Board["grid"];
  selected: number[];
}

interface UndoContext {
  getBoard(): Board;
  getSelected(): number[];
  setSelected(ids: number[]): void;
  clearEditing(): void;
  bumpSearchVersion(): void;
  requestRender(): void;
  refreshSettings(): void;
  toast(msg: string): void;
  // Called when a save is refused by the live-follow guard
  // (the board changed on disk): the renderer reloads the
  // disk board, with the refused edits preserved in the
  // recovery journal. Optional — unit tests omit it.
  onSaveRefused?(): void;
}

export interface UndoStore {
  save(): { itemsJson: string; contentKey: string };
  saveWithoutUndo(): void;
  // Synchronous flush for unload: write the board to disk
  // only if it changed since the last save. Returns whether
  // it wrote. A board that did not change — including a
  // board restored on disk but not yet reloaded in memory —
  // is not written, so the unload flush can never overwrite
  // a restore with the stale board it replaced.
  saveSync(): boolean;
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
  // Async saves in flight: save() marks a change as seen
  // when it dispatches the write, but the write lands
  // later. While a write is in flight the flush (saveSync)
  // must not trust the seen keys — a close during the
  // flight would otherwise skip the write and leave
  // board.json stale, with only the journal holding the
  // change. A count, not a flag: two saves can dispatch
  // before the first lands.
  let savesInFlight = 0;
  // The content key for the current board, built from one
  // serialisation of the items: identical to contentKey()
  // of a snapshot (same fields, same order), without
  // stringifying the items a second time.
  function contentKeyFor(itemsJson: string): string {
    return `{"items":${itemsJson},"next_id":${ctx.getBoard().next_id},"next_group":${ctx.getBoard().next_group},"groups":${JSON.stringify(ctx.getBoard().groups ?? {})},"layers":${JSON.stringify(ctx.getBoard().layers ?? [])},"extensions":${JSON.stringify(ctx.getBoard().extensions ?? {})},"bg":${JSON.stringify(ctx.getBoard().bg)},"grid":${JSON.stringify(ctx.getBoard().grid)}}`;
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
    // The write is async: "saving" first (content writes
    // only — a camera-only write is not a change worth
    // announcing), "saved" when the file holds the board.
    if (contentChanged) emitPluginEvent("saving");
    const onSaveFailed = (e: unknown) => {
      // A failed write must not be remembered as saved:
      // clear the seen keys so the next save retries
      // instead of skipping on "nothing changed".
      lastSeenContentKey = null;
      lastSeenCameraJson = null;
      emitPluginEvent("save-failed");
      ctx.toast(`Save failed: ${String(e)}`);
    };
    const boardJson = JSON.stringify(ctx.getBoard());
    // The recovery journal is written synchronously before
    // the save itself, so a kill between the two still leaves
    // the edit on disk: the journal is the write-ahead copy
    // of exactly this save. A journal that cannot be written
    // (or a bridge without one, in tests) must never break
    // the save it precedes.
    try {
      api.recoveryWriteSync(boardJson);
    } catch { /* the save below still proceeds */ }
    savesInFlight++;
    api.saveBoard(boardJson).then(
      (ok) => {
        // A refused save — an external writer changed the file,
        // or the board is absurdly large — is a failure too:
        // without this the title bar says "Saved" for a board
        // that never reached disk.
        if (ok === false) {
          onSaveFailed("save was refused");
          // The disk board wins: reload it, with the refused
          // edits preserved in the recovery journal (the
          // journal was written before this save, so the
          // reload cannot lose them).
          ctx.onSaveRefused?.();
        } else {
          emitPluginEvent("saved");
          // The save landed: clear the journal, but only if
          // it still holds this board — a later save's journal
          // write can land between this save and its clear,
          // and a blind clear would delete the newer journal.
          if (typeof api.recoveryClear === "function") {
            void api.recoveryClear(boardJson).catch(() => undefined);
          }
        }
      },
      onSaveFailed,
    ).finally(() => { savesInFlight--; });
    return { itemsJson, contentKey };
  }

  // Synchronous flush for unload (see board-input.ts
  // beforeunload): the same change check as save(), but
  // the write is synchronous because an async save may
  // not complete before the window closes. Only a board
  // that changed since the last save is written — a
  // pending wheel/zoom camera save, or an edit not yet
  // saved. A board that did not change is not written:
  // after a backup restore the disk board is the
  // snapshot while memory still holds the board it
  // replaced, and an unconditional write would put the
  // old board back on disk. A save already dispatched
  // IS dirty here: its async write may not have landed
  // yet, and the seen keys were marked at dispatch, so
  // trusting them would skip the write and leave
  // board.json stale. The flush writes it synchronously
  // instead — the same board the in-flight save is
  // writing, so a duplicate landing is harmless. No undo step,
  // no search bump, no events: this is a flush, and the
  // seen keys are left alone so a later save still
  // captures the undo step for the change.
  function saveSync(): boolean {
    const itemsJson = JSON.stringify(ctx.getBoard().items);
    const contentKey = contentKeyFor(itemsJson);
    const cameraJson = JSON.stringify(ctx.getBoard().camera);
    if (savesInFlight === 0 && contentKey === lastSeenContentKey && cameraJson === lastSeenCameraJson) return false;
    if (typeof api.saveBoardSync !== "function") return false;
    const boardJson = JSON.stringify(ctx.getBoard());
    // The journal is the write-ahead copy, as in save():
    // a refused sync write keeps the edit for the next
    // launch instead of losing it.
    try {
      api.recoveryWriteSync(boardJson);
    } catch { /* the save below still proceeds */ }
    let ok = false;
    try {
      ok = api.saveBoardSync(boardJson);
    } catch {
      return false;
    }
    if (ok && typeof api.recoveryClear === "function") {
      void api.recoveryClear(boardJson).catch(() => undefined);
    }
    return ok;
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
  // - Items, next_id, next_group, group labels, layers,
  //   per-board plugin data, bg and grid: restored on undo.
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
      groups: JSON.parse(JSON.stringify(ctx.getBoard().groups ?? {})) as Record<number, GroupEntry>,
      layers: JSON.parse(JSON.stringify(ctx.getBoard().layers ?? [])) as Layer[],
      extensions: JSON.parse(JSON.stringify(ctx.getBoard().extensions ?? {})) as Record<string, unknown>,
      bg: ctx.getBoard().bg,
      grid: ctx.getBoard().grid,
      selected: [...ctx.getSelected()],
    };
  }

  // The same state, built from an existing serialisation
  // instead of re-copying the live board. Used where a
  // save already produced the items JSON.
  function stateFromJson(itemsJson: string): UndoState {
    return {
      items: JSON.parse(itemsJson) as Item[],
      next_id: ctx.getBoard().next_id,
      next_group: ctx.getBoard().next_group,
      groups: JSON.parse(JSON.stringify(ctx.getBoard().groups ?? {})) as Record<number, GroupEntry>,
      layers: JSON.parse(JSON.stringify(ctx.getBoard().layers ?? [])) as Layer[],
      extensions: JSON.parse(JSON.stringify(ctx.getBoard().extensions ?? {})) as Record<string, unknown>,
      bg: ctx.getBoard().bg,
      grid: ctx.getBoard().grid,
      selected: [...ctx.getSelected()],
    };
  }

  function contentKey(s: UndoState): string {
    // Selection is restored by undo, but a selection change alone
    // is not a board change, so it is not part of the key.
    // The field order matches contentKeyFor: the two keys for
    // the same board must be identical strings.
    return JSON.stringify({ items: s.items, next_id: s.next_id, next_group: s.next_group, groups: s.groups ?? {}, layers: s.layers ?? [], extensions: s.extensions ?? {}, bg: s.bg, grid: s.grid });
  }

  function updateUndoButtons(): void {
    // Node (unit tests) has no document: the buttons only
    // exist in the renderer.
    if (typeof document === "undefined") return;
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
      ? stateFromJson(itemsJson)
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
      lastSnapshot = stateFromJson(ser.itemsJson);
      lastSnapshotKey = ser.contentKey;
    }
    updateUndoButtons();
  }

  function restoreUndoState(s: UndoState): void {
    ctx.getBoard().items = JSON.parse(JSON.stringify(s.items)) as Item[];
    ctx.getBoard().next_id = s.next_id;
    ctx.getBoard().next_group = s.next_group;
    if (Object.keys(s.groups ?? {}).length > 0) {
      ctx.getBoard().groups = JSON.parse(JSON.stringify(s.groups)) as Record<number, GroupEntry>;
    } else {
      delete ctx.getBoard().groups;
    }
    // Layers and extensions restore like groups: an empty
    // value deletes the field, so a board that never had
    // layers keeps its old shape on disk after an undo.
    if ((s.layers ?? []).length > 0) {
      ctx.getBoard().layers = JSON.parse(JSON.stringify(s.layers)) as Layer[];
    } else {
      delete ctx.getBoard().layers;
    }
    if (Object.keys(s.extensions ?? {}).length > 0) {
      ctx.getBoard().extensions = JSON.parse(JSON.stringify(s.extensions)) as Record<string, unknown>;
    } else {
      delete ctx.getBoard().extensions;
    }
    ctx.getBoard().bg = s.bg;
    ctx.getBoard().grid = s.grid;
    ctx.setSelected(s.selected.filter((id) => boardGet(ctx.getBoard(), id) !== undefined));
    ctx.clearEditing();
  }

  // One undo/redo step: move the current state onto the
  // other stack, restore the popped state, and save. Undo
  // and redo are mirror images — only which stack is source
  // and which is destination swaps.
  function step(from: UndoState[], to: UndoState[]): boolean {
    if (from.length === 0) return false;
    to.push(contentSnapshot());
    const s = from.pop() as UndoState;
    restoreUndoState(s);
    // Set lastSnapshot before save, so save's capture sees the
    // restored content as already known and does not push a step
    // or clear the redo chain we just built.
    setLastSnapshot(contentSnapshot());
    save(); ctx.requestRender();
    ctx.refreshSettings();
    updateUndoButtons();
    return true;
  }

  function undo(): boolean {
    return step(undoStack, redoStack);
  }

  function redo(): boolean {
    return step(redoStack, undoStack);
  }

  function resetUndo(): void {
    undoStack = [];
    redoStack = [];
    setLastSnapshot(contentSnapshot());
    resetSeenKeys();
    updateUndoButtons();
  }
  // The loaded board is the new baseline for save()'s
  // change detection. Without this, a board loaded from
  // disk (a watcher reload, a restore) still counts as
  // "changed" against the last saved state, and the next
  // save — including the unload flush — writes the loaded
  // board back over the disk board it came from. That is
  // how a restore was undone by a reload: the disk board
  // was the snapshot, memory held the board it replaced,
  // and the flush wrote memory back.
  function resetSeenKeys(): void {
    const itemsJson = JSON.stringify(ctx.getBoard().items);
    lastSeenContentKey = contentKeyFor(itemsJson);
    lastSeenCameraJson = JSON.stringify(ctx.getBoard().camera);
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
      resetSeenKeys();
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
    resetSeenKeys();
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
    saveSync,
    undo,
    redo,
    canUndo,
    canRedo,
    resetUndo,
    stashUndoForBoard,
    restoreUndoForBoard,
  };
}
