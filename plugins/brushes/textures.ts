// Brush textures: one filter construction per built-in.
// Not one filter with different numbers: each texture is
// built from different primitives, so it reads differently
// at swatch size and on a drawn stroke. The host wraps
// the built SVG in <filter id="texture-<id>"> in the
// board SVG defs. Custom textures stay parametric
// feTurbulence, built by textureFilterSvg below.
export type TextureFamily = "pencil" | "pen" | "highlighter";

export interface TextureParams {
  baseFrequency: number;
  octaves: number;
  scale: number;
  seed: number;
}

export interface BuiltinTexture {
  id: string;
  label: string;
  family: TextureFamily;
  filterSvg: string;
}

// The grain fragment: turbulence, then its alpha shaped
// into a mask the stroke is clipped to. A steeper slope
// drops more ink out, so the stroke breaks up further.
function grainMask(freq: number, octaves: number, seed: number, slope: number, intercept: number): string {
  return `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" seed="${seed}" result="noise" />`
    + `<feComponentTransfer in="noise" result="grain"><feFuncA type="linear" slope="${slope}" intercept="${intercept}" /></feComponentTransfer>`;
}

// The built-ins, one per pen family. Pencil is dry media
// (grain and wobble); pen is ink (clean or dotted);
// highlighter is a wash (soft edge, no breakup).
export const BUILTIN_TEXTURES: BuiltinTexture[] = [
  {
    id: "graphite", label: "Graphite", family: "pencil",
    // Fine grain, slight wobble: a pencil line. The
    // grain cuts hard (steep slope, same midpoint), so
    // the speckle is dark dots on white, not a pale
    // grey wash — a gentle slope left every pixel
    // half-inked and the line read as blurry.
    filterSvg:
      grainMask(0.9, 2, 7, 8, -3.5)
      + `<feDisplacementMap in="SourceGraphic" in2="noise" scale="2.5" result="wobbly" />`
      + `<feComposite in="wobbly" in2="grain" operator="in" />`,
  },
  {
    id: "chalk", label: "Chalk", family: "pencil",
    // Dry, dusty, pale: big irregular chunks with gaps,
    // and the alpha capped so even the darkest chunk
    // stays light grey — chalk on a board, not charcoal.
    // The cut is hard, so the stroke breaks into patches.
    filterSvg:
      grainMask(0.22, 3, 11, 4, -1.8)
      + `<feDisplacementMap in="SourceGraphic" in2="noise" scale="7" result="chunky" />`
      + `<feComposite in="chunky" in2="grain" operator="in" result="broken" />`
      + `<feComponentTransfer in="broken"><feFuncA type="linear" slope="0.7" intercept="0" /></feComponentTransfer>`,
  },
  {
    id: "grain", label: "Grain", family: "pen",
    // Fine even stipple, straight edge, darker than
    // Graphite: ink on rough paper, not a pencil line.
    // The speckle is finer than Graphite's and the grain
    // keeps most of the ink, so it reads dark and even.
    filterSvg:
      grainMask(1.2, 2, 3, 1.3, 0.05)
      + `<feComposite in="SourceGraphic" in2="grain" operator="in" />`,
  },
  {
    id: "marker", label: "Marker", family: "highlighter",
    // Flat and even: no blur, no breakup — a wash whose
    // fill stays uniform edge to edge. The wash opacity
    // comes from the highlighter family, so the flat fill
    // reads lighter than Ink, not smeared.
    filterSvg: `<feComponentTransfer in="SourceGraphic"><feFuncA type="linear" slope="1" intercept="0" /></feComponentTransfer>`,
  },
  {
    id: "charcoal", label: "Charcoal", family: "pencil",
    // Smudged and dark: heavily displaced, then the
    // alpha is pushed back up — without the push the
    // smudge read as a pale ghost. No blur: the blur
    // spread the edge over several pixels and the
    // stroke read as out of focus. The grain cuts
    // hard, so the smudge keeps dark cores.
    filterSvg:
      grainMask(0.3, 4, 21, 5, -2)
      + `<feDisplacementMap in="SourceGraphic" in2="noise" scale="9" result="smudged" />`
      + `<feComponentTransfer in="smudged" result="dark"><feFuncA type="linear" slope="2" intercept="-0.2" /></feComponentTransfer>`
      + `<feComposite in="dark" in2="grain" operator="in" />`,
  },
  {
    id: "crayon", label: "Crayon", family: "pencil",
    // Waxy and dark, with a rough edge: wobbled and
    // cut by a hard grain — the grain keeps most of
    // the ink, so it stays dark, and only the edge
    // and a few gaps break up. No blur: it softened
    // the edge without adding anything. The first try
    // cut too hard and it read as pale pencil.
    filterSvg:
      `<feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="3" seed="13" result="noise" />`
      + `<feDisplacementMap in="SourceGraphic" in2="noise" scale="5" result="waxy" />`
      + `<feComponentTransfer in="noise" result="grain"><feFuncA type="linear" slope="5" intercept="-0.9" /></feComponentTransfer>`
      + `<feComposite in="waxy" in2="grain" operator="in" />`,
  },
  {
    id: "watercolour", label: "Watercolour", family: "highlighter",
    // A wash with pigment pools, not a blur blob: slow
    // displacement for a wobbly edge, and the same low
    // turbulence shaped into an alpha mask, so the wash
    // holds darker and lighter pools. The mask spans
    // most of the alpha range, so the pools read; a
    // narrow mask left the wash one flat pale grey.
    // The displacement is small, so the edge stays
    // defined — a big wobble on a thin wash left no
    // edge at all. No blur anywhere.
    filterSvg:
      grainMask(0.08, 3, 17, 0.8, 0.2)
      + `<feDisplacementMap in="SourceGraphic" in2="noise" scale="3" result="blotchy" />`
      + `<feComposite in="blotchy" in2="grain" operator="in" />`,
  },
  {
    id: "spray", label: "Spray", family: "pen",
    // A spray can, not a line with dust: the dots are
    // big enough to see (coarse grain) and dense enough
    // to read as a scatter reaching well beyond the line.
    // Dots only — no solid core under the scatter: a core
    // read as a straight line with dust on it. The halo
    // band is a blur pushed back up by a transfer, not a
    // dilate: feMorphology left a faint wash over the
    // whole filter region in the app. The dots are cut
    // hard from the band — no second blur after the cut,
    // or each dot's edge goes soft and the scatter reads
    // as a blurry smear. The band itself fades at its
    // edge the way a real spray does, so the dots thin
    // out toward the edge instead of stopping dead.
    filterSvg:
      grainMask(0.3, 2, 9, 8, -4.5)
      + `<feGaussianBlur in="SourceGraphic" stdDeviation="8" result="wide" />`
      + `<feComponentTransfer in="wide" result="fat"><feFuncA type="linear" slope="8" intercept="-0.2" /></feComponentTransfer>`
      + `<feComposite in="fat" in2="grain" operator="in" result="dots" />`,
  },
];

// The family a texture id belongs to, or null for no
// texture and for a custom id (customs show everywhere).
export function familyForTextureId(id: string | null): TextureFamily | null {
  if (!id) return null;
  return BUILTIN_TEXTURES.find((t) => t.id === id)?.family ?? null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// The filter SVG for a texture's parameters: turbulence
// displaces the ink, so the stroke edge breaks up like a
// dry medium. Numbers are clamped to the ranges the form
// offers, so a stored value cannot build a filter the
// renderer chokes on.
export function textureFilterSvg(params: TextureParams): string {
  const freq = clamp(params.baseFrequency, 0.05, 1);
  const octaves = Math.round(clamp(params.octaves, 1, 5));
  const scale = clamp(params.scale, 0, 10);
  const seed = Math.round(clamp(params.seed, 0, 100));
  return `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" seed="${seed}" result="noise" /><feDisplacementMap in="SourceGraphic" in2="noise" scale="${scale}" />`;
}
