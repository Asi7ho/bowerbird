// Command Palette — bundled Bowerbird plugin (see PLUGIN_API.md).
// One place to run anything: plugin commands, board cards, views,
// tools and the core actions the API can reach. Cmd/Ctrl+K opens
// it, typing filters, Arrow keys move, Enter runs, Esc closes.
//
// Plugin shortcuts in v1 are single keys with no modifiers, so
// Cmd/Ctrl+K cannot be one: this plugin listens for it itself,
// in the capture phase, like Presentation does for its view keys.
// While the palette is open that listener stops propagation, so
// typing in its input never fires a board shortcut (typing "v"
// must not switch to the Select tool behind the palette).
//
// The palette is modal: a click outside its dialog just closes
// it, it does not also act on whatever was clicked. That is the
// window pointerdown listener added on open and removed on close.
let apiRef = null;
let root = null;
let dialog = null;
let input = null;
let listEl = null;
let isOpen = false;
let entries = [];
let filtered = [];
let selectedIdx = 0;

function baseName(path) {
  if (!path) return "";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

function truncate(text, max) {
  const t = String(text || "");
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}

function cardTitle(item) {
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

function isGoToItem(item) {
  if ("Stroke" in item.kind || "Connector" in item.kind) return false;
  // A slide frame is a container, not content to jump to, just
  // as Visual Library excludes slide frames from its library.
  if ("Plugin" in item.kind && item.kind.Plugin.kind === "slide") return false;
  return true;
}

function buildEntries() {
  const out = [];

  // Plugin commands first: these are the commands other plugins
  // registered, the ones Settings shows as Run buttons. The
  // palette's own Open command is left out — running it while
  // the palette is already open would do nothing useful.
  const commands = apiRef.ui.listCommands()
    .filter((c) => !(c.pluginId === "command-palette" && c.id === "open"))
    .sort((a, b) => a.title.localeCompare(b.title));
  for (const c of commands) {
    out.push({
      title: c.title,
      hint: c.pluginName,
      run: () => apiRef.ui.runCommand(c.pluginId, c.id),
    });
  }

  // Board cards, in board order, to jump to.
  for (const item of apiRef.board.getItems()) {
    if (!isGoToItem(item)) continue;
    out.push({
      title: "Go to " + cardTitle(item),
      hint: "Board",
      run: () => {
        apiRef.view.setView("board");
        apiRef.view.centreOn(item.id);
      },
    });
  }

  // Views, including Board, in the order the view switcher shows.
  for (const v of apiRef.view.listViews()) {
    out.push({
      title: "Switch to " + v.title,
      hint: "View",
      run: () => apiRef.view.setView(v.id),
    });
  }

  // Tools: the core tools, then any plugin tools.
  const coreTools = [
    { id: "select", title: "Select" },
    { id: "pen", title: "Pen" },
    { id: "connector", title: "Arrow" },
  ];
  for (const t of coreTools) {
    out.push({ title: "Use " + t.title + " tool", hint: "Tool", run: () => apiRef.ui.setTool(t.id) });
  }
  for (const t of apiRef.ui.listTools()) {
    out.push({ title: "Use " + t.title + " tool", hint: t.pluginName, run: () => apiRef.ui.setTool(t.id) });
  }

  // Core actions the API can reach. Group, Ungroup and Delete
  // only appear when they can actually do something, so the
  // palette never lists an action that silently does nothing.
  const selected = apiRef.board.getSelected();
  const items = apiRef.board.getItems();
  const hasGrouped = selected.some((id) => {
    const it = items.find((i) => i.id === id);
    return it && it.group !== null && it.group !== undefined;
  });
  const zoom = (factor) => {
    const cam = apiRef.view.getCamera();
    apiRef.view.setCamera({ x: cam.x, y: cam.y, zoom: cam.zoom * factor });
  };
  const actions = [
    { title: "Zoom in", run: () => zoom(1.2) },
    { title: "Zoom out", run: () => zoom(1 / 1.2) },
    { title: "Reset view", run: () => apiRef.view.setCamera({ x: 0, y: 0, zoom: 1 }) },
  ];
  // Undo and Redo only appear when they can do something, like
  // Group and Delete below: the palette never lists a dead action.
  if (apiRef.board.canUndo()) actions.push({ title: "Undo", run: () => apiRef.board.undo() });
  if (apiRef.board.canRedo()) actions.push({ title: "Redo", run: () => apiRef.board.redo() });
  if (selected.length >= 2) actions.push({ title: "Group selection", run: () => apiRef.board.groupSelected() });
  if (hasGrouped) actions.push({ title: "Ungroup selection", run: () => apiRef.board.ungroupSelected() });
  if (selected.length >= 1) actions.push({ title: "Delete selection", run: () => apiRef.board.deleteSelected() });
  actions.push(
    { title: "Open Settings", run: () => apiRef.ui.openSettings() },
    { title: "Minimise board", run: () => apiRef.window.minimise().catch(() => undefined) },
    {
      title: "Hide board",
      run: () => {
        // Same order Hide uses: commit, save, then hide, so an
        // open note edit is not lost behind the peek icon.
        apiRef.board.commitEditing();
        apiRef.board.save();
        apiRef.window.hide().catch(() => undefined);
      },
    },
  );
  for (const a of actions) out.push({ title: a.title, hint: "Action", run: a.run });

  return out;
}

function renderList() {
  const q = input.value.trim().toLowerCase();
  filtered = q === ""
    ? entries.slice()
    : entries.filter((e) => (e.title + " " + e.hint).toLowerCase().includes(q));
  if (selectedIdx >= filtered.length) selectedIdx = Math.max(0, filtered.length - 1);
  if (filtered.length === 0) selectedIdx = -1;
  listEl.innerHTML = "";
  if (filtered.length === 0) {
    const row = document.createElement("div");
    row.className = "cmd-row cmd-empty";
    row.textContent = "No commands match";
    listEl.appendChild(row);
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
      for (const sib of listEl.querySelectorAll(".cmd-row")) sib.classList.remove("active");
      row.classList.add("active");
    });
    row.addEventListener("click", () => runSelected());
    listEl.appendChild(row);
  });
}

function moveSelection(delta) {
  if (filtered.length === 0) return;
  selectedIdx = (selectedIdx + delta + filtered.length) % filtered.length;
  const rows = listEl.querySelectorAll(".cmd-row");
  rows.forEach((r, i) => r.classList.toggle("active", i === selectedIdx));
  const active = rows[selectedIdx];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function open() {
  if (isOpen || !root) return;
  // Opening from Settings' Run button must not leave the palette
  // hidden behind the Settings sheet: close Settings first.
  if (apiRef.ui.isSettingsOpen()) apiRef.ui.closeSettings();
  entries = buildEntries();
  selectedIdx = 0;
  isOpen = true;
  root.style.display = "";
  input.value = "";
  renderList();
  input.focus();
  window.addEventListener("pointerdown", onPointerDown, true);
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  root.style.display = "none";
  window.removeEventListener("pointerdown", onPointerDown, true);
  input.blur();
}

function runSelected() {
  if (selectedIdx < 0 || selectedIdx >= filtered.length) return;
  const entry = filtered[selectedIdx];
  close();
  try {
    const r = entry.run();
    if (r instanceof Promise) r.catch((e) => apiRef.ui.toast("Command failed: " + String(e)));
  } catch (e) {
    apiRef.ui.toast("Command failed: " + String(e));
  }
}

function onPointerDown(e) {
  if (!isOpen) return;
  if (dialog.contains(e.target)) return;
  close();
  e.preventDefault();
  e.stopPropagation();
}

function onKeyDown(e) {
  const isK = e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey);
  if (isK) {
    if (isOpen) {
      close();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Do not steal keys while editing a note or while Settings
    // is open: the core's own shortcuts are blocked there too.
    const active = document.activeElement;
    if ((active && active.tagName === "TEXTAREA") || apiRef.ui.isSettingsOpen()) return;
    open();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!isOpen) return;
  // Modal: no board shortcut may fire while the palette is open.
  e.stopPropagation();
  if (e.key === "Escape") {
    close();
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

function initOverlay(container) {
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

export function activate(api) {
  apiRef = api;
  api.ui.registerOverlay({
    id: "palette",
    render: (container) => initOverlay(container),
  });
  api.ui.registerCommand({
    id: "open",
    title: "Open command palette",
    run: () => open(),
  });
  window.addEventListener("keydown", onKeyDown, true);
}

export function deactivate() {
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("pointerdown", onPointerDown, true);
  apiRef = null;
  root = null;
  dialog = null;
  input = null;
  listEl = null;
  isOpen = false;
}
