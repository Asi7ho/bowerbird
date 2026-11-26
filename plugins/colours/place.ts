// Color Management — placing swatches on the board.
// Drag a colour tile to place a 120x120 swatch at the
// drop point, centred there. A click applies instead,
// so only the drag places. A placed swatch is an
// ordinary board item, not a plugin card, so it
// survives disabling the plugin.
import type { PluginContext, Pt } from "bowerbird-plugin-api";

function placeAt(api: PluginContext | null, hex: string, point: Pt): void {
  if (!api) return;
  api.board.addItem({ Swatch: { hex } }, { x: point.x - 60, y: point.y - 60 }, { w: 120, h: 120 });
}

export function attachPlaceDrag(api: PluginContext, el: HTMLElement): void {
  // The colour is read from the element at drop time,
  // not when the handler is attached.
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
        ghost.className = "col-ghost";
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
      placeAt(api, hex, api.view.screenToWorld(me.clientX, me.clientY));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
  });
}
