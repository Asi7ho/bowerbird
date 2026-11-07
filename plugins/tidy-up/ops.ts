// Tidy Up — the align and distribute maths. Pure functions of
// the selected cards: given the cards, return the position
// patches. No API, no panel, no undo — the caller applies the
// patches in one undo step (see panel.ts) and refreshes.
//
// Cards only. Strokes and connectors are skipped: moving
// a stroke needs its points moved too, and a connector's
// anchors move with the cards it joins, so setting a
// stroke or connector's position alone would not move
// what is drawn. Rotated cards align by their unrotated
// box, the same box the core uses for their handles.
import type { Item, Pt } from "../../src/model";

export type Axis = "x" | "y";
export type Edge = "start" | "centre" | "end";

export interface PositionPatch {
  id: number;
  pos: Pt;
}

export function isCard(it: Item | undefined): it is Item {
  return !!it && !("Stroke" in it.kind) && !("Connector" in it.kind);
}

// Align is to the selection's bounding box (its outermost
// edge, or its centre). That is the predictable version —
// the one a user can picture before pressing the button.
export function alignPatches(cards: Item[], axis: Axis, edge: Edge): PositionPatch[] {
  const posKey = axis === "x" ? "x" : "y";
  const sizeKey = axis === "x" ? "w" : "h";
  const lo = Math.min(...cards.map((c) => c.pos[posKey]));
  const hi = Math.max(...cards.map((c) => c.pos[posKey] + c.size[sizeKey]));
  const mid = (lo + hi) / 2;
  return cards.map((c) => {
    const target = edge === "start" ? lo : edge === "end" ? hi - c.size[sizeKey] : mid - c.size[sizeKey] / 2;
    return { id: c.id, pos: { ...c.pos, [posKey]: Math.round(target) } };
  });
}

// Distribute keeps the first and last cards fixed and
// spaces the rest evenly between them.
export function distributePatches(cards: Item[], axis: Axis): PositionPatch[] {
  const posKey = axis === "x" ? "x" : "y";
  const sizeKey = axis === "x" ? "w" : "h";
  const sorted = [...cards].sort((a, b) => (a.pos[posKey] - b.pos[posKey]) || (a.id - b.id));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = (last.pos[posKey] + last.size[sizeKey]) - first.pos[posKey];
  const total = sorted.reduce((sum, c) => sum + c.size[sizeKey], 0);
  // Gap clamped at 0: overlapping cards end up touching
  // rather than stacked on top of each other.
  const gap = Math.max(0, (span - total) / (sorted.length - 1));
  let cursor = first.pos[posKey];
  return sorted.map((c) => {
    const p = { id: c.id, pos: { ...c.pos, [posKey]: Math.round(cursor) } };
    cursor += c.size[sizeKey] + gap;
    return p;
  });
}
