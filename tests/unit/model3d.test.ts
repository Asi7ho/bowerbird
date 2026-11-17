// Unit tests for the 3D layer's pan transform
// (src/backend/model3d.ts, layerTransform): the CSS transform
// that carries the already-rendered shared WebGL layer with
// the camera during a pan or zoom, instead of re-rendering
// every frame. Pure geometry, no DOM. These pin the mapping
// the layer depends on: a world point rendered at its old
// screen position must land exactly on its new screen
// position after the transform, or the models drift away
// from their cards mid-pan.
import { describe, expect, it } from "vitest";
import { isWorthTurning, layerTransform } from "../../src/backend/model3d";

type Cam = { x: number; y: number; zoom: number };

// Where a world point sits on screen under a camera.
const screen = (w: { x: number; y: number }, cam: Cam) => ({
  x: (w.x - cam.x) * cam.zoom,
  y: (w.y - cam.y) * cam.zoom,
});

// The transform must map the old screen position onto the
// new one, for several world points and camera moves.
const expectTracks = (from: Cam, to: Cam, points: Array<{ x: number; y: number }>) => {
  const t = layerTransform(from, to);
  for (const w of points) {
    const oldS = screen(w, from);
    const want = screen(w, to);
    expect(oldS.x * t.s + t.tx).toBeCloseTo(want.x, 9);
    expect(oldS.y * t.s + t.ty).toBeCloseTo(want.y, 9);
  }
};

const POINTS = [
  { x: 0, y: 0 },
  { x: 500, y: 300 },
  { x: -200, y: 900 },
  { x: 3000, y: -400 },
];

describe("layerTransform", () => {
  it("is the identity when the camera did not move", () => {
    const t = layerTransform({ x: 100, y: 200, zoom: 1.5 }, { x: 100, y: 200, zoom: 1.5 });
    expect(t).toEqual({ tx: 0, ty: 0, s: 1 });
  });

  it("panning right moves the layer left by the same screen distance", () => {
    // Camera x +100 at zoom 1: every model moves 100px left.
    const t = layerTransform({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 0, zoom: 1 });
    expect(t).toEqual({ tx: -100, ty: 0, s: 1 });
  });

  it("panning down moves the layer up", () => {
    const t = layerTransform({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 50, zoom: 1 });
    expect(t).toEqual({ tx: 0, ty: -50, s: 1 });
  });

  it("panning at zoom scales the translation by the zoom", () => {
    // Camera x +100 at zoom 2: the models move 200px left.
    const t = layerTransform({ x: 0, y: 0, zoom: 2 }, { x: 100, y: 0, zoom: 2 });
    expect(t).toEqual({ tx: -200, ty: 0, s: 1 });
  });

  it("zooming in about the origin scales the layer up", () => {
    const t = layerTransform({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, zoom: 2 });
    expect(t).toEqual({ tx: 0, ty: 0, s: 2 });
  });

  it("zooming out scales the layer down", () => {
    const t = layerTransform({ x: 0, y: 0, zoom: 2 }, { x: 0, y: 0, zoom: 1 });
    expect(t).toEqual({ tx: 0, ty: 0, s: 0.5 });
  });

  it("a pan plus a zoom composes", () => {
    const t = layerTransform({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 50, zoom: 2 });
    expect(t).toEqual({ tx: -200, ty: -100, s: 2 });
  });

  it("tracks world points through a pan", () => {
    expectTracks({ x: 0, y: 0, zoom: 1 }, { x: 137, y: -42, zoom: 1 }, POINTS);
  });

  it("tracks world points through a zoom", () => {
    expectTracks({ x: 100, y: 100, zoom: 0.5 }, { x: 100, y: 100, zoom: 2 }, POINTS);
  });

  it("tracks world points through a pan and zoom together", () => {
    expectTracks({ x: 40, y: -80, zoom: 1.2 }, { x: 300, y: 150, zoom: 0.7 }, POINTS);
  });

  it("tracks world points at fit zoom on a wide board", () => {
    // A 2,000-card board fits at zoom ~0.07; panning there
    // moves models by only a few screen pixels, so the
    // transform must be exact, not approximately right.
    expectTracks({ x: 0, y: 0, zoom: 0.073 }, { x: 500, y: 200, zoom: 0.073 }, POINTS);
  });
});

describe("isWorthTurning", () => {
  // The gate for the idle turn (src/backend/model3d.ts):
  // a model only counts toward the auto-rotate trigger
  // when its larger on-screen dimension is at least 48px.
  // Below that the turn is invisible, so rendering the
  // whole layer every 100ms for it is pure waste.
  it("a model at fit zoom is too small to turn", () => {
    // The 2,000-card board fits at zoom ~0.046; a 360px
    // model card is ~16px on screen there.
    expect(isWorthTurning(360, 300, 0.0456)).toBe(false);
  });

  it("the same model at working zoom turns", () => {
    expect(isWorthTurning(360, 300, 0.84)).toBe(true);
  });

  it("the threshold is 48px on the larger dimension", () => {
    // 360px wide at zoom 48/360 is exactly 48px.
    expect(isWorthTurning(360, 300, 48 / 360)).toBe(true);
    expect(isWorthTurning(360, 300, 47 / 360)).toBe(false);
  });

  it("a wide flat model counts on its width", () => {
    // 500px wide but only 10px tall: the turn reads on
    // the width, so at zoom 0.1 (50px) it turns.
    expect(isWorthTurning(500, 10, 0.1)).toBe(true);
    expect(isWorthTurning(500, 10, 0.09)).toBe(false);
  });

  it("zero size or zero zoom never turns", () => {
    expect(isWorthTurning(0, 0, 1)).toBe(false);
    expect(isWorthTurning(360, 300, 0)).toBe(false);
  });
});
