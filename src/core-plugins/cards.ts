// core-cards — the built-in card kinds, as a first-party
// plugin. The core is headless: it owns the board model,
// persistence, the plugin host and the API, and it renders
// no card itself. This plugin provides the eight built-in
// kinds (Text, Image, Swatch, UrlCard, PdfCard, Audio,
// Video, Shape) through the same `cards.registerBuiltin`
// any plugin uses. It is the reference implementation for
// a card plugin: a plugin that replaces a built-in kind is
// built the same way, registering the same kind name.
//
// Everything here goes through the PluginContext only —
// `api.board` for selection, `api.media` for PDF and audio
// state, `api.files` for file URLs, `api.text` and
// `api.geometry` for the pure helpers. Board JSON is
// untrusted input: every value that lands in an attribute
// or as text is coerced or escaped here, exactly as the
// core's renderer did, never trusted from the board.
// Numbers are forced through Number() (a string like
// `0" onmouseover="…` becomes NaN, then the fallback,
// instead of breaking out of the style attribute),
// colours must match a strict hex pattern, and names,
// domains and titles are escaped before they are
// interpolated. Markdown text is already escaped by
// renderMarkdownHtml; image/video sources go through
// fileUrl(), which encodes each path segment.
import type { PluginContext, PluginManifest } from "../plugins";
import type { Item } from "../model";
import { AUDIO_TRANSCRIPT_HIDDEN_H } from "../model";

export const manifest: PluginManifest = {
  apiVersion: "2",
  id: "core-cards",
  name: "Cards",
  version: "1.0.0",
  description: "The built-in card kinds.",
  main: "cards.js",
  permissions: ["board:read", "files:read"],
};

type TextData = { text: string; bold: boolean; size: number; color: string; bg?: string };
type ShapeData = { shape: string; fill: string };
type ImageData = { path: string };
type UrlCardData = { url: string; title: string | null; description: string | null; image?: string | null; icon?: string | null; embed?: boolean };
type PdfCardData = { path: string; size_bytes: number };
type SwatchData = { hex: string };
type AudioData = { path: string; transcript?: string };
type VideoData = { source: string; remote: boolean; size_bytes: number };

// Link cards are previews only: clicking one opens it in the browser.
// The preview (image, icon, title) comes from the site itself, via
// fetchPreview in the main process.
function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

// Polygon shapes are cut with clip-path on the inner fill,
// so a triangle is really a triangle, not a rectangle with
// a triangle drawn on it. This is the same table as the
// core's shape metadata (cards.ts); it is a small, stable
// set of polygon strings, copied here so this plugin does
// not import core code. When the toolbar moves into its
// own plugin, the shape metadata can be unified then.
function shapeClipPath(kind: string): string | null {
  switch (kind) {
    case "triangle": return "polygon(50% 0, 100% 100%, 0 100%)";
    case "diamond": return "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)";
    case "hexagon": return "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)";
    case "star": return "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)";
    case "arrow": return "polygon(0 40%, 60% 40%, 60% 15%, 100% 50%, 60% 85%, 60% 60%, 0 60%)";
    default: return null;
  }
}

export function activate(api: PluginContext): void {
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const safeColor = (v: unknown, fallback: string): string =>
    typeof v === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? v : fallback;

  // Markdown is a per-character regex walk, so re-parsing every note
  // on every render is the most expensive part of a rebuild for a
  // text-heavy board. Cache it per item object, invalidated by the
  // text and size themselves — an edit changes the text, so the
  // cache misses exactly when it should.
  const mdCache = new WeakMap<object, { text: string; size: number; html: string }>();
  function cachedMarkdown(item: Item, text: string, size: number): string {
    const hit = mdCache.get(item);
    if (hit && hit.text === text && hit.size === size) return hit.html;
    const html = api.text.renderMarkdownHtml(text, size);
    mdCache.set(item, { text, size, html });
    return html;
  }

  // The card chrome shared by every kind: position, size,
  // rotation and the selection ring. Cards live in world
  // coordinates; the whole #cards layer is transformed once
  // by the camera, so a per-card transform is only the
  // rotation, never a position or a scale.
  function chrome(item: Item, plain: boolean): { id: number; sel: boolean; cls: string; ww: number; hh: number; style: string } {
    const id = num(item.id, 0);
    const sel = plain ? false : api.board.getSelected().includes(id);
    const cls = sel ? "card selected" : "card";
    const ww = num(item.size.w, 0);
    const hh = num(item.size.h, 0);
    const rot = api.geometry.itemRotation(item);
    const style = `left:${num(item.pos.x, 0)}px;top:${num(item.pos.y, 0)}px;width:${ww}px;height:${hh}px;${rot ? `transform:rotate(${rot}deg);` : ""}`;
    return { id, sel, cls, ww, hh, style };
  }

  api.cards.registerBuiltin({
    kind: "Text",
    title: "Text note",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { text, size, color, bg } = data as TextData;
      const safeSize = num(size, 16);
      const noteBg = safeColor(bg, "#FFFFFF");
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}background:${noteBg}"><div class="inner note-body" style="font-size:${safeSize}px;color:${safeColor(color, "#1A1A1A")}">${cachedMarkdown(item, text, safeSize)}</div></div>`;
    },
  });

  api.cards.registerBuiltin({
    kind: "Shape",
    title: "Shape",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { shape, fill } = data as ShapeData;
      const fillColor = safeColor(fill, "#1A1A1A");
      const radius = shape === "ellipse" ? "50%" : shape === "rect" ? "12px" : "0px";
      // Outer card is transparent with no hairline border,
      // so an ellipse is really an ellipse: a filled outer
      // rect would show its corners outside the ellipse,
      // and a rectangular hairline would frame it. The
      // selected ring follows the outer border-radius for
      // rect and ellipse; for polygons it is the bounding
      // rect, which is how a polygon selection reads.
      const clip = shapeClipPath(shape);
      const clipStyle = clip ? `clip-path:${clip};` : "";
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}background:transparent;border:none;border-radius:${radius}"><div class="inner" style="background:${fillColor};border-radius:${radius};${clipStyle}width:100%;height:100%;box-shadow:var(--shadow-sm)"></div></div>`;
    },
  });

  api.cards.registerBuiltin({
    kind: "Image",
    title: "Image",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { path } = data as ImageData;
      const name = path.split("/").pop() ?? path;
      // A selected image shows whole, not cropped: the board
      // crops images to fill the card, which is the right look
      // for a board, but a poor preview of what you just
      // selected. Selecting switches to contain, so the full
      // image is visible; deselecting goes back to cover.
      const fit = c.sel ? "contain" : "cover";
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="background:var(--bg-system)"><img src="${api.files.fileUrl(path)}" data-name="${api.text.escapeHtml(name)}" data-path="${api.text.escapeHtml(path)}" draggable="false" style="width:100%;height:100%;object-fit:${fit};border-radius:12px" alt="" /></div></div>`;
    },
  });

  api.cards.registerBuiltin({
    kind: "UrlCard",
    title: "Link",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { url, title, description, image, icon } = data as UrlCardData;
      const domain = api.text.domainOf(url);
      const head = title ?? domain;
      const tile = api.text.tileColorFor(domain);
      const initial = (domain[0] ?? "?").toUpperCase();
      const img = safeHttpUrl(image);
      const ico = safeHttpUrl(icon);
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const footer = `<div class="link-footer"><a class="link-domain" data-action="open-link" data-id="${c.id}">${ico ? `<img class="favicon" src="${esc(ico)}" alt="" onerror="this.style.display='none';var f=this.nextElementSibling;if(f)f.style.display='flex'" /><span class="favicon-fallback" style="display:none;background:${api.text.tint(tile, 0.85)};color:${tile}">${esc(initial)}</span>` : `<span class="favicon-fallback" style="background:${api.text.tint(tile, 0.85)};color:${tile}">${esc(initial)}</span>`}<span>${esc(domain)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg></a></div>`;
      if (img) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner link-card">
          <a class="link-image" data-action="open-link" data-id="${c.id}"><img src="${esc(img)}" draggable="false" alt="" onerror="this.closest('.link-image').style.display='none'" /></a>
          <div class="link-body">
            <a class="link-title" data-action="open-link" data-id="${c.id}">${esc(head)}</a>
            ${description ? `<div class="link-desc">${esc(description)}</div>` : ""}
            ${footer}
          </div></div></div>`;
      }
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner link-card no-image">
        <div class="link-body">
          <a class="link-title" data-action="open-link" data-id="${c.id}">${esc(head)}</a>
          ${description ? `<div class="link-desc">${esc(description)}</div>` : ""}
          ${footer}
        </div></div></div>`;
    },
  });

  // PDF tiles use red as the PDF file-type colour (the
  // Adobe/document red), not the destructive-action red:
  // it is a kind colour, like audio purple, not a warning.
  api.cards.registerBuiltin({
    kind: "PdfCard",
    title: "PDF",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { path, size_bytes } = data as PdfCardData;
      const name = path.split("/").pop() ?? path;
      const kb = Math.round(num(size_bytes, 0) / 1024);
      const tile = `<div class="tile" style="background:${api.text.tint("#E63946", 0.88)};color:#E63946;font-size:13px">PDF</div>
        <div class="col"><div class="title" style="font-size:14px">${api.text.escapeHtml(api.text.elide(name, c.ww - 92, 14, true))}</div><div class="sub" style="font-size:12px">${kb} KB</div></div>`;
      // Plain rendering (slides, library, export) stays a tile:
      // a canvas drawn by PDF.js does not survive as HTML, so
      // a rendered page there would export as a blank box.
      if (plain) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px">${tile}</div></div>`;
      }
      if (api.media.pdfFailed(path)) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px">${tile}</div></div>`;
      }
      api.media.loadPdfPage(c.id, path);
      const pageNum = api.media.getPdfPage(c.id);
      if (c.hh < 200) {
        // A short card, like the old 96px tile: a small page
        // preview on the left, name and page count on the right,
        // the same row shape as audio and video cards.
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px" data-pdf-wrap="${c.id}">
          <div style="width:56px;height:${c.hh - 24}px;flex:none;background:var(--bg-system);border-radius:6px;overflow:hidden"><canvas data-pdf-canvas="${c.id}" style="width:100%;height:100%;object-fit:contain;display:block"></canvas></div>
          <div class="col"><div class="title" style="font-size:14px">${api.text.escapeHtml(api.text.elide(name, c.ww - 92, 14, true))}</div><div class="sub" style="font-size:12px">${kb} KB · <span data-pdf-count="${c.id}">…</span></div></div></div></div>`;
      }
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px" data-pdf-wrap="${c.id}">
        <div style="flex:1 1 auto;min-height:0;background:var(--bg-system);border-radius:8px;overflow:hidden"><canvas data-pdf-canvas="${c.id}" style="width:100%;height:100%;object-fit:contain;display:block"></canvas></div>
        <div style="display:flex;align-items:center;gap:8px"><div class="title" style="font-size:14px;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${api.text.escapeHtml(name)}</div>
        <button class="pdf-nav" data-action="pdf-prev" data-id="${c.id}" title="Previous page" aria-label="Previous page" ${pageNum <= 1 ? "disabled" : ""}>‹</button><span class="sub" data-pdf-count="${c.id}">…</span><button class="pdf-nav" data-action="pdf-next" data-id="${c.id}" title="Next page" aria-label="Next page">›</button></div>
        <div class="sub" style="font-size:12px">${kb} KB</div></div></div>`;
    },
  });

  api.cards.registerBuiltin({
    kind: "Swatch",
    title: "Colour swatch",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { hex } = data as SwatchData;
      const safeHex = safeColor(hex, "#1A1A1A");
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style};background:${safeHex}"><div class="swatch-pill">${api.text.escapeHtml(safeHex)}</div></div>`;
    },
  });

  api.cards.registerBuiltin({
    kind: "Audio",
    title: "Audio",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { path, transcript } = data as AudioData;
      const text = typeof transcript === "string" ? transcript.trim() : "";
      const name = path.split("/").pop() ?? path;
      if (api.media.audioFailed(path)) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px"><div class="missing-media" style="flex:1 1 auto">File missing: ${api.text.escapeHtml(name)}</div></div></div>`;
      }
      const state = api.media.getAudioState();
      const playing = !plain && state.id === c.id && state.playing;
      const isCurrent = !plain && state.id === c.id;
      const dur = isCurrent && state.duration > 0 ? state.duration : (api.media.getAudioDuration(path) ?? NaN);
      const cur = isCurrent ? state.currentTime : 0;
      const seekVal = isFinite(dur) && dur > 0 ? Math.round((cur / dur) * 1000) : 0;
      const seekPct = isFinite(dur) && dur > 0 ? Math.round((cur / dur) * 100) : 0;
      if (!isCurrent) api.media.loadAudioDuration(c.id, path);
      // Like the other media cards: a tile, a title, and the time as
      // a quiet grey sub-line — the same shape as the PDF card's
      // "1 KB". The seek control is a thin track in the tile's own
      // purple, not a chunky browser slider in blue.
      const tile = c.hh >= 104 ? 56 : 48;
      // A voice recording carries its transcript under the
      // player, hidden by default: the toggle lives in the
      // card's bottom row while hidden (see cards.ts), and
      // once the card is grown it heads the transcript
      // here, above the text, so the label is never below
      // what it labels. The text fills the card and
      // scrolls, so a long note does not grow the card.
      const expanded = text.length > 0 && c.hh > AUDIO_TRANSCRIPT_HIDDEN_H;
      const transcriptHtml = expanded
        ? `<button type="button" class="audio-transcript-toggle" data-action="toggle-transcript" data-id="${c.id}" aria-expanded="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg> Transcript</button><div class="audio-transcript-text">${api.text.escapeHtml(text)}</div>`
        : "";
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="audio-tile clickable" data-action="play-audio" data-id="${c.id}" style="width:${tile}px;height:${tile}px;background:${api.text.tint("#6A4C93", 0.88)};color:#6a4c93;font-size:${tile === 56 ? 18 : 16}px">${playing ? "❚❚" : "▶"}</div>
          <div class="col"><div class="title" style="font-size:14px">${api.text.escapeHtml(api.text.elide(name, c.ww - 92, 14, true))}</div><div class="sub" style="font-size:12px"><span data-audio-time="${c.id}">${api.media.formatAudioTime(cur)}</span> / <span data-audio-dur="${c.id}">${api.media.formatAudioTime(dur)}</span></div></div>
        </div>
        <input class="audio-seek" type="range" min="0" max="1000" value="${seekVal}" style="--seek-pct:${seekPct}%" data-audio-seek="${c.id}" aria-label="Seek">
        ${transcriptHtml}
      </div></div>`;
    },
  });

  api.cards.registerBuiltin({
    kind: "Video",
    title: "Video",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { source, remote, size_bytes } = data as VideoData;
      const name = remote ? api.text.domainOf(source) : (source.split("/").pop() ?? source);
      const sub = remote ? "Video link" : `${Math.round(num(size_bytes, 0) / 1024)} KB`;
      const thumbH = (c.ww - 24) * 9 / 16;
      // A local video in a format Chromium can play plays right here
      // in the board, with its real first frame as the thumbnail —
      // no black box, no trip out to a browser or system player.
      // Remote links (YouTube, Vimeo, …) and formats Chromium cannot
      // play still open outside the app, as before.
      const ext = source.toLowerCase().split("?")[0].split("#")[0].split(".").pop() ?? "";
      const inline = !remote && ["mp4", "webm", "m4v"].includes(ext);
      if (inline) {
        const src = api.files.fileUrl(source);
        if (c.hh >= thumbH + 70) {
          return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
            <video controls preload="metadata" playsinline src="${src}" data-name="${api.text.escapeHtml(name)}" data-path="${api.text.escapeHtml(source)}" style="width:${c.ww - 24}px;height:${thumbH}px;object-fit:${c.sel ? "contain" : "cover"};border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
            <div class="title" style="font-size:14px">${api.text.escapeHtml(api.text.elide(name, c.ww - 24, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
        }
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px">
          <video controls preload="metadata" playsinline src="${src}" data-name="${api.text.escapeHtml(name)}" data-path="${api.text.escapeHtml(source)}" style="width:96px;height:56px;object-fit:${c.sel ? "contain" : "cover"};border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
          <div class="col"><div class="title" style="font-size:14px">${api.text.escapeHtml(api.text.elide(name, c.ww - 132, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div></div>`;
      }
      if (c.hh >= thumbH + 70) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
          <div class="video-thumb clickable" data-action="play-video" data-id="${c.id}" style="width:${c.ww - 24}px;height:${thumbH}px;font-size:28px">▶</div>
          <div class="title" style="font-size:14px">${api.text.escapeHtml(api.text.elide(name, c.ww - 24, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
      }
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px">
        <div class="video-thumb clickable" data-action="play-video" data-id="${c.id}" style="width:96px;height:56px;font-size:20px">▶</div>
        <div class="col"><div class="title" style="font-size:14px">${api.text.escapeHtml(api.text.elide(name, c.ww - 132, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div></div>`;
    },
  });
}

export function deactivate(): void {
  // The builtin renderers are registered in the plugin
  // system by kind; there is no per-plugin DOM to remove.
  // (A future version will pass the API object to
  // deactivate for cleanup; see PLUGIN_API.md.)
}
