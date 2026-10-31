// Visual Library — bundled Bowerbird plugin (see PLUGIN_API.md).
// A panel over a library folder on disk (board/library/, temp
// folder in demo so a demo never touches the real library).
// Images and PDFs in that folder appear here with thumbnails,
// searchable by filename. Click places the item at the camera
// centre; drag places it at the drop point. Either way the result
// is an ordinary Image or PdfCard, board-owned via files:embed,
// not a plugin card — so it survives with or without this plugin.
// Listing and copying are scoped to the library folder through
// the core (api.files.listLibrary / addToLibrary); the plugin
// never gets an arbitrary folder to list or copy to.
let apiRef = null;
let items = [];
let libraryPath = "";
let query = "";

let searchInput = null;
let gridEl = null;
let countEl = null;
let pathEl = null;
let addBtn = null;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function filtered() {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => it.name.toLowerCase().includes(q));
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
  // centreWorld and dropWorld are both world points; the card is
  // centred on whichever one the caller passed.
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

function renderGrid() {
  if (!gridEl) return;
  const list = filtered();
  gridEl.innerHTML = "";
  countEl.textContent = items.length === 0
    ? "Library is empty."
    : `${list.length} of ${items.length} item${items.length === 1 ? "" : "s"}`;
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "meta";
    empty.textContent = "Drop images or PDFs into the library folder, then Refresh. They appear here, searchable by filename.";
    gridEl.appendChild(empty);
    return;
  }
  if (list.length === 0) {
    const none = document.createElement("p");
    none.className = "meta";
    none.textContent = "No matches.";
    gridEl.appendChild(none);
    return;
  }
  for (const item of list) {
    const b = document.createElement("button");
    b.className = "vl-item";
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

    // Drag to place: mouse tracking, not HTML5 drag, so the drop
    // is a plain board position, not a file drop the core has to
    // understand. A plain click (no drag) places at camera centre.
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
    gridEl.appendChild(b);
  }
}

async function refresh() {
  try {
    const res = await apiRef.files.listLibrary();
    libraryPath = res.path;
    items = res.items;
    if (pathEl) {
      pathEl.textContent = `Folder: ${libraryPath}`;
      pathEl.title = libraryPath;
    }
  } catch (e) {
    apiRef.ui.toast(`Could not list library: ${String(e)}`);
    items = [];
  }
  renderGrid();
  updateAddButton();
}

function updateAddButton() {
  if (!addBtn) return;
  let n = 0;
  try {
    const selected = new Set(apiRef.board.getSelected());
    for (const it of apiRef.board.getItems()) {
      if (!selected.has(it.id)) continue;
      if ("Image" in it.kind || "PdfCard" in it.kind) n += 1;
    }
  } catch { n = 0; }
  addBtn.disabled = n === 0;
  addBtn.textContent = n === 0 ? "Add selected to library" : `Add selected to library (${n})`;
}

function initPanel(body) {
  searchInput = document.createElement("input");
  searchInput.className = "vl-search";
  searchInput.type = "search";
  searchInput.placeholder = "Search library…";
  // Search only re-renders the grid, never the whole panel, so
  // typing does not steal focus or reset the input.
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    renderGrid();
  });
  body.appendChild(searchInput);

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
  body.appendChild(row);

  pathEl = document.createElement("p");
  pathEl.className = "meta vl-path";
  body.appendChild(pathEl);

  countEl = document.createElement("p");
  countEl.className = "meta";
  body.appendChild(countEl);

  gridEl = document.createElement("div");
  gridEl.className = "vl-grid";
  body.appendChild(gridEl);

  addBtn = document.createElement("button");
  addBtn.className = "vl-add";
  addBtn.disabled = true;
  addBtn.textContent = "Add selected to library";
  addBtn.addEventListener("click", async () => {
    const selected = new Set(apiRef.board.getSelected());
    const toAdd = [];
    for (const it of apiRef.board.getItems()) {
      if (!selected.has(it.id)) continue;
      if ("Image" in it.kind) toAdd.push(it.kind.Image.path);
      else if ("PdfCard" in it.kind) toAdd.push(it.kind.PdfCard.path);
    }
    if (toAdd.length === 0) return;
    let added = 0;
    for (const p of toAdd) {
      try { await apiRef.files.addToLibrary(p); added += 1; } catch { /* skip one bad file, keep the rest */ }
    }
    apiRef.ui.toast(added === 1 ? "Added 1 item to library" : `Added ${added} items to library`);
    await refresh();
  });
  body.appendChild(addBtn);

  apiRef.events.on("selection", updateAddButton);
  apiRef.events.on("board", updateAddButton);
  refresh();
}

export function activate(api) {
  apiRef = api;
  api.ui.registerPanel({
    id: "library",
    title: "Visual Library",
    render: (container) => initPanel(container),
  });
  api.ui.registerCommand({
    id: "refresh-library",
    title: "Refresh Visual Library",
    run: () => refresh(),
  });
}

export function deactivate() {
  // The core removes the panel and the command on deactivate.
  // Panel listeners die with the removed panel DOM; the ghost,
  // if a drag was in flight, is removed on mouseup.
  apiRef = null;
  searchInput = null;
  gridEl = null;
  countEl = null;
  pathEl = null;
  addBtn = null;
}
