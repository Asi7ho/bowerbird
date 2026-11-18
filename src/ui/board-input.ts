// The board's input loop: the zoom and eraser helpers, text and
// group editing, the tools (select/pen/connector/eraser/shape,
// group/ungroup/delete/rotate/navigate), and the pointer and
// keyboard listeners that drive pan, drag, resize/rotate,
// stroke, lasso, marquee and connector drags. Input calls the
// render functions in board-render and reads S from board-state;
// it is the last module board.ts itself wires up.
import {
  S,
  ACCENT, ERASER_RADIUS,
  boardPoint, boardSize, isFrameCard, toWorld,
  type Tool,
} from "./board-state";
import { groupBounds, isRotatable, membersBounds, normAngle, rotateAngleFor, rotateHandleWorld, svgEl2 } from "./board-geometry";
import {
  applyCamera, applyStacking, refreshContentIfVisibleChanged, render, renderSvgOnly, updateResizeHandle, updateSelection,
} from "./board-render";
import {
  Anchor, Item, Pt, ShapeKind,
  isInlineVideo, pressureWidth, rectFromPoints, smoothStrokePath, smoothStrokePressures, smoothStrokeSamples, splitStrokeByEraser, strokeMaxWidth, strokePressuresVary,
  zoomCamera,
} from "../backend/model";
import { fitModel3DView } from "../backend/model3d";
import { measureNoteCardHeight } from "./text-measure";

// The fallback icon for a creation action that offers
// none of its own, shown beside the text box.
const MIC_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>`;

// ---------------------------------------------------------------- helpers

export function zoomAt(screen: Pt, factor: number): void {
  S.api.view.setCameraSilent(zoomCamera(S.api.view.getCamera(), screen, factor));
}
export function zoomCentre(factor: number): void {
  const s = boardSize();
  zoomAt({ x: s.x / 2, y: s.y / 2 }, factor);
}
// F: zoom to fit — every item on screen at once. A no-op on
// an empty board. Like the 0 reset, this only moves the view;
// it does not save.
export function zoomToFit(): void {
  const bs = boardSize();
  const cam = S.api.geometry.fitCamera({ w: bs.x, h: bs.y });
  if (cam) S.api.view.setCamera(cam);
}

export function ensureEraserRing(): HTMLDivElement {
  if (!S.eraserRing) {
    S.eraserRing = document.createElement("div");
    S.eraserRing.id = "eraser-ring";
    document.body.appendChild(S.eraserRing);
  }
  return S.eraserRing;
}
export function updateEraserRing(clientX: number, clientY: number, show: boolean): void {
  const ring = ensureEraserRing();
  if (!show) { ring.style.display = "none"; return; }
  const d = ERASER_RADIUS * 2 * S.api.view.getCamera().zoom;
  ring.style.display = "block";
  ring.style.width = `${d}px`;
  ring.style.height = `${d}px`;
  ring.style.left = `${clientX - d / 2}px`;
  ring.style.top = `${clientY - d / 2}px`;
}
// Erase the ink the eraser touches at this point, the
// way a pen draws: only the part under the eraser goes,
// and a stroke it passes through breaks into the pieces
// either side. Returns true when at least one stroke
// changed. The board is not saved here: the drag saves
// once, on mouseup, so a whole sweep is one undo step —
// the new pieces are added silent, like the removed
// stroke was, and only the SVG layer is rebuilt.
export function eraseAt(world: Pt): boolean {
  const ids = S.api.board.strokesNear(world, ERASER_RADIUS);
  if (ids.length === 0) return false;
  let changed = false;
  for (const id of ids) {
    const it = S.api.board.getItem(id);
    if (!it || !("Stroke" in it.kind)) continue;
    const st = it.kind.Stroke;
    const runs = splitStrokeByEraser(st.points, st.pressures, world, ERASER_RADIUS, strokeMaxWidth(st) / 2);
    S.api.board.removeItems([id]);
    for (const run of runs) {
      const xs = run.points.map((p) => p.x), ys = run.points.map((p) => p.y);
      const pos = { x: Math.min(...xs), y: Math.min(...ys) };
      const size = { w: Math.max(1, Math.max(...xs) - pos.x), h: Math.max(1, Math.max(...ys) - pos.y) };
      S.api.board.addItemSilent(
        { Stroke: { points: run.points, color: st.color, width: st.width, marker: st.marker, ...(run.pressures && run.pressures.length > 0 ? { pressures: run.pressures } : {}), ...(st.pencil ? { pencil: true } : {}) } },
        pos, size,
      );
    }
    changed = true;
  }
  if (changed) renderSvgOnly();
  return changed;
}

// ---------------------------------------------------------------- editing

export function createTextNoteAt(world: Pt): void {
  const id = S.api.board.addItemSilent({ Text: { text: "", bold: false, size: 16, color: "#1A1A1A" } }, world, { w: 260, h: 48 });
  // No save here: the commit saves the typed text, or
  // removes the note if it is empty, so an empty note
  // leaves no board change and no undo step behind.
  startTextEdit(id, true);
}

export function startTextEdit(id: number, isNew = false): void {
  const item = S.api.board.getItem(id);
  if (!item || !("Text" in item.kind)) return;
  // Render first, then mark the note as editing: render() skips
  // the editing note, so setting editingId before it would
  // leave a brand-new note with no card in the DOM to edit —
  // double-clicking empty space created a note that only
  // appeared after the next click. A later render preserves
  // the textarea through editingHtml, as before.
  render();
  S.editingId = id;
  const card = S.cardsEl.querySelector(`[data-id="${id}"]`);
  if (!card) { S.editingId = null; return; }
  const { size } = item.kind.Text;
  const ta = document.createElement("textarea");
  ta.className = "note-edit";
  ta.value = item.kind.Text.text;
  ta.style.fontSize = `${size}px`;
  ta.style.color = item.kind.Text.color;
  // A creation action is offered on the left of the text
  // box, as its icon — but only on a new note. Editing an
  // existing note is for typing, not for starting a
  // recording, so the mic never appears there. The user
  // types, or clicks the icon instead. The first
  // registered action is the one shown (today that is the
  // voice plugin's mic). Clicking it commits the note
  // first — an empty note is removed, typed text is kept —
  // then runs the action at the note's position (the
  // double-click point for a new note).
  const row = document.createElement("div");
  row.className = "note-edit-row";
  const actions = S.api.ui.listCreateActions();
  if (isNew && actions.length > 0) {
    const a = actions[0];
    const mic = document.createElement("button");
    mic.type = "button";
    mic.className = "note-edit-mic";
    mic.setAttribute("aria-label", a.label);
    mic.title = a.label;
    if (a.icon) {
      if (/<script/i.test(a.icon)) throw new Error("Create action icon contains <script>");
      mic.innerHTML = a.icon;
    } else {
      mic.innerHTML = MIC_SVG;
    }
    // Without this the board's pointerdown handler commits
    // the edit and re-renders, destroying the button before
    // its click ever fires.
    mic.addEventListener("pointerdown", (e) => e.stopPropagation());
    // And without this the click moves focus off the text
    // box, whose blur commits the edit and re-renders —
    // again destroying the button before its click fires.
    // The button never takes focus; the click still runs.
    mic.addEventListener("mousedown", (e) => e.preventDefault());
    mic.addEventListener("click", () => {
      const it = S.api.board.getItem(id);
      if (!it) return;
      const point = { x: it.pos.x, y: it.pos.y };
      commitEditingIfAny();
      try {
        void a.run(point);
      } catch (e) {
        S.api.ui.toast(`Could not start ${a.label}: ${String(e)}`);
      }
    });
    row.appendChild(mic);
  }
  row.appendChild(ta);
  card.innerHTML = "";
  card.appendChild(row);
  card.classList.add("selected");
  // The card's decorations (checklist progress) are from
  // the render before editing started; they sit over the
  // text box and would cover the mic on its left. They
  // come back on the next render.
  S.cardsEl.querySelector(`.card-decorations[data-for="${id}"]`)?.remove();
  S.cardsEl.querySelector(`.card-decorations-right[data-for="${id}"]`)?.remove();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  // Grow the note as you type: the card's height follows
  // the text, measured from the text as rendered (see
  // text-measure.ts), so the note never jumps when the
  // edit ends and no empty space grows at its bottom.
  // Without this the text box stays at the card's
  // creation height and the text just scrolls inside it.
  const grow = () => {
    const h = measureNoteCardHeight(ta.value, size, item.size.w);
    (card as HTMLElement).style.height = `${h}px`;
  };
  ta.addEventListener("input", grow);
  grow();
  const commit = () => {
    if (S.editingId !== id) return;
    // A render moves the editing card out of #cards and back,
    // which blurs the textarea; the blur must not commit the
    // edit mid-render (see suppressEditCommit). The render
    // restores focus afterwards, so the user keeps typing.
    if (S.suppressEditCommit) return;
    const text = ta.value;
    // An empty note is not a note: double-clicking empty
    // space creates a text box, and if nothing is typed
    // before it is committed, it must vanish, not stay as
    // a blank card on the board. Whitespace only counts
    // as empty. Removing here is undoable, like any edit.
    if (text.trim() === "") {
      // Remove without saving, then save once: the empty
      // note leaves no board change and no undo step.
      S.api.board.removeItems([id]);
      S.editingId = null;
      S.api.board.save();
      render();
      return;
    }
    S.api.board.setTextContent(id, text);
    S.editingId = null;
    S.api.board.save();
    render();
  };
  ta.addEventListener("blur", commit);
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); ta.blur(); }
  });
  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
}

// Rename a group's section label, in place on its frame.
// Double-clicking the label swaps it for an input; Enter
// or leaving the field commits (one undo step), Escape
// cancels. The input is a real input element, so the
// board's pointer and key handlers leave it alone: the
// pointerdown guard ignores inputs, and typing in one
// never triggers board shortcuts.
// Wire a rename input: Enter or leaving the field
// commits, Escape cancels, and only the first of
// commit/cancel runs. Shared by section-label and
// voice-note renames.
export function wireRenameInput(input: HTMLInputElement, onCommit: () => void): void {
  input.focus();
  input.select();
  let done = false;
  const commit = () => { if (done) return; done = true; onCommit(); render(); };
  const cancel = () => { if (done) return; done = true; render(); };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
  });
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
}

export function startGroupRename(group: number): void {
  const board = S.api.board.get();
  const label = board.groups?.[group]?.label ?? `Section ${group}`;
  const chip = S.groupsEl.querySelector(`.group-label[data-group="${group}"]`) as HTMLElement | null;
  if (!chip) return;
  const input = document.createElement("input");
  input.className = "group-rename";
  input.value = label;
  input.setAttribute("aria-label", "Section name");
  input.style.width = `${Math.max(8, label.length + 2)}ch`;
  chip.textContent = "";
  chip.appendChild(input);
  wireRenameInput(input, () => {
    if (input.value.trim() !== "" && input.value !== label) S.api.board.setGroupLabel(group, input.value);
  });
}

// Is the click on a voice note's name? The card itself
// has pointer-events: none (only its controls take
// clicks), so a click on the name reaches the board as a
// #cards target — the DOM target cannot say which part of
// the card was clicked. The title's screen rect can.
export function audioTitleHit(id: number, clientX: number, clientY: number): boolean {
  const titleEl = S.cardsEl.querySelector(`.card[data-id="${id}"] .col .title`) as HTMLElement | null;
  if (!titleEl) return false;
  const r = titleEl.getBoundingClientRect();
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

// Rename a voice note: double-clicking its name swaps the
// title for an input, like a section label. Enter or
// leaving the field commits (one undo step), Escape
// cancels. An empty name clears the title, so the card
// falls back to the file's name.
export function startAudioRename(id: number): void {
  const it = S.api.board.getItem(id);
  if (!it || !("Audio" in it.kind)) return;
  const current = (it.kind.Audio.title?.trim() ?? "") || (it.kind.Audio.path.split("/").pop() ?? it.kind.Audio.path);
  const cardEl = S.cardsEl.querySelector(`.card[data-id="${id}"]`) as HTMLElement | null;
  const titleEl = cardEl?.querySelector(".col .title") as HTMLElement | null;
  if (!titleEl) return;
  const input = document.createElement("input");
  input.className = "audio-rename";
  input.value = current;
  input.setAttribute("aria-label", "Voice note name");
  titleEl.textContent = "";
  titleEl.appendChild(input);
  wireRenameInput(input, () => { S.api.board.setAudioTitle(id, input.value); });
}

export function commitEditingIfAny(): void {
  if (S.editingId === null) return;
  const ta = S.cardsEl.querySelector("textarea.note-edit") as HTMLTextAreaElement | null;
  if (ta) ta.blur();
  else { S.editingId = null; render(); }
}

// ---------------------------------------------------------------- tools

export function setTool(t: Tool): void {
  S.tool = t;
  // The draw tools share one toolbar button and one
  // shortcut (P): remember the draw tool last chosen, so
  // P activates that one instead of always the pen.
  if (t === "pen" || t === "pencil" || t === "highlighter" || t === "eraser") S.lastDrawTool = t;
  // The geometry shapes share one toolbar button and one
  // shortcut (R): remember the shape last chosen, so R
  // activates that one instead of always the rectangle.
  if (isShapeTool(t)) S.lastShapeTool = t;
  // Lasso mode belongs to Select only: leaving Select
  // turns it off, and returning to Select restores the
  // selection mode last chosen (select or lasso) — so V
  // activates the lasso if that was last used.
  S.lassoMode = t === "select" && S.lastSelectMode === "lasso";
  S.drag = null;
  updateEraserRing(0, 0, false);
  // The toolbar plugin follows the tool through the "tool"
  // plugin event, so it can highlight the active tool and
  // show the right flyout without polling. The plugin
  // system syncs its own tool buttons on the same event.
  S.api.events.emit("tool");
}

// Choose the selection mode (plain select or lasso) and
// activate Select with it. The mode is remembered, so V
// and the select button restore it — the toolbar's select
// picker and the shortcut share this one memory.
export function setSelectMode(mode: "select" | "lasso"): void {
  S.lastSelectMode = mode;
  setTool("select");
}

export function getSelectMode(): "select" | "lasso" {
  return S.lassoMode ? "lasso" : "select";
}

// Selection actions, shared by the keyboard shortcuts and by the
// plugin API (so a palette plugin can group, ungroup or delete
// exactly as Ctrl+G / Ctrl+U / Delete do, instead of reimplementing
// them and drifting — in particular, group ids must come from
// board.next_group, or a later core group can collide with them).
// These are the board controller's group/ungroup/delete: the host
// delegates its groupSelection/ungroupSelection/deleteSelection
// here, so a plugin groups exactly as the keyboard does.
export function groupSelected(): boolean {
  const selected = S.api.board.getSelected();
  if (selected.length < 2) return false;
  // The group id comes from the board's next_group, which
  // the core owns: createGroup bumps it, assigns it, and
  // saves, so a later group can never collide with it.
  return S.api.board.createGroup(selected) !== null;
}

export function ungroupSelected(): boolean {
  const selected = S.api.board.getSelected();
  const board = S.api.board.get();
  const groups = new Set(selected.map((id) => S.api.board.getItem(id)?.group).filter((g): g is number => g !== null && g !== undefined));
  if (groups.size === 0) return false;
  const patches = board.items
    .filter((it) => it.group !== null && groups.has(it.group))
    .map((it) => ({ id: it.id, group: null as number | null }));
  S.api.board.updateItems(patches);
  return true;
}

export function deleteSelected(): boolean {
  const selected = S.api.board.getSelected();
  if (selected.length === 0) return false;
  S.api.board.removeItems(selected);
  S.api.board.setSelected([]);
  S.api.board.save();
  render();
  return true;
}

export function cornerHit(id: number, world: Pt): boolean {
  const cam = S.api.view.getCamera();
  const it = S.api.board.getItem(id);
  if (!it || "Connector" in it.kind) return false;
  const [p, s] = S.api.geometry.itemBounds(it);
  const corner = S.api.geometry.rotatePoint({ x: p.x + s.w, y: p.y + s.h }, S.api.geometry.centre(it), S.api.geometry.itemRotation(it));
  const tol = 16 / cam.zoom;
  return Math.hypot(world.x - corner.x, world.y - corner.y) <= tol;
}
export function rotateHit(id: number, world: Pt): boolean {
  const cam = S.api.view.getCamera();
  const it = S.api.board.getItem(id);
  if (!it || !isRotatable(it, isFrameCard)) return false;
  const h = rotateHandleWorld(it, S.api.view.getCamera());
  const tol = 18 / cam.zoom;
  return Math.hypot(world.x - h.x, world.y - h.y) <= tol;
}
export function rotateSelected(delta: number): boolean {
  const selected = S.api.board.getSelected();
  let changed = false;
  for (const id of selected) {
    const it = S.api.board.getItem(id);
    if (!it || !isRotatable(it, isFrameCard)) continue;
    S.api.board.setItemRotation(id, normAngle(S.api.geometry.itemRotation(it) + delta));
    changed = true;
  }
  if (!changed) return false;
  S.api.board.save();
  render();
  return true;
}

// Find elements one by one on an infinite board: Tab steps through
// the board's elements in board order, selecting each in turn and
// centring the camera on it, so an element far from the current
// view is found without hunting. Shift+Tab steps backwards, and
// the cycle wraps. Pen strokes and connectors are skipped: they
// are drawings and lines, not elements to find. A grouped item
// selects its whole group and centres on the group's bounds.
export function navigateElements(dir: 1 | -1): void {
  const board = S.api.board.get();
  const navigable = board.items.filter((it) => !("Stroke" in it.kind) && !("Connector" in it.kind));
  if (navigable.length === 0) return;
  const selected = S.api.board.getSelected();
  // Advance from the edge of the selection in the direction
  // of travel: from the last member going forward, from the
  // first going back. Advancing from the first member in
  // both directions traps Tab inside a group — selecting
  // one member selects the whole group, so the next Tab
  // lands on the group's other member and re-selects the
  // same group forever (6, 2, 6, 2, …).
  let idx = -1;
  if (selected.length > 0) {
    const indices = navigable.map((it, i) => (selected.includes(it.id) ? i : -1)).filter((i) => i !== -1);
    if (indices.length > 0) idx = dir === 1 ? Math.max(...indices) : Math.min(...indices);
  }
  const next = idx === -1
    ? (dir === 1 ? 0 : navigable.length - 1)
    : (idx + dir + navigable.length) % navigable.length;
  const target = navigable[next];
  S.api.board.setSelected(S.api.board.selectCard([], target.id, false));
  let c: Pt;
  if (target.group !== null) {
    const members = board.items.filter((it) => it.group === target.group);
    const b = membersBounds(members, S.api.geometry.itemBounds);
    c = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : S.api.geometry.centre(target);
  } else {
    c = S.api.geometry.centre(target);
  }
  const bs = boardSize();
  const cam = S.api.view.getCamera();
  S.api.view.setCamera({ x: c.x - bs.x / 2 / cam.zoom, y: c.y - bs.y / 2 / cam.zoom, zoom: cam.zoom });
}

// ---------------------------------------------------------------- input

export function attachBoardListeners(): void {
S.boardEl.addEventListener("pointerdown", (e: PointerEvent) => {
  const target = e.target as HTMLElement;
  if (target.closest("#toolbar, #settings-backdrop, #toast, #plugin-overlays, #search-box, #title-bar, video, input, canvas.model3d")) return;
  // A board click or drag must never start a native text selection
  // across the cards (bug: clicking anywhere highlighted all text).
  if (!target.closest("textarea.note-edit")) window.getSelection()?.removeAllRanges();
  if (e.button !== 0) return;
  const winPt: Pt = boardPoint(e.clientX, e.clientY);
  if (S.editingId !== null && !target.closest("textarea.note-edit")) {
    commitEditingIfAny();
    render();
    return;
  }
  const world = toWorld(winPt);
  // A plugin view owns its own viewport: core board clicks, pan and
  // A plugin view owns its own viewport: core board clicks, pan and
  // tools must not run while it is active. The plugin's own
  // listeners on its container handle clicks there.
  if (S.api.view.getView() !== "board" && target.closest("#plugin-view")) return;
  if (S.tool.startsWith("plugin:")) {
    const pt = S.api.ui.getToolDef(S.tool);
    if (pt?.onMouseDown) {
      try { pt.onMouseDown(world); } catch (e) { S.api.ui.toast(`Plugin tool failed: ${String(e)}`); }
      S.pluginToolDown = true;
      return;
    }
    return;
  }
  if (S.spaceDown) { S.drag = { kind: "pan", last: winPt }; return; }
  if (isShapeTool(S.tool)) {
    S.drag = { kind: "shape", shape: S.tool as ShapeKind, start: world, current: world };
    return;
  }
  if (S.tool === "pen" || S.tool === "pencil" || S.tool === "highlighter") {
    // A stylus records its pressure per point, so the
    // stroke can thicken and thin with the press; a mouse
    // or finger records none, and draws a uniform stroke.
    // The pencil draws thinner than the pen; the
    // highlighter is a wide translucent marker, so it
    // records no pressure and draws uniform.
    const isHighlighter = S.tool === "highlighter";
    S.drag = {
      kind: "stroke",
      points: [world],
      pressures: e.pointerType === "pen" && !isHighlighter ? [e.pressure] : [],
      width: isHighlighter ? 12 : S.tool === "pencil" ? 2 : 3,
      marker: isHighlighter,
      // The pencil is a graphite texture, not just a
      // thinner pen: the flag travels with the stroke so
      // it keeps its texture through erasing and reloads.
      pencil: S.tool === "pencil",
    };
    return;
  }
  if (S.tool === "select" && S.lassoMode) {
    S.drag = { kind: "lasso", points: [world] };
    return;
  }
  if (S.tool === "eraser") {
    S.drag = { kind: "erase", erased: false };
    if (eraseAt(world)) S.drag.erased = true;
    return;
  }
  if (S.tool === "connector") {
    const hit = S.api.board.hitTest(world);
    const hitItem = hit !== null ? S.api.board.getItem(hit) : null;
    const anchorable = hitItem && !("Stroke" in hitItem.kind) && !("Connector" in hitItem.kind);
    S.drag = { kind: "connector", from: hitItem && anchorable ? { Item: hitItem.id } : { Point: world }, current: world };
    return;
  }
  // Select tool.
  const now = Date.now();
  const isDoubleClick =
    now - S.lastPointerDown.t < 500 &&
    Math.hypot(winPt.x - S.lastPointerDown.x, winPt.y - S.lastPointerDown.y) < 5;
  S.lastPointerDown = { x: winPt.x, y: winPt.y, t: now };
  if (isDoubleClick) {
    // Without this, the browser's default mousedown focus runs after
    // this handler and steals focus from a textarea created here, so
    // typing would never land in a new or edited note.
    e.preventDefault();
    // Double-clicking a section label renames the group,
    // instead of creating a note under it (the label sits
    // in the frame's padding, which is empty board space).
    const labelEl = target.closest(".group-label") as HTMLElement | null;
    if (labelEl) { startGroupRename(Number(labelEl.dataset.group)); return; }
    const hit = S.api.board.hitTest(world);
    if (hit !== null) {
      const it = S.api.board.getItem(hit);
      if (it && "Plugin" in it.kind && S.api.cards.dispatchDoubleClick(it)) return;
      if (it && "Text" in it.kind) { startTextEdit(hit); return; }
      // Double-clicking a voice note's name renames it,
      // like a section label renames its group. Anywhere
      // else on the card keeps its own behaviour (the tile
      // plays, the seek seeks).
      if (it && "Audio" in it.kind && audioTitleHit(hit, e.clientX, e.clientY)) { startAudioRename(hit); return; }
      if (it && "UrlCard" in it.kind) { openExternal(it.kind.UrlCard.url); return; }
      if (it && "PdfCard" in it.kind) { openExternal(it.kind.PdfCard.path); return; }
      if (it && "Image" in it.kind) { openExternal(it.kind.Image.path); return; }
      // A design file opens in its own app: Photoshop for a
      // .psd, Illustrator for a .ai. The OS picks the app
      // from the file type; the board just opens the file.
      if (it && "FileCard" in it.kind) { openExternal(it.kind.FileCard.path); return; }
    } else {
      createTextNoteAt(world);
      return;
    }
  }
  const clicked = S.api.board.hitTest(world);
  const selected = S.api.board.getSelected();
  if (selected.length === 1 && rotateHit(selected[0], world)) {
    const it = S.api.board.getItem(selected[0]);
    S.drag = { kind: "rotate", id: selected[0], origRot: it ? S.api.geometry.itemRotation(it) : 0, moved: false };
    return;
  }
  if (selected.length === 1 && cornerHit(selected[0], world)) {
    const sel = selected[0];
    const it = S.api.board.getItem(sel);
    S.drag = { kind: "resize", id: sel, startWorld: world, origW: it?.size.w ?? 100, origH: it?.size.h ?? 100, moved: false };
    return;
  }
  if (clicked !== null && cornerHit(clicked, world)) {
    S.api.board.setSelected(S.api.board.selectCard(S.api.board.getSelected(), clicked, false));
    applyStacking();
    updateSelection();
    const it = S.api.board.getItem(clicked);
    S.drag = { kind: "resize", id: clicked, startWorld: world, origW: it?.size.w ?? 100, origH: it?.size.h ?? 100, moved: false };
    return;
  }
  if (clicked !== null) {
    S.api.board.setSelected(S.api.board.selectCard(S.api.board.getSelected(), clicked, e.shiftKey));
    applyStacking();
    updateSelection();
    S.drag = { kind: "move", lastWorld: world, moved: false };
    return;
  }
  if (!e.shiftKey) S.api.board.setSelected([]);
  S.drag = { kind: "marquee", start: world, current: world };
});

S.cardsEl.addEventListener("click", (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const link = target.closest("a[data-url]") as HTMLElement | null;
  if (link) { e.preventDefault(); openExternal(link.dataset.url ?? ""); return; }
  const pbtn = target.closest("[data-plugin-action]") as HTMLElement | null;
  if (pbtn) {
    const pid = Number(pbtn.dataset.id);
    const pit = S.api.board.getItem(pid);
    if (pit && S.api.cards.dispatchAction(pbtn.dataset.pluginAction ?? "", pit)) return;
  }
  const task = target.closest("[data-action=\"toggle-task\"]") as HTMLElement | null;
  if (task) {
    // The browser would toggle the checkbox itself after
    // this click; the re-render below replaces the node, so
    // suppress that and let the text be the state instead.
    e.preventDefault();
    const cardEl = task.closest(".card") as HTMLElement | null;
    const it = S.api.board.getItem(Number(cardEl?.dataset.id));
    if (!it || !("Text" in it.kind)) return;
    const lineNo = Number(task.dataset.line);
    const lines = it.kind.Text.text.split("\n");
    const next = S.api.text.toggleTaskLine(lines[lineNo] ?? "");
    if (next === null) return;
    lines[lineNo] = next;
    S.api.board.setTextContent(it.id, lines.join("\n"));
    S.api.board.save();
    render();
    return;
  }
  const btn = target.closest("[data-action]") as HTMLElement | null;
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const action = btn.dataset.action;
  const it = S.api.board.getItem(id);
  if (!it) return;
  if (action === "open-link" && "UrlCard" in it.kind) openExternal(it.kind.UrlCard.url);
  if (action === "play-audio" && "Audio" in it.kind) S.api.media.toggleAudio(id, it.kind.Audio.path);
  if (action === "toggle-transcript" && "Audio" in it.kind) {
    // The card's height is the state: taller than the hidden
    // height, the transcript shows; at it or below, only the
    // toggle does. A normal resize, so one undo step.
    const expanded = it.size.h > S.api.cards.audioHeights.transcriptHidden;
    const h = expanded ? S.api.cards.audioHeights.transcriptHidden : S.api.cards.audioHeights.transcriptShown;
    S.api.board.updateItem(id, { size: { w: it.size.w, h } });
  }
  if ((action === "pdf-prev" || action === "pdf-next") && "PdfCard" in it.kind) {
    const pdfPath = it.kind.PdfCard.path;
    const cur = S.api.media.getPdfPage(id);
    const nextPage = action === "pdf-prev" ? cur - 1 : cur + 1;
    void S.api.media.setPdfPage(id, pdfPath, nextPage);
  }
  if (action === "play-video" && "Video" in it.kind) {
    // A local video plays on the board (its poster becomes
    // the live element); a remote link or an unplayable
    // format opens outside the app, as before.
    const v = it.kind.Video;
    if (isInlineVideo(v.source, v.remote)) S.api.media.playVideo(id);
    else openExternal(v.source);
  }
  if (action === "fit-model3d" && "Model3D" in it.kind) fitModel3DView(id);
});

S.cardsEl.addEventListener("input", (e: Event) => {
  const seek = (e.target as HTMLElement).closest("[data-audio-seek]") as HTMLInputElement | null;
  if (!seek) return;
  const id = Number(seek.dataset.audioSeek);
  const state = S.api.media.getAudioState();
  if (state.id !== id || !isFinite(state.duration) || state.duration <= 0) return;
  S.api.media.seekAudio(id, (Number(seek.value) / 1000) * state.duration);
});
}

// Whether a tool id is a shape kind, from the shape table
// the API hands out. The toolbar's shape picker and this
// drag check both read the same table.
export function isShapeTool(t: string): boolean {
  return S.api.shapes.list().some((s) => s.kind === t);
}

export function openExternal(target: string): void {
  S.api.files.openExternal(target).catch((e) => S.api.ui.toast(`Could not open ${target}: ${String(e)}`));
}

// ---------------------------------------------------------------- mouse

// Fast-path drag previews: a single SVG node updated in place,
// instead of rebuilding every card and stroke on every mousemove.
// The node is cleared by the next full render (mouseup), so it never
// needs its own removal. A preview drawn over the cards (the shape
// preview) lives in the preview layer above #cards instead of the
// world layer below it, so the cards cannot cover it mid-drag.
export function dragPreview(id: string, tag: string, toPreview = false): SVGElement {
  const layer = toPreview ? S.previewWorldEl : S.worldEl;
  let el = layer.querySelector(`#${id}`) as SVGElement | null;
  if (!el) {
    el = svgEl2(tag, { id }) as SVGElement;
    layer.appendChild(el);
  }
  return el;
}
// The live stroke, drawn while the pen is down. A uniform
// stroke is one smooth path; a pen stroke whose pressure
// varies is one line per short sample along the smooth
// curve, each at the width its pressure makes, so the
// stroke visibly thickens as it is drawn. `width` is the
// tool's base width: the pencil draws thinner than the pen,
// the highlighter much wider. A marker (highlighter) draws
// translucent, like the stored stroke.
export function updateLiveStroke(points: Pt[], pressures: number[], width: number, marker: boolean, pencil = false): void {
  const el = dragPreview("live-stroke", "g");
  while (el.firstChild) el.removeChild(el.firstChild);
  // A pencil stroke shows its graphite texture while it
  // is being drawn, not only once it is committed.
  if (pencil) el.setAttribute("filter", "url(#pencil-texture)");
  else el.removeAttribute("filter");
  const opacity = marker ? "0.45" : "1";
  if (pressures.length === points.length && strokePressuresVary({ pressures })) {
    const pts = smoothStrokeSamples(points);
    const prs = smoothStrokePressures(pressures);
    for (let i = 0; i + 1 < pts.length; i++) {
      const w = pressureWidth(width, (prs[i] + prs[i + 1]) / 2);
      el.appendChild(svgEl2("line", { x1: String(pts[i].x), y1: String(pts[i].y), x2: String(pts[i + 1].x), y2: String(pts[i + 1].y), stroke: S.api.pen.getColor(), "stroke-width": String(w), "stroke-linecap": "round", opacity }));
    }
  } else {
    el.appendChild(svgEl2("path", { d: smoothStrokePath(points), fill: "none", stroke: S.api.pen.getColor(), "stroke-width": String(width), "stroke-linecap": "round", "stroke-linejoin": "round", opacity }));
  }
}
// The lasso loop, drawn live while dragging. The path is
// closed (the Z joins the last point back to the first),
// so the fill shows the region the loop will select.
export function updateLassoPreview(points: Pt[]): void {
  const el = dragPreview("lasso-preview", "path");
  el.setAttribute("d", points.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x},${pt.y}`).join(" ") + " Z");
  el.setAttribute("fill", "rgba(0,122,255,0.08)");
  el.setAttribute("stroke", ACCENT);
  el.setAttribute("stroke-width", "1");
}
export function updateDraggedCards(ids: number[]): void {
  // Cards are world-space now, so moving one is a style change on
  // its own node — no markdown, no image re-parse, no rebuild.
  // Element lookups come from the render-built cardEls map, not
  // from three attribute-selector queries per card per move.
  // A cached element that left the DOM (a card edited since the
  // last render had its decorations removed) falls back to a
  // live query, so the drag never moves a detached node.
  for (const id of ids) {
    const it = S.api.board.getItem(id);
    if (!it) continue;
    const cached = S.cardEls.get(id);
    const el = cached?.card.isConnected
      ? cached.card
      : (S.cardsEl.querySelector(`[data-id="${id}"]`) as HTMLElement | null);
    if (!el) continue;
    el.style.left = `${it.pos.x}px`;
    el.style.top = `${it.pos.y}px`;
    el.style.width = `${it.size.w}px`;
    el.style.height = `${it.size.h}px`;
    // The card's bottom row is a sibling div, not part of the
    // card node, so it does not move with it: move it by the
    // same rule that placed it (see decorations() in cards.ts),
    // or the progress stays behind while the card is dragged.
    // A resize moves it too (its top and the right side follow
    // the card's height and width), so this covers both.
    const top = Math.max(it.pos.y + 4, it.pos.y + it.size.h - 36);
    const leftDeco = cached?.left?.isConnected
      ? cached.left
      : (S.cardsEl.querySelector(`.card-decorations:not(.card-decorations-right)[data-for="${id}"]`) as HTMLElement | null);
    if (leftDeco) {
      leftDeco.style.left = `${it.pos.x + 8}px`;
      leftDeco.style.top = `${top}px`;
      leftDeco.style.width = `${Math.max(it.size.w - 16, 0)}px`;
    }
    const rightDeco = cached?.right?.isConnected
      ? cached.right
      : (S.cardsEl.querySelector(`.card-decorations-right[data-for="${id}"]`) as HTMLElement | null);
    if (rightDeco) {
      rightDeco.style.left = `${it.pos.x + it.size.w - 8}px`;
      rightDeco.style.top = `${top}px`;
    }
  }
  updateDraggedGroupFrames(ids);
}

// The section frame is a derived div, not part of any card,
// so it does not move with the cards it frames: recompute
// its bounds from the live board (the cards already moved)
// and move the frame to match, or it stays behind while the
// group is dragged. A resize moves it too (a member's size
// changes the union), so this covers both. The label is a
// separate element in #groups now, so it moves too — it
// sits at the frame's top-left plus the same offset it
// had as the frame's child.
export function updateDraggedGroupFrames(ids: number[]): void {
  if (!S.groupsEl || !S.groupFramesEl) return;
  const groups = new Set<number>();
  for (const id of ids) {
    const it = S.api.board.getItem(id);
    if (it && it.group !== null) groups.add(it.group);
  }
  if (groups.size === 0) return;
  // Membership comes from the last render's board: group
  // membership does not change mid-drag, and scanning it is
  // a plain array pass, not a JSON round-trip. Positions
  // come from getItem, so they reflect the drag move. The
  // old version called api.board.get() — a full deep copy
  // of the board — on every pointermove, and then scanned
  // that copy once per group inside groupBounds.
  const source = S.cachedBoard ?? S.api.board.get();
  for (const g of groups) {
    const memberIds = source.items.filter((it) => it.group === g).map((it) => it.id);
    // A live import is a section even with one card, so its
    // frame exists and must follow the drag too.
    if (memberIds.length < 2 && !source.groups?.[g]?.source) continue;
    const members: Item[] = [];
    for (const id of memberIds) {
      const it = S.api.board.getItem(id);
      if (it) members.push(it);
    }
    const b = groupBounds(members, S.api.geometry.itemBounds);
    if (!b) continue;
    const frame = S.groupFramesEl.querySelector(`.group-frame[data-group="${g}"]`) as HTMLElement | null;
    if (!frame) continue;
    frame.style.left = `${b.x}px`;
    frame.style.top = `${b.y}px`;
    frame.style.width = `${b.w}px`;
    frame.style.height = `${b.h}px`;
    const label = S.groupsEl.querySelector(`.group-label[data-group="${g}"]`) as HTMLElement | null;
    if (label) {
      label.style.left = `${b.x + 12}px`;
      label.style.top = `${b.y - 11}px`;
    }
  }
}

export function attachWindowListeners(): void {
  if (S.listenersAttached) return;
  S.listenersAttached = true;

window.addEventListener("pointermove", (e: PointerEvent) => {
  const winPt: Pt = boardPoint(e.clientX, e.clientY);
  const world = toWorld(winPt);
  if (!S.drag) {
    // Cursor hints run at most once per frame: hitTest walks every
    // item, and mousemove can fire far faster than the display.
    S.pendingCursor = world;
    if (!S.cursorRaf) {
      S.cursorRaf = requestAnimationFrame(() => {
        S.cursorRaf = 0;
        const w = S.pendingCursor;
        if (!w) return;
        const selected = S.api.board.getSelected();
        if (S.api.ui.isSettingsOpen() || S.editingId !== null) {
          S.boardEl.style.cursor = "default";
        } else if (S.tool === "pen" || S.tool === "pencil" || S.tool === "highlighter" || S.tool === "connector" || isShapeTool(S.tool) || (S.tool === "select" && S.lassoMode)) {
          S.boardEl.style.cursor = "crosshair";
        } else if (S.tool === "eraser") {
          // The ring is the cursor while erasing.
          S.boardEl.style.cursor = "none";
        } else if (S.spaceDown) {
          S.boardEl.style.cursor = "grab";
        } else if (selected.length === 1 && rotateHit(selected[0], w)) {
          S.boardEl.style.cursor = "grab";
        } else if (selected.length === 1 && cornerHit(selected[0], w)) {
          S.boardEl.style.cursor = "nwse-resize";
        } else if (S.api.board.hitTest(w) !== null) {
          S.boardEl.style.cursor = "move";
        } else {
          S.boardEl.style.cursor = "default";
        }
      });
    }
    // The eraser ring follows the mouse directly, not
    // through the rAF above: it is the cursor, so it must
    // not lag a frame. It shows only over the board itself,
    // never over the toolbar, panels, title bar or settings.
    const overBoard = !(e.target as HTMLElement).closest("#toolbar, #settings-backdrop, #plugin-panels, #title-bar, #plugin-overlays, #plugin-view, input, textarea, select");
    const showRing = S.tool === "eraser" && overBoard && !S.api.ui.isSettingsOpen() && S.editingId === null && S.api.view.getView() === "board";
    updateEraserRing(e.clientX, e.clientY, showRing);
    return;
  }
  S.boardEl.style.cursor = S.drag.kind === "resize" ? "nwse-resize" : S.drag.kind === "rotate" ? "grabbing" : S.drag.kind === "pan" ? "grabbing" : S.drag.kind === "move" ? "move" : S.drag.kind === "erase" ? "none" : "default";
  if (S.drag.kind === "pan") {
    const cam = S.api.view.getCamera();
    S.api.view.setCameraSilent({
      x: cam.x - (winPt.x - S.drag.last.x) / cam.zoom,
      y: cam.y - (winPt.y - S.drag.last.y) / cam.zoom,
      zoom: cam.zoom,
    });
    S.drag.last = winPt;
    applyCamera();
    refreshContentIfVisibleChanged();
  } else if (S.drag.kind === "move") {
    const dx = world.x - S.drag.lastWorld.x, dy = world.y - S.drag.lastWorld.y;
    if (Math.hypot(dx, dy) > 0.5) S.drag.moved = true;
    S.api.board.moveItems(S.api.board.getSelected(), dx, dy);
    S.drag.lastWorld = world;
    updateDraggedCards(S.api.board.getSelected());
    // Strokes do not move when a card moves, so the SVG layer
    // only changes when a connector follows a dragged card.
    // Skipping the redraw on a board with no connectors also
    // skips the full api.board.get() deep copy renderSvgOnly
    // does on every pointermove. (cachedBoard is set on every
    // render; if it is somehow null, redraw as before.)
    if (!S.cachedBoard || S.cachedBoard.items.some((it) => "Connector" in it.kind)) renderSvgOnly();
    updateResizeHandle();
  } else if (S.drag.kind === "resize") {
    const it = S.api.board.getItem(S.drag.id);
    S.api.board.resizeItem(S.drag.id, S.drag.origW + (world.x - S.drag.startWorld.x), S.drag.origH + (world.y - S.drag.startWorld.y));
    if (Math.hypot(world.x - S.drag.startWorld.x, world.y - S.drag.startWorld.y) > 2) S.drag.moved = true;
    updateDraggedCards([S.drag.id]);
    // Strokes have no card element to resize live, so rebuild
    // the SVG layer instead: the stroke visibly follows the
    // handle, like a card does. Same as the rotate drag below.
    if (it && "Stroke" in it.kind) renderSvgOnly();
    updateResizeHandle();
  } else if (S.drag.kind === "stroke") {
    const cam = S.api.view.getCamera();
    const last = S.drag.points[S.drag.points.length - 1];
    if (Math.hypot(world.x - last.x, world.y - last.y) > 2 / cam.zoom) {
      S.drag.points.push(world);
      if (e.pointerType === "pen" && !S.drag.marker) S.drag.pressures.push(e.pressure);
      updateLiveStroke(S.drag.points, S.drag.pressures, S.drag.width, S.drag.marker, S.drag.pencil);
    }
  } else if (S.drag.kind === "lasso") {
    const cam = S.api.view.getCamera();
    const last = S.drag.points[S.drag.points.length - 1];
    if (Math.hypot(world.x - last.x, world.y - last.y) > 2 / cam.zoom) {
      S.drag.points.push(world);
      updateLassoPreview(S.drag.points);
    }
  } else if (S.drag.kind === "erase") {
    if (eraseAt(world)) S.drag.erased = true;
    updateEraserRing(e.clientX, e.clientY, true);
  } else if (S.drag.kind === "connector") {
    S.drag.current = world;
    const a = S.api.geometry.anchorPoint(S.drag.from);
    if (a) {
      const el = dragPreview("connector-preview", "line");
      el.setAttribute("x1", String(a.x));
      el.setAttribute("y1", String(a.y));
      el.setAttribute("x2", String(world.x));
      el.setAttribute("y2", String(world.y));
      el.setAttribute("stroke", S.api.pen.getColor());
      el.setAttribute("stroke-width", "2");
    }
  } else if (S.drag.kind === "shape") {
    S.drag.current = world;
    const penColor = S.api.pen.getColor();
    const outline = S.api.shapes.getOutline();
    const x0 = Math.min(S.drag.start.x, world.x), y0 = Math.min(S.drag.start.y, world.y);
    const w = Math.abs(world.x - S.drag.start.x), h = Math.abs(world.y - S.drag.start.y);
    // An outline shape previews as a stroke, not a fill.
    const fillAttr = outline ? "none" : penColor;
    const strokeAttr = outline ? penColor : "none";
    if (S.drag.shape === "rect") {
      const el = dragPreview("shape-preview", "rect", true);
      el.setAttribute("x", String(x0)); el.setAttribute("y", String(y0));
      el.setAttribute("width", String(w)); el.setAttribute("height", String(h));
      el.setAttribute("rx", "12");
      el.setAttribute("fill", fillAttr); el.setAttribute("fill-opacity", outline ? "1" : "0.85");
      el.setAttribute("stroke", strokeAttr); el.setAttribute("stroke-width", outline ? "4" : "0");
    } else if (S.drag.shape === "ellipse") {
      const el = dragPreview("shape-preview", "ellipse", true);
      el.setAttribute("cx", String(x0 + w / 2)); el.setAttribute("cy", String(y0 + h / 2));
      el.setAttribute("rx", String(w / 2)); el.setAttribute("ry", String(h / 2));
      el.setAttribute("fill", fillAttr); el.setAttribute("fill-opacity", outline ? "1" : "0.85");
      el.setAttribute("stroke", strokeAttr); el.setAttribute("stroke-width", outline ? "4" : "0");
    } else {
      const el = dragPreview("shape-preview", "polygon", true);
      el.setAttribute("points", S.api.shapes.previewPoints(S.drag.shape, x0, y0, w, h));
      el.setAttribute("fill", fillAttr); el.setAttribute("fill-opacity", outline ? "1" : "0.85");
      el.setAttribute("stroke", strokeAttr); el.setAttribute("stroke-width", outline ? "4" : "0");
      el.setAttribute("stroke-linejoin", "round");
    }
  } else if (S.drag.kind === "rotate") {
    const it = S.api.board.getItem(S.drag.id);
    if (it) {
      const rot = rotateAngleFor(world, it, e.shiftKey);
      if (Math.abs(rot - S.drag.origRot) > 1) S.drag.moved = true;
      S.api.board.setItemRotation(S.drag.id, rot);
      const el = S.cardsEl.querySelector(`[data-id="${S.drag.id}"]`) as HTMLElement | null;
      if (el) el.style.transform = rot ? `rotate(${rot}deg)` : "";
      // Strokes have no card element to transform live,
      // so rebuild the SVG layer instead: the stroke
      // visibly follows the handle, like a card does.
      if ("Stroke" in it.kind) renderSvgOnly();
      updateResizeHandle();
    }
  } else if (S.drag.kind === "marquee") {
    S.drag.current = world;
    const el = dragPreview("marquee-preview", "rect");
    const x0 = Math.min(S.drag.start.x, world.x), y0 = Math.min(S.drag.start.y, world.y);
    el.setAttribute("x", String(x0));
    el.setAttribute("y", String(y0));
    el.setAttribute("width", String(Math.abs(world.x - S.drag.start.x)));
    el.setAttribute("height", String(Math.abs(world.y - S.drag.start.y)));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", ACCENT);
    el.setAttribute("stroke-width", "1");
  }
});

window.addEventListener("pointerup", (e: PointerEvent) => {
  if (S.pluginToolDown) {
    S.pluginToolDown = false;
    const pt = S.api.ui.getToolDef(S.tool);
    if (pt?.onMouseUp) {
      try { pt.onMouseUp(toWorld(boardPoint(e.clientX, e.clientY))); } catch (err) { S.api.ui.toast(`Plugin tool failed: ${String(err)}`); }
    }
    return;
  }
  if (!S.drag) return;
  const world = toWorld(boardPoint(e.clientX, e.clientY));
  const d = S.drag;
  S.drag = null;
  if (d.kind === "stroke") {
    if (d.points.length >= 2) {
      const xs = d.points.map((p) => p.x), ys = d.points.map((p) => p.y);
      const pos = { x: Math.min(...xs), y: Math.min(...ys) };
      const size = { w: Math.max(1, Math.max(...xs) - pos.x), h: Math.max(1, Math.max(...ys) - pos.y) };
      S.api.board.addItem({ Stroke: { points: d.points, color: S.api.pen.getColor(), width: d.width, marker: d.marker, ...(d.pressures.length > 0 ? { pressures: d.pressures } : {}), ...(d.pencil ? { pencil: true } : {}) } }, pos, size);
    }
  } else if (d.kind === "lasso") {
    // A click, not a loop: select what is under the cursor,
    // the way the select tool does. A real loop selects
    // everything it touches. Either way it is only a
    // selection change, never an undo step.
    const xs = d.points.map((p) => p.x), ys = d.points.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    if (d.points.length < 3 || (w < 4 && h < 4)) {
      const hit = S.api.board.hitTest(world);
      S.api.board.setSelected(hit !== null ? [hit] : []);
    } else {
      S.api.board.setSelected(S.api.board.lassoSelect(d.points));
    }
  } else if (d.kind === "erase") {
    // A sweep that erased anything is one undo step. A
    // click that erased nothing leaves no step behind.
    if (d.erased) S.api.board.save();
  } else if (d.kind === "connector") {
    const to = S.api.board.hitTest(world);
    const toItem = to !== null ? S.api.board.getItem(to) : null;
    const toAnchorable = toItem && !("Stroke" in toItem.kind) && !("Connector" in toItem.kind);
    const toAnchor: Anchor = toItem && toAnchorable ? { Item: toItem.id } : { Point: world };
    const a = S.api.geometry.anchorPoint(d.from);
    const degenerate = a !== null && "Point" in toAnchor && Math.hypot(a.x - toAnchor.Point.x, a.y - toAnchor.Point.y) < 4;
    // A connector from a card to itself is a click, not a connection:
    // it renders as a 1x1 invisible item that can never be selected
    // or deleted except by undo, and it pollutes the board JSON.
    const selfConnector = "Item" in d.from && "Item" in toAnchor && d.from.Item === toAnchor.Item;
    if (!degenerate && !selfConnector) {
      const aPt = a ?? { x: 0, y: 0 };
      // toAnchor is an Item exactly when toItem exists, so
      // its centre comes from toItem — no second lookup.
      const bPt = "Point" in toAnchor ? toAnchor.Point : (toItem ? S.api.geometry.centre(toItem) : { x: 0, y: 0 });
      const { pos, size } = rectFromPoints(aPt, bPt);
      S.api.board.addItem({ Connector: { from: d.from, to: toAnchor, color: S.api.pen.getColor() } }, pos, size);
    }
  } else if (d.kind === "shape") {
    const w = Math.abs(world.x - d.start.x), h = Math.abs(world.y - d.start.y);
    if (w >= 10 && h >= 10) {
      const pos = { x: Math.min(d.start.x, world.x), y: Math.min(d.start.y, world.y) };
      const outline = S.api.shapes.getOutline();
      S.api.board.addItem({ Shape: { shape: d.shape, fill: S.api.pen.getColor(), ...(outline ? { outline: true } : {}) } }, pos, { w, h });
    }
  } else if (d.kind === "rotate") {
    // Apply the final point too: a drag's last mousemove
    // may not be at the mouseup point, so the rotation
    // would otherwise stop one step short of where the
    // user actually released.
    const it = S.api.board.getItem(d.id);
    if (it) {
      const rot = rotateAngleFor(world, it, e.shiftKey);
      if (Math.abs(rot - d.origRot) > 1) d.moved = true;
      S.api.board.setItemRotation(d.id, rot);
    }
    if (d.moved) S.api.board.save();
  } else if (d.kind === "marquee") {
    // A click is not a marquee: pointerdown already settled
    // the selection by geometry (hitTest), and a zero-area
    // marquee would re-select by box — the empty corner of
    // a triangle would select the triangle after hitTest
    // correctly returned nothing. Only a real drag (moved
    // at least a few pixels) marquee-selects.
    if (Math.abs(world.x - d.start.x) >= 3 || Math.abs(world.y - d.start.y) >= 3) {
      S.api.board.setSelected(S.api.board.marqueeSelect(d.start, world));
    }
  } else if (d.kind === "pan") {
    // A Space+drag pan changes only the camera, so it must not
    // become an undo step — but it must reach disk, or closing
    // the window without another save loses the view.
    S.api.board.saveWithoutUndo();
  } else if (d.kind === "move" || d.kind === "resize") {
    // A drag that actually moved is a board change and an undo
    // step. A click that never moved only brought a card to the
    // front: that stacking change still saves to disk, but it
    // must not become an undo step, or every click would take
    // a Ctrl+Z to get past before the real change undoes.
    if (d.moved) S.api.board.save();
    else S.api.board.saveWithoutUndo();
  }
  // A move/resize that actually moved is safe to rebuild once at
  // the end (it refreshes truncation and connector endpoints with
  // their final geometry). A move/resize that never moved was a
  // click, not a drag: rebuilding here would destroy the card
  // button just pressed, so its click would never fire.
  if (d.kind === "stroke" || d.kind === "connector" || d.kind === "marquee" || d.kind === "shape" || d.kind === "lasso" || (d.kind === "erase" && d.erased) || (d.kind === "rotate" && d.moved)) {
    render();
  } else if ((d.kind === "move" || d.kind === "resize") && d.moved) {
    render();
  } else {
    updateSelection();
  }
  // A marquee drag ends in render(), not updateSelection(),
  // so without this the selection event never fires after
  // marquee-selecting — and anything listening for it, like
  // a plugin panel enabling its buttons for the selection,
  // stays stale. The toolbar and resize handle update here
  // too, for the same reason. A lasso drag ends the same way.
  if (d.kind === "marquee" || d.kind === "lasso") updateSelection();
});

// The ring must not freeze at the edge when the pointer
// leaves the window mid-erase.
document.addEventListener("mouseleave", () => updateEraserRing(0, 0, false));
document.addEventListener("pointerleave", () => updateEraserRing(0, 0, false));

window.addEventListener("wheel", (e: WheelEvent) => {
  // A wheel over a plugin panel or a plugin view must scroll
  // that panel or view, not pan the board behind it. The
  // handler below calls preventDefault, so without this guard
  // scrolling the Visual Library panel (or its whiteboard
  // view, which is itself a scroll container) moved the
  // whiteboard and the panel never scrolled. Ctrl/Cmd+wheel
  // over a panel or view is blocked, not zoomed: zooming the
  // board from over a panel is confusing, and in view mode
  // the board is hidden anyway. A wheel over a panel header
  // or search row has no scrollable ancestor — the sections
  // list is the scroller, and the header sits outside it —
  // so scroll that list by hand instead of doing nothing.
  // The command palette is an overlay, not a panel or a
  // view, so it needs its own guard here: without it, a
  // wheel over its list panned the board behind it, and
  // the preventDefault below stopped the list scrolling
  // at all. Over the palette, let the list scroll natively
  // and never pan or zoom the board; Ctrl/Cmd+wheel is
  // still blocked, so it does not zoom the page either.
  if ((e.target as HTMLElement).closest(".cmd-palette")) {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
    return;
  }
  const panelOrView = (e.target as HTMLElement).closest("#plugin-panels, #plugin-view");
  if (panelOrView) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); return; }
    if (panelOrView.closest("#plugin-panels")) {
      const panel = (e.target as HTMLElement).closest(".plugin-panel");
      const sections = panel?.querySelector(".vl-sections") as HTMLElement | null;
      if (sections && !(e.target as HTMLElement).closest(".vl-sections")) {
        sections.scrollTop += e.deltaY;
        e.preventDefault();
      }
    }
    return;
  }
  if ((e.target as HTMLElement).closest("#settings, #toolbar, #title-bar")) return;
  // A wheel over a card's scrollable content — a note taller
  // than its card, an audio transcript — scrolls that content,
  // not the board. Only when it can actually scroll further
  // in the wheel's direction: at the top or bottom edge the
  // wheel falls through to the board, so the board never
  // feels stuck behind a card that has nothing more to show.
  // Ctrl/Cmd+wheel still zooms the board from over a card.
  if (!e.ctrlKey && !e.metaKey) {
    const scroller = (e.target as HTMLElement).closest(".card .note-body, .card .audio-transcript-text") as HTMLElement | null;
    if (scroller) {
      const canUp = scroller.scrollTop > 0;
      const canDown = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight;
      if ((e.deltaY < 0 && canUp) || (e.deltaY > 0 && canDown)) return;
    }
  }
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    // Pinch / Ctrl+wheel zoom: accumulate, apply once per
    // frame, rebuild content when the gesture settles and
    // periodically during a long gesture, so cards that
    // come into view appear while zooming, not only after.
    // Sensitivity: 0.003, not 0.0015 — a full trackpad
    // pinch used to give only ~1.35x and felt slow, and a
    // mouse-wheel notch almost nothing. deltaMode is
    // normalised first, so a line-based wheel (deltaY in
    // lines) and a pixel-based trackpad pinch both land
    // on the same scale.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    S.pendingZoomFactor *= Math.exp(-dy * 0.003);
    S.pendingZoomAnchor = boardPoint(e.clientX, e.clientY);
    if (S.zoomFrame === null) {
      S.zoomFrame = requestAnimationFrame(() => {
        S.zoomFrame = null;
        if (S.pendingZoomAnchor && S.pendingZoomFactor !== 1) {
          zoomAt(S.pendingZoomAnchor, S.pendingZoomFactor);
        }
        S.pendingZoomFactor = 1;
        S.pendingZoomAnchor = null;
        applyCamera();
        const now = performance.now();
        const cam = S.api.view.getCamera();
        const ratio = cam.zoom / S.lastZoomRefreshZoom;
        if (now - S.lastZoomRefreshTime > 250 || ratio > 1.25 || ratio < 0.8) {
          refreshContentIfVisibleChanged();
          S.lastZoomRefreshZoom = cam.zoom;
          S.lastZoomRefreshTime = now;
        }
      });
    }
    if (S.zoomSettleTimer) clearTimeout(S.zoomSettleTimer);
    S.zoomSettleTimer = setTimeout(() => {
      refreshContentIfVisibleChanged();
      const cam = S.api.view.getCamera();
      S.lastZoomRefreshZoom = cam.zoom;
      S.lastZoomRefreshTime = performance.now();
      S.api.board.save();
    }, 120);
    return;
  }
  // Pan follows standard Mac scrolling: scrolling down moves
  // the content up, as in Safari, Notes and every other Mac
  // app. The previous code moved the content with the scroll,
  // which is the opposite of what a Mac trackpad user expects.
  // (Dragging with Space still grabs the paper and moves it
  // with the pointer — that is a grab, not a scroll, and stays.)
  const cam = S.api.view.getCamera();
  S.api.view.setCameraSilent({
    x: cam.x + e.deltaX / cam.zoom,
    y: cam.y + e.deltaY / cam.zoom,
    zoom: cam.zoom,
  });
  // Wheel events fire many times a second; writing the whole board
  // JSON on every tick is the worst save cost for a large board.
  // Save once, 400ms after the last wheel event instead. Content
  // edits still save immediately (move/resize mouseup, note commit),
  // and Close saves explicitly before closing.
  if (S.wheelSaveTimer) clearTimeout(S.wheelSaveTimer);
  S.wheelSaveTimer = setTimeout(() => S.api.board.save(), 400);
  applyCamera();
  refreshContentIfVisibleChanged();
}, { passive: false });

window.addEventListener("resize", () => { applyCamera(); refreshContentIfVisibleChanged(); });
// Quitting inside a camera-save debounce (400 ms wheel,
// 120 ms zoom settle) used to lose the camera: the async
// save never ran. And an async content save in flight when
// the window closes may not complete either. Flush
// synchronously on unload, so a pan, a zoom or an edit made
// just before quitting is kept: commit any in-progress edit,
// then write the board as-is. Only the unload flush uses
// the synchronous save; ordinary saves stay async. The
// flush writes only when the board changed since the last
// save (see undo.ts saveSync): a board restored on disk
// but not yet reloaded in memory is not dirty, so the
// flush never overwrites the restore with the stale board
// it replaced — and a content save already dispatched is
// covered by the journal it wrote before the async save.
window.addEventListener("beforeunload", () => {
  if (S.wheelSaveTimer) { clearTimeout(S.wheelSaveTimer); S.wheelSaveTimer = null; }
  if (S.zoomSettleTimer) { clearTimeout(S.zoomSettleTimer); S.zoomSettleTimer = null; }
  try {
    S.api.board.commitEditing();
    S.api.board.saveSync();
  } catch { /* the board is gone; nothing to flush */ }
});
// A media file that is missing shows as a blank card, which
// looks like a rendering bug and tells the user nothing.
// Catch load errors in the capture phase (img/video errors
// do not bubble). First, try once to load the same file as
// a data URL through the main process: if the app-file
// scheme itself is what fails in a given run (files exist
// and open in Preview, but never render in the board),
// the data URL still renders, and the user never sees a
// missing tile for a file that is actually there. Only
// if that also fails is the element swapped for a plain
// tile naming the missing file, so a broken board is
// diagnosable instead of silently blank.
window.addEventListener("error", (e: Event) => {
  const t = e.target as HTMLElement | null;
  if (!t || (t.tagName !== "IMG" && t.tagName !== "VIDEO")) return;
  const el = t as HTMLImageElement | HTMLVideoElement;
  const path = el.dataset?.path;
  // A remote image (a link card's preview or favicon) has no
  // data-path: it is not a board file, so there is nothing to
  // retry and no missing file to report. Leave it alone — the
  // card's own error handling hides the image area and shows
  // the title and description. Only board-local media gets
  // the missing tile below.
  if (!path) return;
  if (el.dataset?.fallback !== "1") {
    el.dataset.fallback = "1";
    void S.api.files.readFileBase64(path).then(({ mime, base64 }) => {
      el.src = `data:${mime};base64,${base64}`;
    }).catch(() => {
      // The read failed, so the data URL never loads
      // and no second error event ever fires — the
      // comment's "next error event" never comes. Swap
      // the element for the missing tile right here
      // instead of leaving a broken image forever.
      const name = el.dataset?.name ?? "media file";
      const div = document.createElement("div");
      div.className = "missing-media";
      div.textContent = `File missing: ${name}`;
      if (el.parentElement) el.parentElement.replaceChild(div, el);
    });
    return;
  }
  // The data-URL retry also failed, so the file is genuinely
  // unreadable — this is the only case that gets the tile.
  const name = el.dataset?.name ?? "media file";
  const div = document.createElement("div");
  div.className = "missing-media";
  div.textContent = `File missing: ${name}`;
  if (t.parentElement) t.parentElement.replaceChild(div, t);
}, true);

// ---------------------------------------------------------------- keyboard

window.addEventListener("keydown", (e: KeyboardEvent) => {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA") return;
  // Typing in the search box must never trigger board shortcuts:
  // without this, typing "h" would minimise the app, "v" would
  // switch tools, and so on. The search input has its own key
  // handler below, and this window handler stays out of its way.
  if (active && active.id === "search-input") return;
  const ctrl0 = e.ctrlKey || e.metaKey;
  if (ctrl0 && e.key.toLowerCase() === "f") {
    e.preventDefault();
    const input = document.getElementById("search-input") as HTMLInputElement | null;
    if (input) { input.focus(); input.select(); }
    return;
  }
  // Typing in any text input (a plugin's chat or search box,
  // not just the board search) must never trigger board
  // shortcuts: without this, typing "v" in the AI chat
  // switched tools, Backspace deleted the selected card,
  // and a space started panning. Ctrl/Cmd shortcuts,
  // Escape and Tab still work in inputs.
  if (active && active.tagName === "INPUT" && !ctrl0 && e.key !== "Escape" && e.key !== "Tab") return;
  // Focus is on a playing video or audio element: Tab, Space
  // and the arrows are that element's own controls (Tab moves
  // through the video controls, Space toggles play, arrows
  // seek). Let them pass — otherwise Tab cycles cards and
  // Space arms board panning while the video toggles.
  // Escape still falls through to the board handler below.
  if (active && (active.tagName === "VIDEO" || active.tagName === "AUDIO") && e.key !== "Escape") return;
  // Settings open means the board is not listening: without this,
  // Delete deleted the selected card behind the sheet, v/p/a
  // switched tools, and +/- zoomed, all while the user thought
  // they were in Settings. Esc still closes the sheet (handled
  // below), and Tab keeps its normal focus job in the sheet.
  if (S.api.ui.isSettingsOpen() && e.key !== "Escape" && e.key !== "Tab") return;
  // Tab cycles elements, unless Settings is open, where Tab keeps
  // its normal job of moving focus around the sheet.
  if (e.key === "Tab" && !S.api.ui.isSettingsOpen()) {
    // Tab in a text input keeps its normal focus job too: a
    // panel input (a section rename, a search) commits on
    // blur, and Tab is how the user leaves it. Cycling here
    // would steal the blur — the rename would never commit —
    // and the selection with it.
    if (active && active.tagName === "INPUT") return;
    // Focus is on a control — a toolbar or title-bar button,
    // a panel — so Tab keeps its normal job of moving between
    // controls. Without this, Tab could never reach the
    // toolbar, the panels toggle or the title bar at all.
    // Tab only cycles cards when focus is on the board itself.
    if (active && (active.tagName === "BUTTON" || active.closest("#toolbar, #title-bar, #plugin-panels"))) return;
    e.preventDefault();
    navigateElements(e.shiftKey ? -1 : 1);
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === " " || e.key === " ") S.spaceDown = true;
  // Ctrl/Cmd+, is the standard preferences shortcut on the
  // Mac (and in many apps elsewhere). Guarded the same way
  // as the other board keys: Settings being open already
  // returns above, and textareas and the search box return
  // before this, so typing a comma never opens the sheet.
  if (ctrl && e.key === ",") { S.api.ui.openSettings(); return; }
  if (e.key === "Escape") {
    if (S.api.ui.isSettingsOpen()) { S.api.ui.closeSettings(); return; }
    // An active search is cleared first; the next Esc clears the
    // selection, as before. Searching must not eat the selection
    // clear entirely, and clearing the selection must not eat a
    // search the user is still looking at.
    const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
    if (searchInput && searchInput.value.trim() !== "") { S.api.search.clear(); return; }
    S.api.board.setSelected([]);
    // Focus was on a control (a toolbar button, say): blur it
    // so focus returns to the board and Tab cycles cards again.
    if (active && active instanceof HTMLElement) active.blur();
    render();
    return;
  }
  // Ctrl+Z in a text input is text undo, not board undo: the
  // search box is already guarded above, and this covers plugin
  // inputs like the Visual Library search. Without the guard,
  // Ctrl+Z there would undo a board change instead of the text.
  if (e.key.toLowerCase() === "z" && ctrl && !e.shiftKey && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    S.api.board.undo();
  } else if (e.key.toLowerCase() === "z" && ctrl && e.shiftKey && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    S.api.board.redo();
  } else if (e.key.toLowerCase() === "y" && ctrl && !(active && active.tagName === "INPUT")) {
    e.preventDefault();
    S.api.board.redo();
  }
  // V is the one select shortcut: it activates Select with
  // the selection mode last chosen (plain select or lasso),
  // not always plain select. There is no L shortcut any
  // more: it used to toggle the lasso, which V now covers
  // by remembering it.
  else if (e.key.toLowerCase() === "v" && !ctrl) setTool("select");
  // P activates the draw tool last chosen, not always the
  // pen: a pencil stays a pencil. Before any draw tool is
  // used it is the pen, the draw button's default.
  else if (e.key.toLowerCase() === "p" && !ctrl) setTool(S.lastDrawTool ?? "pen");
  else if (e.key.toLowerCase() === "a" && !ctrl) setTool("connector");
  // R is the one geometry shortcut: it activates the shape
  // last chosen, not always the rectangle. Before any shape
  // is used it is the rectangle, the shape button's default.
  // There is no E shortcut any more: it used to switch to
  // the ellipse, which the single R shortcut now covers by
  // remembering it.
  else if (e.key.toLowerCase() === "r" && !ctrl) setTool(S.lastShapeTool ?? "rect");
  else if (e.key.toLowerCase() === "x" && !ctrl) setTool("eraser");
  else if (e.key === "[" && !ctrl) rotateSelected(-15);
  else if (e.key === "]" && !ctrl) rotateSelected(15);
  else if (e.key.toLowerCase() === "g" && ctrl) {
    e.preventDefault();
    groupSelected();
  } else if (e.key.toLowerCase() === "u" && ctrl) {
    e.preventDefault();
    ungroupSelected();
  } else if (e.key === "Backspace" || e.key === "Delete") {
    deleteSelected();
  } else if (e.key === "+" || e.key === "=") { zoomCentre(1.2); S.api.board.save(); render(); }
  else if (e.key === "-") { zoomCentre(1 / 1.2); S.api.board.save(); render(); }
  else if (e.key === "0") { S.api.view.setCamera({ x: 0, y: 0, zoom: 1 }); }
  else if (e.key.toLowerCase() === "f" && !ctrl) zoomToFit();
  else if (e.key.toLowerCase() === "b" && ctrl) {
    // Panels toggle: the only keyboard path to the panels.
    e.preventDefault();
    document.getElementById("panels-toggle")?.click();
  }
  else if (e.key.toLowerCase() === "t" && ctrl) {
    // Focus the toolbar, so its buttons are reachable by
    // keyboard: Tab then moves between them natively.
    e.preventDefault();
    const first = document.querySelector<HTMLElement>("#toolbar button");
    if (first) first.focus();
  }
  else if (e.key === "Enter" && !ctrl) {
    // Create, edit or rename from the keyboard: nothing
    // selected makes a note at the viewport centre; a
    // single text card edits it; a group selection renames
    // the group.
    e.preventDefault();
    const selected = S.api.board.getSelected();
    if (selected.length === 0) {
      const cam = S.api.view.getCamera();
      const rect = S.boardEl.getBoundingClientRect();
      createTextNoteAt({ x: cam.x + rect.width / 2 / cam.zoom, y: cam.y + rect.height / 2 / cam.zoom });
    } else if (selected.length === 1) {
      const it = S.api.board.getItem(selected[0]);
      if (it && "Text" in it.kind) startTextEdit(selected[0]);
      else if (it && "Video" in it.kind) {
        // The same action as the card's play button: a local
        // video plays on the board, a remote link or an
        // unplayable format opens outside the app. Tab cycles
        // the selection to the card, Enter plays it — the
        // button itself is not a Tab stop while Tab cycles
        // cards, so the keyboard path runs through here.
        const v = it.kind.Video;
        if (isInlineVideo(v.source, v.remote)) S.api.media.playVideo(it.id);
        else openExternal(v.source);
      } else if (it && "Audio" in it.kind) S.api.media.toggleAudio(it.id, it.kind.Audio.path);
      else if (it && it.group !== null) startGroupRename(it.group);
    } else {
      const groups = new Set(selected.map((id) => S.api.board.getItem(id)?.group).filter((g): g is number => g !== null && g !== undefined));
      if (groups.size === 1) startGroupRename(groups.values().next().value as number);
    }
  }
  else if (e.key.startsWith("Arrow") && !ctrl) {
    // Nudge the selection: 1 px, or 10 px with Shift.
    e.preventDefault();
    const selected = S.api.board.getSelected();
    if (selected.length === 0) return;
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    const patches = selected.map((id) => {
      const it = S.api.board.getItem(id);
      return it ? { id, pos: { x: it.pos.x + dx, y: it.pos.y + dy } } : null;
    }).filter((p): p is { id: number; pos: { x: number; y: number } } => p !== null);
    if (patches.length > 0) S.api.board.updateItems(patches);
  }
  // Plugin shortcuts, last: core keys above win, so a plugin cannot
  // steal V, P, A, Ctrl+G/U, Delete, zoom or reset. The core guards
  // above (textarea, search box, Settings open) already applied.
  else if (S.editingId === null && !S.api.ui.isSettingsOpen() && !ctrl && S.api.ui.dispatchShortcut(e.key)) { /* plugin handled it */ }
});
window.addEventListener("keyup", (e: KeyboardEvent) => {
  if (e.key === " ") S.spaceDown = false;
});
}

