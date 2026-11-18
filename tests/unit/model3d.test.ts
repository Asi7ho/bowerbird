// Unit tests for the 3D viewer framing (src/backend/model3d.ts):
// the view a model opens with, which the fit button restores.
import { describe, expect, it } from "vitest";
import { initialViewState } from "../../src/backend/model3d";

describe("initialViewState", () => {
  it("frames the model straight on, slightly above", () => {
    const v = initialViewState(1);
    expect(v.azimuth).toBe(0);
    expect(v.elevation).toBe(0.35);
  });

  it("scales the distance with the model", () => {
    expect(initialViewState(1).distance).toBe(2.4);
    expect(initialViewState(2).distance).toBe(4.8);
    expect(initialViewState(0.5).distance).toBe(1.2);
  });

  it("stays inside the wheel-zoom clamp for any model", () => {
    // The wheel clamp is [radius * 1.1, radius * 6]; the
    // opening distance (radius * 2.4) sits inside it, so a
    // fitted model can still be zoomed either way.
    for (const r of [0.01, 0.5, 1, 10, 100]) {
      const d = initialViewState(r).distance;
      expect(d).toBeGreaterThanOrEqual(r * 1.1);
      expect(d).toBeLessThanOrEqual(r * 6);
    }
  });
});
