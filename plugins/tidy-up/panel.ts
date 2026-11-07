// Tidy Up — the panel: the meta line, the Align and
// Distribute button grids, and the apply step that writes
// the patches in one undo step. The maths lives in ops.ts;
// this file owns the panel DOM and the API calls.
import type { PluginContext } from "../../src/plugins";
import type { Item } from "../../src/model";
import { alignPatches, distributePatches, isCard } from "./ops.js";
import type { Axis, Edge, PositionPatch } from "./ops.js";

let panelEl: HTMLElement | null = null;
let metaEl: HTMLParagraphElement | null = null;
let alignBtns: Record<string, HTMLButtonElement> = {};
let distributeBtns: Record<string, HTMLButtonElement> = {};

function selectedCards(api: PluginContext): Item[] {
  const out: Item[] = [];
  for (const id of api.board.getSelected()) {
    const it = api.board.getItem(id);
    if (isCard(it)) out.push(it);
  }
  return out;
}

export function refresh(api: PluginContext): void {
  if (!panelEl || !metaEl) return;
  const cards = selectedCards(api);
  metaEl.textContent = `${cards.length} card${cards.length === 1 ? "" : "s"} selected.`;
  const alignOk = cards.length >= 2;
  for (const b of Object.values(alignBtns)) b.disabled = !alignOk;
  const distOk = cards.length >= 3;
  for (const b of Object.values(distributeBtns)) b.disabled = !distOk;
}

function apply(api: PluginContext, patches: PositionPatch[], verb: string): void {
  if (patches.length === 0) return;
  // Skip cards that would not move: an align of already
  // aligned cards changes nothing, and must not create
  // an undo step or a toast for doing nothing.
  const current = new Map(selectedCards(api).map((c) => [c.id, c]));
  const real = patches.filter((p) => {
    const it = current.get(p.id);
    return it && (p.pos.x !== it.pos.x || p.pos.y !== it.pos.y);
  });
  if (real.length === 0) return;
  // One tidy action is one undo step: the batch goes
  // through api.board.updateItems, which saves once.
  // (If an older core has no updateItems, the fallback
  // loop through updateItem still works, just with one
  // undo step per card.)
  if (typeof api.board.updateItems === "function") {
    api.board.updateItems(real);
  } else {
    for (const p of real) api.board.updateItem(p.id, { pos: p.pos });
  }
  api.ui.toast(`${verb} ${real.length} card${real.length === 1 ? "" : "s"}`);
  refresh(api);
}

function align(api: PluginContext, axis: Axis, edge: Edge): void {
  const cards = selectedCards(api);
  if (cards.length < 2) return;
  apply(api, alignPatches(cards, axis, edge), "Aligned");
}

function distribute(api: PluginContext, axis: Axis): void {
  const cards = selectedCards(api);
  if (cards.length < 3) return;
  apply(api, distributePatches(cards, axis), "Distributed");
}

function iconBtn(label: string, svg: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tidy-btn";
  b.type = "button";
  b.innerHTML = svg + `<span>${label}</span>`;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

export function renderPanel(api: PluginContext, container: HTMLElement): void {
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
  const aligns: Array<[string, string, string, () => void]> = [
    ["Left", svg('<path d="M4 4v16"/><rect x="7" y="5" width="8" height="4"/><rect x="7" y="14" width="12" height="4"/>'), "Align left", () => align(api, "x", "start")],
    ["Centre", svg('<path d="M12 4v16"/><rect x="8" y="5" width="8" height="4"/><rect x="6" y="14" width="12" height="4"/>'), "Align centre", () => align(api, "x", "centre")],
    ["Right", svg('<path d="M20 4v16"/><rect x="9" y="5" width="8" height="4"/><rect x="5" y="14" width="12" height="4"/>'), "Align right", () => align(api, "x", "end")],
    ["Top", svg('<path d="M4 4h16"/><rect x="5" y="7" width="4" height="8"/><rect x="14" y="7" width="4" height="12"/>'), "Align top", () => align(api, "y", "start")],
    ["Middle", svg('<path d="M4 12h16"/><rect x="5" y="8" width="4" height="8"/><rect x="14" y="6" width="4" height="12"/>'), "Align middle", () => align(api, "y", "centre")],
    ["Bottom", svg('<path d="M4 20h16"/><rect x="5" y="9" width="4" height="8"/><rect x="14" y="5" width="4" height="12"/>'), "Align bottom", () => align(api, "y", "end")],
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
  const dists: Array<[string, string, string, () => void]> = [
    ["Horizontally", svg('<rect x="3" y="9" width="4" height="6"/><rect x="10" y="9" width="4" height="6"/><rect x="17" y="9" width="4" height="6"/><path d="M4 4h16"/>'), "Distribute horizontally", () => distribute(api, "x")],
    ["Vertically", svg('<rect x="9" y="3" width="6" height="4"/><rect x="9" y="10" width="6" height="4"/><rect x="9" y="17" width="6" height="4"/><path d="M4 4v16"/>'), "Distribute vertically", () => distribute(api, "y")],
  ];
  for (const [label, icon, title, run] of dists) {
    const b = iconBtn(label, icon, title, run);
    distributeBtns[label] = b;
    distGrid.appendChild(b);
  }
  container.appendChild(distGrid);
  refresh(api);
}

export function clearPanel(): void {
  panelEl = null;
  metaEl = null;
  alignBtns = {};
  distributeBtns = {};
}
