// Colour Library — hex colours. The plugin cannot import
// the core's colour helpers (public API only), so the one
// it needs lives here: normalise "#f00" and "#FF0000" to
// the same "#FF0000", and reject anything that is not a hex.
export function normaliseHex(hex: string): string | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return "#" + h.toUpperCase();
}

export function isHex(hex: string): boolean {
  return normaliseHex(hex) !== null;
}
