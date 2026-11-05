// Tidy Up — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Align and distribute the selected cards. No key object,
// no extra UI: align is to the selection's bounding box
// (its outermost edge, or its centre), distribute keeps
// the first and last cards fixed and spaces the rest
// evenly between them. That is the predictable version —
// the one a user can picture before pressing the button.
//
// Cards only. Strokes and connectors are skipped: moving
// a stroke needs its points moved too, and a connector's
// anchors move with the cards it joins, so setting a
// stroke or connector's position alone would not move
// what is drawn. Rotated cards align by their unrotated
// box, the same box the core uses for their handles.
//
// One tidy action is one undo step: the batch goes
// through api.board.updateItems, which saves once.
// (If an older core has no updateItems, the fallback
// loop through updateItem still works, just with one
// undo step per card.)
let apiRef = null;
let panelEl = null;
let metaEl = null;
let alignBtns = {};
let distributeBtns = {};

function isCard(it) {
  return it && !("Stroke" in it.kind) && !("Connector" in it.kind);
}

function selectedCards() {
  if (!apiRef) return [];
  const out = [];
  for (const id of apiRef.board.getSelected()) {
    const it = apiRef.board.getItem(id);
    if (isCard(it)) out.push(it);
  }
  return out;
}

function refresh() {
  if (!panelEl) return;
  const cards = selectedCards();
  metaEl.textContent = cards.length === 0
    ? "Select 2 or more cards to tidy. Strokes and connectors stay where they are."
    : `${cards.length} card${cards.length === 1 ? "" : "s"} selected.`;
  const alignOk = cards.length >= 2;
  for (const b of Object.values(alignBtns)) b.disabled = !alignOk;
  const distOk = cards.length >= 3;
  for (const b of Object.values(distributeBtns)) b.disabled = !distOk;
}

function apply(patches, verb) {
  if (!apiRef || patches.length === 0) return;
  // Skip cards that would not move: an align of already
  // aligned cards changes nothing, and must not create
  // an undo step or a toast for doing nothing.
  const current = new Map(selectedCards().map((c) => [c.id, c]));
  const real = patches.filter((p) => {
    const it = current.get(p.id);
    return it && (p.pos.x !== it.pos.x || p.pos.y !== it.pos.y);
  });
  if (real.length === 0) return;
  if (typeof apiRef.board.updateItems === "function") {
    apiRef.board.updateItems(real);
  } else {
    for (const p of real) apiRef.board.updateItem(p.id, { pos: p.pos });
  }
  apiRef.ui.toast(`${verb} ${real.length} card${real.length === 1 ? "" : "s"}`);
  refresh();
}

function align(axis, edge) {
  const cards = selectedCards();
  if (cards.length < 2) return;
  const posKey = axis === "x" ? "x" : "y";
  const sizeKey = axis === "x" ? "w" : "h";
  const lo = Math.min(...cards.map((c) => c.pos[posKey]));
  const hi = Math.max(...cards.map((c) => c.pos[posKey] + c.size[sizeKey]));
  const mid = (lo + hi) / 2;
  const patches = cards.map((c) => {
    const target = edge === "start" ? lo : edge === "end" ? hi - c.size[sizeKey] : mid - c.size[sizeKey] / 2;
    return { id: c.id, pos: { ...c.pos, [posKey]: Math.round(target) } };
  });
  apply(patches, "Aligned");
}

function distribute(axis) {
  const cards = selectedCards();
  if (cards.length < 3) return;
  const posKey = axis === "x" ? "x" : "y";
  const sizeKey = axis === "x" ? "w" : "h";
  const sorted = [...cards].sort((a, b) => (a.pos[posKey] - b.pos[posKey]) || (a.id - b.id));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = (last.pos[posKey] + last.size[sizeKey]) - first.pos[posKey];
  const total = sorted.reduce((sum, c) => sum + c.size[sizeKey], 0);
  // Gap clamped at 0: overlapping cards end up touching
  // rather than stacked on top of each other.
  const gap = Math.max(0, (span - total) / (sorted.length - 1));
  let cursor = first.pos[posKey];
  const patches = sorted.map((c) => {
    const p = { id: c.id, pos: { ...c.pos, [posKey]: Math.round(cursor) } };
    cursor += c.size[sizeKey] + gap;
    return p;
  });
  apply(patches, "Distributed");
}

function iconBtn(label, svg, title, onClick) {
  const b = document.createElement("button");
  b.className = "tidy-btn";
  b.type = "button";
  b.innerHTML = svg + `<span>${label}</span>`;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

function svg(inner) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function renderPanel(container) {
  panelEl = container;
  container.innerHTML = "";
  metaEl = document.createElement("p");
  metaEl.className = "tidy-meta";
  container.appendChild(metaEl);

  const alignHead = document.createElement("p");
  alignHead.className = "tidy-head";
  alignHead.textContent = "Align";
  container.appendChild(alignHead);
  const alignGrid = document.createElement("div");
  alignGrid.className = "tidy-grid";
  const aligns = [
    ["Left", svg('<path d="M4 4v16"/><rect x="7" y="5" width="8" height="4"/><rect x="7" y="14" width="12" height="4"/>'), "Align left", () => align("x", "start")],
    ["Centre", svg('<path d="M12 4v16"/><rect x="8" y="5" width="8" height="4"/><rect x="6" y="14" width="12" height="4"/>'), "Align centre", () => align("x", "centre")],
    ["Right", svg('<path d="M20 4v16"/><rect x="9" y="5" width="8" height="4"/><rect x="5" y="14" width="12" height="4"/>'), "Align right", () => align("x", "end")],
    ["Top", svg('<path d="M4 4h16"/><rect x="5" y="7" width="4" height="8"/><rect x="14" y="7" width="4" height="12"/>'), "Align top", () => align("y", "start")],
    ["Middle", svg('<path d="M4 12h16"/><rect x="5" y="8" width="4" height="8"/><rect x="14" y="6" width="4" height="12"/>'), "Align middle", () => align("y", "centre")],
    ["Bottom", svg('<path d="M4 20h16"/><rect x="5" y="9" width="4" height="8"/><rect x="14" y="5" width="4" height="12"/>'), "Align bottom", () => align("y", "end")],
  ];
  for (const [label, icon, title, run] of aligns) {
    const b = iconBtn(label, icon, title, run);
    alignBtns[label] = b;
    alignGrid.appendChild(b);
  }
  container.appendChild(alignGrid);

  const distHead = document.createElement("p");
  distHead.className = "tidy-head tidy-head-sep";
  distHead.textContent = "Distribute";
  container.appendChild(distHead);
  const distGrid = document.createElement("div");
  distGrid.className = "tidy-grid tidy-grid-2";
  const dists = [
    ["Horizontally", svg('<rect x="3" y="9" width="4" height="6"/><rect x="10" y="9" width="4" height="6"/><rect x="17" y="9" width="4" height="6"/><path d="M4 4h16"/>'), "Distribute horizontally", () => distribute("x")],
    ["Vertically", svg('<rect x="9" y="3" width="6" height="4"/><rect x="9" y="10" width="6" height="4"/><rect x="9" y="17" width="6" height="4"/><path d="M4 4v16"/>'), "Distribute vertically", () => distribute("y")],
  ];
  for (const [label, icon, title, run] of dists) {
    const b = iconBtn(label, icon, title, run);
    distributeBtns[label] = b;
    distGrid.appendChild(b);
  }
  container.appendChild(distGrid);
  refresh();
}

let onSelectionHandler = null;
let onBoardHandler = null;

function activate(api) {
  apiRef = api;
  onSelectionHandler = () => refresh();
  onBoardHandler = () => refresh();
  apiRef.events.on("selection", onSelectionHandler);
  apiRef.events.on("board", onBoardHandler);
  apiRef.ui.registerPanel({
    id: "tidy-up",
    title: "Tidy Up",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="7" y="5" width="9" height="4"/><rect x="7" y="11" width="13" height="4"/><rect x="7" y="17" width="6" height="4"/></svg>',
    render: (container) => renderPanel(container),
  });
}

function deactivate() {
  if (apiRef && onSelectionHandler) apiRef.events.off("selection", onSelectionHandler);
  if (apiRef && onBoardHandler) apiRef.events.off("board", onBoardHandler);
  onSelectionHandler = null;
  onBoardHandler = null;
  panelEl = null;
  metaEl = null;
  alignBtns = {};
  distributeBtns = {};
  apiRef = null;
}

export { activate, deactivate };
