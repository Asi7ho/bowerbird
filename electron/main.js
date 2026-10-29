// Bowerbird on Electron.
// One frameless BaseWindow. The board is a WebContentsView filling it.
// Link cards are previews only — no embedded pages — so there is no
// second view type: a link card shows the site's own image, icon and
// title, and clicking it opens the site in the browser.
// The board file format is unchanged from the GPUI board, so existing
// boards load as-is (an old embed:true flag is simply ignored).

const { app, BaseWindow, WebContentsView, ipcMain, shell, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

let win = null;
let boardView = null;

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
    if (fs.existsSync(path.join(dir, 'welcome.png'))) return dir;
  }
  return candidates[0];
}

function installShowcaseAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const src = assetsDir();
  const welcome = path.join(dir, 'welcome.png');
  if (!fs.existsSync(welcome) && fs.existsSync(path.join(src, 'welcome.png'))) {
    fs.copyFileSync(path.join(src, 'welcome.png'), welcome);
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

function createWindow() {
  win = new BaseWindow({
    width: 1440,
    height: 900,
    frame: false,
    title: 'Bowerbird',
    backgroundColor: '#ffffff',
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
  ipcMain.handle('bowerbird:minimise', () => { if (win) win.minimize(); });
  ipcMain.handle('bowerbird:close-window', () => { if (win) win.close(); });
  ipcMain.handle('bowerbird:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
}

// ---------------------------------------------------------------- app

protocol.registerSchemesAsPrivileged([{
  scheme: 'app-file',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

app.whenReady().then(() => {
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
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
