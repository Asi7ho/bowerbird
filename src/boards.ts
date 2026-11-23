// Board operations: load, switch, restore, reset, and the
// background indexing/poster backfill after a load. Each takes
// the boot context; this module owns nothing at load time.

import { api } from "./backend/api";
import { type Media } from "./backend/media";
import { type BoardSearch } from "./backend/search";
import { type CardRenderer } from "./backend/cards";
import { type UndoStore } from "./backend/undo";
import { type Drops } from "./backend/drops";
import { ensureVideoPoster } from "./backend/poster";
import {
  Board, GroupEntry, Item,
  AUDIO_TRANSCRIPT_HIDDEN_H, boardGet, CARD_DECORATIONS_H,
  estimateTextHeight, healDuplicateIds, healLayers,
} from "./backend/model";
import { welcomeBoard } from "./backend/welcome";
import {
  boardClearEditing, boardCommitEditing, boardRender,
  closeSettingsUI, getCardRenderer,
} from "./plugins/host";

export interface BootContext {
  board: Board;
  boardDir: string;
  // Build id for this run (git short hash in a packaged build,
  // "dev" from source). Set at board load; the feedback mail
  // carries it so a report can be matched to the exact build.
  currentBuildId: string;
  // Board generation: bumped on every board load, so async
  // work started for one board (a PDF render, a search
  // index, an audio probe) can tell, after an await, that
  // the user has switched boards and must not write its
  // result into the new board's card with the same id.
  boardGeneration: number;
  penColor: string;
  // Whether new shapes are outlines (stroke only) or filled.
  shapeOutline: boolean;
  selected: number[];
  toastTimer: ReturnType<typeof setTimeout> | null;
  // Show a transient message on the board's toast element.
  // The implementation lives in main.ts (it owns the toast
  // DOM); the board operations call it through the context
  // so this module never imports the boot module.
  toast: (msg: string) => void;
  // Measure a text note's card height from its text as
  // rendered (the UI probe in text-measure.ts), so a load
  // never re-inflates a note the editor sized exactly.
  // Set by main.ts at boot; the estimate is the fallback
  // where there is no DOM.
  measureNoteCardHeight: (text: string, fontSize: number, width: number) => number;
  // Live imports: re-import the group linked to a source
  // file that changed on disk. Set by main.ts after the
  // drops are created; boards.ts reaches the re-import
  // through here so it never imports the drops module.
  refreshLinkedSource?: (path: string, stat: { exists: boolean; size: number; mtimeMs: number }) => Promise<void>;
  // The board DOM is built by the core-board plugin, so these
  // start unassigned and are read from the shell after the
  // plugin activates in init(). Before that they must not be
  // used: the board does not exist yet.
  boardEl: HTMLDivElement;
  cardsEl: HTMLDivElement;
  toastEl: HTMLDivElement;
  boardSearchVersion: number;
  media: Media;
  search: BoardSearch;
  cards: CardRenderer;
  undoStore: UndoStore;
  drops: Drops;
}

// Each group carries the label its frame shows. Keep the
// label map in step with membership: a group with fewer
// than two members is not a group, so its entry goes; a
// group with members and no entry gets "Group <id>".
// Called after every mutation that can change membership,
// and on load for old boards.
export function syncGroupLabels(b: Board): void {
  const counts = new Map<number, number>();
  for (const it of b.items) {
    if (it.group === null) continue;
    counts.set(it.group, (counts.get(it.group) ?? 0) + 1);
  }
  const labels: Record<number, GroupEntry> = b.groups ?? {};
  for (const key of Object.keys(labels)) {
    const n = counts.get(Number(key)) ?? 0;
    // A group with no members at all loses its entry, link
    // or not — the import is gone with its cards. A live
    // import is a group even with one card, so its entry
    // survives below two members while its source does.
    if (n === 0) { delete labels[Number(key)]; continue; }
    if (n < 2 && !labels[Number(key)].source) delete labels[Number(key)];
  }
  // Rename a default "Section N" label to "Group N": old
  // boards were labelled "Section". A custom label is left
  // alone. (The Swift app does the same on load.)
  for (const key of Object.keys(labels)) {
    const entry = labels[Number(key)];
    const m = /^Section (\d+)$/.exec(entry.label);
    if (m) labels[Number(key)] = { ...entry, label: `Group ${m[1]}` };
  }
  for (const [g, n] of counts) {
    if (n >= 2 && !labels[g]) labels[g] = { label: `Group ${g}` };
  }
  if (Object.keys(labels).length > 0) b.groups = labels; else delete b.groups;
}


export function isFrameCard(it: Item | undefined): boolean {
  if (!it || !("Plugin" in it.kind)) return false;
  // A slide is a frame by its stored kind, not only by its
  // renderer: frames must never rotate, even if the
  // Presentation plugin is disabled and no renderer is
  // registered for them. Other frame kinds still come
  // from their renderer.
  if (it.kind.Plugin.plugin === "presentation" && it.kind.Plugin.kind === "slide") return true;
  return getCardRenderer(it)?.frame === true;
}

// Heal one loaded item: drop stale tags, un-rotate frames,
// grow text cards to fit their text plus the bottom row,
// and grow transcript voice notes so the toggle fits.
// Shared by loadBoardFromJson and init (which adds its own
// UrlCard branch on top).
// The height is measured from the text as rendered
// (measureCardHeight), not estimated: the character-count
// estimate over-counts wrapped lines, so a healed card
// would come back taller than its text and the empty space
// at its bottom would grow on every load. Callers without
// a DOM (unit tests) keep the estimate.
export function healBoardItem(
  it: Item,
  measureCardHeight: (text: string, fontSize: number, width: number) => number = (t, s, w) => estimateTextHeight(t, s, w) + CARD_DECORATIONS_H,
): void {
  // Tags are gone: drop any the board still carries,
  // so they never come back.
  delete (it as { tags?: unknown }).tags;
  if (isFrameCard(it)) delete (it as { rotation?: number }).rotation;
  if ("Text" in it.kind) {
    const need = measureCardHeight(it.kind.Text.text, it.kind.Text.size, it.size.w);
    if (it.size.h < need) it.size.h = need;
  }
  // A voice note with a transcript keeps room for its
  // toggle below the seek: a card saved at the old
  // hidden height is grown on load, so the toggle fits.
  if ("Audio" in it.kind && typeof it.kind.Audio.transcript === "string" && it.kind.Audio.transcript.trim().length > 0) {
    if (it.size.h < AUDIO_TRANSCRIPT_HIDDEN_H) it.size.h = AUDIO_TRANSCRIPT_HIDDEN_H;
  }
}

// Replace the board in place, from a JSON string the main
// process just handed over (a board switch, or a backup
// restore). The old board's undo, search, context index and
// media caches are all per-board, so they are cleared, not
// carried over — a restored board must not undo back into
// the board it replaced, and its context index is its own
// file in its own folder.
// Start indexing the board's media in the background,
// once the renderer is idle — so the model loads don't
// compete with the board's first render and the user's
// first interactions. requestIdleCallback fires when the
// main thread is quiet; the 10s timeout is the backstop
// so indexing still starts on a busy board. A search
// starts indexing at once (see updateSearch), so this
// delay only ever costs a few seconds of background time.
// Tell the main process which source files to watch for live
// imports: the paths linked from this board's groups. Called
// after every board load, and after a drop links a new source
// (via the drops context). The main process only notifies for
// these paths, and only when they are board-local.
export function syncWatchedSources(ctx: BootContext): void {
  const paths: string[] = [];
  for (const entry of Object.values(ctx.board.groups ?? {})) {
    if (entry.source) paths.push(entry.source.path);
  }
  void api.setWatchedSources(paths).then(() => {
    // The watcher only sees changes after it starts: a
    // source edited between the drop and the watcher
    // starting would be missed entirely, so stat the
    // registered sources now and refresh any that already
    // moved. (This is also what catches a change made
    // while the app was closed, on the next load.)
    void refreshStaleSources(ctx);
  }).catch(() => { /* watching is a convenience */ });
}

// After a load, a linked source may be newer than its cards
// (the file was edited while the app was closed, or while
// another board was showing): re-import the stale groups.
// A source missing at load is left alone — the file may come
// back, and the watcher will catch it then; a deletion while
// the app runs is unlinked by the change event instead.
export async function refreshStaleSources(ctx: BootContext): Promise<void> {
  if (!ctx.refreshLinkedSource) return;
  for (const entry of Object.values(ctx.board.groups ?? {})) {
    if (!entry.source) continue;
    let stat: { exists: boolean; size: number; mtimeMs: number };
    try {
      const checked = await api.checkFile(entry.source.path);
      stat = { exists: checked.exists, size: checked.size, mtimeMs: checked.mtimeMs };
    } catch { continue; }
    if (!stat.exists) continue;
    // The stored stat is the file as last imported: a
    // difference means the file changed since the cards
    // were built.
    if (entry.source.size === stat.size && entry.source.mtimeMs === stat.mtimeMs) continue;
    await ctx.refreshLinkedSource(entry.source.path, stat);
  }
}

export function startBackgroundIndexing(ctx: BootContext): void {
  const start = () => { void ctx.search.startContextIndexing(); };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 10000 });
  } else {
    setTimeout(start, 2000);
  }
}

// Fill in poster frames for videos that predate them — old
// boards, and the welcome board — so every video card shows
// its frame instead of a dark tile. One video at a time, in
// the background once the renderer is idle, like the context
// indexing: a capture loads a decoder briefly, and doing
// them all at once would compete with the board's first
// render. A board switch stops the run: the guard compares
// the board object, which a load replaces.
export function startPosterBackfill(ctx: BootContext): void {
  const start = () => { void runPosterBackfill(ctx); };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 10000 });
  } else {
    setTimeout(start, 2000);
  }
}


async function runPosterBackfill(ctx: BootContext): Promise<void> {
  const boardAtStart = ctx.board;
  const pending: Array<{ id: number; source: string }> = [];
  for (const it of boardAtStart.items) {
    if ("Video" in it.kind && !it.kind.Video.remote && !it.kind.Video.poster) {
      pending.push({ id: it.id, source: it.kind.Video.source });
    }
  }
  if (pending.length === 0) return;
  let filledAny = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Save and re-render at most once every two seconds while
  // posters land, so a board of many videos is not saved
  // and rebuilt once per poster.
  const flushSoon = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (ctx.board !== boardAtStart) return;
      ctx.undoStore.saveWithoutUndo();
      boardRender();
    }, 2000);
  };
  for (const { id, source } of pending) {
    if (ctx.board !== boardAtStart) return;
    const filled = await ensureVideoPoster(source);
    if (!filled) continue;
    if (ctx.board !== boardAtStart) return;
    // The item may have been deleted or replaced while the
    // frame was captured: only fill the same video.
    const current = boardGet(boardAtStart, id);
    if (!current || !("Video" in current.kind) || current.kind.Video.source !== source || current.kind.Video.poster) continue;
    current.kind.Video.poster = filled.poster;
    current.kind.Video.duration = filled.duration;
    filledAny = true;
    flushSoon();
  }
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (filledAny && ctx.board === boardAtStart) {
    ctx.undoStore.saveWithoutUndo();
    boardRender();
  }
}

// Replace the board in place, from a JSON string the main
// process just handed over (a board switch, or a backup
// restore). The old board's undo, search, context index and
// media caches are all per-board, so they are cleared, not
// carried over — a restored board must not undo back into
// the board it replaced, and its context index is its own
// file in its own folder.
export async function loadBoardFromJson(ctx: BootContext, json: string, dir: string, preserveUndo = false): Promise<void> {
  // Discard an in-progress edit, do not commit it: the incoming
  // board replaces the outgoing one, and committing would save
  // the outgoing board to disk after the incoming content was
  // already read — overwriting a restore or an external change
  // and leaving disk and memory diverged. (A board switch
  // commits and saves the edit before calling this, so nothing
  // is lost there.)
  boardClearEditing();
  const oldDir = ctx.boardDir;
  const sameBoard = oldDir !== "" && oldDir === dir;
  // Save the outgoing board's stack before replacing it,
  // unless this is the same board reloaded (a restore or
  // a rename): then the stack is kept, not filed away.
  if (!sameBoard && !preserveUndo && oldDir !== "") {
    ctx.undoStore.stashUndoForBoard(oldDir);
  }
  const parsed = JSON.parse(json) as Board;
  parsed.bg = parsed.bg ?? "#FFFFFF";
  parsed.grid = parsed.grid ?? "Dots";
  parsed.camera = parsed.camera ?? { x: 0, y: 0, zoom: 1 };
  // A board file can carry two cards with the same id; the
  // first keeps it and later ones get fresh ids, so search
  // and every id lookup see a consistent board.
  healDuplicateIds(parsed);
  // A board written before layers existed has no layers or
  // extensions field: every item lands on the default layer
  // and extensions starts empty, in memory only — the file
  // gains the fields on the next save, never on load.
  healLayers(parsed);
  // Frames never rotate: a frame carrying rotation from
  // an older board, or set while Presentation was
  // disabled, is healed on load, so what is drawn always
  // matches the unrotated rect Presentation plays.
  // Text cards keep room for their bottom row below the
  // text: a card saved before that room existed is grown
  // on load, so the checklist progress never sits on its
  // text.
  for (const it of parsed.items) {
    healBoardItem(it, ctx.measureNoteCardHeight);
  }
  // Groups: give every group its label, and drop labels
  // for groups that no longer have members.
  syncGroupLabels(parsed);
  ctx.board = parsed;
  ctx.boardGeneration++;
  ctx.boardSearchVersion++;
  ctx.boardDir = dir;
  ctx.selected = [];
  boardClearEditing();
  ctx.search.reset();
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (input) input.value = "";
  // A pending debounced save belongs to the outgoing
  // board: flush it only if the main process is still on
  // that board (same-board reload/restore); on a switch
  // the main process has already moved on, so flushing
  // would write the old index into the new board's file
  // — discard it instead, the new board re-indexes.
  if (oldDir !== "" && oldDir === dir) ctx.search.flushContextIndex(); else ctx.search.cancelContextIndexSave();
  ctx.search.clearBoardCaches();
  ctx.media.clearBoardCaches();
  ctx.undoStore.restoreUndoForBoard(dir, sameBoard || preserveUndo);
  boardRender();
  void ctx.search.loadContextIndex();
  // Index the board's media in the background, so the
  // first search does not pay the model-load and embedding
  // cost. It is async and guarded: nothing happens when
  // everything is already indexed.
  startBackgroundIndexing(ctx);
  syncWatchedSources(ctx);
  // A source may be newer than its cards already (edited
  // while the app was closed, or while another board was
  // showing): re-import the stale groups.
  void refreshStaleSources(ctx);
  // Fill in poster frames for videos that predate them
  // (old boards, the welcome board), in the background.
  startPosterBackfill(ctx);
}

export async function switchToBoard(ctx: BootContext, name: string, preserveUndo = false): Promise<boolean> {
  try {
    boardCommitEditing();
    await api.saveBoard(JSON.stringify(ctx.board));
    ctx.search.flushContextIndex();
    const loaded = await api.switchBoard(name);
    await loadBoardFromJson(ctx, loaded.json, loaded.board_dir, preserveUndo);
    ctx.toast(`Board: ${name}`);
    return true;
  } catch (e) {
    ctx.toast(`Could not switch boards: ${String(e)}`);
    return false;
  }
}

export async function restoreBoardBackup(ctx: BootContext, name: string): Promise<boolean> {
  try {
    const loaded = await api.restoreBackup(name);
    await loadBoardFromJson(ctx, loaded.json, loaded.board_dir);
    ctx.toast("Backup restored");
    return true;
  } catch (e) {
    ctx.toast(`Could not restore backup: ${String(e)}`);
    return false;
  }
}

// Restore the crash-recovery journal: the edits board.json
// does not hold. The main process backs the current board up
// first, so the restore is reversible like a backup restore.
export async function restoreRecoveryJournal(ctx: BootContext): Promise<boolean> {
  try {
    const restored = await api.recoveryRestore();
    await loadBoardFromJson(ctx, restored.json, restored.board_dir);
    ctx.toast("Unsaved changes restored");
    return true;
  } catch (e) {
    ctx.toast(`Could not restore unsaved changes: ${String(e)}`);
    return false;
  }
}

// Import a data export — a ZIP file, or the folder it
// unzips to — and load the board that was current at export
// time. The main process installs every board, plugin and
// state file, and hands back the board resolved to this
// machine; null means the user cancelled the file dialog,
// which is not an error.
export async function importBoard(ctx: BootContext): Promise<boolean> {
  try {
    const loaded = await api.importBoard();
    if (!loaded) return false;
    await loadBoardFromJson(ctx, loaded.json, loaded.board_dir);
    ctx.toast("Board imported");
    return true;
  } catch (e) {
    ctx.toast(`Could not import board: ${String(e)}`);
    return false;
  }
}

// Reset the board to a fresh welcome board (the settings
// "Delete all board data" flow). The settings plugin calls
// this through the API; the core owns the reset itself.
// Delete first, then build the fresh welcome board in memory
// and save that — never save the old board after the wipe,
// or it would come straight back. The corner setting is
// untouched: reset-board only deletes board data, not app
// settings.
export async function resetBoardToWelcome(ctx: BootContext, opts?: { confirmed?: boolean }): Promise<boolean> {
  boardCommitEditing();
  ctx.media.stopAudio();
  ctx.selected = [];
  boardClearEditing();
  try {
    const showcase = await api.resetBoard(opts);
    const pdfPage = await ctx.media.probePdfSize(`${ctx.boardDir}/sample.pdf`);
    ctx.board = welcomeBoard(ctx.boardDir, showcase.pdf_size_bytes, showcase.video_size_bytes, showcase.model_size_bytes, showcase.psd_size_bytes, showcase.ai_size_bytes, pdfPage);
    ctx.board.camera = { x: 0, y: 0, zoom: 1 };
    closeSettingsUI();
    ctx.undoStore.save();
    boardRender();
    void ctx.drops.refreshLinkPreviews();
    ctx.toast("Board data deleted — fresh welcome board restored");
    return true;
  } catch (e) {
    ctx.toast(`Reset failed: ${String(e)}`);
    return false;
  }
}
