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
// play in frame creation order — the order frames appear
// on the board — and a new frame always goes last, so
// creating slides in presentation order is creating them
// in play order. Clicking a frame to move it never reorders
// its slides: core never brings a frame to the front, so
// frame order only changes when a frame is created or
// deleted.
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

function rectsOverlap(a, b) {
  // Strict overlap: a card that only touches the frame's
  // edge, with no area inside, shows nothing in the slide.
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function cardOverlapsFrame(frame, item) {
  return rectsOverlap(
    { x: frame.pos.x, y: frame.pos.y, w: frame.size.w, h: frame.size.h },
    { x: item.pos.x, y: item.pos.y, w: item.size.w, h: item.size.h },
  );
}

// Where a segment from `from` to `to` crosses a rectangle,
// as the core's rectCrossing does (Liang-Barsky): entry
// is the first crossing, exit the second. Used both for
// clipping a connector to its cards, and for testing
// whether a stroke or connector segment enters a frame.
function rectCrossing(from, to, pos, w, h, entry) {
  const dx = to.x - from.x, dy = to.y - from.y;
  let t0 = 0, t1 = 1;
  for (const [o, d, lo, hi] of [[from.x, dx, pos.x, pos.x + w], [from.y, dy, pos.y, pos.y + h]]) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
  }
  const t = entry ? t0 : t1;
  if (t < 0 || t > 1) return null;
  return { x: from.x + dx * t, y: from.y + dy * t };
}

function segmentIntersectsFrame(frame, a, b) {
  // A segment enters the frame if its clipped interval
  // overlaps the segment at all — that is, if any part
  // of it, however short, is inside, as a screenshot
  // of the frame area would show.
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  for (const [o, d, lo, hi] of [[a.x, dx, frame.pos.x, frame.pos.x + frame.size.w], [a.y, dy, frame.pos.y, frame.pos.y + frame.size.h]]) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return t0 <= t1;
}

function strokeOverlapsFrame(frame, item) {
  const points = item.kind.Stroke.points;
  if (points.length < 2) return false;
  for (let i = 0; i + 1 < points.length; i++) {
    if (segmentIntersectsFrame(frame, points[i], points[i + 1])) return true;
  }
  return false;
}

function anchorPoint(all, anchor) {
  if ("Point" in anchor) return anchor.Point;
  const it = all.find((x) => x.id === anchor.Item);
  return it ? { x: it.pos.x + it.size.w / 2, y: it.pos.y + it.size.h / 2 } : null;
}

function clippedConnectorEnds(all, item) {
  const aRaw = anchorPoint(all, item.kind.Connector.from);
  const bRaw = anchorPoint(all, item.kind.Connector.to);
  if (!aRaw || !bRaw) return null;
  let a = aRaw, b = bRaw;
  if ("Item" in item.kind.Connector.from) {
    const it = all.find((x) => x.id === item.kind.Connector.from.Item);
    if (it) {
      const p = rectCrossing(aRaw, bRaw, it.pos, it.size.w, it.size.h, false);
      if (p) a = p;
    }
  }
  if ("Item" in item.kind.Connector.to) {
    const it = all.find((x) => x.id === item.kind.Connector.to.Item);
    if (it) {
      const p = rectCrossing(aRaw, bRaw, it.pos, it.size.w, it.size.h, true);
      if (p) b = p;
    }
  }
  return [a, b];
}

function connectorOverlapsFrame(all, frame, item) {
  const ends = clippedConnectorEnds(all, item);
  if (!ends) return false;
  return segmentIntersectsFrame(frame, ends[0], ends[1]);
}

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
      ("Connector" in it.kind && connectorOverlapsFrame(all, frame, it)),
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
      parts.push(`${it.id}:${JSON.stringify(it.kind)}`);
    }
  }
  return parts.join("|");
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
        const all = apiRef.board.getItems();
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "pres-slide-svg");
        svg.setAttribute("width", String(frame.size.w * scale));
        svg.setAttribute("height", String(frame.size.h * scale));
        svg.setAttribute("viewBox", `0 0 ${frame.size.w} ${frame.size.h}`);
        svg.style.position = "absolute";
        svg.style.left = "0";
        svg.style.top = "0";
        for (const item of slide.drawings) {
          if ("Stroke" in item.kind) {
            const points = item.kind.Stroke.points;
            if (points.length < 2) continue;
            const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x - frame.pos.x},${p.y - frame.pos.y}`).join(" ");
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", d);
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", item.kind.Stroke.color);
            path.setAttribute("stroke-width", String(item.kind.Stroke.width));
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("stroke-linejoin", "round");
            if (item.kind.Stroke.marker) path.setAttribute("opacity", "0.45");
            svg.appendChild(path);
          }
          if ("Connector" in item.kind) {
            const ends = clippedConnectorEnds(all, item);
            if (!ends) continue;
            const a = { x: ends[0].x - frame.pos.x, y: ends[0].y - frame.pos.y };
            const b = { x: ends[1].x - frame.pos.x, y: ends[1].y - frame.pos.y };
            const color = item.kind.Connector.color || "#333333";
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", String(a.x));
            line.setAttribute("y1", String(a.y));
            line.setAttribute("x2", String(b.x));
            line.setAttribute("y2", String(b.y));
            line.setAttribute("stroke", color);
            line.setAttribute("stroke-width", "2");
            svg.appendChild(line);
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.max(1, Math.hypot(dx, dy));
            const ux = dx / len, uy = dy / len;
            const head = 12, spread = 0.45;
            const c1 = Math.cos(spread), s1 = Math.sin(spread), c2 = Math.cos(-spread), s2 = Math.sin(-spread);
            const p1 = { x: b.x - head * (ux * c1 - uy * s1), y: b.y - head * (ux * s1 + uy * c1) };
            const p2 = { x: b.x - head * (ux * c2 - uy * s2), y: b.y - head * (ux * s2 + uy * c2) };
            const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
            arrow.setAttribute("points", `${p1.x},${p1.y} ${b.x},${b.y} ${p2.x},${p2.y}`);
            arrow.setAttribute("fill", "none");
            arrow.setAttribute("stroke", color);
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

function updatePanel() {
  if (!panelList) return;
  // Play is the primary action, but only when there is
  // something to play: with no slides it is disabled, so
  // the panel guides you to Draw first instead of
  // opening an empty presentation.
  if (panelPlayBtn) panelPlayBtn.disabled = slides.length === 0;
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
    row.title = "Show this slide on the board";
    row.addEventListener("click", () => {
      if (apiRef.view.getView() === "presentation") {
        goTo(i);
      } else {
        apiRef.view.centreOn(slide.frame.id);
      }
    });
    const name = document.createElement("span");
    name.className = "pres-panel-name";
    name.textContent = `Slide ${i + 1}`;
    const play = document.createElement("button");
    play.className = "pres-panel-icon-btn";
    play.textContent = "▶";
    play.title = `Play from Slide ${i + 1}`;
    play.setAttribute("aria-label", `Play from Slide ${i + 1}`);
    play.addEventListener("click", (e) => {
      e.stopPropagation();
      startPresentation(i);
    });
    const del = document.createElement("button");
    del.className = "pres-panel-icon-btn";
    del.textContent = "×";
    del.title = `Delete Slide ${i + 1}`;
    del.setAttribute("aria-label", `Delete Slide ${i + 1}`);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      apiRef.board.removeItem(slide.frame.id);
    });
    row.append(name, play, del);
    panelList.appendChild(row);
  });
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
  syncFromBoard(true);
}

// ---------------------------------------------------------------- draw mode

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
  const onUp = (me) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
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
  });
}

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
  drawLayer = null;
  drawInstruction = null;
  drawPreview = null;
  viewContainerClear();
  apiRef = null;
}

export { activate, deactivate };
