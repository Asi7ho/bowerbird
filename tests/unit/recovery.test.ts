// Unit tests for the recovery journal (electron/recovery.ts):
// write/read round-trip, invalid content, race-safe clear,
// and the differs check that decides whether launch offers
// a restore. The journal is plain Node fs, so no Electron
// stub is needed.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearRecovery,
  clearRecoveryIfMatches,
  readRecovery,
  recoveryDiffers,
  recoveryPathFor,
  writeRecovery,
} from "../../electron/recovery";

const BOARD_A = JSON.stringify({
  items: [{ id: 1, pos: { x: 0, y: 0 }, size: { w: 320, h: 80 }, group: null, kind: { Text: { text: "Hello", bold: false, size: 16, color: "#1A1A1A" } } }],
  camera: { x: 0, y: 0, zoom: 1 },
  next_id: 2,
  next_group: 0,
  bg: "#FFFFFF",
  grid: "Dots",
});
const BOARD_B = JSON.stringify({
  items: [],
  camera: { x: 0, y: 0, zoom: 1 },
  next_id: 1,
  next_group: 0,
  bg: "#FFFFFF",
  grid: "Dots",
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-recovery-test-"));
}

describe("recovery journal", () => {
  it("round-trips a board and reports its save time", () => {
    const dir = tmpDir();
    expect(writeRecovery(dir, BOARD_A)).toBe(true);
    const read = readRecovery(dir);
    expect(read).not.toBeNull();
    expect(read?.json).toBe(BOARD_A);
    expect(typeof read?.savedAt).toBe("number");
    expect(read?.savedAt).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when there is no journal", () => {
    const dir = tmpDir();
    expect(readRecovery(dir)).toBeNull();
    expect(recoveryDiffers(dir, BOARD_A)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses content that is not a board", () => {
    const dir = tmpDir();
    expect(writeRecovery(dir, "not json")).toBe(false);
    expect(writeRecovery(dir, JSON.stringify({ noItems: true }))).toBe(false);
    expect(writeRecovery(dir, JSON.stringify({ items: "nope" }))).toBe(false);
    expect(fs.existsSync(recoveryPathFor(dir))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a corrupt journal on disk", () => {
    const dir = tmpDir();
    fs.writeFileSync(recoveryPathFor(dir), "{broken");
    expect(readRecovery(dir)).toBeNull();
    expect(recoveryDiffers(dir, BOARD_A)).toBe(false);
    fs.writeFileSync(recoveryPathFor(dir), JSON.stringify({ savedAt: 1, board: { items: "nope" } }));
    expect(readRecovery(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("differs only when the journal holds edits the board lacks", () => {
    const dir = tmpDir();
    expect(writeRecovery(dir, BOARD_A)).toBe(true);
    expect(recoveryDiffers(dir, BOARD_A)).toBe(false);
    // Same board, pretty-printed: equal content, no offer.
    expect(recoveryDiffers(dir, JSON.stringify(JSON.parse(BOARD_A), null, 2))).toBe(false);
    expect(recoveryDiffers(dir, BOARD_B)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a board that cannot be parsed counts as differing", () => {
    const dir = tmpDir();
    expect(writeRecovery(dir, BOARD_A)).toBe(true);
    expect(recoveryDiffers(dir, "not json")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("clears only when the journal still holds the saved board", () => {
    const dir = tmpDir();
    expect(writeRecovery(dir, BOARD_A)).toBe(true);
    // Another save overwrote the journal before this clear:
    // the clear must not delete the newer journal.
    expect(writeRecovery(dir, BOARD_B)).toBe(true);
    expect(clearRecoveryIfMatches(dir, BOARD_A)).toBe(false);
    expect(readRecovery(dir)?.json).toBe(BOARD_B);
    expect(clearRecoveryIfMatches(dir, BOARD_B)).toBe(true);
    expect(readRecovery(dir)).toBeNull();
    // Clearing a missing journal is a no-op, not an error.
    expect(clearRecoveryIfMatches(dir, BOARD_B)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("clear removes the journal", () => {
    const dir = tmpDir();
    expect(writeRecovery(dir, BOARD_A)).toBe(true);
    clearRecovery(dir);
    expect(readRecovery(dir)).toBeNull();
    clearRecovery(dir); // clearing twice is fine
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a board over the 50 MB cap", () => {
    const dir = tmpDir();
    const huge = "x".repeat(50000001);
    expect(writeRecovery(dir, huge)).toBe(false);
    expect(fs.existsSync(recoveryPathFor(dir))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a crash between save and clear leaves a journal equal to the board", () => {
    // The save landed but the clear did not: the journal
    // holds exactly board.json, so no recovery is offered.
    const dir = tmpDir();
    expect(writeRecovery(dir, BOARD_A)).toBe(true);
    expect(recoveryDiffers(dir, BOARD_A)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
