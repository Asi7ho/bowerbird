// core-toolbar — the toolbar, as a first-party plugin.
// The core is headless: it owns the board model, persistence,
// the plugin host and the API, and it renders no UI of its
// own. This plugin builds the toolbar (tools, pen palette,
// shape picker, note colours, zoom, delete, settings) and
// wires it through the PluginContext only. The tool
// behaviour itself (what a drag does with the active tool)
// still lives in the core's input loop, which moves with
// core-board; this plugin owns the buttons and the flyouts,
// and activates tools through `api.ui.setTool`.
//
// The toolbar's state is the tool, the selection, the pen
// colour and the selected notes' background. It follows
// those through the plugin events ("tool", "selection",
// "pen") and refreshes its DOM only when the state key
// changes, so a render on every mousemove does not rebuild
// the toolbar for nothing.
import type { PluginContext, PluginManifest } from "../plugins";

export const manifest: PluginManifest = {
  apiVersion: "2",
  id: "core-toolbar",
  name: "Toolbar",
  version: "1.0.0",
  description: "Tools, pen, eraser, shapes, zoom, delete and settings.",
  main: "toolbar.js",
  permissions: ["board:read", "board:write", "pen"],
};

// The pen's fixed colours, and the note background colours.
// These are the toolbar's own choices, not core model data.
const PALETTE = ["#1A1A1A", "#E63946", "#2E86AB", "#FF6B35", "#6a4c93", "#2A9D8F"];
const NOTE_COLOURS = ["#FFFFFF", "#FEF3C7", "#FCE7F3", "#DCFCE7", "#DBEAFE", "#FFEDD5", "#EDE9FE", "#F3F4F6"];

const ICONS = {
  select: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5 19 12l-7.5 1.4L8.6 20.5 6 3.5Z" /></svg>',
  pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5 5.6 15 16.2 4.4a2.12 2.12 0 0 1 3 3L8.6 18l-4.1 1.5Z" fill="none"/><path d="M14.5 6.5l3 3" /></svg>',
  eraser: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" /></svg>',
  connector: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20 20 4" /><path d="M14 4h6v6" /></svg>',
  zoomOut: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>',
  zoomIn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" /><path d="M10 10.5v5M14 10.5v5" /></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h9M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2.2" /><circle cx="9" cy="16" r="2.2" /></svg>',
};

export function activate(api: PluginContext): void {
  // ---- build the toolbar DOM ----
  const wrap = document.createElement("div");
  wrap.id = "toolbar-wrap";
  const toolbar = document.createElement("div");
  toolbar.id = "toolbar";
  wrap.appendChild(toolbar);

  const toolsSeg = document.createElement("div");
  toolsSeg.className = "seg";
  toolsSeg.id = "tools";
  toolbar.appendChild(toolsSeg);

  function toolButton(id: string, title: string, label: string, icon: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.id = id;
    b.title = title;
    b.setAttribute("aria-label", label);
    b.innerHTML = icon;
    b.addEventListener("click", onClick);
    toolsSeg.appendChild(b);
    return b;
  }

  const selectBtn = toolButton("tool-select", "Select (V)", "Select", ICONS.select, () => api.ui.setTool("select"));
  const penBtn = toolButton("tool-pen", "Pen (P)", "Pen", ICONS.pen, () => api.ui.setTool("pen"));
  const eraserBtn = toolButton("tool-eraser", "Eraser (X)", "Eraser", ICONS.eraser, () => api.ui.setTool("eraser"));
  const connectorBtn = toolButton("tool-connector", "Arrow (A)", "Arrow", ICONS.connector, () => api.ui.setTool("connector"));
  // The shape button shows the shape last chosen, and the
  // flyout beside the toolbar chooses between all shapes.
  // Its icon and title follow the current shape.
  const shapeBtn = toolButton("tool-shape", "Shape (R for rectangle, E for ellipse, more in the flyout)", "Shape", ICONS.select, () => {
    const cur = api.ui.getTool();
    // Clicking the shape button (re)activates the last shape.
    const shapes = api.shapes.list();
    const isShape = shapes.some((s) => s.kind === cur);
    api.ui.setTool(isShape ? cur : shapes[0]?.kind ?? "rect");
  });

  // The plugin system adds plugin tool buttons to this
  // segment (the #tools div). Register it now, so tools
  // registered by user plugins land beside the core tools.
  api.ui.setToolbarToolsEl(toolsSeg);

  const palette = document.createElement("div");
  palette.className = "palette";
  palette.id = "palette";
  palette.style.display = "none";
  toolbar.appendChild(palette);

  const shapePicker = document.createElement("div");
  shapePicker.className = "palette";
  shapePicker.id = "shape-picker";
  shapePicker.style.display = "none";
  toolbar.appendChild(shapePicker);

  const noteEl = document.createElement("div");
  noteEl.className = "palette";
  noteEl.id = "note-colours";
  noteEl.style.display = "none";
  toolbar.appendChild(noteEl);

  const div1 = document.createElement("div");
  div1.className = "divider";
  toolbar.appendChild(div1);

  const zoomGroup = document.createElement("div");
  zoomGroup.className = "zoom-group";
  toolbar.appendChild(zoomGroup);

  const zoomOut = document.createElement("button");
  zoomOut.id = "zoom-out";
  zoomOut.title = "Zoom out (-)";
  zoomOut.setAttribute("aria-label", "Zoom out");
  zoomOut.innerHTML = ICONS.zoomOut;
  zoomOut.addEventListener("click", () => api.view.zoomBy(1 / 1.2));
  zoomGroup.appendChild(zoomOut);

  const zoomIn = document.createElement("button");
  zoomIn.id = "zoom-in";
  zoomIn.title = "Zoom in (+)";
  zoomIn.setAttribute("aria-label", "Zoom in");
  zoomIn.innerHTML = ICONS.zoomIn;
  zoomIn.addEventListener("click", () => api.view.zoomBy(1.2));
  zoomGroup.appendChild(zoomIn);

  const div2 = document.createElement("div");
  div2.className = "divider";
  toolbar.appendChild(div2);

  const delBtn = document.createElement("button");
  delBtn.id = "btn-delete";
  delBtn.title = "Delete selection (Delete)";
  delBtn.setAttribute("aria-label", "Delete");
  delBtn.innerHTML = ICONS.delete;
  delBtn.addEventListener("click", () => { api.board.deleteSelected(); });
  toolbar.appendChild(delBtn);

  const settingsBtn = document.createElement("button");
  settingsBtn.id = "btn-settings";
  settingsBtn.title = "Settings (?)";
  settingsBtn.setAttribute("aria-label", "Settings");
  settingsBtn.innerHTML = ICONS.settings;
  settingsBtn.addEventListener("click", () => {
    if (api.ui.isSettingsOpen()) api.ui.closeSettings(); else api.ui.openSettings();
  });
  toolbar.appendChild(settingsBtn);

  // The toolbar lives in the board area, beside the cards
  // layer. The core's shell mounts it here; the plugin
  // appends it to the board area element the API provides.
  api.ui.boardEl.appendChild(wrap);

  // ---- toolbar state ----
  // The background of the selected text notes (the first
  // one found), or null when no text note is selected.
  // The note-colours flyout shows only then.
  function noteBgOfSelected(): string | null {
    const items = api.board.getItems();
    const selected = api.board.getSelected();
    for (const id of selected) {
      const it = items.find((i) => i.id === id);
      if (it && "Text" in it.kind) return (it.kind as { Text: { bg?: string } }).Text.bg ?? "#FFFFFF";
    }
    return null;
  }

  function isShapeTool(t: string): boolean {
    return api.shapes.list().some((s) => s.kind === t);
  }

  let lastKey = "";
  function update(): void {
    const tool = api.ui.getTool();
    const selected = api.board.getSelected();
    const penColor = api.pen.getColor();
    const noteBg = noteBgOfSelected();
    const key = `${tool}|${selected.join(",")}|${penColor}|${noteBg ?? ""}`;
    if (key === lastKey) return;
    lastKey = key;

    const setActive = (el: HTMLElement, on: boolean) => el.classList.toggle("active", on);
    setActive(selectBtn, tool === "select");
    setActive(penBtn, tool === "pen");
    setActive(eraserBtn, tool === "eraser");
    setActive(connectorBtn, tool === "connector");

    const isShape = isShapeTool(tool);
    setActive(shapeBtn, isShape);
    if (isShape) {
      const meta = api.shapes.list().find((s) => s.kind === tool);
      if (meta && shapeBtn.dataset.shape !== tool) {
        shapeBtn.dataset.shape = tool;
        shapeBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${meta.svg}</svg>`;
        shapeBtn.title = meta.key ? `${meta.label} (${meta.key})` : meta.label;
        shapeBtn.setAttribute("aria-label", meta.label);
      }
    } else if (!shapeBtn.dataset.shape) {
      // Before any shape is used there is no last shape, so
      // the button starts on the first shape — the one a
      // click activates. Without this it kept its initial
      // select icon, a duplicate of Select.
      const first = api.shapes.list()[0];
      if (first) {
        shapeBtn.dataset.shape = first.kind;
        shapeBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${first.svg}</svg>`;
        shapeBtn.title = first.key ? `${first.label} (${first.key})` : first.label;
        shapeBtn.setAttribute("aria-label", first.label);
      }
    }

    // Shape picker: shown when a shape tool is active.
    shapePicker.style.display = isShape ? "flex" : "none";
    if (isShape && shapePicker.childElementCount === 0) {
      for (const meta of api.shapes.list()) {
        const b = document.createElement("button");
        b.className = "shape-option";
        b.dataset.shape = meta.kind;
        b.title = meta.key ? `${meta.label} (${meta.key})` : meta.label;
        b.setAttribute("aria-label", meta.label);
        b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${meta.svg}</svg>`;
        b.addEventListener("click", () => api.ui.setTool(meta.kind));
        shapePicker.appendChild(b);
      }
    }
    if (isShape) {
      for (const child of Array.from(shapePicker.children)) {
        (child as HTMLButtonElement).classList.toggle("active", (child as HTMLButtonElement).dataset.shape === tool);
      }
    }

    // Note colours: shown when at least one selected card
    // is a text note and the pen flyout is not showing.
    // Clicking a colour sets the background of every
    // selected text note, in one undo step.
    const showNotes = noteBg !== null && tool !== "pen";
    noteEl.style.display = showNotes ? "flex" : "none";
    if (showNotes && noteEl.childElementCount === 0) {
      for (const hex of NOTE_COLOURS) {
        const b = document.createElement("div");
        b.className = "swatch";
        b.style.background = hex;
        b.title = hex;
        b.addEventListener("click", () => {
          const ids = api.board.getSelected();
          api.board.setNoteBackground(ids, hex);
          update();
        });
        noteEl.appendChild(b);
      }
    }
    if (showNotes) {
      for (const child of Array.from(noteEl.children)) {
        const sw = child as HTMLDivElement;
        sw.classList.toggle("active", sw.title.toUpperCase() === (noteBg ?? "#FFFFFF").toUpperCase());
      }
    }

    // Pen palette: shown when the pen tool is active.
    palette.style.display = tool === "pen" ? "flex" : "none";
    if (tool === "pen" && palette.childElementCount === 0) {
      for (const hex of PALETTE) {
        const b = document.createElement("div");
        b.className = "swatch" + (hex === penColor ? " active" : "");
        b.style.background = hex;
        b.title = hex;
        b.addEventListener("click", () => { api.pen.setColor(hex); });
        palette.appendChild(b);
      }
    }
    if (tool === "pen") {
      // A pen colour set elsewhere — Palette's wheel, for
      // example — is not one of the six fixed swatches, so
      // without this it would show no active swatch at all,
      // and the toolbar would not say what the pen is.
      // Keep at most one such custom swatch: drop a stale
      // one, add the current colour if it is not fixed.
      for (const child of Array.from(palette.children)) {
        const sw = child as HTMLDivElement;
        if (!PALETTE.includes(sw.title) && sw.title.toUpperCase() !== penColor.toUpperCase()) sw.remove();
      }
      const hasCurrent = Array.from(palette.children).some((c) => (c as HTMLDivElement).title.toUpperCase() === penColor.toUpperCase());
      if (!hasCurrent) {
        const b = document.createElement("div");
        b.className = "swatch";
        b.style.background = penColor;
        b.title = penColor;
        b.addEventListener("click", () => { api.pen.setColor(penColor); });
        palette.prepend(b);
      }
      for (const child of Array.from(palette.children)) {
        const sw = child as HTMLDivElement;
        sw.classList.toggle("active", sw.style.background === penColor || sw.title === penColor);
      }
    }

    delBtn.classList.toggle("dim", selected.length === 0);
  }

  // Follow the tool, the selection and the pen colour.
  api.events.on("tool", update);
  api.events.on("selection", update);
  api.events.on("pen", update);
  update();
}

export function deactivate(): void {
  // The toolbar DOM is built by this plugin; removing it
  // restores the board without a toolbar (the core renders
  // nothing on its own).
  document.getElementById("toolbar-wrap")?.remove();
}
