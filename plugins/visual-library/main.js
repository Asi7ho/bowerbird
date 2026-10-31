// Visual Library — bundled Bowerbird plugin (see PLUGIN_API.md).
// Two modes over the same library folder on disk (board/library/,
// temp folder in demo so a demo never touches the real library):
//  - Panel mode: a panel in the right dock, full height of the
//    app, over the board. Click places at the camera centre;
//    drag places at the drop point.
//  - Whiteboard mode: a view replacing the canvas, laid out
//    like Pinterest — a masonry grid of items with their natural
//    heights. Click places at the camera centre; the board is
//    hidden in this mode, so there is no drag-to-drop. Switching
//    modes keeps the search and category filter, and the view
//    hides the panel while it is active so the masonry gets the
//    full board width, then shows the panel again on the way back.
// Categories are the library's subfolders: a file's category is
// the first folder under the library, files in the root are
// Uncategorized. Organise in Finder (Open folder) or with the
// New category control, then Refresh. Either way the result is
// an ordinary Image or PdfCard, board-owned via files:embed,
// not a plugin card — so it survives with or without this plugin.
// Listing and copying are scoped to the library folder through
// the core (api.files.listLibrary / addToLibrary); the plugin
// never gets an arbitrary folder to list or copy to.
let apiRef = null;
let items = [];
let categories = [];
let uncategorizedCount = 0;
let libraryPath = "";
let query = "";
let selectedCategory = "all";

// Panel refs (built once by initPanel).
let panelSearch = null;
let panelChips = null;
let panelGrid = null;
let panelCount = null;
let panelPath = null;
let panelAdd = null;
let panelNewCat = null;

// View refs (built on each activation, cleared on hide).
let viewContainer = null;
let viewBuilt = false;
let masonrySeq = 0;
let viewSearch = null;
let viewChips = null;
let viewMasonry = null;
let viewCount = null;
let viewPath = null;
let viewAdd = null;
let viewNewCat = null;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function filtered() {
  let list = items;
  if (selectedCategory === "uncategorized") {
    list = list.filter((it) => it.category === null);
  } else if (selectedCategory !== "all") {
    list = list.filter((it) => it.category === selectedCategory);
  }
  const q = query.trim().toLowerCase();
  if (q) list = list.filter((it) => it.name.toLowerCase().includes(q));
  return list;
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

function makeItemButton(item, masonry) {
  const b = document.createElement("button");
  b.className = masonry ? "vl-masonry-item" : "vl-item";
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
  if (masonry && item.category) {
    const cat = document.createElement("div");
    cat.className = "vl-cat";
    cat.textContent = item.category;
    b.appendChild(cat);
  }
  return b;
}

function attachPanelDrag(b, item) {
  // Drag to place: mouse tracking, not HTML5 drag, so the drop
  // is a plain board position, not a file drop the core has to
  // understand. A plain click (no drag) places at camera centre.
  // Only in panel mode: in whiteboard mode the board is hidden,
  // so there is nothing visible to drop onto.
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
      }
    };
    const onUp = (me) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (ghost) { ghost.remove(); ghost = null; }
      if (!dragged) return;
      // Dropped back on the panel itself: cancel, do not add.
      if (me.target && me.target.closest && me.target.closest(".plugin-panel")) return;
      addItemAt(item, null, dropWorld(me.clientX, me.clientY));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  b.addEventListener("click", () => {
    if (dragged) { dragged = false; return; }
    addItemAt(item, cameraCentreWorld(), null);
  });
}

function emptyMessage() {
  if (items.length === 0) return "Library is empty. Drop images or PDFs into the library folder, then Refresh.";
  if (query.trim()) return "No matches.";
  if (selectedCategory !== "all") return "No items in this category yet — drop files into that folder, or use Open folder.";
  return "No matches.";
}

function renderChips(into) {
  into.innerHTML = "";
  const mk = (key, label, count) => {
    const chip = document.createElement("button");
    chip.className = "vl-chip" + (selectedCategory === key ? " active" : "");
    chip.textContent = count !== null && count !== undefined ? `${label} (${count})` : label;
    chip.addEventListener("click", () => {
      selectedCategory = key;
      updateAllDynamic();
    });
    into.appendChild(chip);
  };
  mk("all", "All", items.length);
  if (uncategorizedCount > 0 || selectedCategory === "uncategorized") {
    mk("uncategorized", "Uncategorized", uncategorizedCount);
  }
  for (const c of categories) mk(c.name, c.name, c.count);
}

function renderPanelDynamic() {
  if (!panelGrid) return;
  if (panelPath) { panelPath.textContent = `Folder: ${libraryPath}`; panelPath.title = libraryPath; }
  renderChips(panelChips);
  const list = filtered();
  panelGrid.innerHTML = "";
  panelCount.textContent = items.length === 0
    ? "Library is empty."
    : `${list.length} of ${items.length} item${items.length === 1 ? "" : "s"}`;
  if (list.length === 0) {
    const msg = document.createElement("p");
    msg.className = "meta";
    msg.textContent = emptyMessage();
    panelGrid.appendChild(msg);
  } else {
    for (const item of list) {
      const b = makeItemButton(item, false);
      attachPanelDrag(b, item);
      panelGrid.appendChild(b);
    }
  }
  updateAddButtons();
}

async function layoutMasonry(list) {
  // True Pinterest-style masonry: items are placed in columns
  // by hand, each new item going to the currently shortest
  // column, so columns fill the full width with varied heights.
  // CSS columns cannot do this reliably in a scrollable view:
  // with a constrained height they collapse to fewer columns
  // and leave the right half empty.
  const seq = ++masonrySeq;
  const container = viewMasonry;
  if (!container) return;
  container.innerHTML = "";
  container.style.height = "auto";
  if (list.length === 0) {
    const msg = document.createElement("p");
    msg.className = "meta";
    msg.textContent = emptyMessage();
    container.appendChild(msg);
    return;
  }
  const gap = 16;
  const containerWidth = container.clientWidth;
  if (containerWidth <= 0) return;
  const colCount = Math.max(1, Math.floor((containerWidth + gap) / (240 + gap)));
  const colWidth = (containerWidth - (colCount - 1) * gap) / colCount;
  const colHeights = new Array(colCount).fill(0);
  for (const item of list) {
    let contentHeight;
    if (item.kind === "image") {
      const size = await loadImageSize(apiRef.files.fileUrl(item.path));
      if (seq !== masonrySeq || !viewMasonry) return;
      contentHeight = colWidth * (size.h / size.w);
    } else {
      contentHeight = 180;
    }
    // Card chrome under the thumbnail: name, size, and a
    // category line when there is one, plus padding.
    const chrome = item.category ? 68 : 52;
    const height = contentHeight + chrome;
    let col = 0;
    for (let i = 1; i < colCount; i++) {
      if (colHeights[i] < colHeights[col]) col = i;
    }
    const b = makeItemButton(item, true);
    b.style.position = "absolute";
    b.style.left = `${col * (colWidth + gap)}px`;
    b.style.top = `${colHeights[col]}px`;
    b.style.width = `${colWidth}px`;
    b.addEventListener("click", () => addItemAt(item, cameraCentreWorld(), null));
    container.appendChild(b);
    colHeights[col] += height + gap;
  }
  if (seq !== masonrySeq || !viewMasonry) return;
  container.style.height = `${Math.max(...colHeights) - gap}px`;
}

function renderViewDynamic() {
  if (!viewMasonry) return;
  if (viewPath) { viewPath.textContent = `Folder: ${libraryPath}`; viewPath.title = libraryPath; }
  renderChips(viewChips);
  const list = filtered();
  viewCount.textContent = items.length === 0
    ? "Library is empty."
    : `${list.length} of ${items.length} item${items.length === 1 ? "" : "s"}`;
  layoutMasonry(list);
  updateAddButtons();
}

function updateAllDynamic() {
  renderPanelDynamic();
  renderViewDynamic();
}

function selectedBoardFiles() {
  const selected = new Set(apiRef.board.getSelected());
  const toAdd = [];
  for (const it of apiRef.board.getItems()) {
    if (!selected.has(it.id)) continue;
    if ("Image" in it.kind) toAdd.push(it.kind.Image.path);
    else if ("PdfCard" in it.kind) toAdd.push(it.kind.PdfCard.path);
  }
  return toAdd;
}

function updateAddButtons() {
  let n = 0;
  try { n = selectedBoardFiles().length; } catch { n = 0; }
  for (const btn of [panelAdd, viewAdd]) {
    if (!btn) continue;
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? "Add selected to library" : `Add selected to library (${n})`;
  }
}

async function addSelectedToLibrary() {
  const toAdd = selectedBoardFiles();
  if (toAdd.length === 0) return;
  let added = 0;
  for (const p of toAdd) {
    try { await apiRef.files.addToLibrary(p); added += 1; } catch { /* skip one bad file, keep the rest */ }
  }
  apiRef.ui.toast(added === 1 ? "Added 1 item to library" : `Added ${added} items to library`);
  await refresh();
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

function searchInputEl(placeholder, initial) {
  const input = document.createElement("input");
  input.className = "vl-search";
  input.type = "search";
  input.placeholder = placeholder;
  input.value = initial;
  // Search only re-renders grids/chips, never the search input
  // itself, so typing does not steal focus or reset the input.
  input.addEventListener("input", () => {
    query = input.value;
    // Keep the other mode's search box in step when it is built.
    if (panelSearch && panelSearch !== input) panelSearch.value = query;
    if (viewSearch && viewSearch !== input) viewSearch.value = query;
    updateAllDynamic();
  });
  return input;
}

function buttonsRow(withModeButton, modeLabel, onMode) {
  const row = document.createElement("div");
  row.className = "vl-row";
  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "Refresh";
  refreshBtn.addEventListener("click", () => refresh());
  row.appendChild(refreshBtn);
  const openBtn = document.createElement("button");
  openBtn.textContent = "Open folder";
  openBtn.addEventListener("click", () => {
    if (libraryPath) apiRef.files.openExternal(libraryPath).catch(() => undefined);
  });
  row.appendChild(openBtn);
  if (withModeButton) {
    const modeBtn = document.createElement("button");
    modeBtn.textContent = modeLabel;
    modeBtn.addEventListener("click", onMode);
    row.appendChild(modeBtn);
  }
  return row;
}

function newCategoryRow() {
  const row = document.createElement("div");
  row.className = "vl-newcat";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "New category…";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createCategoryFrom(input); }
  });
  const btn = document.createElement("button");
  btn.textContent = "Create";
  btn.addEventListener("click", () => createCategoryFrom(input));
  row.appendChild(input);
  row.appendChild(btn);
  return { row, input };
}

function initPanel(body) {
  panelSearch = searchInputEl("Search library…", query);
  body.appendChild(panelSearch);
  body.appendChild(buttonsRow(true, "Whiteboard view", () => apiRef.view.setView("library")));
  panelPath = document.createElement("p");
  panelPath.className = "meta vl-path";
  body.appendChild(panelPath);
  panelCount = document.createElement("p");
  panelCount.className = "meta";
  body.appendChild(panelCount);
  panelChips = document.createElement("div");
  panelChips.className = "vl-chips";
  body.appendChild(panelChips);
  panelGrid = document.createElement("div");
  panelGrid.className = "vl-grid";
  body.appendChild(panelGrid);
  panelAdd = document.createElement("button");
  panelAdd.className = "vl-add";
  panelAdd.disabled = true;
  panelAdd.textContent = "Add selected to library";
  panelAdd.addEventListener("click", () => addSelectedToLibrary());
  body.appendChild(panelAdd);
  const nc = newCategoryRow();
  panelNewCat = nc.input;
  body.appendChild(nc.row);
  apiRef.events.on("selection", updateAddButtons);
  apiRef.events.on("board", updateAddButtons);
  refresh();
}

function buildView(container) {
  const head = document.createElement("div");
  head.className = "vl-view-head";
  const title = document.createElement("h2");
  title.textContent = "Visual Library";
  head.appendChild(title);
  viewSearch = searchInputEl("Search library…", query);
  head.appendChild(viewSearch);
  head.appendChild(buttonsRow(true, "Panel view", () => apiRef.view.setView("board")));
  viewPath = document.createElement("p");
  viewPath.className = "meta vl-path";
  head.appendChild(viewPath);
  viewCount = document.createElement("p");
  viewCount.className = "meta";
  head.appendChild(viewCount);
  viewChips = document.createElement("div");
  viewChips.className = "vl-chips";
  head.appendChild(viewChips);
  viewAdd = document.createElement("button");
  viewAdd.className = "vl-add vl-view-add";
  viewAdd.disabled = true;
  viewAdd.textContent = "Add selected to library";
  viewAdd.addEventListener("click", () => addSelectedToLibrary());
  head.appendChild(viewAdd);
  const nc = newCategoryRow();
  viewNewCat = nc.input;
  head.appendChild(nc.row);
  container.appendChild(head);
  viewMasonry = document.createElement("div");
  viewMasonry.className = "vl-masonry";
  container.appendChild(viewMasonry);
  viewBuilt = true;
  viewContainer = container;
}

function renderView(container) {
  // The core calls render again on board changes while the view
  // is active; rebuilding the shell each time would steal the
  // search box focus, so a built shell is only updated.
  if (viewBuilt && viewContainer === container) {
    renderViewDynamic();
    return;
  }
  container.innerHTML = "";
  buildView(container);
  renderViewDynamic();
}

async function refresh() {
  if (!apiRef) return;
  try {
    const res = await apiRef.files.listLibrary();
    libraryPath = res.path;
    items = res.items;
    categories = res.categories;
    uncategorizedCount = res.uncategorizedCount;
    // A category deleted outside the app must not leave a filter
    // pointing at nothing.
    if (selectedCategory !== "all" && selectedCategory !== "uncategorized" &&
        !categories.some((c) => c.name === selectedCategory)) {
      selectedCategory = "all";
    }
    if (selectedCategory === "uncategorized" && uncategorizedCount === 0) selectedCategory = "all";
  } catch (e) {
    if (apiRef) apiRef.ui.toast(`Could not list library: ${String(e)}`);
    items = [];
    categories = [];
    uncategorizedCount = 0;
  }
  updateAllDynamic();
}

let resizeHandler = null;

export function activate(api) {
  apiRef = api;
  resizeHandler = () => { if (viewMasonry) renderViewDynamic(); };
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
      viewBuilt = false;
      viewContainer = null;
      viewSearch = null;
      viewChips = null;
      viewMasonry = null;
      viewCount = null;
      viewPath = null;
      viewAdd = null;
      viewNewCat = null;
      api.ui.showPanel("library");
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
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  resizeHandler = null;
  apiRef = null;
  panelSearch = null;
  panelChips = null;
  panelGrid = null;
  panelCount = null;
  panelPath = null;
  panelAdd = null;
  panelNewCat = null;
  viewContainer = null;
  viewBuilt = false;
  viewSearch = null;
  viewChips = null;
  viewMasonry = null;
  viewCount = null;
  viewPath = null;
  viewAdd = null;
  viewNewCat = null;
}
