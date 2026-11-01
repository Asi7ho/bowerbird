# Bowerbird

An infinite whiteboard for creatives, built like a quick note: one window, always there, ready to drop things onto.

Drop images, notes, links, PDFs, audio, video and colours onto the board. Pan and zoom freely, sketch with a pen, connect things with lines, draw rectangles and ellipses, rotate cards, and group items that belong together. The board saves on every change, so closing it never loses anything, and it backs itself up at most once an hour, plus before a reset or a restore — see Settings → Data → Backups.

Link cards are previews only. They do not embed web pages.

## Run it

```sh
npm install
npm run dev
```

That starts the board in development mode. No Xcode is needed on a Mac to run it from source.

Do not run `npm audit fix --force`. It downgrades `@xenova/transformers` to 1.x, which depends on `canvas` — and `canvas` has no prebuilt binary for Node 26 on Mac arm64 and fails to build from source. Instead, the known vulnerabilities in transformers 2.x are fixed by the `overrides` in `package.json`: `sharp` is forced to 0.35.5 (fixing its libvips/libheif/librsvg advisories and dropping the deprecated `prebuild-install`) and `protobufjs` to 7.6.6 (fixing its critical code-execution advisory). With those overrides, `npm audit` reports 0 vulnerabilities, and `npm install` shows no deprecated-package warnings. If search ever shows "Context unavailable", it means a model failed to load — it does not mean the install is broken.

The first run opens a welcome board that explains the controls on the board itself.

Your board is one JSON file:

- Linux and macOS: `~/.local/share/bowerbird/board.json` (or `$XDG_DATA_HOME/bowerbird/board.json`)
- To use a different file: `BOWERBIRD_BOARD_PATH=/tmp/my-board.json npm run dev`
- A board left in the old `quickboard` folder is still read from there.

To build a Mac app and DMG:

```sh
./scripts/package-mac.sh
```

The build is unsigned, so a recipient must right-click it and choose Open the first time. For a demo that saves nothing, see `./scripts/demo.sh`.

## Use it

- **Pan:** hold `Space` and drag, or scroll. **Zoom:** `Ctrl` + scroll, `+` / `-`, or the toolbar buttons.
- **Shapes:** one shape button in the toolbar, with a flyout beside it to choose rectangle (R) or ellipse (E). Drag on the board to size it, in the pen colour.
- **Rotate:** drag the round handle above a selected card, or press `[` / `]` to rotate the selection by 15°. Strokes, connectors and slide frames do not rotate.
- **Note colours:** select a text note and pick a background from the colour flyout beside the toolbar. Light pastels only, so the text stays readable.
- **Boards:** the Boards plugin (on by default) lists boards in the right panel. Click a board to open it, click the current board's name to rename it, × to delete it. Main is the default board.
- **Select:** click an item, `Shift`-click to add to the selection, or drag a box around several items. Dragging one member of a group moves the whole group. Clicking a card brings it to the front.
- **Find:** `Tab` steps through elements in board order and centres each one. `Shift + Tab` steps backwards. Pen strokes and connectors are skipped.
- **Text:** double-click empty space for a new note, double-click a note to edit it. `Esc` commits, and the note renders markdown: headings, bullets, numbered lists, quotes, code blocks, bold, italic, code, links and strikethrough.
- **PDF:** a PDF card shows its pages, one at a time, with previous/next buttons and a page count. Double-click still opens it outside Bowerbird. New PDFs are dropped at a tall size so the page is readable; a short card shows a small page preview instead.
- **Pen:** drag on the canvas to sketch.
- **Connector:** drag from one item to another, or from empty space to empty space. Ends anchored to items follow them when they move.
- **Resize:** drag the small handle at a card's bottom-right corner. Connectors have no handle: move the cards they connect instead.
- **Group:** `Ctrl/Cmd + G` groups the selection, `Ctrl/Cmd + U` ungroups it.
- **Undo and redo:** `Ctrl/Cmd + Z` undoes, `Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y` redoes, or use the undo and redo buttons on the left of the top bar, next to Bowerbird. Undo covers board changes, including plugin actions and deleting all data, up to 50 steps. Panning and zooming are not undo steps, and undoing never moves the view.
- **Hide:** the button in a corner hides the whole board into that corner. Only a small round icon stays visible. Click it to restore the board. Change the corner in Settings, under Plugin settings → Hide, or turn it off there. Pressing `H` minimises the board.
- **Delete all data:** Settings → General → Data → Delete all board data. It asks you to confirm first, then removes the board file and every dropped file, and restores a fresh welcome board. The corner setting is kept. You can undo it with `Ctrl/Cmd + Z`.

Shortcuts in full are in Settings, under General.

## What you can drop

Dropped files are copied into an `assets` folder next to your board file, so deleting the original later never breaks the card. Drop several at once and they fan out from the drop point.

- Images: PNG, JPG, GIF, WebP, BMP, SVG
- PDFs: a card showing its pages, with previous/next buttons and a page count. It opens in your system viewer on double-click.
- Audio: MP3, WAV, FLAC, OGG, M4A. It plays in place, with a play button, the file name, time and a seek control.
- Video: MP4, MOV, WebM, MKV, AVI. Local MP4, WebM and M4V files play in place. Other local files and video links open outside Bowerbird.
- Text: `.txt` and `.md` files become notes. A file whose whole content is a colour code, like `#FF6B35`, becomes a swatch instead.
- Shortcuts: `.url` and `.webloc` files become link cards. A video link becomes a video card instead.

A link card shows the site's preview image when it has one, plus its title, description, icon and domain. Click the image, title or domain to open the site in your browser. A card with no preview yet just shows its domain until the fetch lands.

Long names are clipped to the card. Nothing runs onto the canvas or over a neighbour.

## Settings

Settings has three tabs: General, Plugins, and Plugin settings.

General holds the keyboard shortcuts, the canvas background and grid, and Data. Plugins turns plugins on and off. Plugin settings holds one section per plugin that is on and has settings. Each setting has a one-line description.

## Plugins

Bowerbird has plugins. The bundled ones are Hide, Visual Library, Palette, Presentation, Command Palette, Plugin Builder, which describes a plugin and has an AI write it for you to check and install, and Boards, for switching between boards. See `plugins/README.md` for what each one does, and `PLUGIN_API.md` if you want to write one.

## Icon

The icon is two black line wings, no fill, no body, on a white squircle. The source is `assets/icon.svg`. `assets/icon.png` is the 1024px export, `assets/icon.ico` is the Windows icon, and `assets/icon.iconset/` is the macOS iconset. For a packaged Mac build, generate the `.icns` on a Mac with:

```sh
iconutil -c icns assets/icon.iconset
```

## Screenshots

`screenshots/` holds five 1440×900 PNGs captured from the running app. See `screenshots/README.md` for what each one shows.

## Project layout

```
electron/   main process: window, board file, asset embedding,
            link previews, IPC
  main.js, preload.js, peek.html, dev.js
src/        renderer
  main.ts     board UI: tools, rendering, interactions, settings
  model.ts    board data, geometry, hit-testing, grouping, markdown
  plugins.ts  plugin API: discovery, panels, views, tools, cards
  welcome.ts  the welcome board
  styles.css  board styling
plugins/    bundled plugins: hide, visual-library, palette,
            presentation, command-palette (see plugins/README.md)
index.html  board shell and toolbar
assets/     welcome photo, birdsong, video, sample PDF, icon
screenshots/  App Store screenshots
```

Checks:

```sh
npx tsc --noEmit
npm run build
```

## Not yet

- No system-wide global hotkey. That needs an OS-level hook, with accessibility permission on macOS.

## License

MIT.
