// Board model: types, geometry and markdown, ported from the GPUI
// board so existing board.json files load unchanged. The JSON shape is
// serde's externally-tagged enum: a text note is
// {"Text": {"text": "...", "bold": false, "size": 16, "color": "#1A1A1A"}}
// and a connector endpoint is {"Item": 3} or {"Point": {"x": 1, "y": 2}}.

export interface Pt { x: number; y: number }
export interface Size { w: number; h: number }
export type Anchor = { Point: Pt } | { Item: number };

export type Kind =
  | { Text: { text: string; bold: boolean; size: number; color: string } }
  | { Image: { path: string } }
  | { UrlCard: { url: string; title: string | null; description: string | null; embed?: boolean } }
  | { PdfCard: { path: string; size_bytes: number } }
  | { Swatch: { hex: string } }
  | { Audio: { path: string } }
  | { Video: { source: string; remote: boolean; size_bytes: number } }
  | { Stroke: { points: Pt[]; color: string; width: number; marker: boolean } }
  | { Connector: { from: Anchor; to: Anchor; color: string } };

export interface Item {
  id: number;
  pos: Pt;
  size: Size;
  group: number | null;
  kind: Kind;
}

export interface Camera { x: number; y: number; zoom: number }

export interface Board {
  items: Item[];
  camera: Camera;
  next_id: number;
  next_group: number;
  bg: string;
  grid: "Lines" | "Dots" | "Off";
}

export const GRID = 100;
export const HEADER_H = 32; // embedded card header, in world units

export function kindName(item: Item): string {
  return Object.keys(item.kind)[0];
}

export function get(item: Item, board: Board): Item | undefined {
  return board.items.find((i) => i.id === item.id);
}

export function boardGet(board: Board, id: number): Item | undefined {
  return board.items.find((i) => i.id === id);
}

export function centre(item: Item): Pt {
  return { x: item.pos.x + item.size.w / 2, y: item.pos.y + item.size.h / 2 };
}

export function anchorPoint(board: Board, a: Anchor): Pt | null {
  if ("Point" in a) return a.Point;
  const it = boardGet(board, a.Item);
  return it ? centre(it) : null;
}

export function itemBounds(board: Board, item: Item): [Pt, Size] {
  if ("Connector" in item.kind) {
    const a = anchorPoint(board, item.kind.Connector.from);
    const b = anchorPoint(board, item.kind.Connector.to);
    if (a && b) {
      const m = 8;
      const x = Math.min(a.x, b.x) - m;
      const y = Math.min(a.y, b.y) - m;
      return [{ x, y }, { w: Math.max(a.x, b.x) - x + m, h: Math.max(a.y, b.y) - y + m }];
    }
  }
  return [item.pos, item.size];
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function itemHit(board: Board, item: Item, world: Pt): boolean {
  if ("Connector" in item.kind) {
    const a = anchorPoint(board, item.kind.Connector.from);
    const b = anchorPoint(board, item.kind.Connector.to);
    if (a && b) return distToSegment(world, a, b) <= 8;
  }
  if ("Stroke" in item.kind) {
    const { points, width } = item.kind.Stroke;
    const tol = Math.max(width / 2 + 6, 8);
    for (let i = 0; i + 1 < points.length; i++) {
      if (distToSegment(world, points[i], points[i + 1]) <= tol) return true;
    }
    return points.some((p) => Math.hypot(p.x - world.x, p.y - world.y) <= tol);
  }
  return (
    world.x >= item.pos.x && world.x <= item.pos.x + item.size.w &&
    world.y >= item.pos.y && world.y <= item.pos.y + item.size.h
  );
}

export function hitTest(board: Board, world: Pt): number | null {
  for (let i = board.items.length - 1; i >= 0; i--) {
    if (itemHit(board, board.items[i], world)) return board.items[i].id;
  }
  return null;
}

export function marquee(board: Board, a: Pt, b: Pt): number[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return board.items.filter((it) => {
    const [p, s] = itemBounds(board, it);
    return p.x < x1 && p.x + s.w > x0 && p.y < y1 && p.y + s.h > y0;
  }).map((it) => it.id);
}

export function allocId(board: Board): number {
  board.next_id += 1;
  return board.next_id;
}

export function select(board: Board, selected: number[], id: number, additive: boolean): number[] {
  const out = additive ? [...selected] : [];
  const it = boardGet(board, id);
  if (it && it.group !== null) {
    for (const m of board.items) {
      if (m.group === it.group && !out.includes(m.id)) out.push(m.id);
    }
  } else if (!out.includes(id)) {
    out.push(id);
  }
  return out;
}

export function moveSelection(board: Board, selected: number[], dx: number, dy: number): void {
  for (const it of board.items) {
    if (!selected.includes(it.id)) continue;
    it.pos.x += dx; it.pos.y += dy;
    if ("Stroke" in it.kind) for (const p of it.kind.Stroke.points) { p.x += dx; p.y += dy; }
    if ("Connector" in it.kind) {
      const { from, to } = it.kind.Connector;
      if ("Point" in from) { from.Point.x += dx; from.Point.y += dy; }
      if ("Point" in to) { to.Point.x += dx; to.Point.y += dy; }
    }
  }
}

export function resizeItem(board: Board, id: number, newW: number, newH: number): void {
  newW = Math.max(48, newW); newH = Math.max(48, newH);
  const it = boardGet(board, id);
  if (!it) return;
  const { x: ox, y: oy } = it.pos; const ow = it.size.w, oh = it.size.h;
  if ("Stroke" in it.kind && ow > 0 && oh > 0) {
    const sx = newW / ow, sy = newH / oh;
    for (const p of it.kind.Stroke.points) {
      p.x = ox + (p.x - ox) * sx; p.y = oy + (p.y - oy) * sy;
    }
  }
  if ("Connector" in it.kind && ow > 0 && oh > 0) {
    const sx = newW / ow, sy = newH / oh;
    const { from, to } = it.kind.Connector;
    if ("Point" in from) { from.Point.x = ox + (from.Point.x - ox) * sx; from.Point.y = oy + (from.Point.y - oy) * sy; }
    if ("Point" in to) { to.Point.x = ox + (to.Point.x - ox) * sx; to.Point.y = oy + (to.Point.y - oy) * sy; }
  }
  it.size = { w: newW, h: newH };
}

// --- URL classification -------------------------------------------------
// A dropped link becomes an embedded page unless it is clearly a file:
// a direct download, an image, audio or video file stays a simple card
// (video links already become video cards before this is consulted).
const FILE_EXTS = ["pdf", "zip", "gz", "mp3", "wav", "flac", "ogg", "m4a", "mp4", "mov", "webm", "mkv", "avi", "m4v", "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
export function shouldEmbedUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false;
  const path = lower.split("?")[0].split("#")[0];
  return !FILE_EXTS.some((ext) => path.endsWith("." + ext));
}

export function domainOf(url: string): string {
  const after = url.split("://")[1] ?? url;
  let host = after.split("/")[0].split("?")[0].split(":")[0];
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

export function parseHex(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function normaliseHex(hex: string): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("");
}

// --- Markdown (same subset as the GPUI board) ---------------------------

export interface Segment { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: boolean; strike?: boolean }
export type Block =
  | { Heading: { level: number; segments: Segment[] } }
  | { Bullet: { segments: Segment[] } }
  | { Ordered: { n: number; segments: Segment[] } }
  | { Quote: { segments: Segment[] } }
  | { Code: { lines: string[] } }
  | { Paragraph: { segments: Segment[] } };

export function parseInline(s: string): Segment[] {
  const out: Segment[] = [];
  let i = 0, buf = "";
  const flush = (extra: Partial<Segment> = {}) => {
    if (buf) { out.push({ text: buf, ...extra }); buf = ""; }
  };
  // Deliberately flat: markers stay literal when unclosed, and
  // "2 * 3 * 4" is not emphasis. Backslash escapes one character.
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
    const rest = s.slice(i);
    const tryMark = (mark: string, extra: Partial<Segment>): boolean => {
      if (!rest.startsWith(mark)) return false;
      const end = s.indexOf(mark, i + mark.length);
      if (end === -1) return false;
      const inner = s.slice(i + mark.length, end);
      if (!inner || inner.includes("\n")) return false;
      flush(); out.push({ text: inner, ...extra }); i = end + mark.length; return true;
    };
    if (tryMark("**", { bold: true })) continue;
    if (tryMark("~~", { strike: true })) continue;
    if (tryMark("`", { code: true })) continue;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
    if (link) { flush(); out.push({ text: link[1], link: true }); i += link[0].length; continue; }
    if (c === "*" && rest.length > 1) {
      const end = s.indexOf("*", i + 1);
      if (end !== -1 && end > i + 1) {
        const inner = s.slice(i + 1, end);
        if (!inner.includes(" ") || inner.trim().length > 0) {
          // Only treat a lone *...* as italic when it is not part of
          // an arithmetic-looking expression: require the char before
          // and after to not both be digits/spaces in "a * b" form.
          const before = i === 0 ? " " : s[i - 1];
          const after = end + 1 >= s.length ? " " : s[end + 1];
          if (!(before.trim() !== "" && after.trim() !== "" && /\d/.test(before) && /\d/.test(after))) {
            flush(); out.push({ text: inner, italic: true }); i = end + 1; continue;
          }
        }
      }
    }
    buf += c; i++;
  }
  flush();
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      blocks.push({ Code: { lines: codeLines } });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ Heading: { level: heading[1].length, segments: parseInline(heading[2]) } }); i++; continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { blocks.push({ Bullet: { segments: parseInline(bullet[1]) } }); i++; continue; }
    const ordered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ordered) { blocks.push({ Ordered: { n: parseInt(ordered[1], 10), segments: parseInline(ordered[2]) } }); i++; continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { blocks.push({ Quote: { segments: parseInline(quote[1]) } }); i++; continue; }
    blocks.push({ Paragraph: { segments: parseInline(line) } });
    i++;
  }
  return blocks;
}

export function estimateTextHeight(text: string, fontSize: number, width: number): number {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return 48;
  const charsFit = Math.max(20, (width - 24) / (fontSize * 0.55));
  let h = 24;
  blocks.forEach((block, idx) => {
    if (idx > 0) h += 4;
    if ("Heading" in block) {
      const len = block.Heading.segments.reduce((a, s) => a + s.text.length, 0);
      const lines = Math.max(1, Math.ceil(len / charsFit));
      const extra = block.Heading.level === 1 ? 6 : block.Heading.level === 2 ? 3 : 1;
      h += lines * (fontSize + extra) * 1.62;
    } else if ("Code" in block) {
      h += Math.max(1, block.Code.lines.length) * fontSize * 1.62 + 12;
    } else {
      const segs = ("Bullet" in block ? block.Bullet.segments : "Ordered" in block ? block.Ordered.segments : "Quote" in block ? block.Quote.segments : block.Paragraph.segments);
      const len = segs.reduce((a, s) => a + s.text.length, 0);
      h += Math.max(1, Math.ceil(len / charsFit)) * fontSize * 1.62;
    }
  });
  return Math.max(48, h);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Notes render with link URLs intact: parseInline drops URLs (it is
// only used for height estimation, where text length is what matters),
// so rendering walks the raw lines with a link-aware pass instead.
export function renderMarkdownHtml(text: string, _baseSize: number): string {
  return renderNoteHtml(text);
}

function renderNoteHtml(text: string): string {
  // Render blocks, keeping link URLs: walk the raw lines and render
  // inline markup with a link-aware pass instead of parseInline's
  // text-only segments.
  const inlineHtml = (s: string): string => {
    let out = "", i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
      if (link) { out += `<a href="#" data-url="${escapeHtml(link[2])}">${escapeHtml(link[1])}</a>`; i += link[0].length; continue; }
      const bold = /^\*\*([^*]+)\*\*/.exec(rest);
      if (bold) { out += `<strong>${escapeHtml(bold[1])}</strong>`; i += bold[0].length; continue; }
      const code = /^`([^`]+)`/.exec(rest);
      if (code) { out += `<code>${escapeHtml(code[1])}</code>`; i += code[0].length; continue; }
      const strike = /^~~([^~]+)~~/.exec(rest);
      if (strike) { out += `<s>${escapeHtml(strike[1])}</s>`; i += strike[0].length; continue; }
      const ital = /^\*([^*]+)\*/.exec(rest);
      if (ital) { out += `<em>${escapeHtml(ital[1])}</em>`; i += ital[0].length; continue; }
      if (s[i] === "\\" && i + 1 < s.length) { out += escapeHtml(s[i + 1]); i += 2; continue; }
      out += escapeHtml(s[i]); i++;
    }
    return out;
  };
  const lines = text.split("\n");
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const codeLines: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      html += `<pre>${escapeHtml(codeLines.join("\n"))}</pre>`;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { const lvl = heading[1].length; html += `<h${lvl}>${inlineHtml(heading[2])}</h${lvl}>`; i++; continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { html += `<p>• ${inlineHtml(bullet[1])}</p>`; i++; continue; }
    const ordered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ordered) { html += `<p>${ordered[1]}. ${inlineHtml(ordered[2])}</p>`; i++; continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { html += `<blockquote>${inlineHtml(quote[1])}</blockquote>`; i++; continue; }
    html += `<p>${inlineHtml(line)}</p>`; i++;
  }
  return html;
}

// Where a segment from `from` to `to` crosses a rectangle: entry point
// for the target item, exit point for the source item.
export function rectCrossing(from: Pt, to: Pt, pos: Pt, w: number, h: number, entry: boolean): Pt | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  let t0 = 0, t1 = 1;
  for (const [o, d, lo, hi] of [[from.x, dx, pos.x, pos.x + w], [from.y, dy, pos.y, pos.y + h]] as const) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
  }
  const t = entry ? t0 : t1;
  if (t < 0 || t > 1) return null;
  return { x: from.x + dx * t, y: from.y + dy * t };
}

export function clippedEnds(board: Board, from: Anchor, to: Anchor): [Pt, Pt] | null {
  const aRaw = anchorPoint(board, from);
  const bRaw = anchorPoint(board, to);
  if (!aRaw || !bRaw) return null;
  let a = aRaw, b = bRaw;
  if ("Item" in from) {
    const it = boardGet(board, from.Item);
    if (it) { const p = rectCrossing(aRaw, bRaw, it.pos, it.size.w, it.size.h, false); if (p) a = p; }
  }
  if ("Item" in to) {
    const it = boardGet(board, to.Item);
    if (it) { const p = rectCrossing(aRaw, bRaw, it.pos, it.size.w, it.size.h, true); if (p) b = p; }
  }
  return [a, b];
}

export function tileColorFor(domain: string): string {
  const tiles = ["#2E86AB", "#6A4C93", "#2A9D8F", "#FF6B35", "#E63946", "#B56576"];
  let h = 0;
  for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return tiles[h % tiles.length];
}

export function tint(hex: string, whiteMix: number): string {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  const m = (c: number) => Math.round(c * (1 - whiteMix) + 255 * whiteMix);
  return `rgb(${m(rgb[0])},${m(rgb[1])},${m(rgb[2])})`;
}

export function elide(s: string, widthPx: number, textPx: number, bold: boolean): string {
  const perChar = textPx * (bold ? 0.55 : 0.5);
  const budget = Math.floor(widthPx / perChar);
  const chars = [...s];
  if (chars.length <= budget || budget < 2) return s;
  return chars.slice(0, budget - 1).join("").trimEnd() + "…";
}
