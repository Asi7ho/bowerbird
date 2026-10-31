# Bowerbird

A quick-reveal infinite whiteboard for creatives — the "quick note" idea,
but for a canvas instead of a note.

Drop raw images, text snippets, web links, PDFs, audio, video and colour swatches straight
onto an infinite board. Pan and zoom freely, sketch with a pen,
connect things with lines, and group items that belong together. The board
auto-saves on every change, so closing it never loses anything.

Built with [Electron](https://www.electronjs.org): one frameless window
with a board view filling it. Link cards are previews only — no
embedded pages.

## Run it

```sh
npm install
npm run dev
```

That starts the board in development mode (Vite + Electron). No Xcode
is needed to run it from source on a Mac — Electron is prebuilt, so the
command-line tools are enough for development. A packaged build
(electron-builder, `.app`/DMG) is not wired up yet; running from source
is the supported route for now.

No other setup: the first run opens a welcome board that explains the
controls on the canvas itself.

Your board is stored as one JSON file and auto-saved on every change:

- Linux and macOS: `~/.local/share/bowerbird/board.json` (or `$XDG_DATA_HOME/bowerbird/board.json`)
- Override for testing/portability: `BOWERBIRD_BOARD_PATH=/tmp/my-board.json npm run dev`
- A board left in the pre-rename `quickboard` folder is still read from there.
- Boards written by the GPUI version load as-is, and old boards that
  carry an `embed:true` link card now render that card as a preview
  instead of a page.

## How the "quick reveal" works in v0.2

One window, always alive: the board itself. The window is frameless
and the toolbar carries no window controls — close it the usual way
for your system (Cmd+Q on a Mac); pressing `h` while the board is
focused minimises it, and the floating button in a corner of the
board hides it into that corner (see Collapse to a corner below).
There is no handle tab.

- **Title bar, top:** an opaque white bar, 48px tall, with a hairline
  underneath — Bowerbird on the left, the board search centred in
  it, and nothing else. The bar is the window drag region; the
  search field and its controls opt out of dragging, so typing
  never moves the window. The bar is layout, not an overlay:
  the board, its panels and its views start below it, so nothing
  in the app ever slides over it or hides under it.
- **Vertical toolbar, left side:** a frosted vertical bar, centred on
  the left edge — Select, Pen,
  Arrow (connectors), the pen palette (only while Pen is active),
  zoom out and zoom in, Delete, and Settings. There is no zoom
  percentage readout: zoom is `+`/`-`, `Ctrl` + scroll, or the toolbar
  buttons. Delete is dimmed while nothing is selected. The bar itself
  is the window drag region; its buttons are not. A fresh board starts
  clear of the bar, so the welcome board is never hidden behind it.
- **Collapse to a corner:** a floating button in a corner of the
  board (bottom-left by default) hides the whole board into that
  corner. Only a small round icon stays visible there, with an
  arrow pointing away from the corner into the screen. Clicking
  that icon opens the board again, back in its saved bounds.
  Change the corner in Settings, under Corner reveal
  (Bottom-left, Bottom-right, Top-left, Top-right, or Off) — the
  floating button moves to the chosen corner, and Off hides it.
  Cards scale with the zoom: a card is laid out in world units
  and scaled by the camera, so its text, padding and images shrink
  and grow with it instead of staying fixed while the card shrinks.
  Text is never selected by a board click or drag; only the note
  editor and Settings allow text selection. A selected card shows a
  visible resize square at its bottom-right corner, and hovering that
  corner shows a diagonal resize cursor.
- **Smoothness:** cards live in world coordinates and the whole
  cards layer is transformed once by the camera, so pan and zoom
  are one GPU transform instead of repositioning and re-parsing
  every card per frame. The grid is a CSS background that follows
  the camera, not hundreds of SVG dots rebuilt per frame. Drags
  update only the dragged card's style (or a single SVG preview
  for pen, connector and marquee) instead of rebuilding the board,
  cursor hints run at most once per frame, and content is only
  rebuilt when the visible set actually changes.
- **Settings (?):** a panel listing every keyboard shortcut, plus the
  canvas background (White, Paper, Sage, Sky, Ink) and grid
  (Dots, Lines, Off), the corner the board collapses into, a
  Data section, and a Quit Bowerbird button under App. The corner
  choice is saved in the app's settings file and survives restarts.
- **In-app hotkeys:** `V` select, `P` pen, `A` arrow, `Ctrl/Cmd+G`
  group, `Ctrl/Cmd+U` ungroup, `Delete` removes the selection,
  `+`/`-` zoom, `0` resets the view, hold `Space` to pan, `h` hides,
  `?` settings, `Tab` next element, `Shift + Tab` previous element.
  There is no add menu: adding is drag and drop (see
  below), plus double-clicking empty space for a note.

What is *not* faked: a system-wide global hotkey that fires while another
app is focused needs an OS-level hook (CGEventTap / accessibility
permission on macOS, a global key grabber on Linux). That is the next
step, not something v0.2 pretends to do. The corner peek above is
not a fake swipe: it is a real window, and clicking its icon
really restores the board.

## Using the board

- **First run:** a fresh board opens as a showcase of everything the
  app does — a note, a real photograph, a link card with a real
  image and icon, colour swatches, a PDF card, an audio card, a
  video card, a grouped pair (note + swatch, moving together), a
  pen circle drawn around the photo, a connector, and a short
  note explaining Tab navigation, panning, zooming and
  drag-and-drop — with space between the cards, so you can see
  what every element looks like before adding your own. The
  photo, audio, video and PDF are installed next to your board
  file on first launch, so they open wherever you run the app
  from. They are real Wikimedia Commons media: a Satin Bowerbird
  photograph, its call, and a short clip of one. Cards are flat and
  minimal: a hairline border, a soft corner, no heavy shadow;
  link cards get a pastel tile with the domain's initial in colour,
  PDF cards a pastel red tile, swatches a white hex pill.
- **Pan:** hold `Space` and drag, or scroll without Ctrl. **Zoom:**
  `Ctrl` + scroll (keeps the point under the cursor fixed), or `+`/`-`,
  or the toolbar zoom buttons. The canvas fills the window below
  the title bar and the toolbar floats over its left edge.
- **Select:** click an item, `Shift`-click to add to the selection, or drag
  a marquee around several items. Dragging one member of a group moves the
  whole group. `Ctrl/Cmd+G` groups the selection. Clicking a card brings
  it to the front.
- **Find an element:** the board is infinite, so an element can be far
  from the current view. `Tab` steps through the elements one by one
  in board order, selecting each in turn and centring the camera on
  it; `Shift + Tab` steps backwards, and the cycle wraps. Pen strokes
  and connectors are skipped — they are drawings and lines, not
  elements to find. Starting from a selected element, `Tab` goes to
  the next one after it.
- **Delete all board data:** Settings → Data → Delete all board data.
  It asks you to confirm first, then removes everything saved in
  the whiteboard — the board file and every file dropped onto it —
  and restores a fresh welcome board. The corner setting is kept.
  There is no undo, so the confirm step is deliberate.
- **Resize:** drag the small handle at a card's bottom-right corner —
  it works on the first click, no need to select first. Everything
  resizes: notes, cards, images, swatches, strokes (their points
  scale). Connectors have no handle: their ends follow their anchors,
  so there is nothing to drag — move the cards they connect instead.
- **Canvas:** a fresh board is white with a dot grid. Boards saved
  with other settings keep them.
- **Pen:** drag on the canvas to sketch.
- **Connector (Arrow):** drag from one item to another (or from empty
  space to empty space). Endpoints anchored to items follow them when
  they move.
- **Text:** double-click empty space for a new note, double-click a
  note to edit it. The card itself becomes a simple text editor: raw
  text with a blinking cursor, no input bar anywhere. `Esc` (or a click
  elsewhere) commits, and the note renders markdown automatically once
  committed — `#` headings, `-` bullets, `1.` lists, `>` quotes, fenced
  code blocks, and inline **bold**, *italic*, `code`, [links](https://example.com) and ~~strikethrough~~.
- **Drop files onto the canvas:** images (PNG/JPG/GIF/WebP/BMP/SVG),
  PDFs, audio files (MP3/WAV/FLAC/OGG/M4A), video files
  (MP4/MOV/WebM/MKV/AVI), `.txt`/`.md` files (become notes — a file
  whose whole content is a colour code like `#FF6B35` becomes a swatch
  instead), and `.url`/`.webloc` shortcut files (become link preview
  cards; a video link becomes a video card). Drop several at once and
  they fan out from the drop point. Bowerbird keeps its own copy of every dropped
  file in an `assets` folder next to your board file, so deleting the
  original later never breaks the card.
- **Audio:** an audio file lands as a mini-player card — a pastel tile
  with a play button, the file name, and a waveform strip. Click the
  play button to play or pause it inside Bowerbird.
- **Video:** a video file lands as a preview card and opens in your
  system video player (local files) or browser (links) on click.
  Decoding video frames inside the canvas is a planned follow-up.
- **Links — preview cards:** a link card shows what the site itself
  provides — its preview image on top when it has one (Open Graph /
  Twitter image), otherwise a clean text card — plus its title,
  description, and a footer with its icon and domain. Click the
  image, title or domain to open the site in your browser. A card
  with no preview yet just shows its domain until the fetch lands;
  a site with no image or icon falls back to a coloured initial tile.
  Dropped links become preview cards automatically; a video link
  becomes a video card instead.
- **Long names never spill:** card text is clipped to the card — long
  file names, titles and URLs end with "…", descriptions are capped at
  two lines. Nothing ever runs onto the canvas or over a neighbour.
- **Swatches:** drop a text file whose whole content is a colour code
  like `#FF6B35` and it becomes a swatch.
- **PDFs:** a PDF lands as a card (name + size) and opens in your system
  viewer on double-click. Rendering PDF pages *inside* the canvas is a
  planned follow-up, not a stub that pretends otherwise.

## Icon

Bowerbird has its own icon, not a framework default: a blue
squircle with a white board and flat colour cards inside, in
the app's palette — no bird, no pale outer ring. The squircle
is inset to 75% of its canvas, so in the Dock it reads the
same size as other icons instead of dominating them. The
vector source is `assets/icon.svg`;
`assets/icon.png` is the 1024px export, `assets/icon.ico` is the
Windows multi-size icon, and `assets/icon.iconset/` is the macOS
iconset. The app uses it for its window icon (Linux/Windows
taskbar) and, on macOS, for its Dock icon when running from source
(`app.dock.setIcon`). For a packaged Mac build, generate the
`.icns` on a Mac with:

```sh
iconutil -c icns assets/icon.iconset
```

## App Store screenshots

`screenshots/` holds five 1440×900 PNGs captured from the running
app (see `screenshots/README.md` for what each one shows and how
to upload them). They are the app itself, full-bleed, with no
cursor in frame and no captions baked in.

## Project layout

```
electron/
  main.js     frameless BaseWindow, board view,
              board file, asset embedding, link previews, IPC
  preload.js  the only privileged surface the renderer sees
  peek.html     small round corner icon, click to restore
  dev.js      dev runner: Vite, then Electron pointed at it
src/
  main.ts     board UI: tools, rendering, interactions, settings
  model.ts    board data + geometry: pan/zoom, hit-testing, grouping,
              markdown, link classification
  styles.css  flat, quiet board styling
index.html    board shell + vertical left toolbar
assets/       welcome photo, birdsong and video + sample PDF, installed beside the board;
              icon.svg / icon.png (1024) / icon.ico / icon.iconset
screenshots/  App Store screenshots, 1440x900 PNG (see screenshots/README.md)
```

Checks:

```sh
npx tsc --noEmit   # TypeScript
npm run build      # production renderer bundle (dist/)
```

## Status / roadmap

v0.2 — the Electron migration, verified on Linux under Xvfb (welcome
board, toolbar, zoom, pen, note editing, delete, settings shortcuts,
old GPUI board loading, and link preview cards with image, icon and
title). Still to check on a Mac: real drag-and-drop from Finder and
from a browser address bar, audio audibility, Cmd+G/U grouping, and
minimise/Dock behaviour.

Next, in order: system-wide global hotkey on macOS,
in-canvas PDF page rendering, in-canvas video playback, note formatting
controls in the toolbar (bold/size/colour), multi-board switching, and
a packaged build (`.app`/DMG).

## License

MIT.
