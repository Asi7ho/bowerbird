// Unit tests for the Colour Library palette store
// (plugins/colours/store.ts) and its hex helper
// (plugins/colours/color.ts): pure data, no DOM, no API.
import { describe, expect, it } from "vitest";
import type { PluginContext } from "bowerbird-plugin-api";
import { applyColour } from "../../plugins/colours/apply";
import { hexToHsl, hslToHex, isHex, normaliseHex } from "../../plugins/colours/color";
import {
  addColour,
  createPalette,
  deletePalette,
  emptyStore,
  movePalette,
  nextPaletteName,
  parseStored,
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
    let toast: string | null = null;
    const api = {
      board: {
        getSelected: () => selected,
        getItems: () => items,
        updateItems: (patches: unknown) => { calls.push(patches); return updateResult; },
      },
      pen: { setColor: (hex: string) => { pen = hex; return true; } },
      ui: { toast: (msg: string) => { toast = msg; } },
    };
    return { api: api as unknown as PluginContext, calls, pen: () => pen, toast: () => toast };
  }
  it("sets the pen when nothing colourable is selected", () => {
    const f = makeApi([3], [textItem(3)]);
    applyColour(f.api, "#FF0000");
    expect(f.pen()).toBe("#FF0000");
    expect(f.calls).toEqual([]);
    expect(f.toast()).toBeNull();
  });
  it("recolours selected strokes and swatches in one call", () => {
    const f = makeApi([1, 2, 3], [strokeItem(1), swatchItem(2), textItem(3)]);
    applyColour(f.api, "#00FF00");
    expect(f.pen()).toBeNull();
    expect(f.calls).toEqual([[{ id: 1, data: { color: "#00FF00" } }, { id: 2, data: { hex: "#00FF00" } }]]);
    expect(f.toast()).toBeNull();
  });
  it("toasts when the recolour is refused", () => {
    const f = makeApi([1], [strokeItem(1)], false);
    applyColour(f.api, "#00FF00");
    expect(f.toast()).toBe("Layer is locked");
    expect(f.pen()).toBeNull();
  });
});
