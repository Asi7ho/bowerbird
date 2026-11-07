// Boards — the panel: the intro line, the new-board form,
// and the list container. The list itself (rows, delete,
// rename) lives in list.ts; this file owns the panel DOM.
import type { PluginContext } from "../../src/plugins";
import { refresh } from "./list.js";

let listEl: HTMLDivElement | null = null;
let nameInput: HTMLInputElement | null = null;

// Rebuild the list, if the panel is rendered. A board event
// can fire before the panel renders, when there is no list
// yet — that is the guard the old refresh() carried.
export function refreshPanel(api: PluginContext): void {
  if (!listEl) return;
  void refresh(api, listEl);
}

export function renderPanel(api: PluginContext, container: HTMLElement): void {
  container.innerHTML = "";
  const form = document.createElement("div");
  form.className = "bd-form";
  nameInput = document.createElement("input");
  nameInput.className = "bd-input";
  nameInput.type = "text";
  nameInput.placeholder = "New board name";
  nameInput.setAttribute("aria-label", "New board name");
  const input = nameInput;
  const createBtn = document.createElement("button");
  createBtn.className = "bd-create";
  createBtn.textContent = "New board";
  const create = async (): Promise<void> => {
    const name = input.value.trim();
    if (!name) return;
    try {
      await api.boards.create(name);
      input.value = "";
      const ok = await api.boards.switch(name);
      if (!ok) api.ui.toast(`Created ${name} — click it to open`);
      refreshPanel(api);
    } catch (err) { api.ui.toast(`Could not create: ${String((err as { message?: unknown })?.message || err)}`); }
  };
  createBtn.addEventListener("click", () => void create());
  // Same stopPropagation as the rename input above:
  // typing a board name must never switch tools or
  // delete the selected card.
  nameInput.addEventListener("keydown", (e) => e.stopPropagation());
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } });
  form.appendChild(nameInput);
  form.appendChild(createBtn);
  container.appendChild(form);
  listEl = document.createElement("div");
  listEl.className = "bd-list";
  container.appendChild(listEl);
  refreshPanel(api);
}

export function clearPanel(): void {
  listEl = null;
  nameInput = null;
}
