// Library — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Every card on every board, in one panel, with a search box.
// Strokes and connectors are not cards (same rule as the
// Visual Library), so they are left out. Clicking a row
// switches to that card's board when needed, then centres
// on the card and selects it, and adds nothing. The list
// refreshes whenever the board's content changes, and
// whenever the panel opens.
import type { PluginContext } from "../../src/plugins";
import type { Item } from "../../src/model";

type Row = { board: string; item: Item };

const KIND_LABEL: Record<string, string> = {
  Text: "Note", Shape: "Shape", Image: "Image", UrlCard: "Link",
  PdfCard: "PDF", Swatch: "Swatch", Audio: "Audio", Video: "Video", Plugin: "Plugin",
};

function baseName(p: string): string {
  const raw = p.split("/").pop() ?? p;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

function cardTitle(item: Item): string {
  const k = item.kind;
  if ("Text" in k) {
    const first = k.Text.text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    return first ? first.slice(0, 80) : "Empty note";
  }
  if ("Image" in k) return baseName(k.Image.path);
  if ("UrlCard" in k) return k.UrlCard.title || hostOf(k.UrlCard.url) || k.UrlCard.url;
  if ("PdfCard" in k) return baseName(k.PdfCard.path);
  if ("Audio" in k) return baseName(k.Audio.path);
  if ("Video" in k) return k.Video.remote ? k.Video.source : baseName(k.Video.source);
  if ("Swatch" in k) return k.Swatch.hex;
  if ("Shape" in k) return k.Shape.shape;
  if ("Plugin" in k) return k.Plugin.kind;
  return "Card";
}

function kindOf(item: Item): string {
  const key = Object.keys(item.kind)[0] ?? "";
  return KIND_LABEL[key] ?? key;
}

function isCard(item: Item): boolean {
  return !("Stroke" in item.kind) && !("Connector" in item.kind);
}

let apiRef: PluginContext | null = null;
let rows: Row[] = [];
let query = "";
let listEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let onBoardHandler: (() => void) | null = null;

async function loadRows(api: PluginContext): Promise<void> {
  const boards = await api.boards.list();
  const reads = await Promise.all(boards.map((b) => api.boards.read(b.name)));
  rows = reads.flatMap((r) => r.items.filter(isCard).map((item) => ({ board: r.name, item })));
}

function matches(row: Row): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [cardTitle(row.item), row.board, kindOf(row.item)];
  if ("Text" in row.item.kind) hay.push(row.item.kind.Text.text);
  return hay.join("\n").toLowerCase().includes(q);
}

function renderList(): void {
  if (!listEl || !countEl) return;
  const shown = rows.filter(matches);
  countEl.textContent = `${shown.length} card${shown.length === 1 ? "" : "s"}`;
  listEl.replaceChildren();
  let lastBoard: string | null = null;
  for (const row of shown) {
    if (row.board !== lastBoard) {
      const h = document.createElement("div");
      h.className = "lib-board";
      h.textContent = row.board;
      listEl.appendChild(h);
      lastBoard = row.board;
    }
    const b = document.createElement("button");
    b.className = "lib-row";
    b.type = "button";
    const title = document.createElement("span");
    title.className = "lib-title";
    title.textContent = cardTitle(row.item);
    const meta = document.createElement("span");
    meta.className = "lib-meta";
    meta.textContent = kindOf(row.item);
    b.append(title, meta);
    b.addEventListener("click", () => void jumpTo(row));
    listEl.appendChild(b);
  }
  if (shown.length === 0) {
    const empty = document.createElement("div");
    empty.className = "lib-empty";
    empty.textContent = query.trim() ? "No cards match." : "No cards yet.";
    listEl.appendChild(empty);
  }
}

async function refresh(api: PluginContext): Promise<void> {
  try {
    await loadRows(api);
    renderList();
  } catch {
    // A failed read leaves the last good list in place.
  }
}

async function jumpTo(row: Row): Promise<void> {
  if (!apiRef) return;
  const current = await apiRef.boards.current();
  if (current !== row.board) {
    await apiRef.boards.switch(row.board);
  }
  apiRef.view.centreOn(row.item.id);
  apiRef.board.setSelected([row.item.id]);
}

export async function activate(api: PluginContext): Promise<void> {
  apiRef = api;
  onBoardHandler = () => void refresh(api);
  api.events.on("board", onBoardHandler);
  api.ui.registerPanel({
    id: "library",
    title: "Library",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 4v16M12 4v16"/></svg>',
    render: (container) => {
      container.replaceChildren();
      const search = document.createElement("input");
      search.className = "lib-search";
      search.type = "search";
      search.placeholder = "Search all boards";
      search.value = query;
      search.addEventListener("input", () => {
        query = search.value;
        renderList();
      });
      const count = document.createElement("div");
      count.className = "lib-count";
      countEl = count;
      const list = document.createElement("div");
      list.className = "lib-list";
      listEl = list;
      container.append(search, count, list);
      void refresh(api);
    },
  });
}

export function deactivate(): void {
  if (apiRef && onBoardHandler) apiRef.events.off("board", onBoardHandler);
  onBoardHandler = null;
  listEl = null;
  countEl = null;
  apiRef = null;
}
