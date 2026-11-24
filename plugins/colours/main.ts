// Colour Library — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Named colour palettes, harmonies of the picked colour,
// and recent colours, saved in plugin storage. Click a
// colour to apply it — to the selected strokes and swatches,
// or to the pen when nothing colourable is selected. Drag
// a colour onto the board to place a swatch. Palettes live
// in storage, so disabling the plugin loses nothing: the
// board keeps its colours, the pen keeps its colour.
//
// The plugin is six files, like a first-party plugin:
// color.ts owns the hex maths and the harmonies, store.ts
// the palettes, the recents and their persistence shapes,
// apply.ts applying a colour, place.ts placing swatches
// on the board, panel.ts the library panel. main.ts is
// the entry point that wires them together.
import type { PluginContext } from "bowerbird-plugin-api";
import { clearPanel, initPanel, parsePickerMode, renderPanel } from "./panel.js";
import { emptyStore, parseRecent, parseStored } from "./store.js";

let apiRef: PluginContext | null = null;

export async function activate(api: PluginContext): Promise<void> {
  apiRef = api;
  // First run seeds one palette from the pen colour; a
  // stored empty list stays empty, so palettes a user
  // deleted are never resurrected by a restart.
  let store = emptyStore();
  let seeded = false;
  let pickerMode = parsePickerMode(undefined);
  let recent: string[] = [];
  try {
    if (apiRef.storage) {
      const saved = await apiRef.storage.get("palettes");
      if (saved === undefined || saved === null) {
        seeded = true;
      } else {
        store = parseStored(saved) ?? emptyStore();
      }
      pickerMode = parsePickerMode(await apiRef.storage.get("pickerMode"));
      // Recents live under their own key, so a bad value
      // here never touches the palettes above.
      recent = parseRecent(await apiRef.storage.get("recent")) ?? [];
    }
  } catch { /* a failed load seeds fresh below */ }
  if (seeded && apiRef.pen) {
    const pen = apiRef.pen.getColor();
    if (/^#[0-9a-fA-F]{6}$/.test(pen)) {
      store = { palettes: [{ name: "Palette 1", colors: [pen.toUpperCase()] }] };
    }
  }
  initPanel(apiRef, store, pickerMode, recent);
  apiRef.ui.registerPanel({
    id: "colours",
    title: "Colour Library",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12 22 12A10 10 0 0 1 17 20.7Z" fill="#FF3B30"/><path d="M12 12 17 20.7A10 10 0 0 1 7 20.7Z" fill="#FFCC00"/><path d="M12 12 7 20.7A10 10 0 0 1 2 12Z" fill="#34C759"/><path d="M12 12 2 12A10 10 0 0 1 7 3.3Z" fill="#64D2FF"/><path d="M12 12 7 3.3A10 10 0 0 1 17 3.3Z" fill="#007AFF"/><path d="M12 12 17 3.3A10 10 0 0 1 22 12Z" fill="#AF52DE"/><circle cx="12" cy="12" r="3" fill="#fff"/></svg>',
    render: (container) => renderPanel(container),
  });
}

export function deactivate(): void {
  clearPanel();
  apiRef = null;
}
