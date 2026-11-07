// Hide — corner state. The corner the board hides into, shared
// by the floating button and the Settings picker. The stored value
// comes from the main process (api.window); the default is the
// bottom-left corner.
import type { PluginContext } from "../../src/plugins";

export const CORNERS = ["bottom-left", "bottom-right", "top-left", "top-right", "off"] as const;
export type Corner = (typeof CORNERS)[number];
export const OPTIONS: Array<[string, Corner]> = [
  ["Bottom-left", "bottom-left"],
  ["Bottom-right", "bottom-right"],
  ["Top-left", "top-left"],
  ["Top-right", "top-right"],
  ["Off", "off"],
];

let corner: Corner = "bottom-left";

export function getCorner(): Corner {
  return corner;
}

export function setCorner(value: Corner): void {
  corner = value;
}

export async function loadCorner(api: PluginContext): Promise<void> {
  try {
    const c = await api.window.getCorner();
    if ((CORNERS as readonly string[]).includes(c)) corner = c as Corner;
  } catch {
    // Default stands.
  }
}
