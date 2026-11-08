// Visual Library — what happens to a library card. Clicking
// focuses the original on the board; dragging duplicates it
// at the drop point; media previews play in place and do
// neither. Also the board geometry the drop point goes
// through, so a duplicate never lands 48px low.
import type { PluginContext } from "../../src/plugins";
import type { Item, Pt } from "../../src/model";
import { KIND_SINGULAR, kindKey, moveItemToCategory } from "./items.js";
import { updateAllDynamic } from "./render.js";
import type { LibraryMode } from "./items.js";
import { playLibraryAudio, seekLibAudio } from "./audio.js";

// Board geometry lives in #board now, below the title bar:
// its client size is the visible board, and its top edge is
// the board's origin in client coordinates. Centre and drop
// points go through it, never window size or raw client
// coordinates, or a duplicate lands 48px low.
export function boardGeometry(): { w: number; h: number; left: number; top: number } {
  const el = document.getElementById("board");
  if (!el) return { w: window.innerWidth, h: window.innerHeight, left: 0, top: 0 };
  const r = el.getBoundingClientRect();
  return { w: el.clientWidth, h: el.clientHeight, left: r.left, top: r.top };
}

export function cameraCentreWorld(api: PluginContext): Pt {
  const cam = api.view.getCamera();
  const b = boardGeometry();
  return {
    x: cam.x + b.w / 2 / cam.zoom,
    y: cam.y + b.h / 2 / cam.zoom,
  };
}

export function dropWorld(api: PluginContext, clientX: number, clientY: number): Pt {
  const cam = api.view.getCamera();
  const b = boardGeometry();
  return { x: (clientX - b.left) / cam.zoom + cam.x, y: (clientY - b.top) / cam.zoom + cam.y };
}

export function duplicateAt(api: PluginContext, item: Item, point: Pt, showToast: boolean): void {
  const kind = JSON.parse(JSON.stringify(item.kind)) as Item["kind"];
  const size = { w: item.size.w, h: item.size.h };
  api.board.addItem(kind, { x: point.x - size.w / 2, y: point.y - size.h / 2 }, size);
  if (showToast) api.ui.toast(`Duplicated ${KIND_SINGULAR[kindKey(item)] || "element"} to board`);
}

export function focusOnBoard(api: PluginContext, item: Item, mode: LibraryMode): void {
  // Focus, not duplication: show the original on the
  // board, centred and selected, and add nothing.
  // In whiteboard view mode, clicking a card must NOT
  // leave the library: it only selects the card in
  // place (the library's selection highlight follows),
  // and the board view stays hidden behind the view.
  // Panel mode keeps the old behaviour: go back to the
  // board first, then centre on the original.
  if (mode === "view") {
    api.board.setSelected([item.id]);
    return;
  }
  if (api.view.getView() !== "board") api.view.setView("board");
  api.board.setSelected([item.id]);
  api.view.centreOn(item.id);
}

export function isMediaTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  return Boolean(target.closest("video") || target.closest("input.audio-seek") || target.closest(".audio-tile"));
}

export function attachCardInteractions(api: PluginContext, wrap: HTMLElement, item: Item, mode: LibraryMode): void {
  wrap.addEventListener("click", (e) => {
    // Media previews do not focus either. Everything else
    // on the card — including a link's title and image —
    // focuses the original on the board. Dragging, below,
    // is still how a card is duplicated.
    if (isMediaTarget(e.target)) return;
    focusOnBoard(api, item, mode);
  });
  const tile = wrap.querySelector(".audio-tile");
  if (tile) {
    tile.addEventListener("click", () => playLibraryAudio(api, item, tile, wrap));
  }
  const seek = wrap.querySelector("input.audio-seek") as HTMLInputElement | null;
  if (seek) {
    seek.addEventListener("input", () => {
      seekLibAudio(item.id, Number(seek.value));
    });
  }
  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || isMediaTarget(e.target)) return;
    let moved = false;
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost: HTMLDivElement | null = null;
    const onMove = (me: MouseEvent) => {
      if (!moved && Math.hypot(me.clientX - startX, me.clientY - startY) > 5) {
        moved = true;
        ghost = document.createElement("div");
        ghost.className = "vl-ghost";
        const gScale = 120 / item.size.w;
        ghost.style.width = "120px";
        ghost.style.height = `${item.size.h * gScale}px`;
        const html = api.board.renderCard(item.id);
        if (html) {
          ghost.innerHTML = html;
          const inner = ghost.firstElementChild as HTMLElement | null;
          if (inner) {
            inner.style.transform = `scale(${gScale})`;
            inner.style.transformOrigin = "top left";
          }
        }
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = `${me.clientX + 12}px`;
        ghost.style.top = `${me.clientY + 12}px`;
      }
    };
    // A release outside the window never fires mouseup
    // on it, so without the blur cleanup the move/up
    // listeners — and the ghost — would linger until the
    // next mouse-up anywhere. Blur cancels the drag
    // (no drop); mouseup drops.
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
      if (ghost) ghost.remove();
      ghost = null;
    };
    const onBlur = () => { cleanup(); moved = false; };
    const onUp = (me: MouseEvent) => {
      cleanup();
      if (!moved) return;
      // A drop onto a category section moves the card into
      // that category instead of duplicating it — including
      // a drop on Uncategorized, which moves it back out.
      // This runs before the UI-cancel checks below, because
      // the sections live inside the library panel, which
      // the panel-mode check would otherwise cancel.
      const dropEl = document.elementFromPoint(me.clientX, me.clientY);
      const catWrap = dropEl && dropEl.closest ? dropEl.closest(".vl-category") as HTMLElement | null : null;
      if (catWrap && catWrap.dataset.category) {
        const key = catWrap.dataset.category;
        moveItemToCategory(api, item.id, key === "uncategorized" ? null : key);
        // Re-render the library so the card appears in its
        // new section at once.
        updateAllDynamic(api);
        return;
      }
      if (mode === "panel") {
        // Panel mode: only a drop onto the visible board
        // duplicates. A drop back onto any UI cancels.
        const el = document.elementFromPoint(me.clientX, me.clientY);
        if (!el) return;
        if (el.closest && (el.closest('[data-panel="library"]') || el.closest("#toolbar") || el.closest("#plugin-view") || el.closest("#view-switcher") || el.closest("#search-box") || el.closest("#title-bar") || el.closest("#settings-sheet") || el.closest(".plugin-tabs") || el.closest(".plugin-panel"))) return;
        duplicateAt(api, item, dropWorld(api, me.clientX, me.clientY), false);
      } else {
        // Whiteboard mode: the board is hidden behind the view,
        // so any drop duplicates at the drop point in camera
        // coordinates, with a toast — except a drop onto the
        // title bar, which is not the board and must not
        // create a card hidden under it.
        const el = document.elementFromPoint(me.clientX, me.clientY);
        if (el && el.closest && el.closest("#title-bar")) return;
        duplicateAt(api, item, dropWorld(api, me.clientX, me.clientY), true);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
  });
}
