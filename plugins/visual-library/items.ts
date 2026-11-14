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

export interface LibraryCategory {
  id: string;
  name: string;
}

// User-created categories, stored in plugin storage so
// they survive restarts. Every board item goes, by default,
// in a single "Uncategorized" section, in board order.
// A category holds the items the user moved into it;
// assignments are keyed by board item id, so they survive
// a board sync, and an item deleted from the board simply
// stops appearing (its assignment is dropped on save).
const CATEGORIES_KEY = "categories";
const ASSIGNMENTS_KEY = "assignments";

let categories: LibraryCategory[] = [];
let assignments: Record<number, string> = {};
let categoriesLoaded = false;

export function getCategories(): LibraryCategory[] {
  return categories;
}

export async function loadCategories(api: PluginContext): Promise<void> {
  if (categoriesLoaded) return;
  categoriesLoaded = true;
  try {
    const savedCats = (await api.storage.get(CATEGORIES_KEY)) as LibraryCategory[] | undefined;
    if (Array.isArray(savedCats)) categories = savedCats.filter((c) => c && typeof c.id === "string" && typeof c.name === "string");
    const savedAssign = (await api.storage.get(ASSIGNMENTS_KEY)) as Record<number, string> | undefined;
    if (savedAssign && typeof savedAssign === "object") assignments = savedAssign;
  } catch {
    categories = [];
    assignments = {};
  }
}

async function saveCategories(api: PluginContext): Promise<void> {
  try {
    await api.storage.set(CATEGORIES_KEY, categories);
    await api.storage.set(ASSIGNMENTS_KEY, assignments);
  } catch {
    // Storage is a convenience: a failed save leaves the
    // in-memory categories working for this session.
  }
}

export function createCategory(api: PluginContext, name: string): LibraryCategory {
  const id = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const cat = { id, name };
  categories = [...categories, cat];
  void saveCategories(api);
  return cat;
}

export function renameCategory(api: PluginContext, id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  categories = categories.map((c) => (c.id === id ? { ...c, name: trimmed } : c));
  void saveCategories(api);
}

export function deleteCategory(api: PluginContext, id: string): void {
  categories = categories.filter((c) => c.id !== id);
  for (const itemId of Object.keys(assignments)) {
    if (assignments[Number(itemId)] === id) delete assignments[Number(itemId)];
  }
  void saveCategories(api);
}

export function moveItemToCategory(api: PluginContext, itemId: number, categoryId: string | null): void {
  if (categoryId === null) delete assignments[itemId];
  else assignments[itemId] = categoryId;
  void saveCategories(api);
}

export function sectionsList(): LibrarySection[] {
  const q = query.trim().toLowerCase();
  const filtered = q ? boardItems.filter((it) => searchText(it).toLowerCase().includes(q)) : boardItems;
  // A search with no matches leaves a blank sections area.
  // With no query, even an empty library renders as a single
  // Uncategorized header (no text).
  if (q && filtered.length === 0) return [];
  const uncategorized = filtered.filter((it) => !assignments[it.id] || !categories.some((c) => c.id === assignments[it.id]));
  const sections: LibrarySection[] = [{ key: "uncategorized", label: "Uncategorized", items: uncategorized }];
  for (const cat of categories) {
    sections.push({ key: cat.id, label: cat.name, items: filtered.filter((it) => assignments[it.id] === cat.id) });
  }
  return sections;
}
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
