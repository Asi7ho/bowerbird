# Command Palette

Press Cmd or Ctrl + K, type to search, Arrow keys to move, Enter to run, Esc to close.

It lists, in order: plugin commands, board cards to jump to, views to switch to, tools to pick, and core actions — zoom in and out, reset view, group, ungroup, delete, Open Settings, Minimise and Hide. Group only shows with two or more cards selected, Ungroup only when a selected card is grouped, Delete only with a selection, so the palette never lists an action that does nothing.

It is a bundled plugin, built on the same API as user plugins: `api.ui.listCommands` and `runCommand` for other plugins' commands, `api.ui.listTools` and `setTool` for tools, `api.view.listViews` and `setView` for views, and `api.board.groupSelected`, `ungroupSelected` and `deleteSelected` for selection actions. Cmd/Ctrl+K is not a registered shortcut — plugin shortcuts are single keys with no modifiers — so the plugin listens for it itself and removes that listener when it is disabled.
