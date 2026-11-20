// Pure geometry for placing floating overlays (the note colour
// bar) beside a card.

export type OverlayRect = { x: number; y: number; w: number; h: number };

export function rectsOverlap(a: OverlayRect, b: OverlayRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export type BarPlacement = { side: "left" | "right" | "hidden"; x: number; y: number };

const BAR_GAP = 8;
const BAR_EDGE = 8;

export function placeNoteBar(
  note: OverlayRect,
  bar: { w: number; h: number },
  toolbar: OverlayRect | null,
  viewport: { w: number; h: number },
): BarPlacement {
  // The bar belongs to the note: it hides only when the note
  // is fully off-screen, so it does not vanish the moment the
  // note starts to leave the viewport on a horizontal pan.
  const noteVisible =
    note.x + note.w > 0 && note.x < viewport.w &&
    note.y + note.h > 0 && note.y < viewport.h;
  if (!noteVisible) return { side: "hidden", x: 0, y: 0 };
  // The bar is an extension of the note: its top is the
  // note's top, with no clamp. Clamping it to the viewport
  // made it slide relative to the note whenever the note
  // moved near the top or bottom edge.
  const y = note.y;
  const leftSide = note.x - bar.w - BAR_GAP;
  const rightSide = note.x + note.w + BAR_GAP;
  const coversToolbar = (x: number) =>
    toolbar !== null && rectsOverlap({ x, y, w: bar.w, h: bar.h }, toolbar);
  if (leftSide >= BAR_EDGE && !coversToolbar(leftSide)) {
    return { side: "left", x: leftSide, y };
  }
  if (rightSide + bar.w <= viewport.w - BAR_EDGE && !coversToolbar(rightSide)) {
    return { side: "right", x: rightSide, y };
  }
  // No place to put the bar without covering the toolbar or
  // running off-screen.
  return { side: "hidden", x: 0, y: 0 };
}
