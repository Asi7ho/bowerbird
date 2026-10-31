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
// it duplicates, as click does.
//
// Clicking a library card duplicates that board element onto
// the board, at the camera centre. Dragging it duplicates it
// at the drop point (panel mode: onto the visible board;
// whiteboard mode: at the drop point in camera coordinates,
// with a toast, since the board is hidden). The duplicate is
// an ordinary board item of the same kind and the same size
// as the original, so it appears in the library too — it is a
// board element. Media previews are the only interactions
// that do not duplicate: a video's native controls play in
// place, and an audio tile plays in place. Link cards
// duplicate on click like every other card; open a link from
// the board after placing it.
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
let resizeHandler = null;

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
  return items.map((it) => `${it.id}:${JSON.stringify(it.kind)}:${it.size.w}x${it.size.h}`).sort().join("|");
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

function updateAllDynamic() {
  // A re-render drops the DOM the audio preview was wired to,
  // so stop the preview rather than leaving orphan playback.
  stopLibraryAudio();
  if (panelSections) renderSections(panelSections, "panel");
  if (viewSections) renderSections(viewSections, "view");
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

function refresh() {
  syncFromBoard(true);
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

function loadLibraryAudioDuration(wrap, item) {
  const dur = wrap.querySelector("[data-audio-dur]");
  if (!dur || dur.textContent !== "–:––") return;
  const audio = new Audio(apiRef.files.fileUrl(item.kind.Audio.path));
  audio.addEventListener("loadedmetadata", () => {
    if (wrap.isConnected && dur.isConnected) dur.textContent = formatAudioTime(audio.duration);
  });
  audio.addEventListener("error", () => {});
}

function attachCardInteractions(wrap, item, mode) {
  wrap.addEventListener("click", (e) => {
    // Media previews do not duplicate. Everything else on the
    // card — including a link's title and image — duplicates.
    if (isMediaTarget(e.target)) return;
    duplicateAt(item, cameraCentreWorld(), mode === "view");
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
    const onUp = (me) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (ghost) ghost.remove();
      if (!moved) return;
      if (mode === "panel") {
        // Panel mode: only a drop onto the visible board
        // duplicates. A drop back onto any UI cancels.
        const el = document.elementFromPoint(me.clientX, me.clientY);
        if (!el) return;
        if (el.closest && (el.closest('[data-panel="library"]') || el.closest("#toolbar") || el.closest("#plugin-view") || el.closest("#view-switcher") || el.closest("#search-box") || el.closest("#title-bar") || el.closest("#settings-sheet") || el.closest(".plugin-panel"))) return;
        duplicateAt(item, dropWorld(me.clientX, me.clientY), false);
      } else {
        // Whiteboard mode: the board is hidden behind the view,
        // so any drop duplicates at the drop point in camera
        // coordinates, with a toast, as a click does — except
        // a drop onto the title bar, which is not the board
        // and must not create a card hidden under it.
        const el = document.elementFromPoint(me.clientX, me.clientY);
        if (el && el.closest && el.closest("#title-bar")) return;
        duplicateAt(item, dropWorld(me.clientX, me.clientY), true);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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
  const containerWidth = container.clientWidth
    - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
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
  input.addEventListener("input", () => {
    query = input.value;
    if (panelSearch && panelSearch !== input) panelSearch.value = query;
    if (viewSearch && viewSearch !== input) viewSearch.value = query;
    updateAllDynamic();
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
  resizeHandler = () => {
    if (viewSections) renderSections(viewSections, "view");
  };
  window.addEventListener("resize", resizeHandler);
  apiRef.ui.registerPanel({
    id: "library",
    title: "Visual Library",
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
  apiRef.ui.registerCommand({
    id: "refresh",
    title: "Refresh Visual Library",
    run: () => refresh(),
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
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  onBoardHandler = null;
  resizeHandler = null;
  panelSearch = null;
  panelSections = null;
  viewContainerClear();
  apiRef = null;
}

export { activate, deactivate };
