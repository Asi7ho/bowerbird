// Media: PDF documents/rendering, audio probing and playback.
// Async work keyed by board path or card id, with board-switch
// guards so a late result never writes into the new board.

import { api } from "./api";
import { peaksFromSamples } from "./audio-peaks";
import { boardGet, type Board } from "./model";
import { fileCardHeightForWidth, fileCardPreviewHeight, linkCardHeightForWidth, pdfCardHeightForWidth, videoCardHeightForWidth } from "./live-import";

export interface MediaContext {
  getBoard(): Board;
  getBoardGeneration(): number;
  bumpSearchVersion(): void;
  requestSearchUpdate(): void;
  requestRender(): void;
  // Write the board without an undo step: for heals, not
  // for user actions, so a healed card never becomes an
  // undoable change.
  saveWithoutUndo(): void;
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
  // Heal a FileCard saved at the stale height (see
  // loadFileCardSize): measure its preview and shrink the
  // card to the ratio of the file when it is still wrong.
  loadFileCardSize(preview: string): void;
  // Heal a Video card saved at the stale 16:9 height (see
  // loadVideoCardSize): measure its poster and resize the
  // card to the ratio of the video when it is still wrong.
  loadVideoCardSize(poster: string): void;
  // The first page's size in points, for sizing a PDF card
  // to its page at drop time. Null when the file cannot be
  // read. Shares the document load with the renderer, so
  // probing never opens the file twice.
  probePdfSize(path: string): Promise<{ w: number; h: number } | null>;
  // Heal a PdfCard saved at the stale fixed size (see
  // loadPdfCardSize): measure its first page and resize the
  // card to the ratio of the page when it is still wrong.
  loadPdfCardSize(path: string): void;
  // Heal a UrlCard saved at the stale fixed size (see
  // loadLinkCardSize): measure its preview image and resize
  // the card to the ratio of the image when it is still
  // wrong.
  loadLinkCardSize(image: string): void;
  loadAudioDuration(id: number, path: string): void;
  // Waveform peaks for an audio card (100 bars, 0..1), from
  // a real decode of the file — never fake bars. Loaded on
  // demand like the duration, cached per path.
  getAudioPeaks(path: string): number[] | undefined;
  loadAudioPeaks(id: number, path: string): Promise<void>;
  // Seek an audio card to a time in seconds. Unlike the
  // plugin API's seekAudio (playing only), this also works
  // on a card that is not playing: it loads the file paused
  // at that time, so pressing play starts there instead of
  // from the top.
  seekAudioTo(id: number, path: string, time: number): void;
  updateAudioProgress(): void;
  formatAudioTime(sec: number): string;
  toggleAudio(id: number, path: string): void;
  stopAudio(): void;
  getAudioState(): { el: HTMLAudioElement | null; id: number | null };
  // The video card currently showing a live <video> element,
  // if any. At most one: a video card is a poster until its
  // play button is pressed, and pressing another card's play
  // button moves the live element there. Null means every
  // video card is a poster.
  playVideo(id: number): void;
  getVideoState(): { id: number | null };
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
  // The video card showing a live <video> element, if any.
  // The element itself lives in the card's DOM (the picture
  // has to), so this is just the id; the card renders a
  // <video> for this id and a poster for every other video.
  // Cleared on board switch with the rest of the caches.
  let videoId: number | null = null;
  function playVideo(id: number): void {
    videoId = id;
    host.requestRender();
  }
  function getVideoState(): { id: number | null } {
    return { id: videoId };
  }
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
  // The waveform is the progress display now: while the
  // audio plays, the bars up to the playback position turn
  // dark. No full re-render — the bars are already in the
  // DOM, only their played class moves, a few times a
  // second. A render (play/pause, track end) paints the
  // same state from the card itself.
  function paintWaveProgress(wave: Element, pct: number): void {
    const bars = wave.querySelectorAll("rect[data-i]");
    const cut = Math.floor(pct * bars.length);
    bars.forEach((b) => {
      const i = Number((b as HTMLElement).dataset.i);
      b.classList.toggle("played", i < cut);
    });
  }
  function updateAudioProgress(): void {
    if (!audioEl || audioId === null) return;
    const dur = audioEl.duration;
    const cur = audioEl.currentTime;
    if (!isFinite(dur) || dur <= 0) return;
    const wave = host.getCardsEl().querySelector(`[data-audio-wave="${audioId}"]`);
    if (wave) paintWaveProgress(wave, Math.min(1, Math.max(0, cur / dur)));
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
  // Waveform peaks, cached per path and decoded once: the
  // same file on two cards shares one decode. A decode in
  // flight is not started twice. A failed decode is not
  // an error state — the card shows its empty track and
  // still plays; only the waveform is missing.
  const audioPeaks = new Map<string, number[]>();
  const audioPeaksLoading = new Set<string>();
  function getAudioPeaks(path: string): number[] | undefined {
    return audioPeaks.get(path);
  }
  async function loadAudioPeaks(_id: number, path: string): Promise<void> {
    if (audioPeaks.has(path) || audioPeaksLoading.has(path)) return;
    audioPeaksLoading.add(path);
    try {
      let bytes: ArrayBuffer;
      try {
        const res = await fetch(api.fileUrl(path));
        if (!res.ok) throw new Error(`peaks fetch failed: ${res.status}`);
        bytes = await res.arrayBuffer();
      } catch {
        // Same app-file fallback as the duration probe: a
        // file that only loads as a data URL still gets a
        // waveform.
        const { base64 } = await api.readFileBase64(path);
        const bin = atob(base64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        bytes = arr.buffer;
      }
      const ctx = new AudioContext();
      let decoded: AudioBuffer;
      try {
        decoded = await ctx.decodeAudioData(bytes);
      } finally {
        void ctx.close();
      }
      if (decoded.numberOfChannels === 0 || decoded.length === 0) return;
      // Mix down to mono, whatever the recording's format.
      const mono = new Float32Array(decoded.length);
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        const ch = decoded.getChannelData(c);
        for (let i = 0; i < decoded.length; i++) mono[i] += ch[i] / decoded.numberOfChannels;
      }
      audioPeaks.set(path, peaksFromSamples(mono, 100));
      // No re-render here: the card that asked for the
      // peaks paints them into its own waveform (see
      // cards.ts). A full render would replace the card's
      // node under any click or measurement in flight.
    } catch {
      // No waveform; the card keeps its empty track.
    } finally {
      audioPeaksLoading.delete(path);
    }
  }
  // A seek asked for before the audio's metadata loaded:
  // applied on loadedmetadata instead of being lost.
  let pendingSeek: { id: number; time: number } | null = null;
  function applyPendingSeek(el: HTMLAudioElement, id: number): void {
    if (pendingSeek && pendingSeek.id === id) {
      el.currentTime = pendingSeek.time;
      pendingSeek = null;
    }
  }
  function seekAudioTo(id: number, path: string, time: number): void {
    if (audioId === id && audioEl) {
      if (audioEl.readyState === 0) pendingSeek = { id, time };
      else audioEl.currentTime = time;
      updateAudioProgress();
      return;
    }
    // Not the current audio: load it paused at that time,
    // so pressing play starts there instead of from the
    // top. A later toggleAudio resumes this same element.
    if (audioEl) audioEl.pause();
    audioEl = new Audio(mediaDataUrls.get(path) ?? api.fileUrl(path));
    audioId = id;
    pendingSeek = { id, time };
    audioEl.onloadedmetadata = () => {
      if (audioEl && isFinite(audioEl.duration)) audioDurations.set(path, audioEl.duration);
      if (audioEl) applyPendingSeek(audioEl, id);
      updateAudioProgress();
    };
    audioEl.ontimeupdate = () => updateAudioProgress();
    audioEl.onended = () => { audioId = null; host.requestRender(); };
    host.requestRender();
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
  // FileCard preview dimensions, cached per path, and the
  // paths with a load in flight. A preview is measured once
  // per file, not once per render.
  const fileCardPreviewSize = new Map<string, { w: number; h: number }>();
  const fileCardPreviewLoading = new Set<string>();
  // Video poster dimensions, cached per path, and the paths
  // with a load in flight. A poster is measured once per
  // file, not once per render. The poster is captured at the
  // video's own ratio, so its size is the video's ratio.
  const videoCardPosterSize = new Map<string, { w: number; h: number }>();
  const videoCardPosterLoading = new Set<string>();
  // Heal a FileCard saved at a stale height: the old formulas
  // sized the preview at the card minus 24px of padding and
  // then added 70px for a title and sub-line, or 24px for the
  // padding, that no longer exist. When the preview image
  // loads, measure it; if the card is still at either stale
  // height, shrink it to the ratio of the file and save (no
  // undo step — this is a heal, not an action). A card the
  // user resized by hand is left alone: its height will not
  // match a stale formula. Called from the FileCard renderer,
  // like loadPdfPage.
  function loadFileCardSize(preview: string): void {
    const cached = fileCardPreviewSize.get(preview);
    if (cached) {
      healFileCardsWithPreview(preview, cached.w, cached.h);
      return;
    }
    if (fileCardPreviewLoading.has(preview)) return;
    fileCardPreviewLoading.add(preview);
    const img = new Image();
    img.onload = () => {
      fileCardPreviewLoading.delete(preview);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        fileCardPreviewSize.set(preview, { w: img.naturalWidth, h: img.naturalHeight });
        healFileCardsWithPreview(preview, img.naturalWidth, img.naturalHeight);
      }
    };
    img.onerror = () => {
      fileCardPreviewLoading.delete(preview);
      // A missing preview leaves the card alone.
    };
    img.src = api.fileUrl(preview);
  }
  // Shrink every FileCard using this preview that is still at
  // a stale height to the ratio of the file. Several cards can
  // share one preview (the same file dropped twice), so the
  // heal runs over all of them, not just the one that asked.
  // A card the user resized by hand is left alone: its height
  // will not match a stale formula.
  function healFileCardsWithPreview(preview: string, artW: number, artH: number): void {
    let changed = false;
    for (const it of host.getBoard().items) {
      if (!("FileCard" in it.kind) || it.kind.FileCard.preview !== preview) continue;
      const correctH = fileCardHeightForWidth(artW, artH, it.size.w);
      // Both stale heights, from the preview height the old
      // formulas used (the card minus 24px of padding): +70
      // for the title and sub-line, +24 for the padding.
      const previewH = fileCardPreviewHeight(artW, artH, Math.max(1, it.size.w - 24));
      const stale70 = Math.round(previewH + 70);
      const stale24 = Math.round(previewH + 24);
      const isStale = Math.abs(it.size.h - stale70) <= 2 || Math.abs(it.size.h - stale24) <= 2;
      if (isStale && it.size.h !== correctH) {
        it.size.h = correctH;
        changed = true;
      }
    }
    if (changed) {
      host.saveWithoutUndo();
      host.requestRender();
    }
  }
  // Heal a Video card saved at the stale 16:9 height: videos
  // used to land at 360x203 whatever their ratio, so a 4:3
  // clip sat in a 16:9 card. When the poster loads, measure
  // it (it is captured at the video's own ratio); if the card
  // is still at the 16:9 height for its width, resize it to
  // the ratio of the video and save (no undo step — this is a
  // heal, not an action). A card the user resized by hand is
  // left alone: its height will not match 16:9. Called from
  // the Video renderer, like loadFileCardSize.
  function loadVideoCardSize(poster: string): void {
    const cached = videoCardPosterSize.get(poster);
    if (cached) {
      healVideoCardsWithPoster(poster, cached.w, cached.h);
      return;
    }
    if (videoCardPosterLoading.has(poster)) return;
    videoCardPosterLoading.add(poster);
    const img = new Image();
    img.onload = () => {
      videoCardPosterLoading.delete(poster);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        videoCardPosterSize.set(poster, { w: img.naturalWidth, h: img.naturalHeight });
        healVideoCardsWithPoster(poster, img.naturalWidth, img.naturalHeight);
      }
    };
    img.onerror = () => {
      videoCardPosterLoading.delete(poster);
      // A missing poster leaves the card alone.
    };
    img.src = api.fileUrl(poster);
  }
  // Resize every Video card using this poster that is still
  // at the stale 16:9 height to the ratio of the video.
  // Several cards can share one poster (the same file
  // dropped twice), so the heal runs over all of them, not
  // just the one that asked. A card the user resized by hand
  // is left alone: its height will not match 16:9.
  function healVideoCardsWithPoster(poster: string, vidW: number, vidH: number): void {
    let changed = false;
    for (const it of host.getBoard().items) {
      if (!("Video" in it.kind) || it.kind.Video.poster !== poster) continue;
      const correctH = videoCardHeightForWidth(vidW, vidH, it.size.w);
      const staleH = Math.round((it.size.w * 9) / 16);
      if (Math.abs(it.size.h - staleH) <= 2 && it.size.h !== correctH) {
        it.size.h = correctH;
        changed = true;
      }
    }
    if (changed) {
      host.saveWithoutUndo();
      host.requestRender();
    }
  }
  // PDF first-page dimensions, cached per path, and the
  // paths with a load in flight. A page is measured once
  // per file, not once per render. The document load is
  // shared with the renderer (getPdfDoc), so measuring
  // never opens the file twice.
  const pdfPageSize = new Map<string, { w: number; h: number }>();
  const pdfPageLoading = new Set<string>();
  // The first page's size in points, for sizing a PDF card
  // to its page at drop time. Null when the file cannot be
  // read, so the caller falls back to the old default.
  async function probePdfSize(path: string): Promise<{ w: number; h: number } | null> {
    const cached = pdfPageSize.get(path);
    if (cached) return cached;
    try {
      const doc = await getPdfDoc(path);
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      if (viewport.width <= 0 || viewport.height <= 0) return null;
      const dims = { w: viewport.width, h: viewport.height };
      pdfPageSize.set(path, dims);
      return dims;
    } catch {
      return null;
    }
  }
  // Heal a PdfCard saved at the stale fixed size: PDFs used
  // to land at 260x360 whatever the page, so a landscape
  // page sat in a portrait card. When the first page loads,
  // measure it; if the card is still at 260x360, resize it
  // to the ratio of the page and save (no undo step — this
  // is a heal, not an action). A card the user resized by
  // hand is left alone: its size will not match 260x360.
  // Called from the PdfCard renderer, like loadPdfPage.
  function loadPdfCardSize(path: string): void {
    const cached = pdfPageSize.get(path);
    if (cached) {
      healPdfCardsWithPage(path, cached.w, cached.h);
      return;
    }
    if (pdfPageLoading.has(path)) return;
    pdfPageLoading.add(path);
    void probePdfSize(path).then((dims) => {
      pdfPageLoading.delete(path);
      if (!dims) return;
      pdfPageSize.set(path, dims);
      healPdfCardsWithPage(path, dims.w, dims.h);
    });
  }
  // Resize every PdfCard showing this file that is still at
  // the stale fixed size to the ratio of its first page.
  // Several cards can show one PDF, so the heal runs over
  // all of them, not just the one that asked.
  function healPdfCardsWithPage(path: string, pageW: number, pageH: number): void {
    let changed = false;
    for (const it of host.getBoard().items) {
      if (!("PdfCard" in it.kind) || it.kind.PdfCard.path !== path) continue;
      if (Math.abs(it.size.w - 260) > 2 || Math.abs(it.size.h - 360) > 2) continue;
      const correctH = pdfCardHeightForWidth(pageW, pageH, it.size.w);
      if (it.size.h !== correctH) {
        it.size.h = correctH;
        changed = true;
      }
    }
    if (changed) {
      host.saveWithoutUndo();
      host.requestRender();
    }
  }
  // Link preview-image dimensions, cached per URL, and the
  // URLs with a load in flight. An image is measured once
  // per URL, not once per render. The image is remote, so it
  // loads from its own URL (not the board-local file URL);
  // reading its natural size needs no CORS.
  const linkImageSize = new Map<string, { w: number; h: number }>();
  const linkImageLoading = new Set<string>();
  // Heal a UrlCard saved at the stale fixed size: a preview
  // image used to make the card 320x300 whatever the image,
  // so a wide banner sat in a tall card. When the preview
  // image loads, measure it; if the card is still at
  // 320x300, resize it to the ratio of the image and save
  // (no undo step — this is a heal, not an action). A card
  // the user resized by hand is left alone: its size will
  // not match 320x300. Called from the UrlCard renderer,
  // like loadFileCardSize.
  function loadLinkCardSize(image: string): void {
    const cached = linkImageSize.get(image);
    if (cached) {
      healLinkCardsWithImage(image, cached.w, cached.h);
      return;
    }
    if (linkImageLoading.has(image)) return;
    linkImageLoading.add(image);
    const img = new Image();
    img.onload = () => {
      linkImageLoading.delete(image);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        linkImageSize.set(image, { w: img.naturalWidth, h: img.naturalHeight });
        healLinkCardsWithImage(image, img.naturalWidth, img.naturalHeight);
      }
    };
    img.onerror = () => {
      linkImageLoading.delete(image);
      // An image that cannot load leaves the card alone.
    };
    img.src = image;
  }
  // Resize every UrlCard using this preview image that is
  // still at the stale fixed size to the ratio of the image.
  function healLinkCardsWithImage(image: string, imgW: number, imgH: number): void {
    let changed = false;
    for (const it of host.getBoard().items) {
      if (!("UrlCard" in it.kind) || it.kind.UrlCard.image !== image) continue;
      if (Math.abs(it.size.w - 320) > 2 || Math.abs(it.size.h - 300) > 2) continue;
      const correctH = linkCardHeightForWidth(imgW, imgH, it.size.w);
      if (it.size.h !== correctH) {
        it.size.h = correctH;
        changed = true;
      }
    }
    if (changed) {
      host.saveWithoutUndo();
      host.requestRender();
    }
  }
  function toggleAudio(id: number, path: string): void {
    if (audioId === id && audioEl && !audioEl.paused) {
      audioEl.pause();
      host.requestRender();
      return;
    }
    if (audioId === id && audioEl) {
      // Paused, possibly after a waveform seek: resume
      // this same element instead of starting a new one
      // from the top.
      audioEl.play().catch((err) => {
        audioId = null;
        host.toast(`Could not play audio: ${String(err)}`);
        host.requestRender();
      });
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
      if (audioEl) applyPendingSeek(audioEl, id);
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
    audioPeaks.clear();
    fileCardPreviewSize.clear();
    fileCardPreviewLoading.clear();
    pendingSeek = null;
    pdfSearchText.clear();
    pdfSearchIndexing.clear();
    pdfPages.clear();
    // A video playing on the outgoing board must not stay
    // the live card on the incoming one.
    videoId = null;
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
    loadFileCardSize,
    loadVideoCardSize,
    probePdfSize,
    loadPdfCardSize,
    loadLinkCardSize,
    loadAudioDuration,
    getAudioPeaks,
    loadAudioPeaks,
    seekAudioTo,
    updateAudioProgress,
    formatAudioTime,
    toggleAudio,
    stopAudio,
    getAudioState,
    playVideo,
    getVideoState,
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
