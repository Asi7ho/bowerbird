// Illustrator import: a modern .ai file saved with PDF
// compatibility IS a PDF — the artwork lives in an embedded
// PDF stream — so its vector content is extracted into
// editable cards (see ai-vector.ts), never landed as a PDF
// preview card: the user wants the artwork as shapes, not a
// preview. A page with anything the extractor cannot
// represent (gradients, clipping, transparency, patterns)
// falls back to one Image card of the rendered page. An .ai
// file saved without PDF compatibility is PostScript, which
// the app cannot read: that is reported as unsupported, never
// silently dropped (see drops.ts).
import type { Kind, Pt } from "bowerbird-plugin-api";
import type { ImportedItem } from "./import-types";
import { extractAiPage, type AiExtractResult, type AiRawItem } from "./ai-vector";

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

// PDF.js is loaded lazily, not statically imported — same
// reason as in media.ts: it used to sit in the main chunk
// (533 KB) and every launch paid for it. The worker is
// bundled by Vite from the ?worker import below.
let pdfjsLibPromise: Promise<typeof import("pdfjs-dist")> | null = null;
async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const lib = await import("pdfjs-dist");
      const { default: PdfWorker } = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker");
      lib.GlobalWorkerOptions.workerPort = new PdfWorker();
      return lib;
    })();
  }
  return pdfjsLibPromise;
}

type PdfPage = import("pdfjs-dist").PDFPageProxy;

// pdf.js image kinds (ImageKind in pdf.js): 1 = grayscale
// (1 byte/px), 2 = RGB (3 bytes/px), 3 = RGBA (4 bytes/px).
// The resolved image object has two shapes: with a worker
// (the app's case) it arrives as an ImageBitmap, decoded by
// the worker for rendering; without one (main-thread
// evaluation) it is a plain { width, height, kind, data }
// with raw pixel bytes. Both are handled.
async function resolveImagePixels(page: PdfPage, objId: string): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  // The object is usually resolved by the time the operator
  // list returns; read it synchronously, and wait briefly
  // (callback form) if it is not there yet.
  let raw: unknown = null;
  try {
    raw = page.objs.get(objId);
  } catch {
    raw = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      try {
        page.objs.get(
          objId,
          (data: unknown) => { clearTimeout(timer); resolve(data); },
          () => { clearTimeout(timer); resolve(null); },
        );
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }
  if (!raw || typeof raw !== "object") return null;
  const img = raw as { width?: unknown; height?: unknown; kind?: unknown; data?: unknown; bitmap?: unknown };
  if (typeof img.width !== "number" || typeof img.height !== "number") return null;
  if (img.bitmap instanceof ImageBitmap) {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img.bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    return { width: img.width, height: img.height, data: imageData.data };
  }
  if (!(img.data instanceof Uint8Array)) return null;
  const n = img.width * img.height;
  const rgba = new Uint8ClampedArray(n * 4);
  if (img.kind === 3) {
    if (img.data.length < n * 4) return null;
    rgba.set(img.data.subarray(0, n * 4));
  } else if (img.kind === 2) {
    if (img.data.length < n * 3) return null;
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = img.data[i * 3];
      rgba[i * 4 + 1] = img.data[i * 3 + 1];
      rgba[i * 4 + 2] = img.data[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else if (img.kind === 1) {
    if (img.data.length < n) return null;
    for (let i = 0; i < n; i++) {
      const v = img.data[i];
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
    }
  } else {
    return null;
  }
  return { width: img.width, height: img.height, data: rgba };
}

// Render a PDF-compatible .ai file's first page as the
// preview for a FileCard, at 2x for sharpness (the card
// sizes from the page, so the pixels stay sharp). A file
// with more artboards shows its first; the rest live in
// Illustrator, which is where the file opens. Returns null
// when the file cannot be read as a PDF at all.
export async function renderAiPreview(data: Uint8Array): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  let doc: import("pdfjs-dist").PDFDocumentProxy;
  try {
    const pdfjs = await loadPdfjs();
    doc = await pdfjs.getDocument({ data }).promise;
  } catch {
    return null;
  }
  if (doc.numPages < 1) return null;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const png = await renderPageToPng(page);
  return { png, width: viewport.width, height: viewport.height };
}

// Render one page to PNG bytes, at 2x for the raster
// fallback (the card is sized from the page, so the pixels
// stay sharp when the import is scaled down).
async function renderPageToPng(page: PdfPage): Promise<Uint8Array> {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context for AI fallback");
  await page.render({ canvas, viewport }).promise;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not render AI page as PNG");
  return new Uint8Array(await blob.arrayBuffer());
}

// A .ai file has one artboard per PDF page, and a file with
// more pages than this is almost certainly a PDF renamed
// .ai: cap the import rather than flooding the board.
const MAX_PAGES = 20;
const PAGE_GAP = 24;

// Parse a PDF-compatible .ai file's bytes into board cards
// placed at `origin`, scaled down to `maxWidth` if the
// artwork is wider (same rule as the SVG import). Returns an
// empty list for a file with no importable artwork (the
// caller reports that); throws when the bytes are not a
// readable PDF at all (the caller reports that too).
export async function parseAiToItems(data: Uint8Array, origin: Pt, maxWidth = 640): Promise<ImportedItem[]> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data }).promise;
  const raw: AiRawItem[] = [];
  let offsetY = 0;
  const pages = Math.min(doc.numPages, MAX_PAGES);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const pageItems: AiRawItem[] = [];
    let extracted: AiExtractResult | null = null;
    // A rotated page's user-space coordinates do not match
    // its viewport orientation, so the extractor's output
    // would land skewed: raster it like unmappable content.
    const needRaster = page.rotate !== 0;
    if (!needRaster) {
      const opList = await page.getOperatorList();
      extracted = extractAiPage({ fnArray: opList.fnArray, argsArray: opList.argsArray as unknown[][] }, viewport.height);
    }
    if (needRaster || (extracted && extracted.unmappable)) {
      const png = await renderPageToPng(page);
      pageItems.push({
        kind: { Image: { path: "" } },
        pos: { x: 0, y: 0 },
        size: { w: viewport.width, h: viewport.height },
        embed: { name: `page-${p}.png`, data: png },
      });
    } else if (extracted) {
      let imageFailed = false;
      for (const req of extracted.images) {
        const pixels = await resolveImagePixels(page, req.objId);
        if (!pixels) { imageFailed = true; break; }
        pageItems.push({
          kind: { Image: { path: "" } },
          pos: req.pos,
          size: req.size,
          ...(req.rotation !== undefined ? { rotation: req.rotation } : {}),
          pixels,
        });
      }
      if (imageFailed) {
        // An image that cannot be decoded sinks the page to
        // the raster fallback, like unmappable content.
        const png = await renderPageToPng(page);
        pageItems.length = 0;
        pageItems.push({
          kind: { Image: { path: "" } },
          pos: { x: 0, y: 0 },
          size: { w: viewport.width, h: viewport.height },
          embed: { name: `page-${p}.png`, data: png },
        });
      } else {
        pageItems.push(...extracted.items);
      }
    }
    // Stack the pages vertically with a gap, in page
    // coordinates; the union scale below places them all.
    // Stroke points are absolute in the page frame, so
    // they move with pos — otherwise a stroke on a later
    // page would draw at its first-page position.
    for (const it of pageItems) {
      it.pos = { x: it.pos.x, y: it.pos.y + offsetY };
      if ("Stroke" in it.kind) {
        it.kind.Stroke.points = it.kind.Stroke.points.map((p) => ({ x: p.x, y: p.y + offsetY }));
      }
      raw.push(it);
    }
    offsetY += viewport.height + PAGE_GAP;
  }
  if (raw.length === 0) return [];
  // Union box of everything, in page units.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of raw) {
    minX = Math.min(minX, it.pos.x); minY = Math.min(minY, it.pos.y);
    maxX = Math.max(maxX, it.pos.x + it.size.w); maxY = Math.max(maxY, it.pos.y + it.size.h);
  }
  const w = maxX - minX;
  const scale = w > maxWidth ? maxWidth / w : 1;
  const out: ImportedItem[] = raw.map((it) => {
    const kind: Kind = it.kind;
    if ("Stroke" in kind) {
      // Points are absolute in page units, so they
      // translate like pos does — never scale them in place
      // as relative offsets.
      kind.Stroke.points = kind.Stroke.points.map((pt) => ({ x: origin.x + (pt.x - minX) * scale, y: origin.y + (pt.y - minY) * scale }));
      kind.Stroke.width = Math.max(1, kind.Stroke.width * scale);
    }
    if ("Text" in kind && it.fontSize !== undefined) {
      kind.Text.size = Math.max(8, Math.round(kind.Text.size * scale));
    }
    const { fontSize: _fontSize, ...rest } = it;
    void _fontSize;
    return {
      ...rest,
      kind,
      pos: { x: origin.x + (it.pos.x - minX) * scale, y: origin.y + (it.pos.y - minY) * scale },
      size: { w: Math.max(1, it.size.w * scale), h: Math.max(1, it.size.h * scale) },
    };
  });
  return out;
}
