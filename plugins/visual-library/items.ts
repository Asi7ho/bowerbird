// Visual Library — board data. Which board items are library
// elements, the search text for each, the single Uncategorized
// section, and syncing the library's copy of the board with
// the board itself. Owns boardItems, the search query, the
// collapsed sections and the last signature.
import type { PluginContext } from "../../src/plugins";
import type { Item } from "../../src/model";

export type LibraryMode = "panel" | "view";

export interface LibrarySection {
  key: string;
  label: string;
  items: Item[];
}

// No categories are created for the user: every board item
// goes, by default, in a single "Uncategorized" section, in
// board order. A future category system (user-created
// categories, drag to move) would add sections here; for now
// there is exactly one, so the library never invents an
// organisation the user did not ask for.
export const KIND_SINGULAR: Record<string, string> = { Audio: "audio", Image: "image", UrlCard: "link", PdfCard: "PDF", Plugin: "plugin card", Swatch: "swatch", Text: "text note", Video: "video" };
const LIBRARY_KINDS = new Set(["Audio", "Image", "UrlCard", "PdfCard", "Plugin", "Swatch", "Text", "Video"]);

let boardItems: Item[] = [];
let query = "";
let collapsed = new Set<string>();
let lastSignature = "";

export function getBoardItems(): Item[] {
  return boardItems;
}

export function getQuery(): string {
  return query;
}

export function setQuery(value: string): void {
  query = value;
}

export function isSectionCollapsed(key: string): boolean {
  return collapsed.has(key);
}

export function setSectionCollapsed(key: string, value: boolean): void {
  if (value) collapsed.add(key);
  else collapsed.delete(key);
}

export function kindKey(item: Item): string {
  return Object.keys(item.kind)[0];
}

export function isLibraryItem(item: Item): boolean {
  // Slide frames are containers, not content: a frame
  // border is not a library card, so kind "slide" is
  // excluded here, as Presentation's frames use it, and
  // any future frame plugin should use it too.
  if ("Plugin" in item.kind && item.kind.Plugin.kind === "slide") return false;
  return LIBRARY_KINDS.has(kindKey(item)) && item.size.w > 0 && item.size.h > 0;
}

export function basename(path: string): string {
  return (path || "").split("/").pop() || path || "";
}

export function domainOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "";
  }
}

export function searchText(item: Item): string {
  const k = item.kind;
  if ("Text" in k) return k.Text.text || "";
  if ("Image" in k) return basename(k.Image.path);
  if ("UrlCard" in k) return [k.UrlCard.title, k.UrlCard.url, k.UrlCard.description].filter(Boolean).join(" ");
  if ("PdfCard" in k) return basename(k.PdfCard.path);
  if ("Swatch" in k) return k.Swatch.hex || "";
  if ("Audio" in k) return basename(k.Audio.path);
  if ("Video" in k) return k.Video.remote ? domainOfUrl(k.Video.source) : basename(k.Video.source);
  if ("Plugin" in k) return `${k.Plugin.plugin} ${k.Plugin.kind} ${JSON.stringify(k.Plugin.data)}`;
  return "";
}

export function sectionsList(): LibrarySection[] {
  const q = query.trim().toLowerCase();
  const filtered = q ? boardItems.filter((it) => searchText(it).toLowerCase().includes(q)) : boardItems;
  // A search with no matches leaves a blank sections area.
  // With no query, even an empty library renders as a single
  // Uncategorized header (no text).
  if (q && filtered.length === 0) return [];
  return [{ key: "uncategorized", label: "Uncategorized", items: filtered }];
}

export function signature(items: Item[]): string {
  // Deliberately NOT sorted: the library shows cards
  // in board order, so a reorder must change the
  // signature and refresh the view. (Presentation's
  // signature is unsorted for the same reason.)
  return items.map((it) => `${it.id}:${JSON.stringify(it.kind)}:${it.size.w}x${it.size.h}`).join("|");
}

// Sync the library's copy of the board. Returns whether
// anything changed; the caller re-renders when it did.
// The return replaces the old in-place re-render, so this
// module never imports the renderer (no import cycle).
export function syncFromBoard(api: PluginContext, force: boolean): boolean {
  const next = api.board.getItems().filter(isLibraryItem);
  const sig = signature(next);
  if (!force && sig === lastSignature) return false;
  boardItems = next;
  lastSignature = sig;
  return true;
}
