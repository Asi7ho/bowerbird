# QuickBoard

A quick-reveal infinite whiteboard for creatives — the "quick note" idea,
but for a canvas instead of a note.

Drop raw images, text snippets, web links, PDFs and colour swatches straight
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

- Linux: `~/.local/share/quickboard/board.json` (or `$XDG_DATA_HOME/quickboard/board.json`)
- macOS: `~/.local/share/quickboard/board.json`
- Override for testing/portability: `QB_BOARD_PATH=/tmp/my-board.json cargo run`

## How the "quick reveal" works in v0.1

- **Desktop handle:** a small dark `▦ QuickBoard` pill sits in the
  top-right corner of the primary display, above other apps. Click it and
  the board comes forward.
- **Hide:** the board toolbar's eye icon, or pressing `h` while the
  board is focused, minimises the board back to just the handle.
  The toolbar is icons only (the status bar names the active tool);
  icons are drawn vectors, not emoji, so they look the same on every
  platform.
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

- **Pan:** drag with the Pan tool, hold `Space` and drag, or scroll without
  Ctrl. **Zoom:** `Ctrl` + scroll (keeps the point under the cursor fixed),
  or `+`/`-`.
- **Select:** click an item, `Shift`-click to add to the selection, or drag
  a marquee around several items. Dragging one member of a group moves the
  whole group. `Ctrl/Cmd+G` groups the selection.
- **Pen / Marker:** drag on the canvas. Marker is thicker and translucent.
- **Connector:** drag from one item to another (or from empty space to
  empty space). Endpoints anchored to items follow them when they move.
- **Text:** `T` then click, or the note icon in the toolbar, type,
  `Enter` for a new line, `Esc` to finish. Double-click a note to edit
  it again. Bold/size editing for notes is in the toolbar's next pass;
  notes are plain or bold in the model already.
- **Drop files onto the canvas:** images (PNG/JPG/GIF/WebP/BMP/SVG),
  PDFs, and `.txt`/`.md` files become board items at the drop point.
  You can also use the image / PDF icons and type or paste a file path.
- **Links:** the link icon, type a URL, `Enter`. The card shows the
  domain immediately and fills in the page title/description in the
  background when the fetch succeeds. Double-click a link card to open
  it in your browser; double-click a PDF card (or an image) to open it
  in its viewer.
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
  store.rs    JSON persistence (write-then-rename, corrupt file never wipes)
```

The model, preview parsing and persistence are pure Rust with unit tests
that run without a display:

```sh
cargo test
```

## Status / roadmap

v0.1 — the core loop above, tested on Linux (build, unit tests, and a
launch under Xvfb; see the repo history for the exact check).

Next, in order: system-wide global hotkey + corner trigger on macOS,
in-canvas PDF page rendering, note formatting controls in the toolbar
(bold/size/colour), and multi-board switching.

## License

MIT.
