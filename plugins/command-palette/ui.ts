// Command Palette — the palette UI. The modal overlay, its
// input and list, opening and closing, filtering, moving the
// selection, and running the selected entry. The entries
// themselves live in entries.ts; this file only shows them.
//
// The key handling lives here too: Cmd/Ctrl+K toggles the
// palette, and while it is open the listener stops
// propagation, so typing in its input never fires a board
// shortcut (typing "v" must not switch to the Select tool
// behind the palette).
import type { PluginContext } from "../../src/plugins";
import { buildEntries } from "./entries.js";
import type { Entry } from "./entries.js";

let apiRef: PluginContext | null = null;
let root: HTMLDivElement | null = null;
let dialog: HTMLDivElement | null = null;
let input: HTMLInputElement | null = null;
let listEl: HTMLDivElement | null = null;
let isOpen = false;
let entries: Entry[] = [];
let filtered: Entry[] = [];
let selectedIdx = 0;

export function initPalette(api: PluginContext): void {
  apiRef = api;
}

export function clearPalette(): void {
  apiRef = null;
  root = null;
  dialog = null;
  input = null;
  listEl = null;
  isOpen = false;
  entries = [];
  filtered = [];
  selectedIdx = 0;
}

// Only the first 50 matches are rendered or
// navigable: the old code rebuilt a row per match on
// every keystroke, so typing on a big board rebuilt
// hundreds of rows per keystroke. Fifty is more than
// a screenful; the count row below says how many more
// there are, so the user types to narrow instead.
const MAX_ROWS = 50;
function renderList(): void {
  const inputEl = input;
  const list = listEl;
  if (!inputEl || !list) return;
  const q = inputEl.value.trim().toLowerCase();
  const matches = q === ""
    ? entries
    : entries.filter((e) => (e.title + " " + e.hint).toLowerCase().includes(q));
  filtered = matches.slice(0, MAX_ROWS);
  const extra = matches.length - filtered.length;
  if (selectedIdx >= filtered.length) selectedIdx = Math.max(0, filtered.length - 1);
  if (filtered.length === 0) selectedIdx = -1;
  list.innerHTML = "";
  if (filtered.length === 0) {
    const row = document.createElement("div");
    row.className = "cmd-row cmd-empty";
    row.textContent = "No commands match";
    list.appendChild(row);
    return;
  }
  filtered.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "cmd-row" + (i === selectedIdx ? " active" : "");
    const title = document.createElement("span");
    title.className = "cmd-title";
    title.textContent = e.title;
    const hint = document.createElement("span");
    hint.className = "cmd-hint";
    hint.textContent = e.hint;
    row.append(title, hint);
    // mousemove, not mouseenter: a row appearing under a stationary
    // mouse (for example, on open, or on a re-render while typing)
    // must not steal the selection from the first row. Only a real
    // mouse move over a row selects it, so Enter after opening
    // always runs the first row, not whichever row the cursor
    // happens to be sitting over.
    row.addEventListener("mousemove", () => {
      if (selectedIdx === i) return;
      selectedIdx = i;
      for (const sib of list.querySelectorAll(".cmd-row")) sib.classList.remove("active");
      row.classList.add("active");
    });
    row.addEventListener("click", () => runSelected());
    list.appendChild(row);
  });
  if (extra > 0) {
    const more = document.createElement("div");
    more.className = "cmd-row cmd-empty";
    more.textContent = `…and ${extra} more — keep typing to narrow`;
    list.appendChild(more);
  }
}

export function moveSelection(delta: number): void {
  const list = listEl;
  if (!list || filtered.length === 0) return;
  selectedIdx = (selectedIdx + delta + filtered.length) % filtered.length;
  const rows = list.querySelectorAll(".cmd-row");
  rows.forEach((r, i) => r.classList.toggle("active", i === selectedIdx));
  const active = rows[selectedIdx];
  if (active) active.scrollIntoView({ block: "nearest" });
}

export function openPalette(): void {
  const api = apiRef;
  if (!api || isOpen || !root || !input) return;
  // Opening from Settings' Run button must not leave the palette
  // hidden behind the Settings sheet: close Settings first.
  if (api.ui.isSettingsOpen()) api.ui.closeSettings();
  entries = buildEntries(api);
  selectedIdx = 0;
  isOpen = true;
  root.style.display = "";
  input.value = "";
  renderList();
  input.focus();
  window.addEventListener("pointerdown", onPointerDown, true);
}

export function closePalette(): void {
  if (!isOpen) return;
  isOpen = false;
  if (root) root.style.display = "none";
  window.removeEventListener("pointerdown", onPointerDown, true);
  input?.blur();
}

export function runSelected(): void {
  const api = apiRef;
  if (!api || selectedIdx < 0 || selectedIdx >= filtered.length) return;
  const entry = filtered[selectedIdx];
  closePalette();
  try {
    const r = entry.run();
    if (r instanceof Promise) r.catch((e) => api.ui.toast("Command failed: " + String(e)));
  } catch (e) {
    api.ui.toast("Command failed: " + String(e));
  }
}

export function onPointerDown(e: PointerEvent): void {
  if (!isOpen || !dialog) return;
  if (dialog.contains(e.target as Node | null)) return;
  closePalette();
  e.preventDefault();
  e.stopPropagation();
}

export function onKeyDown(e: KeyboardEvent): void {
  const isK = e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey);
  if (isK) {
    if (isOpen) {
      closePalette();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const api = apiRef;
    // Do not steal keys while editing a note or while Settings
    // is open: the core's own shortcuts are blocked there too.
    if (!api) return;
    const active = document.activeElement;
    if ((active && active.tagName === "TEXTAREA") || api.ui.isSettingsOpen()) return;
    openPalette();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!isOpen) return;
  // Modal: no board shortcut may fire while the palette is open.
  e.stopPropagation();
  if (e.key === "Escape") {
    closePalette();
    e.preventDefault();
  } else if (e.key === "ArrowDown") {
    moveSelection(1);
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    moveSelection(-1);
    e.preventDefault();
  } else if (e.key === "Tab") {
    moveSelection(e.shiftKey ? -1 : 1);
    e.preventDefault();
  } else if (e.key === "Enter") {
    runSelected();
    e.preventDefault();
  }
  // Any other key reaches the input normally, so typing filters.
}

export function initOverlay(container: HTMLElement): void {
  root = document.createElement("div");
  root.className = "cmd-palette-root";
  root.style.display = "none";
  const backdrop = document.createElement("div");
  backdrop.className = "cmd-palette-backdrop";
  dialog = document.createElement("div");
  dialog.className = "cmd-palette";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Command palette");
  input = document.createElement("input");
  input.className = "cmd-input";
  input.type = "text";
  input.placeholder = "Type a command or search\u2026";
  input.setAttribute("aria-label", "Search commands");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("input", () => {
    selectedIdx = 0;
    renderList();
  });
  listEl = document.createElement("div");
  listEl.className = "cmd-list";
  const footer = document.createElement("div");
  footer.className = "cmd-footer";
  footer.textContent = "\u2191\u2193 to move \u00b7 Enter to run \u00b7 Esc to close";
  dialog.append(input, listEl, footer);
  backdrop.appendChild(dialog);
  root.appendChild(backdrop);
  container.appendChild(root);
}
