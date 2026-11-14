# Bundled plugins

Plugins in this folder ship inside the app. They are listed in Settings → Plugins as "Built in" and update with the app. They use exactly the same Plugin API as user plugins, no backdoors, so a bundled plugin is also proof that the API can build that feature. See `PLUGIN_API.md` in the repo root for the API.

- **Hide Button** (`hide/`) — the corner button that hides Bowerbird into a corner, the corner picker in Settings, and H to minimise.
- **Visual Library** (`visual-library/`) — the library is the board: every board card except strokes and connectors, in board order, under a single Uncategorized section. Click to focus the original, drag to duplicate.
- **Colour Palette** (`palette/`) — a colour wheel panel. Pick a colour and five palettes are made from it live. Click or drag to place a 120×120 swatch. Placed swatches are ordinary board Swatch items, so they survive disabling the plugin.
- **Presentation** (`presentation/`) — slides are frames on the board. Draw a rectangle around cards to make a slide, then play it. Export downloads all slides as a single HTML file.
- **Multiple Boards** (`boards/`) — multiple boards, as a panel: click a board to open it, click the current board's name to rename it, × to delete it, New board to create one.
- **Command Palette** (`command-palette/`) — Cmd or Ctrl + K for one place to run anything: plugin commands, jumping to a board card, switching views, picking a tool, and core actions.
- **Tidy Up** (`tidy-up/`) — align and distribute the selected cards, from a panel. Cards only, 2 or more to align, 3 or more to distribute.
- **AI Chat** (`ai/`) — a general AI chat panel. Ask anything; when you ask for a plugin, the AI writes it and you install it from the reply. Paste your API key in Settings → Plugin settings → AI Chat (OpenAI, Ollama Cloud, Gemini, Grok, DeepSeek, Mistral or OpenRouter). The key lives in secure storage; the chat call runs in the main process.
- **Voice Notes** (`voice-notes/`) — record a voice note straight onto the board: double-click the board, type a note, and use the mic beside the text box. Transcribed on-device with Whisper; the transcript hides behind a toggle on the audio card, and the note can be renamed by double-clicking its name.

Packaging: the `scripts/package-*.sh` scripts copy this folder into the app bundle (`Contents/Resources/app/plugins/` on Mac, `resources/app/plugins/` on Windows and Linux). Running from source finds this folder via the current working directory.
