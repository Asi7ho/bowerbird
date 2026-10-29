# Bowerbird

A quick-reveal infinite whiteboard for creatives — the "quick note" idea,
but for a canvas instead of a note.

Drop raw images, text snippets, web links, PDFs, audio, video and colour swatches straight
onto an infinite board. Pan and zoom freely, sketch with a pen,
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

On macOS, full Xcode is required — the command-line tools alone are
not enough. GPUI compiles its Metal shaders at build time with
`xcrun metal`, and that tool ships with Xcode. With only the
command-line tools selected, the build fails with `xcrun: error:
unable to find utility "metal"`. Fix:

```sh
# If Xcode is already installed but the command-line tools are selected:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
# Otherwise install Xcode from the App Store first, then run the line above.
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch
xcrun -find metal   # should print a path inside Xcode.app
cargo clean -p gpui # drop the failed build-script output
cargo run
```

No other setup: the first run opens a welcome board that explains the
controls on the canvas itself.

Your board is stored as one JSON file and auto-saved on every change:

- Linux: `~/.local/share/bowerbird/board.json` (or `$XDG_DATA_HOME/bowerbird/board.json`)
- macOS: `~/.local/share/bowerbird/board.json`
- Override for testing/portability: `BOWERBIRD_BOARD_PATH=/tmp/my-board.json cargo run`
- A board left in the pre-rename `quickboard` folder is still read from there.

## How the "quick reveal" works in v0.1

One window, always alive: the board itself. Pressing `h` while the
board is focused minimises it; it stays alive in the Dock / taskbar,
which is what brings it back. There is no second handle window.

- **Minimal toolbar:** exactly four controls — Select, Pen, Arrow
  (connectors), Delete — plus the pen palette, which appears only
  while Pen is active. Delete is dimmed while nothing is selected.
  Icons are drawn vectors, not emoji, so they look the same on every
  platform. The accent throughout is macOS blue; on a Mac the
  interface also picks up the system font and native window controls.
- **In-app hotkeys:** `V` select, `P` pen, `A` arrow, `Ctrl/Cmd+G`
  group, `Ctrl/Cmd+U` ungroup, `Delete` removes the selection,
  `+`/`-` zoom, `0` resets the view, hold `Space` to pan, `h` hides.
  There is no add menu: adding is drag and drop (see below), plus
  double-clicking empty space for a note.

What is *not* faked: a system-wide global hotkey that fires while another
app is focused, and a macOS screen-corner swipe, both need OS-level hooks
(CGEventTap / accessibility permission on macOS, a global key grabber on
Linux). Those are the next step, not something v0.1 pretends to do.

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
  `Ctrl` + scroll (keeps the point under the cursor fixed), or `+`/`-`.
  Nothing on the board ever paints over the toolbar: cards panned
  above the top edge clip at it.
- **Select:** click an item, `Shift`-click to add to the selection, or drag
  a marquee around several items. Dragging one member of a group moves the
  whole group. `Ctrl/Cmd+G` groups the selection.
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
  text with a blinking cursor, no input bar anywhere. `Enter` is a new
  line, `Esc` (or a click elsewhere) commits, and the note renders
  markdown automatically once committed — `#` headings, `-` bullets,
  `1.` lists, `>` quotes, fenced code blocks, and inline **bold**,
  *italic*, `code`, [links](https://example.com) and ~~strikethrough~~.
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
  with a play button on top, the name below; a video link dropped as a
  `.url`/`.webloc` file becomes a video card instead of a link card.
  Short video cards (made before this change, or resized small) keep a
  compact row layout instead.
  Videos play in your system video player (local files) or browser
  (links) — click the thumb to play it. Decoding video frames inside
  the canvas is a planned follow-up.
- **Links:** drop a `.url`/`.webloc` shortcut file (or any link — see
  below) and the card shows the domain immediately, filling in the
  page title/description in the background when the fetch succeeds
  (Open Graph title/description preferred, `<title>` as fallback).
  Double-click a link card to open it in your browser; double-click a
  PDF card (or an image) to open it in its viewer.
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
src/
  main.rs     entry point: the single board window
  ui.rs       GPUI views (toolbar, canvas layers, cards)
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
