// Boards — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Multi-board is a plugin, not core UI, by design: the core
// owns one board at a time (its file, its assets, its undo),
// and this plugin is only the list and the switching. The
// core's api.boards does the actual switch — it saves the
// current board, loads the new one, and swaps in that
// board's own undo stack, search and context index, which
// are all per-board — so a plugin cannot strand the core
// in a half-switched state, and creating a board never
// wipes another board's undo.
//
// Layout (see electron/main.ts): Main is the default board
// at the base folder's board.json; every other board is a
// folder under boards/, with its own board.json, assets and
// backups. Deleting a board deletes its folder, so it also
// deletes its backups — the panel asks for confirmation
// first, and Main cannot be deleted or renamed, because
// there must always be a board to fall back to.
//
// The plugin is three files, like Hide: list.ts owns the
// board list (rows, delete, rename), panel.ts the panel
// DOM and the new-board form, main.ts the entry point that
// wires them together.
import type { PluginContext } from "../../src/plugins";
import { clearPanel, refreshPanel, renderPanel } from "./panel.js";

let apiRef: PluginContext | null = null;
let onBoardHandler: (() => void) | null = null;

export function activate(api: PluginContext): void {
  apiRef = api;
  onBoardHandler = () => refreshPanel(api);
  api.events.on("board", onBoardHandler);
  api.ui.registerPanel({
    id: "boards",
    title: "Boards",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" opacity="0.45" /></svg>',
    render: (container) => renderPanel(api, container),
  });
}

export function deactivate(): void {
  if (apiRef && onBoardHandler) apiRef.events.off("board", onBoardHandler);
  onBoardHandler = null;
  clearPanel();
  apiRef = null;
}
