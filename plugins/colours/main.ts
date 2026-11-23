// Colour Library — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Named colour palettes, saved in plugin storage. Click a
// colour to apply it — to the selected strokes and swatches,
// or to the pen when nothing colourable is selected. Drag
// a colour onto the board to place a swatch. Palettes live
// in storage, so disabling the plugin loses nothing: the
// board keeps its colours, the pen keeps its colour.
//
// The plugin is six files, like a first-party plugin:
// color.ts owns the hex maths, store.ts the palettes and
// their persistence shape, apply.ts applying a colour,
// place.ts placing swatches on the board, panel.ts the
// library panel. main.ts is the entry point that wires
// them together.
import type { PluginContext } from "bowerbird-plugin-api";
import { clearPanel, initPanel, renderPanel } from "./panel.js";
import { emptyStore, parseStored } from "./store.js";

let apiRef: PluginContext | null = null;

export async function activate(api: PluginContext): Promise<void> {
  apiRef = api;
  // First run seeds one palette from the pen colour; a
  // stored empty list stays empty, so palettes a user
  // deleted are never resurrected by a restart.
  let store = emptyStore();
  let seeded = false;
  try {
    if (apiRef.storage) {
      const saved = await apiRef.storage.get("palettes");
      if (saved === undefined || saved === null) {
        seeded = true;
      } else {
        store = parseStored(saved) ?? emptyStore();
      }
    }
  } catch { /* a failed load seeds fresh below */ }
  if (seeded && apiRef.pen) {
    const pen = apiRef.pen.getColor();
    if (/^#[0-9a-fA-F]{6}$/.test(pen)) {
      store = { palettes: [{ name: "Palette 1", colors: [pen.toUpperCase()] }] };
    }
  }
  initPanel(apiRef, store);
  apiRef.ui.registerPanel({
    id: "colours",
    title: "Colour Library",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2" fill="#FF3B30"/><rect x="13" y="3" width="8" height="8" rx="2" fill="#FFCC00"/><rect x="3" y="13" width="8" height="8" rx="2" fill="#34C759"/><rect x="13" y="13" width="8" height="8" rx="2" fill="#007AFF"/></svg>',
    render: (container) => renderPanel(container),
  });
}

export function deactivate(): void {
  clearPanel();
  apiRef = null;
}
