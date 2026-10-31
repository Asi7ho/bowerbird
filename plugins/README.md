# Bundled plugins

Plugins in this folder ship inside the app. They are listed in
Settings → Plugins as "Built in" and update with the app. They use
exactly the same Plugin API (see `PLUGIN_API.md` in the repo root)
as user plugins — no backdoors — so a bundled plugin is also a
proof that the API can build that feature.

- `hide/` — the corner button that hides Bowerbird into a corner,
  the corner picker in Settings, and H to minimise. The first
  bundled plugin, and the first feature moved out of the core
  into a plugin. The main process still owns what a renderer
  plugin cannot do: hiding the window, showing the peek icon,
  and remembering the corner for the peek.
- `visual-library/` — a panel over a library folder on disk, with
  search, click-to-place and drag-to-place as ordinary Image and
  PDF cards. Listing and copying are scoped to the library folder
  through the core.

Packaging: `scripts/package-mac.sh` copies this folder into the
app bundle (`Contents/Resources/app/plugins/`), and
`scripts/package-demo.sh` copies the normal app, so the demo
includes bundled plugins too. Running from source finds this
folder via the current working directory.
