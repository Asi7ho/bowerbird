// Visual Library — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// There is no special library folder and no separate library
// file store. The library IS the board: it shows the board's
// own elements — every card on the whiteboard, in both modes —
// rendered by the core itself (api.board.renderCard), so a
// library card is the same card as on the board, at the same
// aspect ratio (the board item's width/height, not the file's
// natural ratio, not a thumbnail ratio). The card is scaled
// uniformly to its masonry column width, so its shape never
// changes, only its size.
//
//  - Panel mode: a panel in the right dock, flush against the
//    window edge, full height, over the board. One column, so
//    board cards stay readable in the narrow panel.
//  - Whiteboard mode: a view replacing the canvas, laid out
//    like Pinterest, several columns wide.
// The search box is shared, and the mode switch is a single
// icon button beside it (masonry icon for whiteboard, sidebar
// icon for panel).
//
// Categories are user-created: Uncategorized holds every
// board item in board order by default, and the user adds
// named categories and drags cards into them. Dragging a
// card onto a category section moves it there; dragging it
// onto the board duplicates it, as it always did.
//
// Clicking a library card focuses the original on the
// board: it centres on it and selects it, and adds nothing.
// Dragging it duplicates it at the drop point (panel mode:
// onto the visible board; whiteboard mode: at the drop
// point in camera coordinates, with a toast, since the
// board is hidden). The duplicate is an ordinary board
// item of the same kind and the same size as the original,
// so it appears in the library too — it is a board
// element. Media previews are the only interactions that
// do neither: a video's native controls play in place,
// and an audio tile plays in place.
//
// Strokes and connectors are not library elements: they are
// drawing and annotation, not cards, and duplicating them
// would need their board positions and item references. The
// library refreshes automatically when the board is saved, and
// the Refresh command still exists in Settings → Plugins for
// a manual refresh.
//
// The plugin is five files, like a first-party plugin:
// items.ts owns the board data and search, audio.ts the
// audio preview, interactions.ts what happens to a card,
// render.ts the panel and view surfaces. main.ts is the
// entry point that wires them together.
import type { PluginContext } from "../../src/plugins";
import { loadCategories, syncFromBoard } from "./items.js";
import { stopLibraryAudio } from "./audio.js";
import { buildView, clearPanelRefs, disconnectPanelObservers, getViewSections, initPanel, isViewBuilt, renderSections, updateAllDynamic, updateSelectionHighlight, viewContainerClear } from "./render.js";

let apiRef: PluginContext | null = null;
let onBoardHandler: (() => void) | null = null;
let onSelectionHandler: (() => void) | null = null;
let resizeHandler: (() => void) | null = null;

export async function activate(api: PluginContext): Promise<void> {
  apiRef = api;
  await loadCategories(api);
  onBoardHandler = () => { if (syncFromBoard(api, false)) updateAllDynamic(api); };
  api.events.on("board", onBoardHandler);
  onSelectionHandler = () => updateSelectionHighlight(api);
  api.events.on("selection", onSelectionHandler);
  resizeHandler = () => {
    const vs = getViewSections();
    if (vs) renderSections(api, vs, "view");
  };
  window.addEventListener("resize", resizeHandler);
  api.ui.registerPanel({
    id: "library",
    title: "Visual Library",
    // Masonry grid, as the panel's own mode icon: a tall
    // card on the left, two short cards on the right.
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="4" width="7" height="16" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
    render: (container) => initPanel(api, container),
  });
  api.ui.registerView({
    id: "library",
    title: "Visual Library",
    render: (container) => {
      // Core re-renders the active view on every board render;
      // sync only when the board's cards actually changed, so
      // scrolling the library is not interrupted by a move.
      if (!isViewBuilt()) {
        buildView(api, container);
      } else if (syncFromBoard(api, false)) {
        updateAllDynamic(api);
      }
    },
    onShow: () => {
      // The view replaces the canvas, and the panel would cover
      // its right-hand columns, including the mode icon itself,
      // so hide the panel while the view is active.
      api.ui.hidePanel("library");
      // The panel dock collapses when the panel hides, so the
      // board (and the view inside it) widens by the panel's
      // 290px: the view must be laid out again at the new,
      // wider width, not kept at the narrower layout render()
      // built before the panel hid. Force it, even when the
      // board itself is unchanged.
      if (isViewBuilt() && getViewSections() && syncFromBoard(api, true)) updateAllDynamic(api);
    },
    onHide: () => {
      // Show first, then clear. showPanel re-renders the
      // board, and that render refreshes the active view:
      // if the view were already cleared, that refresh would
      // rebuild it in a container about to be emptied, leaving
      // a stale built flag and a detached sections element,
      // so the next view activation showed an empty white
      // view. Showing first means the refresh sees the old,
      // still-valid view and skips it, and the clear that
      // follows leaves a clean state for the next activation.
      if (apiRef) apiRef.ui.showPanel("library");
      viewContainerClear();
      // The panel is visible again at its fixed 290px, so the
      // board narrowed back: re-lay the panel at its real
      // width, in case it was re-rendered while hidden (width
      // 0) during the view, before it is seen again.
      if (apiRef && syncFromBoard(apiRef, true)) updateAllDynamic(apiRef);
    },
  });
}

export function deactivate(): void {
  stopLibraryAudio();
  if (apiRef && onBoardHandler) apiRef.events.off("board", onBoardHandler);
  if (apiRef && onSelectionHandler) apiRef.events.off("selection", onSelectionHandler);
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  disconnectPanelObservers();
  onBoardHandler = null;
  onSelectionHandler = null;
  resizeHandler = null;
  clearPanelRefs();
  viewContainerClear();
  apiRef = null;
}
