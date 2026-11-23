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
