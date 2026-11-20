// Unit tests for the 3D viewer framing (src/backend/model3d.ts):
// the view a model opens with, and the formats a card can load.
import { describe, expect, it } from "vitest";
import { MODEL3D_EXTENSIONS, initialViewState, model3DExtension } from "../../src/backend/model3d";

describe("MODEL3D_EXTENSIONS", () => {
  it("covers the self-contained formats, not .gltf", () => {
    for (const ext of ["glb", "obj", "fbx", "stl", "usdz", "dae"]) {
      expect(MODEL3D_EXTENSIONS.has(ext)).toBe(true);
    }
    // A .gltf keeps its geometry in a separate .bin that
    // would not be embedded with it, so it stays out.
    expect(MODEL3D_EXTENSIONS.has("gltf")).toBe(false);
  });
});

describe("model3DExtension", () => {
  it("reads the extension from a stored path or a file URL", () => {
    expect(model3DExtension("assets/cube.glb")).toBe("glb");
    expect(model3DExtension("app-file://localhost/assets/model.OBJ")).toBe("obj");
    expect(model3DExtension("assets/no-extension")).toBe("");
    expect(model3DExtension("assets/model.fbx")).toBe("fbx");
  });
});

describe("initialViewState", () => {
  it("frames the model straight on, slightly above", () => {
    const v = initialViewState(1);
    expect(v.azimuth).toBe(0);
    expect(v.elevation).toBe(0.35);
  });

  it("scales the distance with the model, inside the framing clamp", () => {
    expect(initialViewState(1).distance).toBe(2.4);
    expect(initialViewState(2).distance).toBe(4.8);
    expect(initialViewState(0.5).distance).toBe(1.2);
    // The load clamp is [radius * 1.1, radius * 6]; the
    // opening distance (radius * 2.4) sits inside it, so
    // the model always opens framed.
    for (const r of [0.01, 0.5, 1, 10, 100]) {
      const d = initialViewState(r).distance;
      expect(d).toBeGreaterThanOrEqual(r * 1.1);
      expect(d).toBeLessThanOrEqual(r * 6);
    }
  });
});
