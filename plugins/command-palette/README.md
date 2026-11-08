# Command Palette

Press Cmd or Ctrl + K, type to search, Arrow keys to move, Enter to run, Esc to close.

It lists, in order: plugin commands, board cards to jump to, views to switch to, tools to pick, and core actions — zoom in and out, reset view, undo, redo, group, ungroup, delete, Open Settings, Minimise and Hide. Undo and Redo only show when they can do something, as do Group (two or more cards selected), Ungroup (a selected card is grouped) and Delete (a selection), so the palette never lists an action that does nothing.

It is a bundled plugin, built on the same API as user plugins. Cmd/Ctrl+K is not a registered shortcut — plugin shortcuts are single keys with no modifiers — so the plugin listens for it itself and removes that listener when it is disabled.
