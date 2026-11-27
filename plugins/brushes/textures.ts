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
    // Coarse grain, visible wobble: a pencil line. The
    // grain is coarse on purpose (features ~2px), so the
    // speckle reads at small sizes — a fine grain (0.9)
    // averaged out to a plain grey line and the row read
    // as Ink. The cut is hard (steep slope, same
    // midpoint), so the speckle is dark dots with clear
    // gaps, not a pale grey wash.
    filterSvg:
      grainMask(0.45, 2, 7, 8, -3.5)
      + `<feDisplacementMap in="SourceGraphic" in2="noise" scale="4" result="wobbly" />`
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
    // Smudged and rich black: a dark continuous core with
    // a soft grey halo under it, so the edge fades out
    // like smudged charcoal instead of stopping dead.
    // The grain cut is gentle, so the core stays solid;
    // the halo is only a blur of the stroke at half
    // alpha, and the core on top of it stays hard — a
    // blur of the whole stroke read as out of focus.
    filterSvg:
      grainMask(0.3, 4, 21, 5, -1.5)
      + `<feDisplacementMap in="SourceGraphic" in2="noise" scale="9" result="smudged" />`
      + `<feComponentTransfer in="smudged" result="dark"><feFuncA type="linear" slope="2.5" intercept="-0.3" /></feComponentTransfer>`
      + `<feComposite in="dark" in2="grain" operator="in" result="core" />`
      + `<feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="haloBlur" />`
      + `<feComponentTransfer in="haloBlur" result="halo"><feFuncA type="linear" slope="0.35" intercept="0" /></feComponentTransfer>`
      + `<feMerge><feMergeNode in="halo" /><feMergeNode in="core" /></feMerge>`,
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
    // A wash with pigment pools, not a grey smear: slow
    // displacement for a visibly wobbly edge, and the same
    // low turbulence shaped into a wide alpha mask, so the
    // wash holds clearly darker and lighter pools — a
    // narrow mask (0.8/0.2) left the pools only ~10 grey
    // levels apart and the wash read as one flat pale
    // smear, breaking up at small sizes. The mask floor
    // stays above zero over the usual noise range, so the
    // wash stays continuous; rare low spots dry out the
    // way a real wash does. No blur anywhere.
    filterSvg:
      grainMask(0.06, 2, 17, 1.6, 0.0)
      + `<feDisplacementMap in="SourceGraphic" in2="noise" scale="4" result="blotchy" />`
      + `<feComposite in="blotchy" in2="grain" operator="in" />`,
  },
  {
    id: "spray", label: "Spray", family: "pen",
    // A spray can, not a line with dust: the dots are big
    // enough to see individually (coarse grain, ~5px) and
    // sparse enough that white shows between them — small
    // dense dots (0.3) averaged into a dark mass that read
    // as a thick ink line. Dots only — no solid core under
    // the scatter: a core read as a straight line with dust
    // on it. The halo band is a blur pushed back up by a
    // transfer, not a dilate: feMorphology left a faint wash
    // over the whole filter region in the app. The dots are
    // cut hard from the band — no second blur after the cut,
    // or each dot's edge goes soft and the scatter reads
    // as a blurry smear. The band itself fades at its
    // edge the way a real spray does, so the dots thin
    // out toward the edge instead of stopping dead.
    filterSvg:
      grainMask(0.18, 2, 9, 8, -4.9)
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
