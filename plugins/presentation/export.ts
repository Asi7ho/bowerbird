// Presentation — HTML export. All slides as one standalone
// file (bowerbird-slides.html): the first slide active in the
// HTML itself, navigation by the buttons or arrow keys, media
// embedded as data URLs where it fits. Files over the cap are
// skipped, not read, and shown as a placeholder instead.
import type { Item } from "../../src/model";
import { getApi, state } from "./state.js";
import type { Slide } from "./state.js";
import { drawingPrimitives } from "./geometry.js";
import { updatePanel } from "./panel.js";

// ---- Export -----------------------------------------------------------

// One escaping function for both text and attribute
// values in the export: escaping " as well as &, <, >
// is harmless in text, and required in attributes, so
// there is no need for two near-identical functions.
function escHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A media file too large to embed in the export,
// by name and megabytes, for the toast after export.
let oversizedExportFiles: Array<{ name: string; mb: number }> = [];
// Oversized files by URL, so the embed step can swap
// in the placeholder instead of a dead app-file URL.
const oversizedByUrl = new Map<string, string>();
// Embedding is base64, so a file costs ~1.37x its size
// in the output HTML and in memory while reading it: a
// single large video could balloon the export into
// hundreds of megabytes and hang it. Files over the cap
// are skipped, not read, and the export says so instead
// of shipping a dead app-file URL.
const EXPORT_FILE_MB = 25;

async function fetchDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > EXPORT_FILE_MB * 1024 * 1024) {
      const name = decodeURIComponent(url.split("/").pop() || "media file");
      const mb = Math.round(blob.size / 1024 / 1024);
      oversizedExportFiles.push({ name, mb });
      oversizedByUrl.set(url, oversizedPlaceholder(name, mb));
      return null;
    }
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// A placeholder image for media skipped as too large:
// an inline SVG naming the file, so the slide shows
// what is missing instead of a broken image.
function oversizedPlaceholder(name: string, mb: number): string {
  const text = `${name} — too large to embed (${mb} MB)`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#f5f5f7"/><text x="16" y="90" font-family="sans-serif" font-size="13" fill="#86868b">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function embedAppFiles(html: string): Promise<string> {
  // Embed in parallel, not one file at a time: a slide
  // with several images or videos used to wait for each
  // fetch + FileReader in turn, so export time grew
  // with the number of media files. The replacements
  // are independent (distinct URLs, string splits), so
  // running them together changes nothing about the
  // result, only how long it takes to get there.
  const urls = [...new Set(html.match(/app-file:\/\/[^"'\s<>]+/g) || [])];
  const dataUrls = await Promise.all(urls.map((url) => fetchDataUrl(url)));
  let out = html;
  urls.forEach((url, i) => {
    const dataUrl = dataUrls[i];
    if (dataUrl) {
      out = out.split(url).join(dataUrl);
    } else {
      const placeholder = oversizedByUrl.get(url);
      if (placeholder) out = out.split(url).join(placeholder);
    }
  });
  return out;
}

function exportSlideSvg(slide: Slide): string {
  const frame = slide.frame;
  let parts = "";
  for (const prim of drawingPrimitives(frame, slide.drawings)) {
    if (prim.type === "stroke") {
      parts += `<path d="${prim.d}" fill="none" stroke="${escHtml(prim.color)}" stroke-width="${prim.width}" stroke-linecap="round" stroke-linejoin="round"${prim.marker ? ' opacity="0.45"' : ""}/>`;
    } else {
      parts += `<line x1="${prim.a.x}" y1="${prim.a.y}" x2="${prim.b.x}" y2="${prim.b.y}" stroke="${escHtml(prim.color)}" stroke-width="2"/><polyline points="${prim.p1.x},${prim.p1.y} ${prim.b.x},${prim.b.y} ${prim.p2.x},${prim.p2.y}" fill="none" stroke="${escHtml(prim.color)}" stroke-width="2"/>`;
    }
  }
  if (!parts) return "";
  return `<svg width="${frame.size.w}" height="${frame.size.h}" viewBox="0 0 ${frame.size.w} ${frame.size.h}" style="position:absolute;left:0;top:0">${parts}</svg>`;
}

async function exportCardHtml(item: Item): Promise<string> {
  if ("Audio" in item.kind) {
    // The board's audio tile is a button that only the core
    // can play, so in a standalone file it would do nothing.
    // Export a native audio player instead, with the file
    // embedded, so the audio actually plays in the export.
    const path = item.kind.Audio.path;
    const name = path.split("/").pop() || "Audio";
    const dataUrl = await fetchDataUrl(getApi().files.fileUrl(path));
    if (!dataUrl) {
      // Too large (or unreadable): a dead app-file URL
      // would play nothing in a standalone file, so say
      // so on the card instead.
      const over = oversizedExportFiles.find((f) => f.name === name);
      const note = over ? `${name} — too large to embed (${over.mb} MB)` : `${name} — could not be embedded`;
      return `<div class="card" data-id="${item.id}" style="left:0px;top:0px;width:${item.size.w}px;height:${item.size.h}px"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px"><div class="title">${escHtml(note)}</div></div></div>`;
    }
    return `<div class="card" data-id="${item.id}" style="left:0px;top:0px;width:${item.size.w}px;height:${item.size.h}px"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px"><div class="title">${escHtml(name)}</div><audio controls src="${escHtml(dataUrl)}" style="width:100%"></audio></div></div>`;
  }
  let html = getApi().board.renderCard(item.id);
  if (!html) return "";
  if ("UrlCard" in item.kind) {
    // Link cards in the app are buttons that only the core
    // can open, so in a standalone file they would do
    // nothing. Turn them into real links to the URL.
    const href = escHtml(item.kind.UrlCard.url);
    html = html.replace(/<a ([^>]*?)data-action="open-link"([^>]*?)>/g, (_m, before, after) => {
      const attrs = (before + " " + after).replace(/\s*data-id="[^"]*"/g, "").trim();
      return `<a ${attrs} href="${href}" target="_blank" rel="noopener">`;
    });
  }
  if ("Video" in item.kind && item.kind.Video.remote) {
    // A remote video on the board is a thumbnail button
    // that only the core can open, so in a standalone
    // file it would do nothing. Turn it into a link to
    // the video, keeping its inline size.
    const href = escHtml(item.kind.Video.source);
    html = html.replace(/<div class="video-thumb clickable"[^>]*style="([^"]*)"[^>]*>([^<]*)<\/div>/, `<a class="video-thumb" style="$1" href="${href}" target="_blank" rel="noopener">$2</a>`);
  }
  return await embedAppFiles(html);
}

export async function exportSlides(): Promise<void> {
  const api = state.api;
  if (!api || state.slides.length === 0) return;
  oversizedExportFiles = [];
  oversizedByUrl.clear();
  const btn = state.panelExportBtn;
  const originalHtml = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Exporting…";
  }
  try {
    let sections = "";
    for (let si = 0; si < state.slides.length; si++) {
      const slide = state.slides[si];
      const frame = slide.frame;
      // Cards in a slide are independent, and
      // Promise.all keeps their order, so a slide's
      // cards embed in parallel instead of one by one.
      const cardHtmls = await Promise.all(slide.cards.map((item) => exportCardHtml(item)));
      let cardsHtml = "";
      slide.cards.forEach((item, i) => {
        const html = cardHtmls[i];
        if (!html) return;
        cardsHtml += `<div style="position:absolute;left:${item.pos.x - frame.pos.x}px;top:${item.pos.y - frame.pos.y}px;width:${item.size.w}px;height:${item.size.h}px">${html}</div>`;
      });
      // The first slide is active in the HTML itself, so
      // the page shows a slide even without JavaScript;
      // the script below then takes over navigation.
      const active = si === 0 ? " active" : "";
      sections += `<section class="slide${active}" style="width:${frame.size.w}px;height:${frame.size.h}px">${exportSlideSvg(slide)}${cardsHtml}</section>`;
    }
    const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bowerbird slides</title>
<style>
:root { --accent:#007aff; --ink:#1d1d1f; --grey:#86868b; --hairline:rgba(0,0,0,0.08); --separator:rgba(0,0,0,0.10); --bg-system:#f5f5f7; --shadow-sm:0 1px 2px rgba(0,0,0,0.06); }
body { margin:0; padding:32px; background:var(--bg-system); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif; letter-spacing:-0.01em; display:flex; flex-direction:column; align-items:center; gap:16px; }
.export-nav { display:flex; align-items:center; gap:16px; }
.export-nav button { flex:none; width:48px; height:48px; border:none; background:transparent; border-radius:9px; cursor:pointer; color:var(--grey); display:flex; align-items:center; justify-content:center; }
.export-nav button svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.export-nav button:hover { background:rgba(0,0,0,0.05); color:var(--ink); }
.export-nav button:disabled { opacity:0.35; cursor:default; }
.export-nav button:disabled:hover { background:transparent; color:var(--grey); }
.export-counter { color:var(--grey); font-size:13px; font-weight:500; min-width:48px; text-align:center; }
.export-hint { color:var(--grey); font-size:12px; }
.slide { display:none; position:relative; margin:0; background:#fff; border:1px solid var(--hairline); border-radius:12px; box-shadow:var(--shadow-sm); overflow:hidden; }
.slide.active { display:block; }
.card { position:absolute; background:#fff; border:1px solid var(--hairline); border-radius:12px; overflow:hidden; box-shadow:var(--shadow-sm); pointer-events:none; }
.card a, .card video, .card audio { pointer-events:auto; }
.card .inner { width:100%; height:100%; overflow:hidden; }
.card .note-body { padding:14px; line-height:1.55; word-wrap:break-word; }
.card .note-body p { margin:0 0 6px; }
.card .note-body h1, .card .note-body h2, .card .note-body h3 { margin:0 0 6px; line-height:1.3; font-weight:700; letter-spacing:-0.02em; }
.card .note-body h1 { font-size:1.5em; } .card .note-body h2 { font-size:1.25em; } .card .note-body h3 { font-size:1.1em; }
.card .note-body pre { background:var(--bg-system); border-radius:8px; padding:8px 10px; overflow:hidden; margin:0 0 6px; white-space:pre-wrap; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.9em; }
.card .note-body code { background:var(--bg-system); border-radius:4px; padding:1px 4px; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.9em; }
.card .note-body blockquote { margin:0 0 6px; padding-left:10px; color:var(--grey); border-left:2px solid var(--separator); }
.card .note-body a { color:var(--accent); text-decoration:none; } .card .note-body a:hover { text-decoration:underline; }
.card .row { display:flex; align-items:center; gap:12px; padding:12px; height:100%; }
.card .col { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.card .title { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card .sub { color:var(--grey); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card .tile { flex:none; width:56px; height:56px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:24px; }
.card .link-card { display:flex; flex-direction:column; height:100%; }
.card .link-image { display:block; flex:none; height:168px; overflow:hidden; background:var(--bg-system); }
.card .link-image img { width:100%; height:100%; object-fit:cover; display:block; }
.card .link-body { flex:1; min-height:0; display:flex; flex-direction:column; gap:6px; padding:12px 14px 12px; }
.card .link-card.no-image .link-body { padding:14px; justify-content:center; }
.card a.link-title { color:var(--ink); text-decoration:none; font-size:15px; font-weight:600; line-height:1.35; letter-spacing:-0.01em; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.card a.link-title:hover { color:var(--accent); }
.card .link-desc { color:var(--grey); font-size:13px; line-height:1.45; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.card .link-card.no-image .link-desc { -webkit-line-clamp:3; }
.card .link-footer { margin-top:auto; padding-top:2px; }
.card a.link-domain { display:flex; align-items:center; gap:6px; color:var(--grey); text-decoration:none; font-size:12px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card a.link-domain:hover { color:var(--ink); }
.card a.link-domain .favicon { width:16px; height:16px; border-radius:4px; flex:none; object-fit:cover; }
.card a.link-domain .favicon-fallback { width:16px; height:16px; border-radius:4px; flex:none; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; }
.card a.link-domain svg { width:13px; height:13px; flex:none; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.card .swatch-pill { position:absolute; right:10px; bottom:10px; background:rgba(255,255,255,0.92); border:1px solid var(--hairline); border-radius:8px; padding:4px 8px; font-weight:600; font-size:12px; box-shadow:var(--shadow-sm); }
.card .video-thumb { position:relative; background:#1d1d1f; border-radius:10px; display:flex; align-items:center; justify-content:center; color:#fff; text-decoration:none; }
@media print {
  body { display:block; background:#fff; padding:0; }
  .export-nav, .export-hint { display:none; }
  .slide { display:block !important; margin:0 auto; page-break-after:always; box-shadow:none; border:1px solid #ddd; }
  .slide:last-child { page-break-after:auto; }
}
</style>
</head>
<body>
<nav class="export-nav"><button id="export-prev" aria-label="Previous slide" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5l-7 7 7 7" /></svg></button><span class="export-counter" id="export-counter">1 / ${state.slides.length}</span><button id="export-next" aria-label="Next slide"${state.slides.length <= 1 ? " disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5l7 7-7 7" /></svg></button></nav>
${sections}
<div class="export-hint">← → to move</div>
<script>
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var prev = document.getElementById('export-prev');
  var next = document.getElementById('export-next');
  var counter = document.getElementById('export-counter');
  var index = 0;
  function show(i) {
    if (slides.length === 0) return;
    index = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach(function (s, j) {
      s.classList.toggle('active', j === index);
      if (j !== index) s.querySelectorAll('video, audio').forEach(function (m) { m.pause(); });
    });
    counter.textContent = (index + 1) + ' / ' + slides.length;
    prev.disabled = index === 0;
    next.disabled = index === slides.length - 1;
  }
  prev.addEventListener('click', function () { show(index - 1); });
  next.addEventListener('click', function () { show(index + 1); });
  document.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === ' ') {
      if (tag === 'BUTTON') return;
      e.preventDefault();
      show(index + 1);
    }
  });
  show(0);
})();
</script>
</body>
</html>`;
    const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bowerbird-slides.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (oversizedExportFiles.length > 0) {
      const names = oversizedExportFiles.map((f) => `${f.name} (${f.mb} MB)`).join(", ");
      api.ui.toast(`Downloading slides… ${names} too large to embed (over ${EXPORT_FILE_MB} MB) — shown as a placeholder instead.`);
    } else {
      api.ui.toast("Downloading slides…");
    }
  } catch (e) {
    if (state.api) state.api.ui.toast(`Export failed: ${String(e)}`);
  } finally {
    if (btn) {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
    if (state.panelList) updatePanel();
  }
}
