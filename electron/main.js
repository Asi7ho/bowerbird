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

const { app, BaseWindow, WebContentsView, ipcMain, shell, protocol, screen } = require('electron');
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
const DEMO = process.env.BOWERBIRD_DEMO === "1";
if (DEMO) {
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

function appSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadAppSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(appSettingsPath(), "utf8"));
    if (parsed && CORNERS.includes(parsed.corner)) cornerReveal = parsed.corner;
  } catch {
    // No settings file yet: keep the default.
  }
}

function saveAppSettings() {
  try {
    const file = appSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ corner: cornerReveal }));
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

function assetsDir() {
  const candidates = [
    path.join(__dirname, '..', 'assets'),
    path.join(process.cwd(), 'assets'),
    path.join(app.getAppPath(), 'assets'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'sample.pdf'))) return dir;
  }
  return candidates[0];
}

function installShowcaseAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const src = assetsDir();
  // Real photographs for the welcome board (Wikimedia Commons).
  // installShowcaseAssets only fills in what is missing, so a
  // reset that deletes the board dir gets a full fresh set, while
  // an existing board keeps the copies it already has.
  for (const name of ['welcome-bower.jpg', 'welcome-birdsong.mp3', 'welcome-video.mp4']) {
    const dest = path.join(dir, name);
    if (!fs.existsSync(dest) && fs.existsSync(path.join(src, name))) {
      fs.copyFileSync(path.join(src, name), dest);
    }
  }
  const pdf = path.join(dir, 'sample.pdf');
  if (!fs.existsSync(pdf) && fs.existsSync(path.join(src, 'sample.pdf'))) {
    fs.copyFileSync(path.join(src, 'sample.pdf'), pdf);
  }
  const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
  return {
    pdf_size_bytes: sizeOf(pdf),
    video_size_bytes: sizeOf(path.join(dir, 'welcome-video.mp4')),
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
  // Default size: 800x600, centred in the work area (so it never
  // sits under the menu bar or the Dock). 800x600 is also the
  // minimum size: the window cannot be resized smaller than this.
  const wa0 = screen.getPrimaryDisplay().workArea;
  // Screenshot override (not a user setting): BOWERBIRD_WINDOW_SIZE
  // e.g. 1440x900 makes the window fill the frame for App Store
  // screenshots. Used only by screenshots/README.md recapture
  // instructions. The 800x600 minimum still applies to it.
  const sizeOverride = /^([0-9]+)x([0-9]+)$/.exec(process.env.BOWERBIRD_WINDOW_SIZE || "");
  // The minimum applies to the initial size too, not just to
  // later resizing: an override smaller than 800x600 still opens
  // at 800x600.
  const defaultWidth = Math.max(sizeOverride ? Number(sizeOverride[1]) : 800, 800);
  const defaultHeight = Math.max(sizeOverride ? Number(sizeOverride[2]) : 600, 600);
  const defaultX = wa0.x + Math.round((wa0.width - defaultWidth) / 2);
  const defaultY = wa0.y + Math.round((wa0.height - defaultHeight) / 2);
  win = new BaseWindow({
    width: defaultWidth,
    height: defaultHeight,
    minWidth: 800,
    minHeight: 600,
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
    if (b.width < 800 || b.height < 600) {
      win.setBounds({ x: b.x, y: b.y, width: Math.max(b.width, 800), height: Math.max(b.height, 600) });
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

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('bowerbird:load-board', () => {
    if (DEMO) {
      return { json: null, board_path: '', board_dir: assetsDir(), ...demoShowcaseSizes() };
    }
    const file = boardPath();
    const dir = path.dirname(file);
    let showcase = { pdf_size_bytes: 0, video_size_bytes: 0 };
    if (!fs.existsSync(file)) showcase = installShowcaseAssets(dir);
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
    return { json, board_path: file, board_dir: dir, ...showcase };
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
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Bowerbird/0.1' },
      signal: AbortSignal.timeout(6000),
    });
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
    if (/^https?:\/\//.test(target)) return shell.openExternal(target);
    return shell.openPath(target);
  });
  ipcMain.handle('bowerbird:get-app-settings', () => ({ corner: cornerReveal }));
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
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      // Chromium's media player asks for byte ranges and refuses a
      // source it cannot seek in ("no supported source was found"
      // for audio served as an open-ended stream). Answer ranges
      // properly, and always send a length, so <audio> and <video>
      // work through this scheme just as <img> already did.
      let size;
      try {
        size = fs.statSync(filePath).size;
      } catch {
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
            return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
              status: 206,
              headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
            });
          }
          return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
      }
      return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
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
