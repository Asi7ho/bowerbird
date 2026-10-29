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
const path = require('node:path');
const { Readable } = require('node:stream');

let win = null;
let boardView = null;

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
    title: 'Bowerbird',
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
  for (const name of ['welcome-bower.jpg', 'welcome-kyoto.jpg', 'welcome-brutalist.jpg']) {
    const dest = path.join(dir, name);
    if (!fs.existsSync(dest) && fs.existsSync(path.join(src, name))) {
      fs.copyFileSync(path.join(src, name), dest);
    }
  }
  const pdf = path.join(dir, 'sample.pdf');
  if (!fs.existsSync(pdf) && fs.existsSync(path.join(src, 'sample.pdf'))) {
    fs.copyFileSync(path.join(src, 'sample.pdf'), pdf);
  }
  try {
    return fs.statSync(pdf).size;
  } catch {
    return 0;
  }
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
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.txt': 'text/plain',
  '.md': 'text/markdown',
};

// ---------------------------------------------------------------- window

function iconPath() {
  const file = path.join(__dirname, '..', 'assets', 'icon.png');
  return fs.existsSync(file) ? file : null;
}

function createWindow() {
  win = new BaseWindow({
    width: 1440,
    height: 900,
    frame: false,
    title: 'Bowerbird',
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
    boardView.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  });
  win.on('closed', () => {
    win = null;
    boardView = null;
  });
  // Full work area.
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  win.setBounds({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: Math.min(900, wa.height),
  });
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('bowerbird:load-board', () => {
    const file = boardPath();
    const dir = path.dirname(file);
    let pdfSize = 0;
    if (!fs.existsSync(file)) pdfSize = installShowcaseAssets(dir);
    let json = null;
    try {
      json = fs.readFileSync(file, 'utf8');
    } catch {
      json = null;
    }
    return { json, board_path: file, board_dir: dir, pdf_size_bytes: pdfSize };
  });

  ipcMain.handle('bowerbird:save-board', (_event, json) => {
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
    const file = boardPath();
    const dir = path.dirname(file);
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    try { fs.rmSync(path.join(dir, 'assets'), { recursive: true, force: true }); } catch { /* already gone */ }
    return installShowcaseAssets(dir);
  });

  ipcMain.handle('bowerbird:embed-file', (_event, filePath) => {
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
    saveAppSettings();
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
      return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
        headers: { 'Content-Type': type },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  loadAppSettings();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
