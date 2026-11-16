// PSD import: parse a .psd file's layers into board cards.
//
// Each raster layer becomes an Image card at its layer
// position and size; each text layer becomes a Text card
// (text, size and colour from the layer's type data).
// Hidden layers, empty layers and adjustment layers (which
// have neither pixels nor text) are skipped, and group
// layers are flattened into their children. Layer effects,
// blend modes and adjustment layers are NOT reproduced —
// the visible artwork and the layer structure are what is
// preserved, said so in the PR description.
//
// Parsing is pure (ag-psd with useImageData, so no canvas
// is needed to read a file); turning a layer's pixels into
// PNG bytes needs a canvas, so that step lives in
// imageDataToPngBytes and only runs in the renderer.
import { initializeCanvas, readPsd, type Layer, type PixelData, type Psd } from "ag-psd";
import type { Pt } from "bowerbird-plugin-api";
import { estimateTextHeight } from "./model";
import type { ImportedItem } from "./import-types";

// Node has no canvas: ag-psd only needs createImageData on
// the useImageData read path, so install a minimal shim
// there. In the renderer `document` exists and ag-psd
// initialises itself from it — never override that.
if (typeof document === "undefined") {
  initializeCanvas(
    () => { throw new Error("ag-psd canvas is only available in the renderer"); },
    // ag-psd only reads .data/.width/.height off this on the
    // useImageData path; the cast is for its ImageData type.
    (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }) as ImageData,
  );
}

// Parse a PSD file's bytes. Throws on a file that is not a
// PSD (the caller reports it and drops nothing).
export function parsePsd(buffer: ArrayBuffer): Psd {
  return readPsd(buffer, { useImageData: true, skipThumbnail: true });
}

function hexOf(color: unknown): string {
  if (!color || typeof color !== "object") return "#1A1A1A";
  const { r, g, b } = color as { r?: unknown; g?: unknown; b?: unknown };
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return "#1A1A1A";
  const hex = (c: number): string => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0");
  return "#" + hex(r) + hex(g) + hex(b);
}

// Flatten a PSD's layer tree, topmost layer first (the file
// stores layers top to bottom), into the board's card
// order — later cards paint on top, so the topmost layer
// must come last.
function flattenLayers(layers: Layer[] | undefined): Layer[] {
  const out: Layer[] = [];
  for (const layer of layers ?? []) {
    if (layer.children && layer.children.length > 0) {
      out.push(...flattenLayers(layer.children));
    } else {
      out.push(layer);
    }
  }
  return out;
}

// Turn a parsed PSD into board cards placed at `origin`,
// scaled down to `maxWidth` if the canvas is wider.
// Positions stay relative to the PSD canvas: a layer at
// (left, top) lands at origin + (left, top), scaled.
export function psdLayersToItems(psd: Psd, origin: Pt, maxWidth = 1280): ImportedItem[] {
  const scale = psd.width > maxWidth ? maxWidth / psd.width : 1;
  const place = (left: number, top: number): Pt => ({ x: origin.x + left * scale, y: origin.y + top * scale });
  const items: ImportedItem[] = [];
  // Children arrive topmost-first; reverse so the topmost
  // layer lands last, on top of the ones below it.
  const layers = flattenLayers(psd.children).reverse();
  for (const layer of layers) {
    if (layer.hidden) continue;
    const left = layer.left ?? 0, top = layer.top ?? 0;
    const right = layer.right ?? left, bottom = layer.bottom ?? top;
    const w = Math.max(0, right - left), h = Math.max(0, bottom - top);
    if (layer.text?.text) {
      const text = layer.text.text;
      const fontSize = Math.max(8, Math.round((layer.text.style?.fontSize ?? 16) * scale));
      const width = Math.min(640, Math.max(120, w * scale));
      items.push({
        kind: {
          Text: {
            text,
            bold: layer.text.style?.fauxBold ?? false,
            size: fontSize,
            color: hexOf(layer.text.style?.fillColor),
          },
        },
        pos: place(left, top),
        size: { w: width, h: Math.max(40, estimateTextHeight(text, fontSize, width)) },
      });
      continue;
    }
    if (layer.imageData && w > 0 && h > 0) {
      items.push({
        kind: { Image: { path: "" } },
        pos: place(left, top),
        size: { w: Math.max(1, w * scale), h: Math.max(1, h * scale) },
        pixels: layer.imageData,
      });
      continue;
    }
    // No text and no pixels: an empty layer, an adjustment
    // layer, or a group that flattened to nothing. Skip it.
  }
  // A flattened PSD has no layers but still has a composite
  // image: land that as a single card rather than nothing.
  if (items.length === 0 && psd.imageData && psd.width > 0 && psd.height > 0) {
    items.push({
      kind: { Image: { path: "" } },
      pos: { ...origin },
      size: { w: Math.max(1, psd.width * scale), h: Math.max(1, psd.height * scale) },
      pixels: psd.imageData,
    });
  }
  return items;
}

// Render a layer's raw pixels to PNG bytes. Renderer-only:
// it paints the pixels onto a canvas and exports it, so it
// needs `document`. The drop flow calls this for each raster
// layer, then embeds the bytes. 16-bit channels are scaled
// down (÷257) and 32-bit float channels (0–1) up (×255),
// so a 16/32-bit PSD lands with its colours intact.
export async function imageDataToPngBytes(pixels: PixelData): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context for PSD layer");
  const src = pixels.data;
  let bytes: Uint8ClampedArray<ArrayBuffer>;
  if (src instanceof Uint16Array) {
    bytes = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i++) bytes[i] = Math.round(src[i] / 257);
  } else if (src instanceof Float32Array) {
    bytes = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, src[i])) * 255);
  } else {
    bytes = Uint8ClampedArray.from(src);
  }
  const image = new ImageData(bytes, pixels.width, pixels.height);
  ctx.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not encode PSD layer as PNG");
  return new Uint8Array(await blob.arrayBuffer());
}
