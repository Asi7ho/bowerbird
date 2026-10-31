// Visual Library — bundled Bowerbird plugin (see PLUGIN_API.md).
// Two modes over the same library folder on disk (board/library/,
// temp folder in demo so a demo never touches the real library):
//  - Panel mode: a panel in the right dock, flush against the
//    window edge, full height, over the board.
//  - Whiteboard mode: a view replacing the canvas, laid out
//    like Pinterest.
// Both modes show the same library, with the same card, in a
// masonry grid: images keep their natural aspect ratio, PDF
// tiles keep a 4:3 aspect ratio, so a card never changes shape
// between modes — only its column width changes. The search
// box is shared, and the mode switch is a single icon button
// beside it (masonry icon for whiteboard, sidebar icon for
// panel). There are no Refresh, Open folder or Folder-path
// controls in the UI: the library refreshes automatically when
// you switch modes, when the app regains focus, and after any
// change you make in the app (the Refresh command still exists
// in Settings → Plugins for a manual refresh).
// Categories are the library's subfolders, shown as dropdown
// sections (Uncategorized first, then folders alphabetically).
// A section header expands or collapses it. Changing an
// item's category is drag and drop: drag it onto another
// category's section — header, grid, or an item inside it —
// and it moves there. In panel mode, dragging an item out of
// the panel onto the board still places it on the board, and
// clicking an item places it at the camera centre in both
// modes. Placed items are ordinary Image or PdfCards, board-
// owned via files:embed, not plugin cards, so they survive
// with or without this plugin. Listing, copying and moving
// are scoped to the library folder through the core; the
// plugin never gets an arbitrary folder.
let apiRef = null;
let items = [];
let categories = [];
let uncategorizedCount = 0;
let query = "";
let collapsed = new Set();
let lastRefreshMs = 0;
let currentRenderSeq = 0;

// Panel refs (built once by initPanel).
let panelSearch = null;
let panelSections = null;
let panelNewCat = null;

// View refs (built on each activation, cleared on hide).
let viewContainer = null;
let viewBuilt = false;
let viewSearch = null;
let viewSections = null;
let viewNewCat = null;

let focusHandler = null;
let resizeHandler = null;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function categoryKey(item) {
  return item.category === null ? "uncategorized" : item.category;
}

function categoryLabel(key) {
  return key === "uncategorized" ? "Uncategorized" : key;
}

function sectionsList() {
  const q = query.trim().toLowerCase();
  const keys = ["uncategorized", ...categories.map((c) => c.name)];
  const out = [];
  for (const key of keys) {
    const inCat = items.filter((it) => categoryKey(it) === key);
    const filtered = q ? inCat.filter((it) => it.name.toLowerCase().includes(q)) : inCat;
    if (q && filtered.length === 0) continue;
    out.push({ key, label: categoryLabel(key), total: inCat.length, items: filtered });
  }
  return out;
}

function loadImageSize(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 320, h: img.naturalHeight || 240 });
    img.onerror = () => resolve({ w: 320, h: 240 });
    img.src = url;
  });
}

async function addItemAt(item, centreWorld, dropWorld) {
  const point = centreWorld || dropWorld;
  try {
    if (item.kind === "image") {
      const stored = await apiRef.files.embedFile(item.path);
      const size = await loadImageSize(apiRef.files.fileUrl(stored));
      const scale = size.w > 320 ? 320 / size.w : 1;
      const w = Math.max(40, size.w * scale);
      const h = Math.max(40, size.h * scale);
      apiRef.board.addItem({ Image: { path: stored } }, { x: point.x - w / 2, y: point.y - h / 2 }, { w, h });
    } else {
      const stored = await apiRef.files.embedFile(item.path);
      const sizeBytes = await apiRef.files.fileSize(stored).catch(() => item.size_bytes || 0);
      const w = 260, h = 96;
      apiRef.board.addItem({ PdfCard: { path: stored, size_bytes: sizeBytes } }, { x: point.x - w / 2, y: point.y - h / 2 }, { w, h });
    }
    // In whiteboard mode the board is hidden, so the user cannot
    // see the card appear — say so. In panel mode the board is
    // visible and the card appearing is the feedback.
    if (apiRef.view.getView() === "library") apiRef.ui.toast(`Added ${item.name} to board`);
  } catch (e) {
    apiRef.ui.toast(`Could not add ${item.name}: ${String(e)}`);
  }
}

function cameraCentreWorld() {
  const cam = apiRef.view.getCamera();
  return {
    x: cam.x + window.innerWidth / 2 / cam.zoom,
    y: cam.y + window.innerHeight / 2 / cam.zoom,
  };
}

function dropWorld(clientX, clientY) {
  const cam = apiRef.view.getCamera();
  return { x: clientX / cam.zoom + cam.x, y: clientY / cam.zoom + cam.y };
}

async function moveItem(item, destCategory) {
  const destKey = destCategory === null ? "uncategorized" : destCategory;
  try {
    await apiRef.files.moveLibraryItem(item.relativePath, destCategory);
    // Show the destination expanded, so the moved item is visible.
    collapsed.delete(destKey);
    apiRef.ui.toast(`Moved ${item.name} to ${destCategory === null ? "Uncategorized" : destCategory}`);
    await refresh();
  } catch (e) {
    apiRef.ui.toast(`Could not move ${item.name}: ${String(e)}`);
  }
}

function makeCard(item) {
  // One card component for both modes: same padding, radius,
  // border, shadow and typography as a board card, so a library
  // card never looks like a different app. Images keep their
  // natural aspect ratio (width 100%, height auto); PDF tiles
  // keep a 4:3 aspect ratio via CSS, so height scales with
  // column width in both modes instead of being cropped.
  const b = document.createElement("button");
  b.className = "vl-card";
  b.title = item.name;
  if (item.kind === "image") {
    const img = document.createElement("img");
    img.src = apiRef.files.fileUrl(item.path);
    img.alt = "";
    img.draggable = false;
    b.appendChild(img);
  } else {
    const pdf = document.createElement("div");
    pdf.className = "vl-pdf";
    pdf.textContent = "PDF";
    b.appendChild(pdf);
  }
  const name = document.createElement("div");
  name.className = "vl-name";
  name.textContent = item.name;
  b.appendChild(name);
  const size = document.createElement("div");
  size.className = "vl-size";
  size.textContent = formatSize(item.size_bytes);
  b.appendChild(size);
  return b;
}

function clearDropHighlights() {
  document.querySelectorAll(".vl-category.vl-drop-target").forEach((s) => s.classList.remove("vl-drop-target"));
}

function attachDrag(b, item, mode) {
  // Drag with mouse tracking, not HTML5 drag, so the drop is a
  // plain position or a plain category, not a file drop the
  // core has to understand. A plain click (no drag) places at
  // the camera centre in both modes.
  let dragged = false;
  let ghost = null;
  b.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragged = false;
    let lastX = e.clientX, lastY = e.clientY;
    let moved = 0;
    const onMove = (me) => {
      moved += Math.abs(me.clientX - lastX) + Math.abs(me.clientY - lastY);
      lastX = me.clientX; lastY = me.clientY;
      if (moved > 5) {
        dragged = true;
        if (!ghost) {
          ghost = document.createElement("div");
          ghost.className = "vl-ghost";
          if (item.kind === "image") {
            const gimg = document.createElement("img");
            gimg.src = apiRef.files.fileUrl(item.path);
            gimg.alt = "";
            ghost.appendChild(gimg);
          } else {
            const gpdf = document.createElement("div");
            gpdf.className = "vl-pdf";
            gpdf.textContent = "PDF";
            ghost.appendChild(gpdf);
          }
          document.body.appendChild(ghost);
        }
        ghost.style.left = `${me.clientX + 12}px`;
        ghost.style.top = `${me.clientY + 12}px`;
        // Highlight the category section under the cursor, if any.
        const el = document.elementFromPoint(me.clientX, me.clientY);
        const cat = el ? el.closest("[data-category]") : null;
        document.querySelectorAll(".vl-category.vl-drop-target").forEach((s) => {
          if (s !== cat) s.classList.remove("vl-drop-target");
        });
        if (cat) cat.classList.add("vl-drop-target");
      }
    };
    const onUp = (me) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (ghost) { ghost.remove(); ghost = null; }
      clearDropHighlights();
      if (!dragged) return;
      const target = me.target && me.target.closest ? me.target : null;
      const catEl = target ? target.closest("[data-category]") : null;
      if (catEl) {
        const destKey = catEl.dataset.category;
        const dest = destKey === "uncategorized" ? null : destKey;
        if (dest !== item.category) moveItem(item, dest);
        return;
      }
      if (mode === "panel") {
        // Outside the panel, onto the board: place at the drop
        // point. Onto the panel itself (but not a category),
        // the toolbar, Settings, search or the view switcher:
        // cancel, do not place under chrome.
        if (target && target.closest(".plugin-panel, #toolbar, #settings, #search-box, #view-switcher")) return;
        addItemAt(item, null, dropWorld(me.clientX, me.clientY));
      }
      // In whiteboard mode the board is hidden, so a drop that
      // is not on a category cancels — placing is via click.
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  b.addEventListener("click", () => {
    if (dragged) { dragged = false; return; }
    addItemAt(item, cameraCentreWorld(), null);
  });
}

async function layoutMasonry(container, list, minColWidth, gap, seq) {
  // Pinterest-style masonry by hand: each new item goes to the
  // currently shortest column, so columns fill the full width
  // with varied heights. CSS columns cannot do this reliably
  // in a scrollable view: with a constrained height they
  // collapse to fewer columns and leave the right half empty.
  if (!container.isConnected) return;
  const containerWidth = container.clientWidth;
  if (containerWidth <= 0) return;
  const colCount = Math.max(1, Math.floor((containerWidth + gap) / (minColWidth + gap)));
  const colWidth = (containerWidth - (colCount - 1) * gap) / colCount;
  const colHeights = new Array(colCount).fill(0);
  for (const item of list) {
    let contentHeight;
    if (item.kind === "image") {
      const size = await loadImageSize(apiRef.files.fileUrl(item.path));
      if (seq !== currentRenderSeq || !container.isConnected) return;
      contentHeight = colWidth * (size.h / size.w);
    } else {
      contentHeight = colWidth * 0.75; // PDF tile, 4:3 aspect ratio.
    }
    // Card chrome under the thumbnail: name, size, padding.
    // Same card in both modes, so chrome is width-independent.
    const height = contentHeight + 54;
    let col = 0;
    for (let i = 1; i < colCount; i++) {
      if (colHeights[i] < colHeights[col]) col = i;
    }
    const b = makeCard(item);
    b.style.position = "absolute";
    b.style.left = `${col * (colWidth + gap)}px`;
    b.style.top = `${colHeights[col]}px`;
    b.style.width = `${colWidth}px`;
    attachDrag(b, item, container.dataset.vlMode);
    container.appendChild(b);
    colHeights[col] += height + gap;
  }
  if (seq !== currentRenderSeq || !container.isConnected) return;
  container.style.height = `${Math.max(...colHeights) - gap}px`;
}

function renderSections(container, mode, seq) {
  container.innerHTML = "";
  const sections = sectionsList();
  if (sections.length === 0) {
    return;
  }
  const minColWidth = mode === "panel" ? 110 : 240;
  const gap = mode === "panel" ? 8 : 16;
  for (const section of sections) {
    const wrap = document.createElement("div");
    wrap.className = "vl-category";
    wrap.dataset.category = section.key;
    const head = document.createElement("button");
    head.className = "vl-category-head";
    head.type = "button";
    const isCollapsed = collapsed.has(section.key);
    const arrow = document.createElement("span");
    arrow.className = "vl-arrow";
    arrow.textContent = isCollapsed ? "▸" : "▾";
    head.appendChild(arrow);
    const name = document.createElement("span");
    name.className = "vl-category-name";
    name.textContent = section.label;
    head.appendChild(name);
    const count = document.createElement("span");
    count.className = "vl-category-count";
    count.textContent = query.trim() ? `(${section.items.length})` : `(${section.total})`;
    head.appendChild(count);
    head.addEventListener("click", () => {
      if (collapsed.has(section.key)) collapsed.delete(section.key);
      else collapsed.add(section.key);
      updateAllDynamic();
    });
    wrap.appendChild(head);
    const body = document.createElement("div");
    body.className = "vl-category-body";
    body.dataset.vlMode = mode;
    wrap.appendChild(body);
    container.appendChild(wrap);
    // The body must be in the document before layout runs:
    // layout measures its width and checks isConnected, and a
    // detached body has width 0, so layout would return early
    // and the section would stay empty.
    if (isCollapsed) {
      body.style.display = "none";
    } else if (section.items.length === 0) {
      // No text for an empty category: just the header. The
      // header itself is the drop target for dragging items in.
    } else {
      layoutMasonry(body, section.items, minColWidth, gap, seq);
    }
  }
}

function renderPanelDynamic(seq) {
  // A hidden panel (whiteboard mode hides it) has no width to
  // measure, so do not clear it while hidden — it is re-rendered
  // on the way back, after it is shown again.
  if (!panelSections || panelSections.offsetParent === null) return;
  renderSections(panelSections, "panel", seq);
}

function renderViewDynamic(seq) {
  if (!viewSections) return;
  renderSections(viewSections, "view", seq);
}

function updateAllDynamic() {
  const seq = ++currentRenderSeq;
  renderPanelDynamic(seq);
  renderViewDynamic(seq);
}

async function createCategoryFrom(input) {
  const name = input.value.trim();
  if (!name) return;
  try {
    await apiRef.files.createLibraryCategory(name);
    apiRef.ui.toast(`Category ${name} created`);
    input.value = "";
    await refresh();
  } catch (e) {
    apiRef.ui.toast(`Could not create category: ${String(e)}`);
  }
}

function masonryIcon() {
  const icon = document.createElement("span");
  icon.className = "vl-icon-masonry";
  icon.setAttribute("aria-hidden", "true");
  const left = document.createElement("span");
  left.className = "vl-icon-col vl-icon-col-tall-first";
  left.appendChild(document.createElement("span"));
  left.appendChild(document.createElement("span"));
  const right = document.createElement("span");
  right.className = "vl-icon-col vl-icon-col-short-first";
  right.appendChild(document.createElement("span"));
  right.appendChild(document.createElement("span"));
  icon.appendChild(left);
  icon.appendChild(right);
  return icon;
}

function panelIcon() {
  const icon = document.createElement("span");
  icon.className = "vl-icon-panel";
  icon.setAttribute("aria-hidden", "true");
  const main = document.createElement("span");
  main.className = "vl-icon-panel-main";
  const side = document.createElement("span");
  side.className = "vl-icon-panel-side";
  icon.appendChild(main);
  icon.appendChild(side);
  return icon;
}

function searchRow(mode) {
  const row = document.createElement("div");
  row.className = "vl-search-row";
  const input = document.createElement("input");
  input.className = "vl-search";
  input.type = "search";
  input.placeholder = "Search library…";
  input.value = query;
  // Search only re-renders sections, never the search input
  // itself, so typing does not steal focus or reset the input.
  input.addEventListener("input", () => {
    query = input.value;
    if (panelSearch && panelSearch !== input) panelSearch.value = query;
    if (viewSearch && viewSearch !== input) viewSearch.value = query;
    updateAllDynamic();
  });
  row.appendChild(input);
  const modeBtn = document.createElement("button");
  modeBtn.className = "vl-icon-btn";
  modeBtn.type = "button";
  if (mode === "panel") {
    modeBtn.title = "Whiteboard view";
    modeBtn.setAttribute("aria-label", "Switch to whiteboard view");
    modeBtn.appendChild(masonryIcon());
    modeBtn.addEventListener("click", () => apiRef.view.setView("library"));
  } else {
    modeBtn.title = "Panel view";
    modeBtn.setAttribute("aria-label", "Switch to panel view");
    modeBtn.appendChild(panelIcon());
    modeBtn.addEventListener("click", () => apiRef.view.setView("board"));
  }
  row.appendChild(modeBtn);
  return { row, input };
}

function controlsRow() {
  const wrap = document.createElement("div");
  wrap.className = "vl-controls";
  const nc = document.createElement("div");
  nc.className = "vl-newcat";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "New category…";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createCategoryFrom(input); }
  });
  const btn = document.createElement("button");
  btn.textContent = "Create";
  btn.addEventListener("click", () => createCategoryFrom(input));
  nc.appendChild(input);
  nc.appendChild(btn);
  wrap.appendChild(nc);
  return { wrap, input };
}

function initPanel(body) {
  const sr = searchRow("panel");
  panelSearch = sr.input;
  body.appendChild(sr.row);
  const cr = controlsRow();
  panelNewCat = cr.input;
  body.appendChild(cr.wrap);
  panelSections = document.createElement("div");
  panelSections.className = "vl-sections";
  body.appendChild(panelSections);
  refresh();
}

function buildView(container) {
  const head = document.createElement("div");
  head.className = "vl-view-head";
  const title = document.createElement("h2");
  title.textContent = "Visual Library";
  head.appendChild(title);
  const sr = searchRow("view");
  viewSearch = sr.input;
  head.appendChild(sr.row);
  const cr = controlsRow();
  viewNewCat = cr.input;
  head.appendChild(cr.wrap);
  container.appendChild(head);
  viewSections = document.createElement("div");
  viewSections.className = "vl-sections";
  container.appendChild(viewSections);
  viewBuilt = true;
  viewContainer = container;
}

function renderView(container) {
  // The core calls render again on board changes while the view
  // is active; rebuilding the shell each time would steal the
  // search box focus, so a built shell is only updated.
  if (viewBuilt && viewContainer === container) {
    const seq = ++currentRenderSeq;
    renderViewDynamic(seq);
      return;
  }
  container.innerHTML = "";
  buildView(container);
  updateAllDynamic();
}

async function refresh() {
  if (!apiRef) return;
  try {
    const res = await apiRef.files.listLibrary();
    items = res.items;
    categories = res.categories;
    uncategorizedCount = res.uncategorizedCount;
    // Prune collapsed entries for categories deleted outside
    // the app, so a stale key never hides a new category.
    for (const key of Array.from(collapsed)) {
      if (key !== "uncategorized" && !categories.some((c) => c.name === key)) collapsed.delete(key);
    }
    lastRefreshMs = Date.now();
  } catch (e) {
    if (apiRef) apiRef.ui.toast(`Could not list library: ${String(e)}`);
    items = [];
    categories = [];
    uncategorizedCount = 0;
  }
  updateAllDynamic();
}

export function activate(api) {
  apiRef = api;
  focusHandler = () => {
    // No Refresh button in the UI: picking up files added
    // outside the app happens when the app regains focus
    // (for example after dropping files in Finder), debounced
    // so focus changes do not refresh in a loop.
    if (Date.now() - lastRefreshMs < 3000) return;
    refresh();
  };
  window.addEventListener("focus", focusHandler);
  resizeHandler = () => {
    if (!viewSections) return;
    const seq = ++currentRenderSeq;
    renderViewDynamic(seq);
  };
  window.addEventListener("resize", resizeHandler);
  api.ui.registerPanel({
    id: "library",
    title: "Visual Library",
    render: (container) => initPanel(container),
  });
  api.ui.registerView({
    id: "library",
    title: "Visual Library",
    render: (container) => renderView(container),
    onShow: () => {
      // Whiteboard mode gets the full board width; the panel
      // would only duplicate the same library on the right.
      api.ui.hidePanel("library");
      refresh();
    },
    onHide: () => {
      // Back to panel mode: the panel is the library again.
      // Show it first, then refresh, so the re-render measures
      // a visible panel instead of a hidden one.
      api.ui.showPanel("library");
      viewBuilt = false;
      viewContainer = null;
      viewSearch = null;
      viewSections = null;
          viewNewCat = null;
      refresh();
    },
  });
  api.ui.registerCommand({
    id: "refresh-library",
    title: "Refresh Visual Library",
    run: () => refresh(),
  });
}

export function deactivate() {
  // The core removes the panel, the view and the command on
  // deactivate. Panel listeners die with the removed panel DOM;
  // the ghost, if a drag was in flight, is removed on mouseup.
  if (focusHandler) window.removeEventListener("focus", focusHandler);
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  focusHandler = null;
  resizeHandler = null;
  apiRef = null;
  panelSearch = null;
  panelSections = null;
  panelNewCat = null;
  viewContainer = null;
  viewBuilt = false;
  viewSearch = null;
  viewSections = null;
  viewNewCat = null;
}
