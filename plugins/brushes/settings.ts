// Brush Library — the Settings section: reset the library
// to the eight factory presets.
import type { PluginContext } from "bowerbird-plugin-api";
import { resetLibrary } from "./panel.js";

// The section's container, so the panel's undo handler
// can tell when focus is inside it: after a Reset, the
// Reset button has focus, and Ctrl+Z there should take
// the reset back, not fall through to the board.
let settingsContainer: HTMLElement | null = null;

export function settingsContains(node: Node | null): boolean {
  return node !== null && settingsContainer !== null && settingsContainer.contains(node);
}

export function clearSettings(): void {
  settingsContainer = null;
}

export function renderSettings(api: PluginContext, container: HTMLElement): void {
  settingsContainer = container;
  container.innerHTML = "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "br-settings-btn";
  btn.textContent = "Reset to original brushes";
  btn.addEventListener("click", () => {
    resetLibrary();
    api.ui.toast("Brushes reset");
  });
  container.appendChild(btn);
}
