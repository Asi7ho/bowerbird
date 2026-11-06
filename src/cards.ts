// Cards: the HTML for one board card, plus the shape metadata
// the toolbar flyout and the pen preview use. Board JSON is
// untrusted input here: every value that lands in an attribute
// or as text is coerced or escaped in cardHtml, never trusted
// from the board.
import { api } from "./api";
import type { Media } from "./media";
import {
  domainOf, elide, escapeHtml, itemRotation, renderMarkdownHtml,
  tileColorFor, tint, type Item, type ShapeKind,
} from "./model";
import { getCardHtml, getCardRenderer } from "./plugins";

export interface CardContext {
  media: Media;
  isSelected(id: number): boolean;
  getEditingId(): number | null;
}

export interface CardRenderer {
  cardHtml(item: Item, plain?: boolean): string;
  shapeMeta(kind: ShapeKind): { label: string; key: string; svg: string };
  shapeLabel(kind: ShapeKind): string;
  isShapeTool(t: string): t is ShapeKind;
  shapeClipPath(kind: ShapeKind): string | null;
  shapePreviewPoints(kind: ShapeKind, x0: number, y0: number, w: number, h: number): string;
}

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

// Shapes: one toolbar button, like the pen, with a flyout
// beside it to choose the shape. The table is the single
// source for the flyout, the toolbar button icon, search
// labels and drag previews, so adding a shape means one
// row here, not edits in four places. Keyboard shortcuts
// stay R/E only: the flyout is how the new shapes are
// picked, and no new key is stolen from plugins or text.
export const SHAPES: { kind: ShapeKind; label: string; key: string; svg: string }[] = [
  { kind: "rect", label: "Rectangle", key: "R", svg: '<rect x="4" y="5" width="16" height="14" rx="2" />' },
  { kind: "ellipse", label: "Ellipse", key: "E", svg: '<ellipse cx="12" cy="12" rx="8" ry="6.5" />' },
  { kind: "triangle", label: "Triangle", key: "", svg: '<path d="M12 4 L20 20 L4 20 Z" />' },
  { kind: "diamond", label: "Diamond", key: "", svg: '<path d="M12 3 L21 12 L12 21 L3 12 Z" />' },
  { kind: "hexagon", label: "Hexagon", key: "", svg: '<path d="M8 3 L16 3 L21 12 L16 21 L8 21 L3 12 Z" />' },
  { kind: "star", label: "Star", key: "", svg: '<path d="M12 3 L14.7 9 L21 9.5 L16.2 13.8 L17.8 20 L12 16.5 L6.2 20 L7.8 13.8 L3 9.5 L9.3 9 Z" />' },
  { kind: "arrow", label: "Block arrow", key: "", svg: '<path d="M3 10 H15 V5 L21 12 L15 19 V14 H3 Z" />' },
];

export function shapeMeta(kind: ShapeKind): { label: string; key: string; svg: string } {
  return SHAPES.find((s) => s.kind === kind) ?? SHAPES[0];
}

export function shapeLabel(kind: ShapeKind): string { return shapeMeta(kind).label; }
export function isShapeTool(t: string): t is ShapeKind {
  return SHAPES.some((s) => s.kind === t);
}
// clip-path polygons, in % of the shape's box. The arrow
// points right; rotate it (handle or [ ]) to point
// anywhere else, like any other shape.
export function shapeClipPath(kind: ShapeKind): string | null {
  switch (kind) {
    case "triangle": return "polygon(50% 0, 100% 100%, 0 100%)";
    case "diamond": return "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)";
    case "hexagon": return "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)";
    case "star": return "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)";
    case "arrow": return "polygon(0 40%, 60% 40%, 60% 15%, 100% 50%, 60% 85%, 60% 60%, 0 60%)";
    default: return null;
  }
}
// Drag-preview polygon points, in board coords for a
// box from (x0, y0) sized w x h. Same geometry as the
// clip-paths above, so the preview is the shape drawn.
export function shapePreviewPoints(kind: ShapeKind, x0: number, y0: number, w: number, h: number): string {
  const px = (fx: number, fy: number) => `${x0 + fx * w},${y0 + fy * h}`;
  switch (kind) {
    case "triangle": return [px(0.5, 0), px(1, 1), px(0, 1)].join(" ");
    case "diamond": return [px(0.5, 0), px(1, 0.5), px(0.5, 1), px(0, 0.5)].join(" ");
    case "hexagon": return [px(0.25, 0), px(0.75, 0), px(1, 0.5), px(0.75, 1), px(0.25, 1), px(0, 0.5)].join(" ");
    case "star": return [[0.5, 0], [0.61, 0.35], [0.98, 0.35], [0.68, 0.57], [0.79, 0.91], [0.5, 0.7], [0.21, 0.91], [0.32, 0.57], [0.02, 0.35], [0.39, 0.35]].map(([fx, fy]) => px(fx, fy)).join(" ");
    case "arrow": return [px(0, 0.4), px(0.6, 0.4), px(0.6, 0.15), px(1, 0.5), px(0.6, 0.85), px(0.6, 0.6), px(0, 0.6)].join(" ");
    default: return "";
  }
}

export function createCardRenderer(ctx: CardContext): CardRenderer {
  // Markdown is a per-character regex walk, so re-parsing every note
  // on every render is the most expensive part of a rebuild for a
  // text-heavy board. Cache it per item object, invalidated by the
  // text and size themselves — an edit changes the text, so the
  // cache misses exactly when it should.
  const mdCache = new WeakMap<object, { text: string; size: number; html: string }>();
  function cachedMarkdown(item: Item, text: string, size: number): string {
    const hit = mdCache.get(item);
    if (hit && hit.text === text && hit.size === size) return hit.html;
    const html = renderMarkdownHtml(text, size);
    mdCache.set(item, { text, size, html });
    return html;
  }

  function cardHtml(item: Item, plain = false): string {
    // Board JSON is untrusted input for this function: a board
    // shared by someone else, or a file dropped with a crafted
    // name, can carry any string in any field. This HTML is
    // inserted with innerHTML, so every value that lands in
    // an attribute or as text must be coerced or escaped
    // here, not trusted from the board. Numbers are forced
    // through Number() (a string like `0" onmouseover="…`
    // becomes NaN, then the fallback, instead of breaking
    // out of the style attribute), colours must match a
    // strict hex pattern, and names, domains and titles are
    // escaped with escapeHtml() before they are interpolated.
    // Markdown text is already escaped by renderMarkdownHtml;
    // image/video sources go through fileUrl(), which
    // encodes each path segment.
    const num = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const safeColor = (v: unknown, fallback: string): string =>
      typeof v === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? v : fallback;
    const id = num(item.id, 0);
    const sel = plain ? false : ctx.isSelected(id);
    const cls = sel ? "card selected" : "card";
    if ("Plugin" in item.kind) {
      const ww0 = num(item.size.w, 0), hh0 = num(item.size.h, 0);
      const rot0 = itemRotation(item);
      const style0 = `left:${num(item.pos.x, 0)}px;top:${num(item.pos.y, 0)}px;width:${ww0}px;height:${hh0}px;${rot0 ? `transform:rotate(${rot0}deg);` : ""}`;
      const inner = getCardHtml(item) ?? "";
      const frameCls = getCardRenderer(item)?.frame === true ? " plugin-frame" : "";
      return `<div class="${cls}${frameCls}" data-id="${id}" style="${style0}"><div class="inner">${inner}</div></div>`;
    }
    // Cards live in world coordinates; the whole #cards layer is
    // transformed once by the camera (see applyCamera). Per-card
    // screen positions and per-card scale transforms used to force a
    // full reposition of every card on every pan/zoom frame — that
    // was the main source of lag. Content still scales with zoom,
    // because the layer itself is scaled.
    const ww = num(item.size.w, 0), hh = num(item.size.h, 0);
    const rot = itemRotation(item);
    const style = `left:${num(item.pos.x, 0)}px;top:${num(item.pos.y, 0)}px;width:${ww}px;height:${hh}px;${rot ? `transform:rotate(${rot}deg);` : ""}`;
    if ("Text" in item.kind) {
      if (!plain && ctx.getEditingId() === id) return ""; // the editor DOM is managed separately
      const { text, size, color, bg } = item.kind.Text;
      const safeSize = num(size, 16);
      const noteBg = safeColor(bg, "#FFFFFF");
      return `<div class="${cls}" data-id="${id}" style="${style}background:${noteBg}"><div class="inner note-body" style="font-size:${safeSize}px;color:${safeColor(color, "#1A1A1A")}">${cachedMarkdown(item, text, safeSize)}</div></div>`;
    }
    if ("Shape" in item.kind) {
      const fill = safeColor(item.kind.Shape.fill, "#1A1A1A");
      const shape = item.kind.Shape.shape;
      const radius = shape === "ellipse" ? "50%" : shape === "rect" ? "12px" : "0px";
      // Polygon shapes are cut with clip-path on the inner
      // fill, so a triangle is really a triangle, not a
      // rectangle with a triangle drawn on it. Outer card
      // is transparent with no hairline border, so an
      // ellipse is really an ellipse: a filled outer rect
      // would show its corners outside the ellipse, and a
      // rectangular hairline would frame it. The selected
      // ring follows the outer border-radius for rect and
      // ellipse; for polygons it is the bounding rect,
      // which is how a polygon selection reads.
      const clip = shapeClipPath(shape);
      const clipStyle = clip ? `clip-path:${clip};` : "";
      return `<div class="${cls}" data-id="${id}" style="${style}background:transparent;border:none;border-radius:${radius}"><div class="inner" style="background:${fill};border-radius:${radius};${clipStyle}width:100%;height:100%;box-shadow:var(--shadow-sm)"></div></div>`;
    }
    if ("Image" in item.kind) {
      const { path } = item.kind.Image;
      const name = path.split("/").pop() ?? path;
      // A selected image shows whole, not cropped: the board
      // crops images to fill the card, which is the right look
      // for a board, but a poor preview of what you just
      // selected. Selecting switches to contain, so the full
      // image is visible; deselecting goes back to cover.
      const fit = sel ? "contain" : "cover";
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="background:var(--bg-system)"><img src="${api.fileUrl(path)}" data-name="${escapeHtml(name)}" data-path="${escapeHtml(path)}" draggable="false" style="width:100%;height:100%;object-fit:${fit};border-radius:12px" alt="" /></div></div>`;
    }
    if ("UrlCard" in item.kind) {
      const { url, title, description, image, icon } = item.kind.UrlCard;
      const domain = domainOf(url);
      const head = title ?? domain;
      const tile = tileColorFor(domain);
      const initial = (domain[0] ?? "?").toUpperCase();
      const img = safeHttpUrl(image);
      const ico = safeHttpUrl(icon);
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const footer = `<div class="link-footer"><a class="link-domain" data-action="open-link" data-id="${id}">${ico ? `<img class="favicon" src="${esc(ico)}" alt="" onerror="this.style.display='none';var f=this.nextElementSibling;if(f)f.style.display='flex'" /><span class="favicon-fallback" style="display:none;background:${tint(tile, 0.85)};color:${tile}">${esc(initial)}</span>` : `<span class="favicon-fallback" style="background:${tint(tile, 0.85)};color:${tile}">${esc(initial)}</span>`}<span>${esc(domain)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg></a></div>`;
      if (img) {
        return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner link-card">
          <a class="link-image" data-action="open-link" data-id="${id}"><img src="${esc(img)}" draggable="false" alt="" onerror="this.closest('.link-image').style.display='none'" /></a>
          <div class="link-body">
            <a class="link-title" data-action="open-link" data-id="${id}">${esc(head)}</a>
            ${description ? `<div class="link-desc">${esc(description)}</div>` : ""}
            ${footer}
          </div></div></div>`;
      }
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner link-card no-image">
        <div class="link-body">
          <a class="link-title" data-action="open-link" data-id="${id}">${esc(head)}</a>
          ${description ? `<div class="link-desc">${esc(description)}</div>` : ""}
          ${footer}
        </div></div></div>`;
    }
    // PDF tiles use red as the PDF file-type colour (the
    // Adobe/document red), not the destructive-action red:
    // it is a kind colour, like audio purple, not a warning.
    if ("PdfCard" in item.kind) {
      const { path, size_bytes } = item.kind.PdfCard;
      const name = path.split("/").pop() ?? path;
      const kb = Math.round(num(size_bytes, 0) / 1024);
      const tile = `<div class="tile" style="background:${tint("#E63946", 0.88)};color:#E63946;font-size:13px">PDF</div>
        <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 92, 14, true))}</div><div class="sub" style="font-size:12px">${kb} KB</div></div>`;
      // Plain rendering (slides, library, export) stays a tile:
      // a canvas drawn by PDF.js does not survive as HTML, so
      // a rendered page there would export as a blank box.
      if (plain) {
        return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">${tile}</div></div>`;
      }
      if (ctx.media.pdfFailed.has(path)) {
        return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">${tile}</div></div>`;
      }
      ctx.media.loadPdfPage(id, path);
      const pageNum = ctx.media.pdfPages.get(id) ?? 1;
      if (hh < 200) {
        // A short card, like the old 96px tile: a small page
        // preview on the left, name and page count on the right,
        // the same row shape as audio and video cards.
        return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px" data-pdf-wrap="${id}">
          <div style="width:56px;height:${hh - 24}px;flex:none;background:var(--bg-system);border-radius:6px;overflow:hidden"><canvas data-pdf-canvas="${id}" style="width:100%;height:100%;object-fit:contain;display:block"></canvas></div>
          <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 92, 14, true))}</div><div class="sub" style="font-size:12px">${kb} KB · <span data-pdf-count="${id}">…</span></div></div></div></div>`;
      }
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px" data-pdf-wrap="${id}">
        <div style="flex:1 1 auto;min-height:0;background:var(--bg-system);border-radius:8px;overflow:hidden"><canvas data-pdf-canvas="${id}" style="width:100%;height:100%;object-fit:contain;display:block"></canvas></div>
        <div style="display:flex;align-items:center;gap:8px"><div class="title" style="font-size:14px;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>
        <button class="pdf-nav" data-action="pdf-prev" data-id="${id}" title="Previous page" aria-label="Previous page" ${pageNum <= 1 ? "disabled" : ""}>‹</button><span class="sub" data-pdf-count="${id}">…</span><button class="pdf-nav" data-action="pdf-next" data-id="${id}" title="Next page" aria-label="Next page">›</button></div>
        <div class="sub" style="font-size:12px">${kb} KB</div></div></div>`;
    }
    if ("Swatch" in item.kind) {
      const { hex } = item.kind.Swatch;
      return `<div class="${cls}" data-id="${id}" style="${style};background:${safeColor(hex, "#1A1A1A")}"><div class="swatch-pill">${escapeHtml(safeColor(hex, "#1A1A1A"))}</div></div>`;
    }
    if ("Audio" in item.kind) {
      const { path } = item.kind.Audio;
      const name = path.split("/").pop() ?? path;
      if (ctx.media.audioFailed.has(path)) {
        return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px"><div class="missing-media" style="flex:1 1 auto">File missing: ${escapeHtml(name)}</div></div></div>`;
      }
      const audio = ctx.media.getAudioState();
      const playing = !plain && audio.id === id && audio.el && !audio.el.paused;
      const isCurrent = !plain && audio.id === id && audio.el;
      const dur = isCurrent && isFinite(audio.el!.duration) ? audio.el!.duration : (ctx.media.audioDurations.get(path) ?? NaN);
      const cur = isCurrent ? audio.el!.currentTime : 0;
      const seekVal = isFinite(dur) && dur > 0 ? Math.round((cur / dur) * 1000) : 0;
      const seekPct = isFinite(dur) && dur > 0 ? Math.round((cur / dur) * 100) : 0;
      if (!isCurrent) ctx.media.loadAudioDuration(id, path);
      // Like the other media cards: a tile, a title, and the time as
      // a quiet grey sub-line — the same shape as the PDF card's
      // "1 KB". The seek control is a thin track in the tile's own
      // purple, not a chunky browser slider in blue.
      const tile = hh >= 104 ? 56 : 48;
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="audio-tile clickable" data-action="play-audio" data-id="${id}" style="width:${tile}px;height:${tile}px;background:${tint("#6A4C93", 0.88)};color:#6a4c93;font-size:${tile === 56 ? 18 : 16}px">${playing ? "\u275a\u275a" : "\u25b6"}</div>
          <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 92, 14, true))}</div><div class="sub" style="font-size:12px"><span data-audio-time="${id}">${ctx.media.formatAudioTime(cur)}</span> / <span data-audio-dur="${id}">${ctx.media.formatAudioTime(dur)}</span></div></div>
        </div>
        <input class="audio-seek" type="range" min="0" max="1000" value="${seekVal}" style="--seek-pct:${seekPct}%" data-audio-seek="${id}" aria-label="Seek">
      </div></div>`;
    }
    if ("Video" in item.kind) {
      const { source, remote, size_bytes } = item.kind.Video;
      const name = remote ? domainOf(source) : (source.split("/").pop() ?? source);
      const sub = remote ? "Video link" : `${Math.round(num(size_bytes, 0) / 1024)} KB`;
      const thumbH = (ww - 24) * 9 / 16;
      // A local video in a format Chromium can play plays right here
      // in the board, with its real first frame as the thumbnail —
      // no black box, no trip out to a browser or system player.
      // Remote links (YouTube, Vimeo, …) and formats Chromium cannot
      // play still open outside the app, as before.
      const ext = source.toLowerCase().split("?")[0].split("#")[0].split(".").pop() ?? "";
      const inline = !remote && ["mp4", "webm", "m4v"].includes(ext);
      if (inline) {
        const src = api.fileUrl(source);
        if (hh >= thumbH + 70) {
          return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
            <video controls preload="metadata" playsinline src="${src}" data-name="${escapeHtml(name)}" data-path="${escapeHtml(source)}" style="width:${ww - 24}px;height:${thumbH}px;object-fit:${sel ? "contain" : "cover"};border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
            <div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 24, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
        }
        return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">
          <video controls preload="metadata" playsinline src="${src}" data-name="${escapeHtml(name)}" data-path="${escapeHtml(source)}" style="width:96px;height:56px;object-fit:${sel ? "contain" : "cover"};border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
          <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 132, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div></div>`;
      }
      if (hh >= thumbH + 70) {
        return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
          <div class="video-thumb clickable" data-action="play-video" data-id="${id}" style="width:${ww - 24}px;height:${thumbH}px;font-size:28px">▶</div>
          <div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 24, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div>`;
      }
      return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner row" style="padding:12px">
        <div class="video-thumb clickable" data-action="play-video" data-id="${id}" style="width:96px;height:56px;font-size:20px">▶</div>
        <div class="col"><div class="title" style="font-size:14px">${escapeHtml(elide(name, ww - 132, 14, true))}</div><div class="sub" style="font-size:12px">${sub}</div></div></div></div>`;
    }
    return "";
  }
  return { cardHtml, shapeMeta, shapeLabel, isShapeTool, shapeClipPath, shapePreviewPoints };
}
