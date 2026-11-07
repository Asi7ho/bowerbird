// Presentation — the slide list panel. Play and Draw at the
// top, the slide rows (thumbnail, name, move up/down, play,
// delete) in the middle, Export pinned to the bottom at full
// width. The rows are built from the computed slides, so the
// panel never stores its own list.
import { getApi, state } from "./state.js";
import { isFrameItem } from "./geometry.js";
import { goTo, startPresentation, syncFromBoard } from "./view.js";
import { startDrawMode } from "./draw.js";
import { exportSlides } from "./export.js";

// ---- Panel ------------------------------------------------------------
export function updatePanel(): void {
  const panelList = state.panelList;
  if (!panelList) return;
  // Play and Export only make sense when there is
  // something to play or export: with no slides both
  // are disabled, so the panel guides you to Draw first
  // instead of opening or exporting an empty presentation.
  if (state.panelPlayBtn) state.panelPlayBtn.disabled = state.slides.length === 0;
  if (state.panelExportBtn) state.panelExportBtn.disabled = state.slides.length === 0;
  panelList.innerHTML = "";
  if (state.slides.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pres-panel-empty";
    empty.textContent = "No slides yet. Draw one on the board.";
    panelList.appendChild(empty);
    return;
  }
  state.slides.forEach((slide, i) => {
    const row = document.createElement("div");
    row.className = "pres-panel-row";
    if (getApi().view.getView() === "presentation" && i === state.index) row.classList.add("active");
    row.title = "Show this slide on the board";
    row.addEventListener("click", () => {
      if (getApi().view.getView() === "presentation") {
        goTo(i);
      } else {
        getApi().view.centreOn(slide.frame.id);
      }
    });
    // Thumbnail: the frame's cards as rectangles in
    // frame-relative positions, so the row shows the
    // slide's layout, not just its number.
    const thumb = document.createElement("div");
    thumb.className = "pres-panel-thumb";
    thumb.setAttribute("aria-hidden", "true");
    const frame = slide.frame;
    for (const it of slide.cards) {
      const left = Math.max(it.pos.x, frame.pos.x) - frame.pos.x;
      const top = Math.max(it.pos.y, frame.pos.y) - frame.pos.y;
      const right = Math.min(it.pos.x + it.size.w, frame.pos.x + frame.size.w) - frame.pos.x;
      const bottom = Math.min(it.pos.y + it.size.h, frame.pos.y + frame.size.h) - frame.pos.y;
      if (right <= left || bottom <= top) continue;
      const rect = document.createElement("div");
      rect.className = "pres-panel-thumb-rect";
      rect.style.left = `${(left / frame.size.w) * 100}%`;
      rect.style.top = `${(top / frame.size.h) * 100}%`;
      rect.style.width = `${((right - left) / frame.size.w) * 100}%`;
      rect.style.height = `${((bottom - top) / frame.size.h) * 100}%`;
      if ("Swatch" in it.kind && typeof it.kind.Swatch.hex === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(it.kind.Swatch.hex)) {
        rect.style.background = it.kind.Swatch.hex;
        rect.style.borderColor = "rgba(0,0,0,0.08)";
      }
      thumb.appendChild(rect);
    }
    const name = document.createElement("span");
    name.className = "pres-panel-name";
    name.textContent = `Slide ${i + 1}`;
    // Reordering is moving the frame in board order, which
    // is the slide order: slide numbers, play order and
    // export order all follow from it, so nothing else
    // needs storing. Moving up puts the frame before the
    // previous frame; moving down puts it after the next
    // one (moveItem inserts at the given index after
    // removing it, so the next frame's original index is
    // exactly the spot after it). It saves like any board
    // change, so reordering is undoable.
    const move = (delta: number): void => {
      const all = getApi().board.getItems();
      const frames = all.filter(isFrameItem);
      const target = frames[i + delta];
      if (!target) return;
      const targetIndex = all.findIndex((it) => it.id === target.id);
      getApi().board.moveItem(slide.frame.id, targetIndex);
    };
    const up = document.createElement("button");
    up.className = "pres-panel-icon-btn";
    up.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
    up.title = `Move Slide ${i + 1} up`;
    up.setAttribute("aria-label", `Move Slide ${i + 1} up`);
    up.disabled = i === 0;
    up.addEventListener("click", (e) => {
      e.stopPropagation();
      move(-1);
    });
    const down = document.createElement("button");
    down.className = "pres-panel-icon-btn";
    down.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    down.title = `Move Slide ${i + 1} down`;
    down.setAttribute("aria-label", `Move Slide ${i + 1} down`);
    down.disabled = i === state.slides.length - 1;
    down.addEventListener("click", (e) => {
      e.stopPropagation();
      move(1);
    });
    const play = document.createElement("button");
    play.className = "pres-panel-icon-btn";
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>';
    play.title = `Play from Slide ${i + 1}`;
    play.setAttribute("aria-label", `Play from Slide ${i + 1}`);
    play.addEventListener("click", (e) => {
      e.stopPropagation();
      startPresentation(i);
    });
    const del = document.createElement("button");
    del.className = "pres-panel-icon-btn";
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.title = `Delete Slide ${i + 1}`;
    del.setAttribute("aria-label", `Delete Slide ${i + 1}`);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      getApi().board.removeItem(slide.frame.id);
    });
    row.append(thumb, name, up, down, play, del);
    panelList.appendChild(row);
  });
}

export function initPanel(body: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "pres-panel-actions";
  const play = document.createElement("button");
  play.className = "pres-panel-play";
  // Short label, so Play fits beside Draw on one line;
  // the full wording stays in the title and aria-label.
  play.textContent = "▶ Play";
  play.title = "Play from the first slide";
  play.setAttribute("aria-label", "Play presentation");
  play.addEventListener("click", () => startPresentation(0));
  state.panelPlayBtn = play;
  actions.appendChild(play);
  const draw = document.createElement("button");
  draw.className = "pres-panel-draw";
  // A dashed rectangle, matching the slide frame itself,
  // so Draw reads as drawing a frame at a glance.
  draw.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 3" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/></svg><span>Draw a slide</span>`;
  draw.title = "Draw a rectangle on the board to make a slide";
  draw.setAttribute("aria-label", "Draw a slide");
  draw.addEventListener("click", () => startDrawMode());
  actions.appendChild(draw);
  body.appendChild(actions);
  const hint = document.createElement("div");
  hint.className = "pres-panel-hint";
  hint.textContent = "Draw a rectangle around cards to make a slide.";
  body.appendChild(hint);
  const panelList = document.createElement("div");
  panelList.className = "pres-panel-list";
  state.panelList = panelList;
  body.appendChild(panelList);
  const exportBtn = document.createElement("button");
  exportBtn.className = "pres-panel-export";
  // A download arrow, matching Draw's icon style, and a
  // short label: Export sits at the bottom of the panel,
  // below the slide list, at the panel's full width.
  exportBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg><span>Export</span>`;
  exportBtn.title = "Export all slides as a single HTML file";
  exportBtn.setAttribute("aria-label", "Export slides");
  exportBtn.addEventListener("click", () => { void exportSlides(); });
  state.panelExportBtn = exportBtn;
  body.appendChild(exportBtn);
  syncFromBoard(true);
}
