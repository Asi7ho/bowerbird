// core-board: activation and wiring for the board plugin.
// Builds the board DOM and wires the render loop
// (board-render.ts) and the input loop (board-input.ts).
// Uses only the public API plus pure model functions. The core
// owns the board; the plugin reads it through the API.

import type { PluginContext, PluginManifest } from "../plugins/host";
import { S } from "./board-state";
import { clearLiveStroke, updateLiveStroke, updateShapePreview } from "./board-drag-preview";
import { render, updateSelection } from "./board-render";
import {
  attachBoardListeners, attachWindowListeners, commitEditingIfAny, deleteSelected, getSelectMode, groupSelected, setSelectMode, setTool, ungroupSelected,
} from "./board-input";
import { disposeAllModel3DViewers } from "../backend/model3d";

export const manifest: PluginManifest = {
  id: "core-board",
  name: "Board",
  description: "The board itself: canvas, grid, cards and handles.",
  version: "1.0.0",
  apiVersion: "2",
  main: "board.js",
  permissions: ["board:read", "board:write", "files:read"],
  required: true,
};

// ---------------------------------------------------------------- activation

export function activate(a: PluginContext): void {
  S.api = a;
  S.boardEl = document.createElement("div");
  S.boardEl.id = "board";
  // The board is a region a screen reader can name, and
  // selection changes are announced through a live region:
  // without these, a screen-reader user hears nothing when
  // the selection changes, and the board itself is unlabelled.
  S.boardEl.setAttribute("role", "region");
  S.boardEl.setAttribute("aria-label", "Board");
  S.boardEl.innerHTML = `
    <div id="grid"></div>
    <svg id="canvas-svg"><g id="world"></g></svg>
    <div id="group-frames"></div>
    <div id="groups"></div>
    <div id="cards" role="listbox" aria-label="Board cards"></div>
    <div id="selected-groups"></div>
    <svg id="preview-svg"><g id="preview-world"></g></svg>
    <div id="plugin-view" style="display:none"></div>
    <div id="plugin-overlays"></div>
    <div id="view-switcher" style="display:none"></div>
    <div id="resize-handle" aria-hidden="true"></div>
    <div id="rotate-handle" aria-hidden="true"></div>
    <div id="sr-announcer" class="sr-only" aria-live="polite"></div>
    <div id="toast"></div>`;
  // The board sits inside the main column, below the title
  // bar (which the core-titlebar plugin inserts before it).
  // Append it to the main column element.
  const mainColumn = document.getElementById("main-column");
  if (mainColumn) mainColumn.appendChild(S.boardEl);
  else document.body.appendChild(S.boardEl);

  const grid = S.boardEl.querySelector<HTMLElement>("#grid");
  const canvasSvg = S.boardEl.querySelector<HTMLElement>("#canvas-svg");
  const previewSvg = S.boardEl.querySelector<HTMLElement>("#preview-svg");
  const groupFrames = S.boardEl.querySelector<HTMLElement>("#group-frames");
  const cards = S.boardEl.querySelector<HTMLElement>("#cards");
  const groups = S.boardEl.querySelector<HTMLElement>("#groups");
  const selectedGroups = S.boardEl.querySelector<HTMLElement>("#selected-groups");
  const resizeHandle = S.boardEl.querySelector<HTMLElement>("#resize-handle");
  const rotateHandle = S.boardEl.querySelector<HTMLElement>("#rotate-handle");
  const pluginView = S.boardEl.querySelector<HTMLElement>("#plugin-view");
  const overlays = S.boardEl.querySelector<HTMLElement>("#plugin-overlays");
  const viewSwitcher = S.boardEl.querySelector<HTMLElement>("#view-switcher");
  const toast = S.boardEl.querySelector<HTMLElement>("#toast");
  if (grid && canvasSvg && previewSvg && groupFrames && cards && groups && selectedGroups && resizeHandle && rotateHandle && pluginView && overlays && viewSwitcher && toast) {
    S.gridEl = grid as HTMLDivElement;
    // The SVG world group, inside the canvas SVG.
    const w = canvasSvg.querySelector("#world") as unknown as SVGGElement | null;
    if (w) S.worldEl = w;
    // The draw-preview group, inside the preview SVG above #cards.
    const pw = previewSvg?.querySelector("#preview-world") as unknown as SVGGElement | null;
    if (pw) S.previewWorldEl = pw;
    S.groupFramesEl = groupFrames as HTMLDivElement;
    S.selectedGroupsEl = selectedGroups as HTMLDivElement;
    S.cardsEl = cards as HTMLDivElement;
    S.groupsEl = groups as HTMLDivElement;
    // Hand the plugin system the board DOM elements, so the
    // core reads them back through the shell instead of
    // querying them by id.
    S.api.ui.setBoardElements({
      board: S.boardEl,
      // The preview SVG goes last: it is a canvas layer so a
      // plugin view hides it with the rest of the board (the
      // host shows and hides the canvas list as a group).
      canvas: [grid, canvasSvg, cards, resizeHandle, rotateHandle, previewSvg as HTMLElement],
      pluginView,
      overlays,
      viewSwitcher,
      toast,
    });
  }

  // The board controller: the core delegates its render,
  // selection, editing and tool calls here (see
  // src/plugins/host.ts). Registered now, so the core's host
  // methods and the undo store reach this plugin from the
  // first render after activation.
  S.api.board.registerController({
    render,
    updateSelection,
    commitEditing: commitEditingIfAny,
    clearEditing: () => { S.editingId = null; },
    getEditingId: () => S.editingId,
    setTool,
    getTool: () => S.tool,
    setSelectMode,
    getSelectMode,
    groupSelected,
    ungroupSelected,
    deleteSelected,
    // The live preview stroke for a plugin drag tool: the
    // same path the pen draws through, so a plugin stroke
    // previews exactly like a core one. No points clears it.
    previewStroke: (points, pressures, opts) => {
      if (points.length === 0) { clearLiveStroke(); return; }
      updateLiveStroke(points, pressures, opts?.width ?? 3, opts?.marker ?? false, opts?.pencil ?? false, opts?.color, opts?.opacity ?? 100, opts?.gradient);
    },
    // The live shape preview for a plugin drag tool: the
    // same path the shape tool draws through, so a plugin
    // shape previews exactly like a core one.
    previewShape: (shape, x0, y0, w, h, opts) => {
      updateShapePreview(shape, x0, y0, w, h, opts?.color ?? S.api.pen.getColor(), opts?.outline ?? false);
    },
  });

  // The board's own listeners: the board DOM exists now,
  // and the window listeners attach once, here, so they
  // never run before the board does.
  attachBoardListeners();
  attachWindowListeners();
}

export function deactivate(): void {
  disposeAllModel3DViewers();
  S.boardEl?.remove();
}
