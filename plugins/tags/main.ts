// Tags — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Tag the selected cards. Tags live on the item itself
// (`item.tags`, set through updateItem) and are shown as
// pills inside each card by the decorator below. Adding or
// removing a tag is one undo step for the whole selection.
// The panel refreshes on selection and on board changes.
import type { PluginContext } from "../../src/plugins";
import type { Item } from "../../src/model";

let apiRef: PluginContext | null = null;
let statusEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let onChange: (() => void) | null = null;

function selectedItems(): Item[] {
  if (!apiRef) return [];
  const items = apiRef.board.getItems();
  const sel = new Set(apiRef.board.getSelected());
  return items.filter((it) => sel.has(it.id));
}

function selectionTags(): string[] {
  const tags = new Set<string>();
  for (const it of selectedItems()) {
    for (const t of it.tags ?? []) tags.add(t);
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

function renderList(): void {
  if (!apiRef || !statusEl || !listEl) return;
  const sel = selectedItems();
  statusEl.textContent = sel.length === 0
    ? "No cards selected."
    : `${sel.length} card${sel.length === 1 ? "" : "s"} selected.`;
  listEl.replaceChildren();
  for (const tag of selectionTags()) {
    const row = document.createElement("div");
    row.className = "tags-row";
    const name = document.createElement("span");
    name.className = "tags-name";
    name.textContent = `#${tag}`;
    const remove = document.createElement("button");
    remove.className = "tags-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove tag ${tag}`);
    remove.addEventListener("click", () => removeTag(tag));
    row.append(name, remove);
    listEl.appendChild(row);
  }
  if (sel.length > 0 && selectionTags().length === 0) {
    const empty = document.createElement("div");
    empty.className = "tags-empty";
    empty.textContent = "No tags on these cards.";
    listEl.appendChild(empty);
  }
}

function addTag(raw: string): void {
  if (!apiRef) return;
  const tag = raw.trim().slice(0, 24);
  if (!tag) return;
  const patches = selectedItems().map((it) => {
    const tags = [...(it.tags ?? [])];
    if (!tags.includes(tag)) tags.push(tag);
    return { id: it.id, tags };
  });
  if (patches.length > 0) apiRef.board.updateItems(patches);
}

function removeTag(tag: string): void {
  if (!apiRef) return;
  const patches = selectedItems().map((it) => ({
    id: it.id,
    tags: (it.tags ?? []).filter((t) => t !== tag),
  }));
  if (patches.length > 0) apiRef.board.updateItems(patches);
}

export async function activate(api: PluginContext): Promise<void> {
  apiRef = api;
  api.cards.registerDecorator({
    id: "tags",
    render: (item) => {
      if (!item.tags || item.tags.length === 0) return null;
      return item.tags
        .map((t) => `<span class="card-tag">#${api.text.escapeHtml(t)}</span>`)
        .join("");
    },
  });
  onChange = () => renderList();
  api.events.on("selection", onChange);
  api.events.on("board", onChange);
  api.ui.registerPanel({
    id: "tags",
    title: "Tags",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4h7l9 9-7 7-9-9V4z"/><circle cx="9" cy="9" r="1.6"/></svg>',
    render: (container) => {
      container.replaceChildren();
      const form = document.createElement("form");
      form.className = "tags-form";
      const input = document.createElement("input");
      input.className = "tags-input";
      input.type = "text";
      input.placeholder = "Add a tag";
      input.setAttribute("aria-label", "Add a tag");
      const add = document.createElement("button");
      add.className = "tags-add";
      add.type = "submit";
      add.textContent = "Add";
      form.append(input, add);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        addTag(input.value);
        input.value = "";
        input.focus();
      });
      const status = document.createElement("div");
      status.className = "tags-status";
      statusEl = status;
      const list = document.createElement("div");
      list.className = "tags-list";
      listEl = list;
      container.append(form, status, list);
      renderList();
    },
  });
}

export function deactivate(): void {
  if (apiRef && onChange) {
    apiRef.events.off("selection", onChange);
    apiRef.events.off("board", onChange);
  }
  onChange = null;
  statusEl = null;
  listEl = null;
  apiRef = null;
}
