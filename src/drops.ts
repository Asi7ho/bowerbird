// Drops and pastes: files dropped from the OS, links dragged
// from a browser, links pasted from the clipboard, and the
// background fill of link previews for cards that never got
// one. Dropped files are embedded as board-owned copies in
// the board folder (see the main process), so deleting the
// original cannot break the card. Preview fills are background
// work, not user changes: they save without an undo step.
import { api } from "./api";
import { boardGet, domainOf, estimateTextHeight, normaliseHex, type Board, type Pt } from "./model";

export interface DropsContext {
  getBoard(): Board;
  allocId(): number;
  save(): void;
  saveWithoutUndo(): void;
  requestRender(): void;
  toWorld(s: Pt): Pt;
  toast(msg: string): void;
}

export interface Drops {
  dropPaths(paths: string[], atScreen: Pt): Promise<void>;
  addUrlAt(at: Pt, url: string): Promise<void>;
  refreshLinkPreviews(): Promise<void>;
}

export function createDrops(ctx: DropsContext): Drops {
  // ---------------------------------------------------------------- drops

  function dropKindForExt(ext: string): string {
    const e = ext.toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(e)) return "image";
    if (e === "pdf") return "pdf";
    if (["mp3", "wav", "flac", "ogg", "m4a"].includes(e)) return "audio";
    if (["mp4", "mov", "webm", "mkv", "avi", "m4v"].includes(e)) return "video";
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

  async function dropPaths(paths: string[], atScreen: Pt): Promise<void> {
    let at = ctx.toWorld(atScreen);
    let added = 0;
    for (const path of paths) {
      const ext = path.split(".").pop() ?? "";
      const kind = dropKindForExt(ext);
      try {
        if (kind === "image") {
          const stored = await api.embedFile(path);
          const img = new Image();
          await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); img.src = api.fileUrl(stored); });
          const nw = img.naturalWidth || 320, nh = img.naturalHeight || 240;
          const scale = nw > 320 ? 320 / nw : 1;
          const id = ctx.allocId();
          ctx.getBoard().items.push({ id, pos: at, size: { w: Math.max(40, nw * scale), h: Math.max(40, nh * scale) }, group: null, kind: { Image: { path: stored } } });
          added++;
        } else if (kind === "pdf") {
          const stored = await api.embedFile(path);
          const size = await api.fileSize(stored).catch(() => 0);
          const id = ctx.allocId();
          // Tall enough to show a page, not just a tile: the
          // page preview needs height, and a user can still
          // resize it smaller, where it falls back to a row.
          ctx.getBoard().items.push({ id, pos: at, size: { w: 260, h: 360 }, group: null, kind: { PdfCard: { path: stored, size_bytes: size } } });
          added++;
        } else if (kind === "audio") {
          const stored = await api.embedFile(path);
          const id = ctx.allocId();
          ctx.getBoard().items.push({ id, pos: at, size: { w: 300, h: 104 }, group: null, kind: { Audio: { path: stored } } });
          added++;
        } else if (kind === "video") {
          const stored = await api.embedFile(path);
          const size = await api.fileSize(stored).catch(() => 0);
          const id = ctx.allocId();
          ctx.getBoard().items.push({ id, pos: at, size: { w: 360, h: 264 }, group: null, kind: { Video: { source: stored, remote: false, size_bytes: size } } });
          added++;
        } else if (kind === "text") {
          const text = await api.readTextFile(path);
          const hex = normaliseHex(text.trim());
          const id = ctx.allocId();
          if (hex) {
            ctx.getBoard().items.push({ id, pos: at, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex } } });
          } else {
            ctx.getBoard().items.push({ id, pos: at, size: { w: 260, h: estimateTextHeight(text.slice(0, 2000), 16, 260) }, group: null, kind: { Text: { text: text.slice(0, 2000), bold: false, size: 16, color: "#1A1A1A" } } });
          }
          added++;
        } else if (kind === "shortcut") {
          const text = await api.readTextFile(path);
          const url = extractShortcutUrl(text);
          if (url) { await addUrlAt(at, url); added++; }
        }
      } catch (err) {
        ctx.toast(`Could not add ${path.split("/").pop()}: ${String(err)}`);
      }
      at = { x: at.x + 24, y: at.y + 24 };
    }
    if (added > 0) { ctx.save(); ctx.requestRender(); }
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
          if (preview.title && current.kind.UrlCard.title !== preview.title) { current.kind.UrlCard.title = preview.title; changed = true; }
          if (preview.description && current.kind.UrlCard.description !== preview.description) { current.kind.UrlCard.description = preview.description; changed = true; }
          if (preview.image && current.kind.UrlCard.image !== preview.image) { current.kind.UrlCard.image = preview.image; current.size = { w: 320, h: 300 }; changed = true; }
          if (preview.icon && current.kind.UrlCard.icon !== preview.icon) { current.kind.UrlCard.icon = preview.icon; changed = true; }
          if (changed) { ctx.saveWithoutUndo(); ctx.requestRender(); }
        } catch { /* keep the domain card */ }
      })());
    }
    await Promise.all(jobs);
  }

  return { dropPaths, addUrlAt, refreshLinkPreviews };
}
