// The board's input loop: zoom/eraser helpers, text and group
// editing, tools, and the pointer/keyboard listeners. Reads S
// from board-state; calls the render functions in board-render.

import {
  S,
  ACCENT, ERASER_RADIUS,
  boardPoint, boardSize, isFrameCard, toWorld,
  type Tool,
} from "./board-state";
import { isRotatable, membersBounds, normAngle, rotateAngleFor, rotateHandleWorld } from "./board-geometry";
import { dragPreview, updateDraggedCards, updateLassoPreview, clearLiveStroke, clearShapePreview } from "./board-drag-preview";
import { CONNECTOR_TOOL_ID, ERASER_TOOL_ID, PEN_TOOL_ID, drawKindOf, shapeKindOf, shapeToolId } from "./drawing-tools";
import { NEUTRAL_PLUGIN_POINTER_EVENT, beginPluginDrag, cancelPluginDrag, endPluginDrag, hasPluginDragCallbacks, movePluginDrag, toPluginPointerEvent } from "./plugin-tool-drag";
import {
  applyCamera, applyStacking, refreshContentIfVisibleChanged, render, renderSvgOnly, updateResizeHandle, updateSelection,
} from "./board-render";
import {
  Pt,
  isInlineVideo, proportionalResize,
  zoomCamera,
} from "../backend/model";
import { measureNoteCardHeight } from "./text-measure";
import { matches } from "./shortcuts";

// The fallback icon for a creation action that offers
// none of its own, shown beside the text box.
const MIC_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>`;

// ---------------------------------------------------------------- helpers

function zoomAt(screen: Pt, factor: number): void {
  S.api.view.setCameraSilent(zoomCamera(S.api.view.getCamera(), screen, factor));
}
function zoomCentre(factor: number): void {
  const s = boardSize();
  zoomAt({ x: s.x / 2, y: s.y / 2 }, factor);
}
// F: zoom to fit — every item on screen at once. A no-op on
// an empty board. Like the 0 reset, this only moves the view;
// it does not save.
function zoomToFit(): void {
  const bs = boardSize();
  const cam = S.api.geometry.fitCamera({ w: bs.x, h: bs.y });
  if (cam) S.api.view.setCamera(cam);
}

function ensureEraserRing(): HTMLDivElement {
  if (!S.eraserRing) {
    S.eraserRing = document.createElement("div");
    S.eraserRing.id = "eraser-ring";
    document.body.appendChild(S.eraserRing);
  }
  return S.eraserRing;
}
function updateEraserRing(clientX: number, clientY: number, show: boolean): void {
  const ring = ensureEraserRing();
  if (!show) { ring.style.display = "none"; return; }
  const d = ERASER_RADIUS * 2 * S.api.view.getCamera().zoom;
  ring.style.display = "block";
  ring.style.width = `${d}px`;
  ring.style.height = `${d}px`;
  ring.style.left = `${clientX - d / 2}px`;
  ring.style.top = `${clientY - d / 2}px`;
}

// The pen's preview: a short sample of the stroke the pen
// will lay down — the active brush's texture at the pen's
// size, in the pen's colour — following the pointer like
// the eraser ring. A body-level div, not part of the board
// SVG, so renderSvgOnly() never wipes it, and the texture
// is the board's own filter def, referenced by id. It
// rebuilds only when the pen changes (texture, size,
// colour, zoom); moving the pointer just moves the div,
// so the preview never lags a frame behind the mouse.
function ensurePenPreview(): HTMLDivElement {
  if (!S.penPreview) {
    S.penPreview = document.createElement("div");
    S.penPreview.id = "pen-preview";
    document.body.appendChild(S.penPreview);
  }
  return S.penPreview;
}
function updatePenPreview(clientX: number, clientY: number, show: boolean): void {
  const el = ensurePenPreview();
  if (!show) { el.style.display = "none"; return; }
  const zoom = S.api.view.getCamera().zoom;
  const d = S.api.pen.getStrokeDefaults("pen");
  const width = (typeof d.width === "number" ? d.width : 3) * zoom;
  const color = S.api.pen.getColor();
  const h = Math.max(16, width + 10);
  const key = `${d.texture ?? ""}|${width}|${d.marker === true}|${color}|${zoom}`;
  if (key !== S.penPreviewKey) {
    S.penPreviewKey = key;
    const mid = h / 2;
    const filter = d.texture ? ` filter="url(#texture-${d.texture})"` : "";
    const opacity = d.marker === true ? ` opacity="0.45"` : "";
    el.innerHTML = `<svg width="48" height="${h}" viewBox="0 0 48 ${h}" aria-hidden="true"><path d="M4 ${mid} Q 16 ${mid - 4} 24 ${mid} T 44 ${mid}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${filter}${opacity} /></svg>`;
  }
  el.style.display = "block";
  el.style.width = "48px";
  el.style.height = `${h}px`;
  el.style.left = `${clientX - 24}px`;
  el.style.top = `${clientY - h / 2}px`;
}

// ---------------------------------------------------------------- editing

// Whether an item's layer is locked: a locked layer does
// not edit, so its notes never open for typing and no note
// is created on it. Reads the board copy: double-clicks
// are rare, not a hot path.
function isLocked(id: number): boolean {
  const item = S.api.board.getItem(id);
  if (!item) return false;
  const board = S.api.board.get();
  return board.layers?.find((l) => l.id === (item.layer ?? "default"))?.locked ?? false;
}

function createTextNoteAt(world: Pt): void {
  // A new note lands on the default layer: when that layer
  // is locked, double-clicking empty space creates nothing
  // instead of a note that could never be typed into.
  const board = S.api.board.get();
  if (board.layers?.find((l) => l.id === "default")?.locked) return;
  const id = S.api.board.addItemSilent({ Text: { text: "", bold: false, size: 16, color: "#1A1A1A" } }, world, { w: 260, h: 48 });
  // No save here: the commit saves the typed text, or
  // removes the note if it is empty, so an empty note
  // leaves no board change and no undo step behind.
  startTextEdit(id, true);
}

function startTextEdit(id: number, isNew = false): void {
  const item = S.api.board.getItem(id);
  if (!item || !("Text" in item.kind)) return;
  // A locked layer does not edit.
  if (isLocked(id)) return;
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

// Rename a group's label, in place on its frame.
// Double-clicking the label swaps it for an input; Enter
// or leaving the field commits (one undo step), Escape
// cancels. The input is a real input element, so the
// board's pointer and key handlers leave it alone: the
// pointerdown guard ignores inputs, and typing in one
// never triggers board shortcuts.
// Wire a rename input: Enter or leaving the field
// commits, Escape cancels, and only the first of
// commit/cancel runs. Used by the group-label rename.
function wireRenameInput(input: HTMLInputElement, onCommit: () => void): void {
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

function startGroupRename(group: number): void {
  const board = S.api.board.get();
  const label = board.groups?.[group]?.label ?? `Group ${group}`;
  const chip = S.groupsEl.querySelector(`.group-label[data-group="${group}"]`) as HTMLElement | null;
  if (!chip) return;
  const input = document.createElement("input");
  input.className = "group-rename";
  input.value = label;
  input.setAttribute("aria-label", "Group name");
  input.style.width = `${Math.max(8, label.length + 2)}ch`;
  chip.textContent = "";
  chip.appendChild(input);
  wireRenameInput(input, () => {
    if (input.value.trim() !== "" && input.value !== label) S.api.board.setGroupLabel(group, input.value);
  });
}


export function commitEditingIfAny(): void {
  if (S.editingId === null) return;
  const ta = S.cardsEl.querySelector("textarea.note-edit") as HTMLTextAreaElement | null;
  if (ta) ta.blur();
  else { S.editingId = null; render(); }
}

// ---------------------------------------------------------------- tools

// End an active plugin drag as a cancel: report it to
// the tool at its last point, clear the preview, drop
// the state. Only a plugin drag can be cancelled here.
function cancelPluginDragIfActive(): void {
  if (S.drag?.kind !== "plugin") return;
  const d = S.drag;
  S.drag = null;
  const pt = S.api.ui.getToolDef(d.fullId);
  if (pt) {
    try { cancelPluginDrag(pt, d, NEUTRAL_PLUGIN_POINTER_EVENT); } catch (e) { S.api.ui.toast(`Plugin tool failed: ${String(e)}`); }
  }
  clearLiveStroke();
  clearShapePreview();
}

export function setTool(t: Tool): void {
  S.tool = t;
  // The draw tools share one toolbar button and one
  // shortcut (P): remember the draw tool last chosen, so
  // P activates that one instead of always the pen.
  if (drawKindOf(t) !== null) S.lastDrawTool = t;
  // The geometry shapes share one toolbar button and one
  // shortcut (R): remember the shape last chosen, so R
  // activates that one instead of always the rectangle.
  if (shapeKindOf(t) !== null) S.lastShapeTool = t;
  // Lasso mode belongs to Select only: leaving Select
  // turns it off, and returning to Select restores the
  // selection mode last chosen (select or lasso) — so V
  // activates the lasso if that was last used.
  S.lassoMode = t === "select" && S.lastSelectMode === "lasso";
  // Switching tools mid-drag cancels a plugin drag: the
  // tool hears onPointerCancel, so it can drop the stroke
  // it was building instead of leaving it armed.
  cancelPluginDragIfActive();
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

function cornerHit(id: number, world: Pt): boolean {
  const cam = S.api.view.getCamera();
  const it = S.api.board.getItem(id);
  if (!it || "Connector" in it.kind) return false;
  const [p, s] = S.api.geometry.itemBounds(it);
  const corner = S.api.geometry.rotatePoint({ x: p.x + s.w, y: p.y + s.h }, S.api.geometry.centre(it), S.api.geometry.itemRotation(it));
  const tol = 16 / cam.zoom;
  return Math.hypot(world.x - corner.x, world.y - corner.y) <= tol;
}
function rotateHit(id: number, world: Pt): boolean {
  const cam = S.api.view.getCamera();
  const it = S.api.board.getItem(id);
  if (!it || !isRotatable(it, isFrameCard)) return false;
  const h = rotateHandleWorld(it, S.api.view.getCamera());
  const tol = 18 / cam.zoom;
  return Math.hypot(world.x - h.x, world.y - h.y) <= tol;
}
function rotateSelected(delta: number): boolean {
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
function navigateElements(dir: 1 | -1): void {
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

// An audio drag-scrub in progress: the card id, file path,
// and the element whose width maps to the duration — the
// waveform itself, or the timeline's track (not the whole
// row, whose time labels flank it). Pointermove keeps
// seeking without re-hitting the board. Set by the cards
// pointerdown below, cleared on pointerup.
let audioScrub: { id: number; path: string; el: Element } | null = null;
// A drag that started on a playing video: the press is on the
// <video> element, and the click that follows the pointerup
// would land on its controls and toggle playback (or seek).
// The capture-phase click listener below swallows that one
// click. Set on every pointerdown, cleared on pointerup.
let dragStartedOnVideo = false;
// Until when a click on a video is swallowed (see above): a
// timestamp, so a genuine click a moment later still works.
let suppressVideoClickUntil = 0;
function seekAudioAt(e: PointerEvent): void {
  if (!audioScrub) return;
  const r = audioScrub.el.getBoundingClientRect();
  if (r.width <= 0) return;
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const dur = S.api.media.getAudioDuration(audioScrub.path) ?? S.api.media.getAudioState().duration;
  if (!isFinite(dur) || dur <= 0) return;
  S.api.media.seekAudioTo(audioScrub.id, audioScrub.path, frac * dur);
}

export function attachBoardListeners(): void {
  S.boardEl.addEventListener("pointerdown", (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    dragStartedOnVideo = target.closest("video") !== null;
    // A press on a playing video is NOT ignored: the video
    // fills its card, so it is the only place to grab it, and
    // a drag on it must move the card. A plain click still
    // reaches the controls — the click that follows a drag
    // that actually moved is swallowed by the capture-phase
    // click listener below instead.
    if (target.closest("#toolbar, #settings-backdrop, #toast, #plugin-overlays, #search-box, #title-bar, input, canvas.model3d, [data-audio-wave], [data-audio-timeline]")) return;
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
      // A drag tool owns the gesture from this press: the
      // core routes every pointermove to it until pointerup
      // or cancel, and no core drag runs. A tool with no
      // drag callbacks keeps the old click behaviour below.
      if (pt && hasPluginDragCallbacks(pt)) {
        try {
          S.drag = beginPluginDrag(pt, S.tool, world, toPluginPointerEvent(e));
        } catch (err) {
          S.api.ui.toast(`Plugin tool failed: ${String(err)}`);
        }
        return;
      }
      if (pt?.onMouseDown) {
        try { pt.onMouseDown(world); } catch (e) { S.api.ui.toast(`Plugin tool failed: ${String(e)}`); }
        S.pluginToolDown = true;
        return;
      }
      return;
    }
    if (S.spaceDown) { S.drag = { kind: "pan", last: winPt }; return; }
    if (S.tool === "select" && S.lassoMode) {
      S.drag = { kind: "lasso", points: [world] };
      return;
    }
    // Select tool.
    // The press's own timestamp, not the wall clock: on a
    // busy board the main thread can process the second
    // press more than 500ms after it happened, and the
    // double-click would be missed. e.timeStamp is when
    // the press occurred, so the gap is the user's gap.
    const now = e.timeStamp;
    const isDoubleClick =
      now - S.lastPointerDown.t < 500 &&
      Math.hypot(winPt.x - S.lastPointerDown.x, winPt.y - S.lastPointerDown.y) < 5;
    S.lastPointerDown = { x: winPt.x, y: winPt.y, t: now };
    if (isDoubleClick) {
      // Without this, the browser's default mousedown focus runs after
      // this handler and steals focus from a textarea created here, so
      // typing would never land in a new or edited note.
      e.preventDefault();
      // Double-clicking a group label renames the group,
      // instead of creating a note under it (the label sits
      // in the frame's padding, which is empty board space).
      const labelEl = target.closest(".group-label") as HTMLElement | null;
      if (labelEl) { startGroupRename(Number(labelEl.dataset.group)); return; }
      const hit = S.api.board.hitTest(world);
      if (hit !== null) {
        const it = S.api.board.getItem(hit);
        if (it && "Plugin" in it.kind && S.api.cards.dispatchDoubleClick(it)) return;
        if (it && "Text" in it.kind) { startTextEdit(hit); return; }
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

  // A drag that started on a playing video and actually moved
  // must not also toggle its controls: swallow the one click
  // that follows the pointerup. Capture phase, so the event
  // never reaches the video's controls at all. A plain click
  // (no drag) is unaffected, and the flag expires on its own,
  // so a genuine click a moment later still works.
  S.cardsEl.addEventListener("click", (e: MouseEvent) => {
    if (Date.now() > suppressVideoClickUntil) return;
    if (!(e.target as HTMLElement).closest("video")) return;
    suppressVideoClickUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);

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
  });

    // The waveform and the timeline are both seek controls:
    // pointerdown seeks, and dragging across them scrubs. The
    // board's own pointerdown ignores them (see the guard
    // above), so this never drags the card. Arrow keys seek
    // when either has focus, instead of nudging the selection.
    S.cardsEl.addEventListener("pointerdown", (e: PointerEvent) => {
      const target = (e.target as HTMLElement).closest("[data-audio-wave], [data-audio-timeline]") as Element | null;
      if (!target) return;
      const id = Number((target as HTMLElement).dataset.audioWave ?? (target as HTMLElement).dataset.audioTimeline);
      const it = S.api.board.getItem(id);
      if (!it || !("Audio" in it.kind)) return;
      e.preventDefault();
      // The seek range is the wave itself, or the timeline's
      // track — not the whole row, whose time labels flank it.
      const el = target.classList.contains("audio-timeline")
        ? (target.querySelector(".audio-track") ?? target)
        : target;
      audioScrub = { id, path: it.kind.Audio.path, el };
      seekAudioAt(e);
    });
    S.cardsEl.addEventListener("keydown", (e: KeyboardEvent) => {
      const target = (e.target as HTMLElement).closest("[data-audio-wave], [data-audio-timeline]") as Element | null;
      if (!target || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const id = Number((target as HTMLElement).dataset.audioWave ?? (target as HTMLElement).dataset.audioTimeline);
      const it = S.api.board.getItem(id);
      if (!it || !("Audio" in it.kind)) return;
      const state = S.api.media.getAudioState();
      const dur = S.api.media.getAudioDuration(it.kind.Audio.path) ?? state.duration;
      if (!isFinite(dur) || dur <= 0) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = state.id === id ? state.currentTime : 0;
      const step = e.shiftKey ? 10 : 5;
      S.api.media.seekAudioTo(id, it.kind.Audio.path, Math.min(dur, Math.max(0, cur + (e.key === "ArrowRight" ? step : -step))));
    });
}

function openExternal(target: string): void {
  S.api.files.openExternal(target).catch((e) => S.api.ui.toast(`Could not open ${target}: ${String(e)}`));
}

// ---------------------------------------------------------------- mouse


export function attachWindowListeners(): void {
  if (S.listenersAttached) return;
  S.listenersAttached = true;

  window.addEventListener("pointermove", (e: PointerEvent) => {
    if (audioScrub) {
      seekAudioAt(e);
      return;
    }
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
          } else if (S.tool === ERASER_TOOL_ID || S.tool === PEN_TOOL_ID) {
            // The ring / preview is the cursor while
            // erasing or drawing with the pen: no crosshair.
            S.boardEl.style.cursor = "none";
          } else if (S.tool.startsWith("plugin:") || (S.tool === "select" && S.lassoMode)) {
            S.boardEl.style.cursor = "crosshair";
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
      // The pen preview follows the same rule.
      const overBoard = !(e.target as HTMLElement).closest("#toolbar, #settings-backdrop, #plugin-panels, #title-bar, #plugin-overlays, #plugin-view, input, textarea, select");
      const showRing = S.tool === ERASER_TOOL_ID && overBoard && !S.api.ui.isSettingsOpen() && S.editingId === null && S.api.view.getView() === "board";
      updateEraserRing(e.clientX, e.clientY, showRing);
      const showPen = S.tool === PEN_TOOL_ID && overBoard && !S.api.ui.isSettingsOpen() && S.editingId === null && S.api.view.getView() === "board";
      updatePenPreview(e.clientX, e.clientY, showPen);
      return;
    }
    S.boardEl.style.cursor = S.drag.kind === "resize" ? "nwse-resize" : S.drag.kind === "rotate" ? "grabbing" : S.drag.kind === "pan" ? "grabbing" : S.drag.kind === "move" ? "move" : (S.drag.kind === "plugin" && S.drag.fullId === ERASER_TOOL_ID) ? "none" : "default";
    // While dragging, the live stroke is the feedback, so
    // the pen preview hides; the eraser ring stays, as before.
    updatePenPreview(e.clientX, e.clientY, false);
    if (S.drag.kind === "plugin") {
      const fullId = S.drag.fullId;
      const pt = S.api.ui.getToolDef(fullId);
      if (pt) {
        try { S.drag = movePluginDrag(pt, S.drag, world, toPluginPointerEvent(e)); } catch (err) { S.api.ui.toast(`Plugin tool failed: ${String(err)}`); }
      }
      // The ring is the eraser's cursor, so it follows the
      // pointer through the drag, not just on hover.
      if (fullId === ERASER_TOOL_ID) updateEraserRing(e.clientX, e.clientY, true);
    } else if (S.drag.kind === "pan") {
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
      // Strokes are cards now, so they move with the rest of
      // the selection through updateDraggedCards; the SVG
      // layer only changes when a connector follows a dragged
      // card. Skipping the redraw on a board with no
      // connectors also skips the full api.board.get() deep
      // copy renderSvgOnly does on every pointermove.
      // (cachedBoard is set on every render; if it is
      // somehow null, redraw as before.)
      if (!S.cachedBoard || S.cachedBoard.items.some((it) => "Connector" in it.kind)) renderSvgOnly();
      updateResizeHandle();
    } else if (S.drag.kind === "resize") {
      // A resize keeps the card's ratio: the drag scales the
      // card by one factor, so it can never be stretched.
      const next = proportionalResize(S.drag.origW, S.drag.origH, world.x - S.drag.startWorld.x, world.y - S.drag.startWorld.y);
      S.api.board.resizeItem(S.drag.id, next.w, next.h);
      if (Math.hypot(world.x - S.drag.startWorld.x, world.y - S.drag.startWorld.y) > 2) S.drag.moved = true;
      updateDraggedCards([S.drag.id]);
      updateResizeHandle();
    } else if (S.drag.kind === "lasso") {
      const cam = S.api.view.getCamera();
      const last = S.drag.points[S.drag.points.length - 1];
      if (Math.hypot(world.x - last.x, world.y - last.y) > 2 / cam.zoom) {
        S.drag.points.push(world);
        updateLassoPreview(S.drag.points);
      }
    } else if (S.drag.kind === "rotate") {
      // The live item: this only reads it (centre, size),
      // and a rotate drag reads it on every pointermove.
      const it = S.api.board.getItemLive(S.drag.id);
      if (it) {
        const rot = rotateAngleFor(world, it, e.shiftKey);
        if (Math.abs(rot - S.drag.origRot) > 1) S.drag.moved = true;
        S.api.board.setItemRotation(S.drag.id, rot);
        const el = S.cardsEl.querySelector(`[data-id="${S.drag.id}"]`) as HTMLElement | null;
        if (el) el.style.transform = rot ? `rotate(${rot}deg)` : "";
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
    audioScrub = null;
    // A plugin drag ends here: the tool hears onPointerUp
    // at the release point and commits what it drew, then
    // the preview clears — even when the tool committed
    // nothing and no render follows to wipe it.
    if (S.drag?.kind === "plugin") {
      const d = S.drag;
      S.drag = null;
      const pt = S.api.ui.getToolDef(d.fullId);
      if (pt) {
        try { endPluginDrag(pt, toWorld(boardPoint(e.clientX, e.clientY)), toPluginPointerEvent(e)); } catch (err) { S.api.ui.toast(`Plugin tool failed: ${String(err)}`); }
      }
      clearLiveStroke();
      clearShapePreview();
      return;
    }
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
    if (d.kind === "lasso") {
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
      // A drag that started on a playing video and actually
      // moved must not also toggle its controls: swallow the
      // click that follows this pointerup (see the capture
      // listener below). A click that never moved is a plain
      // click on the controls, and is left alone.
      if (d.moved && dragStartedOnVideo) suppressVideoClickUntil = Date.now() + 500;
      dragStartedOnVideo = false;
    }
    // A drag that actually moved was a drag, not a click: its
    // pointerdown must not count toward a double-click, or the
    // next click on the same spot within 500ms opens the note
    // editor instead of selecting — the drag's mousedown and
    // the click are the same point, so the time check alone
    // decides, and the gap after an undo is short. Only the
    // select tool records lastPointerDown, so only its drags
    // (move/resize/rotate/marquee) need clearing here. A
    // click that never moved leaves it alone, so a real
    // double-click (two clicks, no drag between) still works.
    const dragMoved =
      ((d.kind === "move" || d.kind === "resize" || d.kind === "rotate") && d.moved) ||
      (d.kind === "marquee" && (Math.abs(world.x - d.start.x) >= 3 || Math.abs(world.y - d.start.y) >= 3));
    if (dragMoved) S.lastPointerDown = { x: 0, y: 0, t: 0 };
    // A move/resize that actually moved is safe to rebuild once at
    // the end (it refreshes truncation and connector endpoints with
    // their final geometry). A move/resize that never moved was a
    // click, not a drag: rebuilding here would destroy the card
    // button just pressed, so its click would never fire.
    if (d.kind === "marquee" || d.kind === "lasso" || (d.kind === "rotate" && d.moved)) {
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

  // A pointercancel ends a plugin drag the way a pointerup
  // does, except the tool hears it as a cancel, at the
  // drag's last point — the cancel carries no fresh position.
  // Core drags keep their behaviour.
  window.addEventListener("pointercancel", (e: PointerEvent) => {
    if (S.drag?.kind !== "plugin") return;
    const d = S.drag;
    S.drag = null;
    const pt = S.api.ui.getToolDef(d.fullId);
    if (pt) {
      try { cancelPluginDrag(pt, d, toPluginPointerEvent(e)); } catch (err) { S.api.ui.toast(`Plugin tool failed: ${String(err)}`); }
    }
    clearLiveStroke();
    clearShapePreview();
  });

  // The ring must not freeze at the edge when the pointer
  // leaves the window mid-erase.
  document.addEventListener("mouseleave", () => { updateEraserRing(0, 0, false); updatePenPreview(0, 0, false); });
  document.addEventListener("pointerleave", () => { updateEraserRing(0, 0, false); updatePenPreview(0, 0, false); });

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
      // frame. The zoom itself is only a camera transform —
      // no content rebuild during the gesture. Rebuilding
      // the card DOM mid-pinch (the old periodic refresh)
      // blocked the main thread for ~50ms every ~250ms,
      // which is the hitch that made the pinch feel hard.
      // Cards that come into view appear when the gesture
      // settles (see the timer below), up to 120ms later;
      // the cards already on screen scale smoothly meanwhile.
      // Sensitivity: 0.005 — a full trackpad pinch used to
      // give only ~1.8x at 0.003 and felt slow, so it was
      // raised from 0.0015 to 0.003 and then to 0.005. A
      // mouse-wheel notch still moves a sensible step.
      // deltaMode is normalised first, so a line-based wheel
      // (deltaY in lines) and a pixel-based trackpad pinch
      // both land on the same scale.
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      S.pendingZoomFactor *= Math.exp(-dy * 0.005);
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
        });
      }
      if (S.zoomSettleTimer) clearTimeout(S.zoomSettleTimer);
      S.zoomSettleTimer = setTimeout(() => {
        refreshContentIfVisibleChanged();
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
    if (matches(e, "search")) {
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
      // panel input (a group-label rename, a search) commits on
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
    if (matches(e, "open-settings")) { S.api.ui.openSettings(); return; }
    if (e.key === "Escape") {
      // A plugin drag cancels first: Escape ends the drag
      // the tool is in, so it can drop the stroke it was
      // building, instead of only clearing the selection
      // under it.
      cancelPluginDragIfActive();
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
    if (matches(e, "undo") && !(active && active.tagName === "INPUT")) {
      e.preventDefault();
      S.api.board.undo();
    } else if (matches(e, "redo") && !(active && active.tagName === "INPUT")) {
      e.preventDefault();
      S.api.board.redo();
    } else if (e.key.toLowerCase() === "y" && ctrl && !(active && active.tagName === "INPUT")) {
      // Ctrl+Y is a fixed redo alias, not a rebindable action.
      e.preventDefault();
      S.api.board.redo();
    }
    // V is the one select shortcut: it activates Select with
    // the selection mode last chosen (plain select or lasso),
    // not always plain select. There is no L shortcut any
    // more: it used to toggle the lasso, which V now covers
    // by remembering it.
    else if (matches(e, "select")) setTool("select");
    // P activates the draw tool last chosen, not always the
    // pen: an eraser stays an eraser. Before any draw tool is
    // used it is the pen, the draw button's default.
    else if (matches(e, "pen")) setTool(S.lastDrawTool ?? PEN_TOOL_ID);
    else if (matches(e, "connector")) setTool(CONNECTOR_TOOL_ID);
    // R is the one geometry shortcut: it activates the shape
    // last chosen, not always the rectangle. Before any shape
    // is used it is the rectangle, the shape button's default.
    // There is no E shortcut any more: it used to switch to
    // the ellipse, which the single R shortcut now covers by
    // remembering it.
    else if (matches(e, "shape")) setTool(S.lastShapeTool ?? shapeToolId("rect"));
    else if (matches(e, "eraser")) setTool(ERASER_TOOL_ID);
    else if (matches(e, "rotate-left")) rotateSelected(-15);
    else if (matches(e, "rotate-right")) rotateSelected(15);
    else if (matches(e, "group")) {
      e.preventDefault();
      groupSelected();
    } else if (matches(e, "ungroup")) {
      e.preventDefault();
      ungroupSelected();
    } else if (matches(e, "delete")) {
      deleteSelected();
    } else if (matches(e, "zoom-in")) { zoomCentre(1.2); S.api.board.save(); render(); }
    else if (matches(e, "zoom-out")) { zoomCentre(1 / 1.2); S.api.board.save(); render(); }
    else if (matches(e, "reset-view")) { S.api.view.setCamera({ x: 0, y: 0, zoom: 1 }); }
    else if (matches(e, "zoom-fit")) zoomToFit();
    else if (matches(e, "toggle-panels")) {
      // Panels toggle: the only keyboard path to the panels.
      e.preventDefault();
      document.getElementById("panels-toggle")?.click();
    }
    else if (matches(e, "focus-toolbar")) {
      // Focus the toolbar, so its buttons are reachable by
      // keyboard: Tab then moves between them natively.
      e.preventDefault();
      const first = document.querySelector<HTMLElement>("#toolbar button");
      if (first) first.focus();
    }
    else if (matches(e, "create-edit")) {
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

