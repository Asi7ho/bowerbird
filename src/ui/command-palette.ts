// Command palette: one place to find anything — plugin commands,
// board cards, views, tools and core actions — and route the pick
// to the app or the plugin that owns it. The palette itself never
// runs another plugin's command. Cmd/Ctrl+K opens it.
import type { Item, PluginContext, PluginManifest } from "bowerbird-plugin-api";

// Entries: a routing palette, not an executor. Built fresh on
// every open, so it never lists a dead action; the host runs the
// pick as its owning plugin. Group, Ungroup, Delete, Undo and
// Redo only appear when they can do something.
export interface Entry {
  title: string;
  hint: string;
  run: () => void | Promise<void>;
}

function baseName(path: string): string {
  if (!path) return "";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

function truncate(text: string, max: number): string {
  const t = String(text || "");
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}

function cardTitle(item: Item): string {
  const kind = item.kind;
  if ("Text" in kind) {
    const first = String(kind.Text.text || "").split("\n")[0].trim();
    return first ? truncate(first, 48) : "Text note";
  }
  if ("UrlCard" in kind) return truncate(kind.UrlCard.title || kind.UrlCard.url, 48);
  if ("Image" in kind) return truncate(baseName(kind.Image.path) || "Image", 48);
  if ("PdfCard" in kind) return truncate(baseName(kind.PdfCard.path) || "PDF", 48);
  if ("Audio" in kind) return truncate(baseName(kind.Audio.path) || "Audio", 48);
  if ("Video" in kind) return truncate(baseName(kind.Video.source) || "Video", 48);
  if ("Swatch" in kind) return kind.Swatch.hex;
  if ("Plugin" in kind) return truncate(kind.Plugin.plugin + " " + kind.Plugin.kind, 48);
  return "Card";
}

function isGoToItem(item: Item): boolean {
  if ("Stroke" in item.kind || "Connector" in item.kind) return false;
  // A slide frame is a container, not content to jump to, just
  // as Visual Library excludes slide frames from its library.
  if ("Plugin" in item.kind && item.kind.Plugin.kind === "slide") return false;
  return true;
}

export function buildEntries(api: PluginContext): Entry[] {
  const out: Entry[] = [];

  // Plugin commands first: these are the commands other plugins
  // registered, if any. No plugin currently registers one. Each
  // entry routes the user's pick to the host, which runs the
  // command as its owning plugin — the palette never runs
  // another plugin's command itself.
  const commands = api.ui.listCommands()
    .sort((a, b) => a.title.localeCompare(b.title));
  for (const c of commands) {
    out.push({
      title: c.title,
      hint: c.pluginName,
      run: () => api.ui.routeCommand(c.pluginId, c.id),
    });
  }

  // Board cards, in board order, to jump to.
  for (const item of api.board.getItems()) {
    if (!isGoToItem(item)) continue;
    out.push({
      title: "Go to " + cardTitle(item),
      hint: "Board",
      run: () => {
        api.view.setView("board");
        api.view.centreOn(item.id);
      },
    });
  }

  // Views, including Board, in the order the view switcher shows.
  for (const v of api.view.listViews()) {
    out.push({
      title: "Switch to " + v.title,
      hint: "View",
      run: () => api.view.setView(v.id),
    });
  }

  // Tools: select is the one core tool; the drawing tools
  // are plugin tools now, so listTools() below surfaces
  // them (with the drawing plugin's name) instead of a
  // hardcoded list going stale.
  const coreTools = [
    { id: "select", title: "Select" },
  ];
  for (const t of coreTools) {
    out.push({ title: "Use " + t.title + " tool", hint: "Tool", run: () => api.ui.setTool(t.id) });
  }
  for (const t of api.ui.listTools()) {
    out.push({ title: "Use " + t.title + " tool", hint: t.pluginName, run: () => api.ui.setTool(t.id) });
  }

  // Core actions the API can reach. Group, Ungroup and Delete
  // only appear when they can actually do something, so the
  // palette never lists an action that silently does nothing.
  const selected = api.board.getSelected();
  const items = api.board.getItems();
  const hasGrouped = selected.some((id) => {
    const it = items.find((i) => i.id === id);
    return it && it.group !== null && it.group !== undefined;
  });
  const zoom = (factor: number): void => {
    const cam = api.view.getCamera();
    api.view.setCamera({ x: cam.x, y: cam.y, zoom: cam.zoom * factor });
  };
  const actions: Array<{ title: string; run: () => void | Promise<void> }> = [
    { title: "Zoom in", run: () => zoom(1.2) },
    { title: "Zoom out", run: () => zoom(1 / 1.2) },
    { title: "Reset view", run: () => api.view.setCamera({ x: 0, y: 0, zoom: 1 }) },
  ];
  // Undo and Redo only appear when they can do something, like
  // Group and Delete below: the palette never lists a dead action.
  // The braces discard the boolean: an entry's run returns void
  // or a promise, and runSelected only awaits a promise.
  if (api.board.canUndo()) actions.push({ title: "Undo", run: () => { api.board.undo(); } });
  if (api.board.canRedo()) actions.push({ title: "Redo", run: () => { api.board.redo(); } });
  if (selected.length >= 2) actions.push({ title: "Group selection", run: () => { api.board.groupSelected(); } });
  if (hasGrouped) actions.push({ title: "Ungroup selection", run: () => { api.board.ungroupSelected(); } });
  if (selected.length >= 1) actions.push({ title: "Delete selection", run: () => { api.board.deleteSelected(); } });
  actions.push(
    { title: "Open Settings", run: () => api.ui.openSettings() },
    { title: "Minimise board", run: () => api.window.minimise().catch(() => undefined) },
    {
      title: "Hide board",
      run: () => {
        // Same order Hide uses: commit, save, then hide, so an
        // open note edit is not lost behind the peek icon.
        api.board.commitEditing();
        api.board.save();
        api.window.hide().catch(() => undefined);
      },
    },
  );
  for (const a of actions) out.push({ title: a.title, hint: "Action", run: a.run });

  return out;
}

// Overlay: the modal, filtering, moving the selection, running
// the picked entry. Cmd/Ctrl+K toggles it — it cannot be a
// registered shortcut (those are single keys with no modifiers),
// so the palette listens for it itself in the capture phase.
// While open, the listener stops propagation so typing never
// fires a board shortcut.
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

function moveSelection(delta: number): void {
  const list = listEl;
  if (!list || filtered.length === 0) return;
  selectedIdx = (selectedIdx + delta + filtered.length) % filtered.length;
  const rows = list.querySelectorAll(".cmd-row");
  rows.forEach((r, i) => r.classList.toggle("active", i === selectedIdx));
  const active = rows[selectedIdx];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function openPalette(): void {
  const api = apiRef;
  if (!api || isOpen || !root || !input) return;
  entries = buildEntries(api);
  selectedIdx = 0;
  isOpen = true;
  root.style.display = "";
  input.value = "";
  renderList();
  input.focus();
  window.addEventListener("pointerdown", onPointerDown, true);
}

function closePalette(): void {
  if (!isOpen) return;
  isOpen = false;
  if (root) root.style.display = "none";
  window.removeEventListener("pointerdown", onPointerDown, true);
  input?.blur();
}

function runSelected(): void {
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

// Plugin: always on — disabling it would leave Cmd/Ctrl+K dead.
export const manifest: PluginManifest = {
  apiVersion: "2",
  id: "command-palette",
  name: "Command Palette",
  version: "1.0.0",
  description: "Every command, from one place. Cmd/Ctrl + K.",
  main: "command-palette.js",
  permissions: ["board:write", "window"],
  // The palette is the way commands are run: disabling it would
  // leave Cmd/Ctrl+K dead, so it cannot be disabled, like the board.
  required: true,
};

export function activate(api: PluginContext): void {
  initPalette(api);
  api.ui.registerOverlay({
    id: "palette",
    render: (container) => initOverlay(container),
  });
  // No command is registered for opening the palette:
  // it opens with Cmd/Ctrl+K. The palette is the place
  // commands are run from, not a command to run itself.
  window.addEventListener("keydown", onKeyDown, true);
}

export function deactivate(): void {
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("pointerdown", onPointerDown, true);
  clearPalette();
}
