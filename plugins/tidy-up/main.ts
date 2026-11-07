// Tidy Up — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Align and distribute the selected cards. No key object,
// no extra UI: align is to the selection's bounding box
// (its outermost edge, or its centre), distribute keeps
// the first and last cards fixed and spaces the rest
// evenly between them. That is the predictable version —
// the one a user can picture before pressing the button.
//
// The plugin is three files, like Hide: ops.ts owns the
// align and distribute maths, panel.ts the panel DOM and
// the apply step, main.ts the entry point that wires them
// together.
import type { PluginContext } from "../../src/plugins";
import { clearPanel, refresh, renderPanel } from "./panel.js";

let apiRef: PluginContext | null = null;
let onSelectionHandler: (() => void) | null = null;
let onBoardHandler: (() => void) | null = null;

export function activate(api: PluginContext): void {
  apiRef = api;
  onSelectionHandler = () => refresh(api);
  onBoardHandler = () => refresh(api);
  api.events.on("selection", onSelectionHandler);
  api.events.on("board", onBoardHandler);
  api.ui.registerPanel({
    id: "tidy-up",
    title: "Tidy Up",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="7" y="5" width="9" height="4"/><rect x="7" y="11" width="13" height="4"/><rect x="7" y="17" width="6" height="4"/></svg>',
    render: (container) => renderPanel(api, container),
  });
}

export function deactivate(): void {
  if (apiRef && onSelectionHandler) apiRef.events.off("selection", onSelectionHandler);
  if (apiRef && onBoardHandler) apiRef.events.off("board", onBoardHandler);
  onSelectionHandler = null;
  onBoardHandler = null;
  clearPanel();
  apiRef = null;
}
