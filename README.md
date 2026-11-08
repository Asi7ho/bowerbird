# Bowerbird

An infinite whiteboard for creatives. One window, always there, ready to drop things onto.

Drop images, notes, links, PDFs, audio, video and colours onto the board. Pan and zoom freely, sketch with a pen, connect things with lines, draw shapes, rotate cards and strokes, and group items that belong together. The board saves on every change, and backs itself up at most once an hour.

Link cards are previews only. They do not embed web pages.

## Run it

```sh
npm install
npm run dev
```

No Xcode is needed on a Mac to run it from source. The first run opens a welcome board that explains the controls on the board itself.

Your board is one JSON file: `~/.local/share/bowerbird/board.json` (or `$XDG_DATA_HOME/bowerbird/board.json`). To use a different file: `BOWERBIRD_BOARD_PATH=/tmp/my-board.json npm run dev`. A board left in the old `quickboard` folder is still read from there.

Do not run `npm audit fix --force`. It downgrades `@xenova/transformers` to 1.x, which needs `canvas`, and `canvas` has no prebuilt binary for Node 26 on Mac arm64. The `overrides` in `package.json` already fix the known vulnerabilities (`sharp` 0.35.5, `protobufjs` 7.6.6), so `npm audit` reports 0.

## Package it

```sh
./scripts/package-mac.sh      # macOS DMG
./scripts/package-win.sh      # Windows zip
./scripts/package-linux.sh    # Linux tarball
```

Or push a version tag (`v0.2.2`) and the release workflow builds all three and attaches them to a GitHub Release. The builds are unsigned, so a recipient must right-click the app and choose Open the first time (macOS) or accept the SmartScreen warning (Windows).

## Use it

- **Pan:** hold `Space` and drag, or scroll. **Zoom:** `Ctrl` + scroll, `+` / `-`, or the toolbar buttons.
- **Text:** double-click empty space for a new note, double-click a note to edit it. `Esc` commits. Notes render markdown.
- **Pen:** drag on the canvas to sketch. **Connector:** drag from one item to another. Ends anchored to items follow them.
- **Shapes:** one shape button in the toolbar, with a flyout to choose rectangle (R), ellipse (E), triangle, diamond, hexagon, star, or block arrow. Drag on the board to size it.
- **Rotate:** drag the round handle above a selected card or stroke, or `[` / `]` for 15°. Connectors and slide frames do not rotate.
- **Select:** click an item, `Shift`-click to add, or drag a box around several. Dragging one member of a group moves the whole group.
- **Find:** `Tab` steps through elements in board order and centres each one. `Shift + Tab` steps backwards.
- **Group:** `Ctrl/Cmd + G` groups, `Ctrl/Cmd + U` ungroups.
- **Undo and redo:** `Ctrl/Cmd + Z` undoes, `Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y` redoes, up to 50 steps. Panning and zooming are not undo steps.
- **Hide:** the button in a corner hides the whole board into that corner. Only a small round icon stays visible. Click it to restore. Change the corner in Settings, under Plugin settings → Hide Button. `H` minimises.
- **Factory reset:** Settings → General → Data → Factory reset. It wipes boards, settings, plugins and keys, and cannot be undone.

Shortcuts in full are in Settings, under General.

## What you can drop

Dropped files are copied into an `assets` folder next to your board file, so deleting the original later never breaks the card. Drop several at once and they fan out from the drop point.

- Images: PNG, JPG, GIF, WebP, BMP, SVG
- PDFs: a card showing its pages, with previous/next buttons. Double-click opens it outside Bowerbird.
- Audio: MP3, WAV, FLAC, OGG, M4A. Plays in place.
- Video: MP4, MOV, WebM, MKV, AVI. Local MP4, WebM and M4V play in place; the rest open outside.
- Text: `.txt` and `.md` files become notes. A file whose whole content is a colour code, like `#FF6B35`, becomes a swatch.
- Shortcuts: `.url` and `.webloc` files become link cards. A video link becomes a video card.

A link card shows the site's preview image, title, description, icon and domain. Click it to open the site in your browser.

## Settings

Three tabs: General, Plugins, and Plugin settings.

General holds the keyboard shortcuts, the canvas background and grid, data, backups, and feedback. Plugins turns plugins on and off. Plugin settings holds one section per plugin that is on and has settings.

## Plugins

Bowerbird has plugins. The bundled ones are AI Chat, Boards, Command Palette, Hide Button, Colour Palette, Presentation, Tidy Up, and Visual Library. They are off by default — enable them in Settings → Plugins. See `plugins/README.md` for what each one does, and `PLUGIN_API.md` if you want to write one.

## Layout

```
electron/   main process: window, board file, asset embedding,
            link previews, IPC (TypeScript, compiled to electron-dist/)
src/        renderer: board UI, model, plugin host and API
  core-plugins/  first-party UI plugins (Settings, board, toolbar),
              built on the same plugin API as user plugins
plugins/    bundled plugins (see plugins/README.md)
index.html  board shell
assets/     welcome photo, birdsong, video, sample PDF, icon
```

Checks:

```sh
npx tsc --noEmit
npm run build
```

## License

MIT.
