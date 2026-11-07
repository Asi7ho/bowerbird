// Presentation — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Slides are frames, not cards. A slide is a rectangle on
// the board, drawn by the user, and everything inside it
// is the slide. On the board a slide shows only its border
// — a transparent dashed frame with a "Slide N" label —
// so the cards inside it stay visible and editable, exactly
// as they are on the board. Move a card into a frame and
// it joins that slide; move it out and it leaves it. There
// is no separate slide list to keep in sync with the board,
// and no slide content stored anywhere but the board itself.
//
// How a slide is made: in the panel, "Draw a slide" puts
// the board into draw mode (Esc or Cancel leaves it), and
// dragging a rectangle on the board creates a slide frame
// around whatever is inside it. Or draw a frame first,
// then put cards in it — both orders work, because a
// slide is defined by what is inside its rectangle at
// play time, not by a list made when it was drawn.
//
// What plays: the panel's Play button, a slide row's play
// button, or double-clicking a frame on the board. Slides
// play in frame board order, and a new frame always goes
// last, so creating slides in presentation order is
// creating them in play order. The panel's up and down
// buttons move a frame in board order to reorder it.
// Clicking a frame to move it never reorders its slides:
// core never brings a frame to the front, so frame order
// only changes when a frame is created, deleted or moved
// with those buttons.
//
// What a slide looks like when played: almost a
// screenshot of the frame area, scaled uniformly to fit
// the stage. Every card that overlaps the frame at all,
// every pen stroke that enters it, and every connector
// segment that enters it, in their board positions
// relative to the frame, cropped to the frame, with
// drawing under cards as on the board. A card that
// straddles the border shows only the part inside — a
// swatch top, a pen circle behind a photo, a connector
// segment to the frame edge — so resize the frame to
// include a card fully if you want it whole, or to
// exclude it fully if you do not want a strip of it.
// Frames inside frames are not content — they are their
// own slides. The slide background is plain white, not
// the board's dot grid, so the slide stays clean.
//
// What works inside a slide: a video's native controls
// play in place, and an audio card plays in place through
// the plugin's own player (the core's player belongs to
// the board, which is hidden). A link card opens its URL
// outside the app. Clicking anywhere else on a slide does
// nothing — it does not advance, duplicate or edit — so
// interacting with media never moves you on by accident.
// Plugin cards show as they do on the board, but their
// buttons do not run in presentation; they run on the
// board.
//
// Panels, the toolbar and the view switcher stay where
// the user left them: this plugin hides nothing but the
// board itself. For a clean full-width presentation, hide
// the dock first with the panels toggle in the title bar.
//
// Keyboard, while presenting: left and right arrows move,
// Space moves forward, Esc returns to the board. Tab,
// Delete and the board editing keys (tools, zoom, group)
// are blocked while presenting, because the board is
// hidden and those actions would act on invisible cards.
// Other keys pass through, so ? still opens Settings
// and H still hides the app. Typing in the search box or
// a text field is never hijacked.
//
// The plugin is seven files, like a first-party plugin:
// state.ts owns the shared state, geometry.ts the slide
// geometry and membership, view.ts playing a slide,
// panel.ts the slide list, export.ts the HTML export,
// draw.ts draw mode. main.ts is the entry point that
// wires them together.
import type { PluginContext } from "../../src/plugins";
import { getApi, state } from "./state.js";
import { isFrameItem } from "./geometry.js";
import { buildView, onKeyDown, renderSlide, startPresentation, stopPresentationAudio, syncFromBoard, viewContainerClear } from "./view.js";
import { initPanel, updatePanel } from "./panel.js";
import { cancelDrawMode, initOverlay } from "./draw.js";

// ---- Lifecycle --------------------------------------------------------
export function activate(api: PluginContext): void {
  state.api = api;
  const onBoardHandler = (): void => { syncFromBoard(false); };
  state.onBoardHandler = onBoardHandler;
  api.events.on("board", onBoardHandler);
  const onViewHandler = (): void => {
    // Switching away from the board — for example, via
    // the view switcher while drawing — must not leave
    // the draw layer over a view, with its instruction
    // bar saying "Drag to draw" over a slide.
    if (state.api && state.api.view.getView() !== "board") cancelDrawMode();
  };
  state.onViewHandler = onViewHandler;
  api.events.on("view", onViewHandler);
  const resizeHandler = (): void => {
    if (state.viewBuilt) renderSlide();
  };
  state.resizeHandler = resizeHandler;
  window.addEventListener("resize", resizeHandler);
  api.cards.register({
    kind: "slide",
    title: "Slide",
    frame: true,
    render: (item) => {
      // The slide number is its position among frames in
      // board order, computed at render time, not stored,
      // so deleting a frame renumbers the rest correctly.
      let number = "";
      if (state.api) {
        const frames = state.api.board.getItems().filter(isFrameItem);
        const idx = frames.findIndex((f) => f.id === item.id);
        if (idx >= 0) number = ` ${idx + 1}`;
      }
      return `<div class="pres-slide-label">Slide${number}</div>`;
    },
    onDoubleClick: (item) => {
      const frames = getApi().board.getItems().filter(isFrameItem);
      const idx = frames.findIndex((f) => f.id === item.id);
      startPresentation(idx >= 0 ? idx : 0);
    },
    searchText: () => "Slide",
  });
  api.ui.registerPanel({
    id: "slides",
    title: "Presentation",
    // A screen with a play triangle, as the panel's own
    // Play button is: a slide, played.
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 9l4 2-4 2z" fill="currentColor" stroke="none"/></svg>',
    render: (container) => initPanel(container),
  });
  api.ui.registerView({
    id: "presentation",
    title: "Presentation",
    render: (container) => {
      // Core re-renders the active view on every board
      // render; sync only when the board's slides actually
      // changed, so a slide is not rebuilt — and a video
      // restarted — on every move.
      if (!state.viewBuilt) {
        buildView(container);
      } else {
        syncFromBoard(false);
      }
    },
    onShow: () => {
      window.addEventListener("keydown", onKeyDown, true);
      // A presentation always starts where it was asked
      // to start: first slide from Play or the view
      // switcher, or the slide that was double-clicked
      // or chosen in the panel. This runs after the
      // view's first render, in the same tick, so no
      // intermediate slide is painted.
      if (state.pendingStartIndex !== null) {
        state.index = Math.max(0, Math.min(state.slides.length - 1, state.pendingStartIndex));
        state.pendingStartIndex = null;
      } else {
        state.index = 0;
      }
      if (state.viewBuilt) renderSlide();
      if (state.panelList) updatePanel();
    },
    onHide: () => {
      window.removeEventListener("keydown", onKeyDown, true);
      stopPresentationAudio();
      cancelDrawMode();
      viewContainerClear();
    },
  });
  api.ui.registerOverlay({
    id: "draw-slide",
    render: (container) => initOverlay(container),
  });
}

export function deactivate(): void {
  window.removeEventListener("keydown", onKeyDown, true);
  cancelDrawMode();
  stopPresentationAudio();
  const api = state.api;
  const onBoardHandler = state.onBoardHandler;
  const onViewHandler = state.onViewHandler;
  const resizeHandler = state.resizeHandler;
  if (api && onBoardHandler) api.events.off("board", onBoardHandler);
  if (api && onViewHandler) api.events.off("view", onViewHandler);
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  state.onBoardHandler = null;
  state.onViewHandler = null;
  state.resizeHandler = null;
  state.panelList = null;
  state.panelPlayBtn = null;
  state.panelExportBtn = null;
  state.drawLayer = null;
  state.drawInstruction = null;
  state.drawPreview = null;
  viewContainerClear();
  state.api = null;
}
