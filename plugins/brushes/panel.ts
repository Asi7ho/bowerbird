// Brush Library — the panel: brush presets, each a row
// with a texture preview. Click a brush to apply it —
// to the selected strokes, or as the active brush when
// nothing is selected — and its parameters open below it
// in the list: name, texture settings, pressure curve,
// and a live preview of what the new brush would draw.
// The parameters are a draft: the original brush is
// untouched until Save, which creates a new brush from
// the edited settings (a new texture when the texture
// parameters changed) and selects it. Size lives in the
// toolbar, not here. A brush configures its core tool
// through the pen's stroke defaults, so it adds no
// toolbar tool of its own.
import type { PluginContext } from "bowerbird-plugin-api";
import { activateBrush, applyBrush, applyBrushDefaults } from "./apply.js";
import { copyCurve, curveSegmentControls, LINEAR_CURVE, type CurvePoint } from "./curve.js";
import {
  createPreset, createTexture, deletePreset, emptyStore,
  nextPresetName, seededStore,
  type BrushPreset, type BrushStore,
} from "./store.js";
import { BUILTIN_TEXTURES, textureFilterSvg, type TextureParams } from "./textures.js";
import { clearSettings, settingsContains } from "./settings.js";

let api: PluginContext | null = null;
let store: BrushStore = emptyStore();
let selectedId: string | null = null;
// The brush whose parameters are open below its row, or
// null when no expansion is open. It follows the row the
// user clicked, never a tool change.
let expandedId: string | null = null;
// The expansion's draft: the edited settings, leaving
// the original brush unchanged until Save. The name, the
// texture parameters and the curve are all draft; the
// size stays the source brush's, since size lives in the
// toolbar. The basis is the source brush's own custom
// texture, or the defaults for a built-in texture or plain
// ink — Save makes a new texture only when the parameters
// moved from that basis.
let draftSourceId: string | null = null;
let draftName = "";
let draftParams: TextureParams = { baseFrequency: 0.5, octaves: 2, scale: 4, seed: 1 };
let draftBasisParams: TextureParams = { baseFrequency: 0.5, octaves: 2, scale: 4, seed: 1 };
let draftCurve: CurvePoint[] = copyCurve(LINEAR_CURVE);
let draftTouchedParams = false;
const DEFAULT_TEXTURE_PARAMS: TextureParams = { baseFrequency: 0.5, octaves: 2, scale: 4, seed: 1 };
// The active brush: the one the pen draws with. One
// brush, not one per tool — there is only the pen now,
// and picking a brush is picking what the pen draws like.
let activeBrushId: string | null = null;
let brushesEl: HTMLDivElement | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// Undo for the library itself: a snapshot of the store
// (and the active brush) before each committed change —
// Save, Delete, Reset — so Ctrl+Z can bring back a
// deleted brush or drop a saved one. The board has its
// own undo; the shortcut undoes whichever changed most
// recently. boardEditsSincePanelEdit counts board edits
// since the last library change that no undo has taken
// back yet, so a library change behind board strokes is
// still reached, one Ctrl+Z per stroke, instead of never.
interface PanelUndoEntry {
  store: BrushStore;
  activeBrushId: string | null;
}
let panelUndoStack: PanelUndoEntry[] = [];
let panelRedoStack: PanelUndoEntry[] = [];
let boardEditsSincePanelEdit = 0;
let lastUndoneKind: "panel" | "board" | null = null;
// The core fires "board" synchronously on every board
// change, including the panel's own undo and redo —
// this keeps those from counting as new board edits.
let suppressBoardEvent = false;

function getPresetById(id: string): BrushPreset | undefined {
  return store.presets.find((p) => p.id === id);
}

function activePreset(): BrushPreset | undefined {
  return activeBrushId ? getPresetById(activeBrushId) : store.presets[0];
}

// The active brush's settings onto the pen.
function pushActiveDefaults(): void {
  if (!api) return;
  const preset = activePreset();
  if (preset) applyBrushDefaults(api, preset);
}

// The selection and the defaults follow the active brush:
// the pen draws with it. The tool does not matter any
// more — there is only the pen — so a tool switch leaves
// the brush alone and only pushes its settings again.
export function syncDefaults(): void {
  if (!api) return;
  const preset = activePreset();
  if (preset) selectedId = preset.id;
  pushActiveDefaults();
}

function snapshotLibrary(): PanelUndoEntry {
  return {
    store: JSON.parse(JSON.stringify(store)) as BrushStore,
    activeBrushId,
  };
}

// Remember the library as it is now, before a committed
// change mutates it. A new change means there is nothing
// left to redo, and the board-edit count restarts: the
// change is the most recent one until the board moves.
function rememberLibrary(): void {
  panelUndoStack.push(snapshotLibrary());
  if (panelUndoStack.length > 50) panelUndoStack.shift();
  panelRedoStack = [];
  boardEditsSincePanelEdit = 0;
  lastUndoneKind = null;
}

// Put a snapshot back: the store, the active brush, and
// the selection with it, then re-render and push the
// active brush's settings onto the pen again.
function restoreLibrary(entry: PanelUndoEntry): void {
  closeExpansion();
  activeBrushId = entry.activeBrushId;
  selectedId = entry.activeBrushId;
  commitStore(entry.store);
  syncDefaults();
}

function restorePanelUndo(): boolean {
  const entry = panelUndoStack.pop();
  if (!entry) return false;
  panelRedoStack.push(snapshotLibrary());
  restoreLibrary(entry);
  lastUndoneKind = "panel";
  return true;
}

function restorePanelRedo(): boolean {
  const entry = panelRedoStack.pop();
  if (!entry) return false;
  panelUndoStack.push(snapshotLibrary());
  restoreLibrary(entry);
  lastUndoneKind = "panel";
  return true;
}

function undoFromPanel(): void {
  if (!api) return;
  // A library change with no board edit after it is the
  // most recent change: take it back first.
  if (panelUndoStack.length > 0 && boardEditsSincePanelEdit === 0 && restorePanelUndo()) return;
  // Otherwise the board's turn: one undo step, and the
  // count of board edits since the library change drops.
  suppressBoardEvent = true;
  const undone = api.board.undo();
  suppressBoardEvent = false;
  if (undone) {
    if (boardEditsSincePanelEdit > 0) boardEditsSincePanelEdit--;
    lastUndoneKind = "board";
    return;
  }
  // The board had nothing left to undo: the library
  // change is next, on this same press.
  restorePanelUndo();
}

function redoFromPanel(): void {
  if (!api) return;
  // Redo follows the last undo: a library undo redoes
  // the library, a board undo redoes the board.
  if (lastUndoneKind === "panel" && panelRedoStack.length > 0 && restorePanelRedo()) return;
  suppressBoardEvent = true;
  const redone = api.board.redo();
  suppressBoardEvent = false;
  if (redone) {
    boardEditsSincePanelEdit++;
    lastUndoneKind = "board";
    return;
  }
  restorePanelRedo();
}

// A board edit — not one the panel's own undo or redo
// just made. It counts as one more board step since the
// last library change, and it ends any redo: a new edit
// means the redone state is gone.
function onBoardChange(): void {
  if (suppressBoardEvent) return;
  boardEditsSincePanelEdit++;
  panelRedoStack = [];
  lastUndoneKind = null;
}

// The undo and redo shortcuts, caught here in the panel
// before the board's own handler sees them. The board's
// handler skips the shortcut whenever focus is on an
// input — a slider, the brush name — so from the panel
// Ctrl+Z would do nothing at all. The panel takes it
// instead, from every focus state inside it, and routes
// it to the library or the board, whichever changed
// most recently. A text input with edits since it was
// focused keeps its own undo: the first Ctrl+Z undoes
// the text, and only the next one reaches the board.
function onPanelKeydown(e: KeyboardEvent): void {
  if (!api) return;
  const target = e.target as Node | null;
  const inPanel = (brushesEl !== null && target !== null && brushesEl.contains(target))
    || settingsContains(target);
  if (!inPanel) return;
  if (!e.metaKey && !e.ctrlKey) return;
  const key = e.key.toLowerCase();
  const isUndo = key === "z" && !e.shiftKey;
  const isRedo = (key === "z" && e.shiftKey) || key === "y";
  if (!isUndo && !isRedo) return;
  const active = document.activeElement as HTMLInputElement | null;
  if (active !== null && active.tagName === "INPUT" && active.type === "text"
    && active.value !== (active.dataset.valueAtFocus ?? "")) return;
  e.stopPropagation();
  e.preventDefault();
  if (isUndo) undoFromPanel();
  else redoFromPanel();
}

export function initPanel(a: PluginContext, initial: BrushStore): void {
  api = a;
  store = initial;
  selectedId = store.presets[0]?.id ?? null;
  activeBrushId = store.presets[0]?.id ?? null;
  expandedId = null;
  closeDraft();
  if (api.events) api.events.on("tool", onToolChange);
  if (api.events) api.events.on("board", onBoardChange);
  window.addEventListener("keydown", onPanelKeydown, true);
}

export function clearPanel(): void {
  if (api?.events) api.events.off("tool", onToolChange);
  if (api?.events) api.events.off("board", onBoardChange);
  window.removeEventListener("keydown", onPanelKeydown, true);
  clearSettings();
  api = null;
  store = emptyStore();
  selectedId = null;
  activeBrushId = null;
  expandedId = null;
  closeDraft();
  brushesEl = null;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  panelUndoStack = [];
  panelRedoStack = [];
  boardEditsSincePanelEdit = 0;
  lastUndoneKind = null;
  suppressBoardEvent = false;
}

function onToolChange(): void {
  syncDefaults();
  renderBrushes();
}

function scheduleSave(): void {
  if (!api || !api.storage) return;
  // Debounced: every brush edit used to rewrite the
  // whole plugin-storage file at once, which is a full
  // IPC call plus a synchronous disk write per edit.
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!api || !api.storage) return;
    void api.storage.set("brushes", store).catch(() => { /* storage is a convenience, not a brush */ });
  }, 250);
}

function commitStore(next: BrushStore): void {
  if (next === store) return;
  store = next;
  scheduleSave();
  renderBrushes();
  pushActiveDefaults();
}

// The draft is just in-progress edits: clearing it
// forgets them, and the original brush stands.
function closeDraft(): void {
  draftSourceId = null;
  draftName = "";
  draftParams = { ...DEFAULT_TEXTURE_PARAMS };
  draftBasisParams = { ...DEFAULT_TEXTURE_PARAMS };
  draftCurve = copyCurve(LINEAR_CURVE);
  draftTouchedParams = false;
}

function closeExpansion(): void {
  expandedId = null;
  closeDraft();
}

// Open the parameters below a brush: the draft starts
// from it, so tweaking one starts from its values. A
// custom texture's parameters carry over; a built-in
// brush starts from the defaults, and the preview shows
// the draft texture, not the built-in.
function openExpansion(preset: BrushPreset): void {
  expandedId = preset.id;
  draftSourceId = preset.id;
  draftName = preset.name;
  const custom = preset.texture ? store.textures.find((t) => t.id === preset.texture) : undefined;
  draftBasisParams = custom
    ? { baseFrequency: custom.baseFrequency, octaves: custom.octaves, scale: custom.scale, seed: custom.seed }
    : { ...DEFAULT_TEXTURE_PARAMS };
  draftParams = { ...draftBasisParams };
  draftCurve = copyCurve(preset.curve);
  draftTouchedParams = false;
}

function paramsDiffer(a: TextureParams, b: TextureParams): boolean {
  return a.baseFrequency !== b.baseFrequency || a.octaves !== b.octaves || a.scale !== b.scale || a.seed !== b.seed;
}

// Whether Save makes a new texture: the parameters were
// touched and moved from the source brush's basis.
function draftNeedsNewTexture(): boolean {
  return draftTouchedParams && paramsDiffer(draftParams, draftBasisParams);
}

// Delete a brush by index, and move the pen and the
// selection to the first brush left, so neither points
// at a brush that is gone. Shared by the row's delete
// and the expansion's Delete.
function deleteBrushAt(index: number): BrushStore {
  const preset = store.presets[index];
  const next = deletePreset(store, index);
  if (preset) {
    if (activeBrushId === preset.id) activeBrushId = next.presets[0]?.id ?? null;
    if (selectedId === preset.id) selectedId = next.presets[0]?.id ?? null;
    if (expandedId === preset.id) closeExpansion();
  }
  return next;
}

// Reset the library to the eight factory presets: custom
// brushes and textures go, deleted or changed built-ins
// come back. Strokes already on the board keep the
// texture they were drawn with.
export function resetLibrary(): void {
  rememberLibrary();
  const first = seededStore().presets[0];
  selectedId = first?.id ?? null;
  activeBrushId = selectedId;
  closeExpansion();
  commitStore(seededStore());
}

// An icon button, not a text glyph: the icon is an SVG
// in the toolbar's style (stroke, no fill).
function svgButton(label: string, title: string, svg: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "br-icon-btn";
  b.innerHTML = svg;
  b.title = title;
  b.setAttribute("aria-label", label);
  return b;
}

// The toolbar's trash can, as an outline SVG.
const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" /><path d="M10 10.5v5M14 10.5v5" /></svg>';

function textureLabel(id: string | null): string {
  if (!id) return "None";
  const builtin = BUILTIN_TEXTURES.find((t) => t.id === id);
  if (builtin) return builtin.label;
  return store.textures.find((t) => t.id === id)?.name ?? id;
}

// A brush row's preview: one stroke at the size the
// brush draws, at the scale it draws at — a truthful
// miniature of the drawn stroke. A highlighter-family
// brush previews translucent, like it draws. The sample
// wraps the path in a group with a spacer rect the size
// of the viewBox, so the shared filter's region spans
// the whole sample (a straight path's own box has no
// height). The viewBox is 30 tall so Spray's scatter
// band fits whole.
function previewSvg(preset: BrushPreset): string {
  // A wash at 0.45 read as a faded grey smear next
  // to Ink; 0.65 stays translucent but reads as a mark.
  const opacity = preset.family === "highlighter" ? ` opacity="0.65"` : "";
  const w = preset.size;
  const d = "M10 15 L 98 15";
  const stroke = `<path d="${d}" fill="none" stroke="#1A1A1A" stroke-width="${w}" stroke-linecap="round"${opacity} />`;
  if (!preset.texture) {
    return `<svg viewBox="0 0 108 30" aria-hidden="true">${stroke}</svg>`;
  }
  return `<svg viewBox="0 0 108 30" aria-hidden="true"><g filter="url(#texture-${preset.texture})"><rect x="0" y="0" width="108" height="30" fill="none" />${stroke}</g></svg>`;
}

function renderBrushes(): void {
  const a = api;
  const list = brushesEl;
  if (!a || !list) return;
  list.innerHTML = "";
  if (store.presets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "br-empty";
    empty.textContent = "No brushes";
    list.appendChild(empty);
    return;
  }
  store.presets.forEach((preset, index) => {
    const row = document.createElement("div");
    // Active is the brush the pen draws with.
    row.className = "br-brush" + (activeBrushId === preset.id ? " br-active" : "");
    const preview = document.createElement("div");
    preview.className = "br-preview";
    preview.innerHTML = previewSvg(preset);
    row.appendChild(preview);
    const meta = document.createElement("div");
    meta.className = "br-brush-meta";
    row.appendChild(meta);
    const nameEl = document.createElement("span");
    nameEl.className = "br-brush-name";
    nameEl.textContent = preset.name;
    nameEl.title = `${preset.name} — ${textureLabel(preset.texture)}, size ${preset.size}`;
    const activate = (): void => {
      const wasOpen = expandedId === preset.id;
      selectedId = preset.id;
      activeBrushId = preset.id;
      applyBrush(a, preset);
      if (wasOpen) closeExpansion();
      else openExpansion(preset);
      renderBrushes();
    };
    // The whole row is the click target: name, preview
    // or the space between them all select the brush.
    row.addEventListener("click", activate);
    meta.appendChild(nameEl);
    const del = svgButton("Delete brush", "Delete brush", TRASH_SVG);
    del.addEventListener("click", (e) => {
      // The delete sits inside the row: keep its click
      // from selecting the brush it deletes.
      e.stopPropagation();
      rememberLibrary();
      commitStore(deleteBrushAt(index));
      focusList();
    });
    meta.append(del);
    list.appendChild(row);
    if (expandedId === preset.id) {
      renderExpansion(list, index);
    }
  });
}

// After a committed change destroys the button that had
// focus, put focus back in the list: without it, focus
// lands on the body and the next Ctrl+Z never reaches
// the panel's handler, so the change could not be undone.
function focusList(): void {
  brushesEl?.focus({ preventScroll: true });
}

function sliderRow(label: string, min: number, max: number, step: number, value: number, format: (v: number) => string, onInput: (v: number) => void): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "br-slider-row";
  const lab = document.createElement("label");
  lab.className = "br-label";
  lab.textContent = label;
  row.appendChild(lab);
  const input = document.createElement("input");
  input.type = "range";
  input.className = "br-slider";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("aria-label", label);
  const val = document.createElement("span");
  val.className = "br-value";
  val.textContent = format(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    val.textContent = format(v);
    onInput(v);
  });
  row.append(input, val);
  return row;
}

// The pressure graph: input pressure left to right,
// output width bottom to top. Drag a point to move it;
// click the empty graph to add a point there; press a
// middle point twice quickly, or select it and press
// Delete, to remove it. The first and last points stay
// at pressure 0 and 1, moving only in height. Dragged
// live, committed on release, so a drag never rebuilds
// the editor under the pointer. The commit goes to the
// caller — the draft here — never straight to the store.
function renderCurveGraph(host: HTMLElement, initialCurve: CurvePoint[], onCommit: (curve: CurvePoint[]) => void): void {
  const W = 200, H = 120, PAD = 8;
  const px = (x: number): number => PAD + x * (W - PAD * 2);
  const py = (y: number): number => H - PAD - y * (H - PAD * 2);
  let points: CurvePoint[] = copyCurve(initialCurve);
  let selected = -1;
  // The last press on a point: a second press on the
  // same point, quickly, deletes it. The dblclick event
  // cannot do this job — pointer capture retargets it to
  // the svg, so its target is never the point.
  let lastTap: { index: number; time: number } | null = null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "br-graph");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Pressure curve graph");
  svg.setAttribute("tabindex", "0");
  const grid = [0.25, 0.5, 0.75].map((v) =>
    `<line x1="${px(v)}" y1="${py(0)}" x2="${px(v)}" y2="${py(1)}" /><line x1="${px(0)}" y1="${py(v)}" x2="${px(1)}" y2="${py(v)}" />`,
  ).join("");
  svg.innerHTML = `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" class="br-graph-frame" />`
    + `<g class="br-graph-grid">${grid}</g>`
    + `<path class="br-graph-line" d="" />`
    + `<g class="br-graph-handles"></g>`
    + `<g class="br-graph-dots"></g>`
    + `<g class="br-graph-del"></g>`;
  const line = svg.querySelector(".br-graph-line") as SVGPathElement;
  const handles = svg.querySelector(".br-graph-handles") as SVGGElement;
  const dots = svg.querySelector(".br-graph-dots") as SVGGElement;
  const del = svg.querySelector(".br-graph-del") as SVGGElement;
  const draw = (): void => {
    // Cubic where a handle bends the segment, straight
    // where none does — the same rule as applyCurve.
    let d = `M ${px(points[0].x).toFixed(1)} ${py(points[0].y).toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (!a.out && !b.in) {
        d += ` L ${px(b.x).toFixed(1)} ${py(b.y).toFixed(1)}`;
      } else {
        const [c1, c2] = curveSegmentControls(a, b);
        d += ` C ${px(c1.x).toFixed(1)} ${py(c1.y).toFixed(1)}, ${px(c2.x).toFixed(1)} ${py(c2.y).toFixed(1)}, ${px(b.x).toFixed(1)} ${py(b.y).toFixed(1)}`;
      }
    }
    line.setAttribute("d", d);
    dots.innerHTML = points.map((p, i) =>
      `<circle class="br-graph-dot${i === selected ? " br-graph-dot-selected" : ""}" data-point="${i}" cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="6" />`,
    ).join("");
    // The selected point's handles: a line from the point
    // to each handle, and a small circle to grab. A handle
    // with nothing stored sits at its default — a third
    // along the chord — so it is there to grab from the
    // first click. Endpoints have one handle only.
    if (selected < 0) {
      handles.innerHTML = "";
    } else {
      const p = points[selected];
      const parts: string[] = [];
      const prev = points[selected - 1], next = points[selected + 1];
      if (prev) {
        const c = curveSegmentControls(prev, p)[1];
        parts.push(`<line class="br-graph-handle-line" x1="${px(p.x).toFixed(1)}" y1="${py(p.y).toFixed(1)}" x2="${px(c.x).toFixed(1)}" y2="${py(c.y).toFixed(1)}" />`
          + `<circle class="br-graph-handle" data-handle="in" data-point="${selected}" cx="${px(c.x).toFixed(1)}" cy="${py(c.y).toFixed(1)}" r="4.5" />`);
      }
      if (next) {
        const c = curveSegmentControls(p, next)[0];
        parts.push(`<line class="br-graph-handle-line" x1="${px(p.x).toFixed(1)}" y1="${py(p.y).toFixed(1)}" x2="${px(c.x).toFixed(1)}" y2="${py(c.y).toFixed(1)}" />`
          + `<circle class="br-graph-handle" data-handle="out" data-point="${selected}" cx="${px(c.x).toFixed(1)}" cy="${py(c.y).toFixed(1)}" r="4.5" />`);
      }
      handles.innerHTML = parts.join("");
    }
    // The selected middle point's delete badge: a small
    // cross above it, so deletion is visible, not guessed.
    if (selected <= 0 || selected >= points.length - 1) {
      del.innerHTML = "";
      del.removeAttribute("data-del");
      return;
    }
    const p = points[selected];
    const cx = Math.min(px(p.x) + 14, W - 10);
    const cy = Math.max(py(p.y) - 14, 10);
    del.setAttribute("data-del", String(selected));
    del.innerHTML = `<circle cx="${cx}" cy="${cy}" r="8" class="br-graph-del-bg" /><path d="M${cx - 3.5} ${cy - 3.5} L${cx + 3.5} ${cy + 3.5} M${cx + 3.5} ${cy - 3.5} L${cx - 3.5} ${cy + 3.5}" class="br-graph-del-x" />`;
  };
  const toGraph = (e: PointerEvent): { x: number; y: number } => {
    const r = svg.getBoundingClientRect();
    const gx = ((e.clientX - r.left) / r.width) * W;
    const gy = ((e.clientY - r.top) / r.height) * H;
    return {
      x: Math.min(1, Math.max(0, (gx - PAD) / (W - PAD * 2))),
      y: Math.min(1, Math.max(0, (H - PAD - gy) / (H - PAD * 2))),
    };
  };
  const commit = (): void => {
    onCommit(copyCurve(points));
  };
  const deletePoint = (i: number): void => {
    if (points.length <= 2 || i <= 0 || i >= points.length - 1) return;
    points.splice(i, 1);
    if (selected === i) selected = -1;
    else if (selected > i) selected -= 1;
    lastTap = null;
    draw();
    commit();
  };
  const startDrag = (dragIndex: number, e: PointerEvent): void => {
    svg.setPointerCapture(e.pointerId);
    const start = toGraph(e);
    const onMove = (me: PointerEvent): void => {
      const q = toGraph(me);
      const prev = points[dragIndex - 1], next = points[dragIndex + 1];
      let x = q.x;
      if (dragIndex === 0) x = 0;
      else if (dragIndex === points.length - 1) x = 1;
      else x = Math.min(next.x - 0.02, Math.max(prev.x + 0.02, q.x));
      points[dragIndex] = { x, y: Math.min(1, Math.max(0, q.y)) };
      draw();
    };
    const onUp = (me: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      // A press without a drag selects the point, so the
      // badge and the Delete key have something to work on.
      const end = toGraph(me);
      if (Math.hypot(end.x - start.x, end.y - start.y) < 0.03) selected = dragIndex;
      draw();
      commit();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  // Dragging a handle reshapes the curve on that side
  // only: the other handle stays where it was. The
  // control point stays in the graph, and on its side of
  // the anchor, or the segment would loop in pressure.
  // Dragged live, committed on release, like a point.
  const startHandleDrag = (handleIndex: number, side: "in" | "out", e: PointerEvent): void => {
    svg.setPointerCapture(e.pointerId);
    const onMove = (me: PointerEvent): void => {
      const q = toGraph(me);
      const p = points[handleIndex];
      const prev = points[handleIndex - 1], next = points[handleIndex + 1];
      let cx = Math.min(1, Math.max(0, q.x));
      const cy = Math.min(1, Math.max(0, q.y));
      if (side === "out") cx = Math.min(next ? next.x : 1, Math.max(p.x, cx));
      else cx = Math.min(p.x, Math.max(prev ? prev.x : 0, cx));
      points[handleIndex] = { ...p, [side]: { dx: cx - p.x, dy: cy - p.y } };
      draw();
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      draw();
      commit();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  draw();
  svg.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // Clicking the graph focuses it, or the Delete key
    // below would go to the board instead. preventDefault
    // above blocks the default focus, so focus it here.
    svg.focus({ preventScroll: true });
    const delTarget = (e.target as Element).closest?.("[data-del]");
    if (delTarget) {
      deletePoint(Number(delTarget.getAttribute("data-del")));
      return;
    }
    const handleTarget = (e.target as Element).closest?.("[data-handle]");
    if (handleTarget) {
      const i = Number(handleTarget.getAttribute("data-point"));
      const side = handleTarget.getAttribute("data-handle") as "in" | "out";
      lastTap = null;
      startHandleDrag(i, side, e);
      return;
    }
    const target = (e.target as Element).closest?.("[data-point]");
    if (target) {
      const i = Number(target.getAttribute("data-point"));
      const now = Date.now();
      if (lastTap && lastTap.index === i && now - lastTap.time < 400) {
        deletePoint(i);
        return;
      }
      lastTap = { index: i, time: now };
      startDrag(i, e);
      return;
    }
    lastTap = null;
    // Clicked empty graph: add a point there, then drag it.
    const at = toGraph(e);
    let atIndex = points.findIndex((q) => q.x > at.x);
    if (atIndex < 0) atIndex = points.length;
    points.splice(atIndex, 0, at);
    selected = atIndex;
    draw();
    startDrag(atIndex, e);
  });
  svg.addEventListener("keydown", (e) => {
    if ((e.key !== "Delete" && e.key !== "Backspace") || selected < 0) return;
    // The core Delete deletes the board selection: stop
    // the key here, or the selected card goes with the point.
    e.stopPropagation();
    e.preventDefault();
    deletePoint(selected);
  });
  host.appendChild(svg);
}

// The parameters below a brush: a draft of a new brush
// from it. The name, the texture's parameters, the
// pressure curve, and a live preview of the draft
// texture — one stroke at the size the brush draws, so
// the preview shows what the brush draws, not a
// generic thick stroke. Save creates the new brush (and
// a new texture when the parameters moved) and selects
// it; Cancel drops the draft; Delete removes the brush
// itself. The original brush is untouched until Save.
function renderExpansion(list: HTMLElement, index: number): void {
  const a = api;
  if (!a) return;
  const box = document.createElement("div");
  box.className = "br-expand";
  const nameInput = document.createElement("input");
  nameInput.className = "br-expand-name";
  nameInput.setAttribute("aria-label", "Brush name");
  nameInput.placeholder = "Name";
  nameInput.value = draftName;
  // What the name was when the input was focused: the
  // undo handler lets the first Ctrl+Z undo typed text,
  // and only the next one reach the board or the library.
  nameInput.dataset.valueAtFocus = draftName;
  nameInput.addEventListener("focus", () => {
    nameInput.dataset.valueAtFocus = nameInput.value;
  });
  nameInput.addEventListener("input", () => {
    draftName = nameInput.value;
  });
  box.appendChild(nameInput);
  const previewHost = document.createElement("div");
  previewHost.className = "br-tex-preview";
  const drawPreview = (): void => {
    // One stroke only, straight like the rows: the same
    // shared sample path, so the preview shows texture.
    const source = getPresetById(draftSourceId ?? "");
    // The preview shows what Save would produce: the source
    // brush's own look while the parameters still sit on
    // their basis, the draft texture once they moved.
    if (source && !draftNeedsNewTexture()) {
      const opacity = source.family === "highlighter" ? ` opacity="0.65"` : "";
      const stroke = `<path d="M8 28 L 232 28" fill="none" stroke="#1A1A1A" stroke-width="${source.size}" stroke-linecap="round"${opacity} />`;
      const inner = source.texture
        ? `<g filter="url(#texture-${source.texture})"><rect x="0" y="0" width="240" height="56" fill="none" />${stroke}</g>`
        : stroke;
      previewHost.innerHTML = `<svg viewBox="0 0 240 56" aria-hidden="true">${inner}</svg>`;
      return;
    }
    // The filter region is in user units over the whole
    // preview, so displaced grain is never clipped at the
    // edges. The draft keeps the source brush's size: the
    // saved brush draws at that size, so the preview does.
    previewHost.innerHTML = `<svg viewBox="0 0 240 56" aria-hidden="true"><defs><filter id="br-draft-preview" filterUnits="userSpaceOnUse" x="0" y="0" width="240" height="56">${textureFilterSvg(draftParams)}</filter></defs><path d="M8 28 L 232 28" fill="none" stroke="#1A1A1A" stroke-width="${source?.size ?? 7}" stroke-linecap="round" filter="url(#br-draft-preview)" /></svg>`;
  };
  drawPreview();
  box.appendChild(previewHost);
  const params = document.createElement("div");
  params.className = "br-expand-params";
  params.append(
    sliderRow("Frequency", 0.05, 1, 0.05, draftParams.baseFrequency, (v) => v.toFixed(2), (v) => { draftParams.baseFrequency = v; draftTouchedParams = true; drawPreview(); }),
    sliderRow("Octaves", 1, 5, 1, draftParams.octaves, (v) => String(v), (v) => { draftParams.octaves = v; draftTouchedParams = true; drawPreview(); }),
    sliderRow("Scale", 0, 10, 0.5, draftParams.scale, (v) => v.toFixed(1), (v) => { draftParams.scale = v; draftTouchedParams = true; drawPreview(); }),
    sliderRow("Seed", 0, 100, 1, draftParams.seed, (v) => String(v), (v) => { draftParams.seed = v; draftTouchedParams = true; drawPreview(); }),
  );
  box.appendChild(params);
  const curveHead = document.createElement("div");
  curveHead.className = "br-graph-head";
  const curveLab = document.createElement("div");
  curveLab.className = "br-label";
  curveLab.textContent = "Pressure";
  curveHead.appendChild(curveLab);
  box.appendChild(curveHead);
  const graphHost = document.createElement("div");
  graphHost.className = "br-graph-wrap";
  renderCurveGraph(graphHost, draftCurve, (curve) => {
    draftCurve = curve;
  });
  box.appendChild(graphHost);
  const actions = document.createElement("div");
  actions.className = "br-expand-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "br-btn";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    if (!api) return;
    const source = getPresetById(draftSourceId ?? "");
    if (!source) return;
    rememberLibrary();
    // The texture takes the brush's name: the texture
    // list is never shown on its own, so a second name
    // would only be a field to fill in. An untouched
    // name is the source's, so it auto-names instead of
    // making a second brush with the same name.
    const name = draftName.trim() && draftName.trim() !== source.name
      ? draftName.trim()
      : nextPresetName(store);
    const needsNewTexture = draftNeedsNewTexture();
    let next = store;
    let textureId = source.texture;
    if (needsNewTexture) {
      const tex = createTexture(next, { name, ...draftParams });
      const def = tex.store.textures[tex.index];
      api.brushes.registerTexture({ id: def.id, label: def.name, filterSvg: textureFilterSvg(def) });
      next = tex.store;
      textureId = def.id;
    }
    // The family follows the brush this was made from;
    // the size stays the source's, since size lives in
    // the toolbar.
    const created = createPreset(next, {
      name,
      texture: textureId,
      size: source.size,
      curve: draftCurve,
      family: source.family,
    });
    const made = created.store.presets[created.index];
    selectedId = made.id;
    activeBrushId = made.id;
    // Close the expansion before committing: commitStore
    // re-renders, and the expansion must be gone by then.
    closeExpansion();
    commitStore(created.store);
    if (api) activateBrush(api, made);
    focusList();
  });
  actions.appendChild(saveBtn);
  const row = document.createElement("div");
  row.className = "br-expand-actions-row";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "br-btn-quiet";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    closeExpansion();
    renderBrushes();
  });
  row.appendChild(cancelBtn);
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "br-btn-quiet";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => {
    rememberLibrary();
    commitStore(deleteBrushAt(index));
    focusList();
  });
  row.appendChild(deleteBtn);
  actions.appendChild(row);
  box.appendChild(actions);
  list.appendChild(box);
}

export function renderPanel(container: HTMLElement): void {
  const a = api;
  if (!a) return;
  container.innerHTML = "";
  brushesEl = document.createElement("div");
  brushesEl.className = "br-brushes";
  // Focusable, but not in the tab order: after a Save or
  // Delete destroys the button that had focus, focus
  // moves here so the next Ctrl+Z reaches the panel.
  brushesEl.tabIndex = -1;
  container.appendChild(brushesEl);
  syncDefaults();
  renderBrushes();
}
