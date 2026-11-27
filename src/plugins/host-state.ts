// The plugin host's registries and shared state.

import type { Item, PluginBuiltinCardDef, PluginCardDecoratorDef, PluginCardDef, PluginCommandDef, PluginContext, PluginCreateActionDef, PluginManifest, PluginOverlayDef, PluginPanelDef, PluginSettingsSectionDef, PluginShortcutDef, PluginToolDef, PluginViewDef, ShellElements } from "bowerbird-plugin-api";

export interface LoadedPlugin {
  manifest: PluginManifest;
  // First-party (core) plugins are bundled with the app and
  // build the app's own UI; the rest are user plugins. The
  // flag is exposed in plugins.list() so Settings can group
  // them, and so a plugin can tell core UI apart from extras.
  firstParty?: boolean;
  // A first-party plugin's module is a bundled import, not
  // a file on disk, so it cannot be re-loaded from the
  // plugin: scheme. It is kept here across deactivation so
  // re-enabling the plugin re-activates the same module
  // instead of fetching a URL that does not exist.
  firstPartyModule?: { activate?: (api: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> } | null;
  // Trial plugins run in memory only (see tryPlugin): they are
  // never written to disk, and endTrial removes them entirely.
  trial?: boolean;
  active: boolean;
  failed: boolean;
  error: string | null;
  module: { activate?: (api: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> } | null;
}

export const cards = new Map<string, PluginCardDef & { pluginId: string }>();
export const builtinCards = new Map<string, PluginBuiltinCardDef & { pluginId: string }>();
// Card decorations: a plugin registers a renderer that
// returns HTML shown inside a card, at its bottom edge
// (checklist progress sits bottom-right). Decorations are
// display only — they never take clicks (pointer-events:
// none in styles.css) and never write. A renderer that
// throws renders nothing.
export const cardDecorators = new Map<string, PluginCardDecoratorDef & { pluginId: string }>();
export function getCardDecorations(item: Item): { left: string; right: string } {
  let left = "";
  let right = "";
  for (const def of cardDecorators.values()) {
    try {
      const html = def.render(item);
      if (!html) continue;
      if (def.side === "right") right += html; else left += html;
    } catch { /* a broken decorator renders nothing */ }
  }
  return { left, right };
}

export const tools = new Map<string, PluginToolDef & { pluginId: string; fullId: string }>();
// Stroke textures: a plugin registers an SVG filter for
// its brush strokes; the board renderer wraps the filter
// in `<filter id="texture-<id>">` beside the pencil
// filter. Keyed by texture id, which is global — two
// plugins cannot hold the same id.
export interface RegisteredTexture {
  id: string;
  label: string;
  filterSvg: string;
  pluginId: string;
}
export const textures = new Map<string, RegisteredTexture>();
export const panels = new Map<string, PluginPanelDef & { pluginId: string; el: HTMLElement; body: HTMLElement; tab: HTMLElement; hidden: boolean }>();
export const views = new Map<string, PluginViewDef & { pluginId: string }>();
export const commands = new Map<string, PluginCommandDef & { pluginId: string }>();
export const createActions = new Map<string, PluginCreateActionDef & { pluginId: string }>();
export const overlays = new Map<string, PluginOverlayDef & { pluginId: string; el: HTMLElement }>();
export const settingsSections = new Map<string, PluginSettingsSectionDef & { pluginId: string }>();
export const shortcuts = new Map<string, PluginShortcutDef & { pluginId: string }>();
export const loaded = new Map<string, LoadedPlugin>();
export const listeners = new Map<string, Set<() => void>>();
// The core's own events: state changes the core fires and
// every plugin listens for — the board changed, a save
// started or finished, the tool, view, camera, pen or
// selection changed, or items moved without a save (a drag
// moves cards live and saves once at drag end, so a
// listener that follows a card — the toolbar's note colour
// bar — needs this, not the save-time "board" event). A
// plugin may listen for these but never fire them: firing
// one would make every other plugin and the core act on a
// state change that never happened.
export const CORE_EVENTS = new Set(["board", "camera", "items-moved", "pen", "save-failed", "saved", "saving", "selection", "tool", "view"]);

// The shell DOM the core owns (board element, panels
// element, view switcher, toast, ...), filled in by
// registerShellElements. A const bag mutated through
// Object.assign, never reassigned.
export const shell: Partial<ShellElements> = {};
