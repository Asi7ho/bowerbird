// Command palette: one place to find anything — plugin commands,
// board cards, views, tools and core actions — and route the pick
// to the app or the plugin that owns it. The palette itself never
// runs another plugin's command. Cmd/Ctrl+K opens it.
import type { PluginContext, PluginManifest } from "bowerbird-plugin-api";
import { clearPalette, initOverlay, initPalette, onKeyDown, onPointerDown } from "./ui";

export const manifest: PluginManifest = {
  apiVersion: "2",
  id: "command-palette",
  name: "Command Palette",
  version: "1.0.0",
  description: "Every command, from one place. Cmd/Ctrl + K.",
  main: "command-palette/main.js",
  permissions: ["board:write", "window"],
  // The palette is the way commands are run: disabling it would
  // leave Cmd/Ctrl+K dead, so it cannot be disabled, like the board.
  required: true,
};

export function activate(api: PluginContext): void {
  initPalette(api);
  api.ui.registerOverlay({
    id: "palette",
    render: (container) => initOverlay(container),
  });
  // No command is registered for opening the palette:
  // it opens with Cmd/Ctrl+K. The palette is the place
  // commands are run from, not a command to run itself.
  window.addEventListener("keydown", onKeyDown, true);
}

export function deactivate(): void {
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("pointerdown", onPointerDown, true);
  clearPalette();
}
