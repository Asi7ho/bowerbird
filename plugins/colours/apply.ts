// Color Management — applying a colour. Clicking a colour
// recolours the selected strokes and swatches, in one undo
// step; with nothing colourable selected it sets the pen
// for the next stroke instead. The picked state is a
// colour, an opacity and a gradient (null for solid): a
// stroke takes all three, a swatch takes the colour only,
// and the pen takes all three. The colour sent with a
// gradient is the gradient's first stop, so the stroke
// keeps a solid fallback for a gradient-unaware
// renderer. A locked layer refuses the recolour: the core
// returns false and the panel says so.
import type { Item, PluginContext, StrokeGradient } from "bowerbird-plugin-api";

export function applyColour(api: PluginContext, hex: string, opacity?: number, gradient?: StrokeGradient | null): void {
  // The colour sent with a gradient is the gradient's
  // first stop, whatever hex the caller passed: the
  // stroke's colour is the solid fallback, so it must
  // match the gradient, not the tile that was clicked.
  const color = gradient && gradient.stops.length > 0 ? gradient.stops[0].color : hex;
  const items = api.board.getItems();
  const targets = api.board.getSelected()
    .map((id) => items.find((i) => i.id === id))
    .filter((it): it is Item => it !== undefined && ("Stroke" in it.kind || "Swatch" in it.kind));
  if (targets.length === 0) {
    api.pen.setColor(color);
    if (opacity !== undefined) api.pen.setOpacity(opacity);
    if (gradient !== undefined) api.pen.setGradient(gradient);
    return;
  }
  const ok = api.board.updateItems(targets.map((it) => ({
    id: it.id,
    data: "Stroke" in it.kind ? { color, ...(opacity !== undefined ? { opacity } : {}), ...(gradient !== undefined ? { gradient } : {}) } : { hex: color },
  })));
  if (!ok) api.ui.toast("Layer is locked");
}
