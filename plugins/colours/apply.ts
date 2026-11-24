// Colour Library — applying a colour. Clicking a colour
// recolours the selected strokes and swatches, in one undo
// step; with nothing colourable selected it sets the pen
// for the next stroke instead. The picked state is a
// colour and an opacity: a stroke takes both, a swatch
// takes the colour only, and the pen takes both. A locked
// layer refuses the recolour: the core returns false and
// the panel says so.
import type { Item, PluginContext } from "bowerbird-plugin-api";

export function applyColour(api: PluginContext, hex: string, opacity?: number): void {
  const items = api.board.getItems();
  const targets = api.board.getSelected()
    .map((id) => items.find((i) => i.id === id))
    .filter((it): it is Item => it !== undefined && ("Stroke" in it.kind || "Swatch" in it.kind));
  if (targets.length === 0) {
    api.pen.setColor(hex);
    if (opacity !== undefined) api.pen.setOpacity(opacity);
    return;
  }
  const ok = api.board.updateItems(targets.map((it) => ({
    id: it.id,
    data: "Stroke" in it.kind ? { color: hex, ...(opacity !== undefined ? { opacity } : {}) } : { hex },
  })));
  if (!ok) api.ui.toast("Layer is locked");
}
