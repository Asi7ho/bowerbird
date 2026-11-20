// Drops and pastes: files dropped from the OS or pasted from
// the clipboard, turned into board cards.

import { api } from "./api";
import { isPdfCompatible, renderAiPreview } from "./ai-import";
import type { ImportedItem } from "./import-types";
import { base64ToBytes, fileCardSize, findSourceGroup, groupBBox, translateImportedToAnchor } from "./live-import";
import { boardGet, domainOf, estimateTextHeight, normaliseHex, type Board, type Item, type Kind, type Pt, type Size } from "./model";
import { ensureVideoPoster } from "./poster";
import { parsePsd, renderPsdPreview } from "./psd-import";
import { parseSvgToItems } from "./svg-import";

export interface DropsContext {
  getBoard(): Board;
  allocId(): number;
  allocGroup(): number;
  save(): void;
  saveWithoutUndo(): void;
  requestRender(): void;
  toWorld(s: Pt): Pt;
  toast(msg: string): void;
  syncWatchedSources(): void;
  clearSelection(ids: number[]): void;
}

export interface Drops {
  dropPaths(files: File[], atScreen: Pt): Promise<void>;
  addUrlAt(at: Pt, url: string): Promise<void>;
  refreshLinkPreviews(): Promise<void>;
  // Re-import the group linked to a source file that changed
  // on disk. The group's cards are rebuilt from the file and
  // land where the group currently is; a deleted source
  // unlinks the group and keeps its cards.
  refreshSource(path: string, stat: { exists: boolean; size: number; mtimeMs: number }): Promise<void>;
}

export function createDrops(ctx: DropsContext): Drops {
  // ---------------------------------------------------------------- drops

  // Stored files (pdf, audio, video, model3d) all embed as
  // bytes, then land as a card at the drop point. The image
  // branch genuinely differs — it loads the image for its
  // natural size — so it stays separate.
  const STORED_KINDS: Record<string, { size: Size; needsSize: boolean; kind: (stored: string, size: number) => Kind }> = {
    // Tall enough to show a page, not just a tile: the
    // page preview needs height, and a user can still
    // resize it smaller, where it falls back to a row.
    pdf: { size: { w: 260, h: 360 }, needsSize: true, kind: (stored, size) => ({ PdfCard: { path: stored, size_bytes: size } }) },
    audio: { size: { w: 300, h: 104 }, needsSize: false, kind: (stored) => ({ Audio: { path: stored } }) },
    video: { size: { w: 360, h: 264 }, needsSize: true, kind: (stored, size) => ({ Video: { source: stored, remote: false, size_bytes: size } }) },
    // Wide enough for the viewport plus the title row
    // below it (the canvas takes the height above it).
    model3d: { size: { w: 360, h: 300 }, needsSize: true, kind: (stored, size) => ({ Model3D: { path: stored, size_bytes: size } }) },
  };

  function dropKindForExt(ext: string): string {
    const e = ext.toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(e)) return "image";
    // SVG is parsed into cards (shapes, strokes, text),
    // not landed as one image — see the svg branch below.
    if (e === "svg") return "svg";
    if (e === "psd") return "psd";
    if (e === "ai") return "ai";
    if (e === "pdf") return "pdf";
    if (["mp3", "wav", "flac", "ogg", "m4a"].includes(e)) return "audio";
    if (["mp4", "mov", "webm", "mkv", "avi", "m4v"].includes(e)) return "video";
    // GLB only: a .gltf references external buffers and
    // textures that would not be embedded with it, so it
    // stays unknown rather than landing as a broken card.
    if (e === "glb") return "model3d";
    if (["txt", "md"].includes(e)) return "text";
    if (["url", "webloc"].includes(e)) return "shortcut";
    return "unknown";
  }

  function extractShortcutUrl(content: string): string | null {
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (t.startsWith("URL=")) {
        const url = t.slice(4).trim();
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
      }
    }
    for (const needle of ["https://", "http://"]) {
      const pos = content.indexOf(needle);
      if (pos !== -1) {
        const rest = content.slice(pos);
        const end = rest.search(/[\s<"']/);
        const url = end === -1 ? rest : rest.slice(0, end);
        if (url.length > needle.length + 1) return url;
      }
    }
    return null;
  }

  async function addUrlAt(at: Pt, url: string): Promise<void> {
    const isVideo = (() => {
      const host = domainOf(url.toLowerCase());
      if (["youtube.com", "youtu.be", "vimeo.com"].includes(host)) return true;
      const path = url.toLowerCase().split("?")[0].split("#")[0];
      return ["mp4", "mov", "webm", "mkv", "avi", "m4v"].some((ext) => path.endsWith("." + ext));
    })();
    if (isVideo) {
      const id = ctx.allocId();
      ctx.getBoard().items.push({ id, pos: at, size: { w: 360, h: 264 }, group: null, kind: { Video: { source: url, remote: true, size_bytes: 0 } } });
      ctx.save(); ctx.requestRender();
      return;
    }
    const id = ctx.allocId();
    ctx.getBoard().items.push({ id, pos: at, size: { w: 320, h: 132 }, group: null, kind: { UrlCard: { url: url.trim(), title: null, description: null, image: null, icon: null } } });
    ctx.save(); ctx.requestRender();
    try {
      const preview = await api.fetchPreview(url);
      const it = boardGet(ctx.getBoard(), id);
      // The board may have switched while the preview
      // fetched: only fill in a link card for the same
      // URL on this board.
      if (it && "UrlCard" in it.kind && it.kind.UrlCard.url === url.trim()) {
        it.kind.UrlCard.title = preview.title;
        it.kind.UrlCard.description = preview.description;
        it.kind.UrlCard.image = preview.image;
        it.kind.UrlCard.icon = preview.icon;
        // A preview image makes the card taller: banner on top, text below.
        if (preview.image) it.size = { w: 320, h: 300 };
        // A preview fill is background work, not a user change: it
        // must not become its own undo step (see saveWithoutUndo).
        ctx.saveWithoutUndo(); ctx.requestRender();
      }
    } catch { /* domain-only card is fine */ }
  }

  // Capture a dropped video's poster frame and duration, and
  // fill them into the card. Background work, not a user
  // change: it saves without an undo step, like a link
  // preview fill. A video whose poster cannot be captured
  // keeps the dark tile.
  async function fillVideoPoster(board: Board, id: number, source: string): Promise<void> {
    const filled = await ensureVideoPoster(source);
    if (!filled) return;
    // The board may have switched while the frame was
    // captured: only fill the same video on the same board.
    if (ctx.getBoard() !== board) return;
    const it = boardGet(board, id);
    if (!it || !("Video" in it.kind) || it.kind.Video.source !== source) return;
    it.kind.Video.poster = filled.poster;
    it.kind.Video.duration = filled.duration;
    ctx.saveWithoutUndo();
    ctx.requestRender();
  }

  // Store an imported item's raster bytes and push it onto
  // the given board. An Image card arrives with a placeholder
  // path; the bytes behind it are embedded here and the
  // path rewritten to the stored copy. Returns false if
  // the board switched mid-import, so the caller stops.
  // Shared by the drop flow and the live re-import, so it
  // takes the board it lands on instead of closing over
  // the drop's.
  async function addImportedItem(board: Board, item: ImportedItem, group: number | null): Promise<boolean> {
    const kind = item.kind;
    // An Image card arrives with a placeholder path and the
    // bytes to store; the bytes are embedded here and the
    // path rewritten to the stored copy. (PSD and AI no
    // longer explode into layer items, so no importer
    // produces raw pixels any more — only the SVG's
    // embedded images land here.)
    if (item.embed && "Image" in kind) {
      kind.Image.path = await api.embedFileBytes(item.embed.name, item.embed.data);
    }
    if (ctx.getBoard() !== board) { ctx.toast("Board switched — import stopped"); return false; }
    const id = ctx.allocId();
    const newItem: Item = { id, pos: item.pos, size: item.size, group, kind };
    if (item.rotation !== undefined) newItem.rotation = item.rotation;
    board.items.push(newItem);
    return true;
  }

  // Land an image card for a file already embedded at
  // `stored` (the SVG fallback, where the embedded file is
  // the linked source itself, so it must not be embedded
  // a second time). The size comes from loading it. Shared
  // by the drop flow and the live re-import.
  async function addStoredImageCard(board: Board, stored: string, atWorld: Pt, group: number | null): Promise<boolean> {
    const img = new Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); img.src = api.fileUrl(stored); });
    if (ctx.getBoard() !== board) { ctx.toast("Board switched — import stopped"); return false; }
    const nw = img.naturalWidth || 320, nh = img.naturalHeight || 240;
    const scale = nw > 320 ? 320 / nw : 1;
    const id = ctx.allocId();
    board.items.push({ id, pos: atWorld, size: { w: Math.max(40, nw * scale), h: Math.max(40, nh * scale) }, group, kind: { Image: { path: stored } } });
    return true;
  }

  async function dropPaths(files: File[], atScreen: Pt): Promise<void> {
    // The board the drop started on. Every branch awaits
    // file work, and the user may switch boards while it
    // runs; items must land on the board they were dropped
    // onto, never the board the app happens to be on when
    // an await resolves. Switching saves the outgoing board
    // first, so items already added are kept — the import
    // just stops there, and says so.
    const board = ctx.getBoard();
    const sameBoard = (): boolean => ctx.getBoard() === board;
    // Files arrive as File objects, not paths: text is read
    // with the File API and media is embedded as bytes, so
    // no renderer-supplied path is ever handed to the main
    // process to open (see the security boundaries comment
    // in electron/main.ts).
    let at = ctx.toWorld(atScreen);
    let added = 0;

    // Land a raster image file as one Image card at its
    // natural size (capped at 320 wide). Shared by the image
    // branch and the SVG fallback below.
    async function addImageCard(file: File, atWorld: Pt, group: number | null = null): Promise<boolean> {
      const stored = await api.embedFileBytes(file.name, await file.arrayBuffer());
      const img = new Image();
      await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); img.src = api.fileUrl(stored); });
      if (!sameBoard()) { ctx.toast("Board switched — import stopped"); return false; }
      const nw = img.naturalWidth || 320, nh = img.naturalHeight || 240;
      const scale = nw > 320 ? 320 / nw : 1;
      const id = ctx.allocId();
      board.items.push({ id, pos: atWorld, size: { w: Math.max(40, nw * scale), h: Math.max(40, nh * scale) }, group, kind: { Image: { path: stored } } });
      return true;
    }

    // Store an imported item's raster bytes and push it onto
    // the board — see addImportedItem above (shared with the
    // live re-import).

    // Keep an import's source file in the board's assets and
    // link its cards to it: the file is never lost, and the
    // app can re-import it when it changes on disk. The
    // cards go in one group named after the file, and the
    // group records the source. Returns the group and the
    // stored path, or null when the source could not be
    // kept — the cards still land, just unlinked.
    async function linkImport(file: File, data: Uint8Array, kind: "svg" | "psd" | "ai"): Promise<{ group: number; stored: string; size: number; mtimeMs: number } | null> {
      let stored: string;
      try {
        stored = await api.embedFileBytes(file.name, data);
      } catch {
        ctx.toast(`Could not keep ${file.name}`);
        return null;
      }
      const group = ctx.allocGroup();
      // The stat as embedded: the re-import compares the file
      // on disk against it, so the app's own write is ignored
      // and an outside edit is caught. Best-effort — a failed
      // stat just means the first load re-imports once and
      // records the real stat.
      let size = 0, mtimeMs = 0;
      try {
        const checked = await api.checkFile(stored);
        size = checked.size; mtimeMs = checked.mtimeMs;
      } catch { /* keep the link; the stat heals on first refresh */ }
      board.groups = board.groups ?? {};
      board.groups[group] = { label: file.name, source: { path: stored, kind, size, mtimeMs } };
      return { group, stored, size, mtimeMs };
    }

    // Land one FileCard for a .psd or .ai: the source file is
    // kept and linked (so it live-syncs), the artwork is
    // rendered once to a preview, and the card shows the
    // preview with the file name and size. The preview is a
    // derived file in the board's assets, like a video
    // poster; a file whose artwork could not be rendered
    // still lands, with the format tile instead.
    async function addFileCard(file: File, data: Uint8Array<ArrayBuffer>, format: "psd" | "ai", atWorld: Pt): Promise<boolean> {
      const linked = await linkImport(file, data, format);
      if (!linked) return false;
      const stem = file.name.replace(/\.[^.]*$/, "") || format;
      let preview: string | undefined;
      let artW = 0, artH = 0;
      try {
        const rendered = format === "psd"
          ? await renderPsdPreview(parsePsd(data.buffer))
          : await renderAiPreview(data);
        if (rendered) {
          preview = await api.embedFileBytes(`${stem}-preview.png`, rendered.png);
          artW = rendered.width; artH = rendered.height;
        }
      } catch {
        // No preview: the card lands with its format tile.
        preview = undefined;
      }
      if (!sameBoard()) { ctx.toast("Board switched — import stopped"); return false; }
      const id = ctx.allocId();
      board.items.push({
        id,
        pos: atWorld,
        size: fileCardSize(artW, artH),
        group: linked.group,
        kind: { FileCard: { path: linked.stored, size_bytes: linked.size, format, ...(preview ? { preview } : {}) } },
      });
      return true;
    }

    for (const file of files) {
      const ext = file.name.split(".").pop() ?? "";
      const kind = dropKindForExt(ext);
      try {
        if (kind === "image") {
          if (await addImageCard(file, at)) added++;
        } else if (kind === "svg") {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const items = parseSvgToItems(new TextDecoder().decode(bytes), at);
          if (!sameBoard()) { ctx.toast("Board switched — import stopped"); return; }
          if (items.length === 0) {
            // Nothing mappable (a <use>-only file, say): keep
            // the old behaviour and land the whole SVG as
            // one image card — the embedded file is the
            // linked source itself, so it is not embedded
            // a second time.
            const linked = await linkImport(file, bytes, "svg");
            if (!linked) { if (await addImageCard(file, at)) added++; }
            else if (await addStoredImageCard(board, linked.stored, at, linked.group)) added++;
          } else {
            const linked = await linkImport(file, bytes, "svg");
            const group = linked?.group ?? null;
            for (const item of items) {
              if (!(await addImportedItem(board, item, group))) return;
            }
            added += items.length;
          }
        } else if (kind === "psd") {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!sameBoard()) { ctx.toast("Board switched — import stopped"); return; }
          // A .psd lands as one FileCard — the artwork's
          // preview, the file name and size — not as its
          // layers exploded into cards. Double-clicking it
          // opens the file in Photoshop; editing it there
          // re-renders the preview on the board.
          if (await addFileCard(file, bytes, "psd", at)) added++;
        } else if (kind === "ai") {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!isPdfCompatible(bytes)) {
            // A file saved without PDF compatibility is
            // PostScript, which the app cannot read: say so
            // rather than landing a broken card.
            ctx.toast(`${file.name} was saved without PDF compatibility, so it can't be imported`);
          } else {
            // A .ai lands as one FileCard, like a .psd: its
            // first page rendered as the preview, the file
            // name and size below it. Double-clicking it
            // opens the file in Illustrator.
            if (await addFileCard(file, bytes, "ai", at)) added++;
          }
        } else if (kind in STORED_KINDS) {
          const desc = STORED_KINDS[kind];
          const stored = await api.embedFileBytes(file.name, await file.arrayBuffer());
          const size = desc.needsSize ? await api.fileSize(stored).catch(() => 0) : 0;
          if (!sameBoard()) { ctx.toast("Board switched — import stopped"); return; }
          const id = ctx.allocId();
          ctx.getBoard().items.push({ id, pos: at, size: desc.size, group: null, kind: desc.kind(stored, size) });
          added++;
          if (kind === "video") {
            // The poster is background work, not the drop
            // itself: the card lands at once and the poster
            // fills in when the frame is captured, like a
            // link preview.
            void fillVideoPoster(board, id, stored);
          }
        } else if (kind === "text") {
          const text = await file.text();
          if (!sameBoard()) { ctx.toast("Board switched — import stopped"); return; }
          const hex = normaliseHex(text.trim());
          const id = ctx.allocId();
          if (hex) {
            ctx.getBoard().items.push({ id, pos: at, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex } } });
          } else {
            ctx.getBoard().items.push({ id, pos: at, size: { w: 260, h: estimateTextHeight(text.slice(0, 2000), 16, 260) }, group: null, kind: { Text: { text: text.slice(0, 2000), bold: false, size: 16, color: "#1A1A1A" } } });
          }
          added++;
        } else if (kind === "shortcut") {
          const text = await file.text();
          const url = extractShortcutUrl(text);
          if (url) {
            if (!sameBoard()) { ctx.toast("Board switched — import stopped"); return; }
            await addUrlAt(at, url); added++;
          }
        }
      } catch (err) {
        ctx.toast(`Could not add ${file.name}: ${String(err)}`);
      }
      at = { x: at.x + 24, y: at.y + 24 };
    }
    if (added > 0) { ctx.save(); ctx.requestRender(); ctx.syncWatchedSources(); }
  }
  async function refreshLinkPreviews(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const it of ctx.getBoard().items) {
      if (!("UrlCard" in it.kind)) continue;
      if (it.kind.UrlCard.title !== null && it.kind.UrlCard.image !== undefined) continue;
      const url = it.kind.UrlCard.url;
      const id = it.id;
      jobs.push((async () => {
        try {
          const preview = await api.fetchPreview(url);
          const current = boardGet(ctx.getBoard(), id);
          // Same board-switch guard as addUrlAt: the new
          // board can have a different link card at this id.
          if (!current || !("UrlCard" in current.kind) || current.kind.UrlCard.url !== url) return;
          let changed = false;
          for (const key of ["title", "description", "icon"] as const) {
            if (preview[key] && current.kind.UrlCard[key] !== preview[key]) { current.kind.UrlCard[key] = preview[key]; changed = true; }
          }
          if (preview.image && current.kind.UrlCard.image !== preview.image) { current.kind.UrlCard.image = preview.image; current.size = { w: 320, h: 300 }; changed = true; }
          if (changed) { ctx.saveWithoutUndo(); ctx.requestRender(); }
        } catch { /* keep the domain card */ }
      })());
    }
    await Promise.all(jobs);
  }

  async function refreshSource(path: string, stat: { exists: boolean; size: number; mtimeMs: number }): Promise<void> {
    // The board the refresh started on: the user may switch
    // boards while the file is read and parsed, and the new
    // cards must land on the board they were refreshed for.
    const board = ctx.getBoard();
    const sameBoard = (): boolean => ctx.getBoard() === board;
    const group = findSourceGroup(board, path);
    if (group === null) return;
    const entry = board.groups?.[group];
    const source = entry?.source;
    if (!source) return;
    // The app's own write (the embed at drop time) matches
    // the stored stat: nothing changed.
    if (stat.exists && source.size === stat.size && source.mtimeMs === stat.mtimeMs) return;
    if (!stat.exists) {
      // The source file was deleted outside the app: keep the
      // cards, drop the link, and say so. The group keeps its
      // label; it is a plain group now.
      delete entry.source;
      ctx.toast(`Source file deleted — ${entry.label} is no longer linked`);
      ctx.save(); ctx.requestRender(); ctx.syncWatchedSources();
      return;
    }
    const members = board.items.filter((it) => it.group === group);
    if (members.length === 0) return;
    const anchor = groupBBox(members);
    if (!anchor) return;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const read = await api.readFileBase64(path);
      bytes = base64ToBytes(read.base64);
    } catch {
      ctx.toast(`Could not read ${entry.label}`);
      return;
    }
    if (!sameBoard() || findSourceGroup(ctx.getBoard(), path) !== group) { ctx.toast("Board switched — import stopped"); return; }
    // A design file is one card: re-render its preview and
    // update that card in place, keeping its top-left. The
    // card resizes to the new artwork's aspect, like the
    // drop does. A file whose artwork can no longer be
    // rendered keeps its card with the format tile.
    if (source.kind === "psd" || source.kind === "ai") {
      const card = members.find((it) => "FileCard" in it.kind);
      if (!card || !("FileCard" in card.kind)) return;
      if (source.kind === "ai" && !isPdfCompatible(bytes)) { ctx.toast(`${entry.label} was saved without PDF compatibility, so it can't be imported`); return; }
      let preview: string | undefined;
      let artW = 0, artH = 0;
      try {
        const rendered = source.kind === "psd"
          ? await renderPsdPreview(parsePsd(bytes.buffer))
          : await renderAiPreview(bytes);
        if (rendered) {
          const stem = entry.label.replace(/\.[^.]*$/, "") || source.kind;
          preview = await api.embedFileBytes(`${stem}-preview.png`, rendered.png);
          artW = rendered.width; artH = rendered.height;
        }
      } catch {
        // No preview: the card keeps its format tile.
        preview = undefined;
      }
      if (!sameBoard() || findSourceGroup(ctx.getBoard(), path) !== group) { ctx.toast("Board switched — import stopped"); return; }
      card.pos = { x: anchor.x, y: anchor.y };
      card.size = fileCardSize(artW, artH);
      card.kind = { FileCard: { path, size_bytes: stat.size, format: source.kind, ...(preview ? { preview } : {}) } };
      const entryNow = ctx.getBoard().groups?.[group];
      if (entryNow?.source) entryNow.source = { ...entryNow.source, size: stat.size, mtimeMs: stat.mtimeMs };
      ctx.save(); ctx.requestRender();
      return;
    }
    let items: ImportedItem[];
    try {
      items = parseSvgToItems(new TextDecoder().decode(bytes), { x: anchor.x, y: anchor.y });
    } catch {
      ctx.toast(`Could not re-import ${entry.label}`);
      return;
    }
    if (!sameBoard() || findSourceGroup(ctx.getBoard(), path) !== group) { ctx.toast("Board switched — import stopped"); return; }
    const ids = members.map((it) => it.id);
    if (items.length === 0) {
      // Nothing mappable any more: fall back to one image
      // card of the whole file, as the drop does.
      board.items = board.items.filter((it) => !ids.includes(it.id));
      if (!(await addStoredImageCard(board, path, { x: anchor.x, y: anchor.y }, group))) return;
    } else {
      // The parser positions from the anchor, but the file's
      // content may start offset from it: translate so the
      // rebuilt group's top-left lands where the group is.
      const translated = translateImportedToAnchor(items, { x: anchor.x, y: anchor.y });
      board.items = board.items.filter((it) => !ids.includes(it.id));
      for (const item of translated) {
        if (!(await addImportedItem(board, item, group))) return;
      }
    }
    ctx.clearSelection(ids);
    // The cards are rebuilt from the new bytes: record the
    // stat they came from, so the next change is detected
    // against this one and the app's own writes are ignored.
    const entryNow = ctx.getBoard().groups?.[group];
    if (entryNow?.source) entryNow.source = { ...entryNow.source, size: stat.size, mtimeMs: stat.mtimeMs };
    ctx.save(); ctx.requestRender();
  }

  return { dropPaths, addUrlAt, refreshLinkPreviews, refreshSource };
}
