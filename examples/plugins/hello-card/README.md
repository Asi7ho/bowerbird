# Hello Card — sample plugin

The smallest plugin that uses every Plugin API surface: a card kind, a tool, a panel, a command and a view. See `PLUGIN_API.md` in the repo root for the full API.

To try it: copy this folder into your plugins folder (`~/.local/share/bowerbird/plugins/` on Linux), restart Bowerbird, and look for the Hello stamp tool in the toolbar, the Hello panel on the right, the List view in the bottom view switcher, and "Hello Card" in Settings → Plugins (where its command can also be run).

To start a new plugin: copy this folder, change the `id` and `name` in `manifest.json`, and replace the Hello card with your own kind. Keep `apiVersion` at `"2"`.
