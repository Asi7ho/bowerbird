// Presentation — playing a slide. The presentation view itself
// (stage, navigation, counter), the keyboard while presenting,
// and the audio that plays in place inside a slide through a
// plain Audio element (the core's audio player belongs to the
// board, which is hidden).
import type { Item } from "../../src/model";
import { getApi, state } from "./state.js";
import { computeSlides, drawingPrimitives, signature } from "./geometry.js";
import { updatePanel } from "./panel.js";
import { cancelDrawMode } from "./draw.js";

// ---- Audio, in the playing view only ---------------------------------
function formatAudioTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "–:––";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function stopPresentationAudio(): void {
  if (state.presAudio) state.presAudio.pause();
  state.presAudio = null;
  state.presAudioItemId = null;
  state.presAudioTile = null;
  state.presAudioSeek = null;
  state.presAudioTime = null;
  state.presAudioDur = null;
}

export function playPresentationAudio(item: Item, tile: HTMLElement): void {
  if (!("Audio" in item.kind)) return;
  const path = item.kind.Audio.path;
  const current = state.presAudio;
  if (state.presAudioItemId === item.id && current) {
    if (current.paused) {
      current.play().catch(() => undefined);
      tile.textContent = "❚❚";
    } else {
      current.pause();
      tile.textContent = "▶";
    }
    return;
  }
  stopPresentationAudio();
  const audio = new Audio(getApi().files.fileUrl(path));
  state.presAudio = audio;
  state.presAudioItemId = item.id;
  state.presAudioTile = tile;
  state.presAudioSeek = state.stage ? state.stage.querySelector<HTMLInputElement>(`input.audio-seek[data-audio-seek="${item.id}"]`) : null;
  state.presAudioTime = state.stage ? state.stage.querySelector<HTMLElement>(`[data-audio-time="${item.id}"]`) : null;
  state.presAudioDur = state.stage ? state.stage.querySelector<HTMLElement>(`[data-audio-dur="${item.id}"]`) : null;
  audio.addEventListener("loadedmetadata", () => {
    if (state.presAudioDur && state.presAudioDur.isConnected) state.presAudioDur.textContent = formatAudioTime(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    if (state.presAudioSeek && state.presAudioSeek.isConnected) state.presAudioSeek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    if (state.presAudioTime && state.presAudioTime.isConnected) state.presAudioTime.textContent = formatAudioTime(audio.currentTime);
  });
  audio.addEventListener("ended", () => {
    if (state.presAudioTile && state.presAudioTile.isConnected) state.presAudioTile.textContent = "▶";
    stopPresentationAudio();
  });
  audio.play().catch(() => undefined);
  tile.textContent = "❚❚";
}

// ---- View: playing a slide -------------------------------------------
export function startPresentation(at: number): void {
  if (state.slides.length === 0) return;
  cancelDrawMode();
  state.pendingStartIndex = at;
  getApi().view.setView("presentation");
}

export function goTo(next: number): void {
  if (state.slides.length === 0) return;
  const clamped = Math.max(0, Math.min(state.slides.length - 1, next));
  if (clamped === state.index) return;
  state.index = clamped;
  renderSlide();
  if (state.panelList) updatePanel();
}

export function renderSlide(): void {
  const stage = state.stage;
  if (!state.viewBuilt || !stage) return;
  stopPresentationAudio();
  stage.innerHTML = "";
  if (state.slides.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pres-empty";
    const head = document.createElement("div");
    head.textContent = "No slides yet";
    const sub = document.createElement("div");
    sub.className = "pres-empty-sub";
    sub.textContent = "Draw a slide on the board, then play.";
    empty.append(head, sub);
    stage.appendChild(empty);
  } else {
    const slide = state.slides[state.index];
    const frame = slide.frame;
    // Scale the whole frame uniformly to fit the stage,
    // capped so a small frame stays a slide, not a
    // full-screen field. The card DOM itself is scaled,
    // not a screenshot, so text stays crisp and an image
    // re-renders from its file.
    const rect = stage.getBoundingClientRect();
    const maxW = Math.max(1, rect.width - 32);
    const maxH = Math.max(1, rect.height - 32);
    let scale = Math.min(maxW / frame.size.w, maxH / frame.size.h, 2.5);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    const wrap = document.createElement("div");
    wrap.className = "pres-slide-wrap";
    wrap.style.width = `${frame.size.w * scale}px`;
    wrap.style.height = `${frame.size.h * scale}px`;
    if (slide.cards.length === 0 && slide.drawings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pres-empty";
      const head = document.createElement("div");
      head.textContent = "This slide is empty";
      const sub = document.createElement("div");
      sub.className = "pres-empty-sub";
      sub.textContent = "Move a card into the frame on the board, then play again.";
      empty.append(head, sub);
      wrap.appendChild(empty);
    } else {
      // Drawing first, under the cards, as on the board,
      // where the SVG layer sits under the card layer.
      // The SVG uses the frame itself as its viewBox, so
      // its coordinates are frame-relative world units and
      // it scales with the slide automatically; the slide
      // wrapper's overflow hidden crops it to the frame,
      // exactly as a screenshot of the frame area would.
      if (slide.drawings.length > 0) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "pres-slide-svg");
        svg.setAttribute("width", String(frame.size.w * scale));
        svg.setAttribute("height", String(frame.size.h * scale));
        svg.setAttribute("viewBox", `0 0 ${frame.size.w} ${frame.size.h}`);
        svg.style.position = "absolute";
        svg.style.left = "0";
        svg.style.top = "0";
        for (const prim of drawingPrimitives(frame, slide.drawings)) {
          if (prim.type === "stroke") {
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", prim.d);
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", prim.color);
            path.setAttribute("stroke-width", String(prim.width));
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("stroke-linejoin", "round");
            if (prim.marker) path.setAttribute("opacity", "0.45");
            svg.appendChild(path);
          } else {
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", String(prim.a.x));
            line.setAttribute("y1", String(prim.a.y));
            line.setAttribute("x2", String(prim.b.x));
            line.setAttribute("y2", String(prim.b.y));
            line.setAttribute("stroke", prim.color);
            line.setAttribute("stroke-width", "2");
            svg.appendChild(line);
            const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
            arrow.setAttribute("points", `${prim.p1.x},${prim.p1.y} ${prim.b.x},${prim.b.y} ${prim.p2.x},${prim.p2.y}`);
            arrow.setAttribute("fill", "none");
            arrow.setAttribute("stroke", prim.color);
            arrow.setAttribute("stroke-width", "2");
            svg.appendChild(arrow);
          }
        }
        wrap.appendChild(svg);
      }
      for (const item of slide.cards) {
        const html = getApi().board.renderCard(item.id);
        if (!html) continue;
        const cardWrap = document.createElement("div");
        cardWrap.className = "pres-slide-card-wrap";
        cardWrap.style.left = `${(item.pos.x - frame.pos.x) * scale}px`;
        cardWrap.style.top = `${(item.pos.y - frame.pos.y) * scale}px`;
        cardWrap.style.width = `${item.size.w * scale}px`;
        cardWrap.style.height = `${item.size.h * scale}px`;
        cardWrap.innerHTML = html;
        const inner = cardWrap.firstElementChild as HTMLElement | null;
        if (inner) {
          inner.style.transform = `scale(${scale})`;
          inner.style.transformOrigin = "top left";
        }
        wrap.appendChild(cardWrap);
        const seek = cardWrap.querySelector<HTMLInputElement>("input.audio-seek");
        if (seek) {
          seek.addEventListener("input", () => {
            if (state.presAudioItemId === item.id && state.presAudio && isFinite(state.presAudio.duration) && state.presAudio.duration > 0) {
              state.presAudio.currentTime = (Number(seek.value) / 1000) * state.presAudio.duration;
            }
          });
        }
      }
    }
    stage.appendChild(wrap);
  }
  if (state.counter) state.counter.textContent = state.slides.length === 0 ? "0 / 0" : `${state.index + 1} / ${state.slides.length}`;
  if (state.prevBtn) state.prevBtn.disabled = state.slides.length === 0 || state.index === 0;
  if (state.nextBtn) state.nextBtn.disabled = state.slides.length === 0 || state.index === state.slides.length - 1;
}

export function syncFromBoard(force: boolean): boolean {
  const next = computeSlides();
  const sig = signature(next);
  if (!force && sig === state.lastSignature) return false;
  state.slides = next;
  state.lastSignature = sig;
  if (state.index >= state.slides.length) state.index = Math.max(0, state.slides.length - 1);
  if (state.viewBuilt) renderSlide();
  if (state.panelList) updatePanel();
  return true;
}

function onStageClick(e: MouseEvent): void {
  const stage = state.stage;
  if (!stage || state.slides.length === 0) return;
  const slide = state.slides[state.index];
  if (!slide) return;
  const target = e.target as HTMLElement | null;
  if (!target || !target.closest) return;
  const cardEl = target.closest<HTMLElement>(".card");
  if (!cardEl || !cardEl.dataset.id) return;
  const item = slide.cards.find((it) => it.id === Number(cardEl.dataset.id));
  if (!item) return;
  // Audio plays in place, as on the board. Everything else
  // on a slide is inert: a click never advances, so a
  // video control or a link never moves you on.
  const tile = target.closest<HTMLElement>(".audio-tile");
  if (tile) {
    if ("Audio" in item.kind) playPresentationAudio(item, tile);
    return;
  }
  if (target.closest("[data-action=\"open-link\"]")) {
    if ("UrlCard" in item.kind) {
      e.preventDefault();
      getApi().files.openExternal(item.kind.UrlCard.url).catch(() => undefined);
    }
    return;
  }
}

export function onKeyDown(e: KeyboardEvent): void {
  // Guard for v1: a handler registered in activate stays
  // registered after deactivate, so it must check that
  // presentation is actually the active view before
  // doing anything, or it would hijack the board.
  const api = state.api;
  if (!api || api.view.getView() !== "presentation") return;
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.id === "search-input")) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key;
  if (key === "ArrowLeft") {
    e.preventDefault();
    e.stopPropagation();
    goTo(state.index - 1);
    return;
  }
  if (key === "ArrowRight") {
    e.preventDefault();
    e.stopPropagation();
    goTo(state.index + 1);
    return;
  }
  if (key === " ") {
    // A focused button handles Space itself on keyup;
    // handling it here too would advance twice.
    if (active && active.tagName === "BUTTON") return;
    e.preventDefault();
    e.stopPropagation();
    goTo(state.index + 1);
    return;
  }
  if (key === "Escape") {
    api.view.setView("board");
    // Not stopped: core Esc then also closes Settings
    // if it is open, so one Esc returns to a clean board.
    return;
  }
  // Board editing keys, blocked while the board is hidden:
  // Tab would step through hidden board elements, Delete
  // would delete a hidden card, tools and zoom would act
  // on a canvas you cannot see. ? and H pass through.
  const lower = key.toLowerCase();
  if (
    key === "Tab" || key === "Delete" || key === "Backspace" ||
    (!ctrl && (lower === "v" || lower === "p" || lower === "a" || key === "+" || key === "-" || key === "=" || key === "0")) ||
    (ctrl && (lower === "g" || lower === "u"))
  ) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
}

export function buildView(container: HTMLElement): void {
  const root = document.createElement("div");
  root.className = "pres-root";
  const row = document.createElement("div");
  row.className = "pres-stage-row";
  const prevBtn = document.createElement("button");
  prevBtn.className = "pres-nav";
  prevBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5l-7 7 7 7" /></svg>`;
  prevBtn.title = "Previous (Left arrow)";
  prevBtn.setAttribute("aria-label", "Previous slide");
  prevBtn.addEventListener("click", () => goTo(state.index - 1));
  const stage = document.createElement("div");
  stage.className = "pres-stage";
  stage.addEventListener("click", onStageClick);
  const nextBtn = document.createElement("button");
  nextBtn.className = "pres-nav";
  nextBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5l7 7-7 7" /></svg>`;
  nextBtn.title = "Next (Right arrow or Space)";
  nextBtn.setAttribute("aria-label", "Next slide");
  nextBtn.addEventListener("click", () => goTo(state.index + 1));
  row.append(prevBtn, stage, nextBtn);
  const controls = document.createElement("div");
  controls.className = "pres-controls";
  const counter = document.createElement("span");
  counter.className = "pres-counter";
  const hint = document.createElement("span");
  hint.className = "pres-hint";
  hint.textContent = "← → to move · Esc to exit";
  controls.append(counter, hint);
  root.append(row, controls);
  container.appendChild(root);
  state.prevBtn = prevBtn;
  state.stage = stage;
  state.nextBtn = nextBtn;
  state.counter = counter;
  state.viewBuilt = true;
  syncFromBoard(true);
}

export function viewContainerClear(): void {
  state.viewBuilt = false;
  state.stage = null;
  state.prevBtn = null;
  state.nextBtn = null;
  state.counter = null;
}
