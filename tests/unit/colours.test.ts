// Unit tests for the Colour Library palette store
// (plugins/colours/store.ts) and its hex helper
// (plugins/colours/color.ts): pure data, no DOM, no API.
import { describe, expect, it } from "vitest";
import type { PluginContext } from "bowerbird-plugin-api";
import { applyColour } from "../../plugins/colours/apply";
import { brightHex, deepShadeHex, gradientPixels, hexToHsl, hexToHsv, hexToRgb, hslToHex, hsvToHex, isHex, isNearDuplicate, colourDistance, normaliseHex, rgbToHex, HARMONY_NAMES, harmoniesFor } from "../../plugins/colours/color";
import {
  addColour,
  createPalette,
  deletePalette,
  emptyStore,
  MAX_RECENT,
  movePalette,
  nextPaletteName,
  parseRecent,
  parseStored,
  recordRecent,
  removeColour,
  renamePalette,
  type ColourStore,
} from "../../plugins/colours/store";

describe("normaliseHex", () => {
  it("normalises #rgb and #rrggbb to uppercase #RRGGBB, and rejects the rest", () => {
    expect(normaliseHex("#f00")).toBe("#FF0000");
    expect(normaliseHex("#00ff00")).toBe("#00FF00");
    expect(normaliseHex("FF0000")).toBe("#FF0000");
    expect(normaliseHex("red")).toBeNull();
    expect(normaliseHex("#GG0000")).toBeNull();
    expect(normaliseHex("")).toBeNull();
    expect(isHex("#ABCDEF")).toBe(true);
    expect(isHex("blue")).toBe(false);
  });
});

describe("hslToHex and hexToHsl", () => {
  it("converts the primaries and round-trips real colours", () => {
    expect(hslToHex(0, 100, 50)).toBe("#FF0000");
    expect(hslToHex(120, 100, 50)).toBe("#00FF00");
    expect(hslToHex(240, 100, 50)).toBe("#0000FF");
    expect(hslToHex(0, 0, 50)).toBe("#808080");
    // Integer sliders quantise: 211° is one step off the
    // pen's blue, which is 211.29° from hexToHsl.
    expect(hslToHex(211, 100, 50)).toBe("#007BFF");
    expect(hexToHsl("#007AFF")).toEqual({ h: expect.closeTo(211.29, 2), s: 100, l: 50 });
    const red = hexToHsl("#E63946");
    expect(hslToHex(red.h, red.s, red.l)).toBe("#E63946");
    const grey = hexToHsl("#1A1A1A");
    expect(hslToHex(grey.h, grey.s, grey.l)).toBe("#1A1A1A");
  });
});

describe("deepShadeHex", () => {
  it("is the same hue and saturation, 30 lightness below the pick and never above 18", () => {
    // The e2e red (355°, 78%, 56%) fades to a deep crimson.
    expect(deepShadeHex("#E63746")).toBe("#520A10");
    const shade = hexToHsl(deepShadeHex("#E63746"));
    expect(shade.h).toBeCloseTo(355, 0);
    expect(shade.s).toBeCloseTo(78, 0);
    expect(shade.l).toBeCloseTo(18, 0);
    // A light pick fades to a deep shade, not a wash-out.
    expect(deepShadeHex("#F5C542")).toBe("#574105");
    // A mid pick lands on the 18 cap.
    expect(hexToHsl(deepShadeHex("#7FB069")).l).toBeCloseTo(18, 0);
  });

  it("never goes below the darkest hslToHex renders, so a black pick is flat by nature", () => {
    // Dark grey fades to the darkest renderable shade.
    expect(deepShadeHex("#262626")).toBe("#0D0D0D");
    // Black has no darker shade: the pick itself clamps
    // to #0D0D0D, so both stops are the same colour.
    expect(deepShadeHex("#000000")).toBe("#0D0D0D");
    expect(deepShadeHex("#000000")).toBe(hslToHex(0, 0, 5));
  });
});

describe("brightHex", () => {
  it("keeps hue and saturation and lands at lightness 50%", () => {
    // A dark red reads as vivid red while dragging.
    const input = hexToHsl("#2D0609");
    const out = hexToHsl(brightHex("#2D0609"));
    expect(out.h).toBeCloseTo(input.h, 0);
    expect(out.s).toBeCloseTo(input.s, 0);
    expect(out.l).toBeCloseTo(50, 0);
    // A pick already at 50% is unchanged.
    expect(brightHex(hslToHex(200, 80, 50))).toBe(hslToHex(200, 80, 50));
    // A light pick comes down to 50%, not to black.
    expect(hexToHsl(brightHex("#F5C542")).l).toBeCloseTo(50, 0);
  });
});

describe("gradientPixels", () => {
  const red = { offset: 0, color: "#E63746" };
  const dark = { offset: 100, color: "#520A10" };
  const px = (buf: Uint8ClampedArray, w: number, x: number, y = 0): [number, number, number, number] => {
    const i = (y * w + x) * 4;
    return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
  };
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1;

  it("runs from the first stop to the last, with the opacity as a uniform alpha", () => {
    const buf = gradientPixels([red, dark], 101, 4, 50);
    expect(buf.length).toBe(101 * 4 * 4);
    const [r0, g0, b0, a0] = px(buf, 101, 0);
    expect(close(r0, 230) && close(g0, 55) && close(b0, 70)).toBe(true);
    const [r1, g1, b1, a1] = px(buf, 101, 100);
    expect(close(r1, 82) && close(g1, 10) && close(b1, 16)).toBe(true);
    expect(a0).toBe(128);
    expect(a1).toBe(128);
    // The middle is the average of the stops, give or take the noise.
    const [rm, gm, bm] = px(buf, 101, 50);
    expect(close(rm, 156) && close(gm, 33) && close(bm, 43)).toBe(true);
  });

  it("is seeded: the same gradient paints the same pixels every time", () => {
    const a = gradientPixels([red, dark], 80, 40, 100);
    const b = gradientPixels([red, dark], 80, 40, 100);
    expect(a).toEqual(b);
    // A different gradient paints different grain.
    const c = gradientPixels([red, { offset: 100, color: "#0000FF" }], 80, 40, 100);
    expect(c).not.toEqual(a);
  });

  it("keeps every pixel within one step of the noiseless ramp", () => {
    const buf = gradientPixels([red, dark], 201, 2, 100);
    for (let x = 0; x < 201; x++) {
      const t = x / 200;
      const [r, g, b] = px(buf, 201, x);
      expect(Math.abs(r - (230 + (82 - 230) * t))).toBeLessThanOrEqual(1);
      expect(Math.abs(g - (55 + (10 - 55) * t))).toBeLessThanOrEqual(1);
      expect(Math.abs(b - (70 + (16 - 70) * t))).toBeLessThanOrEqual(1);
    }
  });

  it("handles one stop, unsorted stops, and empty sizes", () => {
    const solid = gradientPixels([red], 10, 2, 100);
    const [r, g, b, a] = px(solid, 10, 9);
    expect(close(r, 230) && close(g, 55) && close(b, 70)).toBe(true);
    expect(a).toBe(255);
    const unsorted = gradientPixels([dark, red], 101, 1, 100);
    const [r0] = px(unsorted, 101, 0);
    expect(close(r0, 230)).toBe(true);
    expect(gradientPixels([red, dark], 0, 10, 100).length).toBe(0);
    expect(gradientPixels([], 10, 10, 100).length).toBe(0);
  });
});

describe("hexToRgb and rgbToHex", () => {
  it("converts the primaries and round-trips real colours", () => {
    expect(hexToRgb("#FF0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("#00FF00")).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb("#0000FF")).toEqual({ r: 0, g: 0, b: 255 });
    expect(rgbToHex(255, 0, 0)).toBe("#FF0000");
    expect(rgbToHex(0, 128, 255)).toBe("#0080FF");
    const c = hexToRgb("#E63946");
    expect(rgbToHex(c.r, c.g, c.b)).toBe("#E63946");
  });
});

describe("hexToHsv and hsvToHex", () => {
  it("converts the primaries and round-trips real colours", () => {
    expect(hexToHsv("#FF0000")).toEqual({ h: 0, s: 100, v: 100 });
    expect(hexToHsv("#00FF00")).toEqual({ h: 120, s: 100, v: 100 });
    expect(hexToHsv("#0000FF")).toEqual({ h: 240, s: 100, v: 100 });
    expect(hexToHsv("#808080")).toEqual({ h: 0, s: 0, v: expect.closeTo(50.2, 1) });
    expect(hsvToHex(0, 100, 100)).toBe("#FF0000");
    expect(hsvToHex(211, 100, 100)).toBe("#007BFF");
    const red = hexToHsv("#E63946");
    expect(hsvToHex(red.h, red.s, red.v)).toBe("#E63946");
    const grey = hexToHsv("#1A1A1A");
    expect(hsvToHex(grey.h, grey.s, grey.v)).toBe("#1A1A1A");
  });
});

describe("harmoniesFor", () => {
  it("returns the five harmony types in order, five colours each", () => {
    const harmonies = harmoniesFor(0, 100, 50);
    expect(harmonies.map((h) => h.name)).toEqual([...HARMONY_NAMES]);
    for (const h of harmonies) {
      expect(h.colors).toHaveLength(5);
      for (const c of h.colors) expect(isHex(c)).toBe(true);
      expect(new Set(h.colors).size).toBe(5);
    }
  });
  it("builds each harmony from the base colour by hue and lightness only", () => {
    const harmonies = harmoniesFor(0, 100, 50);
    const byName = Object.fromEntries(harmonies.map((h) => [h.name, h.colors]));
    // Every harmony but Monochromatic starts at the base.
    expect(byName["Analogous"][2]).toBe("#FF0000");
    expect(byName["Complementary"][0]).toBe("#FF0000");
    expect(byName["Split complementary"][0]).toBe("#FF0000");
    expect(byName["Triadic"][0]).toBe("#FF0000");
    // The opposite hue, and the triadic hues.
    expect(byName["Complementary"][1]).toBe("#00FFFF");
    expect(byName["Triadic"][1]).toBe("#00FF00");
    expect(byName["Triadic"][2]).toBe("#0000FF");
    // Monochromatic: same hue, lightness dark to light.
    const monoLight = byName["Monochromatic"].map((c) => hexToHsl(c).l);
    for (let i = 1; i < monoLight.length; i++) expect(monoLight[i]).toBeGreaterThan(monoLight[i - 1]);
    expect(byName["Monochromatic"][2]).toBe("#FF0000");
    // The tints are the base lightened, never a new hue.
    expect(hexToHsl(byName["Complementary"][2]).h).toBeCloseTo(0, 0);
    expect(hexToHsl(byName["Complementary"][2]).l).toBeGreaterThan(50);
  });
});

describe("palette store", () => {
  function seeded(): ColourStore {
    return { palettes: [{ name: "Palette 1", colors: ["#FF0000"] }, { name: "Warm", colors: [] }] };
  }
  it("parseStored accepts a valid shape and normalises its colours", () => {
    expect(parseStored([{ name: "A", colors: ["#f00", "#00FF00"] }]))
      .toEqual({ palettes: [{ name: "A", colors: ["#FF0000", "#00FF00"] }] });
    expect(parseStored(null)).toBeNull();
    expect(parseStored("no")).toBeNull();
    expect(parseStored([{ name: "A", colors: ["red"] }])).toBeNull();
    expect(parseStored([{ name: "", colors: [] }])).toBeNull();
  });
  it("createPalette names the next free Palette N and seeds its colours", () => {
    const { store, index } = createPalette(seeded(), ["#0000ff", "red", "#0000FF"]);
    expect(index).toBe(2);
    expect(store.palettes[2]).toEqual({ name: "Palette 2", colors: ["#0000FF"] });
    expect(seeded().palettes.length).toBe(2);
  });
  it("nextPaletteName skips names already taken", () => {
    expect(nextPaletteName(emptyStore())).toBe("Palette 1");
    expect(nextPaletteName(seeded())).toBe("Palette 2");
  });
  it("renamePalette trims, refuses an empty name, and leaves the input alone", () => {
    const before = seeded();
    expect(renamePalette(before, 1, "  Cool  ").palettes[1].name).toBe("Cool");
    expect(renamePalette(before, 1, "   ")).toBe(before);
    expect(renamePalette(before, 9, "Cool")).toBe(before);
    expect(before.palettes[1].name).toBe("Warm");
  });
  it("deletePalette and movePalette reorder and remove, and refuse bad indexes", () => {
    const before = seeded();
    expect(deletePalette(before, 0).palettes.map((p) => p.name)).toEqual(["Warm"]);
    expect(deletePalette(before, 9)).toBe(before);
    expect(movePalette(before, 0, 1).palettes.map((p) => p.name)).toEqual(["Warm", "Palette 1"]);
    expect(movePalette(before, 0, -1)).toBe(before);
    expect(movePalette(before, 1, 1)).toBe(before);
  });
  it("addColour normalises, refuses bad hexes and duplicates; removeColour removes by index", () => {
    const before = seeded();
    const added = addColour(before, 0, "#00ff00");
    expect(added.palettes[0].colors).toEqual(["#FF0000", "#00FF00"]);
    expect(addColour(before, 0, "#FF0000")).toBe(before);
    expect(addColour(before, 0, "red")).toBe(before);
    expect(addColour(before, 9, "#00FF00")).toBe(before);
    expect(removeColour(added, 0, 0).palettes[0].colors).toEqual(["#00FF00"]);
    expect(removeColour(added, 0, 9)).toBe(added);
  });
});

describe("recent colours", () => {
  it("parseRecent accepts a valid list, normalises, dedupes and caps at ten", () => {
    expect(parseRecent(["#f00", "#00FF00"])).toEqual(["#FF0000", "#00FF00"]);
    expect(parseRecent(["#FF0000", "#ff0000"])).toEqual(["#FF0000"]);
    expect(parseRecent(null)).toBeNull();
    expect(parseRecent("no")).toBeNull();
    expect(parseRecent(["red"])).toBeNull();
    expect(parseRecent([1])).toBeNull();
    const eleven = Array.from({ length: 11 }, (_, i) => hslToHex(i * 30, 100, 50));
    expect(parseRecent(eleven)).toHaveLength(MAX_RECENT);
  });
  it("parseRecent collapses near-duplicates, keeping the first of each cluster", () => {
    expect(parseRecent(["#007BFF", "#007AFF", "#FF0000"])).toEqual(["#007BFF", "#FF0000"]);
    expect(parseRecent(["#007BFF", "#0A5CFF"])).toEqual(["#007BFF", "#0A5CFF"]);
  });
  it("recordRecent puts the colour first, moves a repeat to the front, and caps at ten", () => {
    const before = ["#FF0000", "#00FF00"];
    expect(recordRecent(before, "#0000ff")).toEqual(["#0000FF", "#FF0000", "#00FF00"]);
    expect(recordRecent(before, "#00ff00")).toEqual(["#00FF00", "#FF0000"]);
    expect(recordRecent(before, "red")).toBe(before);
    expect(before).toEqual(["#FF0000", "#00FF00"]);
    const ten = Array.from({ length: 10 }, (_, i) => hslToHex(i * 30, 100, 50));
    const capped = recordRecent(ten, "#FFFFFF");
    expect(capped).toHaveLength(10);
    expect(capped[0]).toBe("#FFFFFF");
    expect(capped).not.toContain(ten[9]);
  });
  it("recordRecent drops a near-duplicate of the new colour, and keeps visibly different ones", () => {
    expect(recordRecent(["#007AFF", "#FF0000"], "#007BFF")).toEqual(["#007BFF", "#FF0000"]);
    expect(recordRecent(["#0A5CFF", "#FF0000"], "#007BFF")).toEqual(["#007BFF", "#0A5CFF", "#FF0000"]);
  });
  it("colourDistance scores look-alikes low and distinct colours high", () => {
    expect(colourDistance("#007BFF", "#007AFF")).toBeLessThan(15);
    expect(colourDistance("#007BFF", "#0A5CFF")).toBeGreaterThan(15);
    expect(isNearDuplicate("#007BFF", "#007AFF")).toBe(true);
    expect(isNearDuplicate("#007BFF", "#FF0000")).toBe(false);
  });
});

describe("applyColour", () => {
  function strokeItem(id: number, color = "#1A1A1A") {
    return { id, pos: { x: 0, y: 0 }, size: { w: 100, h: 20 }, group: null, kind: { Stroke: { points: [{ x: 0, y: 0 }], color, width: 3, marker: false } } };
  }
  function swatchItem(id: number, hex = "#1A1A1A") {
    return { id, pos: { x: 0, y: 0 }, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex } } };
  }
  function textItem(id: number) {
    return { id, pos: { x: 0, y: 0 }, size: { w: 260, h: 48 }, group: null, kind: { Text: { text: "Note", bold: false, size: 16, color: "#1A1A1A" } } };
  }
  function makeApi(selected: number[], items: unknown[], updateResult = true) {
    const calls: unknown[] = [];
    let pen: string | null = null;
    let penOpacity: number | null = null;
    let penGradient: unknown = undefined;
    let toast: string | null = null;
    const api = {
      board: {
        getSelected: () => selected,
        getItems: () => items,
        updateItems: (patches: unknown) => { calls.push(patches); return updateResult; },
      },
      pen: {
        setColor: (hex: string) => { pen = hex; return true; },
        setOpacity: (opacity: number) => { penOpacity = opacity; return true; },
        setGradient: (gradient: unknown) => { penGradient = gradient; return true; },
      },
      ui: { toast: (msg: string) => { toast = msg; } },
    };
    return { api: api as unknown as PluginContext, calls, pen: () => pen, penOpacity: () => penOpacity, penGradient: () => penGradient, toast: () => toast };
  }
  it("sets the pen when nothing colourable is selected", () => {
    const f = makeApi([3], [textItem(3)]);
    applyColour(f.api, "#FF0000");
    expect(f.pen()).toBe("#FF0000");
    expect(f.calls).toEqual([]);
    expect(f.toast()).toBeNull();
  });
  it("sets the pen colour and opacity when nothing colourable is selected", () => {
    const f = makeApi([3], [textItem(3)]);
    applyColour(f.api, "#FF0000", 50);
    expect(f.pen()).toBe("#FF0000");
    expect(f.penOpacity()).toBe(50);
    expect(f.calls).toEqual([]);
  });
  it("leaves the pen opacity alone when no opacity is passed", () => {
    const f = makeApi([3], [textItem(3)]);
    applyColour(f.api, "#FF0000");
    expect(f.penOpacity()).toBeNull();
  });
  it("recolours selected strokes and swatches in one call", () => {
    const f = makeApi([1, 2, 3], [strokeItem(1), swatchItem(2), textItem(3)]);
    applyColour(f.api, "#00FF00");
    expect(f.pen()).toBeNull();
    expect(f.calls).toEqual([[{ id: 1, data: { color: "#00FF00" } }, { id: 2, data: { hex: "#00FF00" } }]]);
    expect(f.toast()).toBeNull();
  });
  it("recolours a selected stroke with colour and opacity, and a swatch with the colour only", () => {
    const f = makeApi([1, 2, 3], [strokeItem(1), swatchItem(2), textItem(3)]);
    applyColour(f.api, "#00FF00", 50);
    expect(f.pen()).toBeNull();
    expect(f.penOpacity()).toBeNull();
    expect(f.calls).toEqual([[{ id: 1, data: { color: "#00FF00", opacity: 50 } }, { id: 2, data: { hex: "#00FF00" } }]]);
    expect(f.toast()).toBeNull();
  });
  it("toasts when the recolour is refused", () => {
    const f = makeApi([1], [strokeItem(1)], false);
    applyColour(f.api, "#00FF00");
    expect(f.toast()).toBe("Layer is locked");
    expect(f.pen()).toBeNull();
  });
  it("sets the pen gradient when nothing colourable is selected", () => {
    const f = makeApi([3], [textItem(3)]);
    const gradient = { angle: 90, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#0000FF" }] };
    applyColour(f.api, "#FF0000", 50, gradient);
    expect(f.pen()).toBe("#FF0000");
    expect(f.penOpacity()).toBe(50);
    expect(f.penGradient()).toEqual(gradient);
    expect(f.calls).toEqual([]);
  });
  it("leaves the pen gradient alone when no gradient is passed", () => {
    const f = makeApi([3], [textItem(3)]);
    applyColour(f.api, "#FF0000", 50);
    expect(f.penGradient()).toBeUndefined();
  });
  it("sends the gradient with a selected stroke, colour from its first stop, and the colour only to a swatch", () => {
    const f = makeApi([1, 2, 3], [strokeItem(1), swatchItem(2), textItem(3)]);
    const gradient = { angle: 90, stops: [{ offset: 0, color: "#FF0000" }, { offset: 100, color: "#0000FF" }] };
    applyColour(f.api, "#00FF00", 50, gradient);
    expect(f.pen()).toBeNull();
    expect(f.calls).toEqual([[{ id: 1, data: { color: "#FF0000", opacity: 50, gradient } }, { id: 2, data: { hex: "#FF0000" } }]]);
  });
  it("clears a selected stroke's gradient with a null gradient", () => {
    const f = makeApi([1], [strokeItem(1)]);
    applyColour(f.api, "#00FF00", 50, null);
    expect(f.calls).toEqual([[{ id: 1, data: { color: "#00FF00", opacity: 50, gradient: null } }]]);
  });
});
