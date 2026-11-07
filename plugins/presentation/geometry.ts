// Presentation — slide geometry and membership. Which cards
// belong to a slide, which strokes and connectors enter it,
// and the frame-relative drawing primitives both the playing
// view and the export render from. Also the slide computation
// itself (frames in board order, with their cards and
// drawings) and the signature that tells syncFromBoard whether
// a slide changed.
//
// All geometry lives in the core now, via api.geometry
// (see PLUGIN_API.md). This plugin used to copy
// rectCrossing and clipped ends by hand; those copies
// are gone, so there is one implementation to keep
// correct, and this file only says what a slide contains.
import type { Item, Pt } from "../../src/model";
import { getApi } from "./state.js";
import type { Slide } from "./state.js";

// One source for the drawing in a slide, used by both
// the playing view (DOM SVG) and the export (string SVG).
// A primitive is frame-relative, so both renderers just
// place it, without redoing clipping or arrowhead math.
export type DrawingPrimitive =
  | { type: "stroke"; d: string; color: string; width: number; marker: boolean }
  | { type: "connector"; a: Pt; b: Pt; p1: Pt; p2: Pt; color: string };

export function isFrameItem(item: Item): boolean {
  return (
    "Plugin" in item.kind &&
    item.kind.Plugin.plugin === "presentation" &&
    item.kind.Plugin.kind === "slide" &&
    item.size.w > 0 &&
    item.size.h > 0
  );
}

export function isCardItem(item: Item): boolean {
  // Frames are containers, not content — a frame inside
  // a frame is its own slide, never content — but every
  // other card kind counts, including Plugin cards.
  if ("Stroke" in item.kind || "Connector" in item.kind) return false;
  if ("Plugin" in item.kind && item.kind.Plugin.kind === "slide") return false;
  return item.size.w > 0 && item.size.h > 0;
}

type Rect = { x: number; y: number; w: number; h: number };

function frameRect(frame: Item): Rect {
  return { x: frame.pos.x, y: frame.pos.y, w: frame.size.w, h: frame.size.h };
}

function cardOverlapsFrame(frame: Item, item: Item): boolean {
  // Strict overlap: a card that only touches the frame's
  // edge, with no area inside, shows nothing in the slide.
  return getApi().geometry.rectsOverlap(
    frameRect(frame),
    { x: item.pos.x, y: item.pos.y, w: item.size.w, h: item.size.h },
  );
}

function segmentIntersectsFrame(frame: Item, a: Pt, b: Pt): boolean {
  // A segment enters the frame if any part of it,
  // however short, is inside, as a screenshot of the
  // frame area would show.
  return getApi().geometry.segmentIntersectsRect(a, b, frameRect(frame));
}

function strokeOverlapsFrame(frame: Item, item: Item): boolean {
  if (!("Stroke" in item.kind)) return false;
  const points = item.kind.Stroke.points;
  if (points.length < 2) return false;
  // Fast reject first: a stroke's points all lie inside
  // its pos/size bounding box, so if that box does not
  // overlap the frame, no segment can — this skips the
  // per-segment loop for every stroke far from a frame,
  // which is most strokes on a large board. It changes
  // nothing about the result: the segment test below
  // is the same test, just not run when it cannot pass.
  if (!cardOverlapsFrame(frame, item)) return false;
  for (let i = 0; i + 1 < points.length; i++) {
    if (segmentIntersectsFrame(frame, points[i], points[i + 1])) return true;
  }
  return false;
}

function connectorOverlapsFrame(frame: Item, item: Item): boolean {
  if (!("Connector" in item.kind)) return false;
  const ends = getApi().geometry.clippedEnds(item.kind.Connector.from, item.kind.Connector.to);
  if (!ends) return false;
  return segmentIntersectsFrame(frame, ends[0], ends[1]);
}

export function drawingPrimitives(frame: Item, drawings: Item[]): DrawingPrimitive[] {
  const out: DrawingPrimitive[] = [];
  for (const item of drawings) {
    if ("Stroke" in item.kind) {
      const points = item.kind.Stroke.points;
      if (points.length < 2) continue;
      out.push({
        type: "stroke",
        d: points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x - frame.pos.x},${p.y - frame.pos.y}`).join(" "),
        color: item.kind.Stroke.color,
        width: item.kind.Stroke.width,
        marker: item.kind.Stroke.marker,
      });
    }
    if ("Connector" in item.kind) {
      const ends = getApi().geometry.clippedEnds(item.kind.Connector.from, item.kind.Connector.to);
      if (!ends) continue;
      const a = { x: ends[0].x - frame.pos.x, y: ends[0].y - frame.pos.y };
      const b = { x: ends[1].x - frame.pos.x, y: ends[1].y - frame.pos.y };
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / len, uy = dy / len;
      const head = 12, spread = 0.45;
      const c1 = Math.cos(spread), s1 = Math.sin(spread), c2 = Math.cos(-spread), s2 = Math.sin(-spread);
      out.push({
        type: "connector",
        a, b,
        p1: { x: b.x - head * (ux * c1 - uy * s1), y: b.y - head * (ux * s1 + uy * c1) },
        p2: { x: b.x - head * (ux * c2 - uy * s2), y: b.y - head * (ux * s2 + uy * c2) },
        color: item.kind.Connector.color || "#333333",
      });
    }
  }
  return out;
}

export function computeSlides(): Slide[] {
  const all = getApi().board.getItems();
  const frames = all.filter(isFrameItem);
  return frames.map((frame) => ({
    frame,
    // A slide is almost a screenshot of its frame area:
    // every card that overlaps the frame at all, however
    // little, and every stroke or connector segment that
    // enters it, in board order. A card's centre is NOT
    // the test — a swatch whose top is inside, or a pen
    // circle behind a photo, shows in the slide, cropped
    // to the frame, exactly as it looks on the board.
    cards: all.filter((it) => isCardItem(it) && cardOverlapsFrame(frame, it)),
    drawings: all.filter((it) =>
      ("Stroke" in it.kind && strokeOverlapsFrame(frame, it)) ||
      ("Connector" in it.kind && connectorOverlapsFrame(frame, it)),
    ),
  }));
}

export function signature(list: Slide[]): string {
  // Order matters here — it is the slide order — and a
  // card's position matters too, because a slide is a
  // layout, not a list: moving a card into, out of, or
  // inside a frame must re-render that slide. This
  // signature is NOT sorted, and it covers drawings too,
  // so a pen stroke moving into a frame re-renders it.
  const parts: string[] = [];
  for (const slide of list) {
    parts.push(`F${slide.frame.id}:${slide.frame.pos.x},${slide.frame.pos.y},${slide.frame.size.w}x${slide.frame.size.h}`);
    for (const it of slide.cards) {
      parts.push(`${it.id}:${JSON.stringify(it.kind)}:${it.pos.x},${it.pos.y},${it.size.w}x${it.size.h}`);
    }
    for (const it of slide.drawings) {
      // Drawings are not stringified whole: a pen stroke
      // can hold hundreds of points, and stringifying them
      // on every board event is the signature's main cost.
      // A stroke's points are fixed once it is drawn; the
      // only changes after that are a move (pos), a resize
      // (size) or a deletion, and a new stroke is a new id,
      // so id + pos + size + point count detects every real
      // change. A connector is different: its own pos/size
      // is unreliable, and its anchors are just two small
      // values, so connectors keep the full kind string.
      if ("Stroke" in it.kind) {
        const pts = it.kind.Stroke.points;
        parts.push(`S${it.id}:${it.pos.x},${it.pos.y},${it.size.w}x${it.size.h}:${Array.isArray(pts) ? pts.length : 0}`);
      } else {
        parts.push(`${it.id}:${JSON.stringify(it.kind)}`);
      }
    }
  }
  return parts.join("|");
}
