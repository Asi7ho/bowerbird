// Bowerbird on Electron.
// One frameless BaseWindow. The board is a WebContentsView filling it.
// There is no handle tab. A floating button in a corner of the
// board hides the whole board into that corner (see the peek
// below): the board window hides and a small corner of the board
// itself stays visible at the screen corner. Clicking that corner
// opens the board again, back in its saved bounds.
// Link cards are previews only — no embedded pages — so there is no
// second view type: a link card shows the site's own image, icon and
// title, and clicking it opens the site in the browser.
// The board file format is unchanged from the GPUI board, so existing
// boards load as-is (an old embed:true flag is simply ignored).

const { app, BaseWindow, WebContentsView, ipcMain, shell, protocol, screen, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

let win = null;
let boardView = null;

// ---------------------------------------------------------------- demo mode

// BOWERBIRD_DEMO=1 runs a demo that saves nothing, anywhere:
// no board file, no settings file, no showcase copies, no dropped
// file copies, no reset/delete. The demo always starts from the
// welcome board, with its media read straight from the app's own
// assets folder, and everything the user does lives only in
// memory until quit. The real board and settings are never even
// opened, so a demo can never overwrite or delete them. Every
// write path below checks DEMO first, and the renderer also
// short-circuits save() in demo mode, so a write needs both
// guards to fail before anything could reach disk.
// Demo mode is on either by environment (running from source with
// BOWERBIRD_DEMO=1) or by a demo-mode marker file next to the app
// code (Contents/Resources/app/demo-mode in a packaged demo).
// The marker is how an installed demo knows it is a demo: a user
// who installs the demo DMG does not set any environment variable,
// and macOS does not reliably pass one through Finder launches.
// Once DEMO is known, it is also written back into process.env so
// the preload bridge — which only reads the environment — reports
// isDemo correctly in a packaged demo too. The marker file is
// created only in the demo staging folder by package-demo.sh;
// it must never be committed at the repo root, or source runs
// would become demos.
const DEMO = process.env.BOWERBIRD_DEMO === "1" || fs.existsSync(path.join(__dirname, "..", "demo-mode"));
if (DEMO) {
  process.env.BOWERBIRD_DEMO = "1";
  try {
    app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-demo-")));
  } catch {
    // If the redirect fails, the demo guards below still prevent
    // any board or settings write; only Chromium cache would land
    // in the normal userData folder.
  }
}
function demoShowcaseSizes() {
  const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
  const dir = assetsDir();
  return {
    pdf_size_bytes: sizeOf(path.join(dir, "sample.pdf")),
    video_size_bytes: sizeOf(path.join(dir, "welcome-video.mp4")),
  };
}

// ---------------------------------------------------------------- corner reveal

// Which screen corner reveals the board, chosen in Settings.
// Default bottom-left, per the user's choice. "off" disables it.
const CORNERS = ["bottom-left", "bottom-right", "top-left", "top-right", "off"];
let cornerReveal = "bottom-left";
// Panel tab order, as the user dragged it: an array of
// "pluginId:panelId" keys, in tab-bar order. Panels not in
// the list (new plugins, or a first run) go at the end, in
// registration order, so an old list never hides a panel.
let panelOrder = [];

function appSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadAppSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(appSettingsPath(), "utf8"));
    if (parsed && CORNERS.includes(parsed.corner)) cornerReveal = parsed.corner;
    if (parsed && Array.isArray(parsed.panelOrder)) panelOrder = parsed.panelOrder.filter((x) => typeof x === "string");
  } catch {
    // No settings file yet: keep the default.
  }
}

function saveAppSettings() {
  try {
    const file = appSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ corner: cornerReveal, panelOrder }));
    fs.renameSync(tmp, file);
  } catch {
    // Settings are a convenience, not board data: never fail the app
    // over a settings write.
  }
}

// Corner icon: the board hides into a corner, it does not vanish.
// The floating button in the board (see src/main.ts) asks the main
// process to collapse. The board window hides and only a small
// round icon stays visible at the chosen screen corner. Clicking
// the icon restores the board to its saved bounds. This is a real
// window receiving a real click, so it works whether or not the
// main process could query the cursor while hidden — the previous
// trigger-window approach was dropped for exactly that reason,
// and a cursor poll was dropped earlier because Electron's cursor
// query froze at the last position before the board hid. No
// screenshot is needed: the icon is just an icon.
// The window is 80px so the 56px circle sits with a 12px margin
// from the screen edges and room to grow slightly on hover.
const PEEK_W = 80;
const PEEK_H = 80;
let peekWin = null;
let savedBounds = null;
let isCollapsed = false;

function cornerOrigin(w, h) {
  const display = screen.getPrimaryDisplay();
  const b = display.bounds;
  if (cornerReveal === "bottom-left") return { x: b.x, y: b.y + b.height - h };
  if (cornerReveal === "bottom-right") return { x: b.x + b.width - w, y: b.y + b.height - h };
  if (cornerReveal === "top-left") return { x: b.x, y: b.y };
  if (cornerReveal === "top-right") return { x: b.x + b.width - w, y: b.y };
  return null;
}

function peekBounds() {
  const origin = cornerOrigin(PEEK_W, PEEK_H);
  return origin ? { ...origin, width: PEEK_W, height: PEEK_H } : null;
}

async function collapseBoard() {
  if (!win || isCollapsed || !boardView) return;
  const bounds = peekBounds();
  if (!bounds) return; // Corner is Off: the button is hidden, so this should not happen.
  savedBounds = win.getBounds();
  const { BrowserWindow } = require('electron');
  peekWin = new BrowserWindow({
    width: PEEK_W,
    height: PEEK_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: DEMO ? 'Bowerbird \u2014 Demo' : 'Bowerbird',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try { peekWin.setAlwaysOnTop(true, 'screen-saver'); } catch { /* level is macOS-only */ }
  peekWin.setBounds(bounds);
  // The corner tells the icon which way its expand arrow points:
  // away from the corner, into the screen.
  peekWin.loadFile(path.join(__dirname, 'peek.html'), { query: { corner: cornerReveal } });
  peekWin.on('closed', () => { peekWin = null; });
  win.hide();
  isCollapsed = true;
}

function restoreBoard() {
  if (!win) return;
  if (peekWin) { peekWin.destroy(); peekWin = null; }
  isCollapsed = false;
  win.show();
  if (win.isMinimized()) win.restore();
  if (savedBounds) win.setBounds(savedBounds);
  win.focus();
}

// ---------------------------------------------------------------- board file

function boardPath() {
  if (process.env.BOWERBIRD_BOARD_PATH) return process.env.BOWERBIRD_BOARD_PATH;
  if (process.env.QB_BOARD_PATH) return process.env.QB_BOARD_PATH;
  const base = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(process.env.HOME || '.', '.local', 'share');
  const next = path.join(base, 'bowerbird', 'board.json');
  if (!fs.existsSync(next)) {
    const old = path.join(base, 'quickboard', 'board.json');
    if (fs.existsSync(old)) return old;
  }
  return next;
}

function boardDir() {
  return path.dirname(boardPath());
}

// Build identifier, so a user can tell which packaged build
// they are actually running (Settings → General → Data).
// package-mac.sh writes dist/build-id.txt with the git short
// hash at packaging time; source runs without it read "dev".
function buildId() {
  for (const candidate of [
    path.join(__dirname, '..', 'dist', 'build-id.txt'),
    path.join(app.getAppPath(), 'dist', 'build-id.txt'),
  ]) {
    try {
      const id = fs.readFileSync(candidate, 'utf8').trim();
      if (id) return id;
    } catch { /* no build id in this run */ }
  }
  return 'dev';
}

function assetsDir() {
  const candidates = [
    path.join(__dirname, '..', 'assets'),
    path.join(process.cwd(), 'assets'),
    path.join(app.getAppPath(), 'assets'),
    // Packaged Mac app, via resourcesPath, in case __dirname
    // or getAppPath ever resolve differently (translocation,
    // a renamed bundle): Resources/app/assets is where the
    // packaging script puts the showcase files, full stop.
    path.join(process.resourcesPath || '', 'app', 'assets'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'sample.pdf'))) return dir;
  }
  return candidates[0];
}

function installShowcaseAssets(dir, force = false) {
  fs.mkdirSync(dir, { recursive: true });
  const src = assetsDir();
  const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
  const copied = [];
  const missing = [];
  // Real photographs for the welcome board (Wikimedia Commons).
  // Normally only fills in what is missing, so a reset that
  // deletes the board dir gets a full fresh set, while an
  // existing board keeps the copies it already has. But a
  // file that exists with the wrong size — empty, truncated,
  // a failed earlier copy — is just as broken as a missing
  // file, and the old missing-only check left it broken
  // forever. So copy when missing, when forced (the Restore
  // button), or when the size does not match the bundle.
  for (const name of ['welcome-bower.jpg', 'welcome-birdsong.mp3', 'welcome-video.mp4', 'sample.pdf']) {
    const srcFile = path.join(src, name);
    const dest = path.join(dir, name);
    if (!fs.existsSync(srcFile)) { missing.push(name); continue; }
    if (force || !fs.existsSync(dest) || sizeOf(dest) !== sizeOf(srcFile)) {
      try { fs.copyFileSync(srcFile, dest); copied.push(name); } catch (e) { missing.push(`${name} (${e.message})`); }
    }
  }
  const pdf = path.join(dir, 'sample.pdf');
  return {
    pdf_size_bytes: sizeOf(pdf),
    video_size_bytes: sizeOf(path.join(dir, 'welcome-video.mp4')),
    copied,
    missing,
    srcDir: src,
    destDir: dir,
  };
}

function sanitise(name) {
  let out = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (out.length > 64) out = out.slice(0, 64);
  return out || 'file';
}

// ---------------------------------------------------------------- link preview

function decodeEntities(s) {
  let out = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  out = out.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (_m, num) => {
    const code = num.startsWith('x') ? parseInt(num.slice(1), 16) : parseInt(num, 10);
    return Number.isNaN(code) ? _m : String.fromCodePoint(code);
  });
  return out;
}

function metaContent(html, property) {
  const re = /<meta[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (tag.includes(`property="${property}"`) || tag.includes(`property='${property}'`) || tag.includes(`name="${property}"`)) {
      const cm = /content=(?:"([^"]*)"|'([^']*)')/.exec(tag);
      if (cm) {
        const value = decodeEntities((cm[1] ?? cm[2] ?? '').trim());
        if (value) return value;
      }
    }
  }
  return null;
}

function tagContent(html, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(html);
  if (!m) return null;
  const value = decodeEntities(m[1].trim());
  return value || null;
}

// Href of the first <link> whose rel matches one of the wanted kinds
// (e.g. "icon", "apple-touch-icon"), or null.
function linkHref(html, kinds) {
  const re = /<link[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const rel = /rel=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const href = /href=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!rel || !href) continue;
    const relLower = (rel[1] ?? rel[2] ?? '').toLowerCase();
    const hrefValue = decodeEntities((href[1] ?? href[2] ?? '').trim());
    if (hrefValue && kinds.some((k) => relLower.includes(k))) return hrefValue;
  }
  return null;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.ogv': 'video/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.txt': 'text/plain',
  '.md': 'text/markdown',
};

// ---------------------------------------------------------------- window

function iconPath() {
  const file = path.join(__dirname, '..', 'assets', 'icon.png');
  return fs.existsSync(file) ? file : null;
}

function createWindow() {
  // Default size: 1280x850, centred in the work area (so it never
  // sits under the menu bar or the Dock). 1100x720 is also the
  // minimum size: the window cannot be resized smaller than this.
  // 800x600 was too small on a Mac screen: the board felt cramped
  // and the welcome board needed scrolling to be seen at all,
  // and 1200x800 still felt a little small, hence one more step up.
  const wa0 = screen.getPrimaryDisplay().workArea;
  // Screenshot override (not a user setting): BOWERBIRD_WINDOW_SIZE
  // e.g. 1440x900 makes the window fill the frame for App Store
  // screenshots. Used only by screenshots/README.md recapture
  // instructions. The 1100x720 minimum still applies to it.
  const sizeOverride = /^([0-9]+)x([0-9]+)$/.exec(process.env.BOWERBIRD_WINDOW_SIZE || "");
  // The minimum applies to the initial size too, not just to
  // later resizing: an override smaller than 1100x720 still opens
  // at 1100x720.
  const defaultWidth = Math.max(sizeOverride ? Number(sizeOverride[1]) : 1280, 1100);
  const defaultHeight = Math.max(sizeOverride ? Number(sizeOverride[2]) : 850, 720);
  const defaultX = wa0.x + Math.round((wa0.width - defaultWidth) / 2);
  const defaultY = wa0.y + Math.round((wa0.height - defaultHeight) / 2);
  win = new BaseWindow({
    width: defaultWidth,
    height: defaultHeight,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    title: DEMO ? 'Bowerbird \u2014 Demo' : 'Bowerbird',
    backgroundColor: '#ffffff',
    ...(iconPath() ? { icon: iconPath() } : {}),
  });
  boardView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(boardView);
  const bounds = win.getContentBounds();
  boardView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  if (process.env.ELECTRON_RENDERER_URL) {
    boardView.webContents.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    boardView.webContents.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  win.on('resize', () => {
    if (!win || !boardView) return;
    const b = win.getContentBounds();
    // Enforce the minimum in code, not just via minWidth/minHeight:
    // a programmatic resize (and, on bare X11, a window-manager
    // resize) can bypass the option, but it cannot bypass this.
    // Clamping triggers one more resize event, which then passes
    // this check and updates the board view.
    if (b.width < 1100 || b.height < 720) {
      win.setBounds({ x: b.x, y: b.y, width: Math.max(b.width, 1100), height: Math.max(b.height, 720) });
      return;
    }
    boardView.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  });
  win.on('closed', () => {
    win = null;
    boardView = null;
  });
  win.setBounds({
    x: defaultX,
    y: defaultY,
    width: defaultWidth,
    height: defaultHeight,
  });
}

// ---------------------------------------------------------------- plugins

// Plugin discovery (see PLUGIN_API.md). Order matters: the first
// plugin with a given id wins, and duplicates are skipped.
//   1. BOWERBIRD_PLUGINS_DIR, if set (development / testing)
//   2. The user plugins folder next to the board data
//   3. Bundled plugins inside the app (app/plugins, or plugins/
//      next to the repo root when running from source)
// A plugin is a subfolder with a manifest.json. Invalid manifests
// are skipped, never fatal: one bad plugin must not break the list.
const pluginDirs = new Map(); // id -> folder, refreshed by listPlugins

function pluginCandidates() {
  const out = [];
  if (process.env.BOWERBIRD_PLUGINS_DIR) {
    out.push({ dir: process.env.BOWERBIRD_PLUGINS_DIR, source: "user" });
  }
  const base = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(process.env.HOME || ".", ".local", "share");
  out.push({ dir: path.join(base, "bowerbird", "plugins"), source: "user" });
  for (const dir of [
    path.join(app.getAppPath(), "plugins"),
    path.join(process.cwd(), "plugins"),
    path.join(__dirname, "..", "plugins"),
  ]) {
    out.push({ dir, source: "bundled" });
  }
  return out;
}

function pluginEnabledPath() {
  return path.join(app.getPath("userData"), "plugins.json");
}

function loadPluginEnabled() {
  try {
    const parsed = JSON.parse(fs.readFileSync(pluginEnabledPath(), "utf8"));
    if (parsed && typeof parsed.enabled === "object" && parsed.enabled !== null) {
      return parsed.enabled;
    }
  } catch {
    // No file yet: everything defaults to enabled.
  }
  return {};
}

function savePluginEnabled(enabled) {
  try {
    const file = pluginEnabledPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ enabled }));
    fs.renameSync(tmp, file);
  } catch {
    // Plugin toggles are a convenience, not board data.
  }
}

function listPlugins() {
  const enabled = loadPluginEnabled();
  const seen = new Set();
  const out = [];
  pluginDirs.clear();
  for (const { dir, source } of pluginCandidates()) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // Folder does not exist yet: fine, not an error.
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(dir, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
      } catch {
        continue; // No manifest, or broken JSON: skip, do not fail the list.
      }
      if (!manifest || typeof manifest.id !== "string" || !/^[a-z0-9-]+$/.test(manifest.id)) continue;
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
      if (typeof manifest.apiVersion !== "string" || typeof manifest.main !== "string") continue;
      if (seen.has(manifest.id)) continue; // First place wins.
      seen.add(manifest.id);
      pluginDirs.set(manifest.id, folder);
      out.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        description: typeof manifest.description === "string" ? manifest.description : "",
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        main: manifest.main,
        styles: Array.isArray(manifest.styles) ? manifest.styles : [],
        contributions: manifest.contributions && typeof manifest.contributions === "object" ? manifest.contributions : {},
        source,
        enabled: enabled[manifest.id] !== false,
      });
    }
  }
  return out;
}

function pluginStoragePath() {
  return path.join(app.getPath("userData"), "plugin-storage.json");
}

function loadPluginStorage() {
  try {
    const parsed = JSON.parse(fs.readFileSync(pluginStoragePath(), "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // No file yet.
  }
  return {};
}

function savePluginStorage(data) {
  const file = pluginStoragePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// Secure storage: for secrets like an AI provider key, which
// must survive restarts but must not sit in plain text in
// plugin-storage.json. On macOS this is the Keychain, via
// safeStorage; where the OS cannot encrypt (some Linux
// setups), the value is still stored, but flagged plain, and
// the plugin UI says so plainly instead of pretending it
// is encrypted. Secure values live in their own file, so a
// plain storage read can never return a secret by accident.
function secureStoragePath() {
  return path.join(app.getPath("userData"), "secure-storage.json");
}
function loadSecureStorage() {
  try {
    const parsed = JSON.parse(fs.readFileSync(secureStoragePath(), "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // No file yet.
  }
  return {};
}
function saveSecureStorage(data) {
  const file = secureStoragePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function secureStorageAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

// ---------------------------------------------------------------- IPC

// Security boundaries for the renderer. The renderer (and any
// plugin running in it) can call the bridge, so the main process
// is the only place a path or URL check can be enforced:
//  - app-file: only board files and app assets are served.
//    Without this, any renderer code could fetch
//    app-file:///etc/passwd or a private key and read it
//    through the scheme, bypassing the plugin files:read
//    permission entirely (the scheme has no permission check).
//    Legitimate media is always board-owned: dropped files
//    are copied into boardDir()/assets, the welcome board
//    lives in boardDir(), and demo mode uses assetsDir().
//  - openExternal: https URLs open in the browser; anything
//    else must be a board-local file (a PDF, image or video
//    card). A shared board must not be able to make a click
//    on what looks like a web link open a local app or script.
//  - fetchPreview: only public http(s) URLs. A link card is
//    user-initiated, but a shared board or a pasted URL must
//    not turn the main process into a probe for localhost
//    or private-network services. This blocks IP literals
//    and localhost names; a DNS name that resolves to a
//    private address after this check (DNS rebinding) is
//    still out of scope, and is noted in PLUGIN_API.md.
function isBoardLocal(filePath) {
  try {
    const resolved = path.resolve(filePath);
    for (const root of [boardDir(), assetsDir()]) {
      const r = path.resolve(root);
      if (resolved === r || resolved.startsWith(r + path.sep)) return true;
    }
  } catch { /* not a path: not board-local */ }
  return false;
}
function isPrivateHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".local") || h === "0.0.0.0") return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127 || (a === 169 && b === 254)) return true;
    return false;
  }
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc00:") || h.startsWith("fd00:") || h.startsWith("::ffff:127.") || h.startsWith("::ffff:10.") || h.startsWith("::ffff:192.168.")) return true;
  return false;
}

function registerIpc() {
  ipcMain.handle('bowerbird:load-board', () => {
    if (DEMO) {
      return { json: null, board_path: '', board_dir: assetsDir(), buildId: buildId(), ...demoShowcaseSizes() };
    }
    const file = boardPath();
    const dir = path.dirname(file);
    // Always fill in missing welcome files, not only on first
    // run: a board created before the welcome files existed,
    // or a board whose files were deleted, otherwise stays
    // broken forever — the image shows nothing, audio and
    // video play nothing, and nothing ever repairs it.
    // installShowcaseAssets only fills what is missing, so
    // this never overwrites a user's own files.
    let showcase = installShowcaseAssets(dir);
    let json = null;
    try {
      json = fs.readFileSync(file, 'utf8');
    } catch {
      json = null;
    }
    // One-time migration: the welcome video was Theora (.ogv),
    // which Chromium cannot play inline, and is now H.264 (.mp4).
    // An existing board pointing at the old file gets the new
    // file installed and its reference rewritten, so it plays in
    // the board without the user having to reset their board.
    if (json && json.includes('welcome-video.ogv')) {
      const src = path.join(assetsDir(), 'welcome-video.mp4');
      const dest = path.join(dir, 'welcome-video.mp4');
      try {
        if (fs.existsSync(src) && !fs.existsSync(dest)) fs.copyFileSync(src, dest);
        if (fs.existsSync(dest)) {
          json = json.split('welcome-video.ogv').join('welcome-video.mp4');
          fs.writeFileSync(file, json);
        }
      } catch { /* old reference stays, video still opens outside */ }
    }
    return { json, board_path: file, board_dir: dir, panelOrder: [...panelOrder], buildId: buildId(), ...showcase };
  });

  ipcMain.handle('bowerbird:save-board', (_event, json) => {
    if (DEMO) return;
    const file = boardPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  });

  // Delete/reset: remove everything saved in the whiteboard — the
  // board file and every board-owned file in its assets folder
  // (dropped images, PDFs, audio, video) — then reinstall the
  // showcase assets so a fresh welcome board can be built.
  // App settings (e.g. the corner) are NOT touched: they are not
  // board data. Returns the PDF size for the fresh welcome board.
  ipcMain.handle('bowerbird:reset-board', () => {
    if (DEMO) return demoShowcaseSizes();
    const file = boardPath();
    const dir = path.dirname(file);
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    try { fs.rmSync(path.join(dir, 'assets'), { recursive: true, force: true }); } catch { /* already gone */ }
    return installShowcaseAssets(dir);
  });

  // Force-restore the welcome media, even if files already
  // exist: the Settings button for a board whose image,
  // audio or video shows "File missing". Returns what was
  // copied and what could not be found, so the user can
  // report the exact failure instead of a blank card.
  ipcMain.handle('bowerbird:restore-showcase', () => {
    if (DEMO) return { copied: [], missing: ['demo mode'], srcDir: assetsDir(), destDir: '' };
    const dir = path.dirname(boardPath());
    try {
      return installShowcaseAssets(dir, true);
    } catch (e) {
      return { copied: [], missing: [String(e.message)], srcDir: assetsDir(), destDir: dir };
    }
  });

  // Visual Library folder: a user's personal collection of images
  // and PDFs, next to the board (board/library/). In demo mode it
  // lives under the demo's temp userData, so a demo never reads
  // or writes the real library. Listing and copying are scoped to
  // this one folder only: a plugin never gets an arbitrary path
  // to list or an arbitrary destination to copy to.
  function libraryDir() {
    if (DEMO) return path.join(app.getPath('userData'), 'library');
    return path.join(boardDir(), 'library');
  }
  const LIBRARY_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']);
  ipcMain.handle('bowerbird:list-library', () => {
    const dir = libraryDir();
    const items = [];
    const folderCounts = new Map();
    const folders = [];
    // Recursive walk, sorted, capped at 1000 items. A category is
    // an immediate subfolder of the library: a file's category is
    // the first segment of its path under the library, or null
    // for files in the library root (shown as Uncategorized).
    // Empty folders still appear as categories, so a category a
    // user just created is visible before anything is put in it.
    const walk = (current, relBase) => {
      let entries = [];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(current, ent.name);
        const rel = relBase ? path.join(relBase, ent.name) : ent.name;
        if (ent.isDirectory()) {
          if (!relBase) folders.push(ent.name);
          walk(full, rel);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (!LIBRARY_EXTS.has(ext)) continue;
          if (items.length >= 1000) return;
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          const category = relBase ? relBase.split(path.sep)[0] : null;
          if (category) folderCounts.set(category, (folderCounts.get(category) || 0) + 1);
          items.push({
            name: ent.name,
            path: full,
            relativePath: rel.split(path.sep).join('/'),
            ext,
            kind: ext === '.pdf' ? 'pdf' : 'image',
            category,
            size_bytes: st.size,
            mtime_ms: st.mtimeMs,
          });
        }
      }
    };
    walk(dir, '');
    folders.sort();
    const categories = folders.map((name) => ({ name, count: folderCounts.get(name) || 0 }));
    const uncategorizedCount = items.filter((it) => it.category === null).length;
    return { path: dir, items, categories, uncategorizedCount };
  });
  ipcMain.handle('bowerbird:create-library-category', (_event, name) => {
    if (typeof name !== 'string') throw new Error('category name must be a string');
    const clean = name.trim();
    if (!clean || clean.length > 100) throw new Error('category name is empty or too long');
    if (clean.includes('/') || clean.includes('\\') || clean.includes('..') || clean.startsWith('.')) {
      throw new Error('category name must be a single folder name');
    }
    if (clean.toLowerCase() === 'all' || clean.toLowerCase() === 'uncategorized') {
      throw new Error('All and Uncategorized are reserved');
    }
    const dir = path.join(libraryDir(), clean);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });

  ipcMain.handle('bowerbird:move-library-item', (_event, relativePath, category) => {
    // Move a library file to another category (a subfolder), or to
    // the library root when category is null (Uncategorized).
    // Scoped: the source must already be inside the library, the
    // destination stays inside it, and only library extensions move.
    if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') || relativePath.includes('..')) {
      throw new Error('invalid library path');
    }
    const lib = libraryDir();
    const src = path.join(lib, relativePath);
    if (!src.startsWith(lib + path.sep)) throw new Error('source is outside the library');
    const ext = path.extname(src).toLowerCase();
    if (!LIBRARY_EXTS.has(ext)) throw new Error('not a library file');
    let st;
    try { st = fs.statSync(src); } catch { throw new Error('library file not found'); }
    if (!st.isFile()) throw new Error('not a file');
    let destDir = lib;
    if (category !== null && category !== undefined) {
      if (typeof category !== 'string') throw new Error('category must be a string or null');
      const clean = category.trim();
      if (!clean || clean.length > 100 || clean.includes('/') || clean.includes('\\') || clean.includes('..') || clean.startsWith('.')) {
        throw new Error('category name must be a single folder name');
      }
      if (clean.toLowerCase() === 'all' || clean.toLowerCase() === 'uncategorized') {
        throw new Error('All and Uncategorized are reserved');
      }
      destDir = path.join(lib, clean);
      fs.mkdirSync(destDir, { recursive: true });
    }
    const base = path.basename(src);
    let dest = path.join(destDir, base);
    if (dest === src) return relativePath.split(path.sep).join('/');
    // Deduplicate like embedFile/addToLibrary: stem-1, stem-2, …
    if (fs.existsSync(dest)) {
      const stem = path.basename(base, ext);
      let n = 1;
      do { dest = path.join(destDir, `${stem}-${n}${ext}`); n += 1; } while (fs.existsSync(dest));
    }
    fs.renameSync(src, dest);
    return path.relative(lib, dest).split(path.sep).join('/');
  });

  ipcMain.handle('bowerbird:add-to-library', (_event, filePath) => {
    const dir = libraryDir();
    fs.mkdirSync(dir, { recursive: true });
    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(dir);
    if (resolved.startsWith(resolvedDir + path.sep)) return filePath;
    const clean = sanitise(path.basename(filePath));
    let dest = path.join(dir, clean);
    let n = 1;
    while (fs.existsSync(dest)) {
      const ext = path.extname(clean);
      const stem = path.basename(clean, ext);
      dest = path.join(dir, ext ? `${stem}-${n}${ext}` : `${stem}-${n}`);
      n += 1;
    }
    fs.copyFileSync(filePath, dest);
    return dest;
  });

  ipcMain.handle('bowerbird:embed-file', (_event, filePath) => {
    if (DEMO) return filePath;
    const assets = path.join(boardDir(), 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const resolved = path.resolve(filePath);
    const resolvedAssets = path.resolve(assets);
    if (resolved.startsWith(resolvedAssets + path.sep)) return filePath;
    const clean = sanitise(path.basename(filePath));
    let dest = path.join(assets, clean);
    let n = 1;
    while (fs.existsSync(dest)) {
      const ext = path.extname(clean);
      const stem = path.basename(clean, ext);
      dest = path.join(assets, ext ? `${stem}-${n}${ext}` : `${stem}-${n}`);
      n += 1;
    }
    fs.copyFileSync(filePath, dest);
    return dest;
  });

  ipcMain.handle('bowerbird:read-text-file', (_event, filePath) => fs.readFileSync(filePath, 'utf8'));
  ipcMain.handle('bowerbird:file-size', (_event, filePath) => fs.statSync(filePath).size);

  ipcMain.handle('bowerbird:fetch-preview', async (_event, url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('preview URL is not a valid URL');
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || isPrivateHost(parsed.hostname)) {
      throw new Error('preview URL is not a public web address');
    }
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Bowerbird/0.1' },
      signal: AbortSignal.timeout(6000),
    });
    // fetch follows redirects, so a public URL could redirect
    // to a private one; check where it actually landed too.
    try {
      if (res.url && isPrivateHost(new URL(res.url).hostname)) {
        throw new Error('preview URL redirected to a private address');
      }
    } catch (e) {
      if (e.message && e.message.includes('private address')) throw e;
    }
    const text = (await res.text()).slice(0, 300000);
    // Resolve a possibly-relative image/icon URL against the page URL,
    // and only ever hand the renderer an http(s) URL.
    const resolveHttp = (href) => {
      if (!href) return null;
      try {
        const u = new URL(href, url);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
      } catch {
        return null;
      }
    };
    const image = resolveHttp(
      metaContent(text, 'og:image') || metaContent(text, 'twitter:image') || metaContent(text, 'og:image:secure_url')
    );
    let icon = resolveHttp(linkHref(text, ['icon', 'apple-touch-icon']));
    if (!icon) {
      try {
        icon = `https://${new URL(url).hostname}/favicon.ico`;
      } catch {
        icon = null;
      }
    }
    return {
      title: metaContent(text, 'og:title') || metaContent(text, 'twitter:title') || tagContent(text, 'title'),
      description: metaContent(text, 'og:description') || metaContent(text, 'twitter:description') || metaContent(text, 'description'),
      image,
      icon,
    };
  });

  ipcMain.handle('bowerbird:open-external', (_event, target) => {
    if (typeof target !== 'string' || !target) throw new Error('nothing to open');
    if (/^https?:\/\//.test(target)) return shell.openExternal(target);
    // Local files: only board-local files (see isBoardLocal).
    // A file:// URL is unwrapped first, so file:///etc/passwd
    // does not slip past the check as a non-https string.
    let local = target;
    if (target.startsWith('file://')) {
      try { local = decodeURIComponent(new URL(target).pathname); } catch { throw new Error('not a board-local file'); }
    }
    if (isBoardLocal(local)) return shell.openPath(local);
    throw new Error('not a public web address or a board-local file');
  });
  ipcMain.handle('bowerbird:get-app-settings', () => ({ corner: cornerReveal, panelOrder: [...panelOrder] }));
  ipcMain.handle('bowerbird:set-panel-order', (_event, order) => {
    if (!Array.isArray(order)) return panelOrder;
    panelOrder = order.filter((x) => typeof x === "string").slice(0, 100);
    if (!DEMO) saveAppSettings();
    return panelOrder;
  });
  ipcMain.handle('bowerbird:list-plugins', () => listPlugins());
  ipcMain.handle('bowerbird:read-plugin-file', (_event, pluginId, relativePath) => {
    if (typeof pluginId !== "string" || typeof relativePath !== "string") {
      throw new Error("bad plugin file request");
    }
    let dir = pluginDirs.get(pluginId);
    if (!dir) {
      listPlugins();
      dir = pluginDirs.get(pluginId);
    }
    if (!dir) throw new Error(`unknown plugin ${pluginId}`);
    const ext = path.extname(relativePath).toLowerCase();
    if (![".js", ".css", ".json"].includes(ext)) {
      throw new Error(`plugin file type not allowed: ${ext}`);
    }
    const resolved = path.resolve(dir, relativePath);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
      throw new Error("plugin file path escapes its folder");
    }
    return fs.readFileSync(resolved, "utf8");
  });
  ipcMain.handle('bowerbird:set-plugin-enabled', (_event, pluginId, enabled) => {
    const map = loadPluginEnabled();
    map[pluginId] = enabled === true;
    savePluginEnabled(map);
    return map[pluginId];
  });
  // Install a plugin written by the Plugin Builder (or, in
  // future, any plugin with the plugins:install permission).
  // Writes only to the user plugins folder, never to the
  // bundled folder, and never overwrites an existing plugin:
  // a clash is an error the caller shows, not a silent
  // replacement. Blocked in demo mode, which saves nothing.
  ipcMain.handle('bowerbird:install-plugin', (_event, plugin) => {
    if (DEMO) throw new Error('cannot install a plugin in demo mode');
    if (!plugin || typeof plugin !== 'object') throw new Error('bad plugin');
    const { id, name, description, permissions, mainCode, styleCode } = plugin;
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error('plugin id must be lowercase letters, digits and hyphens');
    if (typeof name !== 'string' || !name.trim() || typeof mainCode !== 'string' || !mainCode.trim()) throw new Error('plugin name and code are required');
    if (mainCode.length > 200000 || (typeof styleCode === 'string' && styleCode.length > 200000)) throw new Error('plugin code is too large');
    if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== 'string')) throw new Error('plugin permissions must be strings');
    const base = process.env.XDG_DATA_HOME
      ? process.env.XDG_DATA_HOME
      : path.join(process.env.HOME || '.', '.local', 'share');
    const folder = path.join(base, 'bowerbird', 'plugins', id);
    if (fs.existsSync(folder)) throw new Error(`a plugin called ${id} already exists`);
    const styles = typeof styleCode === 'string' && styleCode.trim() ? ['style.css'] : [];
    const manifest = {
      apiVersion: '1',
      id,
      name: name.trim(),
      description: typeof description === 'string' ? description : '',
      version: '1.0.0',
      main: 'main.js',
      styles,
      permissions,
    };
    fs.mkdirSync(folder, { recursive: true });
    try {
      fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
      fs.writeFileSync(path.join(folder, 'main.js'), mainCode);
      if (styles.length) fs.writeFileSync(path.join(folder, 'style.css'), styleCode);
    } catch (e) {
      fs.rmSync(folder, { recursive: true, force: true });
      throw e;
    }
    return manifest;
  });
  // Chat completions for a plugin with the ai permission, run
  // in the main process, not the renderer: a browser fetch
  // from the renderer is subject to the provider's CORS
  // policy, and a local model server is http, not https.
  // Only the chat-completions path of the configured base
  // is ever called, with the caller's own key, which is
  // never stored here. Public bases must be https; a
  // localhost base may be http, for a local model server.
  // Other private addresses are refused, as with fetchPreview.
  ipcMain.handle('bowerbird:llm-chat', async (_event, req) => {
    if (!req || typeof req !== 'object') throw new Error('bad chat request');
    const { baseUrl, model, key, messages } = req;
    if (typeof baseUrl !== 'string' || typeof model !== 'string' || !model.trim()) throw new Error('a provider and model are required');
    if (!Array.isArray(messages) || messages.length === 0 || messages.some((m) => !m || typeof m.role !== 'string' || typeof m.content !== 'string')) throw new Error('bad chat messages');
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error('bad provider address'); }
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (!isLocal && (url.protocol !== 'https:' || isPrivateHost(url.hostname))) throw new Error('provider must be a public https address or localhost');
    if (isLocal && url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad provider address');
    const endpoint = new URL('chat/completions', url.href.endsWith('/') ? url.href : url.href + '/');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(endpoint.href, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(typeof key === 'string' && key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ model: model.trim(), messages, temperature: 0.2, max_tokens: 4000 }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`provider error ${res.status}: ${text.slice(0, 500)}`);
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('provider did not return JSON'); }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('provider returned no text');
      return content;
    } finally {
      clearTimeout(timer);
    }
  });
  ipcMain.handle('bowerbird:plugin-storage-get', (_event, pluginId, key) => {
    const data = loadPluginStorage();
    const per = data[pluginId];
    return per && typeof per === "object" ? (per[key] ?? null) : null;
  });
  ipcMain.handle('bowerbird:plugin-storage-set', (_event, pluginId, key, value) => {
    const data = loadPluginStorage();
    if (!data[pluginId] || typeof data[pluginId] !== "object") data[pluginId] = {};
    data[pluginId][key] = value;
    savePluginStorage(data);
  });
  ipcMain.handle('bowerbird:plugin-storage-delete', (_event, pluginId, key) => {
    const data = loadPluginStorage();
    if (data[pluginId] && typeof data[pluginId] === "object") {
      delete data[pluginId][key];
      savePluginStorage(data);
    }
  });
  ipcMain.handle('bowerbird:secure-storage-available', () => secureStorageAvailable());
  ipcMain.handle('bowerbird:secure-storage-get', (_event, pluginId, key) => {
    const data = loadSecureStorage();
    const per = data[pluginId];
    if (!per || typeof per !== "object" || !per[key]) return null;
    const entry = per[key];
    if (entry.encrypted) {
      try { return safeStorage.decryptString(Buffer.from(entry.value, "base64")); } catch { return null; }
    }
    return entry.value ?? null;
  });
  ipcMain.handle('bowerbird:secure-storage-set', (_event, pluginId, key, value) => {
    const data = loadSecureStorage();
    if (!data[pluginId] || typeof data[pluginId] !== "object") data[pluginId] = {};
    if (secureStorageAvailable()) {
      data[pluginId][key] = { encrypted: true, value: safeStorage.encryptString(String(value)).toString("base64") };
    } else {
      data[pluginId][key] = { encrypted: false, value: String(value) };
    }
    saveSecureStorage(data);
    return secureStorageAvailable();
  });
  ipcMain.handle('bowerbird:secure-storage-delete', (_event, pluginId, key) => {
    const data = loadSecureStorage();
    if (data[pluginId] && typeof data[pluginId] === "object") {
      delete data[pluginId][key];
      saveSecureStorage(data);
    }
  });
  ipcMain.handle('bowerbird:set-corner', (_event, corner) => {
    if (!CORNERS.includes(corner)) return cornerReveal;
    cornerReveal = corner;
    if (!DEMO) saveAppSettings();
    // Moving the icon while collapsed: it follows the new corner
    // and its arrow is re-pointed by reloading with the new corner.
    if (isCollapsed && peekWin) {
      const bounds = peekBounds();
      if (bounds) {
        peekWin.setBounds(bounds);
        peekWin.loadFile(path.join(__dirname, 'peek.html'), { query: { corner: cornerReveal } });
      }
    }
    return cornerReveal;
  });
  ipcMain.handle('bowerbird:collapse', () => collapseBoard());
  ipcMain.on('bowerbird:move-window', (_event, dx, dy) => {
    if (!win || isCollapsed) return;
    const b = win.getBounds();
    win.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height });
  });
  ipcMain.handle('bowerbird:restore', () => { restoreBoard(); });

  ipcMain.handle('bowerbird:minimise', () => { if (win) win.minimize(); });
  ipcMain.handle('bowerbird:close-window', () => { if (win) win.close(); });
  // Quit must quit the app, not just close the window: on macOS
  // closing the only window does not by itself end the app, and
  // BaseWindow.close() alone did not end the process in testing.
  ipcMain.handle('bowerbird:quit', () => { if (peekWin) peekWin.destroy(); if (win) win.destroy(); app.quit(); });
  ipcMain.handle('bowerbird:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
}

// ---------------------------------------------------------------- app

protocol.registerSchemesAsPrivileged([{
  scheme: 'app-file',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

app.whenReady().then(() => {
  if (process.platform === 'darwin' && iconPath()) {
    try { app.dock.setIcon(iconPath()); } catch { /* Dock icon is cosmetic */ }
  }
  // Local board files (images, audio, PDFs) reach the renderer through
  // this scheme, in dev and in a packaged build alike. The renderer
  // never gets a raw filesystem path it can use outside this scheme.
  protocol.handle('app-file', (request) => {
    try {
      const u = new URL(request.url);
      // A standard scheme parses app-file:///tmp/x as host "tmp" and
      // path "/x", so the real filesystem path is host + pathname.
      const raw = `/${u.hostname}${u.pathname}`;
      const filePath = raw.split('/').map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      }).join('/');
      // Only board-local files are served (see isBoardLocal
      // above). Any other path — /etc/passwd, a private key,
      // another app's data — is a 404, not a file, even
      // though the renderer asked for it by full path.
      if (!isBoardLocal(filePath)) {
        return new Response('not found', { status: 404 });
      }
      // Welcome-media fallback: a board item that points at
      // a welcome file in the board folder must still play
      // even if that board copy is missing or empty — which
      // is exactly the "File missing" state users kept
      // hitting on Mac, where the board-folder copy was
      // gone for reasons the load-time repair could not
      // fix. In that case serve the bundle copy, which is
      // always inside the app itself. A non-empty board
      // copy is never overridden: if the user replaced a
      // welcome file with their own image of the same name,
      // that file is the one served.
      const WELCOME = ['welcome-bower.jpg', 'welcome-birdsong.mp3', 'welcome-video.mp4', 'sample.pdf'];
      let servePath = filePath;
      if (WELCOME.includes(path.basename(filePath))) {
        let boardSize = -1;
        try { boardSize = fs.statSync(filePath).size; } catch { boardSize = -1; }
        if (boardSize <= 0) {
          const bundle = path.join(assetsDir(), path.basename(filePath));
          if (fs.existsSync(bundle)) servePath = bundle;
        }
      }
      const ext = path.extname(servePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      // Chromium's media player asks for byte ranges and refuses a
      // source it cannot seek in ("no supported source was found"
      // for audio served as an open-ended stream). Answer ranges
      // properly, and always send a length, so <audio> and <video>
      // work through this scheme just as <img> already did.
      let size;
      try {
        size = fs.statSync(servePath).size;
      } catch {
        return new Response('not found', { status: 404 });
      }
      // A bundle fallback that is itself empty is no better
      // than the missing board copy: fall through to 404 so
      // the renderer shows "File missing" instead of a blank
      // card that looks like a different bug.
      if (size <= 0 && servePath !== filePath) {
        return new Response('not found', { status: 404 });
      }
      const range = request.headers.get('range');
      if (request.method === 'HEAD') {
        return new Response(null, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
      }
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? parseInt(m[2], 10) : size - 1;
          if (start < size && end >= start && end < size) {
            return new Response(Readable.toWeb(fs.createReadStream(servePath, { start, end })), {
              status: 206,
              headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
            });
          }
          return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
      }
      return new Response(Readable.toWeb(fs.createReadStream(servePath)), {
        headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  if (!DEMO) loadAppSettings();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
