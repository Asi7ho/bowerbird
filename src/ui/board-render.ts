// The board's render loop: the grid, the camera transform, the
// SVG strokes/connectors, the group frames, the card HTML, the
// selection and resize/rotate handles, and the drag previews.
// Rendering reads the board through S.api and the cached board;
// it never calls an input function (the dependency runs
// board-state <- board-render <- board-input <- board.ts).
import {
  S,
  ACCENT,
  boardSize, isFrameCard, toScreen,
} from "./board-state";
import { groupBounds, isRotatable, rotateHandleWorld, strokePath, svgEl2 } from "./board-geometry";
import {
  Board, GRID, Item,
  pressureWidth, smoothStrokePressures, smoothStrokeSamples, strokeMaxWidth, strokePressuresVary,
} from "../backend/model";
import { syncModel3DViews } from "../backend/model3d";

// ---------------------------------------------------------------- rendering

// The grid is a CSS background, not SVG nodes: a repeating dot or
// line pattern whose size and offset follow the camera. Panning
// then costs two style properties, not rebuilding hundreds of
// circles on every frame.
export function applyGrid(): void {
  const cam = S.api.view.getCamera();
  const b = S.cachedBoard;
  const bg = b?.bg ?? "#FFFFFF";
  const grid = b?.grid ?? "Dots";
  if (grid === "Off") { S.gridEl.style.backgroundImage = "none"; return; }
  const rgb = S.api.text.parseHex(bg) ?? [247, 245, 240];
  const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const color = lum > 140 ? "#d8d8de" : "#55555a";
  let step = GRID;
  const bs = boardSize();
  while ((bs.x / cam.zoom) / step > 40 || (bs.y / cam.zoom) / step > 40) step *= 2;
  const size = step * cam.zoom;
  const offX = (Math.floor(cam.x / step) * step - cam.x) * cam.zoom;
  const offY = (Math.floor(cam.y / step) * step - cam.y) * cam.zoom;
  if (grid === "Dots") {
    S.gridEl.style.backgroundImage = `radial-gradient(circle, ${color} 1.5px, transparent 1.6px)`;
    S.gridEl.style.backgroundSize = `${size}px ${size}px`;
    S.gridEl.style.backgroundPosition = `${offX}px ${offY}px`;
    S.gridEl.style.backgroundRepeat = "repeat";
  } else {
    S.gridEl.style.backgroundImage = `linear-gradient(to right, ${color} 0 1px, transparent 1px), linear-gradient(to bottom, ${color} 0 1px, transparent 1px)`;
    S.gridEl.style.backgroundSize = `${size}px ${size}px, ${size}px ${size}px`;
    S.gridEl.style.backgroundPosition = `${offX}px ${offY}px, ${offX}px ${offY}px`;
    S.gridEl.style.backgroundRepeat = "repeat";
  }
}

// Camera-only update: one GPU transform on the SVG world and on the
// cards layer (cards live in world coordinates now), plus the grid
// offset and the resize-handle position. No DOM rebuild, no markdown,
// no image re-parse — this is what makes pan and zoom feel smooth.
export function applyCamera(): void {
  const cam = S.api.view.getCamera();
  S.worldEl.setAttribute("transform", `translate(${-cam.x * cam.zoom},${-cam.y * cam.zoom}) scale(${cam.zoom})`);
  S.groupFramesEl.style.transform = `translate(${-cam.x * cam.zoom}px,${-cam.y * cam.zoom}px) scale(${cam.zoom})`;
  S.cardsEl.style.transform = `translate(${-cam.x * cam.zoom}px,${-cam.y * cam.zoom}px) scale(${cam.zoom})`;
  S.groupsEl.style.transform = `translate(${-cam.x * cam.zoom}px,${-cam.y * cam.zoom}px) scale(${cam.zoom})`;
  applyGrid();
  updateResizeHandle();
}

// Visible world rect, with a margin so cards at the edge do not pop
// in and out while panning. Everything else is culled: for a board
// with thousands of items, render() only builds DOM for what is on
// screen, instead of rebuilding every card on every mousemove.
export function visibleRect(): { x0: number; y0: number; x1: number; y1: number } {
  const cam = S.api.view.getCamera();
  const m = 200;
  return {
    x0: cam.x - m, y0: cam.y - m,
    x1: cam.x + boardSize().x / cam.zoom + m,
    y1: cam.y + boardSize().y / cam.zoom + m,
  };
}
export function isVisibleItem(item: Item, v: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const [p, s] = S.api.geometry.itemBounds(item);
  return p.x < v.x1 && p.x + s.w > v.x0 && p.y < v.y1 && p.y + s.h > v.y0;
}

// A numeric hash, not a joined string: this runs on
// every wheel tick, and the old version allocated a
// comma-joined string over all visible ids (plus the
// selection) just to compare it with the last one.
// FNV-1a over the visible ids in board order, then the
// selection and editing state: a changed visible set
// hashes differently, and the hash is only ever compared
// with the previous hash, never persisted. It reads the
// cached board (see cachedBoard): items do not change
// while panning or zooming, only the camera does, so the
// cache is fresh wherever this runs.
export function visibleKey(): number {
  const b = S.cachedBoard;
  if (!b) return 0;
  const v = visibleRect();
  let h = 2166136261;
  const mix = (n: number): void => {
    h ^= n & 0xffffffff;
    h = Math.imul(h, 16777619);
  };
  for (const item of b.items) if (isVisibleItem(item, v)) mix(item.id);
  mix(0x9e3779b9);
  for (const id of S.api.board.getSelected()) mix(id);
  mix(S.editingId ?? -1);
  return h;
}

// After a camera move, rebuild content only if the visible set
// actually changed (new cards scrolled into view). Panning inside
// the same visible set is applyCamera() alone.
export function refreshContentIfVisibleChanged(): void {
  if (visibleKey() !== S.lastContentKey) render();
}

// Rebuild only the SVG layer (strokes/connectors), without touching
// card DOM. Used while dragging a card, so connectors attached to
// it follow in real time without re-parsing every card.
export function renderSvgOnly(): void {
  S.worldEl.innerHTML = "";
  // Fresh board: a drag may have moved items since the last
  // render, and the SVG layer must follow the live board.
  renderStrokesAndConnectors(S.api.board.get());
}

// The pencil's graphite texture, defined once in the
// canvas SVG (the parent of the world group), not in
// the world group itself: the world group is cleared
// and rebuilt on every render, so defs inside it would
// be recreated each time and the turbulence would be
// re-compiled. A tiny warm-up rect uses the filter at
// startup, so the first pencil stroke does not pay the
// first-use compile cost and lag.
function ensurePencilFilter(): void {
  const svg = S.worldEl.ownerSVGElement;
  if (!svg || svg.querySelector("#pencil-texture")) return;
  const defs = svgEl2("defs", {});
  const filter = svgEl2("filter", { id: "pencil-texture", x: "-5%", y: "-5%", width: "110%", height: "110%" });
  filter.appendChild(svgEl2("feTurbulence", { type: "fractalNoise", baseFrequency: "0.9", numOctaves: "2", seed: "7", result: "noise" }));
  filter.appendChild(svgEl2("feDisplacementMap", { in: "SourceGraphic", in2: "noise", scale: "2.5" }));
  defs.appendChild(filter);
  svg.appendChild(defs);
  // Warm-up: a 1px rect the filter paints once, so the
  // turbulence is compiled before the first pencil
  // stroke. Nearly transparent, so it reads as nothing.
  const warm = svgEl2("rect", { x: "0", y: "0", width: "1", height: "1", fill: "#1A1A1A", opacity: "0.01", filter: "url(#pencil-texture)" });
  svg.appendChild(warm);
}

export function renderStrokesAndConnectors(board: Board): void {
  ensurePencilFilter();
  const items = board.items;
  const selected = S.api.board.getSelected();
  const v = visibleRect();
  for (const item of items) {
    // A rotated stroke's extent can exceed its unrotated
    // bounding box, so culling it by that box would hide
    // it at the viewport edge: rotated strokes are always
    // drawn. The count is small, so this costs nothing.
    if (!("Stroke" in item.kind && S.api.geometry.itemRotation(item) !== 0) && !isVisibleItem(item, v)) continue;
    if ("Stroke" in item.kind) {
      const { points, color, width, marker, pressures, pencil } = item.kind.Stroke;
      if (points.length < 2) continue;
      const d = strokePath(item, points, color, width);
      const sel = selected.includes(item.id);
      // Rotation is an SVG transform around the stroke's
      // bounding-box centre, in world coords: the points
      // themselves are never rewritten, so undo, resize
      // and hit-testing all keep working in the local
      // frame, and rotation is just item.rotation.
      const rot = S.api.geometry.itemRotation(item);
      const c = S.api.geometry.centre(item);
      const transform = rot !== 0 ? `rotate(${rot} ${c.x} ${c.y})` : undefined;
      if (sel) {
        const selPath = svgEl2("path", { d, fill: "none", stroke: ACCENT, "stroke-width": String(strokeMaxWidth(item.kind.Stroke) + 6), "stroke-linecap": "round", "stroke-linejoin": "round" });
        if (transform) selPath.setAttribute("transform", transform);
        S.worldEl.appendChild(selPath);
      }
      // A pencil stroke's ink is wrapped in a group
      // carrying the graphite texture filter, so the
      // rough edge applies to the whole stroke at once,
      // not per segment. The selection highlight above
      // stays outside the group, and stays smooth.
      const ink = pencil ? svgEl2("g", { filter: "url(#pencil-texture)" }) : null;
      const target = ink ?? S.worldEl;
      if (pressures && strokePressuresVary(item.kind.Stroke)) {
        // A pen stroke is one line per short sample along
        // the smooth curve, each at the width its pressure
        // makes; a uniform stroke stays a single path, as
        // before. Lines between the sparse raw points would
        // kink at every joint when drawn fast.
        const pts = smoothStrokeSamples(points);
        const prs = smoothStrokePressures(pressures);
        for (let i = 0; i + 1 < pts.length; i++) {
          const w = pressureWidth(width, (prs[i] + prs[i + 1]) / 2);
          const line = svgEl2("line", { x1: String(pts[i].x), y1: String(pts[i].y), x2: String(pts[i + 1].x), y2: String(pts[i + 1].y), stroke: color, "stroke-width": String(w), "stroke-linecap": "round" });
          if (transform) line.setAttribute("transform", transform);
          if (marker) line.setAttribute("opacity", "0.45");
          target.appendChild(line);
        }
      } else {
        const path = svgEl2("path", { d, fill: "none", stroke: color, "stroke-width": String(width), "stroke-linecap": "round", "stroke-linejoin": "round" });
        if (transform) path.setAttribute("transform", transform);
        if (marker) path.setAttribute("opacity", "0.45");
        target.appendChild(path);
      }
      if (ink) S.worldEl.appendChild(ink);
    }
    if ("Connector" in item.kind) {
      const ends = S.api.geometry.clippedEnds(item.kind.Connector.from, item.kind.Connector.to);
      if (!ends) continue;
      const [a, b] = ends;
      const sel = selected.includes(item.id);
      S.worldEl.appendChild(svgEl2("line", { x1: String(a.x), y1: String(a.y), x2: String(b.x), y2: String(b.y), stroke: sel ? ACCENT : "#333333", "stroke-width": sel ? "3" : "2" }));
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / len, uy = dy / len;
      const head = 12, spread = 0.45;
      const c1 = Math.cos(spread), s1 = Math.sin(spread), c2 = Math.cos(-spread), s2 = Math.sin(-spread);
      const p1 = { x: b.x - head * (ux * c1 - uy * s1), y: b.y - head * (ux * s1 + uy * c1) };
      const p2 = { x: b.x - head * (ux * c2 - uy * s2), y: b.y - head * (ux * s2 + uy * c2) };
      S.worldEl.appendChild(svgEl2("polyline", { points: `${p1.x},${p1.y} ${b.x},${b.y} ${p2.x},${p2.y}`, fill: "none", stroke: sel ? ACCENT : "#333333", "stroke-width": sel ? "3" : "2" }));
    }
  }
  // Live stroke, connector preview and marquee are fast-path SVG
  // nodes updated directly during the drag (see mousemove); they
  // are not part of a content rebuild, or every pen point would
  // rebuild every card.
}

export function renderGroupFrames(board: Board): void {
  if (!S.groupsEl || !S.groupFramesEl) return;
  const selected = S.api.board.getSelected();
  const v = visibleRect();
  // The border and its label live in separate layers: the
  // border goes below the cards, so a card placed over a
  // frame's edge covers the dashed line instead of the line
  // painting over the card; the label stays above the cards
  // in #groups, so it keeps taking clicks for rename. The
  // label sits astride the frame's top border, half above
  // it, so its position is the frame's top-left plus the
  // same 12px in and 11px up it had as the frame's child.
  let framesHtml = "";
  let labelsHtml = "";
  // One pass over the items, grouped by group id: the old
  // version filtered the whole item list once per group
  // (and groupBounds scanned it again), so a board with
  // many groups paid O(groups x items) per render.
  const byGroup = new Map<number, Item[]>();
  for (const it of board.items) {
    if (it.group === null) continue;
    const list = byGroup.get(it.group);
    if (list) list.push(it);
    else byGroup.set(it.group, [it]);
  }
  for (const [g, members] of byGroup) {
    if (members.length < 2) continue;
    const b = groupBounds(members, S.api.geometry.itemBounds);
    if (!b) continue;
    if (b.x > v.x1 || b.y > v.y1 || b.x + b.w < v.x0 || b.y + b.h < v.y0) continue;
    const isSel = members.some((it) => selected.includes(it.id));
    const label = board.groups?.[g]?.label ?? `Section ${g}`;
    framesHtml += `<div class="group-frame${isSel ? " selected" : ""}" data-group="${g}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"></div>`;
    labelsHtml += `<span class="group-label" data-group="${g}" style="left:${b.x + 12}px;top:${b.y - 11}px">${S.api.text.escapeHtml(label)}</span>`;
  }
  S.groupFramesEl.innerHTML = framesHtml;
  S.groupsEl.innerHTML = labelsHtml;
}

export function render(): void {
  // A render requested before the board DOM exists (during
  // plugin activation) finds nothing to draw; init() renders
  // once the elements exist. Skip, do not throw.
  if (!S.boardEl) return;
  const board = S.api.board.get();
  S.cachedBoard = board;
  S.boardEl.style.background = board.bg;
  // A playing (or paused mid-way) video used to restart from 0 on
  // every render, because render() rebuilds the card DOM and the
  // <video> node with it. Capture position and playing state first,
  // and restore them onto the rebuilt nodes below.
  const videoState = new Map<number, { t: number; playing: boolean }>();
  for (const v of Array.from(S.cardsEl.querySelectorAll("video"))) {
    const card = v.closest(".card") as HTMLElement | null;
    if (!card || !card.dataset.id) continue;
    if (!v.paused || (isFinite(v.currentTime) && v.currentTime > 0)) {
      videoState.set(Number(card.dataset.id), { t: v.currentTime, playing: !v.paused });
    }
  }
  S.worldEl.innerHTML = "";
  renderStrokesAndConnectors(board);
  renderGroupFrames(board);
  // Cards: rebuild, except the note being edited (its textarea stays).
  // Only visible cards are built (see visibleRect).
  const editingEl = S.editingId !== null ? S.cardsEl.querySelector(`[data-id="${S.editingId}"]`) : null;
  // Keep the editing card as a live element, not a serialised
  // string: a textarea's outerHTML carries only its initial
  // value, never what the user typed, so re-inserting the
  // HTML emptied a note being edited whenever a render ran —
  // zooming out while typing in a new note lost the text.
  // Moving the element out of #cards (to #board, still in
  // the document) keeps its value and its listeners. The
  // move blurs the textarea, so the commit is suppressed
  // while it happens (see suppressEditCommit) and focus —
  // with the cursor where it was — is restored afterwards,
  // so the user keeps typing through a zoom or a pan.
  const editingTa = editingEl ? editingEl.querySelector("textarea.note-edit") as HTMLTextAreaElement | null : null;
  const editingWasFocused = editingTa ? document.activeElement === editingTa : false;
  const editingSel = editingTa && editingWasFocused ? [editingTa.selectionStart, editingTa.selectionEnd] as const : null;
  if (editingEl) { S.suppressEditCommit = true; S.boardEl.appendChild(editingEl); }
  const v = visibleRect();
  let html = "";
  for (const item of board.items) {
    if ("Stroke" in item.kind || "Connector" in item.kind) continue;
    if (S.editingId === item.id) continue;
    if (!isVisibleItem(item, v)) continue;
    html += S.api.board.renderCardAt(item.id) ?? "";
  }
  S.cardsEl.innerHTML = html;
  // Cards are options in the board's listbox: give them the
  // role and the selected state here, since render rebuilds
  // them. updateSelectionInner keeps aria-selected in sync
  // on a plain click, which does not re-render.
  {
    const selected = S.api.board.getSelected();
    for (const child of Array.from(S.cardsEl.children)) {
      const el = child as HTMLElement;
      if (!el.classList.contains("card")) continue;
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(selected.includes(Number(el.dataset.id))));
    }
  }
  applyStacking();
  // Mount 3D views for the Model3D cards in the DOM and
  // drop views whose card is gone or off-screen. The shared
  // WebGL layer lives in #board, not #cards, so a render
  // never touches it.
  syncModel3DViews(S.boardEl, S.cardsEl, board.items, {
    fileUrl: (p) => S.api.files.fileUrl(p),
    onSelect: (id, additive) => S.api.board.setSelected(S.api.board.selectCard(S.api.board.getSelected(), id, additive)),
  });
  for (const [id, st] of videoState) {
    const v = S.cardsEl.querySelector(`[data-id="${id}"] video`) as HTMLVideoElement | null;
    if (!v) continue;
    const restore = () => {
      try { v.currentTime = st.t; } catch { /* not ready yet */ }
      if (st.playing) v.play().catch(() => undefined);
    };
    if (v.readyState >= 1) restore();
    else v.addEventListener("loadedmetadata", restore, { once: true });
  }
  // A video whose play button was just pressed has no prior
  // element to restore from: start it. (No autoplay attribute
  // on the element: that would restart a video the user
  // paused with the native controls on every render.)
  const activeVideo = S.api.media.getVideoState().id;
  if (activeVideo !== null && !videoState.has(activeVideo)) {
    const v = S.cardsEl.querySelector(`[data-id="${activeVideo}"] video`) as HTMLVideoElement | null;
    if (v) v.play().catch(() => undefined);
  }
  if (editingEl) {
    S.cardsEl.appendChild(editingEl);
    S.suppressEditCommit = false;
    // The move blurred the textarea; give the cursor back
    // where it was, so a zoom or a pan mid-edit does not
    // kick the user out of the text box.
    if (editingTa && editingWasFocused) {
      editingTa.focus();
      if (editingSel) {
        try { editingTa.setSelectionRange(editingSel[0], editingSel[1]); } catch { /* selection may be out of range after a re-measure */ }
      }
    }
  }
  // Drag path cache: updateDraggedCards runs on every
  // pointermove, and the old version did three
  // attribute-selector queries per dragged card per move.
  // Rebuild the map here (one pass per render) and read
  // it during the drag instead. A card being edited has
  // its decorations removed (see startTextEdit) and is
  // never dragged, so a stale entry there is harmless;
  // updateDraggedCards still checks isConnected.
  S.cardEls.clear();
  for (const child of Array.from(S.cardsEl.children)) {
    const el = child as HTMLElement;
    if (el.classList.contains("card") && el.dataset.id) {
      const id = Number(el.dataset.id);
      const entry = S.cardEls.get(id) ?? { card: el };
      entry.card = el;
      S.cardEls.set(id, entry);
    } else if (el.classList.contains("card-decorations") && el.dataset.for) {
      const id = Number(el.dataset.for);
      const entry = S.cardEls.get(id);
      if (!entry) continue;
      if (el.classList.contains("card-decorations-right")) entry.right = el;
      else entry.left = el;
    }
  }
  S.api.view.refresh();
  S.lastContentKey = visibleKey();
  applyCamera();
  S.api.search.update();
}

export function updateResizeHandle(): void {
  const el = document.getElementById("resize-handle") as HTMLDivElement;
  const rotEl = document.getElementById("rotate-handle") as HTMLDivElement | null;
  const selected = S.api.board.getSelected();
  // A plugin view owns the screen: the board's resize handle is
  // not part of that view, so it must never float over it — it
  // did, at the selected card's corner, while playing a slide.
  if (S.api.view.getView() !== "board" || selected.length !== 1 || S.api.ui.isSettingsOpen() || S.editingId !== null) {
    el.style.display = "none";
    if (rotEl) rotEl.style.display = "none";
    return;
  }
  // The board, fresh: the selected item's position is what
  // the handle follows, and it moves during a drag.
  const it = S.api.board.getItem(selected[0]);
  if (!it || "Connector" in it.kind) {
    el.style.display = "none";
    if (rotEl) rotEl.style.display = "none";
    return;
  }
  const [p, s] = S.api.geometry.itemBounds(it);
  const c = S.api.geometry.centre(it);
  const rot = S.api.geometry.itemRotation(it);
  // Corners follow the rotation, so the handles sit on the
  // card as drawn, not on its unrotated bounding box.
  const corner = S.api.geometry.rotatePoint({ x: p.x + s.w, y: p.y + s.h }, c, rot);
  const screen = toScreen(corner);
  const bs = boardSize();
  if (screen.x < 0 || screen.y < 0 || screen.x > bs.x || screen.y > bs.y) {
    el.style.display = "none";
  } else {
    el.style.left = `${screen.x}px`;
    el.style.top = `${screen.y}px`;
    el.style.display = "block";
  }
  if (rotEl) {
    if (!isRotatable(it, isFrameCard)) { rotEl.style.display = "none"; return; }
    const rs = toScreen(rotateHandleWorld(it, S.api.view.getCamera()));
    if (rs.x < 0 || rs.y < 0 || rs.x > bs.x || rs.y > bs.y) {
      rotEl.style.display = "none"; return;
    }
    rotEl.style.left = `${rs.x}px`;
    rotEl.style.top = `${rs.y}px`;
    // The grip's position already follows the rotation, but
    // its stem did not: it always pointed straight down, so
    // at 180° the stem pointed away from the card instead
    // of back to it, and the handle looked detached. Rotate
    // the grip itself with the card, around its centre, so
    // the stem always points at the card's centre — down
    // at 0°, up at 180°, sideways at 90°.
    rotEl.style.transform = rot ? `rotate(${rot}deg)` : "";
    rotEl.style.display = "block";
  }
}

// Selection changes must not rebuild the card DOM: rebuilding on
// mousedown destroys the very element the user pressed, so its click
// (a card button, or a double-click to edit) never fires. Bringing a
// card to the front must not move its DOM node either: appendChild
// removes and re-inserts it, which cancels the pending click in
// Chromium. Stacking is therefore done with z-index, which changes
// paint order without touching the node at all.
export function updateSelectionInner(): void {
  const selected = S.api.board.getSelected();
  for (const child of Array.from(S.cardsEl.children)) {
    const el = child as HTMLElement;
    const isSel = selected.includes(Number(el.dataset.id));
    el.classList.toggle("selected", isSel);
    el.setAttribute("aria-selected", String(isSel));
    // A selected image or video shows whole (contain), not
    // cropped (cover): cardHtml sets this at render time,
    // but a plain click only toggles the class here, without
    // a full render — and a full render would restart a
    // playing video — so update the fit here too.
    for (const media of Array.from(el.querySelectorAll("img, video"))) {
      (media as HTMLElement).style.objectFit = isSel ? "contain" : "cover";
    }
  }
  // Group frames follow the selection too: a frame reads as
  // selected when any of its members is.
  const board = S.cachedBoard ?? S.api.board.get();
  for (const child of Array.from(S.groupsEl.children)) {
    const el = child as HTMLElement;
    const g = Number(el.dataset.group);
    el.classList.toggle("selected", board.items.some((it) => it.group === g && selected.includes(it.id)));
  }
  // Selection changes without a full render (a plain click) still
  // need the resize handle to appear / disappear immediately.
  updateResizeHandle();
}

export function updateSelection(): void {
  updateSelectionInner();
  announceSelection();
  // The toolbar plugin follows the selection through the
  // "selection" plugin event, so its note-colours flyout
  // appears when a text note is selected.
  S.api.events.emit("selection");
}

// Announce the selection to a screen reader through the
// live region. Only when it changed: updateSelection runs
// on every click and drag, and repeating the same line
// would spam the reader.
// Kind is a single-key externally-tagged enum, so the
// first key is the discriminant. Shape, Model3D and
// Plugin have no entry and fall to "Card selected".
const KIND_SELECTION_LABELS: Record<string, string> = {
  Text: "Text card selected",
  Image: "Image card selected",
  Audio: "Audio card selected",
  Video: "Video card selected",
  PdfCard: "PDF card selected",
  UrlCard: "Link card selected",
  Swatch: "Colour swatch selected",
  Stroke: "Stroke selected",
  Connector: "Connector selected",
};
export function announceSelection(): void {
  const announcer = document.getElementById("sr-announcer");
  if (!announcer) return;
  const selected = S.api.board.getSelected();
  let text: string;
  if (selected.length === 0) {
    text = "";
  } else if (selected.length === 1) {
    const it = S.api.board.getItem(selected[0]);
    if (!it) text = "1 card selected";
    else text = KIND_SELECTION_LABELS[Object.keys(it.kind)[0]] ?? "Card selected";
    if (it && it.group !== null) {
      const board = S.api.board.get();
      const label = board.groups?.[it.group]?.label;
      if (label) text += `, in group ${label}`;
    }
  } else {
    text = `${selected.length} cards selected`;
  }
  if (text === S.lastAnnouncedSelection) return;
  S.lastAnnouncedSelection = text;
  announcer.textContent = text;
}

export function applyStacking(): void {
  // Only relative order matters for paint: cards are built
  // into #cards in board order by render(), so a child's
  // DOM index already is its stacking order among the
  // cards that are actually on screen. The old version
  // built a Map over every board item on every render,
  // including thousands of off-screen items that have no
  // DOM node and need no z-index at all.
  let i = 0;
  for (const child of Array.from(S.cardsEl.children)) {
    (child as HTMLElement).style.zIndex = String(i++);
  }
}

