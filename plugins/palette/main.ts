// Palette — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// A colour wheel, not a fixed palette list. Pick a colour
// on the wheel and five palettes are made from it, live,
// following colour theory — no fixed palettes, no network.
// The picked colour is saved in plugin storage, so it
// survives restarts and re-enabling: on activate, a fresh
// app (pen still at its default black) restores the saved
// colour and the pen with it; otherwise Palette follows
// the pen, as it always did, so a toolbar pick made while
// Palette was off is not overwritten by an old saved colour.
//
// Picking a colour — on the wheel, on the lightness
// slider, or with the picker icon beside the preview — also sets the
// pen to that colour, through api.pen.setColor, so the
// next pen stroke is the colour you just picked, and the
// toolbar's pen swatches show it (as a custom swatch
// when it is not one of the six fixed colours). Picking
// in the toolbar does the reverse, through the "pen"
// event: Palette follows the pen, so the two colour
// controls are one colour, not two disconnected ones.
//
// The plugin is five files, like a first-party plugin:
// color.ts owns the colour maths and the palettes, state.ts
// the picked colour and its persistence, place.ts placing
// swatches on the board, panel.ts the wheel panel. main.ts
// is the entry point that wires them together.
import type { PluginContext } from "../../src/plugins";
import { hexToHsl } from "./color.js";
import { clearState, initState, isSettingPen, savePicked, setBase } from "./state.js";
import { clearPanel, initPanel, renderPanel, updateAll } from "./panel.js";

let apiRef: PluginContext | null = null;
let penHandler: (() => void) | null = null;

export async function activate(api: PluginContext): Promise<void> {
  apiRef = api;
  // Restore the picked colour, if there is one. A fresh
  // app starts with the pen at its default black, so a
  // saved colour is a restart, not a toolbar pick: restore
  // it into the wheel and the pen. Any other pen colour
  // means the user picked in the toolbar while Palette was
  // off, so Palette follows the pen instead (see below).
  try {
    if (apiRef.storage) {
      const saved = await apiRef.storage.get("picked");
      if (typeof saved === "string" && /^#[0-9a-fA-F]{6}$/.test(saved)) {
        const penNow = apiRef.pen ? apiRef.pen.getColor() : "#1A1A1A";
        if (penNow.toUpperCase() === "#1A1A1A") {
          const hsl = hexToHsl(saved);
          setBase(hsl.h, hsl.s, hsl.l);
          if (apiRef.pen) apiRef.pen.setColor(saved.toUpperCase());
        } else {
          const hsl = hexToHsl(penNow);
          setBase(hsl.h, hsl.s, hsl.l);
        }
      }
    }
  } catch { /* a failed restore leaves the default blue */ }
  initState(apiRef);
  initPanel(apiRef);
  // Follow the pen when it changes elsewhere, in the
  // toolbar: read the new colour, move the wheel and
  // palettes to it, and do not set the pen back, or
  // the two would echo each other forever.
  const handler = (): void => {
    if (isSettingPen()) return;
    if (!apiRef || !apiRef.pen) return;
    const hex = apiRef.pen.getColor();
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    const hsl = hexToHsl(hex);
    setBase(hsl.h, hsl.s, hsl.l);
    updateAll(false);
    savePicked();
  };
  penHandler = handler;
  apiRef.events.on("pen", handler);
  apiRef.ui.registerPanel({
    id: "palette",
    title: "Palette",
    // Colour-wheel dots, hue round the wheel as in the
    // panel itself: red at the top, clockwise through
    // orange, yellow, green, blue and purple.
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4.5" r="2.8" fill="#FF3B30"/><circle cx="18.5" cy="8.25" r="2.8" fill="#FF9500"/><circle cx="18.5" cy="15.75" r="2.8" fill="#FFCC00"/><circle cx="12" cy="19.5" r="2.8" fill="#34C759"/><circle cx="5.5" cy="15.75" r="2.8" fill="#007AFF"/><circle cx="5.5" cy="8.25" r="2.8" fill="#AF52DE"/></svg>',
    render: (container) => renderPanel(container),
  });
}

export function deactivate(): void {
  if (apiRef && penHandler) apiRef.events.off("pen", penHandler);
  penHandler = null;
  clearPanel();
  clearState();
  apiRef = null;
}
