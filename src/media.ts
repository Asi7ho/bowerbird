// Media: PDF documents and rendering, audio probing and playback.
// Everything here is async work keyed by board path or card id, with
// board-switch guards so a result that lands after a switch never
// writes into the new board's card with the same id. The module owns
// its caches (parsed PDFs, extracted text, durations, data-URL
// fallbacks); the core clears them on board load via
// clearBoardCaches(), and reads durations / failure state through
// the maps below.
import { api } from "./api";
import { boardGet, type Board } from "./model";

export interface MediaContext {
  getBoard(): Board;
  getBoardGeneration(): number;
  bumpSearchVersion(): void;
  requestSearchUpdate(): void;
  requestRender(): void;
  // The cards layer, read lazily: the board DOM is built by
  // the core-board plugin, so the cards element does not
  // exist when the media module is created at module load.
  getCardsEl: () => HTMLDivElement;
  toast(msg: string): void;
}

export interface Media {
  pdfSearchText: Map<string, string>;
  mediaDataUrls: Map<string, string>;
  audioDurations: Map<string, number>;
  audioFailed: Set<string>;
  pdfFailed: Set<string>;
  pdfPages: Map<number, number>;
  getPdfDoc(path: string): Promise<PdfDoc>;
  getCachedPdfDoc(path: string): Promise<PdfDoc> | undefined;
  indexPdfForSearch(path: string): void;
  loadPdfPage(id: number, path: string): void;
  renderPdfPage(id: number, path: string): Promise<void>;
  loadAudioDuration(id: number, path: string): void;
  updateAudioProgress(): void;
  formatAudioTime(sec: number): string;
  toggleAudio(id: number, path: string): void;
  stopAudio(): void;
  getAudioState(): { el: HTMLAudioElement | null; id: number | null };
  // Transcribe a recorded audio blob to text, on-device
  // (Whisper in the main process). Null when the audio
  // cannot be decoded or the model cannot run — the caller
  // keeps the recording, just without a transcript.
  transcribeAudio(blob: Blob): Promise<string | null>;
  clearBoardCaches(): void;
}

export type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

export function createMedia(host: MediaContext): Media {
  // PDF.js is loaded lazily, not statically imported: it
  // used to sit in the main chunk (533 KB) and every launch
  // paid for it, including boards with no PDFs. It is now
  // imported on first PDF render or PDF search indexing,
  // with its parser in a worker so a large PDF never
  // blocks the board. The worker is bundled by Vite from
  // the ?worker import below.
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
  let audioEl: HTMLAudioElement | null = null;
  let audioId: number | null = null;
  const audioDurations = new Map<string, number>();
  const audioProbing = new Set<string>();
  // PDF rendering, like audio durations: a PDF card is built as
  // HTML first, then its page is drawn into the canvas in it,
  // because PDF.js loads and renders asynchronously. The
  // document is cached by path, the current page by card id,
  // so flipping pages and re-rendering after a board change
  // do not reload the file, and a failed PDF falls back to
  // its name and size instead of an empty card.
  type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;
  const pdfDocs = new Map<string, Promise<PdfDoc>>();
  const pdfFailed = new Set<string>();
  // Extracted PDF text for search, keyed by path. Filled
  // lazily on the first search that could match a PDF, so
  // board load is never slowed by text extraction.
  const pdfSearchText = new Map<string, string>();
  const pdfSearchIndexing = new Set<string>();
  function getPdfDoc(path: string): Promise<PdfDoc> {
    let docPromise = pdfDocs.get(path);
    if (!docPromise) {
      docPromise = (async () => {
        const pdfjsLib = await loadPdfjs();
        try {
          const res = await fetch(api.fileUrl(path));
          if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`);
          const data = await res.arrayBuffer();
          return pdfjsLib.getDocument({ data }).promise;
        } catch {
          const { base64 } = await api.readFileBase64(path);
          // atob output is Latin-1, so each char is one byte.
          const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          return pdfjsLib.getDocument({ data }).promise;
        }
      })();
      pdfDocs.set(path, docPromise);
    }
    return docPromise;
  }
  function indexPdfForSearch(path: string): void {
    if (pdfSearchText.has(path) || pdfSearchIndexing.has(path)) return;
    pdfSearchIndexing.add(path);
    // If the board switches mid-extraction, the text is
    // still valid for its path, but bumping the new
    // board's search version and re-running its search
    // would be for the wrong board: skip both.
    const gen = host.getBoardGeneration();
    void getPdfDoc(path).then(async (doc) => {
      try {
        const parts: string[] = [];
        const pages = Math.min(doc.numPages, 50);
        for (let i = 1; i <= pages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          for (const it of content.items) {
            if (typeof (it as { str?: unknown }).str === "string") parts.push((it as { str: string }).str);
          }
        }
        pdfSearchText.set(path, parts.join(" "));
        if (gen === host.getBoardGeneration()) host.bumpSearchVersion();
      } catch { /* search falls back to the filename */ }
      pdfSearchIndexing.delete(path);
      if (gen !== host.getBoardGeneration()) return;
      const input = document.getElementById("search-input") as HTMLInputElement | null;
      if (input && input.value.trim() !== "") host.requestSearchUpdate();
    }).catch(() => { pdfSearchIndexing.delete(path); });
  }
  const pdfPages = new Map<number, number>();
  const pdfRendering = new Set<number>();
  function formatAudioTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) return "–:––";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  function updateAudioProgress(): void {
    if (!audioEl || audioId === null) return;
    const dur = audioEl.duration;
    const cur = audioEl.currentTime;
    const timeEl = host.getCardsEl().querySelector(`[data-audio-time="${audioId}"]`);
    if (timeEl) timeEl.textContent = formatAudioTime(cur);
    const durEl = host.getCardsEl().querySelector(`[data-audio-dur="${audioId}"]`);
    if (durEl && isFinite(dur)) durEl.textContent = formatAudioTime(dur);
    const seekEl = host.getCardsEl().querySelector(`[data-audio-seek="${audioId}"]`) as HTMLInputElement | null;
    if (seekEl && isFinite(dur) && dur > 0) {
      seekEl.style.setProperty("--seek-pct", `${Math.round((cur / dur) * 100)}%`);
      if (document.activeElement !== seekEl) seekEl.value = String(Math.round((cur / dur) * 1000));
    }
  }
  const audioFailed = new Set<string>();
  // Data-URL fallbacks for files whose app-file load failed,
  // keyed by board path. Audio playback uses this map too,
  // so a file that only loads as a data URL still plays.
  const mediaDataUrls = new Map<string, string>();
  function loadAudioDuration(id: number, path: string): void {
    if (audioDurations.has(path) || audioProbing.has(path) || audioFailed.has(path)) return;
    audioProbing.add(path);
    // Both the first probe and the data-URL retry write the
    // duration the same way: only if this card is still an
    // audio card for the same file on this board.
    const onAudioMetadata = (el: HTMLAudioElement) => () => {
      audioProbing.delete(path);
      const it = boardGet(host.getBoard(), id);
      if (!it || !("Audio" in it.kind) || it.kind.Audio.path !== path) return;
      if (isFinite(el.duration)) {
        audioDurations.set(path, el.duration);
        const durEl = host.getCardsEl().querySelector(`[data-audio-dur="${id}"]`);
        if (durEl) durEl.textContent = formatAudioTime(el.duration);
      }
    };
    const probe = new Audio(api.fileUrl(path));
    probe.onerror = () => {
      // Same app-file fallback as images and video: try
      // once as a data URL before calling the file missing.
      void api.readFileBase64(path).then(({ mime, base64 }) => {
        const dataUrl = `data:${mime};base64,${base64}`;
        mediaDataUrls.set(path, dataUrl);
        const retry = new Audio(dataUrl);
        retry.preload = "metadata";
        retry.onloadedmetadata = onAudioMetadata(retry);
        retry.onerror = () => {
          audioProbing.delete(path);
          audioFailed.add(path);
          host.requestRender();
        };
      }).catch(() => {
        audioProbing.delete(path);
        audioFailed.add(path);
        host.requestRender();
      });
    };
    probe.preload = "metadata";
    probe.onloadedmetadata = onAudioMetadata(probe);
  }
  async function renderPdfPage(id: number, path: string): Promise<void> {
    if (pdfRendering.has(id) || pdfFailed.has(path)) return;
    pdfRendering.add(id);
    let canvas: HTMLCanvasElement | null = null;
    let renderedPage = 0;
    try {
      // The canvas is queried after the document loads, not
      // before: loadPdfPage runs while cardHtml is still
      // building the new HTML, so a canvas queried here
      // would be the old render's, about to be discarded.
      // Every await below yields past the synchronous render
      // that puts the new canvas in the DOM.
      // One shared promise per path, so two cards showing the
      // same PDF wait on the same load instead of racing it.
      const doc = await getPdfDoc(path);
      // The board may have switched while the document
      // loaded: the new board can have a different card
      // at this id, and drawing the old PDF into its
      // canvas would show the wrong page on the wrong
      // card. Only render when this card is still a PDF
      // card for the same file on this board.
      const stillPdf = () => {
        const it = boardGet(host.getBoard(), id);
        return it && "PdfCard" in it.kind && it.kind.PdfCard.path === path;
      };
      if (!stillPdf()) return;
      canvas = host.getCardsEl().querySelector(`[data-pdf-canvas="${id}"]`) as HTMLCanvasElement | null;
      if (!canvas) return;
      const pageNum = pdfPages.get(id) ?? 1;
      renderedPage = pageNum;
      const page = await doc.getPage(Math.max(1, Math.min(pageNum, doc.numPages)));
      if (!stillPdf()) return;
      // Render at device scale, then let CSS fit the canvas to
      // its box: a portrait page in a wide card letterboxes,
      // a landscape page fills it, and zoom scales the layer.
      const viewport = page.getViewport({ scale: 2 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvas, viewport }).promise;
      const countEl = host.getCardsEl().querySelector(`[data-pdf-count="${id}"]`);
      if (countEl) countEl.textContent = `${pageNum} / ${doc.numPages}`;
      const prev = host.getCardsEl().querySelector(`[data-action="pdf-prev"][data-id="${id}"]`) as HTMLButtonElement | null;
      const next = host.getCardsEl().querySelector(`[data-action="pdf-next"][data-id="${id}"]`) as HTMLButtonElement | null;
      if (prev) prev.disabled = pageNum <= 1;
      if (next) next.disabled = pageNum >= doc.numPages;
    } catch {
      // Same board-switch guard: a failed render for a
      // card that is no longer this PDF must not write
      // into the new board's card at this id.
      const it = boardGet(host.getBoard(), id);
      if (!it || !("PdfCard" in it.kind) || it.kind.PdfCard.path !== path) return;
      pdfFailed.add(path);
      const wrap = host.getCardsEl().querySelector(`[data-pdf-wrap="${id}"]`);
      if (wrap) wrap.textContent = "Could not render this PDF. Double-click to open it.";
    } finally {
      pdfRendering.delete(id);
      // If a board render replaced the canvas while this page
      // was loading, the new canvas is still blank, and if
      // the user flipped pages while this render was in
      // flight, the page shown is now stale: render again.
      // Never re-render after a board switch, for the same
      // reason as above.
      const it = boardGet(host.getBoard(), id);
      const current = host.getCardsEl().querySelector(`[data-pdf-canvas="${id}"]`) as HTMLCanvasElement | null;
      const stale = renderedPage !== 0 && (pdfPages.get(id) ?? 1) !== renderedPage;
      if (it && "PdfCard" in it.kind && it.kind.PdfCard.path === path && current && (current !== canvas || stale) && !pdfFailed.has(path)) void renderPdfPage(id, path);
    }
  }
  function loadPdfPage(id: number, path: string): void {
    // Fire and forget from cardHtml, like loadAudioDuration:
    // the canvas is already in the DOM, renderPdfPage fills
    // it, and a later render re-runs this for the new canvas.
    void renderPdfPage(id, path);
  }
  function toggleAudio(id: number, path: string): void {
    if (audioId === id && audioEl && !audioEl.paused) {
      audioEl.pause();
      host.requestRender();
      return;
    }
    if (audioEl) audioEl.pause();
    // If the app-file probe already fell back to a data
    // URL for this file, play from that URL, not the
    // scheme that failed.
    audioEl = new Audio(mediaDataUrls.get(path) ?? api.fileUrl(path));
    audioId = id;
    audioEl.onloadedmetadata = () => {
      if (audioEl && isFinite(audioEl.duration)) audioDurations.set(path, audioEl.duration);
      updateAudioProgress();
    };
    audioEl.ontimeupdate = () => updateAudioProgress();
    audioEl.play().catch((err) => {
      // Do not leave the card saying "Now playing" for a file that
      // failed to load.
      audioId = null;
      host.toast(`Could not play audio: ${String(err)}`);
      host.requestRender();
    });
    audioEl.onended = () => { audioId = null; host.requestRender(); };
    host.requestRender();
  }

  function clearBoardCaches(): void {
    // Parsed PDF documents and full base64 data URLs
    // (each up to 50 MB) are caches only and re-load on
    // demand for the new board; keeping them across a
    // switch leaked memory for the app lifetime.
    pdfDocs.clear();
    pdfFailed.clear();
    mediaDataUrls.clear();
    audioDurations.clear();
    audioFailed.clear();
    pdfSearchText.clear();
    pdfSearchIndexing.clear();
    pdfPages.clear();
  }

  function getAudioState(): { el: HTMLAudioElement | null; id: number | null } {
    return { el: audioEl, id: audioId };
  }

  function stopAudio(): void {
    if (audioEl) audioEl.pause();
    audioEl = null;
    audioId = null;
  }

  function getCachedPdfDoc(path: string): Promise<PdfDoc> | undefined {
    return pdfDocs.get(path);
  }

  return {
    pdfSearchText,
    mediaDataUrls,
    audioDurations,
    audioFailed,
    pdfFailed,
    pdfPages,
    getPdfDoc,
    getCachedPdfDoc,
    indexPdfForSearch,
    loadPdfPage,
    renderPdfPage,
    loadAudioDuration,
    updateAudioProgress,
    formatAudioTime,
    toggleAudio,
    stopAudio,
    getAudioState,
    transcribeAudio,
    clearBoardCaches,
  };
}

// Decode a recorded blob to 16kHz mono samples, the shape
// Whisper takes. Node has no AudioContext to decode with,
// so the decode happens here, in the renderer, and only
// the samples cross to the main process.
async function decodeTo16kMono(blob: Blob): Promise<Float32Array | null> {
  try {
    const ctx = new AudioContext();
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    } finally {
      void ctx.close();
    }
    if (decoded.numberOfChannels === 0 || decoded.length === 0) return null;
    // An offline render at 16kHz resamples and downmixes to
    // mono in one step, whatever the recording's format.
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } catch {
    return null;
  }
}

async function transcribeAudio(blob: Blob): Promise<string | null> {
  const samples = await decodeTo16kMono(blob);
  if (!samples || samples.length === 0) return null;
  try {
    return await api.transcribeAudio(samples);
  } catch {
    return null;
  }
}
