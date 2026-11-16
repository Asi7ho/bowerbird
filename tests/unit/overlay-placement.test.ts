// Unit tests for the overlay placement geometry
// (src/ui/overlay-placement.ts): where the note colour bar
// sits beside its note, and whether a handle's box is clear
// of the toolbar. Pure geometry, no DOM — these are the
// regressions behind the bar and handle bugs of PR #49:
// the bar sliding relative to the note, the bar and the
// resize handle painting over the toolbar.
import { describe, expect, it } from "vitest";
import { placeNoteBar, rectsOverlap, type OverlayRect } from "../../src/ui/overlay-placement";

// The sandbox window the live checks use: 1280x850, toolbar
// a vertical strip on the left edge.
const VIEWPORT = { w: 1280, h: 850 };
const TOOLBAR: OverlayRect = { x: 12, y: 213, w: 56, h: 473 };
const BAR = { w: 44, h: 240 };

describe("rectsOverlap", () => {
  it("overlapping rects overlap", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });
  it("a rect inside another overlaps", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 100, h: 100 }, { x: 20, y: 20, w: 10, h: 10 })).toBe(true);
  });
  it("disjoint rects do not overlap", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 20, w: 10, h: 10 })).toBe(false);
  });
  it("rects sharing only an edge do not overlap", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 10, w: 10, h: 10 })).toBe(false);
  });
});

describe("placeNoteBar", () => {
  it("sits on the left of a mid-screen note, top-aligned, 8px off", () => {
    const p = placeNoteBar({ x: 300, y: 300, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT);
    expect(p.side).toBe("left");
    expect(p.x).toBe(300 - 44 - 8);
    expect(p.y).toBe(300);
  });

  it("never clamps its top: a note near the bottom keeps the bar top-aligned with it", () => {
    // This is the sliding bug: the old clamp put the bar at
    // 850 - 240 - 8 = 602 while the note was at 700, so the
    // bar drifted up to 191px off the note through a pan.
    // The bar is an extension of the note — its top is the
    // note's top, even if that runs past the viewport edge.
    const p = placeNoteBar({ x: 300, y: 700, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT);
    expect(p.side).toBe("left");
    expect(p.y).toBe(700);
  });

  it("never clamps its top at the top edge either", () => {
    const p = placeNoteBar({ x: 300, y: 0, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT);
    expect(p.side).toBe("left");
    expect(p.y).toBe(0);
  });

  it("flips to the right when the left side would run off the viewport", () => {
    const p = placeNoteBar({ x: 30, y: 300, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT);
    expect(p.side).toBe("right");
    expect(p.x).toBe(30 + 120 + 8);
    expect(p.y).toBe(300);
  });

  it("flips to the right when the left side would cover the toolbar", () => {
    // The note is far enough right that the bar fits on the
    // left of the viewport (left side at x 48), but that
    // rect (48-92) overlaps the toolbar (12-68) at y 300.
    const p = placeNoteBar({ x: 100, y: 300, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT);
    expect(p.side).toBe("right");
    expect(p.x).toBe(100 + 120 + 8);
    expect(p.y).toBe(300);
  });

  it("stays on the left at the same spot when there is no toolbar", () => {
    // Same note as above: without the toolbar the left side
    // is free, so the bar does not flip.
    const p = placeNoteBar({ x: 100, y: 300, w: 120, h: 40 }, BAR, null, VIEWPORT);
    expect(p.side).toBe("left");
    expect(p.x).toBe(100 - 44 - 8);
  });

  it("hides when even the right side would cover the toolbar", () => {
    // The note is mostly off-screen to the left: its right
    // edge is at 59, so the right-side bar (67-111) lands
    // on the toolbar (12-68) at y 300.
    const p = placeNoteBar({ x: -61, y: 300, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT);
    expect(p.side).toBe("hidden");
  });

  it("hides when the note is fully off-screen", () => {
    expect(placeNoteBar({ x: -200, y: 300, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT).side).toBe("hidden");
    expect(placeNoteBar({ x: 1300, y: 300, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT).side).toBe("hidden");
    expect(placeNoteBar({ x: 300, y: -100, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT).side).toBe("hidden");
    expect(placeNoteBar({ x: 300, y: 900, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT).side).toBe("hidden");
  });

  it("stays visible while any part of the note is on-screen", () => {
    // A note hanging off the left edge: the bar flips right
    // (its left side would be off-screen) but it does not
    // vanish — its right-side spot (88-132) clears the
    // toolbar (12-68).
    const p = placeNoteBar({ x: -40, y: 300, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT);
    expect(p.side).toBe("right");
  });

  it("needs no toolbar to place the bar on the left", () => {
    const p = placeNoteBar({ x: 120, y: 300, w: 120, h: 40 }, BAR, null, VIEWPORT);
    expect(p.side).toBe("left");
  });

  it("stays on the left near the right edge", () => {
    const p = placeNoteBar({ x: 1100, y: 300, w: 120, h: 40 }, BAR, TOOLBAR, VIEWPORT);
    expect(p.side).toBe("left");
    expect(p.x).toBe(1100 - 44 - 8);
  });
});
