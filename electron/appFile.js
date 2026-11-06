// app-file: the custom scheme that serves local board files
// (images, audio, PDFs) to the renderer, in dev and in a
// packaged build alike. The renderer never gets a raw
// filesystem path it can use outside this scheme.
// Only board-local files are served: any other path —
// /etc/passwd, a private key, another app's data — is a
// 404, not a file, even though the renderer asked for it
// by full path.
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.ogv': 'video/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.txt': 'text/plain',
  '.md': 'text/markdown',
};

// deps: isBoardLocal(path) (the board-local check),
// boardDir() and assetsDir() (current board folder / bundle assets).
function handleAppFileRequest(request, deps) {
  try {
    const u = new URL(request.url);
    // fileUrl() puts a literal localhost host in front of
    // the path, so the real path is the pathname alone.
    // The legacy host + pathname form is kept for URLs
    // built before that change: a standard scheme parses
    // app-file:///tmp/x as host "tmp" and path "/x".
    // Note the hostname is lowercased by Chromium, which
    // is why the legacy form broke Mac paths starting
    // with /Users — it arrived as /users and failed the
    // board-local check.
    const raw = (u.hostname === 'localhost' || !u.hostname) ? u.pathname : `/${u.hostname}${u.pathname}`;
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
    if (!deps.isBoardLocal(filePath)) {
      console.error(`[app-file] rejected (not board-local): ${filePath} (boardDir=${deps.boardDir()}, assetsDir=${deps.assetsDir()})`);
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
        const bundle = path.join(deps.assetsDir(), path.basename(filePath));
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
    // ETag from size + mtime, so a replaced file is a
    // different resource: render() recreates every <img>
    // on every rebuild, and without any cache headers
    // each one re-read the whole file through this
    // handler. With an ETag the browser revalidates
    // instead (304, no body, no file read), and a
    // replaced asset is never served stale.
    let size;
    let etag;
    try {
      const st = fs.statSync(servePath);
      size = st.size;
      etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
    } catch {
      console.error(`[app-file] not found on disk: ${servePath} (requested ${filePath})`);
      return new Response('not found', { status: 404 });
    }
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { 'ETag': etag, 'Accept-Ranges': 'bytes' } });
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
      return new Response(null, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'ETag': etag } });
    }
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        // A suffix range (bytes=-500) asks for the last
        // 500 bytes, not the first: RFC 9110. The old
        // code read an empty start as 0, so a player
        // seeking to the tail of a file got its head.
        let start;
        let end;
        if (!m[1] && m[2]) {
          const suffix = parseInt(m[2], 10);
          start = Math.max(0, size - suffix);
          end = size - 1;
        } else {
          start = m[1] ? parseInt(m[1], 10) : 0;
          end = m[2] ? parseInt(m[2], 10) : size - 1;
        }
        if (start < size && end >= start && end < size) {
          return new Response(Readable.toWeb(fs.createReadStream(servePath, { start, end })), {
            status: 206,
            headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'ETag': etag },
          });
        }
        return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
    }
    return new Response(Readable.toWeb(fs.createReadStream(servePath)), {
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'ETag': etag },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

module.exports = { handleAppFileRequest, MIME };
