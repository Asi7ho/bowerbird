// Palette — placing swatches on the board. Click a tile or
// the preview to place a 120x120 swatch at the camera centre.
// Drag a tile or the preview to place it at the drop point,
// centred there, the same interaction as Visual Library. A
// placed swatch is an ordinary board item of kind Swatch, not
// a plugin card, so it survives disabling the plugin.
//
// Board geometry lives in #board now, below the title bar:
// its client size is the visible board, and its top edge is
// the board's origin in client coordinates. Centre and drop
// points go through it, never window size or raw client
// coordinates, or a swatch lands 48px low.
import type { PluginContext } from "../../src/plugins";
import type { Pt } from "../../src/model";

export function boardGeometry(): { w: number; h: number; left: number; top: number } {
  const el = document.getElementById("board");
  if (!el) return { w: window.innerWidth, h: window.innerHeight, left: 0, top: 0 };
  const r = el.getBoundingClientRect();
  return { w: el.clientWidth, h: el.clientHeight, left: r.left, top: r.top };
}

export function cameraCentreWorld(api: PluginContext): Pt {
  const cam = api.view.getCamera();
  const b = boardGeometry();
  return { x: cam.x + b.w / 2 / cam.zoom, y: cam.y + b.h / 2 / cam.zoom };
}

export function dropWorld(api: PluginContext, clientX: number, clientY: number): Pt {
  const cam = api.view.getCamera();
  const b = boardGeometry();
  return { x: (clientX - b.left) / cam.zoom + cam.x, y: (clientY - b.top) / cam.zoom + cam.y };
}

export function placeAt(api: PluginContext | null, hex: string, point: Pt): void {
  if (!api) return;
  api.board.addItem({ Swatch: { hex } }, { x: point.x - 60, y: point.y - 60 }, { w: 120, h: 120 });
}

export function attachPlaceInteractions(api: PluginContext, el: HTMLElement): void {
  // The colour is read from the element at click/drop time,
  // not captured when the handler is attached, so updating
  // a tile's colour never needs its handlers re-attached.
  el.addEventListener("click", () => {
    if (el.dataset.hex) placeAt(api, el.dataset.hex, cameraCentreWorld(api));
  });
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !el.dataset.hex) return;
    const hex = el.dataset.hex;
    let moved = false;
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost: HTMLDivElement | null = null;
    const onMove = (me: MouseEvent): void => {
      if (!moved && Math.hypot(me.clientX - startX, me.clientY - startY) > 5) {
        moved = true;
        ghost = document.createElement("div");
        ghost.className = "pal-ghost";
        ghost.style.background = hex;
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = `${me.clientX + 12}px`;
        ghost.style.top = `${me.clientY + 12}px`;
      }
    };
    // Same blur cleanup as Visual Library: a release
    // outside the window never fires mouseup on it.
    const cleanup = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
      if (ghost) ghost.remove();
      ghost = null;
    };
    const onBlur = (): void => { cleanup(); moved = false; };
    const onUp = (me: MouseEvent): void => {
      cleanup();
      if (!moved) return;
      // A drop onto the visible board places the swatch.
      // A drop back onto any UI cancels.
      const target = document.elementFromPoint(me.clientX, me.clientY);
      if (!target) return;
      if (target.closest && (target.closest(".plugin-panel") || target.closest("#toolbar") || target.closest("#title-bar") || target.closest("#settings-backdrop") || target.closest("#view-switcher") || target.closest(".plugin-tabs"))) return;
      placeAt(api, hex, dropWorld(api, me.clientX, me.clientY));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
  });
}
