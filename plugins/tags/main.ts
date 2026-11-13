// Tags — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Tags live on the item itself (`item.tags`, set through
// updateItem) and are shown as pills inside each card by
// the decorator below. A tag is added from the card
// itself: the core renders a "+ tag" button at the end of
// the tag row (only while this plugin is enabled), and
// clicking it opens an input on the card. This plugin
// renders the pills; it has no panel.
import type { PluginContext } from "../../src/plugins";

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
}
