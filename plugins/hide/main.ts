// Hide — bundled Bowerbird plugin (see PLUGIN_API.md).
// This used to be core code: a floating button in a corner of the
// board, a corner picker in Settings, and H to minimise. It moved
// here so the Plugin API has to prove it can handle a window-level
// feature, not just cards and panels.
//
// What stays in the core, because a renderer plugin cannot do it:
// hiding the window, showing the peek icon, and remembering the
// corner for the peek (electron/main.ts, collapse/restore/peek,
// and the corner setting file). Everything the user sees — the
// button, the corner picker, the H shortcut — lives in this
// plugin and talks to the core only through api.window, api.board
// and api.ui.
//
// The plugin is three files, like a first-party plugin: corner.ts
// owns the corner state, button.ts the floating button, settings.ts
// the corner picker. main.ts is the entry point that wires them
// together.
import type { PluginContext } from "../../src/plugins";
import { loadCorner } from "./corner.js";
import { clearButton, createButton } from "./button.js";
import { renderSettings } from "./settings.js";

export async function activate(api: PluginContext): Promise<void> {
  // Load the stored corner before registering, so the button's
  // first position and the settings section's active button are
  // correct, not just the default.
  await loadCorner(api);

  api.ui.registerOverlay({
    id: "corner-button",
    render: (container) => createButton(api, container),
  });
  api.ui.registerSettingsSection({
    id: "corner",
    title: "Hide",
    render: (container) => renderSettings(api, container),
  });
  api.ui.registerShortcut({
    key: "h",
    title: "Hide the board (minimise)",
    run: () => { api.window.minimise().catch(() => undefined); },
  });
}

export function deactivate(): void {
  // The core removes the overlay, the settings section and the
  // shortcut on deactivate. Button listeners die with the removed
  // overlay DOM.
  clearButton();
}
