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
// ---- State ------------------------------------------------------------
let apiRef = null;
let slides = [];
let index = 0;
let pendingStartIndex = null;
let lastSignature = "";

// View refs (built on each activation, cleared on hide).
let viewBuilt = false;
let stage = null;
let prevBtn = null;
let nextBtn = null;
let counter = null;

// Panel refs (built once by initPanel, cleared on deactivate).
let panelList = null;
let panelPlayBtn = null;
let panelExportBtn = null;

// Overlay refs (built once by initOverlay, cleared on deactivate).
let drawLayer = null;
let drawInstruction = null;
let drawPreview = null;
let drawActive = false;
let drawStart = null;
let drawMoved = false;

let onBoardHandler = null;
let onViewHandler = null;
let resizeHandler = null;
let drawKeyHandler = null;

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

function kindKey(item) {
  return Object.keys(item.kind)[0];
}

function isFrameItem(item) {
  return (
    "Plugin" in item.kind &&
    item.kind.Plugin.plugin === "presentation" &&
    item.kind.Plugin.kind === "slide" &&
    item.size.w > 0 &&
    item.size.h > 0
  );
}

function isCardItem(item) {
  // Frames are containers, not content — a frame inside
  // a frame is its own slide, never content — but every
  // other card kind counts, including Plugin cards.
  if ("Stroke" in item.kind || "Connector" in item.kind) return false;
  if ("Plugin" in item.kind && item.kind.Plugin.kind === "slide") return false;
  return item.size.w > 0 && item.size.h > 0;
}

// ---- Slide geometry -------------------------------------------------
// All geometry lives in the core now, via api.geometry
// (see PLUGIN_API.md). This plugin used to copy
// rectCrossing and clipped ends by hand; those copies
// are gone, so there is one implementation to keep
// correct, and this file only says what a slide contains.

function frameRect(frame) {
  return { x: frame.pos.x, y: frame.pos.y, w: frame.size.w, h: frame.size.h };
}

function cardOverlapsFrame(frame, item) {
  // Strict overlap: a card that only touches the frame's
  // edge, with no area inside, shows nothing in the slide.
  return apiRef.geometry.rectsOverlap(
    frameRect(frame),
    { x: item.pos.x, y: item.pos.y, w: item.size.w, h: item.size.h },
  );
}

function segmentIntersectsFrame(frame, a, b) {
  // A segment enters the frame if any part of it,
  // however short, is inside, as a screenshot of the
  // frame area would show.
  return apiRef.geometry.segmentIntersectsRect(a, b, frameRect(frame));
}

function strokeOverlapsFrame(frame, item) {
  const points = item.kind.Stroke.points;
  if (points.length < 2) return false;
  // Fast reject first: a stroke's points all lie inside
  // its pos/size bounding box, so if that box does not
  // overlap the frame, no segment can — this skips the
  // per-segment loop for every stroke far from a frame,
  // which is most strokes on a large board. It changes
  // nothing about the result: the segment test below
  // is the same test, just not run when it cannot pass.
  if (!cardOverlapsFrame(frame, item)) return false;
  for (let i = 0; i + 1 < points.length; i++) {
    if (segmentIntersectsFrame(frame, points[i], points[i + 1])) return true;
  }
  return false;
}

function connectorOverlapsFrame(frame, item) {
  const ends = apiRef.geometry.clippedEnds(item.kind.Connector.from, item.kind.Connector.to);
  if (!ends) return false;
  return segmentIntersectsFrame(frame, ends[0], ends[1]);
}

// ---- Drawing primitives ---------------------------------------------
// One source for the drawing in a slide, used by both
// the playing view (DOM SVG) and the export (string SVG).
// A primitive is frame-relative, so both renderers just
// place it, without redoing clipping or arrowhead math.
function drawingPrimitives(frame, drawings) {
  const out = [];
  for (const item of drawings) {
    if ("Stroke" in item.kind) {
      const points = item.kind.Stroke.points;
      if (points.length < 2) continue;
      out.push({
        type: "stroke",
        d: points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x - frame.pos.x},${p.y - frame.pos.y}`).join(" "),
        color: item.kind.Stroke.color,
        width: item.kind.Stroke.width,
        marker: item.kind.Stroke.marker,
      });
    }
    if ("Connector" in item.kind) {
      const ends = apiRef.geometry.clippedEnds(item.kind.Connector.from, item.kind.Connector.to);
      if (!ends) continue;
      const a = { x: ends[0].x - frame.pos.x, y: ends[0].y - frame.pos.y };
      const b = { x: ends[1].x - frame.pos.x, y: ends[1].y - frame.pos.y };
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / len, uy = dy / len;
      const head = 12, spread = 0.45;
      const c1 = Math.cos(spread), s1 = Math.sin(spread), c2 = Math.cos(-spread), s2 = Math.sin(-spread);
      out.push({
        type: "connector",
        a, b,
        p1: { x: b.x - head * (ux * c1 - uy * s1), y: b.y - head * (ux * s1 + uy * c1) },
        p2: { x: b.x - head * (ux * c2 - uy * s2), y: b.y - head * (ux * s2 + uy * c2) },
        color: item.kind.Connector.color || "#333333",
      });
    }
  }
  return out;
}

// ---- Slide computation ----------------------------------------------
function computeSlides() {
  const all = apiRef.board.getItems();
  const frames = all.filter(isFrameItem);
  return frames.map((frame) => ({
    frame,
    // A slide is almost a screenshot of its frame area:
    // every card that overlaps the frame at all, however
    // little, and every stroke or connector segment that
    // enters it, in board order. A card's centre is NOT
    // the test — a swatch whose top is inside, or a pen
    // circle behind a photo, shows in the slide, cropped
    // to the frame, exactly as it looks on the board.
    cards: all.filter((it) => isCardItem(it) && cardOverlapsFrame(frame, it)),
    drawings: all.filter((it) =>
      ("Stroke" in it.kind && strokeOverlapsFrame(frame, it)) ||
      ("Connector" in it.kind && connectorOverlapsFrame(frame, it)),
    ),
  }));
}

function signature(list) {
  // Order matters here — it is the slide order — and a
  // card's position matters too, because a slide is a
  // layout, not a list: moving a card into, out of, or
  // inside a frame must re-render that slide. This
  // signature is NOT sorted, and it covers drawings too,
  // so a pen stroke moving into a frame re-renders it.
  const parts = [];
  for (const slide of list) {
    parts.push(`F${slide.frame.id}:${slide.frame.pos.x},${slide.frame.pos.y},${slide.frame.size.w}x${slide.frame.size.h}`);
    for (const it of slide.cards) {
      parts.push(`${it.id}:${JSON.stringify(it.kind)}:${it.pos.x},${it.pos.y},${it.size.w}x${it.size.h}`);
    }
    for (const it of slide.drawings) {
      // Drawings are not stringified whole: a pen stroke
      // can hold hundreds of points, and stringifying them
      // on every board event is the signature's main cost.
      // A stroke's points are fixed once it is drawn; the
      // only changes after that are a move (pos), a resize
      // (size) or a deletion, and a new stroke is a new id,
      // so id + pos + size + point count detects every real
      // change. A connector is different: its own pos/size
      // is unreliable, and its anchors are just two small
      // values, so connectors keep the full kind string.
      if ("Stroke" in it.kind) {
        const pts = it.kind.Stroke.points;
        parts.push(`S${it.id}:${it.pos.x},${it.pos.y},${it.size.w}x${it.size.h}:${Array.isArray(pts) ? pts.length : 0}`);
      } else {
        parts.push(`${it.id}:${JSON.stringify(it.kind)}`);
      }
    }
  }
  return parts.join("|");
}

// ---- Audio, in the playing view only ---------------------------------
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

function playPresentationAudio(item, tile) {
  const path = item.kind.Audio.path;
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
  presAudioSeek = stage ? stage.querySelector(`input.audio-seek[data-audio-seek="${item.id}"]`) : null;
  presAudioTime = stage ? stage.querySelector(`[data-audio-time="${item.id}"]`) : null;
  presAudioDur = stage ? stage.querySelector(`[data-audio-dur="${item.id}"]`) : null;
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

// ---- View: playing a slide -------------------------------------------
function startPresentation(at) {
  if (slides.length === 0) return;
  cancelDrawMode();
  pendingStartIndex = at;
  apiRef.view.setView("presentation");
}

function goTo(next) {
  if (slides.length === 0) return;
  const clamped = Math.max(0, Math.min(slides.length - 1, next));
  if (clamped === index) return;
  index = clamped;
  renderSlide();
  if (panelList) updatePanel();
}

function renderSlide() {
  if (!viewBuilt || !stage) return;
  stopPresentationAudio();
  stage.innerHTML = "";
  if (slides.length === 0) {
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
    const slide = slides[index];
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
        const html = apiRef.board.renderCard(item.id);
        if (!html) continue;
        const cardWrap = document.createElement("div");
        cardWrap.className = "pres-slide-card-wrap";
        cardWrap.style.left = `${(item.pos.x - frame.pos.x) * scale}px`;
        cardWrap.style.top = `${(item.pos.y - frame.pos.y) * scale}px`;
        cardWrap.style.width = `${item.size.w * scale}px`;
        cardWrap.style.height = `${item.size.h * scale}px`;
        cardWrap.innerHTML = html;
        const inner = cardWrap.firstElementChild;
        if (inner) {
          inner.style.transform = `scale(${scale})`;
          inner.style.transformOrigin = "top left";
        }
        wrap.appendChild(cardWrap);
        const seek = cardWrap.querySelector("input.audio-seek");
        if (seek) {
          seek.addEventListener("input", () => {
            if (presAudioItemId === item.id && presAudio && isFinite(presAudio.duration) && presAudio.duration > 0) {
              presAudio.currentTime = (Number(seek.value) / 1000) * presAudio.duration;
            }
          });
        }
      }
    }
    stage.appendChild(wrap);
  }
  if (counter) counter.textContent = slides.length === 0 ? "0 / 0" : `${index + 1} / ${slides.length}`;
  if (prevBtn) prevBtn.disabled = slides.length === 0 || index === 0;
  if (nextBtn) nextBtn.disabled = slides.length === 0 || index === slides.length - 1;
}

function syncFromBoard(force) {
  const next = computeSlides();
  const sig = signature(next);
  if (!force && sig === lastSignature) return false;
  slides = next;
  lastSignature = sig;
  if (index >= slides.length) index = Math.max(0, slides.length - 1);
  if (viewBuilt) renderSlide();
  if (panelList) updatePanel();
  return true;
}

function onStageClick(e) {
  if (!stage || slides.length === 0) return;
  const slide = slides[index];
  if (!slide) return;
  const target = e.target;
  if (!target || !target.closest) return;
  const cardEl = target.closest(".card");
  if (!cardEl || !cardEl.dataset.id) return;
  const item = slide.cards.find((it) => it.id === Number(cardEl.dataset.id));
  if (!item) return;
  // Audio plays in place, as on the board. Everything else
  // on a slide is inert: a click never advances, so a
  // video control or a link never moves you on.
  if (target.closest(".audio-tile")) {
    if ("Audio" in item.kind) playPresentationAudio(item, target.closest(".audio-tile"));
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
  prevBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5l-7 7 7 7" /></svg>`;
  prevBtn.title = "Previous (Left arrow)";
  prevBtn.setAttribute("aria-label", "Previous slide");
  prevBtn.addEventListener("click", () => goTo(index - 1));
  stage = document.createElement("div");
  stage.className = "pres-stage";
  stage.addEventListener("click", onStageClick);
  nextBtn = document.createElement("button");
  nextBtn.className = "pres-nav";
  nextBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5l7 7-7 7" /></svg>`;
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
  controls.append(counter, hint);
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

// ---- Panel ------------------------------------------------------------
function updatePanel() {
  if (!panelList) return;
  // Play and Export only make sense when there is
  // something to play or export: with no slides both
  // are disabled, so the panel guides you to Draw first
  // instead of opening or exporting an empty presentation.
  if (panelPlayBtn) panelPlayBtn.disabled = slides.length === 0;
  if (panelExportBtn) panelExportBtn.disabled = slides.length === 0;
  panelList.innerHTML = "";
  if (slides.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pres-panel-empty";
    empty.textContent = "No slides yet. Draw one on the board.";
    panelList.appendChild(empty);
    return;
  }
  slides.forEach((slide, i) => {
    const row = document.createElement("div");
    row.className = "pres-panel-row";
    if (apiRef.view.getView() === "presentation" && i === index) row.classList.add("active");
    row.title = "Show this slide on the board";
    row.addEventListener("click", () => {
      if (apiRef.view.getView() === "presentation") {
        goTo(i);
      } else {
        apiRef.view.centreOn(slide.frame.id);
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
    const move = (delta) => {
      const all = apiRef.board.getItems();
      const frames = all.filter(isFrameItem);
      const target = frames[i + delta];
      if (!target) return;
      const targetIndex = all.findIndex((it) => it.id === target.id);
      apiRef.board.moveItem(slide.frame.id, targetIndex);
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
    down.disabled = i === slides.length - 1;
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
      apiRef.board.removeItem(slide.frame.id);
    });
    row.append(thumb, name, up, down, play, del);
    panelList.appendChild(row);
  });
}

// ---- Export -----------------------------------------------------------

// One escaping function for both text and attribute
// values in the export: escaping " as well as &, <, >
// is harmless in text, and required in attributes, so
// there is no need for two near-identical functions.
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A media file too large to embed in the export,
// by name and megabytes, for the toast after export.
let oversizedExportFiles = [];
// Oversized files by URL, so the embed step can swap
// in the placeholder instead of a dead app-file URL.
const oversizedByUrl = new Map();
// Embedding is base64, so a file costs ~1.37x its size
// in the output HTML and in memory while reading it: a
// single large video could balloon the export into
// hundreds of megabytes and hang it. Files over the cap
// are skipped, not read, and the export says so instead
// of shipping a dead app-file URL.
const EXPORT_FILE_MB = 25;
async function fetchDataUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > EXPORT_FILE_MB * 1024 * 1024) {
      const name = decodeURIComponent(url.split("/").pop() || "media file");
      const mb = Math.round(blob.size / 1024 / 1024);
      oversizedExportFiles.push({ name, mb });
      oversizedByUrl.set(url, oversizedPlaceholder(name, mb));
      return null;
    }
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
// A placeholder image for media skipped as too large:
// an inline SVG naming the file, so the slide shows
// what is missing instead of a broken image.
function oversizedPlaceholder(name, mb) {
  const text = `${name} — too large to embed (${mb} MB)`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#f5f5f7"/><text x="16" y="90" font-family="sans-serif" font-size="13" fill="#86868b">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function embedAppFiles(html) {
  // Embed in parallel, not one file at a time: a slide
  // with several images or videos used to wait for each
  // fetch + FileReader in turn, so export time grew
  // with the number of media files. The replacements
  // are independent (distinct URLs, string splits), so
  // running them together changes nothing about the
  // result, only how long it takes to get there.
  const urls = [...new Set(html.match(/app-file:\/\/[^"'\s<>]+/g) || [])];
  const dataUrls = await Promise.all(urls.map((url) => fetchDataUrl(url)));
  let out = html;
  urls.forEach((url, i) => {
    if (dataUrls[i]) out = out.split(url).join(dataUrls[i]);
    else if (oversizedByUrl.has(url)) out = out.split(url).join(oversizedByUrl.get(url));
  });
  return out;
}

function exportSlideSvg(slide) {
  const frame = slide.frame;
  let parts = "";
  for (const prim of drawingPrimitives(frame, slide.drawings)) {
    if (prim.type === "stroke") {
      parts += `<path d="${prim.d}" fill="none" stroke="${escHtml(prim.color)}" stroke-width="${prim.width}" stroke-linecap="round" stroke-linejoin="round"${prim.marker ? ' opacity="0.45"' : ""}/>`;
    } else {
      parts += `<line x1="${prim.a.x}" y1="${prim.a.y}" x2="${prim.b.x}" y2="${prim.b.y}" stroke="${escHtml(prim.color)}" stroke-width="2"/><polyline points="${prim.p1.x},${prim.p1.y} ${prim.b.x},${prim.b.y} ${prim.p2.x},${prim.p2.y}" fill="none" stroke="${escHtml(prim.color)}" stroke-width="2"/>`;
    }
  }
  if (!parts) return "";
  return `<svg width="${frame.size.w}" height="${frame.size.h}" viewBox="0 0 ${frame.size.w} ${frame.size.h}" style="position:absolute;left:0;top:0">${parts}</svg>`;
}

async function exportCardHtml(item, frame) {
  if ("Audio" in item.kind) {
    // The board's audio tile is a button that only the core
    // can play, so in a standalone file it would do nothing.
    // Export a native audio player instead, with the file
    // embedded, so the audio actually plays in the export.
    const path = item.kind.Audio.path;
    const name = path.split("/").pop() || "Audio";
    const dataUrl = await fetchDataUrl(apiRef.files.fileUrl(path));
    if (!dataUrl) {
      // Too large (or unreadable): a dead app-file URL
      // would play nothing in a standalone file, so say
      // so on the card instead.
      const over = oversizedExportFiles.find((f) => f.name === name);
      const note = over ? `${name} — too large to embed (${over.mb} MB)` : `${name} — could not be embedded`;
      return `<div class="card" data-id="${item.id}" style="left:0px;top:0px;width:${item.size.w}px;height:${item.size.h}px"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px"><div class="title">${escHtml(note)}</div></div></div>`;
    }
    return `<div class="card" data-id="${item.id}" style="left:0px;top:0px;width:${item.size.w}px;height:${item.size.h}px"><div class="inner" style="padding:12px;display:flex;flex-direction:column;gap:8px"><div class="title">${escHtml(name)}</div><audio controls src="${escHtml(dataUrl)}" style="width:100%"></audio></div></div>`;
  }
  let html = apiRef.board.renderCard(item.id);
  if (!html) return "";
  if ("UrlCard" in item.kind) {
    // Link cards in the app are buttons that only the core
    // can open, so in a standalone file they would do
    // nothing. Turn them into real links to the URL.
    const href = escHtml(item.kind.UrlCard.url);
    html = html.replace(/<a ([^>]*?)data-action="open-link"([^>]*?)>/g, (_m, before, after) => {
      const attrs = (before + " " + after).replace(/\s*data-id="[^"]*"/g, "").trim();
      return `<a ${attrs} href="${href}" target="_blank" rel="noopener">`;
    });
  }
  if ("Video" in item.kind && item.kind.Video.remote) {
    // A remote video on the board is a thumbnail button
    // that only the core can open, so in a standalone
    // file it would do nothing. Turn it into a link to
    // the video, keeping its inline size.
    const href = escHtml(item.kind.Video.source);
    html = html.replace(/<div class="video-thumb clickable"[^>]*style="([^"]*)"[^>]*>([^<]*)<\/div>/, `<a class="video-thumb" style="$1" href="${href}" target="_blank" rel="noopener">$2</a>`);
  }
  return await embedAppFiles(html);
}

async function exportSlides() {
  if (!apiRef || slides.length === 0) return;
  oversizedExportFiles = [];
  oversizedByUrl.clear();
  const btn = panelExportBtn;
  const originalHtml = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Exporting…";
  }
  try {
    let sections = "";
    for (let si = 0; si < slides.length; si++) {
      const slide = slides[si];
      const frame = slide.frame;
      // Cards in a slide are independent, and
      // Promise.all keeps their order, so a slide's
      // cards embed in parallel instead of one by one.
      const cardHtmls = await Promise.all(slide.cards.map((item) => exportCardHtml(item, frame)));
      let cardsHtml = "";
      slide.cards.forEach((item, i) => {
        const html = cardHtmls[i];
        if (!html) return;
        cardsHtml += `<div style="position:absolute;left:${item.pos.x - frame.pos.x}px;top:${item.pos.y - frame.pos.y}px;width:${item.size.w}px;height:${item.size.h}px">${html}</div>`;
      });
      // The first slide is active in the HTML itself, so
      // the page shows a slide even without JavaScript;
      // the script below then takes over navigation.
      const active = si === 0 ? " active" : "";
      sections += `<section class="slide${active}" style="width:${frame.size.w}px;height:${frame.size.h}px">${exportSlideSvg(slide)}${cardsHtml}</section>`;
    }
    const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bowerbird slides</title>
<style>
:root { --accent:#007aff; --ink:#1d1d1f; --grey:#86868b; --hairline:rgba(0,0,0,0.08); --separator:rgba(0,0,0,0.10); --bg-system:#f5f5f7; --shadow-sm:0 1px 2px rgba(0,0,0,0.06); }
body { margin:0; padding:32px; background:var(--bg-system); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif; letter-spacing:-0.01em; display:flex; flex-direction:column; align-items:center; gap:16px; }
.export-nav { display:flex; align-items:center; gap:16px; }
.export-nav button { flex:none; width:48px; height:48px; border:none; background:transparent; border-radius:9px; cursor:pointer; color:var(--grey); display:flex; align-items:center; justify-content:center; }
.export-nav button svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.export-nav button:hover { background:rgba(0,0,0,0.05); color:var(--ink); }
.export-nav button:disabled { opacity:0.35; cursor:default; }
.export-nav button:disabled:hover { background:transparent; color:var(--grey); }
.export-counter { color:var(--grey); font-size:13px; font-weight:500; min-width:48px; text-align:center; }
.export-hint { color:var(--grey); font-size:12px; }
.slide { display:none; position:relative; margin:0; background:#fff; border:1px solid var(--hairline); border-radius:12px; box-shadow:var(--shadow-sm); overflow:hidden; }
.slide.active { display:block; }
.card { position:absolute; background:#fff; border:1px solid var(--hairline); border-radius:12px; overflow:hidden; box-shadow:var(--shadow-sm); pointer-events:none; }
.card a, .card video, .card audio { pointer-events:auto; }
.card .inner { width:100%; height:100%; overflow:hidden; }
.card .note-body { padding:14px; line-height:1.55; word-wrap:break-word; }
.card .note-body p { margin:0 0 6px; }
.card .note-body h1, .card .note-body h2, .card .note-body h3 { margin:0 0 6px; line-height:1.3; font-weight:700; letter-spacing:-0.02em; }
.card .note-body h1 { font-size:1.5em; } .card .note-body h2 { font-size:1.25em; } .card .note-body h3 { font-size:1.1em; }
.card .note-body pre { background:var(--bg-system); border-radius:8px; padding:8px 10px; overflow:hidden; margin:0 0 6px; white-space:pre-wrap; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.9em; }
.card .note-body code { background:var(--bg-system); border-radius:4px; padding:1px 4px; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.9em; }
.card .note-body blockquote { margin:0 0 6px; padding-left:10px; color:var(--grey); border-left:2px solid var(--separator); }
.card .note-body a { color:var(--accent); text-decoration:none; } .card .note-body a:hover { text-decoration:underline; }
.card .row { display:flex; align-items:center; gap:12px; padding:12px; height:100%; }
.card .col { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.card .title { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card .sub { color:var(--grey); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card .tile { flex:none; width:56px; height:56px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:24px; }
.card .link-card { display:flex; flex-direction:column; height:100%; }
.card .link-image { display:block; flex:none; height:168px; overflow:hidden; background:var(--bg-system); }
.card .link-image img { width:100%; height:100%; object-fit:cover; display:block; }
.card .link-body { flex:1; min-height:0; display:flex; flex-direction:column; gap:6px; padding:12px 14px 12px; }
.card .link-card.no-image .link-body { padding:14px; justify-content:center; }
.card a.link-title { color:var(--ink); text-decoration:none; font-size:15px; font-weight:600; line-height:1.35; letter-spacing:-0.01em; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.card a.link-title:hover { color:var(--accent); }
.card .link-desc { color:var(--grey); font-size:13px; line-height:1.45; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.card .link-card.no-image .link-desc { -webkit-line-clamp:3; }
.card .link-footer { margin-top:auto; padding-top:2px; }
.card a.link-domain { display:flex; align-items:center; gap:6px; color:var(--grey); text-decoration:none; font-size:12px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card a.link-domain:hover { color:var(--ink); }
.card a.link-domain .favicon { width:16px; height:16px; border-radius:4px; flex:none; object-fit:cover; }
.card a.link-domain .favicon-fallback { width:16px; height:16px; border-radius:4px; flex:none; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; }
.card a.link-domain svg { width:13px; height:13px; flex:none; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.card .swatch-pill { position:absolute; right:10px; bottom:10px; background:rgba(255,255,255,0.92); border:1px solid var(--hairline); border-radius:8px; padding:4px 8px; font-weight:600; font-size:12px; box-shadow:var(--shadow-sm); }
.card .video-thumb { position:relative; background:#1d1d1f; border-radius:10px; display:flex; align-items:center; justify-content:center; color:#fff; text-decoration:none; }
@media print {
  body { display:block; background:#fff; padding:0; }
  .export-nav, .export-hint { display:none; }
  .slide { display:block !important; margin:0 auto; page-break-after:always; box-shadow:none; border:1px solid #ddd; }
  .slide:last-child { page-break-after:auto; }
}
</style>
</head>
<body>
<nav class="export-nav"><button id="export-prev" aria-label="Previous slide" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5l-7 7 7 7" /></svg></button><span class="export-counter" id="export-counter">1 / ${slides.length}</span><button id="export-next" aria-label="Next slide"${slides.length <= 1 ? " disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5l7 7-7 7" /></svg></button></nav>
${sections}
<div class="export-hint">← → to move</div>
<script>
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var prev = document.getElementById('export-prev');
  var next = document.getElementById('export-next');
  var counter = document.getElementById('export-counter');
  var index = 0;
  function show(i) {
    if (slides.length === 0) return;
    index = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach(function (s, j) {
      s.classList.toggle('active', j === index);
      if (j !== index) s.querySelectorAll('video, audio').forEach(function (m) { m.pause(); });
    });
    counter.textContent = (index + 1) + ' / ' + slides.length;
    prev.disabled = index === 0;
    next.disabled = index === slides.length - 1;
  }
  prev.addEventListener('click', function () { show(index - 1); });
  next.addEventListener('click', function () { show(index + 1); });
  document.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === ' ') {
      if (tag === 'BUTTON') return;
      e.preventDefault();
      show(index + 1);
    }
  });
  show(0);
})();
</script>
</body>
</html>`;
    const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bowerbird-slides.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (oversizedExportFiles.length > 0) {
      const names = oversizedExportFiles.map((f) => `${f.name} (${f.mb} MB)`).join(", ");
      apiRef.ui.toast(`Downloading slides… ${names} too large to embed (over ${EXPORT_FILE_MB} MB) — shown as a placeholder instead.`);
    } else {
      apiRef.ui.toast("Downloading slides…");
    }
  } catch (e) {
    if (apiRef) apiRef.ui.toast(`Export failed: ${String(e)}`);
  } finally {
    if (btn) {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
    if (panelList) updatePanel();
  }
}

function initPanel(body) {
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
  panelPlayBtn = play;
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
  panelList = document.createElement("div");
  panelList.className = "pres-panel-list";
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
  panelExportBtn = exportBtn;
  body.appendChild(exportBtn);
  syncFromBoard(true);
}

// ---- Draw mode --------------------------------------------------------

function boardGeometry() {
  const el = document.getElementById("board");
  if (!el) return { w: window.innerWidth, h: window.innerHeight, left: 0, top: 0 };
  const r = el.getBoundingClientRect();
  return { w: el.clientWidth, h: el.clientHeight, left: r.left, top: r.top };
}

function cancelDrawMode() {
  if (!drawActive) return;
  drawActive = false;
  drawStart = null;
  drawMoved = false;
  if (drawLayer) drawLayer.style.display = "none";
  if (drawInstruction) drawInstruction.style.display = "none";
  if (drawPreview) drawPreview.style.display = "none";
  if (drawKeyHandler) window.removeEventListener("keydown", drawKeyHandler, true);
}

function startDrawMode() {
  if (!apiRef) return;
  // Frames are drawn on the board, not on a slide, so
  // drawing always returns to the board first.
  if (apiRef.view.getView() !== "board") apiRef.view.setView("board");
  if (!drawLayer || !drawInstruction) return;
  drawActive = true;
  drawStart = null;
  drawMoved = false;
  drawLayer.style.display = "block";
  drawInstruction.style.display = "flex";
  if (drawPreview) drawPreview.style.display = "none";
  if (!drawKeyHandler) {
    drawKeyHandler = (e) => {
      if (!drawActive) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelDrawMode();
      }
    };
  }
  window.addEventListener("keydown", drawKeyHandler, true);
}

function initOverlay(container) {
  drawLayer = document.createElement("div");
  drawLayer.className = "pres-draw-layer";
  drawLayer.style.display = "none";
  drawPreview = document.createElement("div");
  drawPreview.className = "pres-draw-preview";
  drawPreview.style.display = "none";
  drawLayer.appendChild(drawPreview);
  container.appendChild(drawLayer);
  drawInstruction = document.createElement("div");
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

  const onMove = (me) => {
    if (!drawActive || !drawStart || !drawPreview || !drawLayer) return;
    const layerRect = drawLayer.getBoundingClientRect();
    const x0 = drawStart.x;
    const y0 = drawStart.y;
    const x1 = me.clientX - layerRect.left;
    const y1 = me.clientY - layerRect.top;
    if (Math.hypot(me.clientX - drawStart.clientX, me.clientY - drawStart.clientY) > 5) drawMoved = true;
    drawPreview.style.display = "block";
    drawPreview.style.left = `${Math.min(x0, x1)}px`;
    drawPreview.style.top = `${Math.min(y0, y1)}px`;
    drawPreview.style.width = `${Math.abs(x1 - x0)}px`;
    drawPreview.style.height = `${Math.abs(y1 - y0)}px`;
  };
  // Same blur cleanup as Visual Library: a release
  // outside the window never fires mouseup on it, so
  // without this the draw listeners would linger and
  // the next mouse move would keep drawing a frame.
  const cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("blur", onBlur);
  };
  const onBlur = () => {
    cleanup();
    if (drawPreview) drawPreview.style.display = "none";
    drawStart = null;
    drawMoved = false;
  };
  const onUp = (me) => {
    cleanup();
    if (!drawActive || !drawStart || !drawLayer) return;
    const layerRect = drawLayer.getBoundingClientRect();
    const x0 = drawStart.x;
    const y0 = drawStart.y;
    const x1 = me.clientX - layerRect.left;
    const y1 = me.clientY - layerRect.top;
    if (drawPreview) drawPreview.style.display = "none";
    // A click without a drag creates nothing, and stays in
    // draw mode, so the user can try again immediately.
    if (!drawMoved) {
      drawStart = null;
      return;
    }
    drawStart = null;
    drawMoved = false;
    const clientLeft = Math.min(x0, x1);
    const clientTop = Math.min(y0, y1);
    const clientW = Math.abs(x1 - x0);
    const clientH = Math.abs(y1 - y0);
    const cam = apiRef.view.getCamera();
    const b = boardGeometry();
    const worldLeft = (clientLeft + layerRect.left - b.left) / cam.zoom + cam.x;
    const worldTop = (clientTop + layerRect.top - b.top) / cam.zoom + cam.y;
    const worldW = clientW / cam.zoom;
    const worldH = clientH / cam.zoom;
    if (worldW < 48 || worldH < 48) {
      apiRef.ui.toast("Draw a larger rectangle");
      return;
    }
    const id = apiRef.board.addPluginCard("slide", {}, { x: worldLeft, y: worldTop }, { w: worldW, h: worldH });
    cancelDrawMode();
    apiRef.board.setSelected([id]);
  };
  drawLayer.addEventListener("mousedown", (e) => {
    if (!drawActive || e.button !== 0) return;
    const layerRect = drawLayer.getBoundingClientRect();
    drawStart = {
      x: e.clientX - layerRect.left,
      y: e.clientY - layerRect.top,
      clientX: e.clientX,
      clientY: e.clientY,
    };
    drawMoved = false;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
  });
}

// ---- Lifecycle --------------------------------------------------------
function activate(api) {
  apiRef = api;
  onBoardHandler = () => syncFromBoard(false);
  apiRef.events.on("board", onBoardHandler);
  onViewHandler = () => {
    // Switching away from the board — for example, via
    // the view switcher while drawing — must not leave
    // the draw layer over a view, with its instruction
    // bar saying "Drag to draw" over a slide.
    if (apiRef && apiRef.view.getView() !== "board") cancelDrawMode();
  };
  apiRef.events.on("view", onViewHandler);
  resizeHandler = () => {
    if (viewBuilt) renderSlide();
  };
  window.addEventListener("resize", resizeHandler);
  apiRef.cards.register({
    kind: "slide",
    title: "Slide",
    frame: true,
    render: (item) => {
      // The slide number is its position among frames in
      // board order, computed at render time, not stored,
      // so deleting a frame renumbers the rest correctly.
      let number = "";
      if (apiRef) {
        const frames = apiRef.board.getItems().filter(isFrameItem);
        const idx = frames.findIndex((f) => f.id === item.id);
        if (idx >= 0) number = ` ${idx + 1}`;
      }
      return `<div class="pres-slide-label">Slide${number}</div>`;
    },
    onDoubleClick: (item) => {
      const frames = apiRef.board.getItems().filter(isFrameItem);
      const idx = frames.findIndex((f) => f.id === item.id);
      startPresentation(idx >= 0 ? idx : 0);
    },
    searchText: () => "Slide",
  });
  apiRef.ui.registerPanel({
    id: "slides",
    title: "Presentation",
    // A screen with a play triangle, as the panel's own
    // Play button is: a slide, played.
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 9l4 2-4 2z" fill="currentColor" stroke="none"/></svg>',
    render: (container) => initPanel(container),
  });
  apiRef.ui.registerView({
    id: "presentation",
    title: "Presentation",
    render: (container) => {
      // Core re-renders the active view on every board
      // render; sync only when the board's slides actually
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
      // A presentation always starts where it was asked
      // to start: first slide from Play or the view
      // switcher, or the slide that was double-clicked
      // or chosen in the panel. This runs after the
      // view's first render, in the same tick, so no
      // intermediate slide is painted.
      if (pendingStartIndex !== null) {
        index = Math.max(0, Math.min(slides.length - 1, pendingStartIndex));
        pendingStartIndex = null;
      } else {
        index = 0;
      }
      if (viewBuilt) renderSlide();
      if (panelList) updatePanel();
    },
    onHide: () => {
      window.removeEventListener("keydown", onKeyDown, true);
      stopPresentationAudio();
      cancelDrawMode();
      viewContainerClear();
    },
  });
  apiRef.ui.registerOverlay({
    id: "draw-slide",
    render: (container) => initOverlay(container),
  });
}

function deactivate() {
  window.removeEventListener("keydown", onKeyDown, true);
  cancelDrawMode();
  stopPresentationAudio();
  if (apiRef && onBoardHandler) apiRef.events.off("board", onBoardHandler);
  if (apiRef && onViewHandler) apiRef.events.off("view", onViewHandler);
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  onBoardHandler = null;
  onViewHandler = null;
  resizeHandler = null;
  panelList = null;
  panelPlayBtn = null;
  panelExportBtn = null;
  drawLayer = null;
  drawInstruction = null;
  drawPreview = null;
  viewContainerClear();
  apiRef = null;
}

export { activate, deactivate };
