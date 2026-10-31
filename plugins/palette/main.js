// Palette — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// A panel of curated colour palettes, not a library of the
// board's own cards (that is Visual Library). Palettes are
// static, bundled in this file, with no network and no
// storage: the plugin needs nothing from the board except
// to place a swatch on it.
//
// Click a colour to place a 120x120 swatch at the camera
// centre, the same size as a board swatch. Drag a colour
// to place it at the drop point, centred there, the same
// interaction as Visual Library, so there is nothing new
// to learn. A placed swatch is an ordinary board item of
// kind Swatch, not a plugin card, so it survives disabling
// the plugin — the board never depends on Palette to keep
// its colours.
//
// Board geometry lives in #board now, below the title bar:
// its client size is the visible board, and its top edge is
// the board's origin in client coordinates. Centre and drop
// points go through it, never window size or raw client
// coordinates, or a swatch lands 48px low.
let apiRef = null;

const PALETTES = [
  { name: "Forest", colors: ["#1E3A2F", "#2F5D3A", "#4A7C59", "#7BA889", "#C8D8C4"] },
  { name: "Ocean", colors: ["#0B3D5F", "#176B87", "#2E8CA6", "#6FB3C4", "#C7E3E8"] },
  { name: "Sunset", colors: ["#7C2D12", "#C2410C", "#EA580C", "#F97316", "#FDBA74"] },
  { name: "Pastel", colors: ["#F9A8D4", "#FBCFE8", "#A5B4FC", "#A7F3D0", "#FDE68A"] },
  { name: "Neutral", colors: ["#1D1D1F", "#6B7280", "#9CA3AF", "#D1D5DB", "#F5F5F7"] },
  { name: "Autumn", colors: ["#78350F", "#92400E", "#B45309", "#D97706", "#F59E0B"] },
  { name: "Berry", colors: ["#4C1D95", "#6D28D9", "#9333EA", "#C084FC", "#E9D5FF"] },
  { name: "Meadow", colors: ["#365314", "#4D7C0F", "#65A30D", "#84CC16", "#BEF264"] },
  { name: "Rose", colors: ["#881337", "#BE123C", "#E11D48", "#FB7185", "#FECDD3"] },
  { name: "Slate", colors: ["#0F172A", "#1E293B", "#334155", "#64748B", "#CBD5E1"] },
];

function boardGeometry() {
  const el = document.getElementById("board");
  if (!el) return { w: window.innerWidth, h: window.innerHeight, left: 0, top: 0 };
  const r = el.getBoundingClientRect();
  return { w: el.clientWidth, h: el.clientHeight, left: r.left, top: r.top };
}

function cameraCentreWorld() {
  const cam = apiRef.view.getCamera();
  const b = boardGeometry();
  return { x: cam.x + b.w / 2 / cam.zoom, y: cam.y + b.h / 2 / cam.zoom };
}

function dropWorld(clientX, clientY) {
  const cam = apiRef.view.getCamera();
  const b = boardGeometry();
  return { x: (clientX - b.left) / cam.zoom + cam.x, y: (clientY - b.top) / cam.zoom + cam.y };
}

function placeAt(hex, point) {
  if (!apiRef) return;
  apiRef.board.addItem({ Swatch: { hex } }, { x: point.x - 60, y: point.y - 60 }, { w: 120, h: 120 });
}

function attachTileInteractions(tile, hex) {
  tile.addEventListener("click", () => {
    placeAt(hex, cameraCentreWorld());
  });
  tile.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    let moved = false;
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost = null;
    const onMove = (me) => {
      if (!moved && Math.hypot(me.clientX - startX, me.clientY - startY) > 5) {
        moved = true;
        ghost = document.createElement("div");
        ghost.className = "pal-ghost";
        ghost.style.background = hex;
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
      // Panel mode only: a drop onto the visible board
      // places the swatch. A drop back onto any UI cancels.
      const el = document.elementFromPoint(me.clientX, me.clientY);
      if (!el) return;
      if (el.closest && (el.closest(".plugin-panel") || el.closest("#toolbar") || el.closest("#title-bar") || el.closest("#settings-backdrop") || el.closest("#view-switcher"))) return;
      placeAt(hex, dropWorld(me.clientX, me.clientY));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function renderPanel(container) {
  container.innerHTML = "";
  const sections = document.createElement("div");
  sections.className = "pal-sections";
  for (const palette of PALETTES) {
    const wrap = document.createElement("div");
    wrap.className = "pal-palette";
    const head = document.createElement("div");
    head.className = "pal-head";
    head.textContent = palette.name;
    wrap.appendChild(head);
    const row = document.createElement("div");
    row.className = "pal-row";
    for (const hex of palette.colors) {
      const tile = document.createElement("button");
      tile.className = "pal-tile";
      tile.style.background = hex;
      tile.title = hex;
      tile.setAttribute("aria-label", `${palette.name} ${hex}`);
      attachTileInteractions(tile, hex);
      row.appendChild(tile);
    }
    wrap.appendChild(row);
    sections.appendChild(wrap);
  }
  container.appendChild(sections);
}

function activate(api) {
  apiRef = api;
  apiRef.ui.registerPanel({
    id: "palette",
    title: "Palette",
    render: (container) => renderPanel(container),
  });
}

function deactivate() {
  apiRef = null;
}

export { activate, deactivate };
