// Brush Library — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Brush presets with texture and pressure curve.
// Click a brush to apply it to the selected strokes, or
// to draw with it when nothing is selected: the brush
// configures the matching core tool through the pen's
// stroke defaults, so it adds no toolbar tool of its own.
// Presets and user textures live in storage, so disabling
// the plugin loses nothing: the board keeps its strokes,
// and a stroke whose texture is gone renders plain.
//
// The plugin is seven files, like a first-party plugin:
// textures.ts owns the built-in textures and their filter
// SVG, curve.ts the pressure curve, store.ts the presets
// and their persistence shape, apply.ts applying a brush,
// panel.ts the library panel, settings.ts the Settings
// section. main.ts is the entry point that wires them
// together.
import type { PluginContext } from "bowerbird-plugin-api";
import { clearPanel, initPanel, renderPanel, syncDefaults } from "./panel.js";
import { renderSettings } from "./settings.js";
import { parseStored, seededStore } from "./store.js";
import { BUILTIN_TEXTURES, textureFilterSvg } from "./textures.js";

// The panel's icon: a brush, in the toolbar's style.
// Self-contained (explicit stroke, no fill): the tab
// only sizes the SVG, it adds no stroke of its own.
const BRUSH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" /></svg>';

let apiRef: PluginContext | null = null;

export async function activate(api: PluginContext): Promise<void> {
  apiRef = api;
  let store = seededStore();
  try {
    if (apiRef.storage) {
      const saved = await apiRef.storage.get("brushes");
      if (saved !== undefined && saved !== null) store = parseStored(saved) ?? seededStore();
    }
  } catch { /* a failed load seeds fresh below */ }
  // Textures first: the panel renders strokes through them.
  for (const t of BUILTIN_TEXTURES) {
    apiRef.brushes.registerTexture({ id: t.id, label: t.label, filterSvg: t.filterSvg });
  }
  for (const t of store.textures) {
    apiRef.brushes.registerTexture({ id: t.id, label: t.name, filterSvg: textureFilterSvg(t) });
  }
  initPanel(apiRef, store);
  // The pen draws with the active brush from the start,
  // so the first stroke is textured before the panel is
  // ever opened.
  syncDefaults();
  apiRef.ui.registerPanel({
    id: "brushes",
    title: "Brush Library",
    icon: BRUSH_ICON,
    render: (container) => renderPanel(container),
  });
  apiRef.ui.registerSettingsSection({
    id: "brushes-reset",
    title: "Brush Library",
    render: (container) => renderSettings(api, container),
  });
}

export function deactivate(): void {
  if (apiRef?.pen) {
    // Disabling restores the plain pen: the defaults
    // this plugin set go back to built-ins.
    apiRef.pen.clearStrokeDefaults("pen");
  }
  clearPanel();
  apiRef = null;
}
