// Live imports: a dropped .svg/.psd/.ai keeps its source in the
// board's assets and is re-imported when the file changes.
// Pure pieces: finding the group for a source, and translating
// a fresh import onto the group's current place.

import type { Board, Item, Pt } from "bowerbird-plugin-api";
import type { ImportedItem } from "./import-types";

export function findSourceGroup(board: Board, path: string): number | null {
  const groups = board.groups ?? {};
  for (const key of Object.keys(groups)) {
    if (groups[Number(key)]?.source?.path === path) return Number(key);
  }
  return null;
}

// Decode a base64 string to bytes (atob output is Latin-1,
// so each char is one byte — the same pattern as media.ts).
// The return is a plain ArrayBuffer-backed array, so its
// .buffer is an ArrayBuffer for the PSD parser.
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function groupBBox(items: Item[]): { x: number; y: number; w: number; h: number } | null {
  if (items.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    x0 = Math.min(x0, it.pos.x);
    y0 = Math.min(y0, it.pos.y);
    x1 = Math.max(x1, it.pos.x + it.size.w);
    y1 = Math.max(y1, it.pos.y + it.size.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function importedBBox(items: ImportedItem[]): { x: number; y: number; w: number; h: number } | null {
  if (items.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    x0 = Math.min(x0, it.pos.x);
    y0 = Math.min(y0, it.pos.y);
    x1 = Math.max(x1, it.pos.x + it.size.w);
    y1 = Math.max(y1, it.pos.y + it.size.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Size a FileCard from its artwork's aspect: the card is
// 360 wide like a video card, the preview fills the card
// edge to edge, so the card is the same ratio as the file.
// The preview is capped at 360 tall so a very tall artwork
// does not make a giant card, and floored at 80 so it stays
// visible. A missing or empty artwork falls back to the
// video card's size (16:9).
// The preview height for artwork of a ratio at a given
// width, capped and floored as above. The heal uses it to
// work out the heights the old formulas produced.
export function fileCardPreviewHeight(artW: number, artH: number, w: number): number {
  return Math.min(360, Math.max(80, (artH / artW) * Math.max(1, w)));
}

// The height for a card of any width: the preview fills the
// card, so the card height is the preview height.
export function fileCardHeightForWidth(artW: number, artH: number, w: number): number {
  return Math.round(fileCardPreviewHeight(artW, artH, w));
}

export function fileCardSize(artW: number, artH: number): { w: number; h: number } {
  if (!(artW > 0) || !(artH > 0)) return { w: 360, h: 203 };
  return { w: 360, h: fileCardHeightForWidth(artW, artH, 360) };
}

export function translateImportedToAnchor(items: ImportedItem[], anchor: Pt): ImportedItem[] {
  const b = importedBBox(items);
  if (!b) return items;
  const dx = anchor.x - b.x;
  const dy = anchor.y - b.y;
  if (dx === 0 && dy === 0) return items;
  return items.map((it) => {
    const moved: ImportedItem = { ...it, pos: { x: it.pos.x + dx, y: it.pos.y + dy } };
    if ("Stroke" in it.kind) {
      moved.kind = { Stroke: { ...it.kind.Stroke, points: it.kind.Stroke.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } };
    }
    return moved;
  });
}
