// Visual Library — the library surfaces. The panel in the
// right dock and the whiteboard view, both rendering the
// same sections through the same spanning masonry layout,
// plus the shared search row and the selection highlight.
// Owns the panel and view element refs, and the panel's
// layout observers.
import type { PluginContext } from "../../src/plugins";
import type { Item } from "../../src/model";
import { createCategory, deleteCategory, getBoardItems, getCategories, getQuery, isSectionCollapsed, renameCategory, sectionsList, setQuery, setSectionCollapsed, syncFromBoard } from "./items.js";
import type { LibraryMode } from "./items.js";
import { attachCardInteractions } from "./interactions.js";
import { getLibAudioItemId, hasLibAudio, loadLibraryAudioDuration, rewireLibraryAudio, stopLibraryAudio } from "./audio.js";

// The category whose name is being edited inline, if any.
// Set when a category is created (so the user names it
// straight away) or when its name is double-clicked.
let editingCategory: string | null = null;

export function setEditingCategory(id: string | null): void {
  editingCategory = id;
}

// Panel refs (built once by initPanel).
let panelSearch: HTMLInputElement | null = null;
let panelSections: HTMLElement | null = null;

// View refs (built on each activation, cleared on hide).
let viewBuilt = false;
let viewSearch: HTMLInputElement | null = null;
let viewSections: HTMLElement | null = null;

// The panel's layout observers, so deactivate() can
// disconnect them instead of leaving a pair behind on
// every disable/re-enable cycle.
let panelIntersectionObserver: IntersectionObserver | null = null;
let panelResizeObserver: ResizeObserver | null = null;

export function getPanelSections(): HTMLElement | null {
  return panelSections;
}

export function getViewSections(): HTMLElement | null {
  return viewSections;
}

export function isViewBuilt(): boolean {
  return viewBuilt;
}

export function clearPanelRefs(): void {
  panelSearch = null;
  panelSections = null;
}

export function viewContainerClear(): void {
  viewBuilt = false;
  viewSearch = null;
  viewSections = null;
}

export function disconnectPanelObservers(): void {
  if (panelIntersectionObserver) panelIntersectionObserver.disconnect();
  if (panelResizeObserver) panelResizeObserver.disconnect();
  panelIntersectionObserver = null;
  panelResizeObserver = null;
}

export function updateAllDynamic(api: PluginContext): void {
  // A re-render drops the DOM the audio preview was wired
  // to, but the preview itself is a standalone Audio
  // object: keep it playing while its card is still on
  // the board, and re-wire its controls to the fresh DOM.
  // Only stop it when its card is gone.
  const playingId = getLibAudioItemId();
  if (panelSections) renderSections(api, panelSections, "panel");
  if (viewSections) renderSections(api, viewSections, "view");
  if (playingId !== null && hasLibAudio()) {
    if (getBoardItems().some((it) => it.id === playingId)) rewireLibraryAudio([panelSections, viewSections]);
    else stopLibraryAudio();
  }
}

// Selection preview: when the board selection changes, the
// library marks the selected cards and scrolls the first one
// into view, so selecting on the board previews in the
// library and vice versa. No re-render: re-rendering would
// drop the scroll position and any audio preview.
export function updateSelectionHighlight(api: PluginContext): void {
  const selected = new Set(api.board.getSelected());
  let first: HTMLElement | null = null;
  for (const sections of [panelSections, viewSections]) {
    if (!sections) continue;
    for (const wrap of sections.querySelectorAll(".vl-board-wrap")) {
      const el = wrap as HTMLElement;
      const isSel = selected.has(Number(el.dataset.boardId));
      el.classList.toggle("vl-selected", isSel);
      if (isSel && !first) first = el;
    }
  }
  if (first && typeof first.scrollIntoView === "function") {
    try { first.scrollIntoView({ block: "nearest" }); } catch { /* older Chromium */ }
  }
}

export function layoutMasonry(api: PluginContext, container: HTMLElement, items: Item[], mode: LibraryMode): void {
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
  // No third-party package: this is thirty lines, and it
  // works offline.
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
  const colHeights: number[] = new Array(colCount).fill(0);
  for (const item of items) {
    const html = api.board.renderCard(item.id);
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
    if (api.board.getSelected().includes(item.id)) wrap.classList.add("vl-selected");
    wrap.dataset.boardId = String(item.id);
    wrap.style.left = `${start * (colWidth + gap) + (spanWidth - w) / 2}px`;
    wrap.style.top = `${best}px`;
    wrap.style.width = `${w}px`;
    wrap.style.height = `${h}px`;
    wrap.innerHTML = html;
    const inner = wrap.firstElementChild as HTMLElement | null;
    if (inner) {
      inner.style.transform = `scale(${scale})`;
      inner.style.transformOrigin = "top left";
    }
    attachCardInteractions(api, wrap, item, mode);
    if ("Audio" in item.kind) loadLibraryAudioDuration(api, wrap, item);
    container.appendChild(wrap);
    for (let c = start; c < start + span; c++) colHeights[c] = best + h + gap;
  }
  container.style.height = `${Math.max(0, Math.max(...colHeights) - gap)}px`;
}

export function renderSections(api: PluginContext, container: HTMLElement, mode: LibraryMode): void {
  container.innerHTML = "";
  const sections = sectionsList();
  if (sections.length === 0) return;
  for (const section of sections) {
    const wrap = document.createElement("div");
    wrap.className = "vl-category";
    wrap.dataset.category = section.key;
    const head = document.createElement("button");
    head.className = "vl-category-head";
    const isCollapsed = isSectionCollapsed(section.key);
    const arrow = document.createElement("span");
    arrow.className = "vl-arrow";
    arrow.textContent = isCollapsed ? "▸" : "▾";
    head.append(arrow);
    // A user category's name is editable inline: it starts
    // in edit mode when the category is created, and a
    // double-click renames it later. Uncategorized has no
    // rename and no delete — it is the default, not a
    // category the user made.
    const isUserCategory = section.key !== "uncategorized";
    if (section.key === editingCategory) {
      const input = document.createElement("input");
      input.className = "vl-category-rename";
      input.type = "text";
      input.value = section.label;
      input.setAttribute("aria-label", "Category name");
      let done = false;
      const commit = (save: boolean) => {
        if (done) return;
        done = true;
        if (save) renameCategory(api, section.key, input.value);
        editingCategory = null;
        updateAllDynamic(api);
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(true);
        else if (e.key === "Escape") commit(false);
      });
      input.addEventListener("blur", () => commit(true));
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("dblclick", (e) => e.stopPropagation());
      head.append(input);
      // Focus after the section is in the document, so the
      // input is laid out and the text can be selected.
      queueMicrotask(() => { input.focus(); input.select(); });
    } else {
      const name = document.createElement("span");
      name.className = "vl-category-name";
      name.textContent = section.label;
      if (isUserCategory) {
        name.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          editingCategory = section.key;
          updateAllDynamic(api);
        });
      }
      head.append(name);
    }
    const count = document.createElement("span");
    count.className = "vl-count";
    count.textContent = `(${section.items.length})`;
    head.append(count);
    if (isUserCategory) {
      const del = document.createElement("span");
      del.className = "vl-category-delete";
      del.textContent = "×";
      del.title = "Delete category";
      del.setAttribute("aria-label", "Delete category");
      del.addEventListener("click", (e) => {
        // Inside the collapse button: stop the click from
        // toggling the section as well. Deleting a category
        // never deletes its cards — they return to
        // Uncategorized.
        e.stopPropagation();
        deleteCategory(api, section.key);
        updateAllDynamic(api);
      });
      head.append(del);
    }
    head.addEventListener("click", () => {
      // Keep the scroll position: collapsing a section far
      // down should not jump the library back to the top.
      const panelTop = panelSections ? panelSections.scrollTop : 0;
      const viewTop = viewSections ? viewSections.scrollTop : 0;
      setSectionCollapsed(section.key, !isCollapsed);
      updateAllDynamic(api);
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
      layoutMasonry(api, body, section.items, mode);
    }
  }
}

export function searchRow(api: PluginContext, targetView: LibraryMode): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = document.createElement("div");
  row.className = "vl-search-row";
  const input = document.createElement("input");
  input.className = "vl-search";
  input.type = "text";
  input.placeholder = "Search library…";
  input.value = getQuery();
  // Without this, the core window keydown handler sees every
  // key typed here: v/p/a would switch tools, Delete would
  // delete the selected card, +/- would zoom, and so on.
  // The core only guards textareas and the board search
  // input, so a plugin input must stop its own keydown.
  input.addEventListener("keydown", (e) => e.stopPropagation());
  // Debounced like the board search (150 ms): the
  // input handler used to rebuild the whole library —
  // panel and view masonry — on every keystroke.
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener("input", () => {
    setQuery(input.value);
    if (panelSearch && panelSearch !== input) panelSearch.value = getQuery();
    if (viewSearch && viewSearch !== input) viewSearch.value = getQuery();
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; updateAllDynamic(api); }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && searchTimer !== null) {
      clearTimeout(searchTimer);
      searchTimer = null;
      updateAllDynamic(api);
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
    api.view.setView(toView ? "library" : "board");
  });
  // New category: creates one and puts its name straight
  // into edit mode, so the user names it on the spot.
  // The default name counts the categories already there,
  // so the first is "Category 1", not a bare "Category".
  const addBtn = document.createElement("button");
  addBtn.className = "vl-icon-btn";
  addBtn.title = "New category";
  addBtn.setAttribute("aria-label", "New category");
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    const n = getCategories().length + 1;
    const cat = createCategory(api, `Category ${n}`);
    editingCategory = cat.id;
    updateAllDynamic(api);
  });
  row.append(input, addBtn, btn);
  return { row, input };
}

export function initPanel(api: PluginContext, body: HTMLElement): void {
  const sr = searchRow(api, "view");
  panelSearch = sr.input;
  body.appendChild(sr.row);
  const sections = document.createElement("div");
  sections.className = "vl-sections";
  panelSections = sections;
  body.appendChild(sections);
  if (syncFromBoard(api, true)) updateAllDynamic(api);
  // Re-lay out when the panel is first shown: the first
  // render happened while it was hidden, so even with the
  // fallback width above, the layout must be redone at
  // the panel's real width the moment it becomes visible.
  // The observer fires on the hidden-to-visible change
  // only, not on child changes, so it does not loop.
  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && panelSections) renderSections(api, panelSections, "panel");
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
      renderSections(api, panelSections, "panel");
    });
    panelResizeObserver = ro;
    ro.observe(sections);
  }
}

export function buildView(api: PluginContext, container: HTMLElement): void {
  const head = document.createElement("div");
  head.className = "vl-view-head";
  const h = document.createElement("h2");
  h.textContent = "Visual Library";
  head.appendChild(h);
  const sr = searchRow(api, "panel");
  viewSearch = sr.input;
  head.appendChild(sr.row);
  container.appendChild(head);
  const sections = document.createElement("div");
  sections.className = "vl-sections";
  viewSections = sections;
  container.appendChild(sections);
  viewBuilt = true;
  if (syncFromBoard(api, true)) updateAllDynamic(api);
}
