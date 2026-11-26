// Color Management — hex colours and the HSL maths the
// wheel and sliders need. The plugin uses the public API
// only, so the helpers it needs live here.
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

// One hue sector: which channels carry c and x.
function hueSector(h: number, c: number, x: number): [number, number, number] {
  if (h < 60) return [c, x, 0];
  if (h < 120) return [x, c, 0];
  if (h < 180) return [0, c, x];
  if (h < 240) return [0, x, c];
  if (h < 300) return [x, 0, c];
  return [c, 0, x];
}

const toHexByte = (v: number): string => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0").toUpperCase();

// HSL as 0–1 RGB, for the wheel as well as hex.
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = wrapHue(h);
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 5, 95) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hueSector(h, c, x);
  return { r: r + m, g: g + m, b: b + m };
}

// Lightness clamps to 5–95%: never pure black or white.
export function hslToHex(h: number, s: number, l: number): string {
  const { r, g, b } = hslToRgb(h, s, l);
  return `#${toHexByte(r * 255)}${toHexByte(g * 255)}${toHexByte(b * 255)}`;
}

// The default second stop: the picked colour 30 below,
// capped at 18 and floored at 5 — a deep shade, never
// a wash-out to white. A black pick stays flat.
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

// A gradient as pixels, dithered with random noise —
// Skia's ordered dither reads as vertical stripes.
// Seeded from the stops, so repaints show the same
// grain instead of shimmering.
export interface GradientStop {
  offset: number;
  color: string;
}

export function gradientPixels(
  stops: GradientStop[],
  width: number,
  height: number,
  opacity: number,
): Uint8ClampedArray<ArrayBuffer> {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (w === 0 || h === 0 || stops.length === 0) return new Uint8ClampedArray(new ArrayBuffer(0));
  // Explicit ArrayBuffer, so ImageData takes it without a cast.
  const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  const sorted = [...stops]
    .map((s) => ({ offset: s.offset, ...hexToRgb(s.color) }))
    .sort((a, b) => a.offset - b.offset);
  const alpha = Math.round((clamp(opacity, 0, 100) / 100) * 255);
  // Seeded PRNG (mulberry32): stable grain per gradient.
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

// Hex as 0–255 channel ints, shared by the hex readers.
function hexChannels(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

// RGB as 0–255 integers. No clamp here — the 5–95%
// lightness clamp lives in hslToHex only.
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return hexChannels(hex);
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

// HSV, h 0–360 and s/v 0–100: the third picker mode.
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const { r: r0, g: g0, b: b0 } = hexChannels(hex);
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
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
  const [r, g, b] = hueSector(h, c, x);
  return `#${toHexByte((r + m) * 255)}${toHexByte((g + m) * 255)}${toHexByte((b + m) * 255)}`;
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {  const { r: r0, g: g0, b: b0 } = hexChannels(hex);
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
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

// Colour harmonies: five types, five colours each, from
// a picked colour. Saturation never changes inside a
// harmony; only hue and lightness do. Lightness clamps
// to 5–95%, so no swatch is pure black or white.
//   Monochromatic — same hue, lightness -24/-12/0/
//     +12/+24, shifted to fit 5–95%.
//   Analogous — hues -30/-15/0/+15/+30.
//   Complementary — base, opposite, base light,
//     opposite light, base dark.
//   Split complementary — base, +150, +210, base
//     light, +150 light.
//   Triadic — base, +120, +240, base light, +120 light.
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

// Near-duplicates read as the same colour on a tile:
// redmean-weighted RGB distance under 15.
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
