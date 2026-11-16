// Unit tests for board export and import (electron/export.ts):
// a portable snapshot of one board — board.json with relative
// asset paths plus every referenced media file, packed into a
// ZIP — and the path resolution that lets a board carried over
// from another machine load. No DOM, no Electron, so these run
// in plain vitest on every push and PR.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createExport, resolveBoardAssetPaths } from "../../electron/export";

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

function makeBoard(root: string): string {
  const dir = path.join(root, "My Board");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "board.json"), boardJson(dir));
  fs.writeFileSync(path.join(dir, "display-name.txt"), "My Board");
  for (const f of ["photo.png", "song.mp3", "doc.pdf", "model.glb", "clip.mp4", "poster.png"]) {
    fs.writeFileSync(path.join(dir, "assets", f), `bytes-of-${f}`);
  }
  fs.writeFileSync(path.join(dir, "welcome.jpg"), "bytes-of-welcome");
  // id 9 points at a missing file: it is not created.
  return dir;
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

  it("is idempotent: resolving twice changes nothing the second time", () => {
    const json = JSON.stringify({
      items: [{ id: 1, pos: { x: 0, y: 0 }, size: { w: 1, h: 1 }, group: null, kind: { Image: { path: "assets/photo.png" } } }],
    });
    const once = resolveBoardAssetPaths(json, "/fresh/boards/My_Board");
    expect(resolveBoardAssetPaths(once, "/fresh/boards/My_Board")).toBe(once);
  });

  it("passes unparseable JSON through unchanged", () => {
    expect(resolveBoardAssetPaths("not json", "/x")).toBe("not json");
  });
});

describe("export and import round-trip", () => {
  it("exports a board as a ZIP with relative paths and all its media, and imports it back whole", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-export-"));
    const boardDir = makeBoard(root);
    const boardsDir = path.join(root, "boards");
    fs.mkdirSync(boardsDir, { recursive: true });
    const { buildExportZip } = createExport({
      boardPath: () => path.join(boardDir, "board.json"),
      boardDir: () => boardDir,
      boardsDir: () => boardsDir,
      displayName: (dir: string) => fs.readFileSync(path.join(dir, "display-name.txt"), "utf8").trim(),
      sanitise,
    });

    const zipBuffer = await buildExportZip();
    // The ZIP carries the board with relative paths, the
    // display name, and every media file that existed.
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(zipBuffer);
    const exported = JSON.parse(await zip.file("board.json")!.async("string")) as { items: Array<{ kind: Record<string, { path?: string; source?: string; poster?: string }> }> };
    expect(await zip.file("display-name.txt")!.async("string")).toBe("My Board");
    const paths = exported.items.flatMap((it) => {
      const k = it.kind;
      return [k.Image?.path, k.Audio?.path, k.PdfCard?.path, k.Model3D?.path, k.Video?.source, k.Video?.poster].filter(Boolean) as string[];
    });
    // Every exported path that was rewritten is relative,
    // inside assets/: the seven media files that existed.
    // The remote video's URL and the missing file's absolute
    // path are not rewritten, so they are not in this list.
    const relative = paths.filter((p) => p.startsWith("assets/"));
    expect(relative.length).toBe(7);
    for (const p of relative) expect(p.startsWith("assets/")).toBe(true);
    // The remote video's URL is untouched, and the missing
    // file keeps its absolute path (it was never copied).
    const video = exported.items[5].kind.Video!;
    expect(video.source).toBe("https://example.com/v.mp4");
    expect(exported.items[8].kind.Image!.path).toBe(`${boardDir}/assets/missing.png`);
    // All seven media files are in the ZIP.
    for (const p of relative) expect(zip.file(p)).not.toBeNull();

    // Import the ZIP into a fresh boards directory: the
    // board comes back with its paths resolved to the new
    // folder, and the assets are on disk beside it.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-fresh-"));
    const freshBoards = path.join(fresh, "boards");
    fs.mkdirSync(freshBoards, { recursive: true });
    const zipPath = path.join(root, "export.zip");
    fs.writeFileSync(zipPath, zipBuffer);
    const { importExport: importIntoFresh } = createExport({
      boardPath: () => "",
      boardDir: () => "",
      boardsDir: () => freshBoards,
      displayName: (dir: string) => fs.readFileSync(path.join(dir, "display-name.txt"), "utf8").trim(),
      sanitise,
    });
    const out = await importIntoFresh(zipPath);
    const imported = JSON.parse(out.json) as { items: Array<{ kind: Record<string, { path?: string; source?: string; poster?: string }> }> };
    const importedPaths = imported.items.flatMap((it) => {
      const k = it.kind;
      return [k.Image?.path, k.Audio?.path, k.PdfCard?.path, k.Model3D?.path, k.Video?.source, k.Video?.poster].filter(Boolean) as string[];
    });
    // Every imported local path is absolute, under the new
    // board folder, and the file is actually there. The
    // remote video's URL and the missing file's path are
    // untouched: they were never copied, so they still point
    // where they did.
    const local = importedPaths.filter((p) => p.startsWith(out.board_dir));
    expect(local.length).toBe(7);
    for (const p of local) {
      expect(fs.existsSync(p)).toBe(true);
    }
    const remoteVideo = imported.items[5].kind.Video!;
    expect(remoteVideo.source).toBe("https://example.com/v.mp4");
    expect(imported.items[8].kind.Image!.path).toBe(`${boardDir}/assets/missing.png`);
    expect(fs.readFileSync(path.join(out.board_dir, "display-name.txt"), "utf8").trim()).toBe("My Board");
    expect(fs.existsSync(path.join(out.board_dir, "board.json"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it("imports an unzipped export folder, not just the ZIP", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-export-"));
    const boardDir = makeBoard(root);
    const boardsDir = path.join(root, "boards");
    fs.mkdirSync(boardsDir, { recursive: true });
    const { buildExportZip } = createExport({
      boardPath: () => path.join(boardDir, "board.json"),
      boardDir: () => boardDir,
      boardsDir: () => boardsDir,
      displayName: (dir: string) => fs.readFileSync(path.join(dir, "display-name.txt"), "utf8").trim(),
      sanitise,
    });
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await buildExportZip());
    // Unzip into a folder, the way a user would.
    const folder = path.join(root, "unzipped");
    fs.mkdirSync(path.join(folder, "assets"), { recursive: true });
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      fs.writeFileSync(path.join(folder, name), await entry.async("nodebuffer"));
    }
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-fresh-"));
    const freshBoards = path.join(fresh, "boards");
    fs.mkdirSync(freshBoards, { recursive: true });
    const { importExport } = createExport({
      boardPath: () => "",
      boardDir: () => "",
      boardsDir: () => freshBoards,
      displayName: (dir: string) => fs.readFileSync(path.join(dir, "display-name.txt"), "utf8").trim(),
      sanitise,
    });
    const out = await importExport(folder);
    expect(fs.existsSync(path.join(out.board_dir, "assets", "photo.png"))).toBe(true);
    const imported = JSON.parse(out.json) as { items: Array<{ kind: { Image?: { path: string } } }> };
    expect(imported.items[0].kind.Image!.path).toBe(path.join(out.board_dir, "assets", "photo.png"));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it("refuses a ZIP with no board.json and a folder with no board.json", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-export-"));
    const boardsDir = path.join(root, "boards");
    fs.mkdirSync(boardsDir, { recursive: true });
    const { importExport } = createExport({
      boardPath: () => "",
      boardDir: () => "",
      boardsDir: () => boardsDir,
      displayName: () => "",
      sanitise,
    });
    const JSZip = (await import("jszip")).default;
    const bad = new JSZip();
    bad.file("hello.txt", "not a board");
    const badZip = path.join(root, "bad.zip");
    fs.writeFileSync(badZip, await bad.generateAsync({ type: "nodebuffer" }));
    await expect(importExport(badZip)).rejects.toThrow("no board.json");
    const emptyFolder = path.join(root, "empty");
    fs.mkdirSync(emptyFolder);
    await expect(importExport(emptyFolder)).rejects.toThrow("no board.json");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
