# Visual Library

Bundled plugin. A panel over a library folder on disk
(`board/library/`, temp folder in demo).

- Drop images (jpg, png, gif, webp) and PDFs into the library
  folder, then Refresh in the panel — or click Open folder to
  open it in Finder/Explorer.
- Search by filename in the panel's search box.
- Click an item to place it at the camera centre, or drag it
  onto the board to place it at the drop point. Either way it
  becomes an ordinary Image or PDF card, board-owned, not a
  plugin card.
- Select an image or PDF card on the board and click "Add
  selected to library" to copy it back into the library.

API used: `api.ui.registerPanel`, `api.ui.registerCommand`,
`api.files.listLibrary`, `api.files.addToLibrary`,
`api.files.embedFile`, `api.files.fileUrl`, `api.files.fileSize`,
`api.files.openExternal`, `api.board.addItem`,
`api.board.getItems`, `api.board.getSelected`, `api.view.getCamera`,
`api.events`.
