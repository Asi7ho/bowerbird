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
- `palette/` — a colour wheel panel, not a library of
  the board's own cards and not a fixed palette list. Pick
  a colour on the wheel (hue round the wheel, saturation
  from centre to edge, lightness on the slider) and five
  palettes are made from it live, following colour theory:
  Monochromatic, Analogous, Complementary, Split
  complementary, Triadic, five colours each. Click a colour
  in a palette, or the preview swatch, to place a 120x120
  swatch at the camera centre, drag it to place it at the
  drop point, the same interaction as Visual Library.
  Placed swatches are ordinary board Swatch items, so they
  survive disabling the plugin. No network, no storage,
  board:write only.
- `presentation/` — slides are frames on the board, not
  cards: draw a rectangle around cards to make a slide,
  then play it. A slide shows only its dashed border on
  the board, with a "Slide N" label, so the cards inside
  stay visible and editable; move a card into a frame
  and it joins that slide. The panel lists slides in
  creation order, with Play, Draw a slide, and per-slide
  Play and Delete; double-clicking a frame on the board
  plays from that slide. Playing shows a frame's area,
  scaled to fit, almost as a screenshot of that area:
  every card that overlaps it, every pen stroke and
  connector segment that enters it, in board positions,
  cropped to the frame, drawing under cards; a video
  plays in place, an audio card plays in place, a link
  opens outside, other clicks do nothing. It needs `board:write` (for frames),
  `view:replace` and `files:read` (for opening links).

Packaging: `scripts/package-mac.sh` copies this folder into the
app bundle (`Contents/Resources/app/plugins/`), and
`scripts/package-demo.sh` copies the normal app, so the demo
includes bundled plugins too. Running from source finds this
folder via the current working directory.
