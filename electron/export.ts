// Board export and import: a portable snapshot of the whole
// Bowerbird install — every board, the user-installed plugins
// with their full folders, and the app state (settings, which
// plugins are enabled, per-plugin storage and secure storage) —
// packed into a ZIP. The exported board.json files rewrite
// asset paths to relative assets/<name>, so the ZIP is
// self-contained: unzipped into any fresh install and imported,
// everything comes back as it was at the moment of the export.
// Bundled plugins are not in the ZIP: they ship with the app,
// so a fresh install already has them, and the enabled states
// in plugins.json cover which ones are on.
// A board folder dropped straight into the boards directory
// works the same way, because loading resolves relative asset
// paths against the board folder (see resolveBoardAssetPaths).
// The import also reads the older single-board export (a ZIP
// with board.json at the root), so an export made before the
// full snapshot existed still restores.
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";

export interface ExportDeps {
  baseDir: () => string;
  userDataDir: () => string;
  currentBoardName: () => string | null;
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

// The asset paths a board carries: Image, Audio, PDF, 3D and
// FileCard cards hold a path (a FileCard also holds a preview);
// a video holds a source when it is local
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
    push(k.FileCard, "path");
    push(k.FileCard, "preview");
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

// Copy a directory tree into a JSZip under a prefix, skipping
// nothing: a plugin folder's extra files come along with its
// code, and a board folder's backups, library and context
// index come along with its board.
function addDirToZip(zip: JSZip, src: string, prefix: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const dest = `${prefix}${entry.name}`;
    if (entry.isDirectory()) addDirToZip(zip, s, `${dest}/`);
    else if (entry.isFile()) {
      try {
        zip.file(dest, fs.readFileSync(s));
      } catch { /* a file that vanishes mid-export is skipped */ }
    }
  }
}

export function createExport(deps: ExportDeps): {
  buildFullExportZip: () => Promise<Buffer>;
  importExport: (sourcePath: string) => Promise<ExportResult>;
} {
  // Add one board folder to the ZIP under a prefix: board.json
  // with its asset paths rewritten to relative assets/<name>,
  // the display name, and the whole folder (assets, backups,
  // library, context index). A missing or outside file is left
  // pointing where it was, so the card keeps its "File missing"
  // behaviour instead of gaining a broken relative path.
  function addBoardToZip(zip: JSZip, boardFolder: string, prefix: string): void {
    const jsonFile = path.join(boardFolder, "board.json");
    let json: string;
    try {
      json = fs.readFileSync(jsonFile, "utf8");
    } catch {
      return;
    }
    let board: unknown;
    try {
      board = JSON.parse(json);
    } catch {
      return;
    }
    const used = new Set<string>();
    for (const ref of boardAssetRefs(board)) {
      const abs = path.resolve(boardFolder, ref.value);
      if (!isInside(boardFolder, abs)) continue;
      let data: Buffer;
      try {
        data = fs.readFileSync(abs);
      } catch {
        continue;
      }
      const name = dedupeName(used, path.basename(abs));
      zip.file(`${prefix}assets/${name}`, data);
      ref.holder[ref.field] = `assets/${name}`;
    }
    zip.file(`${prefix}board.json`, JSON.stringify(board));
    try {
      zip.file(`${prefix}display-name.txt`, deps.displayName(boardFolder));
    } catch { /* a board without a display name still exports */ }
    // The rest of the folder comes along whole: backups, the
    // Visual Library, and the search context index. Assets are
    // already in the ZIP under their deduped names, so they are
    // not copied twice.
    for (const sub of ["backups", "library"]) {
      addDirToZip(zip, path.join(boardFolder, sub), `${prefix}${sub}/`);
    }
    const index = path.join(boardFolder, "context-index.json");
    if (fs.existsSync(index)) {
      try {
        zip.file(`${prefix}context-index.json`, fs.readFileSync(index));
      } catch { /* the index is rebuildable, so it is optional */ }
    }
  }

  // Build the full-data ZIP: a manifest, every board (Main at
  // the data root, named boards under boards/), every
  // user-installed plugin with its full folder, and the app
  // state files. Bundled plugins are not included: they ship
  // with the app.
  async function buildFullExportZip(): Promise<Buffer> {
    const zip = new JSZip();
    const base = deps.baseDir();
    const current = deps.currentBoardName();
    zip.file("bowerbird-export.json", JSON.stringify({
      version: 1,
      kind: "bowerbird-data",
      exportedAt: new Date().toISOString(),
      currentBoard: current,
    }, null, 2));
    // Main lives at the data root, not under boards/.
    if (fs.existsSync(path.join(base, "board.json"))) {
      addBoardToZip(zip, base, "boards/Main/");
    }
    const boardsRoot = path.join(base, "boards");
    let folders: string[] = [];
    try {
      folders = fs.readdirSync(boardsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch { /* no named boards yet */ }
    for (const folder of folders) {
      addBoardToZip(zip, path.join(boardsRoot, folder), `boards/${deps.sanitise(folder)}/`);
    }
    // User-installed plugins, whole folders: a plugin is more
    // than its manifest and main code, and its extra files are
    // what the user asked to carry over.
    const pluginsRoot = path.join(base, "plugins");
    let plugins: string[] = [];
    try {
      plugins = fs.readdirSync(pluginsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch { /* no user plugins yet */ }
    for (const id of plugins) {
      addDirToZip(zip, path.join(pluginsRoot, id), `plugins/${deps.sanitise(id)}/`);
    }
    // App state: settings, which plugins are enabled,
    // per-plugin storage, and secure storage (the API keys).
    // These are the user's own data; the ZIP is theirs.
    for (const name of ["settings.json", "plugins.json", "plugin-storage.json", "secure-storage.json"]) {
      const file = path.join(deps.userDataDir(), name);
      if (fs.existsSync(file)) {
        try {
          zip.file(name, fs.readFileSync(file));
        } catch { /* a state file that cannot be read is skipped */ }
      }
    }
    return zip.generateAsync({ type: "nodebuffer" });
  }

  // Install a full-data export: every board, every user
  // plugin, and the state files. A named board whose folder
  // already exists is installed under a deduped name, so an
  // import never overwrites a board the user already has;
  // Main replaces the board at the data root (the welcome
  // board on a fresh install), and a user plugin whose id
  // already exists is skipped. Returns the board that was
  // current at export time, resolved to this machine, ready
  // to load; the board.json files on disk keep their relative
  // paths, so the folders stay portable.
  async function importFullExport(zip: JSZip): Promise<ExportResult> {
    const base = deps.baseDir();
    const boardsRoot = path.join(base, "boards");
    const pluginsRoot = path.join(base, "plugins");
    fs.mkdirSync(boardsRoot, { recursive: true });
    let manifest: { currentBoard?: string | null } = {};
    const manifestFile = zip.file("bowerbird-export.json");
    if (manifestFile) {
      try {
        manifest = JSON.parse(await manifestFile.async("string")) as { currentBoard?: string | null };
      } catch { /* a missing manifest still imports the boards */ }
    }
    let current: ExportResult | null = null;
    // The dest folder is computed once per board, not once
    // per file: the first entry creates the folder, and
    // recomputing the dedupe for every later entry would
    // scatter one board across My_Board, My_Board-1, ...
    const installedBoards = new Map<string, string>();
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!name.startsWith("boards/") || entry.dir) continue;
      const rest = name.slice("boards/".length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      const boardName = rest.slice(0, slash);
      const rel = rest.slice(slash + 1);
      const isMain = boardName === "Main";
      let dest = installedBoards.get(boardName);
      if (dest === undefined) {
        dest = isMain ? base : path.join(boardsRoot, deps.sanitise(boardName));
        // A named board that already exists gets a deduped
        // folder, so the import never overwrites one. Main is
        // the exception: it replaces the board at the root.
        if (!isMain) {
          let n = 1;
          while (fs.existsSync(dest)) {
            dest = path.join(boardsRoot, `${deps.sanitise(boardName)}-${n++}`);
          }
        }
        installedBoards.set(boardName, dest);
      }
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.writeFileSync(path.join(dest, rel), await entry.async("nodebuffer"));
      if (rel === "board.json") {
        const boardJson = await entry.async("string");
        const out = { json: resolveBoardAssetPaths(boardJson, dest), board_path: path.join(dest, "board.json"), board_dir: dest };
        const wanted = manifest.currentBoard ?? null;
        if ((wanted === null && isMain) || (wanted !== null && boardName === deps.sanitise(wanted))) {
          current = out;
        }
        // If the manifest names no current board, the first
        // board found becomes the one to load.
        if (!current && !manifestFile) current = out;
      }
    }
    // User plugins, whole folders. One whose id already
    // existed before this import is skipped, so an import
    // never overwrites a plugin the user already has. The
    // check is against the ids present before the import
    // started: the first file of a plugin creates its folder,
    // and checking existence per file would skip every later
    // file of that same plugin.
    const existingPlugins = new Set<string>();
    try {
      for (const e of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
        if (e.isDirectory()) existingPlugins.add(e.name);
      }
    } catch { /* no plugins yet */ }
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!name.startsWith("plugins/") || entry.dir) continue;
      const rest = name.slice("plugins/".length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      const id = deps.sanitise(rest.slice(0, slash));
      const rel = rest.slice(slash + 1);
      if (existingPlugins.has(id)) continue;
      const dest = path.join(pluginsRoot, id);
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.writeFileSync(path.join(dest, rel), await entry.async("nodebuffer"));
    }
    // App state files, restored as they were.
    for (const stateName of ["settings.json", "plugins.json", "plugin-storage.json", "secure-storage.json"]) {
      const file = zip.file(stateName);
      if (!file) continue;
      try {
        fs.mkdirSync(deps.userDataDir(), { recursive: true });
        fs.writeFileSync(path.join(deps.userDataDir(), stateName), await file.async("nodebuffer"));
      } catch { /* a state file that cannot be written is skipped */ }
    }
    if (!current) throw new Error("that export has no board to open");
    return current;
  }

  // Install a single-board export (the older format: board.json
  // at the ZIP root, or a folder with board.json at its root).
  // The board gets its own folder under the boards directory,
  // named after its display name, with -1, -2 appended when
  // that name is taken.
  async function importSingleBoard(zip: JSZip | null, folder: string | null): Promise<ExportResult> {
    const boardsRoot = path.join(deps.baseDir(), "boards");
    let displayName = "";
    let boardJson = "";
    const files: Array<{ name: string; data: Buffer }> = [];
    if (folder !== null) {
      const jsonFile = path.join(folder, "board.json");
      if (!fs.existsSync(jsonFile)) throw new Error("that folder is not a board export (no board.json)");
      boardJson = fs.readFileSync(jsonFile, "utf8");
      try {
        displayName = fs.readFileSync(path.join(folder, "display-name.txt"), "utf8").trim();
      } catch {
        displayName = path.basename(folder);
      }
      const assets = path.join(folder, "assets");
      if (fs.existsSync(assets)) {
        for (const entry of fs.readdirSync(assets, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          files.push({ name: entry.name, data: fs.readFileSync(path.join(assets, entry.name)) });
        }
      }
    } else if (zip !== null) {
      const boardFile = zip.file("board.json");
      if (!boardFile) throw new Error("that zip is not a board export (no board.json)");
      boardJson = await boardFile.async("string");
      const nameFile = zip.file("display-name.txt");
      displayName = nameFile ? (await nameFile.async("string")).trim() : "board";
      for (const [name, entry] of Object.entries(zip.files)) {
        if (!name.startsWith("assets/") || entry.dir) continue;
        files.push({ name: path.basename(name), data: await entry.async("nodebuffer") });
      }
    } else {
      throw new Error("nothing to import");
    }
    // The board.json must parse, or the import is refused
    // before anything is written.
    JSON.parse(boardJson);
    const clean = deps.sanitise(displayName || "board");
    let dest = path.join(boardsRoot, clean);
    let n = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(boardsRoot, `${clean}-${n++}`);
    }
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "board.json"), boardJson);
    fs.writeFileSync(path.join(dest, "display-name.txt"), displayName || path.basename(dest));
    if (files.length > 0) {
      const assets = path.join(dest, "assets");
      fs.mkdirSync(assets, { recursive: true });
      for (const f of files) {
        fs.writeFileSync(path.join(assets, deps.sanitise(f.name)), f.data);
      }
    }
    const boardPath = path.join(dest, "board.json");
    return { json: resolveBoardAssetPaths(boardJson, dest), board_path: boardPath, board_dir: dest };
  }

  // Install an export into this install: a ZIP file, or a
  // folder (the unzipped export). A full-data export is
  // recognised by its manifest (or a boards/ folder); anything
  // else with a board.json at the root is a single-board
  // export.
  async function importExport(sourcePath: string): Promise<ExportResult> {
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      const manifest = path.join(sourcePath, "bowerbird-export.json");
      const boards = path.join(sourcePath, "boards");
      if (fs.existsSync(manifest) || fs.existsSync(boards)) {
        // A full-data export as a folder: load it into a ZIP
        // in memory so the same importer handles both forms.
        const zip = new JSZip();
        const addDir = (dir: string, prefix: string): void => {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const s = path.join(dir, entry.name);
            const dest = `${prefix}${entry.name}`;
            if (entry.isDirectory()) addDir(s, `${dest}/`);
            else if (entry.isFile()) zip.file(dest, fs.readFileSync(s));
          }
        };
        addDir(sourcePath, "");
        return importFullExport(zip);
      }
      return importSingleBoard(null, sourcePath);
    }
    if (path.extname(sourcePath).toLowerCase() !== ".zip") throw new Error("pick a .zip export, or the folder it unzips to");
    const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
    if (zip.file("bowerbird-export.json") || Object.keys(zip.files).some((n) => n.startsWith("boards/"))) {
      return importFullExport(zip);
    }
    return importSingleBoard(zip, null);
  }

  return { buildFullExportZip, importExport };
}
