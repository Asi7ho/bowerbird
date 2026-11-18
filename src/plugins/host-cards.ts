// The plugin card registry: plugin card renderers, the
// built-in card kinds, card search text, card actions and
// double-clicks, plugin tools and plugin commands.
//
// These functions only need the registries (host-state), the
// model helpers, and the host for toasts on a failed card
// action/command — the host comes via the deps bound by
// initPlugins, a getter closure over host.ts's host let, so
// this module always sees the live value without owning it,
// and before initPlugins binds it the toast calls no-op
// exactly as they did when host was null.
//
// domId and isPluginCard live here too: domId builds the
// element ids for plugin-registered tools (syncPluginToolButtons
// reads them), and isPluginCard is the card-kind guard every
// function below uses. host.ts imports both back.
import type { Item, PluginBuiltinCardDef, PluginCardDef, PluginCommandDef, PluginHost, PluginToolDef } from "bowerbird-plugin-api";
import { escapeHtml } from "../backend/model";
import { builtinCards, cards, commands, loaded, tools } from "./host-state";

export interface CardDeps {
  getHost: () => PluginHost | null;
}

let deps: CardDeps | null = null;
export function bindCardDeps(d: CardDeps): void {
  deps = d;
}

export function domId(pluginId: string, kind: string, id: string): string {
  return `${kind}-plugin-${pluginId}-${id}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

export function isPluginCard(item: Item): item is Item & { kind: { Plugin: { plugin: string; kind: string; data: unknown } } } {
  return "Plugin" in item.kind;
}

export function getCardRenderer(item: Item): PluginCardDef | null {
  if (!isPluginCard(item)) return null;
  return cards.get(`${item.kind.Plugin.plugin}:${item.kind.Plugin.kind}`) ?? null;
}

// A placeholder card for a plugin card that cannot render:
// missing plugin, a render that threw, or a builtin render
// that threw. One helper, not three near-identical divs.
function fallbackCard(title: string, sub: string, sub2?: string): string {
  return `<div style="padding:12px"><div class="title" style="font-size:14px">${title}</div><div class="sub" style="font-size:12px">${sub}</div>${sub2 ? `<div class="sub" style="font-size:12px">${sub2}</div>` : ""}</div>`;
}

export function getCardHtml(item: Item): string | null {
  if (!isPluginCard(item)) return null;
  const def = getCardRenderer(item);
  // Selection class and card chrome are applied by the core
  // wrapper in main.ts; this returns inner HTML only.
  if (!def) {
    const { plugin, kind } = item.kind.Plugin;
    // A frame card is a container, not content: when its
    // plugin is disabled, the frame itself goes away rather
    // than showing a placeholder. The frame is declared in
    // the plugin's manifest, so the core knows it is a frame
    // even though the plugin was never activated in this
    // session — the card's data stays in the board, and
    // re-enabling the plugin brings the frame back.
    const manifest = loaded.get(plugin)?.manifest;
    const isFrame = manifest?.contributions?.cards?.some(
      (c) => c.kind === kind && c.frame === true
    );
    if (isFrame) return null;
    return fallbackCard("Plugin card", `${escapeHtml(plugin)} — ${escapeHtml(kind)}`, "Install the plugin to view this card. Your data is kept.");
  }
  try {
    return def.render(item, item.kind.Plugin.data);
  } catch (e) {
    return fallbackCard("Plugin card failed to render", escapeHtml(String(e)));
  }
}

// ---------------------------------------------------------------- built-in card kinds

// The built-in card kinds (Text, Image, Swatch, UrlCard,
// PdfCard, FileCard, Audio, Video, Shape). Strokes and connectors are
// not cards — they are drawn on the canvas, not rendered
// as card HTML — so they have no builtin renderer.
export function builtinKindName(item: Item): string | null {
  if (isPluginCard(item)) return null;
  if ("Text" in item.kind) return "Text";
  if ("Image" in item.kind) return "Image";
  if ("Swatch" in item.kind) return "Swatch";
  if ("UrlCard" in item.kind) return "UrlCard";
  if ("PdfCard" in item.kind) return "PdfCard";
  if ("FileCard" in item.kind) return "FileCard";
  if ("Audio" in item.kind) return "Audio";
  if ("Video" in item.kind) return "Video";
  if ("Model3D" in item.kind) return "Model3D";
  if ("Shape" in item.kind) return "Shape";
  if ("Stroke" in item.kind) return "Stroke";
  return null;
}

export function registerBuiltinCard(pluginId: string, def: PluginBuiltinCardDef): void {
  builtinCards.set(def.kind, { ...def, pluginId });
}

// Render a built-in card through the plugin that registered
// a renderer for its kind, or null when no plugin provides
// one (the core then falls back to its own renderer, during
// migration, or a placeholder). The renderer returns the
// complete card HTML — outer div, position, size, selection
// ring and all — exactly as the core's renderer did.
export function getBuiltinCardHtml(item: Item, plain = false): string | null {
  const kindName = builtinKindName(item);
  if (!kindName) return null;
  const def = builtinCards.get(kindName);
  if (!def) return null;
  try {
    return def.render(item, (item.kind as Record<string, unknown>)[kindName], plain);
  } catch (e) {
    return fallbackCard("Card failed to render", escapeHtml(String(e)));
  }
}

export function getPluginCardSearchText(item: Item): string | null {
  if (!isPluginCard(item)) return null;
  const def = getCardRenderer(item);
  if (def?.searchText) {
    try {
      return def.searchText(item.kind.Plugin.data);
    } catch {
      return null;
    }
  }
  return `${item.kind.Plugin.plugin} ${item.kind.Plugin.kind} ${JSON.stringify(item.kind.Plugin.data ?? "")}`;
}

export function handlePluginCardDoubleClick(item: Item): boolean {
  if (!isPluginCard(item)) return false;
  const def = getCardRenderer(item);
  if (!def?.onDoubleClick) return false;
  try {
    def.onDoubleClick(item, item.kind.Plugin.data);
  } catch (e) {
    deps?.getHost()?.toast(`Plugin card failed: ${String(e)}`);
  }
  return true;
}

export function handlePluginCardAction(action: string, item: Item): boolean {
  if (!isPluginCard(item)) return false;
  const def = getCardRenderer(item);
  if (!def?.onAction) return false;
  try {
    def.onAction(action, item, item.kind.Plugin.data);
  } catch (e) {
    deps?.getHost()?.toast(`Plugin action failed: ${String(e)}`);
  }
  return true;
}

export function getPluginTool(fullId: string): (PluginToolDef & { pluginId: string; fullId: string }) | null {
  return tools.get(fullId) ?? null;
}

export function syncPluginToolButtons(activeTool: string): void {
  for (const t of tools.values()) {
    const btn = document.getElementById(domId(t.pluginId, "tool", t.id));
    if (btn) btn.classList.toggle("active", activeTool === t.fullId);
  }
}

export function listPluginCommands(): Array<PluginCommandDef & { pluginId: string; pluginName: string }> {
  const out: Array<PluginCommandDef & { pluginId: string; pluginName: string }> = [];
  for (const c of commands.values()) {
    const lp = loaded.get(c.pluginId);
    out.push({ ...c, pluginName: lp?.manifest.name ?? c.pluginId });
  }
  return out;
}

export async function runPluginCommand(pluginId: string, commandId: string): Promise<void> {
  const c = commands.get(`${pluginId}:${commandId}`);
  if (!c) return;
  try {
    await c.run();
  } catch (e) {
    deps?.getHost()?.toast(`Plugin command failed: ${String(e)}`);
  }
}
