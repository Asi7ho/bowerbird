// Presentation — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// A view, not a panel: switch to it in the view switcher at
// the bottom of the board, and it steps through the board's
// cards one at a time, large and centred, for presenting a
// moodboard without the board around it. Slides are in
// board order — the same order Tab steps through on the
// board — so the order you added cards is the order you
// present them. There is no reordering, no custom order,
// and no editing in v1: presenting is showing, not
// rearranging.
//
// What a slide is: the board's own card, rendered by the
// core itself (api.board.renderCard), so a slide is the
// same card as on the board, at the same aspect ratio.
// It is scaled uniformly to fit the stage, so a text note
// or an image reads from a distance; the scale is capped
// so a small swatch becomes a prominent colour block,
// not a full-screen field. Strokes and connectors are
// not cards and are not slides, as in Visual Library.
//
// What works inside a slide: a video's native controls
// play in place, and an audio card plays in place through
// the plugin's own player (the core's player belongs to
// the board, which is hidden). A link card opens its URL
// outside the app, as on the board. Clicking anywhere
// else on a slide does nothing — it does not advance,
// duplicate or edit — so interacting with media never
// moves you on by accident. Plugin cards show as they do
// on the board, but their buttons do not run in
// presentation; they run on the board.
//
// Panels, the toolbar and the view switcher stay where
// the user left them: this plugin hides nothing but the
// board itself, because it cannot know which other
// panels the user wants open, and hiding them all would
// be a cross-plugin guess. For a clean full-width
// presentation, hide the dock first with the panels
// toggle in the title bar; it comes back the same way.
//
// Keyboard, while presenting: left and right arrows move,
// Space moves forward, Esc returns to the board. Tab,
// Delete and the board editing keys (tools, zoom, group)
// are blocked while presenting, because the board is
// hidden and those actions would act on invisible cards
// — Delete behind a presentation would be a real loss.
// Other keys pass through, so ? still opens Settings
// and H still hides the app. Esc is not stopped, so if
// Settings is open it closes too, and one Esc returns
// to a clean board. Typing in the search box or a text
// field is never hijacked: arrows and Space there move
// the cursor and type, as they should.
let apiRef = null;
let items = [];
let index = 0;
let lastSignature = "";

// View refs (built on each activation, cleared on hide).
let viewBuilt = false;
let stage = null;
let prevBtn = null;
let nextBtn = null;
let counter = null;

let onBoardHandler = null;
let resizeHandler = null;

// One presentation audio at a time, played through a plain
// Audio element (the core's audio player belongs to the
// board). Refs are to the current slide's DOM, which is
// rebuilt on every slide change, so playback always stops
// when you move on.
let presAudio = null;
let presAudioItemId = null;
let presAudioTile = null;
let presAudioSeek = null;
let presAudioTime = null;
let presAudioDur = null;

const KIND_SINGULAR = { Audio: "audio", Image: "image", UrlCard: "link", PdfCard: "PDF", Plugin: "plugin card", Swatch: "swatch", Text: "text note", Video: "video" };
const PRESENTABLE_KINDS = new Set(["Audio", "Image", "UrlCard", "PdfCard", "Plugin", "Swatch", "Text", "Video"]);

function kindKey(item) {
  return Object.keys(item.kind)[0];
}

function isPresentableItem(item) {
  return PRESENTABLE_KINDS.has(kindKey(item)) && item.size.w > 0 && item.size.h > 0;
}

function signature(list) {
  // Order matters here — it is the slide order — so this
  // signature is NOT sorted, unlike Visual Library's.
  return list.map((it) => `${it.id}:${JSON.stringify(it.kind)}:${it.size.w}x${it.size.h}`).join("|");
}

function formatAudioTime(sec) {
  if (!isFinite(sec) || sec < 0) return "–:––";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function stopPresentationAudio() {
  if (presAudio) presAudio.pause();
  presAudio = null;
  presAudioItemId = null;
  presAudioTile = null;
  presAudioSeek = null;
  presAudioTime = null;
  presAudioDur = null;
}

function playPresentationAudio(item) {
  const path = item.kind.Audio.path;
  const tile = stage ? stage.querySelector(".audio-tile") : null;
  if (!tile) return;
  if (presAudioItemId === item.id && presAudio) {
    if (presAudio.paused) {
      presAudio.play().catch(() => undefined);
      tile.textContent = "❚❚";
    } else {
      presAudio.pause();
      tile.textContent = "▶";
    }
    return;
  }
  stopPresentationAudio();
  const audio = new Audio(apiRef.files.fileUrl(path));
  presAudio = audio;
  presAudioItemId = item.id;
  presAudioTile = tile;
  presAudioSeek = stage ? stage.querySelector("input.audio-seek") : null;
  presAudioTime = stage ? stage.querySelector("[data-audio-time]") : null;
  presAudioDur = stage ? stage.querySelector("[data-audio-dur]") : null;
  audio.addEventListener("loadedmetadata", () => {
    if (presAudioDur && presAudioDur.isConnected) presAudioDur.textContent = formatAudioTime(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    if (presAudioSeek && presAudioSeek.isConnected) presAudioSeek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    if (presAudioTime && presAudioTime.isConnected) presAudioTime.textContent = formatAudioTime(audio.currentTime);
  });
  audio.addEventListener("ended", () => {
    if (presAudioTile && presAudioTile.isConnected) presAudioTile.textContent = "▶";
    stopPresentationAudio();
  });
  audio.play().catch(() => undefined);
  tile.textContent = "❚❚";
}

function goTo(next) {
  if (items.length === 0) return;
  const clamped = Math.max(0, Math.min(items.length - 1, next));
  if (clamped === index) return;
  index = clamped;
  renderSlide();
}

function renderSlide() {
  if (!viewBuilt || !stage) return;
  stopPresentationAudio();
  stage.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pres-empty";
    const head = document.createElement("div");
    head.textContent = "No cards to present yet";
    const sub = document.createElement("div");
    sub.className = "pres-empty-sub";
    sub.textContent = "Add a card to the board, then come back here.";
    empty.append(head, sub);
    stage.appendChild(empty);
  } else {
    const item = items[index];
    const html = apiRef.board.renderCard(item.id);
    if (!html) {
      const empty = document.createElement("div");
      empty.className = "pres-empty";
      empty.textContent = "This card cannot be shown in presentation";
      stage.appendChild(empty);
    } else {
      // Scale to fit the stage, capped so a small card
      // stays a card, not a full-screen field. The card
      // DOM itself is scaled, not a screenshot, so text
      // stays crisp and an image re-renders from its file.
      const rect = stage.getBoundingClientRect();
      const maxW = Math.max(1, rect.width - 32);
      const maxH = Math.max(1, rect.height - 32);
      let scale = Math.min(maxW / item.size.w, maxH / item.size.h, 2.5);
      if (!isFinite(scale) || scale <= 0) scale = 1;
      const wrap = document.createElement("div");
      wrap.className = "pres-card-wrap";
      wrap.style.width = `${item.size.w * scale}px`;
      wrap.style.height = `${item.size.h * scale}px`;
      wrap.innerHTML = html;
      const inner = wrap.firstElementChild;
      if (inner) {
        inner.style.transform = `scale(${scale})`;
        inner.style.transformOrigin = "top left";
      }
      stage.appendChild(wrap);
      // Audio seek in this slide, if it has one.
      const seek = wrap.querySelector("input.audio-seek");
      if (seek) {
        seek.addEventListener("input", () => {
          if (presAudioItemId === item.id && presAudio && isFinite(presAudio.duration) && presAudio.duration > 0) {
            presAudio.currentTime = (Number(seek.value) / 1000) * presAudio.duration;
          }
        });
      }
    }
  }
  if (counter) counter.textContent = items.length === 0 ? "0 / 0" : `${index + 1} / ${items.length}`;
  if (prevBtn) prevBtn.disabled = items.length === 0 || index === 0;
  if (nextBtn) nextBtn.disabled = items.length === 0 || index === items.length - 1;
}

function syncFromBoard(force) {
  const next = apiRef.board.getItems().filter(isPresentableItem);
  const sig = signature(next);
  if (!force && sig === lastSignature) return false;
  items = next;
  lastSignature = sig;
  if (index >= items.length) index = Math.max(0, items.length - 1);
  if (viewBuilt) renderSlide();
  return true;
}

function onStageClick(e) {
  if (!stage || items.length === 0) return;
  const item = items[index];
  if (!item) return;
  const target = e.target;
  if (!target || !target.closest) return;
  // Audio plays in place, as on the board. Everything else
  // on a slide is inert: a click never advances, so a
  // video control or a link never moves you on.
  if (target.closest(".audio-tile")) {
    if ("Audio" in item.kind) playPresentationAudio(item);
    return;
  }
  if (target.closest("[data-action=\"open-link\"]")) {
    if ("UrlCard" in item.kind) {
      e.preventDefault();
      apiRef.files.openExternal(item.kind.UrlCard.url).catch(() => undefined);
    }
    return;
  }
}

function onKeyDown(e) {
  // Guard for v1: a handler registered in activate stays
  // registered after deactivate, so it must check that
  // presentation is actually the active view before
  // doing anything, or it would hijack the board.
  if (!apiRef || apiRef.view.getView() !== "presentation") return;
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.id === "search-input")) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key;
  if (key === "ArrowLeft") {
    e.preventDefault();
    e.stopPropagation();
    goTo(index - 1);
    return;
  }
  if (key === "ArrowRight") {
    e.preventDefault();
    e.stopPropagation();
    goTo(index + 1);
    return;
  }
  if (key === " ") {
    // A focused button handles Space itself on keyup;
    // handling it here too would advance twice.
    if (active && active.tagName === "BUTTON") return;
    e.preventDefault();
    e.stopPropagation();
    goTo(index + 1);
    return;
  }
  if (key === "Escape") {
    apiRef.view.setView("board");
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

function buildView(container) {
  const root = document.createElement("div");
  root.className = "pres-root";
  const row = document.createElement("div");
  row.className = "pres-stage-row";
  prevBtn = document.createElement("button");
  prevBtn.className = "pres-nav";
  prevBtn.textContent = "‹";
  prevBtn.title = "Previous (Left arrow)";
  prevBtn.setAttribute("aria-label", "Previous slide");
  prevBtn.addEventListener("click", () => goTo(index - 1));
  stage = document.createElement("div");
  stage.className = "pres-stage";
  stage.addEventListener("click", onStageClick);
  nextBtn = document.createElement("button");
  nextBtn.className = "pres-nav";
  nextBtn.textContent = "›";
  nextBtn.title = "Next (Right arrow or Space)";
  nextBtn.setAttribute("aria-label", "Next slide");
  nextBtn.addEventListener("click", () => goTo(index + 1));
  row.append(prevBtn, stage, nextBtn);
  const controls = document.createElement("div");
  controls.className = "pres-controls";
  counter = document.createElement("span");
  counter.className = "pres-counter";
  const hint = document.createElement("span");
  hint.className = "pres-hint";
  hint.textContent = "← → to move · Esc to exit";
  const back = document.createElement("button");
  back.className = "pres-back";
  back.textContent = "Back to board";
  back.title = "Back to board (Esc)";
  back.setAttribute("aria-label", "Back to board");
  back.addEventListener("click", () => apiRef.view.setView("board"));
  controls.append(counter, hint, back);
  root.append(row, controls);
  container.appendChild(root);
  viewBuilt = true;
  syncFromBoard(true);
}

function viewContainerClear() {
  viewBuilt = false;
  stage = null;
  prevBtn = null;
  nextBtn = null;
  counter = null;
}

function activate(api) {
  apiRef = api;
  onBoardHandler = () => syncFromBoard(false);
  apiRef.events.on("board", onBoardHandler);
  resizeHandler = () => {
    if (viewBuilt) renderSlide();
  };
  window.addEventListener("resize", resizeHandler);
  apiRef.ui.registerView({
    id: "presentation",
    title: "Presentation",
    render: (container) => {
      // Core re-renders the active view on every board
      // render; sync only when the board's cards actually
      // changed, so a slide is not rebuilt — and a video
      // restarted — on every move.
      if (!viewBuilt) {
        buildView(container);
      } else {
        syncFromBoard(false);
      }
    },
    onShow: () => {
      window.addEventListener("keydown", onKeyDown, true);
      // A presentation always starts at the first card.
      // This runs after the view's first render, in the
      // same tick, so no intermediate slide is painted.
      index = 0;
      if (viewBuilt) renderSlide();
    },
    onHide: () => {
      window.removeEventListener("keydown", onKeyDown, true);
      stopPresentationAudio();
      viewContainerClear();
    },
  });
}

function deactivate() {
  window.removeEventListener("keydown", onKeyDown, true);
  stopPresentationAudio();
  if (apiRef && onBoardHandler) apiRef.events.off("board", onBoardHandler);
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  onBoardHandler = null;
  resizeHandler = null;
  viewContainerClear();
  apiRef = null;
}

export { activate, deactivate };
