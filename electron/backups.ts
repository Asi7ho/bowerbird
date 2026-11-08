// Backups: a full snapshot of one board at a moment — its
// board.json plus the assets its cards reference (copied, not
// linked, so a later asset delete cannot break the snapshot).
// Backups live in the board's own folder, under backups/, so
// switching boards switches backup lists, and deleting a
// board deletes its backups with it. They are made at most
// once an hour on save, plus unconditionally before a reset
// or a restore (so restoring never loses the current board).
// Only the newest 10 are kept; older ones are pruned.
import * as fs from "node:fs";
import * as path from "node:path";

export interface BackupsDeps {
  boardPath: () => string;
  boardItemCount: (file: string) => number;
}

export interface BackupEntry {
  name: string;
  items: number;
  size: number;
}

export interface Backups {
  maybeBackup: (dir: string, json: string | null) => void;
  listBackups: (dir: string) => BackupEntry[];
  restoreBackup: (dir: string, name: string) => { json: string; board_path: string; board_dir: string };
  makeBackup: (dir: string, json: string | null) => string | null;
}

// deps: boardPath() (current board file),
// boardItemCount(file) (items in a board.json file).
export function createBackups(deps: BackupsDeps): Backups {
  // ---------------------------------------------------------------- backups
  //
  // A backup is a full snapshot of one board at a moment: its
  // board.json plus the assets its cards reference (copied, not
  // linked, so a later asset delete cannot break the snapshot).
  // Backups live in the board's own folder, under backups/, so
  // switching boards switches backup lists, and deleting a
  // board deletes its backups with it. They are made at most
  // once an hour on save, plus unconditionally before a reset
  // or a restore (so restoring never loses the current board).
  // Only the newest 10 are kept; older ones are pruned.

  function backupsDirFor(dir: string): string {
    return path.join(dir, "backups");
  }
  function backupStamp(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name), d = path.join(dest, entry.name);
      if (entry.isDirectory()) copyDirRecursive(s, d);
      else if (entry.isFile()) fs.copyFileSync(s, d);
    }
  }
  function dirSize(dir: string): number {
    let total = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirSize(p);
        else if (entry.isFile()) total += fs.statSync(p).size;
      }
    } catch { /* ignore */ }
    return total;
  }
  function pruneBackups(dir: string): void {
    const backups = backupsDirFor(dir);
    let entries: string[] = [];
    try { entries = fs.readdirSync(backups, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return; }
    while (entries.length > 10) {
      const oldest = entries.shift();
      if (!oldest) break;
      try { fs.rmSync(path.join(backups, oldest), { recursive: true, force: true }); } catch { /* keep going */ }
    }
  }
  function makeBackup(dir: string, json: string | null): string | null {
    if (!json) return null;
    const backups = backupsDirFor(dir);
    fs.mkdirSync(backups, { recursive: true });
    let dest = path.join(backups, backupStamp());
    let i = 1;
    while (fs.existsSync(dest)) { dest = path.join(backups, `${backupStamp()}-${i++}`); }
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "board.json"), json);
    const assets = path.join(dir, "assets");
    if (fs.existsSync(assets)) {
      try { copyDirRecursive(assets, path.join(dest, "assets")); } catch { /* board.json alone is still a backup */ }
    }
    pruneBackups(dir);
    return path.basename(dest);
  }
  // Newest-backup time per board folder, cached so the
  // per-save check does not readdir + stat the backups
  // folder on every save. The cache is only trusted while
  // a backup is recent (none due) and fresh (checked in
  // the last 10 minutes); otherwise the folder is
  // rescanned, so a backup made or removed by another
  // path (restore, reset) is picked up within 10 minutes.
  const backupNewestCache = new Map<string, { newest: number; checkedAt: number }>();
  function maybeBackup(dir: string, json: string | null): void {
    if (!json) return;
    const now = Date.now();
    const cached = backupNewestCache.get(dir);
    if (cached && now - cached.checkedAt < 10 * 60 * 1000 && now - cached.newest < 60 * 60 * 1000) return;
    const backups = backupsDirFor(dir);
    let newest = 0;
    try {
      for (const entry of fs.readdirSync(backups, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const m = fs.statSync(path.join(backups, entry.name)).mtimeMs;
        if (m > newest) newest = m;
      }
    } catch { /* no backups yet */ }
    backupNewestCache.set(dir, { newest, checkedAt: now });
    if (now - newest < 60 * 60 * 1000) return;
    try {
      if (makeBackup(dir, json)) backupNewestCache.set(dir, { newest: now, checkedAt: now });
    } catch { /* backups must never break a save */ }
  }
  function listBackups(dir: string): BackupEntry[] {
    // The Settings UI shows only the last backup, so
    // computing item counts and recursive sizes for all
    // 10 backups on every Settings open was pure waste.
    // Return just the newest entry.
    const backups = backupsDirFor(dir);
    let entries: string[] = [];
    try { entries = fs.readdirSync(backups, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse(); } catch { return []; }
    if (entries.length === 0) return [];
    const name = entries[0];
    const folder = path.join(backups, name);
    return [{ name, items: deps.boardItemCount(path.join(folder, "board.json")), size: dirSize(folder) }];
  }
  function restoreBackup(dir: string, name: string): { json: string; board_path: string; board_dir: string } {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) throw new Error("bad backup name");
    const src = path.join(backupsDirFor(dir), name);
    const srcJson = path.join(src, "board.json");
    if (!fs.existsSync(srcJson)) throw new Error("no such backup");
    // Back up the current board first, so restoring is reversible.
    try {
      const cur = fs.readFileSync(deps.boardPath(), "utf8");
      makeBackup(dir, cur);
    } catch { /* restoring still proceeds */ }
    const json = fs.readFileSync(srcJson, "utf8");
    fs.writeFileSync(deps.boardPath(), json);
    const assetsDest = path.join(dir, "assets");
    try { fs.rmSync(assetsDest, { recursive: true, force: true }); } catch { /* replaced below */ }
    if (fs.existsSync(path.join(src, "assets"))) {
      try { copyDirRecursive(path.join(src, "assets"), assetsDest); } catch { /* board.json is restored regardless */ }
    }
    return { json, board_path: deps.boardPath(), board_dir: dir };
  }

  return { maybeBackup, listBackups, restoreBackup, makeBackup };
}
