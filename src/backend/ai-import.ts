// Illustrator import: a modern .ai file saved with PDF
// compatibility IS a PDF — the artwork lives in an embedded
// PDF stream — so it lands as a PdfCard and renders with
// the app's existing PDF card. An .ai file saved without
// PDF compatibility is PostScript, which the app cannot
// read: that is reported as unsupported, never silently
// dropped (see drops.ts). No vector-shape extraction is
// attempted: the PdfCard already shows the full vector
// artwork, which is the usable form.
export function isPdfCompatible(bytes: Uint8Array): boolean {
  // A PDF header is "%PDF-" followed by the version.
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}
