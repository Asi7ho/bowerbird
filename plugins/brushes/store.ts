// Brush Library — the preset and texture store: pure
// data, no DOM, no API. Presets and user textures live
// in plugin storage under "brushes".
import { copyCurve, curveFromExponent, parseCurvePoints, LINEAR_CURVE, type CurvePoint } from "./curve.js";
import { familyForTextureId, type TextureFamily } from "./textures.js";

export interface BrushPreset {
  id: string;
  name: string;
  texture: string | null;
  curve: CurvePoint[];
  // The pen family the brush belongs to: the texture
  // list follows the active tool, so a brush shows
  // under the tool it draws like. A highlighter-family
  // brush draws translucent (marker) — marker is the
  // family, not a separate flag.
  family: TextureFamily;
}

export interface TextureDef {
  id: string;
  name: string;
  baseFrequency: number;
  octaves: number;
  scale: number;
  seed: number;
}

export interface BrushStore {
  presets: BrushPreset[];
  textures: TextureDef[];
}

export function emptyStore(): BrushStore {
  return { presets: [], textures: [] };
}

// The seeded presets: one per built-in texture, plus
// a plain ink pen — the library feels full on first run.
// The wash brushes (Marker, Watercolour) draw translucent.
export function seededStore(): BrushStore {
  return {
    presets: [
      { id: "preset-1", name: "Ink", texture: null, curve: copyCurve(LINEAR_CURVE), family: "pen" },
      { id: "preset-2", name: "Graphite", texture: "graphite", curve: copyCurve(LINEAR_CURVE), family: "pencil" },
      { id: "preset-3", name: "Chalk", texture: "chalk", curve: copyCurve(LINEAR_CURVE), family: "pencil" },
      { id: "preset-4", name: "Marker", texture: "marker", curve: copyCurve(LINEAR_CURVE), family: "highlighter" },
      { id: "preset-5", name: "Charcoal", texture: "charcoal", curve: copyCurve(LINEAR_CURVE), family: "pencil" },
      { id: "preset-6", name: "Crayon", texture: "crayon", curve: copyCurve(LINEAR_CURVE), family: "pencil" },
      { id: "preset-7", name: "Watercolour", texture: "watercolour", curve: copyCurve(LINEAR_CURVE), family: "highlighter" },
      { id: "preset-8", name: "Spray", texture: "spray", curve: copyCurve(LINEAR_CURVE), family: "pen" },
    ],
    textures: [],
  };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function isNumberIn(value: unknown, lo: number, hi: number): value is number {
  return typeof value === "number" && isFinite(value) && value >= lo && value <= hi;
}

function parsePreset(value: unknown): BrushPreset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isId(v.id) || typeof v.name !== "string" || !v.name.trim()) return null;
  if (!(v.texture === null || isId(v.texture))) return null;
  // A stored curve is points; a number is the old single
  // exponent, migrated to its equivalent points.
  const curve = typeof v.curve === "number" ? curveFromExponent(v.curve) : parseCurvePoints(v.curve);
  if (!curve) return null;
  // A stored family is kept; an old preset without one
  // takes its texture's family, or pen for plain ink.
  // A stored marker flag is ignored: marker is the
  // highlighter family now, not a stored field.
  const texture = v.texture as string | null;
  const family = isFamily(v.family) ? v.family
    : familyForTextureId(texture) ?? "pen";
  return {
    id: v.id,
    name: v.name.trim(),
    texture,
    curve,
    family,
  };
}

function isFamily(value: unknown): value is TextureFamily {
  return value === "pencil" || value === "pen" || value === "highlighter";
}

function parseTexture(value: unknown): TextureDef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isId(v.id) || typeof v.name !== "string" || !v.name.trim()) return null;
  if (!isNumberIn(v.baseFrequency, 0.05, 1) || !isNumberIn(v.scale, 0, 10)) return null;
  if (!isNumberIn(v.octaves, 1, 5) || !Number.isInteger(v.octaves)) return null;
  if (!isNumberIn(v.seed, 0, 100) || !Number.isInteger(v.seed)) return null;
  return {
    id: v.id,
    name: v.name.trim(),
    baseFrequency: v.baseFrequency as number,
    octaves: v.octaves as number,
    scale: v.scale as number,
    seed: v.seed as number,
  };
}

// Stored values come from disk, so a bad shape is a null,
// never a half-loaded store: the caller seeds fresh.
export function parseStored(value: unknown): BrushStore | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.presets) || !Array.isArray(v.textures)) return null;
  const presets: BrushPreset[] = [];
  for (const p of v.presets) {
    const parsed = parsePreset(p);
    if (!parsed) return null;
    presets.push(parsed);
  }
  const textures: TextureDef[] = [];
  for (const t of v.textures) {
    const parsed = parseTexture(t);
    if (!parsed) return null;
    textures.push(parsed);
  }
  return { presets, textures };
}

function nextId(prefix: string, taken: string[]): string {
  let n = 1;
  for (const id of taken) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
  }
  return `${prefix}-${n}`;
}

export function nextPresetName(store: BrushStore): string {
  let n = 1;
  const names = new Set(store.presets.map((p) => p.name));
  while (names.has(`Brush ${n}`)) n++;
  return `Brush ${n}`;
}

export function createPreset(store: BrushStore, base?: Partial<BrushPreset>): { store: BrushStore; index: number } {
  const id = nextId("preset", store.presets.map((p) => p.id));
  const preset: BrushPreset = {
    id,
    // An explicit name wins; a blank one auto-names, as before.
    name: base?.name?.trim() ? base.name.trim() : nextPresetName(store),
    texture: base?.texture ?? null,
    curve: base?.curve ? copyCurve(base.curve) : copyCurve(LINEAR_CURVE),
    // The base's family, else the base texture's family:
    // a copy of a pencil brush stays a pencil brush.
    family: base?.family ?? familyForTextureId(base?.texture ?? null) ?? "pen",
  };
  return { store: { ...store, presets: [...store.presets, preset] }, index: store.presets.length };
}

export function createTexture(store: BrushStore, def: Omit<TextureDef, "id">): { store: BrushStore; index: number } {
  const id = nextId("tex", store.textures.map((t) => t.id));
  const texture: TextureDef = { id, ...def };
  return { store: { ...store, textures: [...store.textures, texture] }, index: store.textures.length };
}

export function renamePreset(store: BrushStore, index: number, name: string): BrushStore {
  const trimmed = name.trim();
  if (!trimmed || index < 0 || index >= store.presets.length) return store;
  const presets = store.presets.slice();
  presets[index] = { ...presets[index], name: trimmed };
  return { ...store, presets };
}

export function deletePreset(store: BrushStore, index: number): BrushStore {
  if (index < 0 || index >= store.presets.length) return store;
  return { ...store, presets: store.presets.filter((_, i) => i !== index) };
}

// One field of a preset, validated: a bad value leaves
// the store alone instead of storing a broken preset.
export function updatePreset(store: BrushStore, index: number, patch: Partial<BrushPreset>): BrushStore {
  if (index < 0 || index >= store.presets.length) return store;
  const current = store.presets[index];
  const next = { ...current };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return store;
    next.name = name;
  }
  if (patch.texture !== undefined) {
    if (!(patch.texture === null || isId(patch.texture))) return store;
    next.texture = patch.texture;
  }
  if (patch.curve !== undefined) {
    const points = parseCurvePoints(patch.curve);
    if (!points) return store;
    next.curve = points;
  }
  const presets = store.presets.slice();
  presets[index] = next;
  return { ...store, presets };
}

// The stored sizes follow a width set elsewhere — the
// toolbar's size control: each family's active preset
// takes its kind's width when it differs, so the panel
// and the toolbar never disagree. A family with no width
// or no active preset is untouched. Returns the same
// store when nothing changed.
export function syncPresetSizes(
  store: BrushStore,
  activeIds: Partial<Record<TextureFamily, string>>,
  widths: Partial<Record<TextureFamily, number>>,
): BrushStore {
  let next = store;
  for (const family of Object.keys(widths) as TextureFamily[]) {
    const width = widths[family];
    const id = activeIds[family];
    if (typeof width !== "number" || !id) continue;
    const index = next.presets.findIndex((p) => p.id === id && p.family === family);
    if (index < 0 || next.presets[index].size === clampSize(width)) continue;
    next = updatePreset(next, index, { size: clampSize(width) });
  }
  return next;
}
