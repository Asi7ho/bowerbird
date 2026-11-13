// Tags is a first-party plugin (core-tags): it registers
// the tag-pill decorator, which shows a card's tags as
// white pills at its bottom left. Adding a tag is the
// core's "+ tag" button on the card (see src/cards.ts);
// this plugin renders the pills only. It uses only the
// public API.
import type { PluginContext, PluginManifest } from "../plugins";

export const manifest: PluginManifest = {
  id: "core-tags",
  name: "Tags",
  description: "Tags show as pills inside each card.",
  version: "1.0.0",
  apiVersion: "2",
  main: "tags.js",
  permissions: ["board:read"],
};

export async function activate(api: PluginContext): Promise<void> {
  api.cards.registerDecorator({
    id: "tags",
    side: "left",
    render: (item) => {
      if (!item.tags || item.tags.length === 0) return null;
      return item.tags
        .map((t) => `<span class="card-tag">#${api.text.escapeHtml(t)}</span>`)
        .join("");
    },
  });
}

export function deactivate(): void {
  // Nothing held: the core unregisters the decorator.
}
