// core-toolbar: the toolbar (tools, pen palette, shape picker,
// note colours, zoom, delete, settings) as a first-party plugin,
// wired through the PluginContext only.

import type { PluginContext, PluginManifest } from "../plugins/host";
import { placeNoteBar } from "./overlay-placement";
import { CONNECTOR_TOOL_ID, drawKindOf, drawToolId, isDrawToolId, isShapeToolId, shapeKindOf, shapeToolId, type DrawKind } from "./drawing-tools";

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
  lasso: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 3.5a5.5 5.5 0 1 1-5.5 5.5c0-1.9 1.3-3.2 3.1-3.2 1.9 0 3.2 1.3 3.2 3.2s-1.3 3.2-3.2 3.2-3.1-1.3-3.1-3.1" fill="none"/><path d="M9 14.5 5.5 20.5" /></svg>',
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

  function toolButton(id: string, title: string, label: string, icon: string, onClick: () => void, parent: HTMLElement = toolsSeg, opts: { className?: string; type?: "button" | "reset" | "submit"; text?: string } = {}): HTMLButtonElement {
    const b = document.createElement("button");
    b.id = id;
    b.title = title;
    b.setAttribute("aria-label", label);
    if (opts.text !== undefined) b.textContent = opts.text;
    else b.innerHTML = icon;
    if (opts.className) b.className = opts.className;
    if (opts.type) b.type = opts.type;
    // A clicked button keeps DOM focus, and after any
    // keypress it matches :focus-visible, so the accent
    // outline lands on the last-used tool. Blur it, so
    // focus returns to the board and the outline only
    // ever shows for genuine keyboard focus (Tab, Ctrl+T).
    b.addEventListener("click", () => { onClick(); b.blur(); });
    parent.appendChild(b);
    return b;
  }

  function swatchButton(hex: string, onClick: () => void, pressed = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.style.background = hex;
    b.title = hex;
    b.setAttribute("aria-label", hex);
    b.setAttribute("aria-pressed", String(pressed));
    // As the tool buttons: a clicked swatch must not keep
    // focus, or the next keypress outlines it.
    b.addEventListener("click", () => { onClick(); b.blur(); });
    return b;
  }

  // One select button for plain select and lasso, like the
  // draw button: it shows the selection mode last chosen,
  // and the flyout beside the toolbar chooses between them.
  // Its icon and title follow the current mode.
  const SELECT_MODES = [
    { id: "select", label: "Select (V)", icon: ICONS.select },
    { id: "lasso", label: "Lasso (V)", icon: ICONS.lasso },
  ] as const;
  const selectBtn = toolButton("tool-select", "Select (V)", "Select", ICONS.select, () => { pickerOpen = "select"; api.ui.setTool("select"); });
  // One draw button for pen and eraser, like the
  // shape button: it shows the draw tool last chosen, and
  // the flyout beside the toolbar chooses between them.
  // Its icon and title follow the current draw tool.
  // Pencil, highlighter and every other style live in
  // the Brush Library, which configures the pen.
  const DRAW_TOOLS = [
    { id: "pen", label: "Pen (P)", icon: ICONS.pen, key: "P" },
    { id: "eraser", label: "Eraser (X)", icon: ICONS.eraser, key: "X" },
  ] as const;
  const drawBtn = toolButton("tool-draw", "Pen (P)", "Pen", ICONS.pen, () => {
    // Opening the draw picker dismisses the colour bar, or
    // the picker would stay hidden behind it.
    pickerOpen = "draw";
    colorBarOpen = false;
    const cur = api.ui.getTool();
    const isDraw = isDrawToolId(cur);
    api.ui.setTool(isDraw ? cur : drawToolId((drawBtn.dataset.draw as DrawKind | undefined) ?? "pen"));
  });
  const connectorBtn = toolButton("tool-connector", "Arrow (A)", "Arrow", ICONS.connector, () => api.ui.setTool(CONNECTOR_TOOL_ID));
  // The shape button shows the shape last chosen, and the
  // flyout beside the toolbar chooses between all shapes.
  // Its icon and title follow the current shape.
  const shapeBtn = toolButton("tool-shape", "Shape (R, more in the flyout)", "Shape", ICONS.select, () => {
    pickerOpen = "shape";
    const cur = api.ui.getTool();
    // Clicking the shape button (re)activates the last shape.
    const shapes = api.shapes.list();
    const isShape = isShapeToolId(cur);
    api.ui.setTool(isShape ? cur : shapeToolId(shapes[0]?.kind ?? "rect"));
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

  // The colour in use, as a swatch in the toolbar.
  // Clicking it opens the colour bar to change colours.
  // It lives at the end of the tools, after the shape
  // button, so the tool buttons stay together.
  const colorSwatch = toolButton("tool-colour", "Colour — change the pen colour", "Colour", "", () => {
    colorBarOpen = !colorBarOpen;
    update();
  }, toolsSeg, { className: "colour-swatch", type: "button" });

  const shapePicker = document.createElement("div");
  shapePicker.className = "palette";
  shapePicker.id = "shape-picker";
  shapePicker.style.display = "none";
  toolbar.appendChild(shapePicker);

  // The draw picker: pen and eraser, beside the
  // draw button. It shows when a draw tool is active.
  const drawPicker = document.createElement("div");
  drawPicker.className = "palette";
  drawPicker.id = "draw-picker";
  drawPicker.style.display = "none";
  toolbar.appendChild(drawPicker);

  // The select picker: plain select and lasso, beside the
  // select button (the first tool, so the default top of
  // 12px already puts it there). It shows when the select
  // tool is active.
  const selectPicker = document.createElement("div");
  selectPicker.className = "palette";
  selectPicker.id = "select-picker";
  selectPicker.style.display = "none";
  toolbar.appendChild(selectPicker);

  // The note-colours bar: a floating bar that sits next
  // to the selected text note, not in the toolbar. It is
  // positioned in screen coordinates (see update), so it
  // stays a usable size at any zoom and tracks the note
  // as the board pans. Clicking a colour sets the
  // background of every selected text note, in one undo
  // step. It lives on the body, outside the board, so
  // clicking it never starts a drag or deselects.
  const noteBar = document.createElement("div");
  noteBar.className = "note-colour-bar";
  noteBar.id = "note-colours";
  noteBar.style.display = "none";
  noteBar.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.body.appendChild(noteBar);

  const div1 = document.createElement("div");
  div1.className = "divider";
  toolbar.appendChild(div1);

  const zoomGroup = document.createElement("div");
  zoomGroup.className = "zoom-group";
  toolbar.appendChild(zoomGroup);

  toolButton("zoom-out", "Zoom out (-)", "Zoom out", ICONS.zoomOut, () => api.view.zoomBy(1 / 1.2), zoomGroup);

  // The zoom level, as live state between the zoom buttons.
  // Clicking it resets the view, the same as pressing 0.
  const zoomLabel = toolButton("zoom-label", "Zoom level — reset the view (0)", "Zoom level, reset the view", "", () => api.view.setCamera({ x: 0, y: 0, zoom: 1 }), zoomGroup, { className: "zoom-label", type: "button", text: "100%" });

  toolButton("zoom-in", "Zoom in (+)", "Zoom in", ICONS.zoomIn, () => api.view.zoomBy(1.2), zoomGroup);

  const div2 = document.createElement("div");
  div2.className = "divider";
  toolbar.appendChild(div2);

  const delBtn = toolButton("btn-delete", "Delete selection (Delete)", "Delete", ICONS.delete, () => { api.board.deleteSelected(); }, toolbar);

  toolButton("btn-settings", "Settings (?)", "Settings", ICONS.settings, () => {
    if (api.ui.isSettingsOpen()) api.ui.closeSettings(); else api.ui.openSettings();
  }, toolbar);

  // The toolbar lives in the board area, beside the cards
  // layer. The core's shell mounts it here; the plugin
  // appends it to the board area element the API provides.
  api.ui.boardEl.appendChild(wrap);

  // ---- toolbar state ----
  // The first selected text note, or null when none is
  // selected. The note-colours bar shows only then, and
  // sits next to this note.
  // The buttons store the short kind (pen, triangle) in
  // their datasets; the tool itself is the plugin's full id.
  function selectedNote(): { id: number; bg: string } | null {
    const selected = api.board.getSelected();
    for (const id of selected) {
      const it = api.board.getItem(id);
      if (it && "Text" in it.kind) return { id, bg: (it.kind as { Text: { bg?: string } }).Text.bg ?? "#FFFFFF" };
    }
    return null;
  }

  // Whether the colour bar is open. It opens only when
  // the colour swatch is clicked, and closes when it is
  // clicked again or a colour is picked. While it is open
  // the pickers hide, so only one flyout shows.
  let colorBarOpen = false;
  // Which tool's flyout is open, or null when none is. A
  // flyout only appears on a tool button click or a tool
  // shortcut, and disappears once a tool is picked from it
  // or the user clicks anywhere else — it never stays open
  // while the user works with the tool.
  let pickerOpen: "select" | "draw" | "shape" | null = null;
  // The tool at the last update. A tool change dismisses
  // the colour bar, or the draw picker would stay hidden
  // behind it when the user switches tools by keyboard.
  let lastTool = "";

  let lastKey = "";
  function update(): void {
    const tool = api.ui.getTool();
    if (tool !== lastTool) {
      colorBarOpen = false;
      lastTool = tool;
    }
    const selected = api.board.getSelected();
    const penColor = api.pen.getColor();
    const note = selectedNote();
    const noteBg = note?.bg ?? null;
    const cam = api.view.getCamera();
    const zoom = cam.zoom;
    const outline = api.shapes.getOutline();
    // The note's position is in the key, so the colours
    // bar follows it when it is moved, not only when the
    // selection or the camera changes. The camera's pan
    // offset is in the key too: panning moves the note
    // on screen without changing its board position or
    // the zoom, and the bar must follow that as well — it
    // is attached to the note, so it moves with it
    // through a drag, a pan or a zoom.
    const noteItem = note ? api.board.getItem(note.id) : null;
    const notePos = noteItem ? api.geometry.itemBounds(noteItem)[0] : null;
    // The selection mode is in the key too: switching
    // between select and lasso leaves the tool as "select",
    // so without it the button and picker would not refresh.
    const mode = api.ui.getSelectMode();
    const key = `${tool}|${mode}|${pickerOpen ?? ""}|${selected.join(",")}|${penColor}|${noteBg ?? ""}|${zoom}|${cam.x},${cam.y}|${colorBarOpen}|${outline}|${notePos ? `${notePos.x},${notePos.y}` : ""}`;
    if (key === lastKey) return;
    lastKey = key;

    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

    const setActive = (el: HTMLElement, on: boolean) => el.classList.toggle("active", on);

    // The select button shows the selection mode in use.
    const isSelect = tool === "select";
    setActive(selectBtn, isSelect);
    const modeTarget = isSelect
      ? SELECT_MODES.find((m) => m.id === mode)
      : (!selectBtn.dataset.mode ? SELECT_MODES.find((m) => m.id === "select") : undefined);
    if (modeTarget && selectBtn.dataset.mode !== modeTarget.id) {
      selectBtn.dataset.mode = modeTarget.id;
      selectBtn.innerHTML = modeTarget.icon;
      selectBtn.title = modeTarget.label;
      selectBtn.setAttribute("aria-label", modeTarget.label.replace(/ \(.*\)$/, ""));
    }

    // Select picker: shown when the select tool is active,
    // the colour bar is not open, and its flyout was opened
    // by the select button or the V shortcut.
    const showSelect = isSelect && !colorBarOpen && pickerOpen === "select";
    selectPicker.style.display = showSelect ? "flex" : "none";
    // The flyout anchors to its button: the toolbar grows
    // with plugin tools, so a fixed top slides under the
    // title bar when the toolbar overflows the window.
    if (showSelect) selectPicker.style.top = `${selectBtn.offsetTop}px`;
    if (showSelect && selectPicker.childElementCount === 0) {
      for (const m of SELECT_MODES) {
        const b = document.createElement("button");
        b.className = "shape-option";
        b.dataset.mode = m.id;
        b.title = m.label;
        b.setAttribute("aria-label", m.label.replace(/ \(.*\)$/, ""));
        b.innerHTML = m.icon;
        b.addEventListener("click", () => { pickerOpen = null; api.ui.setSelectMode(m.id); b.blur(); });
        selectPicker.appendChild(b);
      }
    }
    if (showSelect) {
      for (const child of Array.from(selectPicker.children)) {
        (child as HTMLButtonElement).classList.toggle("active", (child as HTMLButtonElement).dataset.mode === mode);
      }
    }

    setActive(connectorBtn, tool === CONNECTOR_TOOL_ID);

    // The draw button shows the draw tool last chosen.
    const isDraw = isDrawToolId(tool);
    setActive(drawBtn, isDraw);
    const drawTarget = isDraw
      ? DRAW_TOOLS.find((d) => drawToolId(d.id) === tool)
      : (!drawBtn.dataset.draw ? DRAW_TOOLS.find((d) => d.id === "pen") : undefined);
    if (drawTarget && drawBtn.dataset.draw !== drawTarget.id) {
      drawBtn.dataset.draw = drawTarget.id;
      drawBtn.innerHTML = drawTarget.icon;
      drawBtn.title = drawTarget.label;
      drawBtn.setAttribute("aria-label", drawTarget.label.replace(/ \(.*\)$/, ""));
    }

    // Draw picker: shown when a draw tool is active, the
    // colour bar is not open, and its flyout was opened by
    // the draw button or the P shortcut.
    const showDraw = isDraw && !colorBarOpen && pickerOpen === "draw";
    drawPicker.style.display = showDraw ? "flex" : "none";
    if (showDraw) drawPicker.style.top = `${drawBtn.offsetTop}px`;
    if (showDraw && drawPicker.childElementCount === 0) {
      for (const d of DRAW_TOOLS) {
        const b = document.createElement("button");
        b.className = "shape-option";
        b.dataset.draw = d.id;
        b.title = d.label;
        b.setAttribute("aria-label", d.label.replace(/ \(.*\)$/, ""));
        b.innerHTML = d.icon;
        b.addEventListener("click", () => { pickerOpen = null; api.ui.setTool(drawToolId(d.id)); b.blur(); });
        drawPicker.appendChild(b);
      }
    }
    if (showDraw) {
      for (const child of Array.from(drawPicker.children)) {
        (child as HTMLButtonElement).classList.toggle("active", (child as HTMLButtonElement).dataset.draw === drawKindOf(tool));
      }
    }

    // The colour swatch shows the pen colour in use.
    colorSwatch.style.setProperty("--swatch-color", penColor);
    colorSwatch.classList.toggle("active", colorBarOpen);

    const isShape = isShapeToolId(tool);
    setActive(shapeBtn, isShape);
    // The button shows the shape last chosen. Before any
    // shape is used there is no last shape, so it starts
    // on the first shape — the one a click activates.
    // Without this it kept its initial select icon, a
    // duplicate of Select.
    const target = isShape
      ? api.shapes.list().find((s) => shapeToolId(s.kind) === tool)
      : (!shapeBtn.dataset.shape ? api.shapes.list()[0] : undefined);
    if (target && shapeBtn.dataset.shape !== target.kind) {
      shapeBtn.dataset.shape = target.kind;
      shapeBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${target.svg}</svg>`;
      shapeBtn.title = target.key ? `${target.label} (${target.key})` : target.label;
      shapeBtn.setAttribute("aria-label", target.label);
    }

    // Shape picker: shown when a shape tool is active, the
    // colour bar is not open, and its flyout was opened by
    // the shape button or the R shortcut — like the draw and
    // select pickers, so only one flyout shows at a time.
    // Two columns — filled on the left, outline on the
    // right — and no switch: picking a shape sets the fill
    // mode from its column.
    const showShape = isShape && !colorBarOpen && pickerOpen === "shape";
    shapePicker.style.display = showShape ? "flex" : "none";
    if (showShape) shapePicker.style.top = `${shapeBtn.offsetTop}px`;
    if (showShape && shapePicker.childElementCount === 0) {
      for (const mode of [{ id: "filled", outline: false }, { id: "outline", outline: true }]) {
        const column = document.createElement("div");
        column.className = "shape-column";
        for (const meta of api.shapes.list()) {
          const b = document.createElement("button");
          b.className = "shape-option";
          b.dataset.shape = meta.kind;
          b.dataset.mode = mode.id;
          b.title = meta.key ? `${meta.label} ${mode.id} (${meta.key})` : `${meta.label} ${mode.id}`;
          b.setAttribute("aria-label", `${meta.label} ${mode.id}`);
          b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${meta.svg}</svg>`;
          b.addEventListener("click", () => { pickerOpen = null; api.shapes.setOutline(mode.outline); api.ui.setTool(shapeToolId(meta.kind)); b.blur(); });
          column.appendChild(b);
        }
        shapePicker.appendChild(column);
      }
    }
    if (showShape) {
      for (const btn of Array.from(shapePicker.querySelectorAll<HTMLButtonElement>(".shape-option"))) {
        btn.classList.toggle("active", btn.dataset.shape === shapeKindOf(tool) && (btn.dataset.mode === "outline") === outline);
      }
    }

    // Note colours: shown when at least one selected card
    // is a text note and no draw tool is active. The bar
    // sits on the left side of the note, top-aligned, and
    // moves with the note: it is anchored to the note's
    // screen position, so a drag, a pan or a zoom moves
    // it together with the note. Clicking a colour sets
    // the background of every selected text note, in one
    // undo step.
    const showNotes = note !== null && !isDraw;
    noteBar.style.display = showNotes ? "flex" : "none";
    if (showNotes && noteBar.childElementCount === 0) {
      for (const hex of NOTE_COLOURS) {
        noteBar.appendChild(swatchButton(hex, () => {
          const ids = api.board.getSelected();
          api.board.setNoteBackground(ids, hex);
          update();
        }));
      }
    }
    if (showNotes) {
      for (const child of Array.from(noteBar.children)) {
        const sw = child as HTMLButtonElement;
        const active = sw.title.toUpperCase() === (noteBg ?? "#FFFFFF").toUpperCase();
        sw.classList.toggle("active", active);
        sw.setAttribute("aria-pressed", String(active));
      }
      // Position the bar beside the note, in screen
      // coordinates: the board element's rect plus the
      // camera transform of the note's world position.
      // The bar is an extension of the note card: it
      // sits on the left of the note, top-aligned with
      // it, and moves with it exactly through a drag, a
      // pan or a zoom. Where it goes is decided by
      // placeNoteBar (overlay-placement.ts), which the
      // unit tests cover: left side by default, right
      // side when the left would run off the viewport
      // or cover the toolbar, hidden when there is no
      // place to put it without covering the toolbar,
      // and hidden when the note is fully off-screen —
      // but only then, so it does not vanish the moment
      // the note starts to leave the viewport on a
      // horizontal pan.
      const item = api.board.getItem(note.id);
      if (item) {
        const [pos, size] = api.geometry.itemBounds(item);
        const cam = api.view.getCamera();
        const rect = api.ui.boardEl.getBoundingClientRect();
        const left = rect.left + (pos.x - cam.x) * cam.zoom;
        const top = rect.top + (pos.y - cam.y) * cam.zoom;
        const noteW = size.w * cam.zoom;
        const noteH = size.h * cam.zoom;
        const toolbarRect = toolbar.getBoundingClientRect();
        const placement = placeNoteBar(
          { x: left, y: top, w: noteW, h: noteH },
          { w: noteBar.offsetWidth, h: noteBar.offsetHeight },
          { x: toolbarRect.left, y: toolbarRect.top, w: toolbarRect.width, h: toolbarRect.height },
          { w: window.innerWidth, h: window.innerHeight },
        );
        if (placement.side === "hidden") {
          noteBar.style.display = "none";
        } else {
          noteBar.style.left = `${placement.x}px`;
          noteBar.style.top = `${placement.y}px`;
        }
      }
    }

    // Pen palette (the colour bar): shown only when the
    // colour swatch opened it. Picking a colour sets the
    // pen colour and closes the bar.
    palette.style.display = colorBarOpen ? "flex" : "none";
    if (colorBarOpen && palette.childElementCount === 0) {
      for (const hex of PALETTE) {
        // The sync loop below marks the active swatch, so
        // the build-time " active" class is not needed.
        palette.appendChild(swatchButton(hex, () => { api.pen.setColor(hex); colorBarOpen = false; update(); }, hex === penColor));
      }
    }
    if (colorBarOpen) {
      // A pen colour set elsewhere — Palette's wheel, for
      // example — is not one of the six fixed swatches, so
      // without this it would show no active swatch at all,
      // and the toolbar would not say what the pen is.
      // Keep at most one such custom swatch: drop a stale
      // one, add the current colour if it is not fixed.
      for (const child of Array.from(palette.children)) {
        const sw = child as HTMLButtonElement;
        if (!PALETTE.includes(sw.title) && sw.title.toUpperCase() !== penColor.toUpperCase()) sw.remove();
      }
      const hasCurrent = Array.from(palette.children).some((c) => (c as HTMLButtonElement).title.toUpperCase() === penColor.toUpperCase());
      if (!hasCurrent) {
        palette.prepend(swatchButton(penColor, () => { api.pen.setColor(penColor); colorBarOpen = false; update(); }, true));
      }
      for (const child of Array.from(palette.children)) {
        const sw = child as HTMLButtonElement;
        const active = sw.style.background === penColor || sw.title === penColor;
        sw.classList.toggle("active", active);
        sw.setAttribute("aria-pressed", String(active));
      }
    }

    delBtn.classList.toggle("dim", selected.length === 0);
  }

  // A tool shortcut opens its flyout too: the sidebar
  // appears on a tool button click or a tool shortcut, and
  // nowhere else. The core's own key handling switches the
  // tool; this only opens the flyout, so it runs either
  // before or after the core's handler and the result is
  // the same. The guards mirror the core's: no shortcuts
  // while typing in an input, while a video or audio card
  // has focus, or while Settings is open.
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "VIDEO" || active.tagName === "AUDIO")) return;
    if (api.ui.isSettingsOpen()) return;
    const k = e.key.toLowerCase();
    const target = k === "v" ? "select" : k === "p" ? "draw" : k === "r" ? "shape" : null;
    if (!target) return;
    pickerOpen = target;
    update();
  });

  // Clicking anywhere outside the tool buttons and their
  // flyouts dismisses the open flyout: the board, another
  // toolbar button, a panel, the note-colours bar. Clicks
  // inside the flyout are its own option picks, which
  // dismiss it in their handlers.
  document.addEventListener("pointerdown", (e) => {
    if (pickerOpen === null) return;
    const t = e.target as Node;
    if (selectBtn.contains(t) || drawBtn.contains(t) || shapeBtn.contains(t) || selectPicker.contains(t) || drawPicker.contains(t) || shapePicker.contains(t)) return;
    pickerOpen = null;
    update();
  });

  // Follow the tool, the selection and the pen colour.
  api.events.on("tool", update);
  api.events.on("selection", update);
  api.events.on("pen", update);
  // Follow the camera (zoom level) and the board content,
  // so the note-colours bar follows a note that is moved.
  // "items-moved" is the live drag: a move or resize
  // changes the note's geometry without saving, so the
  // save-time "board" event would leave the bar behind
  // until the drag ends. A camera move runs update() too
  // (for the zoom readout), but the bar's position is
  // keyed on the note, not the camera, so a pan or a zoom
  // leaves it exactly where it is on screen.
  api.events.on("camera", update);
  api.events.on("board", update);
  api.events.on("items-moved", update);
  update();
}

export function deactivate(): void {
  // The toolbar DOM is built by this plugin; removing it
  // restores the board without a toolbar (the core renders
  // nothing on its own). The note-colours bar lives on the
  // body, not in the toolbar, so it is removed too.
  document.getElementById("toolbar-wrap")?.remove();
  document.getElementById("note-colours")?.remove();
}
