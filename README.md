# Bowerbird

A quick-reveal infinite whiteboard for creatives — the "quick note" idea,
but for a canvas instead of a note.

Drop raw images, text snippets, web links, PDFs, audio, video and colour swatches straight
onto an infinite board. Pan and zoom freely, sketch with a pen,
connect things with lines, and group items that belong together. The board
auto-saves on every change, so closing it never loses anything.

Built with [Electron](https://www.electronjs.org): one frameless window,
a board view filling it, and every embedded page as its own Chromium
view positioned at its card. The GPUI version that came before lives in
`legacy-gpui/` for reference; it is not built by the Electron app.

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
- Boards written by the GPUI version load as-is. Their link cards stay
  simple unless you turn them into embedded pages; the new `embed`
  flag defaults to off for old cards.

## How the "quick reveal" works in v0.2

One window, always alive: the board itself. The window is frameless,
so the floating toolbar carries the window controls (minimise and
close) next to the board tools. Pressing `h` while the board is focused
minimises it; it stays alive in the Dock / taskbar, which is what
brings it back. There is no second handle window.

- **Floating toolbar:** a centred pill over the canvas — Select, Pen,
  Arrow (connectors), Delete, zoom out / percentage / zoom in,
  Settings, minimise, close, and a drag grip. The pen palette appears
  only while Pen is active. Delete is dimmed while nothing is
  selected. Clicking the zoom percentage resets the view to 100%.
- **Settings (?):** a panel listing every keyboard shortcut, plus the
  canvas background (White, Paper, Sage, Sky, Ink) and grid
  (Dots, Lines, Off). While settings are open, embedded pages are
  hidden; they return when settings close.
- **In-app hotkeys:** `V` select, `P` pen, `A` arrow, `Ctrl/Cmd+G`
  group, `Ctrl/Cmd+U` ungroup, `Delete` removes the selection,
  `+`/`-` zoom, `0` resets the view, hold `Space` to pan, `h` hides,
  `?` settings. There is no add menu: adding is drag and drop (see
  below), plus double-clicking empty space for a note.

What is *not* faked: a system-wide global hotkey that fires while another
app is focused, and a macOS screen-corner swipe, both need OS-level hooks
(CGEventTap / accessibility permission on macOS, a global key grabber on
Linux). Those are the next step, not something v0.2 pretends to do.

## Using the board

- **First run:** a fresh board opens as a showcase — a note, two colour
  swatches, a link card, a real PDF card and a picture, with a connector
  from the note to the link — so you can see what every element looks
  like before adding your own. The picture and PDF are installed next to
  your board file on first launch, so they open wherever you run the app
  from. Cards are flat and minimal: a hairline border, a soft corner,
  no heavy shadow; link cards get a pastel tile with the domain's
  initial in colour, PDF cards a pastel red tile, swatches a white
  hex pill.
- **Pan:** hold `Space` and drag, or scroll without Ctrl. **Zoom:**
  `Ctrl` + scroll (keeps the point under the cursor fixed), or `+`/`-`,
  or the toolbar zoom controls. The canvas fills the whole window and
  the toolbar floats over it.
- **Select:** click an item, `Shift`-click to add to the selection, or drag
  a marquee around several items. Dragging one member of a group moves the
  whole group. `Ctrl/Cmd+G` groups the selection. Clicking a card brings
  it to the front, so an overlapping card cannot hide an embedded
  card's header buttons.
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
- **Links — simple or embedded:** a link card starts simple (domain,
  title/description when the fetch succeeds — Open Graph
  title/description preferred, `<title>` as fallback). Press
  **Embed page** and the card grows into a real, interactive page:
  a header (drag grip, domain, Open, Simple) with the live page below
  it in its own Chromium view, following the card on pan, zoom, move
  and resize. Press **Simple** to go back to a preview card (the page
  view is destroyed). A page that blocks framing is not faked with a
  screenshot — it stays a simple card with an Open button. Direct
  file/video URLs stay simple; ordinary pages are embeddable.
  Because an embedded page is a native view, it always paints above
  the board DOM: a page under the floating toolbar can cover toolbar
  pixels, so drag such a card by its header to move it out from under
  the toolbar.
- **Long names never spill:** card text is clipped to the card — long
  file names, titles and URLs end with "…", descriptions are capped at
  two lines. Nothing ever runs onto the canvas or over a neighbour.
- **Swatches:** drop a text file whose whole content is a colour code
  like `#FF6B35` and it becomes a swatch.
- **PDFs:** a PDF lands as a card (name + size) and opens in your system
  viewer on double-click. Rendering PDF pages *inside* the canvas is a
  planned follow-up, not a stub that pretends otherwise.

## Project layout

```
electron/
  main.js     frameless BaseWindow, board view, embedded page views,
              board file, asset embedding, link previews, IPC
  preload.js  the only privileged surface the renderer sees
  dev.js      dev runner: Vite, then Electron pointed at it
src/
  main.ts     board UI: tools, rendering, interactions, settings
  model.ts    board data + geometry: pan/zoom, hit-testing, grouping,
              markdown, link classification
  styles.css  flat, quiet board styling
index.html    board shell + floating toolbar
assets/       welcome picture + sample PDF, installed beside the board
legacy-gpui/  the previous Rust/GPUI app, kept for reference
```

Checks:

```sh
npx tsc --noEmit   # TypeScript
npm run build      # production renderer bundle (dist/)
```

## Status / roadmap

v0.2 — the Electron migration, verified on Linux under Xvfb (welcome
board, toolbar, zoom, pen, note editing, delete, embed positioning and
pan/zoom sync, Simple/Embed toggle, settings shortcuts, old GPUI board
loading). Still to check on a Mac: real drag-and-drop from Finder and
from a browser address bar, audio audibility, Cmd+G/U grouping,
minimise/Dock behaviour, and embedded-page behaviour in WKWebView's
Chromium counterpart.

Next, in order: system-wide global hotkey + corner trigger on macOS,
in-canvas PDF page rendering, in-canvas video playback, note formatting
controls in the toolbar (bold/size/colour), multi-board switching, and
a packaged build (`.app`/DMG).

## License

MIT.
