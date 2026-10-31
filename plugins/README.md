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
- `visual-library/` — two modes over the same board, with
  the same board card in both: a panel flush against the
  right edge, full height, over the board (search,
  click-to-duplicate, drag-to-duplicate) and a Pinterest-like
  masonry whiteboard view replacing the canvas (search,
  click-to-duplicate). The library is the board's own cards
  (text, images, links, PDFs, swatches, audio, video, plugin
  cards), rendered by the core at the board item's aspect
  ratio, scaled down to its span but never up beyond
  board size, packed in spanning masonry (small cards
  span one small column, others span two, so swatches
  sit side by side with 16px gaps), all in a
  single Uncategorized section in board
  order — no categories are created for the user. Duplicates
  are ordinary board items of the same kind and size, so
  they appear in the library too, in Uncategorized. There is
  no library folder.
- `palette/` — a panel of curated colour palettes, not a
  library of the board's own cards. Click a colour to place
  a 120x120 swatch at the camera centre, drag it to place it
  at the drop point, the same interaction as Visual Library.
  Placed swatches are ordinary board Swatch items, so they
  survive disabling the plugin. Palettes are static and
  bundled in the plugin file, with no network and no
  storage.

Packaging: `scripts/package-mac.sh` copies this folder into the
app bundle (`Contents/Resources/app/plugins/`), and
`scripts/package-demo.sh` copies the normal app, so the demo
includes bundled plugins too. Running from source finds this
folder via the current working directory.
