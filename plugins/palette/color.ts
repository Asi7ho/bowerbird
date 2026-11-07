// Palette — colour maths. Pure functions, no API and no DOM:
// HSL/hex conversion and the five palettes made from a picked
// colour, following colour theory.
//
// Palettes, each five colours, in order:
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
// Saturation never changes inside a palette; only hue
// (by harmony) and lightness (by tint, shade, or the
// monochromatic steps) do, so a palette stays harmonious
// instead of drifting muddy. Lightness is clamped to
// 5–95% so a swatch is never pure black or pure white.
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const wrapHue = (h: number): number => ((h % 360) + 360) % 360;

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

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
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

export interface PaletteDef {
  name: string;
  colors: string[];
}

export function palettesFor(h: number, s: number, l: number): PaletteDef[] {
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
