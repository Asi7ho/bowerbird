// Search: the MiniSearch index over the board's text, and the
// local-ML context index (CLIP embeddings for images and video
// frames, AST labels for audio) that lets a query match media
// by what is in it, not only its filename. No cloud, no API key:
// the models run in the main process (see electron/context.js).
// The module owns the match state and the debounced input
// listeners; the core supplies the board, the cards layer, and
// the jump behaviour (select + centre + save + render) through
// the context, because those touch core state.
import { api } from "./api";
import { shapeLabel } from "./cards";
import type { Media } from "./media";
import { boardGet, escapeHtml, type Board, type Item } from "./model";
import MiniSearch from "minisearch";
import { getPluginCardSearchText } from "./plugins";

export interface SearchContext {
  getBoard(): Board;
  getBoardGeneration(): number;
  getBoardSearchVersion(): number;
  media: Media;
  // The cards layer, read lazily: the board DOM is built by
  // the core-board plugin, so the cards element does not
  // exist when the search engine is created at module load.
  // A getter reads the current element, after the plugin
  // has built it.
  getCardsEl: () => HTMLDivElement;
  onJumpTo(target: Item): void;
}

// The search box elements, built by the core-search plugin.
// The engine operates on the elements the plugin provides —
// it never queries the search box by id, so the box can be
// built by any plugin. The engine keeps the search logic
// (matching, dimming, results, keyboard), operating on
// these elements; a future step can move the results
// rendering into the plugin itself.
export interface SearchElements {
  input: HTMLInputElement;
  count: HTMLElement;
  clear: HTMLButtonElement;
  results: HTMLElement;
}

export interface BoardSearch {
  // Hand the engine the search box elements, built by the
  // core-search plugin. Attaches the input and keyboard
  // listeners. Until this is called, the search engine has
  // no box to operate on.
  setSearchElements(els: SearchElements): void;
  updateSearch(): void;
  clearSearch(): void;
  jumpToSearchIndex(idx: number): void;
  loadContextIndex(): Promise<void>;
  flushContextIndex(sync?: boolean): void;
  cancelContextIndexSave(): void;
  clearBoardCaches(): void;
  reset(): void;
}

export function createBoardSearch(ctx: SearchContext): BoardSearch {
  // Search: matches are board item ids in board order, in the same
  // spirit as Tab navigation (strokes and connectors are skipped:
  // they carry no searchable text). searchIndex is -1 until the user
  // presses Enter, so typing only highlights and counts — it does
  // not yank the camera on every keystroke.
  let searchMatches: number[] = [];
  let searchIndex = -1;
  // The search box elements, provided by the core-search
  // plugin (see setSearchElements). The engine never queries
  // the search box by id.
  let ui: SearchElements | null = null;
  // ---------------------------------------------------------------- context search
  // Local ML index, keyed by media path, persisted next to
  // the board in context-index.json so a board that is
  // already indexed does not re-run the models.
  // - Image: one CLIP embedding (512 floats).
  // - Video: CLIP embeddings of sampled frames, plus audio
  //   labels if the video file decodes as audio.
  // - Audio: AST labels, e.g. "Bird vocalization, bird
  //   call, bird song" — searching "bird" matches them.
  // Indexing runs in parallel (up to 4 items at once, so
  // CLIP and AST load together instead of one after the
  // other), and the index is preloaded at board load, so
  // a search never pays the index-load cost. Until an item
  // is indexed, search falls back to its filename and
  // type, as before. The search count only ever says
  // "Indexing" while unindexed media is actually being
  // indexed — never on a search where everything is
  // already indexed, which was the old misleading status.
  // Query embeddings are also persisted (as __query:
  // entries in the same file), so a repeated word after
  // restart does not need the CLIP model at all.
  type ContextEntry = { embedding?: number[]; frames?: number[][]; labels?: string[] };
  const contextIndex = new Map<string, ContextEntry>();
  let contextIndexLoaded = false;
  let contextIndexing = false;
  let contextIndexTotal = 0;
  let contextIndexDone = 0;
  let contextIndexFailed = false;
  let contextQueryEmbedding: { query: string; embedding: number[] } | null = null;
  const contextQueryCache = new Map<string, number[]>();
  async function loadContextIndex(): Promise<void> {
    if (contextIndexLoaded) return;
    contextIndexLoaded = true;
    try {
      const raw = await api.contextIndexLoad();
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("__query:")) {
          const e = v as ContextEntry;
          if (e && Array.isArray(e.embedding)) contextQueryCache.set(k.slice("__query:".length), e.embedding);
          continue;
        }
        const e = v as ContextEntry;
        if (e && (Array.isArray(e.embedding) || Array.isArray(e.frames) || Array.isArray(e.labels))) contextIndex.set(k, e);
      }
    } catch { /* no saved index yet */ }
  }
  // Context-index saves used to rewrite the whole index
  // (every 512-float CLIP embedding) after every single
  // indexed item, and on every new query word — O(N^2)
  // bytes for a media-heavy board, each write blocking
  // the main process. Now saves are debounced to 1s, and
  // flushed at batch end and before a board switch; the
  // in-memory maps are the source of truth during the
  // session, so a delayed write loses nothing.
  let contextIndexSaveTimer: ReturnType<typeof setTimeout> | undefined;
  function doSaveContextIndex(): void {
    const obj: Record<string, ContextEntry> = {};
    for (const [k, v] of contextIndex.entries()) obj[k] = v;
    for (const [q, embedding] of contextQueryCache.entries()) obj[`__query:${q}`] = { embedding };
    void api.contextIndexSave(obj).catch(() => undefined);
  }
  function saveContextIndex(): void {
    if (contextIndexSaveTimer) return;
    contextIndexSaveTimer = setTimeout(() => { contextIndexSaveTimer = undefined; doSaveContextIndex(); }, 1000);
  }
  function flushContextIndex(sync = false): void {
    if (!contextIndexSaveTimer) return;
    clearTimeout(contextIndexSaveTimer);
    contextIndexSaveTimer = undefined;
    // On unload the async save may not complete before
    // the window closes, losing a just-indexed batch:
    // use the synchronous channel there. Every other
    // flush stays async and non-blocking.
    if (sync) {
      const obj: Record<string, ContextEntry> = {};
      for (const [k, v] of contextIndex.entries()) obj[k] = v;
      for (const [q, embedding] of contextQueryCache.entries()) obj[`__query:${q}`] = { embedding };
      try { api.contextIndexSaveSync(obj); } catch { /* the async save already ran, or the index is lost */ }
      return;
    }
    doSaveContextIndex();
  }
  function cancelContextIndexSave(): void {
    if (!contextIndexSaveTimer) return;
    clearTimeout(contextIndexSaveTimer);
    contextIndexSaveTimer = undefined;
  }
  window.addEventListener("beforeunload", () => { flushContextIndex(true); });
  async function getQueryEmbedding(query: string): Promise<number[] | null> {
    if (contextQueryEmbedding && contextQueryEmbedding.query === query) return contextQueryEmbedding.embedding;
    const cached = contextQueryCache.get(query);
    if (cached) {
      contextQueryEmbedding = { query, embedding: cached };
      return cached;
    }
    try {
      const embedding = await api.contextEmbedText(`a photo of ${query}`);
      contextQueryEmbedding = { query, embedding };
      contextQueryCache.set(query, embedding);
      saveContextIndex();
      return embedding;
    } catch { return null; }
  }
  function cosineSim(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  async function decodeAudio16k(fileUrl: string): Promise<Float32Array | null> {
    try {
      const res = await fetch(fileUrl);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const ctx = new AudioContext();
      try {
        const decoded = await ctx.decodeAudioData(buf);
        const targetRate = 16000;
        // AST's input window is 10 seconds, so render only
        // the first 10 seconds: the old code rendered the
        // whole file at 16 kHz (an hour of audio is ~58M
        // samples) and then threw all but the first 10 s
        // away. Decoding still reads the whole file —
        // slicing compressed bytes before decode is
        // unreliable — but the render, the expensive part,
        // is now capped.
        const renderSeconds = Math.min(decoded.duration, 10);
        const offline = new OfflineAudioContext(1, Math.ceil(renderSeconds * targetRate), targetRate);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start();
        const rendered = await offline.startRendering();
        const data = rendered.getChannelData(0);
        const maxSamples = targetRate * 10;
        return data.length > maxSamples ? data.slice(0, maxSamples) : data;
      } finally {
        void ctx.close().catch(() => undefined);
      }
    } catch { return null; }
  }
  async function captureVideoFrames(source: string): Promise<string[]> {
    const urls: string[] = [];
    try {
      const video = document.createElement("video");
      video.src = api.fileUrl(source);
      video.muted = true;
      video.preload = "auto";
      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => resolve();
        setTimeout(resolve, 5000);
      });
      if (!isFinite(video.duration) || video.duration <= 0) return urls;
      const times = [Math.min(1, video.duration * 0.25), video.duration * 0.5, video.duration * 0.75];
      const canvas = document.createElement("canvas");
      canvas.width = 224; canvas.height = 224;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return urls;
      for (const t of times) {
        try {
          video.currentTime = t;
          await new Promise<void>((resolve) => {
            video.onseeked = () => resolve();
            setTimeout(resolve, 2000);
          });
          ctx2d.drawImage(video, 0, 0, 224, 224);
          urls.push(canvas.toDataURL("image/jpeg", 0.8));
        } catch { /* skip this frame */ }
      }
    } catch { /* video frames are a bonus, not a failure */ }
    return urls;
  }
  async function indexContextItem(item: Item): Promise<void> {
    const k = item.kind;
    try {
      if ("Image" in k) {
        if (contextIndex.get(k.Image.path)?.embedding) return;
        const embedding = await api.contextEmbedImage(k.Image.path);
        contextIndex.set(k.Image.path, { embedding });
      } else if ("Audio" in k) {
        if (contextIndex.get(k.Audio.path)?.labels) return;
        const pcm = await decodeAudio16k(api.fileUrl(k.Audio.path));
        if (!pcm) return;
        const out = await api.contextClassifyAudio(pcm);
        const labels = out.map((o) => o.label.toLowerCase());
        contextIndex.set(k.Audio.path, { labels });
      } else if ("Video" in k && !k.Video.remote) {
        const existing = contextIndex.get(k.Video.source);
        if (existing?.frames) return;
        const frameUrls = await captureVideoFrames(k.Video.source);
        const frames: number[][] = (await Promise.all(frameUrls.map(async (url) => {
          try { return await api.contextEmbedFrame(url); } catch { return null; }
        }))).filter((f): f is number[] => f !== null);
        const labels: string[] = [];
        const pcm = await decodeAudio16k(api.fileUrl(k.Video.source));
        if (pcm) {
          try {
            const out = await api.contextClassifyAudio(pcm);
            labels.push(...out.map((o) => o.label.toLowerCase()));
          } catch { /* visual frames alone are enough */ }
        }
        if (frames.length > 0 || labels.length > 0) contextIndex.set(k.Video.source, { frames, labels });
      } else {
        return;
      }
      saveContextIndex();
    } catch {
      // One failed item must not stop the rest, and must
      // not break ordinary search — but it must be visible,
      // otherwise context search silently does nothing (e.g.
      // sharp's install script was skipped on a Mac, so
      // image indexing fails on every item).
      contextIndexFailed = true;
    }
  }
  function hasUnindexedMedia(): boolean {
    return ctx.getBoard().items.some((it) => {
      if ("Image" in it.kind) return !contextIndex.get(it.kind.Image.path)?.embedding;
      if ("Audio" in it.kind) return !contextIndex.get(it.kind.Audio.path)?.labels;
      if ("Video" in it.kind && !it.kind.Video.remote) {
        const e = contextIndex.get(it.kind.Video.source);
        return !(e?.frames || e?.labels);
      }
      return false;
    });
  }
  async function startContextIndexing(): Promise<void> {
    if (contextIndexing) return;
    await loadContextIndex();
    // Only ever show "Indexing" when there is actually
    // unindexed ctx.media. Previously this flag was set on
    // every search, before the already-indexed check, so
    // every search flashed "Indexing context…" even
    // though nothing was being indexed — which is why
    // it looked like it reindexed all the time.
    if (!hasUnindexedMedia()) return;
    contextIndexing = true;
    // Refresh the count now that indexing is really
    // running, so the status appears during the model
    // load itself, not only after the first item lands.
    {
      const input = ui?.input ?? null;
      if (input && input.value.trim() !== "") updateSearch();
    }
    contextIndexFailed = false;
    const isUnindexed = (it: Item): boolean => {
      const k = it.kind;
      if ("Image" in k) return !contextIndex.get(k.Image.path)?.embedding;
      if ("Audio" in k) return !contextIndex.get(k.Audio.path)?.labels;
      if ("Video" in k && !k.Video.remote) {
        const e = contextIndex.get(k.Video.source);
        return !(e?.frames || e?.labels);
      }
      return false;
    };
    const items = ctx.getBoard().items.filter(isUnindexed);
    contextIndexTotal = items.length;
    contextIndexDone = 0;
    // Parallel, capped at 4 at once: CLIP and AST load
    // together, and image/audio/video decoding overlaps,
    // instead of everything queuing behind one model
    // load. For the 3-item welcome board this is roughly
    // the slowest single item, not the sum of all three.
    let next = 0;
    const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const it = items[next++];
        try { await indexContextItem(it); } catch { contextIndexFailed = true; }
        contextIndexDone++;
        const input = ui?.input ?? null;
        if (input && input.value.trim() !== "") updateSearch();
      }
    });
    await Promise.all(workers);
    contextIndexing = false;
    indexingDonePromise = null;
    flushContextIndex();
    const input = ui?.input ?? null;
    if (input && input.value.trim() !== "") updateSearch();
  }
  // One shared waiter for indexing finishing, instead of a
  // polling loop per search: updateSearch runs at the end of
  // every render while a query is active, and each call used
  // to spawn its own `while (contextIndexing) sleep(200)`
  // loop, so the loops accumulated for as long as indexing
  // ran. Every waiter still checks its own generation after
  // the shared wait, so a stale query still discards its
  // own context results.
  let indexingDonePromise: Promise<void> | null = null;
  function waitForIndexing(): Promise<void> {
    if (!contextIndexing) return Promise.resolve();
    if (!indexingDonePromise) {
      indexingDonePromise = (async () => {
        while (contextIndexing) await new Promise((r) => setTimeout(r, 200));
      })();
    }
    return indexingDonePromise;
  }
  async function contextMatches(item: Item, query: string, words: string[]): Promise<boolean> {
    const k = item.kind;
    if ("Image" in k) {
      const e = contextIndex.get(k.Image.path)?.embedding;
      if (!e) return false;
      const qe = await getQueryEmbedding(query);
      if (!qe) return false;
      return cosineSim(e, qe) >= 0.23;
    }
    if ("Video" in k && !k.Video.remote) {
      const entry = contextIndex.get(k.Video.source);
      if (entry?.labels && words.every((w) => entry.labels!.join(" ").includes(w))) return true;
      if (!entry?.frames || entry.frames.length === 0) return false;
      const qe = await getQueryEmbedding(query);
      if (!qe) return false;
      return entry.frames.some((f) => cosineSim(f, qe) >= 0.23);
    }
    if ("Audio" in k) {
      const labels = contextIndex.get(k.Audio.path)?.labels;
      if (!labels) return false;
      const joined = labels.join(" ");
      return words.every((w) => joined.includes(w));
    }
    return false;
  }

  // ---------------------------------------------------------------- search

  // Search normalisation: separators become spaces, so
  // "welcome bower" matches "welcome-bower.jpg", and a
  // query is split into words that must all match (AND),
  // so "bird song" finds the bird audio, not everything
  // containing either word.
  // Colour names: a swatch's hex is expanded to its plain
  // colour name, so "blue" finds #007AFF and "orange"
  // finds the orange swatch, not just a hex string.
  // Type words: every kind carries its plain type words,
  // so "image", "audio", "video", "pdf", "link", "text"
  // and "color" find all cards of that kind, not just
  // cards whose filename happens to contain the word.
  function normaliseSearch(s: string): string {
    // Diacritics first (café -> cafe, like Omnisearch),
    // then separators become spaces.
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function colorNameForHex(hex: string): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return "";
    const r = parseInt(m[1].slice(0, 2), 16) / 255;
    const g = parseInt(m[1].slice(2, 4), 16) / 255;
    const b = parseInt(m[1].slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const s = max === min ? 0 : l < 0.5 ? (max - min) / (max + min) : (max - min) / (2 - max - min);
    if (l < 0.15) return "black";
    if (l > 0.92) return "white";
    if (s < 0.15) return "grey gray";
    let h = 0;
    if (max === r) h = ((g - b) / (max - min) + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / (max - min) + 2) * 60;
    else h = ((r - g) / (max - min) + 4) * 60;
    if (h >= 345 || h < 12) return l < 0.45 ? "red brown" : "red pink";
    if (h < 45) return l < 0.55 && s > 0.3 ? "orange brown" : "orange";
    if (h < 70) return "yellow";
    if (h < 160) return "green";
    if (h < 200) return "cyan teal blue";
    if (h < 260) return "blue";
    if (h < 300) return "purple violet";
    if (h < 330) return "pink purple";
    return "pink red";
  }
  // ---------------------------------------------------------------- Omnisearch-style search
  // Omnisearch (Obsidian) is MiniSearch with BM25 scoring:
  // filename boosted over headings over body, typo-tolerant
  // fuzzy matching, prefix matching, results as you type in
  // a ranked list with excerpts, keyboard-first, and a query
  // language of "exact phrases", -exclusions and .ext filters.
  // Bowerbird uses the same engine (MiniSearch, zero
  // dependencies) with the same weights, and maps Obsidian's
  // fields onto cards: filename -> card title/filename,
  // headings -> text-card headings, body -> card text, PDF
  // text, link description, colour name, and audio labels.
  // What does not map: Obsidian's path: filter (a board
  // has no folders), backlinks, and in-file search (cards
  // are short; jumping to the card is the in-file view).
  type SearchDoc = { id: number; title: string; headings: string; body: string; typeLabel: string; excerptText: string; ext: string };
  function searchDoc(item: Item): SearchDoc | null {
    const k = item.kind;
    const fileName = (p: string) => p.split("/").pop() ?? p;
    const extOf = (p: string) => { const n = fileName(p); return n.includes(".") ? (n.split(".").pop() ?? "").toLowerCase() : ""; };
    const labels = (p: string) => contextIndex.get(p)?.labels ?? [];
    if ("Text" in k) {
      const lines = k.Text.text.split("\n");
      const headings = lines.filter((l) => l.trim().startsWith("#")).map((l) => l.replace(/^#+\s*/, "")).join(" ");
      const title = lines.map((l) => l.trim()).find((l) => l !== "")?.replace(/^#+\s*/, "") ?? "Note";
      const excerptText = lines.map((l) => l.replace(/^#+\s*/, "")).join("\n");
      const bgName = k.Text.bg && k.Text.bg.toUpperCase() !== "#FFFFFF" ? colorNameForHex(k.Text.bg) : "";
      return { id: item.id, title, headings, body: `${k.Text.text} ${bgName}`, typeLabel: "Note", excerptText, ext: "md" };
    }
    if ("Shape" in k) {
      const name = colorNameForHex(k.Shape.fill).split(" ")[0];
      const label = shapeLabel(k.Shape.shape);
      return { id: item.id, title: `${name} ${label}`, headings: "", body: `${k.Shape.shape} ${label} shape ${k.Shape.fill} ${colorNameForHex(k.Shape.fill)} color colour`, typeLabel: "Shape", excerptText: `${name} ${label}`, ext: "" };
    }
    if ("UrlCard" in k) {
      let domain = "";
      try { domain = new URL(k.UrlCard.url).hostname.replace(/^www\./, ""); } catch { /* keep empty */ }
      const title = k.UrlCard.title ?? domain ?? k.UrlCard.url;
      // Excerpt is the description only: the title is
      // already the row's title, so repeating it in the
      // excerpt would duplicate the first line.
      return { id: item.id, title, headings: "", body: [k.UrlCard.title ?? "", k.UrlCard.description ?? "", k.UrlCard.url, domain, "link"].join(" "), typeLabel: "Link", excerptText: k.UrlCard.description ?? "", ext: "" };
    }
    if ("Image" in k) return { id: item.id, title: fileName(k.Image.path), headings: "", body: `${fileName(k.Image.path)} image picture photo`, typeLabel: "Image", excerptText: fileName(k.Image.path), ext: extOf(k.Image.path) };
    if ("PdfCard" in k) {
      ctx.media.indexPdfForSearch(k.PdfCard.path);
      const pdfText = ctx.media.pdfSearchText.get(k.PdfCard.path) ?? "";
      return { id: item.id, title: fileName(k.PdfCard.path), headings: "", body: `${fileName(k.PdfCard.path)} pdf document ${pdfText}`, typeLabel: "PDF", excerptText: pdfText || fileName(k.PdfCard.path), ext: "pdf" };
    }
    if ("Audio" in k) {
      const lab = labels(k.Audio.path).join(" ");
      return { id: item.id, title: fileName(k.Audio.path), headings: "", body: `${fileName(k.Audio.path)} audio sound music ${lab}`, typeLabel: "Audio", excerptText: lab, ext: extOf(k.Audio.path) };
    }
    if ("Video" in k) {
      if (k.Video.remote) return { id: item.id, title: k.Video.source, headings: "", body: `${k.Video.source} video remote link`, typeLabel: "Video", excerptText: "", ext: "" };
      const lab = labels(k.Video.source).join(" ");
      return { id: item.id, title: fileName(k.Video.source), headings: "", body: `${fileName(k.Video.source)} video ${lab}`, typeLabel: "Video", excerptText: lab, ext: extOf(k.Video.source) };
    }
    if ("Swatch" in k) {
      const name = colorNameForHex(k.Swatch.hex).split(" ")[0];
      return { id: item.id, title: name, headings: "", body: `${k.Swatch.hex} ${colorNameForHex(k.Swatch.hex)} color colour swatch`, typeLabel: "Colour", excerptText: `${name} ${k.Swatch.hex}`, ext: "" };
    }
    if ("Plugin" in k) {
      const pt = getPluginCardSearchText(item);
      return { id: item.id, title: k.Plugin.kind, headings: "", body: pt ?? `${k.Plugin.plugin} ${k.Plugin.kind}`, typeLabel: "Plugin", excerptText: pt ?? k.Plugin.kind, ext: "" };
    }
    return null;
  }
  type ParsedQuery = { terms: string[]; phrases: string[]; exclusions: string[]; exts: string[] };
  function parseSearchQuery(raw: string): ParsedQuery {
    const phrases: string[] = [];
    const exclusions: string[] = [];
    const exts: string[] = [];
    // Excluded phrases first, so -"foo bar" is not read as a phrase.
    let s = raw.replace(/-\s*"([^"]+)"/g, (_m, p) => { exclusions.push(normaliseSearch(p)); return " "; });
    s = s.replace(/"([^"]+)"/g, (_m, p) => { const n = normaliseSearch(p); if (n) phrases.push(n); return " "; });
    s = s.replace(/-\s*([^\s]+)/g, (_m, t) => { const n = normaliseSearch(t); if (n) exclusions.push(n); return " "; });
    s = s.replace(/(^|\s)\.(jpg|jpeg|png|gif|webp|mp3|wav|mp4|mov|pdf|md)\b/gi, (_m, _sp, e) => { exts.push(e.toLowerCase()); return " "; });
    const terms = normaliseSearch(s).split(" ").filter((w) => w !== "");
    return { terms, phrases: phrases.filter(Boolean), exclusions: exclusions.filter(Boolean), exts };
  }
  function splitCamel(s: string): string {
    // Omnisearch's tokenizer splits CamelCase: Bowerbird
    // becomes Bower + bird, so "bird" finds it. Keep the
    // full word too, so "bowerbird" still matches.
    return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  }
  function docPassesFilters(doc: SearchDoc, q: ParsedQuery): boolean {
    if (q.exts.length > 0 && !q.exts.includes(doc.ext)) return false;
    const hay = normaliseSearch([doc.title, doc.headings, doc.body, splitCamel(doc.title), splitCamel(doc.headings), splitCamel(doc.body)].join(" "));
    for (const p of q.phrases) if (!hay.includes(p)) return false;
    for (const e of q.exclusions) {
      // Exclusion is prefix-based for single words: -bird
      // removes birdsong, but keeps Bowerbird (bird is
      // not at the start of that word). Phrases exclude
      // on an exact substring, as they are quoted.
      if (e.includes(" ")) { if (hay.includes(e)) return false; }
      else if (hay.split(" ").some((w) => w.startsWith(e))) return false;
    }
    return true;
  }
  let searchDocsCache: { version: number; docs: SearchDoc[]; ms: MiniSearch<SearchDoc> } | null = null;
  function buildMiniSearch(docs: SearchDoc[]): MiniSearch<SearchDoc> {
    const ms = new MiniSearch<SearchDoc>({
      fields: ["title", "headings", "body"],
      storeFields: ["id"],
      searchOptions: { boost: { title: 3, headings: 2, body: 1 }, fuzzy: 0.2, prefix: true, combineWith: "AND" },
    });
    // Feed MiniSearch already-normalised text, so its
    // tokenizer sees the same diacritic-free words the
    // rest of Bowerbird search uses, plus CamelCase splits.
    ms.addAll(docs.map((d) => ({
      ...d,
      title: normaliseSearch(`${d.title} ${splitCamel(d.title)}`),
      headings: normaliseSearch(`${d.headings} ${splitCamel(d.headings)}`),
      body: normaliseSearch(`${d.body} ${splitCamel(d.body)}`),
    })));
    return ms;
  }
  function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  // Excerpt: ~40 chars before the first matched term, ~80
  // after, with matched terms in <strong>. Diacritics are
  // stripped for finding the position, but the snippet
  // itself is cut from the original text.
  function excerptFor(doc: SearchDoc, matchedTerms: string[]): string {
    const text = doc.excerptText;
    if (!text) return doc.title;
    const stripped = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    let pos = -1;
    for (const t of matchedTerms) {
      const p = stripped.indexOf(t.toLowerCase());
      if (p >= 0 && (pos === -1 || p < pos)) pos = p;
    }
    const start = pos === -1 ? 0 : Math.max(0, pos - 40);
    const end = pos === -1 ? Math.min(text.length, 120) : Math.min(text.length, pos + 80);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = "…" + snippet;
    if (end < text.length) snippet = snippet + "…";
    let html = escapeHtml(snippet);
    const terms = [...new Set(matchedTerms.filter(Boolean))].sort((a, b) => b.length - a.length);
    if (terms.length > 0) {
      const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
      html = html.replace(re, "<strong>$1</strong>");
    }
    return html;
  }
  type SearchRow = { id: number; title: string; typeLabel: string; excerptHtml: string; isContext: boolean };
  let searchRows: SearchRow[] = [];
  let searchResultsOpen = false;
  function renderSearchResults(): void {
    const box = ui?.results ?? null;
    if (!box) return;
    if (!searchResultsOpen || searchRows.length === 0) { box.style.display = "none"; box.innerHTML = ""; return; }
    box.style.display = "block";
    box.innerHTML = searchRows.slice(0, 30).map((r, i) => {
      const sel = i === searchIndex ? " search-result-selected" : "";
      // No excerpt line when it would just repeat the
      // title (a filename-only image, a link with no
      // description, a video with no labels): a row with
      // the same text twice reads like a bug, not a result.
      const plain = r.excerptHtml.replace(/<[^>]+>/g, "").trim();
      const excerpt = plain && plain !== r.title ? `<div class="search-result-excerpt">${r.excerptHtml}</div>` : "";
      return `<div class="search-result${sel}" data-id="${r.id}" data-index="${i}"><div class="search-result-top"><span class="search-result-type">${escapeHtml(r.typeLabel)}${r.isContext ? " · Visual" : ""}</span><span class="search-result-title">${escapeHtml(r.title)}</span></div>${excerpt}</div>`;
    }).join("");
    const selected = box.querySelector(".search-result-selected") as HTMLElement | null;
    selected?.scrollIntoView({ block: "nearest" });
  }
  function closeSearchResults(): void {
    searchResultsOpen = false;
    renderSearchResults();
  }

  let searchGeneration = 0;
  function applySearchMatches(countEl: HTMLElement): void {
    if (searchIndex >= searchMatches.length) searchIndex = -1;
    const matchSet = new Set(searchMatches);
    for (const child of Array.from(ctx.getCardsEl().children)) {
      const el = child as HTMLElement;
      const id = Number(el.dataset.id);
      el.classList.toggle("search-match", matchSet.has(id));
      el.classList.toggle("search-dim", !matchSet.has(id));
    }
    let text = "";
    if (searchMatches.length === 0) text = "No matches";
    // While the results list is open, the selection is
    // just the top result, not a jump — show the count,
    // not "1 of N". After a jump (list closed), show position.
    else if (searchIndex >= 0 && !searchResultsOpen) text = `${searchIndex + 1} of ${searchMatches.length}`;
    else text = searchMatches.length === 1 ? "1 match" : `${searchMatches.length} matches`;
    if (contextIndexing) text += contextIndexTotal > 0 ? ` · Indexing context ${contextIndexDone}/${contextIndexTotal}` : " · Indexing context…";
    else if (contextIndexFailed) text += " · Context unavailable";
    countEl.textContent = text;
  }
  function updateSearch(): void {
    const input = ui?.input ?? null;
    const countEl = ui?.count ?? null;
    const clearEl = ui?.clear ?? null;
    if (!input || !countEl || !clearEl) return;
    const raw = input.value;
    const query = normaliseSearch(raw);
    clearEl.style.visibility = query === "" ? "hidden" : "visible";
    if (query === "") {
      const hadMatches = searchMatches.length > 0;
      searchMatches = [];
      searchRows = [];
      searchIndex = -1;
      closeSearchResults();
      countEl.textContent = "";
      if (!hadMatches) return;
      for (const child of Array.from(ctx.getCardsEl().children)) {
        (child as HTMLElement).classList.remove("search-match", "search-dim");
      }
      return;
    }
    const parsed = parseSearchQuery(raw);
    let docs: SearchDoc[];
    let ms: MiniSearch<SearchDoc>;
    if (searchDocsCache && searchDocsCache.version === ctx.getBoardSearchVersion()) {
      docs = searchDocsCache.docs;
      ms = searchDocsCache.ms;
    } else {
      docs = ctx.getBoard().items.map(searchDoc).filter((d): d is SearchDoc => d !== null);
      ms = buildMiniSearch(docs);
      searchDocsCache = { version: ctx.getBoardSearchVersion(), docs, ms };
    }
    const byId = new Map(docs.map((d) => [d.id, d]));
    let results: { id: number; terms: string[] }[];
    if (parsed.terms.length === 0) {
      // Phrase / filter only: no BM25 terms, so rank by
      // board order among cards passing the filters.
      results = docs.filter((d) => docPassesFilters(d, parsed)).map((d) => ({ id: d.id, terms: parsed.phrases.flatMap((p) => p.split(" ")) }));
    } else {
      results = ms.search(parsed.terms.join(" "))
        .map((r) => ({ id: Number(r.id), terms: r.terms }))
        .filter((r) => { const d = byId.get(r.id); return d ? docPassesFilters(d, parsed) : false; });
    }
    searchMatches = results.map((r) => r.id);
    // Excerpts are only ever shown for the first 30 rows
    // (renderSearchResults slices there); building them
    // for every match, with a regex per row, was pure
    // waste on a many-match query. Later rows carry the
    // title, which render omits as a duplicate excerpt.
    searchRows = results.map((r, i) => {
      const d = byId.get(r.id)!;
      return { id: r.id, title: d.title, typeLabel: d.typeLabel, excerptHtml: i < 30 ? excerptFor(d, r.terms) : d.title, isContext: false };
    });
    if (searchIndex >= searchMatches.length) searchIndex = searchMatches.length > 0 ? 0 : -1;
    searchResultsOpen = searchMatches.length > 0;
    renderSearchResults();
    applySearchMatches(countEl);
    // Context search, in the background: index media that
    // is not indexed yet, then check the rest of the board
    // against the query's CLIP embedding / audio labels.
    // Results merge in as they arrive; a stale query (the
    // user kept typing) discards its own context results.
    const gen = ++searchGeneration;
    void startContextIndexing();
    applySearchMatches(countEl);
    void (async () => {
      // Wait for indexing to finish, then check context.
      // startContextIndexing is already running above; this
      // waits on the one shared waiter, so a new search
      // (new generation) supersedes this one cleanly.
      await waitForIndexing();
      if (gen !== searchGeneration) return;
      const inputNow = ui?.input ?? null;
      if (!inputNow || normaliseSearch(inputNow.value) !== query) return;
      const extra: number[] = [];
      const contextQuery = [...parsed.terms, ...parsed.phrases].join(" ");
      const matchSet = new Set(searchMatches);
      for (const it of ctx.getBoard().items) {
        if (("Stroke" in it.kind) || ("Connector" in it.kind)) continue;
        if (matchSet.has(it.id)) continue;
        if (await contextMatches(it, contextQuery, parsed.terms)) extra.push(it.id);
      }
      if (gen !== searchGeneration) return;
      if (extra.length > 0) {
        searchMatches = [...searchMatches, ...extra];
        const byId2 = new Map(docs.map((d) => [d.id, d]));
        for (const id of extra) {
          const d = byId2.get(id);
          if (!d) continue;
          searchRows.push({ id, title: d.title, typeLabel: d.typeLabel, excerptHtml: excerptFor(d, parsed.terms), isContext: true });
        }
        if (searchIndex < 0 && searchMatches.length > 0) searchIndex = 0;
        searchResultsOpen = true;
        renderSearchResults();
      }
      // Always refresh the count, even with no extra matches:
      // otherwise the "Indexing context…" text stays stuck
      // after indexing finishes with nothing new to add.
      const countNow = ui?.count ?? null;
      if (countNow) applySearchMatches(countNow);
    })().catch(() => { contextIndexFailed = true; });
  }

  function clearSearch(): void {
    const input = ui?.input ?? null;
    if (input) input.value = "";
    searchMatches = [];
    searchRows = [];
    searchIndex = -1;
    closeSearchResults();
    updateSearch();
  }

  function jumpToSearchIndex(idx: number): void {
    if (searchMatches.length === 0) return;
    searchIndex = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
    const target = boardGet(ctx.getBoard(), searchMatches[searchIndex]);
    if (!target) return;
    ctx.onJumpTo(target);
  }

  // The search box elements, provided by the core-search
  // plugin. Attaches the input and keyboard listeners to
  // them. Called once, when the plugin builds the box.
  function setSearchElements(els: SearchElements): void {
    ui = els;
    // Search input is debounced 150 ms: without it, every
    // keystroke rebuilt the search documents and index.
    // Enter flushes immediately, so it still opens the
    // top result for the text just typed, not a stale one.
    let searchInputTimer: ReturnType<typeof setTimeout> | undefined;
    ui.input.addEventListener("input", () => {
      // A new query selects the top-ranked result, like
      // Omnisearch: Enter opens it, arrows move selection.
      searchIndex = 0;
      if (searchInputTimer) clearTimeout(searchInputTimer);
      searchInputTimer = setTimeout(() => { searchInputTimer = undefined; updateSearch(); }, 150);
    });
    ui.input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // A debounced search may not have run yet for the
        // text just typed: run it now, so Enter opens the
        // top result for that text, not a stale list.
        if (searchInputTimer) { clearTimeout(searchInputTimer); searchInputTimer = undefined; updateSearch(); }
        if (searchResultsOpen) {
          // List open: open the selected result, close list.
          jumpToSearchIndex(e.shiftKey ? searchIndex - 1 : searchIndex);
          closeSearchResults();
          const countEl = ui?.count ?? null;
          if (countEl) applySearchMatches(countEl);
        } else {
          // List closed (after a jump): cycle, as before.
          jumpToSearchIndex(searchIndex + (e.shiftKey ? -1 : 1));
          const countEl = ui?.count ?? null;
          if (countEl) applySearchMatches(countEl);
        }
      } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) {
        // Omnisearch supports Vim Ctrl+j/k as well as arrows.
        e.preventDefault();
        if (searchMatches.length === 0) return;
        searchIndex = (searchIndex + 1) % searchMatches.length;
        renderSearchResults();
      } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) {
        e.preventDefault();
        if (searchMatches.length === 0) return;
        searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
        renderSearchResults();
      } else if (e.key === "Escape") {
        e.preventDefault();
        clearSearch();
        (e.target as HTMLInputElement).blur();
      }
    });
    ui.input.addEventListener("blur", () => {
      // Delay so a mousedown on a result lands first.
      setTimeout(() => closeSearchResults(), 150);
    });
    ui.results.addEventListener("mousedown", (e: MouseEvent) => {
      const row = (e.target as HTMLElement).closest(".search-result") as HTMLElement | null;
      if (!row) return;
      e.preventDefault();
      const idx = Number(row.dataset.index ?? "0");
      jumpToSearchIndex(idx);
      closeSearchResults();
      const countEl = ui?.count ?? null;
      if (countEl) applySearchMatches(countEl);
    });
    ui.clear.addEventListener("click", () => {
      clearSearch();
      ui?.input.focus();
    });
  }

  function clearBoardCaches(): void {
    contextIndex.clear();
    contextIndexLoaded = false;
    contextIndexFailed = false;
    contextQueryCache.clear();
    contextQueryEmbedding = null;
  }

  // A board load resets the match state; the input itself
  // is cleared by the search plugin, which owns the box.
  function reset(): void {
    searchMatches = [];
    searchRows = [];
    searchIndex = -1;
    if (ui) ui.input.value = "";
  }

  return {
    setSearchElements,
    updateSearch,
    clearSearch,
    jumpToSearchIndex,
    loadContextIndex,
    flushContextIndex,
    cancelContextIndexSave,
    clearBoardCaches,
    reset,
  };
}
