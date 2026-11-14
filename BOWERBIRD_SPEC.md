# Bowerbird board format — the file-level contract

This is the stable shape of a Bowerbird board on disk, written down
so anything that can run a shell can read and write a board with the
app closed — an agent, a script, another editor. The app follows an
externally changed board within about two seconds (it reloads the
board file; undo history survives, the redo chain clears).

The format is versioned by this document, not by a field in the
file: a board the app wrote is a board the CLI and the spec describe.
If the shape ever changes incompatibly, this file changes first.

## Where the data lives

The board folder is found in this order:

1. `BOWERBIRD_BOARD_PATH` — a full path to a `board.json`. Board
   switching is disabled while it is set.
2. `QB_BOARD_PATH` — the same, kept for the old name.
3. Otherwise the base is `XDG_DATA_HOME` or `~/.local/share`, and
   the folder is `<base>/bowerbird`, unless that folder has no
   `board.json` and `<base>/quickboard` does — then the old folder
   wins. (On macOS the base is `~/Library/Application Support`
   via Electron's paths; on Windows it is `%APPDATA%`.)

App settings — the current board, panel order and width, the
corner — live in `settings.json` in the user-data folder
(macOS `~/Library/Application Support/bowerbird`,
Linux `~/.config/bowerbird`, Windows `%APPDATA%/bowerbird`).
`currentBoard` is a board name, or absent/null for Main.

## Layout

```
<bowerbird folder>/
  board.json                 # the Main board
  assets/                    # Main board's embedded files
  backups/                   # hourly copies of board.json, newest 10 kept
  boards/
    <sanitised name>/
      board.json
      display-name.txt       # the name as the user typed it
      assets/
      backups/
  plugins/                   # user plugins (see PLUGIN_API.md)
```

A board name is sanitised to a folder name by replacing every
character outside `[A-Za-z0-9._-]` with `_`, stripping leading dots,
and truncating to 64 characters. The display name is the folder name
unless `display-name.txt` says otherwise.

## board.json

```json
{
  "items": [ ... ],
  "camera": { "x": 0, "y": 0, "zoom": 1 },
  "next_id": 1,
  "next_group": 1,
  "bg": "#FFFFFF",
  "grid": "Dots"
}
```

- `items` — the cards, strokes and connectors, in z-order (last is
  on top). Frames (see PLUGIN_API.md) are items too.
- `camera` — the view: `x`/`y` is the world point at the top-left
  of the board area, `zoom` is clamped to 0.1–8.
- `next_id` / `next_group` — the last issued item id and group id.
  The next free id is `next_id + 1`: the app allocates by
  bumping first. A writer that adds items must take
  `max(next_id, highest item id) + 1` as the new id and set
  `next_id` to it; a writer that groups takes `next_group + 1`
  and sets `next_group` to it.
- `bg` — the canvas background colour. `grid` is `Dots`, `Lines`
  or `None`.
- Unknown top-level fields are carried through load and save
  verbatim by the app — but the CLI only writes the fields above.

An item:

```json
{ "id": 3, "pos": { "x": 120, "y": 80 }, "size": { "w": 320, "h": 120 },
  "group": null, "kind": { "Text": { "text": "Hello", "bold": false, "size": 16, "color": "#1A1A1A" } } }
```

- `id` — unique within the board. `pos`/`size` are in world
  coordinates. `group` is a group id, or null. `rotation` is
  optional, degrees clockwise around the item centre; missing
  means 0. Connectors never carry it, and frames never rotate.
- `kind` is an externally-tagged enum — exactly one key:

| Kind | Fields |
| --- | --- |
| `Text` | `text`, `bold`, `size`, `color`, `bg?` |
| `Shape` | `shape` (`rect`, `ellipse`, `triangle`, `diamond`, `hexagon`, `star`, `arrow`), `fill` |
| `Image` | `path` |
| `UrlCard` | `url`, `title` (null), `description` (null), `image?`, `icon?`, `embed?` |
| `PdfCard` | `path`, `size_bytes` |
| `Swatch` | `hex` |
| `Audio` | `path`, `transcript?` (the on-device speech-to-text of a voice recording, when it has one) |
| `Video` | `source`, `remote` (bool), `size_bytes` |
| `Stroke` | `points` (`[{x, y}]`), `color`, `width`, `marker` (bool), `pressures?` |
| `Connector` | `from`, `to` (each `{"Item": id}` or `{"Point": {"x","y"}}`), `color` |
| `Plugin` | `plugin`, `kind`, `data` (any JSON) |

Media `path` / `source` values are absolute paths to files in the
board's own `assets/` folder — the app copies dropped and pasted
files there (deduplicating the name: `name`, `name-1`, `name-2`…).
An agent adding media must copy the file into `assets/` first and
store that absolute path. Moving a board folder by hand breaks
absolute media paths; that is a known limitation, not a supported
move — use the app's board folder, or fix the paths up.

Plugin cards are namespaced: the core never reads `data`, and a
missing or disabled plugin renders a placeholder while carrying
`data` through verbatim — uninstalling a plugin never deletes its
cards' data. An agent should not invent `plugin`/`kind` values it
does not know.

## Writing a board

- Read the file, change it, write it back through a temporary file
  in the same folder followed by a rename — never a partial
  in-place write. The app reads the file on change, so a torn
  write is a corrupted board.
- Keep `next_id` ahead of every item id. Keep every id unique.
- A writer that changes a board the app has open does not need
  to tell the app: the app watches the file and reloads it.
- Backups are the app's hourly copies of `board.json` in
  `backups/` (newest 10 kept). A writer should not touch them.

## The CLI (`cli/bowerbird.mjs`)

Plain Node, no dependencies. Run it from the repo root:

```
node cli/bowerbird.mjs <command> [options]
```

Output is JSON on stdout by default; `--human` prints readable
lines instead. Errors print `{"ok": false, "error": "..."}` to
stderr. Exit codes: `0` ok, `1` usage error, `2` board or card not
found, `3` write failed.

| Command | What it does |
| --- | --- |
| `boards` | List boards: name, whether it is current, item count. |
| `cards [--board NAME]` | List cards on a board: id, kind, title, position, size, group. |
| `add-card --board NAME --text "..." [--x N] [--y N] [--w N] [--h N]` | Add a text note. `--dry-run` prints the board that would be written and writes nothing. |

`--board` defaults to the current board (from settings.json), or
Main when there is none. A board that does not exist is exit 2.
