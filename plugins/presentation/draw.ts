// Presentation — draw mode. The overlay that turns the board
// into a rectangle-drawing surface: drag a rectangle and a
// slide frame is created around whatever is inside it. Esc or
// Cancel leaves draw mode; a click without a drag creates
// nothing and stays in draw mode.
import { getApi, state } from "./state.js";

// ---- Draw mode --------------------------------------------------------

function boardGeometry(): { w: number; h: number; left: number; top: number } {
  const el = document.getElementById("board");
  if (!el) return { w: window.innerWidth, h: window.innerHeight, left: 0, top: 0 };
  const r = el.getBoundingClientRect();
  return { w: el.clientWidth, h: el.clientHeight, left: r.left, top: r.top };
}

export function cancelDrawMode(): void {
  if (!state.drawActive) return;
  state.drawActive = false;
  state.drawStart = null;
  state.drawMoved = false;
  if (state.drawLayer) state.drawLayer.style.display = "none";
  if (state.drawInstruction) state.drawInstruction.style.display = "none";
  if (state.drawPreview) state.drawPreview.style.display = "none";
  if (state.drawKeyHandler) window.removeEventListener("keydown", state.drawKeyHandler, true);
}

export function startDrawMode(): void {
  const api = state.api;
  if (!api) return;
  // Frames are drawn on the board, not on a slide, so
  // drawing always returns to the board first.
  if (api.view.getView() !== "board") api.view.setView("board");
  if (!state.drawLayer || !state.drawInstruction) return;
  state.drawActive = true;
  state.drawStart = null;
  state.drawMoved = false;
  state.drawLayer.style.display = "block";
  state.drawInstruction.style.display = "flex";
  if (state.drawPreview) state.drawPreview.style.display = "none";
  if (!state.drawKeyHandler) {
    state.drawKeyHandler = (e: KeyboardEvent) => {
      if (!state.drawActive) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelDrawMode();
      }
    };
  }
  window.addEventListener("keydown", state.drawKeyHandler, true);
}

export function initOverlay(container: HTMLElement): void {
  const drawLayer = document.createElement("div");
  drawLayer.className = "pres-draw-layer";
  drawLayer.style.display = "none";
  const drawPreview = document.createElement("div");
  drawPreview.className = "pres-draw-preview";
  drawPreview.style.display = "none";
  drawLayer.appendChild(drawPreview);
  container.appendChild(drawLayer);
  const drawInstruction = document.createElement("div");
  drawInstruction.className = "pres-draw-instruction";
  drawInstruction.style.display = "none";
  const text = document.createElement("span");
  text.textContent = "Drag to draw a slide";
  const cancel = document.createElement("button");
  cancel.className = "pres-draw-cancel";
  cancel.textContent = "Cancel";
  cancel.title = "Cancel drawing (Esc)";
  cancel.setAttribute("aria-label", "Cancel drawing");
  cancel.addEventListener("click", () => cancelDrawMode());
  drawInstruction.append(text, cancel);
  container.appendChild(drawInstruction);
  state.drawLayer = drawLayer;
  state.drawPreview = drawPreview;
  state.drawInstruction = drawInstruction;

  const onMove = (me: MouseEvent): void => {
    const layer = state.drawLayer;
    const preview = state.drawPreview;
    const start = state.drawStart;
    if (!state.drawActive || !start || !preview || !layer) return;
    const layerRect = layer.getBoundingClientRect();
    const x0 = start.x;
    const y0 = start.y;
    const x1 = me.clientX - layerRect.left;
    const y1 = me.clientY - layerRect.top;
    if (Math.hypot(me.clientX - start.clientX, me.clientY - start.clientY) > 5) state.drawMoved = true;
    preview.style.display = "block";
    preview.style.left = `${Math.min(x0, x1)}px`;
    preview.style.top = `${Math.min(y0, y1)}px`;
    preview.style.width = `${Math.abs(x1 - x0)}px`;
    preview.style.height = `${Math.abs(y1 - y0)}px`;
  };
  // Same blur cleanup as Visual Library: a release
  // outside the window never fires mouseup on it, so
  // without this the draw listeners would linger and
  // the next mouse move would keep drawing a frame.
  const cleanup = (): void => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("blur", onBlur);
  };
  const onBlur = (): void => {
    cleanup();
    if (state.drawPreview) state.drawPreview.style.display = "none";
    state.drawStart = null;
    state.drawMoved = false;
  };
  const onUp = (me: MouseEvent): void => {
    cleanup();
    const layer = state.drawLayer;
    const start = state.drawStart;
    if (!state.drawActive || !start || !layer) return;
    const layerRect = layer.getBoundingClientRect();
    const x0 = start.x;
    const y0 = start.y;
    const x1 = me.clientX - layerRect.left;
    const y1 = me.clientY - layerRect.top;
    if (state.drawPreview) state.drawPreview.style.display = "none";
    // A click without a drag creates nothing, and stays in
    // draw mode, so the user can try again immediately.
    if (!state.drawMoved) {
      state.drawStart = null;
      return;
    }
    state.drawStart = null;
    state.drawMoved = false;
    const clientLeft = Math.min(x0, x1);
    const clientTop = Math.min(y0, y1);
    const clientW = Math.abs(x1 - x0);
    const clientH = Math.abs(y1 - y0);
    const cam = getApi().view.getCamera();
    const b = boardGeometry();
    const worldLeft = (clientLeft + layerRect.left - b.left) / cam.zoom + cam.x;
    const worldTop = (clientTop + layerRect.top - b.top) / cam.zoom + cam.y;
    const worldW = clientW / cam.zoom;
    const worldH = clientH / cam.zoom;
    if (worldW < 48 || worldH < 48) {
      getApi().ui.toast("Draw a larger rectangle");
      return;
    }
    const id = getApi().board.addPluginCard("slide", {}, { x: worldLeft, y: worldTop }, { w: worldW, h: worldH });
    cancelDrawMode();
    getApi().board.setSelected([id]);
  };
  drawLayer.addEventListener("mousedown", (e: MouseEvent) => {
    if (!state.drawActive || e.button !== 0) return;
    const layerRect = drawLayer.getBoundingClientRect();
    state.drawStart = {
      x: e.clientX - layerRect.left,
      y: e.clientY - layerRect.top,
      clientX: e.clientX,
      clientY: e.clientY,
    };
    state.drawMoved = false;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
  });
}
