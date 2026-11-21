// core-cards: the eleven built-in card kinds, as a first-party
// plugin. The core renders no card itself; this plugin provides
// the kinds through the same `cards.registerBuiltin` any
// plugin uses.

import type { PluginContext, PluginManifest } from "../plugins/host";
import { isInlineVideo, pressureWidth, smoothStrokePressures, smoothStrokeSamples, strokeMaxWidth, strokePressuresVary, type Item } from "../backend/model";
import { strokePath } from "./board-geometry";

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
type ShapeData = { shape: string; fill: string; outline?: boolean };
type StrokeData = { points: { x: number; y: number }[]; color: string; width: number; marker: boolean; pressures?: number[]; pencil?: boolean };
type ImageData = { path: string };
type UrlCardData = { url: string; title: string | null; description: string | null; image?: string | null; icon?: string | null; embed?: boolean };
type PdfCardData = { path: string; size_bytes: number };
type FileCardData = { path: string; size_bytes: number; format: "psd" | "ai"; preview?: string };
type SwatchData = { hex: string };
type AudioData = { path: string; title?: string; transcript?: string };
type VideoData = { source: string; remote: boolean; size_bytes: number; poster?: string; duration?: number };
type Model3DData = { path: string; size_bytes: number };

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

// An outline shape: the same geometry as the filled shape,
// drawn as an SVG stroke with no fill, so the line follows
// the shape — a triangle's outline is a triangle, not a
// rectangle. The stroke is 4px, inset by half its width so
// it is not clipped by the card edge. The fractions match
// shapeClipPath above.
function shapeOutlineSvg(shape: string, w: number, h: number, color: string): string {
  const sw = 4, inset = sw / 2;
  const stroke = `fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"`;
  const frac: Record<string, Array<[number, number]>> = {
    triangle: [[0.5, 0], [1, 1], [0, 1]],
    diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
    hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
    star: [[0.5, 0], [0.61, 0.35], [0.98, 0.35], [0.68, 0.57], [0.79, 0.91], [0.5, 0.7], [0.21, 0.91], [0.32, 0.57], [0.02, 0.35], [0.39, 0.35]],
    arrow: [[0, 0.4], [0.6, 0.4], [0.6, 0.15], [1, 0.5], [0.6, 0.85], [0.6, 0.6], [0, 0.6]],
  };
  let inner: string;
  if (shape === "rect") {
    inner = `<rect x="${inset}" y="${inset}" width="${w - sw}" height="${h - sw}" rx="12" ${stroke} />`;
  } else if (shape === "ellipse") {
    inner = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2 - inset}" ry="${h / 2 - inset}" ${stroke} />`;
  } else if (frac[shape]) {
    const pts = frac[shape].map(([fx, fy]) => `${inset + fx * (w - sw)},${inset + fy * (h - sw)}`).join(" ");
    inner = `<polygon points="${pts}" ${stroke} />`;
  } else {
    return "";
  }
  return `<svg width="100%" height="100%" viewBox="0 0 ${w} ${h}">${inner}</svg>`;
}

// A waveform from real peaks: one thin bar per bucket,
// centred vertically, the played bars darker. With no
// peaks yet (still decoding) a quiet centre line stands
// in — never fake bars. The svg is the seek control: a
// slider for keyboard users, a pointer target for the rest.
// The 100 bars of a waveform, as svg rects. Shared by the
// first render and by the in-place repaint below, so the
// two can never drift apart.
function waveRects(peaks: number[], pct: number): string {
  let rects = "";
  const cut = Math.floor(pct * 100);
  for (let i = 0; i < 100; i++) {
    const p = peaks[i] ?? 0;
    const h = p > 0 ? Math.max(1.2, p * 28) : 0;
    const y = (32 - h) / 2;
    rects += `<rect data-i="${i}" x="${i}" y="${y.toFixed(2)}" width="0.62" height="${h.toFixed(2)}"${i < cut ? ' class="played"' : ""}/>`;
  }
  return rects;
}
function audioWaveSvg(peaks: number[] | undefined, pct: number, id: number): string {
  const slider = `role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}"`;
  if (!peaks) {
    return `<svg class="audio-wave" data-audio-wave="${id}" viewBox="0 0 100 32" preserveAspectRatio="none" ${slider}><line x1="0" y1="16" x2="100" y2="16" stroke="#dcdce0" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;
  }
  return `<svg class="audio-wave" data-audio-wave="${id}" viewBox="0 0 100 32" preserveAspectRatio="none" ${slider}>${waveRects(peaks, pct)}</svg>`;
}
// Paint freshly decoded peaks into the waveform already on
// the board. The svg itself stays put — only its bars are
// replaced — so a decode landing never detaches the card
// under a click or a measurement in flight, the way a full
// board re-render would.
function repaintAudioWave(api: PluginContext, id: number, path: string): void {
  const peaks = api.media.getAudioPeaks(path);
  if (!peaks) return;
  const it = api.board.getItem(id);
  if (!it || !("Audio" in it.kind) || it.kind.Audio.path !== path) return;
  const wave = document.querySelector(`[data-audio-wave="${id}"]`);
  if (!wave) return;
  const state = api.media.getAudioState();
  const dur = state.id === id && state.duration > 0 ? state.duration : (api.media.getAudioDuration(path) ?? NaN);
  const cur = state.id === id ? state.currentTime : 0;
  const pct = isFinite(dur) && dur > 0 ? Math.min(1, Math.max(0, cur / dur)) : 0;
  wave.innerHTML = waveRects(peaks, pct);
  wave.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
}
const AUDIO_PLAY_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const AUDIO_PAUSE_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
// The transcript toggle: a quiet document icon, not a text
// button. It reads as part of the card, like the swatch
// pill, and darkens while the transcript is open.
const TRANSCRIPT_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6"/></svg>`;

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
      const { shape, fill, outline } = data as ShapeData;
      const fillColor = safeColor(fill, "#1A1A1A");
      const radius = shape === "ellipse" ? "50%" : shape === "rect" ? "12px" : "0px";
      // An outline shape is a stroked SVG, not a filled
      // div: a border on the div would be a rectangle even
      // for a triangle. A shape saved before outlines
      // existed has no outline flag, and draws filled.
      if (outline) {
        return `<div class="${c.cls} shape" data-id="${c.id}" style="${c.style}background:transparent;border:none;border-radius:${radius}"><div class="inner" style="width:100%;height:100%">${shapeOutlineSvg(shape, item.size.w, item.size.h, fillColor)}</div></div>`;
      }
      // Outer card is transparent with no hairline border,
      // so an ellipse is really an ellipse: a filled outer
      // rect would show its corners outside the ellipse,
      // and a rectangular hairline would frame it. The
      // selected ring follows the outer border-radius for
      // rect and ellipse; for polygons it is the bounding
      // rect, which is how a polygon selection reads.
      const clip = shapeClipPath(shape);
      const clipStyle = clip ? `clip-path:${clip};` : "";
      return `<div class="${c.cls} shape" data-id="${c.id}" style="${c.style}background:transparent;border:none;border-radius:${radius}"><div class="inner" style="background:${fillColor};border-radius:${radius};${clipStyle}width:100%;height:100%"></div></div>`;
    },
  });

  // A stroke is a card, not a path in the board SVG: its ink
  // must stack with the cards around it, not under all of
  // them. The old renderer drew every stroke into #world,
  // below #cards, so a dragged group split apart — its shape
  // cards rose above the cards they passed over (selected
  // cards stack on top) while its strokes slid underneath.
  // As a card the stroke takes the same stacking rule, the
  // same live drag (updateDraggedCards moves it by style),
  // and the same selection ring as every other card.
  // The points are absolute world coords, so they are
  // rebased to the stroke's own bounding box — never to
  // item.pos, which plain rendering zeroes — and the svg is
  // padded by half the widest the stroke gets, so the ink
  // is not shaved at the box edge. The card itself is
  // transparent with no border and overflows visibly, like
  // a shape card; the svg stretches with the card on a live
  // resize, which is the right preview because resizing
  // scales the points by the same factor.
  api.cards.registerBuiltin({
    kind: "Stroke",
    title: "Stroke",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const st = data as StrokeData;
      const raw = Array.isArray(st.points) ? st.points : [];
      if (raw.length < 2) return "";
      const pts = raw.map((p) => ({ x: num(p.x, 0), y: num(p.y, 0) }));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const pad = Math.ceil(strokeMaxWidth(st) / 2) + 1;
      const vw = Math.max(1, maxX - minX) + pad * 2;
      const vh = Math.max(1, maxY - minY) + pad * 2;
      const local = pts.map((p) => ({ x: p.x - minX + pad, y: p.y - minY + pad }));
      const color = safeColor(st.color, "#1A1A1A");
      const marker = st.marker ? ` opacity="0.45"` : "";
      let inner = "";
      if (st.pencil) inner += `<g filter="url(#pencil-texture)">`;
      if (st.pressures && strokePressuresVary(st)) {
        const spts = smoothStrokeSamples(local);
        const sprs = smoothStrokePressures(st.pressures);
        for (let i = 0; i + 1 < spts.length; i++) {
          const w = pressureWidth(st.width, (sprs[i] + sprs[i + 1]) / 2);
          inner += `<line x1="${spts[i].x}" y1="${spts[i].y}" x2="${spts[i + 1].x}" y2="${spts[i + 1].y}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"${marker} />`;
        }
      } else {
        const d = strokePath(item, local, color, st.width);
        inner += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${st.width}" stroke-linecap="round" stroke-linejoin="round"${marker} />`;
      }
      if (st.pencil) inner += `</g>`;
      return `<div class="${c.cls} stroke" data-id="${c.id}" style="${c.style}background:transparent;border:none"><svg viewBox="0 0 ${vw} ${vh}" style="position:absolute;left:${-pad}px;top:${-pad}px;width:calc(100% + ${pad * 2}px);height:calc(100% + ${pad * 2}px);overflow:visible" aria-hidden="true">${inner}</svg></div>`;
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
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner"><img src="${api.files.fileUrl(path)}" data-name="${api.text.escapeHtml(name)}" data-path="${api.text.escapeHtml(path)}" draggable="false" style="width:100%;height:100%;object-fit:${fit};border-radius:12px" alt="" /></div></div>`;
    },
  });

  api.cards.registerBuiltin({
    kind: "UrlCard",
    title: "Link",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { url, title, image, icon } = data as UrlCardData;
      const domain = api.text.domainOf(url);
      const head = title ?? domain;
      const tile = api.text.tileColorFor(domain);
      const initial = (domain[0] ?? "?").toUpperCase();
      const img = safeHttpUrl(image);
      const ico = safeHttpUrl(icon);
      const footer = `<div class="link-footer"><a class="link-domain" data-action="open-link" data-id="${c.id}">${ico ? `<img class="favicon" src="${api.text.escapeHtml(ico)}" alt="" onerror="this.style.display='none';var f=this.nextElementSibling;if(f)f.style.display='flex'" /><span class="favicon-fallback" style="display:none;background:${api.text.tint(tile, 0.85)};color:${tile}">${api.text.escapeHtml(initial)}</span>` : `<span class="favicon-fallback" style="background:${api.text.tint(tile, 0.85)};color:${tile}">${api.text.escapeHtml(initial)}</span>`}<span>${api.text.escapeHtml(domain)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg></a></div>`;
      if (img) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner link-card">
          <a class="link-image" data-action="open-link" data-id="${c.id}"><img src="${api.text.escapeHtml(img)}" draggable="false" alt="" onerror="this.closest('.link-image').style.display='none'" /></a>
          <div class="link-body">
            <a class="link-title" data-action="open-link" data-id="${c.id}">${api.text.escapeHtml(head)}</a>
            ${footer}
          </div></div></div>`;
      }
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner link-card no-image">
        <div class="link-body">
          <a class="link-title" data-action="open-link" data-id="${c.id}">${api.text.escapeHtml(head)}</a>
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
      const { path } = data as PdfCardData;
      const tile = `<div class="tile" style="background:${api.text.tint("#E63946", 0.88)};color:#E63946;font-size:13px">PDF</div>`;
      // Plain rendering (slides, library, export) stays a tile:
      // a canvas drawn by PDF.js does not survive as HTML, so
      // a rendered page there would export as a blank box.
      // A failed PDF renders the same tile row.
      if (plain || api.media.pdfFailed(path)) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px">${tile}</div></div>`;
      }
      api.media.loadPdfPage(c.id, path);
      const pageNum = api.media.getPdfPage(c.id);
      if (c.hh < 200) {
        // A short card, like the old 96px tile: just a small
        // page preview.
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px" data-pdf-wrap="${c.id}">
          <div style="width:56px;height:${c.hh - 24}px;flex:none;border-radius:10px;overflow:hidden"><canvas data-pdf-canvas="${c.id}" style="width:100%;height:100%;object-fit:contain;display:block"></canvas></div></div></div>`;
      }
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px" data-pdf-wrap="${c.id}">
        <div style="flex:1 1 auto;min-height:0;border-radius:10px;overflow:hidden"><canvas data-pdf-canvas="${c.id}" style="width:100%;height:100%;object-fit:contain;display:block"></canvas></div>
        <div style="display:flex;align-items:center;justify-content:center;gap:8px"><button class="pdf-nav" data-action="pdf-prev" data-id="${c.id}" title="Previous page" aria-label="Previous page" ${pageNum <= 1 ? "disabled" : ""}>‹</button><span class="sub" data-pdf-count="${c.id}">…</span><button class="pdf-nav" data-action="pdf-next" data-id="${c.id}" title="Next page" aria-label="Next page">›</button></div></div></div>`;
    },
  });

  // A native design file (.psd, .ai) is one card, like a
  // PDF: a preview of the artwork. The preview is the
  // rendered artwork (the PSD's composite, the AI's first
  // page), embedded alongside the source; without one — a
  // file whose artwork could not be rendered — the card is
  // a tile in the format's colour, like the PDF's red tile.
  // With a preview, a small format pill rides on its
  // bottom-right corner, so the artwork is never mistaken
  // for a plain image; the tile already says the format in
  // full, so it gets no pill.
  api.cards.registerBuiltin({
    kind: "FileCard",
    title: "Design file",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { format, preview } = data as FileCardData;
      const label = format === "psd" ? "PSD" : "AI";
      const tint = format === "psd" ? "#2E86AB" : "#FF6B35";
      const previewHtml = preview
        ? `<img src="${api.files.fileUrl(preview)}" draggable="false" alt="" style="width:100%;height:100%;object-fit:contain;display:block" />`
        : `<div class="filecard-tile" style="background:${api.text.tint(tint, 0.88)};color:${tint}">${label}</div>`;
      return `<div class="${c.cls} filecard" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
        <div style="flex:1 1 auto;min-height:0;border-radius:10px;overflow:hidden;position:relative">${previewHtml}${preview ? `<span class="filecard-pill" style="color:${tint}">${label}</span>` : ""}</div></div></div>`;
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
      const { path, title, transcript } = data as AudioData;
      const text = typeof transcript === "string" ? transcript.trim() : "";
      // The title is only the identifier in the missing-file
      // error now: the card itself shows no name.
      const name = (typeof title === "string" && title.trim() !== "") ? title.trim() : (path.split("/").pop() ?? path);
      if (api.media.audioFailed(path)) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px"><div class="missing-media" style="flex:1 1 auto">File missing: ${api.text.escapeHtml(name)}</div></div></div>`;
      }
      const state = api.media.getAudioState();
      const playing = !plain && state.id === c.id && state.playing;
      const isCurrent = !plain && state.id === c.id;
      const dur = isCurrent && state.duration > 0 ? state.duration : (api.media.getAudioDuration(path) ?? NaN);
      const cur = isCurrent ? state.currentTime : 0;
      const pct = isFinite(dur) && dur > 0 ? Math.min(1, Math.max(0, cur / dur)) : 0;
      if (!isCurrent) api.media.loadAudioDuration(c.id, path);
      // The waveform is the card's content, like a video
      // poster: real peaks, decoded on demand and cached
      // per path. A plain render (slides, library, export)
      // draws whatever is cached and never starts a decode.
      const peaks = api.media.getAudioPeaks(path);
      if (!peaks && !plain) {
        // Paint the peaks into this card's waveform when
        // the decode lands, instead of re-rendering the
        // board (see repaintAudioWave above).
        void api.media.loadAudioPeaks(c.id, path).then(() => repaintAudioWave(api, c.id, path));
      }
      // A voice recording carries its transcript under the
      // player, hidden by default. The toggle is a quiet
      // icon now, not a text button; once the card is grown
      // it sits above the text, and the text fills the card
      // and scrolls, so a long note does not grow the card.
      const expanded = text.length > 0 && c.hh > api.cards.audioHeights.transcriptHidden;
      const toggleHtml = text.length > 0
        ? `<button type="button" class="audio-transcript-toggle" data-action="toggle-transcript" data-id="${c.id}" aria-expanded="${expanded}" aria-label="Transcript" title="Transcript"${expanded ? ' style="color:var(--ink)"' : ""}>${TRANSCRIPT_SVG}</button>`
        : "";
      const transcriptHtml = expanded
        ? `<div class="audio-transcript-text">${api.text.escapeHtml(text)}</div>`
        : "";
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
        <div class="audio-wave-wrap">
          ${audioWaveSvg(peaks, pct, c.id)}
          <button type="button" class="audio-play clickable" data-action="play-audio" data-id="${c.id}" aria-label="${playing ? "Pause audio" : "Play audio"}">${playing ? AUDIO_PAUSE_SVG : AUDIO_PLAY_SVG}</button>
        </div>
        ${toggleHtml}${transcriptHtml}
      </div></div>`;
    },
  });

  api.cards.registerBuiltin({
    kind: "Video",
    title: "Video",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { source, remote, poster } = data as VideoData;
      const name = remote ? api.text.domainOf(source) : (source.split("/").pop() ?? source);
      const thumbH = (c.ww - 24) * 9 / 16;
      // A video card is a poster until it is played. A live
      // <video> element per card costs a decoder and a
      // composited frame on every pan, and a board of videos
      // grinds; the poster is the captured frame (see
      // src/poster.ts). The <video> mounts only for the one
      // card whose play button was pressed, and moves when
      // another is played. Remote links (YouTube, Vimeo, …)
      // and formats Chromium cannot play still open outside
      // the app, as before.
      const inline = isInlineVideo(source, remote);
      const active = !plain && inline && api.media.getVideoState().id === c.id;
      if (active) {
        const src = api.files.fileUrl(source);
        if (c.hh >= thumbH + 70) {
          return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
            <video controls preload="metadata" playsinline src="${src}" data-name="${api.text.escapeHtml(name)}" data-path="${api.text.escapeHtml(source)}" style="width:${c.ww - 24}px;height:${thumbH}px;object-fit:${c.sel ? "contain" : "cover"};border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
            </div></div>`;
        }
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px">
          <video controls preload="metadata" playsinline src="${src}" data-name="${api.text.escapeHtml(name)}" data-path="${api.text.escapeHtml(source)}" style="width:96px;height:56px;object-fit:${c.sel ? "contain" : "cover"};border-radius:10px;background:#1d1d1f;pointer-events:auto"></video>
          </div></div>`;
      }
      // The poster, with the play button over it. No poster
      // yet — an old board, or the capture is still running —
      // falls through to the dark tile below.
      if (inline && poster) {
        const posterUrl = api.files.fileUrl(poster);
        if (c.hh >= thumbH + 70) {
          return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
            <button type="button" class="video-thumb clickable" data-action="play-video" aria-label="Play video" data-id="${c.id}" style="width:${c.ww - 24}px;height:${thumbH}px;font-size:28px;overflow:hidden"><img src="${posterUrl}" alt=""><span class="video-play">▶</span></button>
            </div></div>`;
        }
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px">
          <button type="button" class="video-thumb clickable" data-action="play-video" aria-label="Play video" data-id="${c.id}" style="width:96px;height:56px;font-size:20px;overflow:hidden"><img src="${posterUrl}" alt=""><span class="video-play">▶</span></button>
          </div></div>`;
      }
      if (c.hh >= thumbH + 70) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
          <button type="button" class="video-thumb clickable" data-action="play-video" aria-label="Play video" data-id="${c.id}" style="width:${c.ww - 24}px;height:${thumbH}px;font-size:28px">▶</button>
          </div></div>`;
      }
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}"><div class="inner row" style="padding:12px">
        <button type="button" class="video-thumb clickable" data-action="play-video" aria-label="Play video" data-id="${c.id}" style="width:96px;height:56px;font-size:20px">▶</button>
        </div></div>`;
    },
  });

  api.cards.registerBuiltin({
    kind: "Model3D",
    title: "3D model",
    render: (item, data, plain = false) => {
      const c = chrome(item, plain);
      const { path } = data as Model3DData;
      // A plain render (a preview outside the board) has no
      // viewer to mount, so it gets a static tile instead
      // of an empty canvas.
      if (plain) {
        return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}background:transparent"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
          <div class="model3d-tile" style="flex:1 1 auto">3D</div></div></div>`;
      }
      // The canvas is the viewport: drag rotates the model.
      // It is transparent — the model is drawn by the one
      // shared WebGL layer above the cards, into this
      // canvas's screen rect (see model3d.ts), and shows
      // through it onto the card, which is transparent
      // too, so the board shows through behind the model.
      // There is no zoom and no fit button: the wheel over
      // the card pans or zooms the board, as over any card.
      const canvasH = Math.max(80, c.hh - 24);
      return `<div class="${c.cls}" data-id="${c.id}" style="${c.style}background:transparent"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px">
        <div style="position:relative;width:${c.ww - 24}px;height:${canvasH}px;flex:none">
          <canvas class="model3d clickable" data-id="${c.id}" data-path="${api.text.escapeHtml(path)}" style="width:100%;height:100%;border-radius:10px"></canvas>
        </div></div></div>`;
    },
  });
}

export function deactivate(): void {
  // The builtin renderers are registered in the plugin
  // system by kind; there is no per-plugin DOM to remove.
  // (A future version will pass the API object to
  // deactivate for cleanup; see PLUGIN_API.md.)
}
