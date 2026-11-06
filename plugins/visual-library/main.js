// Visual Library — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// There is no special library folder and no separate library
// file store. The library IS the board: it shows the board's
// own elements — every card on the whiteboard, in both modes —
// rendered by the core itself (api.board.renderCard), so a
// library card is the same card as on the board, at the same
// aspect ratio (the board item's width/height, not the file's
// natural ratio, not a thumbnail ratio). The card is scaled
// uniformly to its masonry column width, so its shape never
// changes, only its size.
//
//  - Panel mode: a panel in the right dock, flush against the
//    window edge, full height, over the board. One column, so
//    board cards stay readable in the narrow panel.
//  - Whiteboard mode: a view replacing the canvas, laid out
//    like Pinterest, several columns wide.
// The search box is shared, and the mode switch is a single
// icon button beside it (masonry icon for whiteboard, sidebar
// icon for panel).
//
// There is one category, Uncategorized, holding every board
// item in board order. Nothing is auto-categorised by kind.
// Drag therefore never moves anything between categories —
// it duplicates, as it always did.
//
// Clicking a library card focuses the original on the
// board: it centres on it and selects it, and adds nothing.
// Dragging it duplicates it at the drop point (panel mode:
// onto the visible board; whiteboard mode: at the drop
// point in camera coordinates, with a toast, since the
// board is hidden). The duplicate is an ordinary board
// item of the same kind and the same size as the original,
// so it appears in the library too — it is a board
// element. Media previews are the only interactions that
// do neither: a video's native controls play in place,
// and an audio tile plays in place.
//
// Strokes and connectors are not library elements: they are
// drawing and annotation, not cards, and duplicating them
// would need their board positions and item references. The
// library refreshes automatically when the board is saved, and
// the Refresh command still exists in Settings → Plugins for
// a manual refresh.
let apiRef = null;
let boardItems = [];
let query = "";
let collapsed = new Set();
let lastSignature = "";

// Panel refs (built once by initPanel).
let panelSearch = null;
let panelSections = null;

// View refs (built on each activation, cleared on hide).
let viewBuilt = false;
let viewSearch = null;
let viewSections = null;

let onBoardHandler = null;
let onSelectionHandler = null;
let resizeHandler = null;
// The panel's layout observers, so deactivate() can
// disconnect them instead of leaving a pair behind on
// every disable/re-enable cycle.
let panelIntersectionObserver = null;
let panelResizeObserver = null;

// One library audio preview at a time, played through a plain
// Audio element (the core's audio player belongs to the board).
let libAudio = null;
let libAudioItemId = null;
let libAudioTile = null;
let libAudioSeek = null;
let libAudioTime = null;
let libAudioDur = null;

// No categories are created for the user: every board item
// goes, by default, in a single "Uncategorized" section, in
// board order. A future category system (user-created
// categories, drag to move) would add sections here; for now
// there is exactly one, so the library never invents an
// organisation the user did not ask for.
const KIND_SINGULAR = { Audio: "audio", Image: "image", UrlCard: "link", PdfCard: "PDF", Plugin: "plugin card", Swatch: "swatch", Text: "text note", Video: "video" };
const LIBRARY_KINDS = new Set(["Audio", "Image", "UrlCard", "PdfCard", "Plugin", "Swatch", "Text", "Video"]);

function kindKey(item) {
  return Object.keys(item.kind)[0];
}

function isLibraryItem(item) {
  // Slide frames are containers, not content: a frame
  // border is not a library card, so kind "slide" is
  // excluded here, as Presentation's frames use it, and
  // any future frame plugin should use it too.
  if ("Plugin" in item.kind && item.kind.Plugin.kind === "slide") return false;
  return LIBRARY_KINDS.has(kindKey(item)) && item.size.w > 0 && item.size.h > 0;
}

function basename(path) {
  return (path || "").split("/").pop() || path || "";
}

function domainOfUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "";
  }
}

function formatAudioTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function searchText(item) {
  const k = item.kind;
  if ("Text" in k) return k.Text.text || "";
  if ("Image" in k) return basename(k.Image.path);
  if ("UrlCard" in k) return [k.UrlCard.title, k.UrlCard.url, k.UrlCard.description].filter(Boolean).join(" ");
  if ("PdfCard" in k) return basename(k.PdfCard.path);
  if ("Swatch" in k) return k.Swatch.hex || "";
  if ("Audio" in k) return basename(k.Audio.path);
  if ("Video" in k) return k.Video.remote ? domainOfUrl(k.Video.source) : basename(k.Video.source);
  if ("Plugin" in k) return `${k.Plugin.plugin} ${k.Plugin.kind} ${JSON.stringify(k.Plugin.data)}`;
  return "";
}

function sectionsList() {
  const q = query.trim().toLowerCase();
  const filtered = q ? boardItems.filter((it) => searchText(it).toLowerCase().includes(q)) : boardItems;
  // A search with no matches leaves a blank sections area.
  // With no query, even an empty library renders as a single
  // Uncategorized header (no text).
  if (q && filtered.length === 0) return [];
  return [{ key: "uncategorized", label: "Uncategorized", items: filtered }];
}

function signature(items) {
  // Deliberately NOT sorted: the library shows cards
  // in board order, so a reorder must change the
  // signature and refresh the view. (Presentation's
  // signature is unsorted for the same reason.)
  return items.map((it) => `${it.id}:${JSON.stringify(it.kind)}:${it.size.w}x${it.size.h}`).join("|");
}

function stopLibraryAudio() {
  if (libAudio) libAudio.pause();
  libAudio = null;
  libAudioItemId = null;
  libAudioTile = null;
  libAudioSeek = null;
  libAudioTime = null;
  libAudioDur = null;
}

function rewireLibraryAudio() {
  // After a re-render, point the playing preview's
  // tile, seek and time at the fresh DOM, so the
  // preview keeps playing and its controls keep
  // working instead of going dead on detached nodes.
  if (!libAudio || libAudioItemId === null) return;
  const wrap = [panelSections, viewSections]
    .map((c) => c && c.querySelector(`[data-board-id="${libAudioItemId}"]`))
    .find(Boolean);
  if (!wrap) {
    libAudioTile = null;
    libAudioSeek = null;
    libAudioTime = null;
    libAudioDur = null;
    return;
  }
  libAudioTile = wrap.querySelector(".audio-tile");
  libAudioSeek = wrap.querySelector("input.audio-seek");
  libAudioTime = wrap.querySelector("[data-audio-time]");
  libAudioDur = wrap.querySelector("[data-audio-dur]");
  if (libAudioTile) libAudioTile.textContent = libAudio.paused ? "▶" : "❚❚";
  if (libAudioDur && isFinite(libAudio.duration)) libAudioDur.textContent = formatAudioTime(libAudio.duration);
  if (libAudioTime) libAudioTime.textContent = formatAudioTime(libAudio.currentTime);
  if (libAudioSeek && isFinite(libAudio.duration) && libAudio.duration > 0) {
    libAudioSeek.value = String(Math.round((libAudio.currentTime / libAudio.duration) * 1000));
  }
}

function updateAllDynamic() {
  // A re-render drops the DOM the audio preview was wired
  // to, but the preview itself is a standalone Audio
  // object: keep it playing while its card is still on
  // the board, and re-wire its controls to the fresh DOM.
  // Only stop it when its card is gone.
  const playingId = libAudioItemId;
  if (panelSections) renderSections(panelSections, "panel");
  if (viewSections) renderSections(viewSections, "view");
  if (playingId !== null && libAudio) {
    if (boardItems.some((it) => it.id === playingId)) rewireLibraryAudio();
    else stopLibraryAudio();
  }
}

// Selection preview: when the board selection changes, the
// library marks the selected cards and scrolls the first one
// into view, so selecting on the board previews in the
// library and vice versa. No re-render: re-rendering would
// drop the scroll position and any audio preview.
function updateSelectionHighlight() {
  if (!apiRef) return;
  const selected = new Set(apiRef.board.getSelected());
  let first = null;
  for (const sections of [panelSections, viewSections]) {
    if (!sections) continue;
    for (const wrap of sections.querySelectorAll(".vl-board-wrap")) {
      const isSel = selected.has(Number(wrap.dataset.boardId));
      wrap.classList.toggle("vl-selected", isSel);
      if (isSel && !first) first = wrap;
    }
  }
  if (first && typeof first.scrollIntoView === "function") {
    try { first.scrollIntoView({ block: "nearest" }); } catch { /* older Chromium */ }
  }
}

function syncFromBoard(force) {
  const next = apiRef.board.getItems().filter(isLibraryItem);
  const sig = signature(next);
  if (!force && sig === lastSignature) return false;
  boardItems = next;
  lastSignature = sig;
  updateAllDynamic();
  return true;
}

// Board geometry lives in #board now, below the title bar:
// its client size is the visible board, and its top edge is
// the board's origin in client coordinates. Centre and drop
// points go through it, never window size or raw client
// coordinates, or a duplicate lands 48px low.
function boardGeometry() {
  const el = document.getElementById("board");
  if (!el) return { w: window.innerWidth, h: window.innerHeight, left: 0, top: 0 };
  const r = el.getBoundingClientRect();
  return { w: el.clientWidth, h: el.clientHeight, left: r.left, top: r.top };
}

function cameraCentreWorld() {
  const cam = apiRef.view.getCamera();
  const b = boardGeometry();
  return {
    x: cam.x + b.w / 2 / cam.zoom,
    y: cam.y + b.h / 2 / cam.zoom,
  };
}

function dropWorld(clientX, clientY) {
  const cam = apiRef.view.getCamera();
  const b = boardGeometry();
  return { x: (clientX - b.left) / cam.zoom + cam.x, y: (clientY - b.top) / cam.zoom + cam.y };
}

function duplicateAt(item, point, showToast) {
  const kind = JSON.parse(JSON.stringify(item.kind));
  const size = { w: item.size.w, h: item.size.h };
  apiRef.board.addItem(kind, { x: point.x - size.w / 2, y: point.y - size.h / 2 }, size);
  if (showToast) apiRef.ui.toast(`Duplicated ${KIND_SINGULAR[kindKey(item)] || "element"} to board`);
}

function playLibraryAudio(item, tile, wrap) {
  const path = item.kind.Audio.path;
  if (libAudioItemId === item.id && libAudio) {
    if (libAudio.paused) {
      libAudio.play().catch(() => undefined);
      tile.textContent = "❚❚";
    } else {
      libAudio.pause();
      tile.textContent = "▶";
    }
    return;
  }
  if (libAudio) {
    libAudio.pause();
    if (libAudioTile && libAudioTile.isConnected) libAudioTile.textContent = "▶";
  }
  const url = apiRef.files.fileUrl(path);
  const audio = new Audio(url);
  libAudio = audio;
  libAudioItemId = item.id;
  libAudioTile = tile;
  libAudioSeek = wrap.querySelector("input.audio-seek");
  libAudioTime = wrap.querySelector("[data-audio-time]");
  libAudioDur = wrap.querySelector("[data-audio-dur]");
  audio.addEventListener("loadedmetadata", () => {
    if (libAudioDur && libAudioDur.isConnected) libAudioDur.textContent = formatAudioTime(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    if (libAudioSeek && libAudioSeek.isConnected) libAudioSeek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    if (libAudioTime && libAudioTime.isConnected) libAudioTime.textContent = formatAudioTime(audio.currentTime);
  });
  audio.addEventListener("ended", () => {
    if (libAudioTile && libAudioTile.isConnected) libAudioTile.textContent = "▶";
    stopLibraryAudio();
  });
  audio.play().catch(() => undefined);
  tile.textContent = "❚❚";
}

function isMediaTarget(target) {
  if (!target || !target.closest) return false;
  return Boolean(target.closest("video") || target.closest("input.audio-seek") || target.closest(".audio-tile"));
}

// Audio durations by path, for the session: every
// library re-render used to spawn a throwaway Audio
// element per audio card just to read its duration, so
// a board with several audio cards re-fetched metadata
// on every board change. A path's duration does not
// change while the app runs.
const libAudioDurations = new Map();
function loadLibraryAudioDuration(wrap, item) {
  const dur = wrap.querySelector("[data-audio-dur]");
  if (!dur || dur.textContent !== "–:––") return;
  const path = item.kind.Audio.path;
  const cached = libAudioDurations.get(path);
  if (cached !== undefined) {
    dur.textContent = formatAudioTime(cached);
    return;
  }
  const audio = new Audio(apiRef.files.fileUrl(path));
  audio.addEventListener("loadedmetadata", () => {
    libAudioDurations.set(path, audio.duration);
    if (wrap.isConnected && dur.isConnected) dur.textContent = formatAudioTime(audio.duration);
  });
  audio.addEventListener("error", () => {});
}

function focusOnBoard(item, mode) {
  // Focus, not duplication: show the original on the
  // board, centred and selected, and add nothing.
  // In whiteboard view mode, clicking a card must NOT
  // leave the library: it only selects the card in
  // place (the library's selection highlight follows),
  // and the board view stays hidden behind the view.
  // Panel mode keeps the old behaviour: go back to the
  // board first, then centre on the original.
  if (mode === "view") {
    apiRef.board.setSelected([item.id]);
    return;
  }
  if (apiRef.view.getView() !== "board") apiRef.view.setView("board");
  apiRef.board.setSelected([item.id]);
  apiRef.view.centreOn(item.id);
}

function attachCardInteractions(wrap, item, mode) {
  wrap.addEventListener("click", (e) => {
    // Media previews do not focus either. Everything else
    // on the card — including a link's title and image —
    // focuses the original on the board. Dragging, below,
    // is still how a card is duplicated.
    if (isMediaTarget(e.target)) return;
    focusOnBoard(item, mode);
  });
  const tile = wrap.querySelector(".audio-tile");
  if (tile) {
    tile.addEventListener("click", () => playLibraryAudio(item, tile, wrap));
  }
  const seek = wrap.querySelector("input.audio-seek");
  if (seek) {
    seek.addEventListener("input", () => {
      if (libAudioItemId === item.id && libAudio && isFinite(libAudio.duration) && libAudio.duration > 0) {
        libAudio.currentTime = (Number(seek.value) / 1000) * libAudio.duration;
      }
    });
  }
  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || isMediaTarget(e.target)) return;
    let moved = false;
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost = null;
    const onMove = (me) => {
      if (!moved && Math.hypot(me.clientX - startX, me.clientY - startY) > 5) {
        moved = true;
        ghost = document.createElement("div");
        ghost.className = "vl-ghost";
        const gScale = 120 / item.size.w;
        ghost.style.width = "120px";
        ghost.style.height = `${item.size.h * gScale}px`;
        const html = apiRef.board.renderCard(item.id);
        if (html) {
          ghost.innerHTML = html;
          const inner = ghost.firstElementChild;
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
    const onUp = (me) => {
      cleanup();
      if (!moved) return;
      if (mode === "panel") {
        // Panel mode: only a drop onto the visible board
        // duplicates. A drop back onto any UI cancels.
        const el = document.elementFromPoint(me.clientX, me.clientY);
        if (!el) return;
        if (el.closest && (el.closest('[data-panel="library"]') || el.closest("#toolbar") || el.closest("#plugin-view") || el.closest("#view-switcher") || el.closest("#search-box") || el.closest("#title-bar") || el.closest("#settings-sheet") || el.closest(".plugin-tabs") || el.closest(".plugin-panel"))) return;
        duplicateAt(item, dropWorld(me.clientX, me.clientY), false);
      } else {
        // Whiteboard mode: the board is hidden behind the view,
        // so any drop duplicates at the drop point in camera
        // coordinates, with a toast — except a drop onto the
        // title bar, which is not the board and must not
        // create a card hidden under it.
        const el = document.elementFromPoint(me.clientX, me.clientY);
        if (el && el.closest && el.closest("#title-bar")) return;
        duplicateAt(item, dropWorld(me.clientX, me.clientY), true);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
  });
}

function layoutMasonry(container, items, mode) {
  // Spanning masonry, in both modes, so small cards pack
  // tightly instead of floating in wide columns. The grid is
  // built from small columns: a small card (a swatch, board
  // width within 1.5x a small column) spans one column, every
  // other card spans two, which is ~250px — the card size
  // the library has always used. A card is scaled uniformly
  // to its span width, capped at its board size, so aspect
  // is exact and nothing is ever upscaled beyond the board:
  // a swatch stays ~120px, centred in its span only when the
  // span is wider than the card. The previous
  // one-column-per-card layout centred a 120px swatch in a
  // 250px column, leaving 149px between two side-by-side
  // swatches; with small columns two consecutive swatches
  // sit in adjacent columns, 16px apart, like a palette.
  // No third-party package: this is thirty lines, the plugin
  // stays a single local file, and it works offline.
  // Width is the content width, not clientWidth: the panel
  // sections carry 15px of right padding as the scrollbar's
  // lane (see style.css), and laying out in clientWidth
  // would push cards back under the scrollbar. The targets
  // differ by mode so the column count stays put on both
  // scrollbar kinds: panel 105px keeps 2 columns whether
  // the content width is 250px (overlay scrollbar) or 235px
  // (classic scrollbar plus padding); view 110px keeps 10
  // columns at 1317–1332px.
  const cs = getComputedStyle(container);
  let containerWidth = container.clientWidth
    - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
  // A panel renders once, at registration, before its tab
  // is the active one — so at first render it is hidden
  // and its width is 0. Laying out at width 0 gave every
  // card a width and height of 0, so Uncategorized looked
  // empty until a collapse/reopen re-rendered it at its
  // real width. The panel is a fixed 290px dock, its body
  // has 12px padding each side, and the sections have
  // 4px of left padding and 15px of right padding, so a
  // hidden panel's content width is 290 - 24 - 4 - 15 = 247.
  // Lay out at that when the real width is not known yet;
  // the observer below re-lays out at the real width as
  // soon as the panel is actually shown, so a classic
  // scrollbar's narrower lane is corrected too.
  if (containerWidth <= 0 && mode === "panel") containerWidth = 247;
  const smallTarget = mode === "panel" ? 105 : 110;
  const gap = 16;
  const colCount = Math.max(1, Math.floor((containerWidth + gap) / (smallTarget + gap)));
  const colWidth = (containerWidth - gap * (colCount - 1)) / colCount;
  const colHeights = new Array(colCount).fill(0);
  for (const item of items) {
    const html = apiRef.board.renderCard(item.id);
    if (!html) continue;
    const span = Math.min(colCount, item.size.w <= colWidth * 1.5 ? 1 : 2);
    const spanWidth = span * colWidth + (span - 1) * gap;
    // Library width: the span width, capped at board width
    // (never upscale). A large card fills its span exactly;
    // a swatch in a slightly wider span stays board size,
    // centred in the span.
    const w = Math.min(item.size.w, spanWidth);
    const scale = w / item.size.w;
    const h = item.size.h * scale;
    // Place at the start column whose spanned columns are
    // shortest (leftmost on a tie), so consecutive small
    // cards pair side by side and order stays top-to-bottom.
    let start = 0;
    let best = Infinity;
    for (let s = 0; s + span <= colCount; s++) {
      let m = 0;
      for (let c = s; c < s + span; c++) m = Math.max(m, colHeights[c]);
      if (m < best) { best = m; start = s; }
    }
    const wrap = document.createElement("div");
    wrap.className = "vl-board-wrap";
    if (apiRef.board.getSelected().includes(item.id)) wrap.classList.add("vl-selected");
    wrap.dataset.boardId = String(item.id);
    wrap.style.left = `${start * (colWidth + gap) + (spanWidth - w) / 2}px`;
    wrap.style.top = `${best}px`;
    wrap.style.width = `${w}px`;
    wrap.style.height = `${h}px`;
    wrap.innerHTML = html;
    const inner = wrap.firstElementChild;
    if (inner) {
      inner.style.transform = `scale(${scale})`;
      inner.style.transformOrigin = "top left";
    }
    attachCardInteractions(wrap, item, mode);
    if ("Audio" in item.kind) loadLibraryAudioDuration(wrap, item);
    container.appendChild(wrap);
    for (let c = start; c < start + span; c++) colHeights[c] = best + h + gap;
  }
  container.style.height = `${Math.max(0, Math.max(...colHeights) - gap)}px`;
}

function renderSections(container, mode) {
  container.innerHTML = "";
  const sections = sectionsList();
  if (sections.length === 0) return;
  for (const section of sections) {
    const wrap = document.createElement("div");
    wrap.className = "vl-category";
    wrap.dataset.category = section.key;
    const head = document.createElement("button");
    head.className = "vl-category-head";
    const isCollapsed = collapsed.has(section.key);
    const arrow = document.createElement("span");
    arrow.className = "vl-arrow";
    arrow.textContent = isCollapsed ? "▸" : "▾";
    const name = document.createElement("span");
    name.className = "vl-category-name";
    name.textContent = section.label;
    const count = document.createElement("span");
    count.className = "vl-count";
    count.textContent = `(${section.items.length})`;
    head.append(arrow, name, count);
    head.addEventListener("click", () => {
      // Keep the scroll position: collapsing a section far
      // down should not jump the library back to the top.
      const panelTop = panelSections ? panelSections.scrollTop : 0;
      const viewTop = viewSections ? viewSections.scrollTop : 0;
      if (isCollapsed) collapsed.delete(section.key);
      else collapsed.add(section.key);
      updateAllDynamic();
      if (panelSections) panelSections.scrollTop = panelTop;
      if (viewSections) viewSections.scrollTop = viewTop;
    });
    wrap.appendChild(head);
    const body = document.createElement("div");
    body.className = "vl-category-body";
    wrap.appendChild(body);
    container.appendChild(wrap);
    if (isCollapsed) {
      body.style.display = "none";
    } else if (section.items.length === 0) {
      // No text for an empty kind: just the header.
    } else {
      layoutMasonry(body, section.items, mode);
    }
  }
}

function searchRow(targetView) {
  const row = document.createElement("div");
  row.className = "vl-search-row";
  const input = document.createElement("input");
  input.className = "vl-search";
  input.type = "text";
  input.placeholder = "Search library…";
  input.value = query;
  // Without this, the core window keydown handler sees every
  // key typed here: v/p/a would switch tools, Delete would
  // delete the selected card, +/- would zoom, and so on.
  // The core only guards textareas and the board search
  // input, so a plugin input must stop its own keydown.
  input.addEventListener("keydown", (e) => e.stopPropagation());
  // Debounced like the board search (150 ms): the
  // input handler used to rebuild the whole library —
  // panel and view masonry — on every keystroke.
  let searchTimer = null;
  input.addEventListener("input", () => {
    query = input.value;
    if (panelSearch && panelSearch !== input) panelSearch.value = query;
    if (viewSearch && viewSearch !== input) viewSearch.value = query;
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; updateAllDynamic(); }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && searchTimer !== null) {
      clearTimeout(searchTimer);
      searchTimer = null;
      updateAllDynamic();
    }
  });
  const btn = document.createElement("button");
  btn.className = "vl-icon-btn";
  const toView = targetView === "view";
  btn.title = toView ? "Whiteboard view" : "Panel view";
  btn.setAttribute("aria-label", toView ? "Whiteboard view" : "Panel view");
  const icon = document.createElement("span");
  icon.className = toView ? "vl-icon-masonry" : "vl-icon-sidebar";
  btn.appendChild(icon);
  btn.addEventListener("click", () => {
    apiRef.view.setView(toView ? "library" : "board");
  });
  row.append(input, btn);
  return { row, input };
}

function initPanel(body) {
  const sr = searchRow("view");
  panelSearch = sr.input;
  body.appendChild(sr.row);
  const sections = document.createElement("div");
  sections.className = "vl-sections";
  panelSections = sections;
  body.appendChild(sections);
  syncFromBoard(true);
  // Re-lay out when the panel is first shown: the first
  // render happened while it was hidden, so even with the
  // fallback width above, the layout must be redone at
  // the panel's real width the moment it becomes visible.
  // The observer fires on the hidden-to-visible change
  // only, not on child changes, so it does not loop.
  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && panelSections) renderSections(panelSections, "panel");
      }
    });
    panelIntersectionObserver = observer;
    observer.observe(sections);
  }
  // Re-lay out when the visible width changes: a classic
  // scrollbar appearing (or the window resizing) narrows
  // the sections, and cards laid out at the old, wider
  // width would otherwise overflow and be clipped by
  // overflow-x: hidden. Only re-render when the width
  // actually moved, so laying out does not loop.
  if (typeof ResizeObserver !== "undefined") {
    let lastWidth = 0;
    const ro = new ResizeObserver(() => {
      if (!panelSections) return;
      const w = panelSections.clientWidth;
      if (Math.abs(w - lastWidth) <= 1) return;
      lastWidth = w;
      renderSections(panelSections, "panel");
    });
    panelResizeObserver = ro;
    ro.observe(sections);
  }
}

function buildView(container) {
  const head = document.createElement("div");
  head.className = "vl-view-head";
  const h = document.createElement("h2");
  h.textContent = "Visual Library";
  head.appendChild(h);
  const sr = searchRow("panel");
  viewSearch = sr.input;
  head.appendChild(sr.row);
  container.appendChild(head);
  const sections = document.createElement("div");
  sections.className = "vl-sections";
  viewSections = sections;
  container.appendChild(sections);
  viewBuilt = true;
  syncFromBoard(true);
}

function activate(api) {
  apiRef = api;
  onBoardHandler = () => syncFromBoard(false);
  apiRef.events.on("board", onBoardHandler);
  onSelectionHandler = () => updateSelectionHighlight();
  apiRef.events.on("selection", onSelectionHandler);
  resizeHandler = () => {
    if (viewSections) renderSections(viewSections, "view");
  };
  window.addEventListener("resize", resizeHandler);
  apiRef.ui.registerPanel({
    id: "library",
    title: "Visual Library",
    // Masonry grid, as the panel's own mode icon: a tall
    // card on the left, two short cards on the right.
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="4" width="7" height="16" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
    render: (container) => initPanel(container),
  });
  apiRef.ui.registerView({
    id: "library",
    title: "Visual Library",
    render: (container) => {
      // Core re-renders the active view on every board render;
      // sync only when the board's cards actually changed, so
      // scrolling the library is not interrupted by a move.
      if (!viewBuilt) {
        buildView(container);
      } else {
        syncFromBoard(false);
      }
    },
    onShow: () => {
      // The view replaces the canvas, and the panel would cover
      // its right-hand columns, including the mode icon itself,
      // so hide the panel while the view is active.
      apiRef.ui.hidePanel("library");
      // The panel dock collapses when the panel hides, so the
      // board (and the view inside it) widens by the panel's
      // 290px: the view must be laid out again at the new,
      // wider width, not kept at the narrower layout render()
      // built before the panel hid. Force it, even when the
      // board itself is unchanged.
      if (viewBuilt && viewSections) syncFromBoard(true);
    },
    onHide: () => {
      // Show first, then clear. showPanel re-renders the
      // board, and that render refreshes the active view:
      // if the view were already cleared, that refresh would
      // rebuild it in a container about to be emptied, leaving
      // a stale built flag and a detached sections element,
      // so the next view activation showed an empty white
      // view. Showing first means the refresh sees the old,
      // still-valid view and skips it, and the clear that
      // follows leaves a clean state for the next activation.
      if (apiRef) apiRef.ui.showPanel("library");
      viewContainerClear();
      // The panel is visible again at its fixed 290px, so the
      // board narrowed back: re-lay the panel at its real
      // width, in case it was re-rendered while hidden (width
      // 0) during the view, before it is seen again.
      if (apiRef) syncFromBoard(true);
    },
  });
}

function viewContainerClear() {
  viewBuilt = false;
  viewSearch = null;
  viewSections = null;
}

function deactivate() {
  stopLibraryAudio();
  if (apiRef && onBoardHandler) apiRef.events.off("board", onBoardHandler);
  if (apiRef && onSelectionHandler) apiRef.events.off("selection", onSelectionHandler);
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  if (panelIntersectionObserver) panelIntersectionObserver.disconnect();
  if (panelResizeObserver) panelResizeObserver.disconnect();
  panelIntersectionObserver = null;
  panelResizeObserver = null;
  onBoardHandler = null;
  onSelectionHandler = null;
  resizeHandler = null;
  panelSearch = null;
  panelSections = null;
  viewContainerClear();
  apiRef = null;
}

export { activate, deactivate };
