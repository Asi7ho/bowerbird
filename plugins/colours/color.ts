// Colour Library — hex colours, plus the HSL maths the
// wheel and sliders need. The plugin cannot import the
// core's colour helpers (public API only), so the ones it
// needs live here: normalise "#f00" and "#FF0000" to the
// same "#FF0000", and convert between hex and HSL. The
// HSL maths matches the old Palette plugin's (same
// conversion, same 5–95% lightness clamp), so a colour
// picked here is the same colour there.
export function normaliseHex(hex: string): string | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return "#" + h.toUpperCase();
}

export function isHex(hex: string): boolean {
  return normaliseHex(hex) !== null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const wrapHue = (h: number): number => ((h % 360) + 360) % 360;

// Lightness is clamped to 5–95%, so a picked colour is
// never pure black or pure white — the same clamp the
// old Palette plugin applies to its harmony palettes.
export function hslToHex(h: number, s: number, l: number): string {
  h = wrapHue(h);
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 5, 95) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// The default second stop for a new gradient: a deep
// shade of the picked colour — same hue and saturation,
// lightness 30 below the pick but never above 18, so a
// light pick still fades to a deep shade, and never
// below 5, the darkest hslToHex renders. A black pick
// has no darker shade, so its gradient is flat by nature.
export function deepShadeHex(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, Math.max(5, Math.min(18, l - 30)));
}

// The same hue and saturation at lightness 50%: the
// readable version of a picked colour, for the preview
// while the wheel is being dragged — a dark pick barely
// reads in the swatch, so the drag shows this instead.
export function brightHex(hex: string): string {
  const { h, s } = hexToHsl(hex);
  return hslToHex(h, s, 50);
}

// A gradient as pixels, with random-noise dithering.
// The CSS linear-gradient the swatch and strip used to
// paint reads as vertical stripes: Skia's ordered
// dither has a regular pattern the eye groups into
// bands, worst in the dark half of a gradient. Random
// noise has no regular structure, so the same ramp
// reads smooth at any size. Pure data, no DOM: the
// panel paints the pixels onto a canvas. The noise is
// seeded from the stops, so the same gradient paints
// the same grain on every repaint instead of shimmering
// while the wheel is dragged.
export interface GradientStop {
  offset: number;
  color: string;
}

export function gradientPixels(
  stops: GradientStop[],
  width: number,
  height: number,
  opacity: number,
): Uint8ClampedArray {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (w === 0 || h === 0 || stops.length === 0) return new Uint8ClampedArray(0);
  const out = new Uint8ClampedArray(w * h * 4);
  const sorted = [...stops]
    .map((s) => ({ offset: s.offset, ...hexToRgb(s.color) }))
    .sort((a, b) => a.offset - b.offset);
  const alpha = Math.round((clamp(opacity, 0, 100) / 100) * 255);
  // A small seeded PRNG (mulberry32): the grain is
  // stable for a given gradient, and differs between
  // gradients so two identical ramps don't share a
  // visible pattern.
  let seed = 0;
  const key = JSON.stringify([sorted, opacity]);
  for (let i = 0; i < key.length; i++) seed = (Math.imul(seed, 31) + key.charCodeAt(i)) | 0;
  const rand = (): number => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const at = (offset: number): { r: number; g: number; b: number } => {
    if (offset <= sorted[0].offset) return sorted[0];
    const last = sorted[sorted.length - 1];
    if (offset >= last.offset) return last;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (offset >= a.offset && offset <= b.offset) {
        const t = b.offset === a.offset ? 0 : (offset - a.offset) / (b.offset - a.offset);
        return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
      }
    }
    return last;
  };
  for (let x = 0; x < w; x++) {
    const offset = w === 1 ? 0 : (x / (w - 1)) * 100;
    const c = at(offset);
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      out[i] = Math.round(c.r + (rand() - 0.5));
      out[i + 1] = Math.round(c.g + (rand() - 0.5));
      out[i + 2] = Math.round(c.b + (rand() - 0.5));
      out[i + 3] = alpha;
    }
  }
  return out;
}

// RGB, as 0–255 integers: the mode the picker offers
// alongside HSL. Pure maths, no clamp — the 5–95%
// lightness clamp lives in hslToHex only.
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number): string => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// HSV, as h 0–360 and s/v 0–100: the third picker mode.
// The wheel draws in HSL, so HSV is a view of the same
// colour, converted through hex like RGB.
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const v = max * 100;
  const s = max === 0 ? 0 : (d / max) * 100;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, v };
}

export function hsvToHex(h: number, s: number, v: number): string {
  h = wrapHue(h);
  s = clamp(s, 0, 100) / 100;
  v = clamp(v, 0, 100) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (val: number): string => Math.round((val + m) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2 * 100;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = (l > 50 ? d / (2 - max - min) : d / (max + min)) * 100;
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

// Colour harmonies, copied from the old Palette plugin's
// palettesFor: same five types, same maths — plugins are
// self-contained, so the logic is duplicated here, not
// imported. Each harmony is five colours from a picked
// colour, in order:
//   Monochromatic — same hue, lightness steps, dark to
//     light. Steps are -24, -12, 0, +12, +24 lightness,
//     shifted as a whole to fit 5–95% so no two steps
//     collapse to the same colour at the extremes.
//   Analogous — hues -30, -15, 0, +15, +30, same
//     saturation and lightness: colours next to each
//     other on the wheel.
//   Complementary — opposite colours, then tints and
//     a shade to fill five: base, opposite, base light,
//     opposite light, base dark.
//   Split complementary — base, opposite +30, opposite
//     -30 (that is, +150 and +210), then tints of the
//     first two: base light, +150 light.
//   Triadic — base, +120, +240, then tints of the first
//     two: base light, +120 light.
// Saturation never changes inside a harmony; only hue
// (by harmony) and lightness (by tint, shade, or the
// monochromatic steps) do, so a harmony stays harmonious
// instead of drifting muddy. Lightness is clamped to
// 5–95% so a swatch is never pure black or pure white.
export const HARMONY_NAMES = ["Monochromatic", "Analogous", "Complementary", "Split complementary", "Triadic"] as const;
export type HarmonyName = (typeof HARMONY_NAMES)[number];

export interface Harmony {
  name: HarmonyName;
  colors: string[];
}

export function harmoniesFor(h: number, s: number, l: number): Harmony[] {
  const col = (dh: number, dl: number): string => hslToHex(h + dh, s, l + dl);
  // Monochromatic: lightness steps, shifted to fit 5–95.
  const steps = [-24, -12, 0, 12, 24].map((dl) => l + dl);
  const lo = Math.min(...steps), hi = Math.max(...steps);
  const shift = lo < 5 ? 5 - lo : hi > 95 ? 95 - hi : 0;
  const mono = steps.map((v) => hslToHex(h, s, v + shift));
  return [
    { name: "Monochromatic", colors: mono },
    { name: "Analogous", colors: [-30, -15, 0, 15, 30].map((dh) => col(dh, 0)) },
    { name: "Complementary", colors: [col(0, 0), col(180, 0), col(0, 15), col(180, 15), col(0, -15)] },
    { name: "Split complementary", colors: [col(0, 0), col(150, 0), col(210, 0), col(0, 15), col(150, 15)] },
    { name: "Triadic", colors: [col(0, 0), col(120, 0), col(240, 0), col(0, 15), col(120, 15)] },
  ];
}

// Two colours are near-duplicates when they read as the
// same colour on a tile: a redmean-weighted RGB distance
// under 15 — about one just-noticeable step at tile size.
// #007BFF and #007AFF score 2; a visibly different blue
// like #0A5CFF scores 67.
export function colourDistance(a: string, b: string): number {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const rMean = (ca.r + cb.r) / 2;
  const dr = ca.r - cb.r;
  const dg = ca.g - cb.g;
  const db = ca.b - cb.b;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

export function isNearDuplicate(a: string, b: string): boolean {
  return colourDistance(a, b) < 15;
}
