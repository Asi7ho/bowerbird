# Bundled plugins

Plugins in this folder ship inside the app. They are listed in
Settings → Plugins as "Built in" and update with the app. They
use exactly the same Plugin API as user plugins, no backdoors,
so a bundled plugin is also proof that the API can build that
feature. See `PLUGIN_API.md` in the repo root for the API.

They are written in TypeScript: each one is a `main.ts` entry
point plus its own modules. The app compiles them when it loads
— there is no build step, and the `.ts` is the source. A
plugin's modules import the API types only (`import type {
PluginContext } from "../../src/plugins"`), so the compiled
JavaScript never depends on the core's source at runtime.
`npm run typecheck:plugins` type-checks them.

- `hide/` — the corner button that hides Bowerbird into a
  corner, the corner picker in Settings, and H to minimise.
- `visual-library/` — the library is the board: every board
  card except strokes and connectors, in board order, under a
  single Uncategorized section. Click to focus the original,
  drag to duplicate.
- `palette/` — a colour wheel panel. Pick a colour and five
  palettes are made from it live. Click or drag to place a
  120×120 swatch. Placed swatches are ordinary board Swatch
  items, so they survive disabling the plugin.
- `presentation/` — slides are frames on the board. Draw a
  rectangle around cards to make a slide, then play it. Export
  downloads all slides as a single HTML file.
- `boards/` — multiple boards, as a panel: click a board to
  open it, click the current board's name to rename it, × to
  delete it, New board to create one.
- `command-palette/` — Cmd or Ctrl + K for one place to run
  anything: plugin commands, jumping to a board card, switching
  views, picking a tool, and core actions.
- `tidy-up/` — align and distribute the selected cards, from a
  panel. Cards only, 2 or more to align, 3 or more to distribute.
- `ai/` — a general AI chat panel. Ask anything; when you ask
  for a plugin, the AI writes it and you install it from the
  reply. Paste your API key in Settings → Plugin settings → AI
  Chat (OpenAI, Ollama Cloud, Gemini, Grok, DeepSeek, Mistral
  or OpenRouter). The key lives in secure storage; the chat call
  runs in the main process.

Packaging: `scripts/package-mac.sh` copies this folder into the
app bundle (`Contents/Resources/app/plugins/`). Running from
source finds this folder via the current working directory.
