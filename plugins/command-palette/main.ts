// Command Palette — bundled Bowerbird plugin (see PLUGIN_API.md).
// One place to run anything: plugin commands, board cards, views,
// tools and the core actions the API can reach. Cmd/Ctrl+K opens
// it, typing filters, Arrow keys move, Enter runs, Esc closes.
//
// Plugin shortcuts in v1 are single keys with no modifiers, so
// Cmd/Ctrl+K cannot be one: this plugin listens for it itself,
// in the capture phase, like Presentation does for its view keys.
// While the palette is open that listener stops propagation, so
// typing in its input never fires a board shortcut (typing "v"
// must not switch to the Select tool behind the palette).
//
// The palette is modal: a click outside its dialog just closes
// it, it does not also act on whatever was clicked. That is the
// window pointerdown listener added on open and removed on close.
//
// The palette is three files, like a first-party plugin:
// entries.ts owns the command registry, ui.ts the modal overlay
// and its keyboard handling. main.ts is the entry point that
// wires them together.
import type { PluginContext } from "../../src/plugins";
import { clearPalette, initOverlay, initPalette, onKeyDown, onPointerDown } from "./ui.js";

export function activate(api: PluginContext): void {
  initPalette(api);
  api.ui.registerOverlay({
    id: "palette",
    render: (container) => initOverlay(container),
  });
  // No command is registered for opening the palette:
  // it opens with Cmd/Ctrl+K, and a Settings Run button
  // for it was just a second, redundant way in — the
  // palette is the place commands are run from, not a
  // command to run from Settings.
  window.addEventListener("keydown", onKeyDown, true);
}

export function deactivate(): void {
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("pointerdown", onPointerDown, true);
  clearPalette();
}
