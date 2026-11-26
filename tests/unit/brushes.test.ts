// Unit tests for the Brush Library plugin
// (plugins/brushes/): the pressure curve, the texture
// builder, the preset store, and applying a brush —
// including the core tool it configures. Pure data and
// a mocked API: no DOM, no board.
import { describe, expect, it } from "vitest";
import type { PluginContext } from "bowerbird-plugin-api";
import { activateBrush, applyBrush, applyBrushDefaults, brushDefaults } from "../../plugins/brushes/apply";
import { applyCurve, clampExponent, copyCurve, curveFromExponent, LINEAR_CURVE, parseCurvePoints } from "../../plugins/brushes/curve";
import {
  createPreset, createTexture, deletePreset,
  nextPresetName, parseStored, renamePreset, seededStore,
  updatePreset, type BrushStore,
} from "../../plugins/brushes/store";
import { BUILTIN_TEXTURES, familyForTextureId, textureFilterSvg } from "../../plugins/brushes/textures";

describe("pressure curve", () => {
  it("is linear on the diagonal, steeper above 1, gentler below", () => {
    expect(applyCurve(0.5, LINEAR_CURVE)).toBe(0.5);
    expect(applyCurve(0.5, curveFromExponent(2))).toBe(0.25);
    expect(applyCurve(0.25, curveFromExponent(0.5))).toBe(0.5);
    expect(applyCurve(0, curveFromExponent(2))).toBe(0);
    expect(applyCurve(1, curveFromExponent(4))).toBe(1);
  });
  it("interpolates between points and clamps outside 0..1", () => {
    const mid = [{ x: 0, y: 0 }, { x: 0.5, y: 0.25 }, { x: 1, y: 1 }];
    expect(applyCurve(0.25, mid)).toBe(0.125);
    expect(applyCurve(0.75, mid)).toBe(0.625);
    expect(applyCurve(2, LINEAR_CURVE)).toBe(1);
    expect(applyCurve(-1, LINEAR_CURVE)).toBe(0);
  });
  it("migrates an old exponent to equivalent points", () => {
    expect(curveFromExponent(1)).toEqual(LINEAR_CURVE);
    expect(curveFromExponent(2)).toEqual([
      { x: 0, y: 0 }, { x: 0.25, y: 0.0625 }, { x: 0.5, y: 0.25 }, { x: 0.75, y: 0.5625 }, { x: 1, y: 1 },
    ]);
    expect(curveFromExponent(NaN)).toEqual(LINEAR_CURVE);
    expect(curveFromExponent(99)).toEqual(curveFromExponent(4));
    expect(clampExponent(10)).toBe(4);
    expect(clampExponent(0)).toBe(0.25);
    expect(clampExponent(NaN)).toBe(1);
  });
  it("a handle bends the segment; without handles it stays linear", () => {
    // Both handles set: the curve stays low, then rises late.
    const bent = [
      { x: 0, y: 0, out: { dx: 0.6, dy: 0.1 } },
      { x: 1, y: 1, in: { dx: -0.1, dy: -0.6 } },
    ];
    expect(applyCurve(0, bent)).toBe(0);
    expect(applyCurve(1, bent)).toBe(1);
    expect(applyCurve(0.25, bent)).toBeCloseTo(0.0588, 3);
    expect(applyCurve(0.5, bent)).toBeCloseTo(0.1682, 3);
    expect(applyCurve(0.75, bent)).toBeCloseTo(0.3819, 3);
    // One handle only: the other side keeps its default.
    const oneSide = [{ x: 0, y: 0, out: { dx: 0.5, dy: 0 } }, { x: 1, y: 1 }];
    expect(applyCurve(0.5, oneSide)).toBeCloseTo(0.2905, 3);
    // The endpoints stay exact.
    expect(applyCurve(0.5, LINEAR_CURVE)).toBe(0.5);
  });
  it("parseCurvePoints keeps handles and drops a bad one", () => {
    const handled = [
      { x: 0, y: 0, out: { dx: 0.5, dy: 0 } },
      { x: 1, y: 1, in: { dx: -0.5, dy: 0 } },
    ];
    expect(parseCurvePoints(handled)).toEqual(handled);
    // A stored curve without handles is unchanged: no
    // handles are invented for it.
    expect(parseCurvePoints(LINEAR_CURVE)).toEqual(LINEAR_CURVE);
    // A malformed handle is dropped, not a reason to
    // reject the curve — the point still draws.
    expect(parseCurvePoints([
      { x: 0, y: 0, out: { dx: NaN, dy: 0 } },
      { x: 1, y: 1 },
    ])).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(parseCurvePoints([
      { x: 0, y: 0, out: { dx: 2, dy: 0 } },
      { x: 1, y: 1 },
    ])).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });
  it("copyCurve copies handles by value, not by reference", () => {
    const curve = [{ x: 0, y: 0, out: { dx: 0.5, dy: 0 } }, { x: 1, y: 1 }];
    const copy = copyCurve(curve);
    copy[0].out!.dx = 0.1;
    expect(curve[0].out).toEqual({ dx: 0.5, dy: 0 });
  });
  it("parseCurvePoints accepts a rising run and rejects the rest", () => {
    expect(parseCurvePoints(LINEAR_CURVE)).toEqual(LINEAR_CURVE);
    expect(parseCurvePoints([{ x: 0, y: 0 }])).toBeNull();
    expect(parseCurvePoints([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0.4, y: 0.6 }, { x: 1, y: 1 }])).toBeNull();
    expect(parseCurvePoints([{ x: 0, y: 0 }, { x: 1, y: 2 }])).toBeNull();
    expect(parseCurvePoints("no")).toBeNull();
  });
});

describe("texture filter SVG", () => {
  it("builds turbulence plus displacement from the parameters", () => {
    const svg = textureFilterSvg({ baseFrequency: 0.5, octaves: 3, scale: 5, seed: 2 });
    expect(svg).toContain('baseFrequency="0.5"');
    expect(svg).toContain('numOctaves="3"');
    expect(svg).toContain('scale="5"');
    expect(svg).toContain('seed="2"');
    expect(svg).toContain("feTurbulence");
    expect(svg).toContain("feDisplacementMap");
  });
  it("clamps out-of-range parameters", () => {
    const svg = textureFilterSvg({ baseFrequency: 9, octaves: 99, scale: -4, seed: 500 });
    expect(svg).toContain('baseFrequency="1"');
    expect(svg).toContain('numOctaves="5"');
    expect(svg).toContain('scale="0"');
    expect(svg).toContain('seed="100"');
  });
  it("ships eight built-ins, each a different filter, one per pen family", () => {
    expect(BUILTIN_TEXTURES.map((t) => t.id)).toEqual(["graphite", "chalk", "grain", "marker", "charcoal", "crayon", "watercolour", "spray"]);
    // Eight different constructions: no two read alike.
    expect(new Set(BUILTIN_TEXTURES.map((t) => t.filterSvg)).size).toBe(8);
    for (const t of BUILTIN_TEXTURES) expect(t.filterSvg.length).toBeGreaterThan(0);
    expect(BUILTIN_TEXTURES.filter((t) => t.family === "pencil").map((t) => t.id)).toEqual(["graphite", "chalk", "charcoal", "crayon"]);
    expect(BUILTIN_TEXTURES.filter((t) => t.family === "pen").map((t) => t.id)).toEqual(["grain", "spray"]);
    expect(BUILTIN_TEXTURES.filter((t) => t.family === "highlighter").map((t) => t.id)).toEqual(["marker", "watercolour"]);
  });
  it("spray scatters beyond the line instead of clipping to it", () => {
    const spray = BUILTIN_TEXTURES.find((t) => t.id === "spray")!;
    // A wide copy of the stroke, cut to specks: the dots
    // live outside the line, not just inside it. The wide
    // copy is a blur pushed back up by a transfer, not a
    // dilate — feMorphology left a faint wash over the
    // whole filter region in the app. The dots are cut
    // hard from the band, with no second blur after the
    // cut: a blur there softened every dot's edge and
    // the scatter read as a blurry smear.
    expect(spray.filterSvg).not.toContain("feMorphology");
    expect(spray.filterSvg).toContain('stdDeviation="8"');
    expect(spray.filterSvg).toContain('result="fat"');
    expect(spray.filterSvg).not.toContain('result="soft"');
    // Dots only: no solid core under the scatter — a core
    // read as a straight line with dust on it.
    expect(spray.filterSvg).not.toContain("feMerge");
    expect(spray.filterSvg).not.toContain("core");
    expect(spray.filterSvg).toContain('result="dots"');
  });
  it("familyForTextureId maps built-ins, and null for the rest", () => {
    expect(familyForTextureId("graphite")).toBe("pencil");
    expect(familyForTextureId("spray")).toBe("pen");
    expect(familyForTextureId("marker")).toBe("highlighter");
    expect(familyForTextureId(null)).toBeNull();
    expect(familyForTextureId("tex-1")).toBeNull();
  });
});

describe("brush store", () => {
  function seeded(): BrushStore {
    return seededStore();
  }
  it("seeds eight presets and no user textures", () => {
    const store = seeded();
    expect(store.presets.map((p) => p.name)).toEqual(["Ink", "Graphite", "Chalk", "Marker", "Charcoal", "Crayon", "Watercolour", "Spray"]);
    expect(store.presets.map((p) => p.family)).toEqual(["pen", "pencil", "pencil", "highlighter", "pencil", "pencil", "highlighter", "pen"]);
    expect(store.presets[1].texture).toBe("graphite");
    expect(store.presets[0].texture).toBeNull();
    // The wash brushes are the highlighter family: marker
    // is the family, not a stored flag.
    expect(store.presets[3].family).toBe("highlighter");
    expect(store.presets[6].family).toBe("highlighter");
    expect(store.textures).toEqual([]);
  });
  it("parseStored accepts a valid shape and rejects the rest", () => {
    expect(parseStored(seeded())).toEqual(seeded());
    expect(parseStored(null)).toBeNull();
    expect(parseStored("no")).toBeNull();
    expect(parseStored({ presets: [{ id: "preset-1", name: "Ink", texture: null, curve: 1, marker: false }], textures: [] })).not.toBeNull();
    // An old numeric curve migrates to its equivalent points.
    const migrated = parseStored({ presets: [{ id: "preset-1", name: "Ink", texture: null, curve: 2, marker: false }], textures: [] });
    expect(migrated?.presets[0].curve).toEqual(curveFromExponent(2));
    // An old preset without a family takes its texture's.
    const migratedFamily = parseStored({ presets: [{ id: "preset-2", name: "Graphite", texture: "graphite", curve: 1, marker: false }], textures: [] });
    expect(migratedFamily?.presets[0].family).toBe("pencil");
    const migratedPlain = parseStored({ presets: [{ id: "preset-1", name: "Ink", texture: null, curve: 1, marker: false }], textures: [] });
    expect(migratedPlain?.presets[0].family).toBe("pen");
    expect(parseStored({ presets: [{ id: "preset-1", name: "Ink", texture: null, curve: 1 }], textures: [] })).not.toBeNull();
    // A preset needs no size any more, and old stored data
    // with one still loads: the size is ignored on read.
    expect(parseStored({ presets: [{ id: "preset-1", name: "Ink", texture: null, size: 3, curve: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], textures: [] })?.presets[0]).toEqual({ id: "preset-1", name: "Ink", texture: null, curve: LINEAR_CURVE, family: "pen" });
    expect(parseStored({ presets: [{ id: "preset-1", name: "Ink", texture: "bad id", size: 3, curve: 1, marker: false }], textures: [] })).toBeNull();
    expect(parseStored({ presets: [], textures: [{ id: "tex-1", name: "T", baseFrequency: 0.5, octaves: 2, scale: 4, seed: 1 }] })).not.toBeNull();
    expect(parseStored({ presets: [], textures: [{ id: "tex-1", name: "T", baseFrequency: 0.5, octaves: 2.5, scale: 4, seed: 1 }] })).toBeNull();
  });
  it("createPreset names the next free Brush N and copies the base", () => {
    const { store, index } = createPreset(seeded(), { texture: "grain", curve: curveFromExponent(2) });
    expect(index).toBe(8);
    expect(store.presets[8]).toEqual({ id: "preset-9", name: "Brush 1", texture: "grain", curve: curveFromExponent(2), family: "pen" });
    expect(nextPresetName(store)).toBe("Brush 2");
  });
  it("createPreset takes an explicit name, and a blank one auto-names", () => {
    const { store } = createPreset(seeded(), { name: "  Soft Chalk  ", texture: "chalk" });
    expect(store.presets[8].name).toBe("Soft Chalk");
    expect(store.presets[8].family).toBe("pencil");
    const blank = createPreset(seeded(), { name: "   ", texture: "chalk" });
    expect(blank.store.presets[8].name).toBe("Brush 1");
  });
  it("createTexture numbers custom textures tex-1, tex-2, and leaves the presets alone", () => {
    const first = createTexture(seeded(), { name: "Grainy", baseFrequency: 0.5, octaves: 2, scale: 4, seed: 1 });
    expect(first.index).toBe(0);
    expect(first.store.textures[0]).toEqual({ id: "tex-1", name: "Grainy", baseFrequency: 0.5, octaves: 2, scale: 4, seed: 1 });
    const second = createTexture(first.store, { name: "Coarse", baseFrequency: 0.3, octaves: 3, scale: 6, seed: 11 });
    expect(second.index).toBe(1);
    expect(second.store.textures[1].id).toBe("tex-2");
    expect(second.store.presets).toEqual(first.store.presets);
  });
  it("renamePreset trims, refuses an empty name, and leaves the input alone", () => {
    const before = seeded();
    expect(renamePreset(before, 1, "  Soft  ").presets[1].name).toBe("Soft");
    expect(renamePreset(before, 1, "   ")).toBe(before);
    expect(renamePreset(before, 9, "Soft")).toBe(before);
    expect(before.presets[1].name).toBe("Graphite");
  });
  it("deletePreset removes, and refuses bad indexes", () => {
    const before = seeded();
    expect(deletePreset(before, 0).presets.map((p) => p.name)).toEqual(["Graphite", "Chalk", "Marker", "Charcoal", "Crayon", "Watercolour", "Spray"]);
    expect(deletePreset(before, 9)).toBe(before);
  });
  it("updatePreset checks the curve, and refuses a bad texture id", () => {
    const before = seeded();
    expect(updatePreset(before, 0, { texture: "bad id" })).toBe(before);
    expect(updatePreset(before, 0, { texture: "grain" }).presets[0].texture).toBe("grain");
    expect(updatePreset(before, 0, { curve: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }).presets[0].curve).toEqual(LINEAR_CURVE);
    expect(updatePreset(before, 0, { curve: [{ x: 0, y: 0 }] })).toBe(before);
    expect(updatePreset(before, 9, { texture: "grain" })).toBe(before);
  });
});

describe("applyBrush", () => {
  function strokeItem(id: number) {
    return { id, pos: { x: 0, y: 0 }, size: { w: 100, h: 20 }, group: null, kind: { Stroke: { points: [{ x: 0, y: 0 }], color: "#1A1A1A", width: 3, marker: false } } };
  }
  function textItem(id: number) {
    return { id, pos: { x: 0, y: 0 }, size: { w: 260, h: 48 }, group: null, kind: { Text: { text: "Note", bold: false, size: 16, color: "#1A1A1A" } } };
  }
  function makeApi(selected: number[], items: unknown[], updateResult = true) {
    const calls: unknown[] = [];
    const defaults: unknown[] = [];
    const penDefaults: Record<string, unknown> = {};
    let tool: string | null = null;
    let toast: string | null = null;
    const api = {
      board: {
        getSelected: () => selected,
        getItems: () => items,
        updateItems: (patches: unknown) => { calls.push(patches); return updateResult; },
      },
      pen: {
        getStrokeDefaults: () => ({ ...penDefaults }),
        setStrokeDefaults: (kind: string, d: unknown) => { defaults.push([kind, d]); },
      },
      ui: {
        setTool: (id: string) => { tool = id; },
        toast: (msg: string) => { toast = msg; },
      },
    };
    return { api: api as unknown as PluginContext, calls, defaults, penDefaults, tool: () => tool, toast: () => toast };
  }
  const graphite = { id: "preset-2", name: "Graphite", texture: "graphite", curve: LINEAR_CURVE, family: "pencil" as const };
  const ink = { id: "preset-1", name: "Ink", texture: null, curve: LINEAR_CURVE, family: "pen" as const };
  const marker = { id: "preset-4", name: "Marker", texture: "marker", curve: LINEAR_CURVE, family: "highlighter" as const };
  it("activates the pen when nothing stroke-like is selected", () => {
    const f = makeApi([3], [textItem(3)]);
    applyBrush(f.api, graphite);
    expect(f.tool()).toBe("plugin:core-draw:pen");
    expect(f.defaults).toEqual([["pen", { texture: "graphite", marker: false, curve: LINEAR_CURVE, width: 3 }]]);
    expect(f.calls).toEqual([]);
    expect(f.toast()).toBeNull();
  });
  it("brushDefaults derives marker from the family", () => {
    expect(brushDefaults(graphite).marker).toBe(false);
    expect(brushDefaults(marker).marker).toBe(true);
    expect(brushDefaults(marker)).toEqual({ texture: "marker", marker: true, curve: LINEAR_CURVE });
  });
  it("applyBrushDefaults sets the preset on the pen", () => {
    const f = makeApi([], []);
    applyBrushDefaults(f.api, graphite);
    expect(f.defaults).toEqual([["pen", { texture: "graphite", marker: false, curve: LINEAR_CURVE, width: 3 }]]);
    expect(f.tool()).toBeNull();
  });
  it("applyBrushDefaults keeps the pen width", () => {
    const f = makeApi([], []);
    f.penDefaults.width = 17;
    applyBrushDefaults(f.api, graphite);
    expect(f.defaults).toEqual([["pen", { texture: "graphite", marker: false, curve: LINEAR_CURVE, width: 17 }]]);
    expect(f.tool()).toBeNull();
  });
  it("activateBrush sets the defaults and the pen", () => {
    const f = makeApi([], []);
    activateBrush(f.api, marker);
    expect(f.defaults).toEqual([["pen", { texture: "marker", marker: true, curve: LINEAR_CURVE, width: 3 }]]);
    expect(f.tool()).toBe("plugin:core-draw:pen");
  });
  it("applies texture to the selected strokes in one call, leaving the width alone", () => {
    const f = makeApi([1, 3], [strokeItem(1), textItem(3)]);
    applyBrush(f.api, graphite);
    expect(f.tool()).toBeNull();
    expect(f.calls).toEqual([[{ id: 1, data: { texture: "graphite" } }]]);
    expect(f.toast()).toBeNull();
  });
  it("a textureless brush clears the texture", () => {
    const f = makeApi([1], [strokeItem(1)]);
    applyBrush(f.api, ink);
    expect(f.calls).toEqual([[{ id: 1, data: { texture: null } }]]);
  });
  it("toasts when the apply is refused", () => {
    const f = makeApi([1], [strokeItem(1)], false);
    applyBrush(f.api, graphite);
    expect(f.toast()).toBe("Layer is locked");
    expect(f.tool()).toBeNull();
  });
});
