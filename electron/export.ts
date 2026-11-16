// Board export and import: a portable snapshot of one board —
// its board.json plus every media file its cards reference,
// packed into a ZIP. The exported board.json rewrites asset
// paths to relative assets/<name>, so the ZIP is self-contained:
// unzipped into any fresh install and imported, the board comes
// back exactly as it was at the moment of the export. A board
// folder dropped straight into the boards directory works the
// same way, because loading resolves relative asset paths
// against the board folder (see resolveBoardAssetPaths).
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";

export interface ExportDeps {
  boardPath: () => string;
  boardDir: () => string;
  boardsDir: () => string;
  displayName: (dir: string) => string;
  sanitise: (name: string) => string;
}

export interface ExportResult {
  json: string;
  board_path: string;
  board_dir: string;
}

// A local file a card references, with a handle to rewrite
// it in the parsed board object.
interface AssetRef {
  // The object holding the path (the kind's data), and the
  // field name holding it, so the export can rewrite it.
  holder: Record<string, unknown>;
  field: string;
  value: string;
}

// The asset paths a board carries: Image, Audio, PDF and 3D
// cards hold a path; a video holds a source when it is local
// (remote videos are URLs, not files) and a poster frame.
// A path is an asset only when it is a string; anything else
// is a corrupt field and is left alone.
function boardAssetRefs(board: unknown): AssetRef[] {
  const refs: AssetRef[] = [];
  if (typeof board !== "object" || board === null) return refs;
  const items = (board as { items?: unknown }).items;
  if (!Array.isArray(items)) return refs;
  for (const it of items) {
    if (typeof it !== "object" || it === null) continue;
    const kind = (it as { kind?: unknown }).kind;
    if (typeof kind !== "object" || kind === null) continue;
    const k = kind as Record<string, unknown>;
    const push = (holder: unknown, field: string): void => {
      if (typeof holder !== "object" || holder === null) return;
      const h = holder as Record<string, unknown>;
      if (typeof h[field] === "string") refs.push({ holder: h, field, value: h[field] as string });
    };
    push(k.Image, "path");
    push(k.Audio, "path");
    push(k.PdfCard, "path");
    push(k.Model3D, "path");
    if (typeof k.Video === "object" && k.Video !== null) {
      const v = k.Video as Record<string, unknown>;
      if (v.remote !== true) push(v, "source");
      push(v, "poster");
    }
  }
  return refs;
}

// A path is relative when it is not absolute and not a URL:
// a bare assets/<name> from an export, or a hand-written
// relative path. Absolute paths and URLs are left alone.
function isRelativeAssetPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return false;
  return true;
}

// Resolve a board's relative asset paths against its folder,
// so a board.json carried over from another machine (whose
// paths are relative assets/<name>) loads with absolute
// paths the renderer can serve. Absolute paths and URLs are
// untouched, so resolving is idempotent and a normal board
// passes through unchanged.
export function resolveBoardAssetPaths(json: string, dir: string): string {
  let board: unknown;
  try {
    board = JSON.parse(json);
  } catch {
    return json;
  }
  let changed = false;
  for (const ref of boardAssetRefs(board)) {
    if (!isRelativeAssetPath(ref.value)) continue;
    ref.holder[ref.field] = path.resolve(dir, ref.value);
    changed = true;
  }
  return changed ? JSON.stringify(board) : json;
}

// A file is exportable when it exists and lives inside the
// board folder (the board-local check): a card pointing
// outside the board cannot be carried over, and is left
// pointing where it was.
function isInside(dir: string, file: string): boolean {
  const d = path.resolve(dir);
  const f = path.resolve(file);
  return f === d || f.startsWith(d + path.sep);
}

function dedupeName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let n = 1;
  let next = ext ? `${stem}-${n}${ext}` : `${stem}-${n}`;
  while (used.has(next)) {
    n += 1;
    next = ext ? `${stem}-${n}${ext}` : `${stem}-${n}`;
  }
  used.add(next);
  return next;
}

export function createExport(deps: ExportDeps): {
  buildExportZip: () => Promise<Buffer>;
  importExport: (sourcePath: string) => Promise<ExportResult>;
} {
  // Build the ZIP for the current board: board.json with its
  // asset paths rewritten to relative assets/<name>, the
  // display name, and every referenced media file that exists
  // inside the board folder, copied under assets/. A missing
  // or outside file is left pointing where it was, so the
  // card keeps its "File missing" behaviour instead of
  // gaining a broken relative path.
  async function buildExportZip(): Promise<Buffer> {
    const dir = deps.boardDir();
    const file = deps.boardPath();
    const json = fs.readFileSync(file, "utf8");
    const board: unknown = JSON.parse(json);
    const zip = new JSZip();
    const used = new Set<string>();
    for (const ref of boardAssetRefs(board)) {
      const abs = path.resolve(dir, ref.value);
      if (!isInside(dir, abs)) continue;
      let data: Buffer;
      try {
        data = fs.readFileSync(abs);
      } catch {
        continue;
      }
      const name = dedupeName(used, path.basename(abs));
      zip.file(`assets/${name}`, data);
      ref.holder[ref.field] = `assets/${name}`;
    }
    zip.file("board.json", JSON.stringify(board));
    zip.file("display-name.txt", deps.displayName(dir));
    return zip.generateAsync({ type: "nodebuffer" });
  }

  // Install an export into this install: a ZIP file, or a
  // folder (the unzipped export). The board gets its own
  // folder under the boards directory, named after its
  // display name, with -1, -2 appended when that name is
  // taken. Returns the board with its paths resolved to
  // this machine, ready to load; the board.json on disk
  // keeps its relative paths, so the folder stays portable.
  async function importExport(sourcePath: string): Promise<ExportResult> {
    const stat = fs.statSync(sourcePath);
    let displayName = "";
    let boardJson = "";
    const files: Array<{ name: string; data: Buffer }> = [];
    if (stat.isDirectory()) {
      const jsonFile = path.join(sourcePath, "board.json");
      if (!fs.existsSync(jsonFile)) throw new Error("that folder is not a board export (no board.json)");
      boardJson = fs.readFileSync(jsonFile, "utf8");
      try {
        displayName = fs.readFileSync(path.join(sourcePath, "display-name.txt"), "utf8").trim();
      } catch {
        displayName = path.basename(sourcePath);
      }
      const assets = path.join(sourcePath, "assets");
      if (fs.existsSync(assets)) {
        for (const entry of fs.readdirSync(assets, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          files.push({ name: entry.name, data: fs.readFileSync(path.join(assets, entry.name)) });
        }
      }
    } else {
      if (path.extname(sourcePath).toLowerCase() !== ".zip") throw new Error("pick a .zip export, or the folder it unzips to");
      const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
      const boardFile = zip.file("board.json");
      if (!boardFile) throw new Error("that zip is not a board export (no board.json)");
      boardJson = await boardFile.async("string");
      const nameFile = zip.file("display-name.txt");
      displayName = nameFile ? (await nameFile.async("string")).trim() : path.basename(sourcePath, ".zip");
      for (const [name, entry] of Object.entries(zip.files)) {
        if (!name.startsWith("assets/") || entry.dir) continue;
        files.push({ name: path.basename(name), data: await entry.async("nodebuffer") });
      }
    }
    // The board.json must parse, or the import is refused
    // before anything is written.
    JSON.parse(boardJson);
    const clean = deps.sanitise(displayName || "board");
    let folder = path.join(deps.boardsDir(), clean);
    let n = 1;
    while (fs.existsSync(folder)) {
      folder = path.join(deps.boardsDir(), `${clean}-${n++}`);
    }
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "board.json"), boardJson);
    fs.writeFileSync(path.join(folder, "display-name.txt"), displayName || path.basename(folder));
    if (files.length > 0) {
      const assets = path.join(folder, "assets");
      fs.mkdirSync(assets, { recursive: true });
      for (const f of files) {
        fs.writeFileSync(path.join(assets, deps.sanitise(f.name)), f.data);
      }
    }
    const boardPath = path.join(folder, "board.json");
    return { json: resolveBoardAssetPaths(boardJson, folder), board_path: boardPath, board_dir: folder };
  }

  return { buildExportZip, importExport };
}
