# Visual Library

Bundled plugin. The library is the board, not a folder on disk.

- Every board card except strokes and connectors, in board order, under a single Uncategorized section. Slide frames are not shown.
- Search by the card's text or file name.
- Click an item to duplicate it at the camera centre, or drag it onto the board to duplicate it at the drop point. A duplicate is an ordinary board item of the same kind and size, so it appears in the library too.
- In the panel, the cards are shown at board size, never upscaled beyond it, packed in masonry with 16px gaps.
- In the view, the same cards are shown as a masonry board, full width. The view hides the panel while it is active and shows it again on the way back to the board.
- Video and audio play in place. Link clicks duplicate, they do not open the site.

The library refreshes automatically when the board is saved. There is no Refresh button, no folder to manage, and no library folder.

API used: `api.ui.registerPanel`, `api.ui.registerView`, `api.board.renderCard`, `api.board.addItem`, `api.board.getItems`, `api.view.getCamera`, `api.events`.
