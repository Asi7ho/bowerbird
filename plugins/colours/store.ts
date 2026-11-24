// Colour Library — the palette store. Pure data, no DOM and
// no API, so it is unit-tested on its own. A palette is a
// name and a list of hex colours; the store is the list of
// palettes. Every function returns a new store and leaves
// its input alone.
import { isNearDuplicate, normaliseHex } from "./color.js";

export interface Palette {
  name: string;
  colors: string[];
}

export interface ColourStore {
  palettes: Palette[];
}

export function emptyStore(): ColourStore {
  return { palettes: [] };
}

// The shape read back from plugin storage: the palettes
// array itself. Anything else is a fresh store, never a
// crash. Colours are normalised on the way in, so old
// mixed-case hexes come out uniform.
export function parseStored(value: unknown): ColourStore | null {
  if (!Array.isArray(value)) return null;
  const palettes: Palette[] = [];
  for (const p of value) {
    if (!p || typeof p !== "object") return null;
    const name = (p as { name?: unknown }).name;
    const colors = (p as { colors?: unknown }).colors;
    if (typeof name !== "string" || name.trim() === "" || !Array.isArray(colors)) return null;
    const hexes: string[] = [];
    for (const c of colors) {
      if (typeof c !== "string") return null;
      const hex = normaliseHex(c);
      if (!hex) return null;
      hexes.push(hex);
    }
    palettes.push({ name: name.trim(), colors: hexes });
  }
  return { palettes };
}

export function nextPaletteName(store: ColourStore): string {
  const used = new Set(store.palettes.map((p) => p.name));
  let n = 1;
  while (used.has(`Palette ${n}`)) n++;
  return `Palette ${n}`;
}

export function createPalette(store: ColourStore, seed: string[] = []): { store: ColourStore; index: number } {
  const colors: string[] = [];
  for (const c of seed) {
    const hex = normaliseHex(c);
    if (hex && !colors.includes(hex)) colors.push(hex);
  }
  const palettes = [...store.palettes, { name: nextPaletteName(store), colors }];
  return { store: { palettes }, index: palettes.length - 1 };
}

export function renamePalette(store: ColourStore, index: number, name: string): ColourStore {
  const trimmed = name.trim();
  if (trimmed === "" || index < 0 || index >= store.palettes.length) return store;
  const palettes = store.palettes.map((p, i) => (i === index ? { ...p, name: trimmed } : p));
  return { palettes };
}

export function deletePalette(store: ColourStore, index: number): ColourStore {
  if (index < 0 || index >= store.palettes.length) return store;
  return { palettes: store.palettes.filter((_, i) => i !== index) };
}

export function movePalette(store: ColourStore, index: number, dir: -1 | 1): ColourStore {
  const to = index + dir;
  if (index < 0 || index >= store.palettes.length || to < 0 || to >= store.palettes.length) return store;
  const palettes = [...store.palettes];
  const [p] = palettes.splice(index, 1);
  palettes.splice(to, 0, p);
  return { palettes };
}

export function addColour(store: ColourStore, index: number, hex: string): ColourStore {
  const colour = normaliseHex(hex);
  if (!colour || index < 0 || index >= store.palettes.length) return store;
  if (store.palettes[index].colors.includes(colour)) return store;
  const palettes = store.palettes.map((p, i) =>
    i === index ? { ...p, colors: [...p.colors, colour] } : p,
  );
  return { palettes };
}

export function removeColour(store: ColourStore, paletteIndex: number, colourIndex: number): ColourStore {
  if (paletteIndex < 0 || paletteIndex >= store.palettes.length) return store;
  const palette = store.palettes[paletteIndex];
  if (colourIndex < 0 || colourIndex >= palette.colors.length) return store;
  const palettes = store.palettes.map((p, i) =>
    i === paletteIndex ? { ...p, colors: p.colors.filter((_, j) => j !== colourIndex) } : p,
  );
  return { palettes };
}

// Recent colours: the last colours applied or settled on,
// most recent first, at most ten, no duplicates. They live
// under their own storage key ("recent"), so the palettes
// shape above never changes — changing it would wipe
// stored palettes. Pure data, like the store: the panel
// owns the list, these functions only shape it.
export const MAX_RECENT = 10;

// The shape read back from plugin storage: the recent
// list itself. Anything else is an empty list, never a
// crash. Colours are normalised and near-duplicates
// collapsed on the way in, so a list stored before the
// near-duplicate rule still reads as distinct colours.
export function parseRecent(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const recent: string[] = [];
  for (const c of value) {
    if (typeof c !== "string") return null;
    const hex = normaliseHex(c);
    if (!hex) return null;
    if (!recent.some((kept) => isNearDuplicate(kept, hex))) recent.push(hex);
  }
  return recent.slice(0, MAX_RECENT);
}

// Record a colour as the most recent: to the front, any
// older copy — exact or near-duplicate — removed, capped
// at ten. A bad hex leaves the list alone, and the input
// is never mutated.
export function recordRecent(recent: string[], hex: string): string[] {
  const colour = normaliseHex(hex);
  if (!colour) return recent;
  return [colour, ...recent.filter((c) => !isNearDuplicate(c, colour))].slice(0, MAX_RECENT);
}
