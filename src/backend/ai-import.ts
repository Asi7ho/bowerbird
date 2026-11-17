// Illustrator import: a modern .ai file saved with PDF
// compatibility IS a PDF — the artwork lives in an embedded
// PDF stream — so the app renders its first page as the
// preview for a FileCard, and the file itself is kept and
// live-synced. It never lands as a PDF preview card, and
// its vector content is no longer extracted into editable
// cards: a .ai is edited in Illustrator, which is where
// double-clicking the card opens it. An .ai file saved
// without PDF compatibility is PostScript, which the app
// cannot read: that is reported as unsupported, never
// silently dropped (see drops.ts).
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

// Render one page to PNG bytes, at 2x for sharpness (the
// card sizes from the page, so the pixels stay sharp).
async function renderPageToPng(page: PdfPage): Promise<Uint8Array> {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context for AI preview");
  await page.render({ canvas, viewport }).promise;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not render AI page as PNG");
  return new Uint8Array(await blob.arrayBuffer());
}
