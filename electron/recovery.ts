// Recovery journal: a write-ahead copy of the board, so an edit
// that reached the renderer but never landed in board.json —
// the app was killed or crashed, or the save was refused by
// the live-follow guard — survives to the next launch, where
// the app offers to restore it.
//
// The journal is one file next to the board, recovery.json:
// {"savedAt": <epoch ms>, "board": <the board object>}.
// It is written (tmp + rename, like a save) before every save,
// and cleared once that save lands — so it only ever holds
// edits board.json does not. A journal whose content equals
// board.json is stale, never an offer: a kill between the save
// and the clear leaves exactly that.
//
// The journal is per board folder, like backups: switching
// boards switches journals, deleting a board deletes its
// journal with it. It is never exported (the export copies
// only board.json, assets, backups, library and the context
// index) and never backed up (a backup is a snapshot of the
// board, not of its unsaved edits).
import * as fs from "node:fs";
import * as path from "node:path";

const RECOVERY_FILE = "recovery.json";
// Same 50 MB cap as a board save: a board that cannot be
// saved cannot be journalled either, and an unbounded write
// must not fill the disk.
const MAX_BYTES = 50000000;

export interface RecoveryEntry {
  json: string;
  savedAt: number;
}

export function recoveryPathFor(dir: string): string {
  return path.join(dir, RECOVERY_FILE);
}

// Parse a board JSON string into its canonical form: the
// stringified parsed board. Two writes of the same board
// compare equal this way even if one was pretty-printed.
function canonicalBoardJson(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { items?: unknown }).items)) return null;
  return JSON.stringify(parsed);
}

// Write the journal for a board folder. Returns false (never
// throws) when the content is not a board, is too large, or
// the write fails — a journal that cannot be written must
// never break the save it precedes.
export function writeRecovery(dir: string, json: string): boolean {
  if (json.length > MAX_BYTES) return false;
  const canonical = canonicalBoardJson(json);
  if (canonical === null) return false;
  const file = recoveryPathFor(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), board: JSON.parse(canonical) }));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// Read the journal, or null when there is none or it is not
// a valid board. The returned json is the canonical board
// JSON, so it compares equal to a save of the same board.
export function readRecovery(dir: string): RecoveryEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(recoveryPathFor(dir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { savedAt, board } = parsed as { savedAt?: unknown; board?: unknown };
  if (typeof savedAt !== "number" || !board || typeof board !== "object") return null;
  if (!Array.isArray((board as { items?: unknown }).items)) return null;
  return { json: JSON.stringify(board), savedAt };
}

// Delete the journal, best-effort: a journal that cannot be
// deleted is stale content, not a failure — the next launch
// compares it against the board and ignores it when equal.
export function clearRecovery(dir: string): void {
  try {
    fs.rmSync(recoveryPathFor(dir), { force: true });
  } catch {
    /* ignore */
  }
}

// Delete the journal only when it still holds exactly the
// board just saved. Saves overlap: a second save's journal
// write can land between the first save and its clear, and
// a blind clear would delete the second save's journal.
// Returns whether anything was cleared.
export function clearRecoveryIfMatches(dir: string, json: string): boolean {
  const canonical = canonicalBoardJson(json);
  if (canonical === null) return false;
  const current = readRecovery(dir);
  if (!current || current.json !== canonical) return false;
  clearRecovery(dir);
  return true;
}

// Whether the journal holds edits board.json does not: it
// exists, is valid, and its content differs from the board
// on disk. A corrupt journal, or one equal to the board, is
// never an offer.
export function recoveryDiffers(dir: string, boardJson: string): boolean {
  const current = readRecovery(dir);
  if (!current) return false;
  const canonical = canonicalBoardJson(boardJson);
  if (canonical === null) return true;
  return current.json !== canonical;
}
