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

Your board is one JSON file: `~/.local/share/bowerbird/board.json` (or `$XDG_DATA_HOME/bowerbird/board.json`). To use a different file: `BOWERBIRD_BOARD_PATH=/tmp/my-board.json npm run dev`.

Do not run `npm audit fix --force`. It downgrades `@xenova/transformers` to 1.x, which needs `canvas`, and `canvas` has no prebuilt binary for Node 26 on Mac arm64. The `overrides` in `package.json` already fix the known vulnerabilities, so `npm audit` reports 0.

## Package it

```sh
./scripts/package-mac.sh      # macOS DMG
./scripts/package-win.sh      # Windows zip
./scripts/package-linux.sh    # Linux tarball
```

Or push a version tag (`v0.2.2`) and the release workflow builds all three and attaches them to a GitHub Release. The builds are unsigned, so a recipient must right-click the app and choose Open the first time (macOS) or accept the SmartScreen warning (Windows).

## Docs

- `PLUGIN_API.md` — how to write a plugin.
- `ARCHITECTURE.md` — core as API, all GUI as plugins.
- `plugins/README.md` — the bundled plugins.

## Layout

```
electron/          main process (TypeScript, compiled to electron-dist/)
src/               renderer: board UI, model, plugin host and API
src/core-plugins/  first-party UI plugins
plugins/           bundled plugins
index.html         board shell
assets/            welcome media and icon
```

Checks:

```sh
npx tsc --noEmit
npm run build
```

## License

MIT.
