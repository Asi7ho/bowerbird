// Brush Library — applying a brush. Clicking a brush
// retextures the selected strokes, in one
// undo step; with no stroke selected it becomes the
// active brush for the next stroke instead: its settings
// go onto the pen through the pen's stroke defaults, so
// a brush adds no toolbar tool of its own.
// A locked layer refuses the apply: the core returns
// false and the panel says so.
import type { Item, PluginContext } from "bowerbird-plugin-api";
import type { BrushPreset } from "./store.js";

// The pen's next stroke, from the preset: marker is
// the highlighter family, so a wash brush draws translucent
// and a pen or pencil brush does not.
// No width: the size is set in the toolbar, never by
// a brush. applyBrushDefaults passes the pen's current
// width through, since setStrokeDefaults replaces the
// defaults whole and an omitted width would reset it.
export function brushDefaults(preset: BrushPreset) {
  return {
    texture: preset.texture,
    marker: preset.family === "highlighter",
    curve: preset.curve,
  };
}

// A brush's settings onto the pen, without switching
// tools: a panel edit follows the brush already in use.
export function applyBrushDefaults(api: PluginContext, preset: BrushPreset): void {
  const width = api.pen.getStrokeDefaults("pen").width ?? 3;
  api.pen.setStrokeDefaults("pen", { ...brushDefaults(preset), width });
}

// The brush becomes the active brush: its settings go onto
// the pen, and the pen activates.
export function activateBrush(api: PluginContext, preset: BrushPreset): void {
  applyBrushDefaults(api, preset);
  api.ui.setTool("plugin:core-draw:pen");
}

export function applyBrush(api: PluginContext, preset: BrushPreset): void {
  const items = api.board.getItems();
  const targets = api.board.getSelected()
    .map((id) => items.find((i) => i.id === id))
    .filter((it): it is Item => it !== undefined && "Stroke" in it.kind);
  if (targets.length === 0) {
    activateBrush(api, preset);
    return;
  }
  const ok = api.board.updateItems(targets.map((it) => ({
    id: it.id,
    data: { texture: preset.texture },
  })));
  if (!ok) api.ui.toast("Layer is locked");
}
