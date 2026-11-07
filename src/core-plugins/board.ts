// The board view is a first-party plugin (core-board):
// it builds the board DOM — the canvas, grid, SVG layer,
// cards layer, plugin view, overlays, view switcher,
// resize/rotate handles and toast — and hands those
// elements to the plugin system through the shell, so the
// core never owns board DOM. It uses only the public API.
//
// The board DOM is the mount point the core-board plugin
// provides. The render loop and the input loop (pan, zoom,
// drag, resize/rotate, text edit) still live in the core
// (src/main.ts), which owns the board model, the undo store
// and the search engine; moving them into this plugin is
// the remaining deep work (see ARCHITECTURE.md). The DOM
// itself is plugin-built now, so index.html is a bare
// mount point and the app boots with an empty mount when
// no UI plugin is enabled.
import type { PluginContext, PluginManifest } from "../plugins";

export const manifest: PluginManifest = {
  id: "core-board",
  name: "Board",
  description: "The board view: canvas, grid, cards layer, handles and toast.",
  version: "1.0.0",
  apiVersion: "2",
  main: "board.js",
  permissions: ["board:read"],
};

let boardEl: HTMLElement | null = null;

export function activate(api: PluginContext): void {
  boardEl = document.createElement("div");
  boardEl.id = "board";
  boardEl.innerHTML = `
    <div id="grid"></div>
    <svg id="canvas-svg"><g id="world"></g></svg>
    <div id="cards"></div>
    <div id="plugin-view" style="display:none"></div>
    <div id="plugin-overlays"></div>
    <div id="view-switcher" style="display:none"></div>
    <div id="resize-handle" aria-hidden="true"></div>
    <div id="rotate-handle" aria-hidden="true"></div>
    <div id="toast"></div>`;
  // The board sits inside the main column, below the title
  // bar (which the core-titlebar plugin inserts before it).
  // Append it to the main column element.
  const mainColumn = document.getElementById("main-column");
  if (mainColumn) mainColumn.appendChild(boardEl);
  else document.body.appendChild(boardEl);

  // Hand the plugin system the board DOM elements, so the
  // core reads them back through the shell instead of
  // querying them by id.
  const grid = boardEl.querySelector<HTMLElement>("#grid");
  const canvasSvg = boardEl.querySelector<HTMLElement>("#canvas-svg");
  const cards = boardEl.querySelector<HTMLElement>("#cards");
  const resizeHandle = boardEl.querySelector<HTMLElement>("#resize-handle");
  const rotateHandle = boardEl.querySelector<HTMLElement>("#rotate-handle");
  const pluginView = boardEl.querySelector<HTMLElement>("#plugin-view");
  const overlays = boardEl.querySelector<HTMLElement>("#plugin-overlays");
  const viewSwitcher = boardEl.querySelector<HTMLElement>("#view-switcher");
  const toast = boardEl.querySelector<HTMLElement>("#toast");
  if (grid && canvasSvg && cards && resizeHandle && rotateHandle && pluginView && overlays && viewSwitcher && toast) {
    api.ui.setBoardElements({
      board: boardEl,
      canvas: [grid, canvasSvg, cards, resizeHandle, rotateHandle],
      pluginView,
      overlays,
      viewSwitcher,
      toast,
    });
  }
}

export function deactivate(): void {
  boardEl?.remove();
  boardEl = null;
}
