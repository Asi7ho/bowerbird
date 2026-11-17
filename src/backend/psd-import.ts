// PSD import: parse a .psd file and render its merged
// composite as the preview for a FileCard. The composite
// is what Photoshop shows — all visible layers, including
// text, flattened — so the card shows the artwork, and the
// file itself is kept and live-synced. The layers are no
// longer exploded into cards: a .psd is edited in
// Photoshop, which is where double-clicking the card opens
// it.
//
// Parsing is pure (ag-psd with useImageData, so no canvas
// is needed to read a file); turning pixels into PNG bytes
// needs a canvas, so that step lives in imageDataToPngBytes
// and only runs in the renderer.
import { initializeCanvas, readPsd, type PixelData, type Psd } from "ag-psd";

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

// Render a PSD's merged composite as the preview for a
// FileCard: the composite is what Photoshop shows — all
// visible layers, including text, flattened. Returns null
// when the file has no composite (nothing visible to show),
// so the card falls back to its format tile.
export async function renderPsdPreview(psd: Psd): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  if (!psd.imageData || psd.width <= 0 || psd.height <= 0) return null;
  const png = await imageDataToPngBytes(psd.imageData);
  return { png, width: psd.width, height: psd.height };
}

// Render raw pixels to PNG bytes. Renderer-only: it paints
// the pixels onto a canvas and exports it, so it needs
// `document`. 16-bit channels are scaled down (÷257) and
// 32-bit float channels (0–1) up (×255), so a 16/32-bit PSD
// lands with its colours intact.
export async function imageDataToPngBytes(pixels: PixelData): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context for PSD preview");
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
  if (!blob) throw new Error("could not encode PSD preview as PNG");
  return new Uint8Array(await blob.arrayBuffer());
}
