# Bowerbird

A quick-reveal infinite whiteboard for creatives — the "quick note" idea,
but for a canvas instead of a note.

Drop raw images, text snippets, web links, PDFs, audio, video and colour swatches straight
onto an infinite board. Pan and zoom freely, sketch with a pen or marker,
connect things with lines, and group items that belong together. The board
auto-saves on every change, so closing it never loses anything.

Built in Rust with [GPUI](https://gpui.rs) (the UI framework behind Zed).

## Run it

```sh
cargo run
```

Requires a current stable Rust (developed against Rust 1.99) and, on Linux,
the display libraries GPUI needs:

```sh
# Debian / Ubuntu
sudo apt install libwayland-dev libxkbcommon-dev libxkbcommon-x11-dev libxcb1-dev
# Software (headless/VM) rendering also wants a Vulkan driver:
sudo apt install mesa-vulkan-drivers
```

On macOS, Xcode command-line tools are enough (`xcode-select --install`).
No other setup: the first run opens a welcome board that explains the
controls on the canvas itself.

Your board is stored as one JSON file and auto-saved on every change:

- Linux: `~/.local/share/bowerbird/board.json` (or `$XDG_DATA_HOME/bowerbird/board.json`)
- macOS: `~/.local/share/bowerbird/board.json`
- Override for testing/portability: `BOWERBIRD_BOARD_PATH=/tmp/my-board.json cargo run`
- A board left in the pre-rename `quickboard` folder is still read from there.

## How the "quick reveal" works in v0.1

- **Desktop handle:** a small dark `▦ Bowerbird` pill sits in the
  top-right corner of the primary display, above other apps. Click it and
  the board comes forward.
- **Hide:** the board toolbar's eye icon, or pressing `h` while the
  board is focused, minimises the board back to just the handle.
  The toolbar is icons only; the active tool is the highlighted one.
  Icons are drawn vectors, not emoji, so they look the same on every
  platform.
- **Minimal toolbar:** the bar shows only what you need right now —
  the pen palette appears only for the Pen/Marker tools, group/ungroup/
  delete only appear while something is selected. There is no add
  menu: adding is drag and drop (see below), plus double-clicking
  empty space for a note. The accent throughout is macOS blue; on a
  Mac the interface also picks up the system font and native window
  controls.
- **In-app hotkeys:** `V` select, `P` pen, `M` marker, `C` connector,
  `T` text, `Ctrl/Cmd+G` group, `Ctrl/Cmd+U` ungroup, `Delete` removes the
  selection, `+`/`-` zoom, `0` resets the view, hold `Space` to pan.

What is *not* faked: a system-wide global hotkey that fires while another
app is focused, and a macOS screen-corner swipe, both need OS-level hooks
(CGEventTap / accessibility permission on macOS, a global key grabber on
Linux). Those are the next step, not something v0.1 pretends to do — the
handle pill is the honest v0.1 version, and it works from any app because
it stays on top.

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
- **Pan:** drag with the Pan tool, hold `Space` and drag, or scroll without
  Ctrl. **Zoom:** `Ctrl` + scroll (keeps the point under the cursor fixed),
  or `+`/`-`.
- **Select:** click an item, `Shift`-click to add to the selection, or drag
  a marquee around several items. Dragging one member of a group moves the
  whole group. `Ctrl/Cmd+G` groups the selection.
- **Resize:** select exactly one item and drag the small handle at its
  bottom-right corner. Everything resizes: notes, cards, images,
  swatches, strokes (their points scale), and connectors (their free
  endpoints scale; item-anchored ends stay pinned to their items).
- **Canvas:** the sliders icon at the toolbar's right end opens a panel
  with background colours (Paper, White, Sage, Sky, Ink) and grid styles
  (lines, dots, off). Choices apply instantly and save with the board.
- **Pen / Marker:** drag on the canvas. Marker is thicker and translucent.
- **Connector:** drag from one item to another (or from empty space to
  empty space). Endpoints anchored to items follow them when they move.
- **Text:** `T` then click, or double-click empty space, type,
  `Enter` for a new line, `Esc` to finish. Double-click a note to edit
  it again. Notes render markdown automatically — `#` headings, `-`
  bullets, `1.` lists, `>` quotes, fenced code blocks, and inline
  **bold**, *italic*, `code`, [links](https://example.com) and
  ~~strikethrough~~ — and while you edit, the note on the canvas shows
  the formatted result live as you type; the banner at the bottom
  holds the raw text.
- **Drop files onto the canvas:** images (PNG/JPG/GIF/WebP/BMP/SVG),
  PDFs, audio files (MP3/WAV/FLAC/OGG/M4A), video files
  (MP4/MOV/WebM/MKV/AVI), `.txt`/`.md` files (become notes — a file
  whose whole content is a colour code like `#FF6B35` becomes a swatch
  instead), and `.url`/`.webloc` shortcut files (become link preview
  cards; a video link becomes a video card). Drop several at once and
  they fan out from the drop point. Double-click empty space to start
  a note right there. Bowerbird keeps its own copy of every dropped
  file in an `assets` folder next to your board file, so deleting the
  original later never breaks the card — and boards from before this
  change get their surviving files copied in on the next launch.
- **Audio:** an audio file lands as a mini-player card — a pastel tile
  with a play button, the file name, and a waveform strip. Click the
  play button to play or pause it (the tile turns into pause bars while
  playing). It plays inside Bowerbird (rodio). If the machine has no
  audio device, pressing play says so instead of crashing.
- **Video:** a video file lands as a big preview card — a 16:9 thumb
  with a play button on top, the name below; a video link (a direct
  video file, or a YouTube/Vimeo page) pasted into the link box becomes
  a video card instead of a link card. Short video cards (made before
  this change, or resized small) keep a compact row layout instead.
  Videos play in your system video player (local files) or browser
  (links) — click the thumb to play it. Decoding video frames inside
  the canvas is a planned follow-up.
- **Links:** the link icon, type a URL, `Enter`. The card shows the
  domain immediately and fills in the page title/description in the
  background when the fetch succeeds (Open Graph title/description
  preferred, `<title>` as fallback). Double-click a link card to open
  it in your browser; double-click a PDF card (or an image) to open it
  in its viewer.
- **Long names never spill:** card text is clipped to the card — long
  file names, titles and URLs end with "…", descriptions are capped at
  two lines. Nothing ever runs onto the canvas or over a neighbour.
- **Swatches:** the swatch icon, type `#FF6B35` (or `FF6B35`, or `#F53`).
  Bad input is rejected with a message instead of creating a broken swatch.
- **PDFs:** a PDF lands as a card (name + size) and opens in your system
  viewer on double-click. Rendering PDF pages *inside* the canvas is a
  planned follow-up, not a stub that pretends otherwise.

## Project layout

```
src/
  main.rs     entry point: board window + corner handle window
  ui.rs       GPUI views (toolbar, canvas layers, cards, input bars)
  model.rs    board data + geometry: pan/zoom, hit-testing, grouping
  preview.rs  link-card domain/title/description parsing
  audio.rs    in-app audio playback (rodio) + decode probing
  store.rs    JSON persistence (write-then-rename, corrupt file never wipes)
```

Linux note: audio playback links against ALSA, so a Linux build needs
`libasound2-dev` installed (macOS uses CoreAudio and needs nothing extra).

The model, preview parsing and persistence are pure Rust with unit tests
that run without a display:

```sh
cargo test
```

## Status / roadmap

v0.1 — the core loop above, tested on Linux (build, unit tests, and a
launch under Xvfb; see the repo history for the exact check).

Next, in order: system-wide global hotkey + corner trigger on macOS,
in-canvas PDF page rendering, in-canvas video playback, note formatting
controls in the toolbar (bold/size/colour), and multi-board switching.

## License

MIT.
