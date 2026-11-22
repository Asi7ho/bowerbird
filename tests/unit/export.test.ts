// Unit tests for the full-data export and import
// (electron/export.ts): a portable snapshot of the whole
// install — every board, the user-installed plugins with
// their full folders, and the app state — packed into a ZIP,
// and the path resolution that lets a board carried over
// from another machine load. No DOM, no Electron, so these
// run in plain vitest on every push and PR.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createExport, joinInside, resolveBoardAssetPaths } from "../../electron/export";

function sanitise(name: string): string {
  let out = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (out.length > 64) out = out.slice(0, 64);
  return out || "file";
}

// A board with one of each media kind, all pointing at files
// in the board folder (some in assets/, one at the root, the
// way the welcome board's media is laid out).
function boardJson(dir: string): string {
  return JSON.stringify({
    items: [
      { id: 1, pos: { x: 0, y: 0 }, size: { w: 100, h: 100 }, group: null, kind: { Image: { path: `${dir}/assets/photo.png` } } },
      { id: 2, pos: { x: 0, y: 0 }, size: { w: 100, h: 100 }, group: null, kind: { Audio: { path: `${dir}/assets/song.mp3` } } },
      { id: 3, pos: { x: 0, y: 0 }, size: { w: 100, h: 100 }, group: null, kind: { PdfCard: { path: `${dir}/assets/doc.pdf`, size_bytes: 10 } } },
      { id: 4, pos: { x: 0, y: 0 }, size: { w: 100, h: 100 }, group: null, kind: { Model3D: { path: `${dir}/assets/model.glb`, size_bytes: 10 } } },
      { id: 5, pos: { x: 0, y: 0 }, size: { w: 100, h: 100 }, group: null, kind: { Video: { source: `${dir}/assets/clip.mp4`, remote: false, size_bytes: 10, poster: `${dir}/assets/poster.png` } } },
      { id: 6, pos: { x: 0, y: 0 }, size: { w: 100, h: 100 }, group: null, kind: { Video: { source: "https://example.com/v.mp4", remote: true, size_bytes: 0 } } },
      { id: 7, pos: { x: 0, y: 0 }, size: { w: 100, h: 100 }, group: null, kind: { Text: { text: "hello", bold: false, size: 14, color: "#000000" } } },
      { id: 8, pos: { x: 0, y: 0 }, size: { w: 100, h: 100 }, group: null, kind: { Image: { path: `${dir}/welcome.jpg` } } },
      { id: 9, pos: { x: 0, y: 0 }, size: { w: 100, h: 100 }, group: null, kind: { Image: { path: `${dir}/assets/missing.png` } } },
    ],
    camera: { x: 0, y: 0, zoom: 1 },
    next_id: 10,
    next_group: 1,
    bg: "#FFFFFF",
    grid: "Dots",
    groups: {},
  });
}

function makeBoard(dir: string, displayName: string): void {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "board.json"), boardJson(dir));
  fs.writeFileSync(path.join(dir, "display-name.txt"), displayName);
  for (const f of ["photo.png", "song.mp3", "doc.pdf", "model.glb", "clip.mp4", "poster.png"]) {
    fs.writeFileSync(path.join(dir, "assets", f), `bytes-of-${f}`);
  }
  fs.writeFileSync(path.join(dir, "welcome.jpg"), "bytes-of-welcome");
  // id 9 points at a missing file: it is not created.
  // A backup, a library file and a context index, so the
  // export has the rest of the board folder to carry.
  fs.mkdirSync(path.join(dir, "backups", "2026-11-16-100000"), { recursive: true });
  fs.writeFileSync(path.join(dir, "backups", "2026-11-16-100000", "board.json"), boardJson(dir));
  fs.mkdirSync(path.join(dir, "library"), { recursive: true });
  fs.writeFileSync(path.join(dir, "library", "kept.png"), "bytes-of-kept");
  fs.writeFileSync(path.join(dir, "context-index.json"), JSON.stringify({ version: 1 }));
}

// A whole fake install: Main at the data root, one named
// board, one user plugin with an extra file, and the state
// files. Returns the base dir and the userData dir.
function makeInstall(root: string): { base: string; userData: string } {
  const base = path.join(root, "base");
  const userData = path.join(root, "userData");
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  makeBoard(base, "Main");
  makeBoard(path.join(base, "boards", "My_Board"), "My Board");
  const plugin = path.join(base, "plugins", "my-plugin");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "manifest.json"), JSON.stringify({ apiVersion: "2", id: "my-plugin", name: "My Plugin", main: "main.ts" }));
  fs.writeFileSync(path.join(plugin, "main.ts"), "export function activate() {}");
  fs.writeFileSync(path.join(plugin, "extra.txt"), "an extra plugin file");
  fs.mkdirSync(path.join(plugin, "data"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "data", "notes.md"), "plugin notes");
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ dockVisible: true }));
  fs.writeFileSync(path.join(userData, "plugins.json"), JSON.stringify({ enabled: { "my-plugin": true } }));
  fs.writeFileSync(path.join(userData, "plugin-storage.json"), JSON.stringify({ "my-plugin": { count: 3 } }));
  fs.writeFileSync(path.join(userData, "secure-storage.json"), JSON.stringify({ "my-plugin": { key: "secret" } }));
  return { base, userData };
}

function makeExport(base: string, userData: string, currentBoard: string | null): ReturnType<typeof createExport> {
  return createExport({
    baseDir: () => base,
    userDataDir: () => userData,
    currentBoardName: () => currentBoard,
    displayName: (dir: string) => fs.readFileSync(path.join(dir, "display-name.txt"), "utf8").trim(),
    sanitise,
  });
}

describe("resolveBoardAssetPaths", () => {
  it("resolves relative asset paths against the board folder", () => {
    const json = JSON.stringify({
      items: [
        { id: 1, pos: { x: 0, y: 0 }, size: { w: 1, h: 1 }, group: null, kind: { Image: { path: "assets/photo.png" } } },
        { id: 2, pos: { x: 0, y: 0 }, size: { w: 1, h: 1 }, group: null, kind: { Video: { source: "assets/clip.mp4", remote: false, size_bytes: 1, poster: "assets/poster.png" } } },
      ],
    });
    const out = JSON.parse(resolveBoardAssetPaths(json, "/fresh/boards/My_Board")) as { items: Array<{ kind: { Image?: { path: string }; Video?: { source: string; poster?: string } } }> };
    expect(out.items[0].kind.Image!.path).toBe("/fresh/boards/My_Board/assets/photo.png");
    expect(out.items[1].kind.Video!.source).toBe("/fresh/boards/My_Board/assets/clip.mp4");
    expect(out.items[1].kind.Video!.poster).toBe("/fresh/boards/My_Board/assets/poster.png");
    // Resolving twice changes nothing the second time.
    const once = resolveBoardAssetPaths(json, "/fresh/boards/My_Board");
    expect(resolveBoardAssetPaths(once, "/fresh/boards/My_Board")).toBe(once);
  });

  it("leaves absolute paths, URLs and remote videos alone", () => {
    const json = JSON.stringify({
      items: [
        { id: 1, pos: { x: 0, y: 0 }, size: { w: 1, h: 1 }, group: null, kind: { Image: { path: "/abs/photo.png" } } },
        { id: 2, pos: { x: 0, y: 0 }, size: { w: 1, h: 1 }, group: null, kind: { Video: { source: "https://example.com/v.mp4", remote: true, size_bytes: 0 } } },
      ],
    });
    expect(resolveBoardAssetPaths(json, "/fresh/boards/My_Board")).toBe(json);
  });

  it("passes unparseable JSON through unchanged", () => {
    expect(resolveBoardAssetPaths("not json", "/x")).toBe("not json");
  });
});

describe("full export and import round-trip", () => {
  // One fake install, exported once, shared by the four
  // split tests below: each test unzips the same buffer
  // and asserts its own slice of the export.
  async function exported() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-export-"));
    const { base, userData } = makeInstall(root);
    const { buildFullExportZip } = makeExport(base, userData, "My Board");
    const zipBuffer = await buildFullExportZip();
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(zipBuffer);
    return { root, base, userData, zipBuffer, zip };
  }

  it("exports a manifest naming the current board", async () => {
    const { root, zip } = await exported();
    // The manifest names the current board.
    const manifest = JSON.parse(await zip.file("bowerbird-export.json")!.async("string")) as { version: number; kind: string; currentBoard: string };
    expect(manifest.version).toBe(1);
    expect(manifest.kind).toBe("bowerbird-data");
    expect(manifest.currentBoard).toBe("My Board");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("exports every board with relative asset paths", async () => {
    const { root, zip } = await exported();
    // Both boards are in the ZIP, with relative asset paths.
    for (const prefix of ["boards/Main/", "boards/My_Board/"]) {
      expect(zip.file(`${prefix}board.json`)).not.toBeNull();
      const board = JSON.parse(await zip.file(`${prefix}board.json`)!.async("string")) as { items: Array<{ kind: Record<string, { path?: string; source?: string }> }> };
      const paths = board.items.flatMap((it) => {
        const k = it.kind;
        return [k.Image?.path, k.Audio?.path, k.PdfCard?.path, k.Model3D?.path, k.Video?.source].filter(Boolean) as string[];
      });
      const relative = paths.filter((p) => p.startsWith("assets/"));
      expect(relative.length).toBe(6);
      expect(zip.file(`${prefix}backups/2026-11-16-100000/board.json`)).not.toBeNull();
      expect(zip.file(`${prefix}library/kept.png`)).not.toBeNull();
      expect(zip.file(`${prefix}context-index.json`)).not.toBeNull();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("exports the user plugins and the state files", async () => {
    const { root, zip } = await exported();
    // The user plugin is in the ZIP with its extra files.
    expect(zip.file("plugins/my-plugin/manifest.json")).not.toBeNull();
    expect(zip.file("plugins/my-plugin/main.ts")).not.toBeNull();
    expect(zip.file("plugins/my-plugin/extra.txt")).not.toBeNull();
    expect(zip.file("plugins/my-plugin/data/notes.md")).not.toBeNull();
    // The state files are in the ZIP.
    for (const name of ["settings.json", "plugins.json", "plugin-storage.json", "secure-storage.json"]) {
      expect(zip.file(name)).not.toBeNull();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("imports the export back whole into a fresh install", async () => {
    const { root, zipBuffer } = await exported();
    // Import into a fresh install: everything comes back.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-fresh-"));
    const freshBase = path.join(fresh, "base");
    const freshUserData = path.join(fresh, "userData");
    const zipPath = path.join(root, "export.zip");
    fs.writeFileSync(zipPath, zipBuffer);
    const { importExport } = makeExport(freshBase, freshUserData, null);
    const out = await importExport(zipPath);
    // The board that was current at export time is the one
    // to load, resolved to the fresh install.
    expect(out.board_dir).toBe(path.join(freshBase, "boards", "My_Board"));
    const imported = JSON.parse(out.json) as { items: Array<{ kind: Record<string, { path: string }> }> };
    expect(imported.items[0].kind.Image!.path).toBe(path.join(freshBase, "boards", "My_Board", "assets", "photo.png"));
    expect(fs.existsSync(imported.items[0].kind.Image!.path)).toBe(true);
    // Main is back at the data root, with its assets.
    expect(fs.existsSync(path.join(freshBase, "board.json"))).toBe(true);
    expect(fs.existsSync(path.join(freshBase, "assets", "photo.png"))).toBe(true);
    expect(fs.existsSync(path.join(freshBase, "backups", "2026-11-16-100000", "board.json"))).toBe(true);
    expect(fs.existsSync(path.join(freshBase, "library", "kept.png"))).toBe(true);
    expect(fs.existsSync(path.join(freshBase, "context-index.json"))).toBe(true);
    // The named board is back whole.
    expect(fs.existsSync(path.join(freshBase, "boards", "My_Board", "assets", "clip.mp4"))).toBe(true);
    // The user plugin is back with its extra files.
    expect(fs.readFileSync(path.join(freshBase, "plugins", "my-plugin", "extra.txt"), "utf8")).toBe("an extra plugin file");
    expect(fs.readFileSync(path.join(freshBase, "plugins", "my-plugin", "data", "notes.md"), "utf8")).toBe("plugin notes");
    // The state files are back.
    expect(JSON.parse(fs.readFileSync(path.join(freshUserData, "plugins.json"), "utf8"))).toEqual({ enabled: { "my-plugin": true } });
    expect(JSON.parse(fs.readFileSync(path.join(freshUserData, "plugin-storage.json"), "utf8"))).toEqual({ "my-plugin": { count: 3 } });
    expect(JSON.parse(fs.readFileSync(path.join(freshUserData, "secure-storage.json"), "utf8"))).toEqual({ "my-plugin": { key: "secret" } });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it("imports an unzipped full export folder, not just the ZIP", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-export-"));
    const { base, userData } = makeInstall(root);
    const { buildFullExportZip } = makeExport(base, userData, null);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await buildFullExportZip());
    const folder = path.join(root, "unzipped");
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const dest = path.join(folder, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await entry.async("nodebuffer"));
    }
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-fresh-"));
    const { importExport } = makeExport(path.join(fresh, "base"), path.join(fresh, "userData"), null);
    const out = await importExport(folder);
    // The folder entry point resolves like the ZIP one:
    // no current board at export time, so Main loads.
    expect(out.board_dir).toBe(path.join(fresh, "base"));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it("dedupes a named board that already exists instead of overwriting it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-export-"));
    const { base, userData } = makeInstall(root);
    const { buildFullExportZip } = makeExport(base, userData, "My Board");
    const zipPath = path.join(root, "export.zip");
    fs.writeFileSync(zipPath, await buildFullExportZip());
    // A fresh install that already has a board called My Board.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-fresh-"));
    const freshBase = path.join(fresh, "base");
    makeBoard(path.join(freshBase, "boards", "My_Board"), "My Board");
    const { importExport } = makeExport(freshBase, path.join(fresh, "userData"), null);
    const out = await importExport(zipPath);
    expect(fs.existsSync(path.join(freshBase, "boards", "My_Board", "board.json"))).toBe(true);
    expect(fs.existsSync(path.join(freshBase, "boards", "My_Board-1", "board.json"))).toBe(true);
    // The imported board is the one to load, under its
    // deduped folder.
    expect(out.board_dir).toBe(path.join(freshBase, "boards", "My_Board-1"));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it("still imports a single-board export, the older format", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-export-"));
    const boardDir = path.join(root, "board");
    makeBoard(boardDir, "Solo");
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const board = JSON.parse(fs.readFileSync(path.join(boardDir, "board.json"), "utf8")) as { items: Array<{ kind: Record<string, { path?: string; source?: string }> }> };
    for (const it of board.items) {
      const k = it.kind;
      for (const field of ["path", "source"] as const) {
        const v = (k.Image ?? k.Audio ?? k.PdfCard ?? k.Model3D ?? k.Video ?? {}) as Record<string, string | undefined>;
        if (typeof v[field] === "string" && v[field]!.startsWith(boardDir) && fs.existsSync(v[field]!)) {
          const name = path.basename(v[field]!);
          zip.file(`assets/${name}`, fs.readFileSync(v[field]!));
          v[field] = `assets/${name}`;
        }
      }
    }
    zip.file("board.json", JSON.stringify(board));
    zip.file("display-name.txt", "Solo");
    const zipPath = path.join(root, "solo.zip");
    fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-fresh-"));
    const { importExport } = makeExport(path.join(fresh, "base"), path.join(fresh, "userData"), null);
    const out = await importExport(zipPath);
    expect(out.board_dir).toBe(path.join(fresh, "base", "boards", "Solo"));
    expect(fs.existsSync(path.join(fresh, "base", "boards", "Solo", "assets", "photo.png"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it("refuses a ZIP with no board to open and a folder with no board.json", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-export-"));
    const { importExport } = makeExport(path.join(root, "base"), path.join(root, "userData"), null);
    const JSZip = (await import("jszip")).default;
    const bad = new JSZip();
    bad.file("hello.txt", "not a board");
    const badZip = path.join(root, "bad.zip");
    fs.writeFileSync(badZip, await bad.generateAsync({ type: "nodebuffer" }));
    await expect(importExport(badZip)).rejects.toThrow("no board");
    const emptyFolder = path.join(root, "empty");
    fs.mkdirSync(emptyFolder);
    await expect(importExport(emptyFolder)).rejects.toThrow("no board.json");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("import keeps entries inside their folder", () => {
  // The guard itself, tested directly: the import path
  // goes through JSZip, which canonicalises `..` out of
  // entry names on load, so no traversal name reaches the
  // writer today — but the containment must hold even if
  // the unzipper ever changes, so the guard is tested on
  // its own terms.
  it("joinInside allows paths inside the destination", () => {
    expect(joinInside("/base/boards/Main", "assets/photo.png")).toBe(
      path.join("/base/boards/Main", "assets/photo.png"),
    );
    // A `..` that stays inside is harmless.
    expect(joinInside("/base/boards/Main", "assets/../board.json")).toBe(
      path.join("/base/boards/Main", "board.json"),
    );
  });

  it("joinInside rejects paths that climb out", () => {
    expect(() => joinInside("/base/boards/Main", "assets/../../pwned.txt")).toThrow("outside its folder");
    expect(() => joinInside("/base/plugins/evil", "../../evil.js")).toThrow("outside its folder");
    expect(() => joinInside("/base/boards/Main", "/etc/passwd")).toThrow("outside its folder");
  });

  // End to end: a hand-made ZIP carrying traversal names.
  // Built byte by byte, not with JSZip: JSZip canonicalises
  // `..` out of entry names on write, so a JSZip-made ZIP
  // cannot carry the attack at all — a hand-made ZIP can.
  const CRC_TABLE: number[] = (() => {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(data: Buffer): number {
    let c = 0xffffffff;
    for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function storedZip(entries: Array<[string, string]>): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of entries) {
      const data = Buffer.from(content, "utf8");
      const nameBuf = Buffer.from(name, "utf8");
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      chunks.push(local, nameBuf, data);
      const dir = Buffer.alloc(46);
      dir.writeUInt32LE(0x02014b50, 0);
      dir.writeUInt16LE(20, 4);
      dir.writeUInt16LE(20, 6);
      dir.writeUInt16LE(0, 10);
      dir.writeUInt32LE(crc, 16);
      dir.writeUInt32LE(data.length, 20);
      dir.writeUInt32LE(data.length, 24);
      dir.writeUInt16LE(nameBuf.length, 28);
      dir.writeUInt32LE(offset, 42);
      central.push(dir, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const cdSize = central.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, ...central, end]);
  }

  it("imports a ZIP with traversal entry names without writing outside", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-export-"));
    const zipPath = path.join(root, "crafted.zip");
    fs.writeFileSync(zipPath, storedZip([
      ["bowerbird-export.json", JSON.stringify({ version: 1, kind: "bowerbird-data", currentBoard: "Main" })],
      ["boards/Main/assets/../../pwned.txt", "pwned"],
      ["plugins/evil/../../evil.js", "evil"],
      ["boards/Main/board.json", boardJson("/nowhere")],
    ]));
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-fresh-"));
    const { importExport } = makeExport(path.join(fresh, "base"), path.join(fresh, "userData"), null);
    const out = await importExport(zipPath);
    // The board itself still imports.
    expect(out.board_dir).toBe(path.join(fresh, "base"));
    // Nothing escaped: neither file is beside the base, in
    // it, or in the plugins folder.
    expect(fs.existsSync(path.join(fresh, "pwned.txt"))).toBe(false);
    expect(fs.existsSync(path.join(fresh, "base", "pwned.txt"))).toBe(false);
    expect(fs.existsSync(path.join(fresh, "base", "evil.js"))).toBe(false);
    expect(fs.existsSync(path.join(fresh, "base", "plugins", "evil.js"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  });
});
