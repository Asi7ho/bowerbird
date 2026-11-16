// The board view is a first-party plugin (core-board):
// it builds the board DOM — the canvas, grid, SVG layer,
// cards layer, plugin view, overlays, view switcher,
// resize/rotate handles and toast — and it owns the render
// loop and the input loop (pan, zoom, drag, resize/rotate,
// text edit). It uses only the public API, plus the pure
// board-model functions in src/backend/model.ts (geometry over the
// board data it reads through the API). The core never owns
// board DOM and renders nothing itself.
//
// The board plugin keeps no live board reference: the core
// owns the board, and the plugin reads it through
// api.board.get() (a copy, for rendering) and mutates it
// through the API's live-drag methods (which change the
// live board without saving, so a drag saves once at drag
// end). The camera, tool, pen colour and selection are
// core state, read and written through api.view, api.ui,
// api.pen and api.board. Text editing state (editingId)
// lives here, because the board view owns text editing;
// the core clears it through the board controller below
// (undo, board switch, reset).
//
// The 3D viewer (src/backend/model3d.ts) is a renderer-side
// helper like the model geometry above: one shared WebGL
// renderer draws every visible model into its card's screen
// rect, and the board syncs viewers after each render.
import type { PluginContext, PluginManifest } from "../plugins/host";
import { S } from "./board-state";
import { render, updateSelection } from "./board-render";
import {
  attachBoardListeners, attachWindowListeners, commitEditingIfAny, deleteSelected, groupSelected, setTool, ungroupSelected,
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
    <div id="plugin-view" style="display:none"></div>
    <div id="plugin-overlays"></div>
    <div id="view-switcher" class="frosted" style="display:none"></div>
    <div id="resize-handle" aria-hidden="true"></div>
    <div id="rotate-handle" aria-hidden="true"></div>
    <div id="sr-announcer" class="sr-only" aria-live="polite"></div>
    <div id="toast" class="toast"></div>`;
  // The board sits inside the main column, below the title
  // bar (which the core-titlebar plugin inserts before it).
  // Append it to the main column element.
  const mainColumn = document.getElementById("main-column");
  if (mainColumn) mainColumn.appendChild(S.boardEl);
  else document.body.appendChild(S.boardEl);

  const grid = S.boardEl.querySelector<HTMLElement>("#grid");
  const canvasSvg = S.boardEl.querySelector<HTMLElement>("#canvas-svg");
  const groupFrames = S.boardEl.querySelector<HTMLElement>("#group-frames");
  const cards = S.boardEl.querySelector<HTMLElement>("#cards");
  const groups = S.boardEl.querySelector<HTMLElement>("#groups");
  const resizeHandle = S.boardEl.querySelector<HTMLElement>("#resize-handle");
  const rotateHandle = S.boardEl.querySelector<HTMLElement>("#rotate-handle");
  const pluginView = S.boardEl.querySelector<HTMLElement>("#plugin-view");
  const overlays = S.boardEl.querySelector<HTMLElement>("#plugin-overlays");
  const viewSwitcher = S.boardEl.querySelector<HTMLElement>("#view-switcher");
  const toast = S.boardEl.querySelector<HTMLElement>("#toast");
  if (grid && canvasSvg && groupFrames && cards && groups && resizeHandle && rotateHandle && pluginView && overlays && viewSwitcher && toast) {
    S.gridEl = grid as HTMLDivElement;
    // The SVG world group, inside the canvas SVG.
    const w = canvasSvg.querySelector("#world") as unknown as SVGGElement | null;
    if (w) S.worldEl = w;
    S.groupFramesEl = groupFrames as HTMLDivElement;
    S.cardsEl = cards as HTMLDivElement;
    S.groupsEl = groups as HTMLDivElement;
    // Hand the plugin system the board DOM elements, so the
    // core reads them back through the shell instead of
    // querying them by id.
    S.api.ui.setBoardElements({
      board: S.boardEl,
      canvas: [grid, canvasSvg, cards, resizeHandle, rotateHandle],
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
    groupSelected,
    ungroupSelected,
    deleteSelected,
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
