// Live drag previews: a single SVG node updated in place,
// instead of rebuilding every card and stroke on every
// mousemove. The node is cleared by the next full render
// (mouseup), so it never needs its own removal.

import { ACCENT, S } from "./board-state";
import { groupBounds, svgEl2 } from "./board-geometry";
import {
  pressureWidth, smoothStrokePath, smoothStrokePressures, smoothStrokeSamples, strokeOpacity, strokePressuresVary,
  type Item, type Pt,
} from "../backend/model";

// Fast-path drag previews: a single SVG node updated in place,
// instead of rebuilding every card and stroke on every mousemove.
// The node is cleared by the next full render (mouseup), so it never
// needs its own removal. A preview drawn over the cards (the shape
// preview) lives in the preview layer above #cards instead of the
// world layer below it, so the cards cannot cover it mid-drag.
export function dragPreview(id: string, tag: string, toPreview = false): SVGElement {
  const layer = toPreview ? S.previewWorldEl : S.worldEl;
  let el = layer.querySelector(`#${id}`) as SVGElement | null;
  if (!el) {
    el = svgEl2(tag, { id }) as SVGElement;
    layer.appendChild(el);
  }
  return el;
}
// The live stroke, drawn while the pen is down. A uniform
// stroke is one smooth path; a pen stroke whose pressure
// varies is one line per short sample along the smooth
// curve, each at the width its pressure makes, so the
// stroke visibly thickens as it is drawn. `width` is the
// tool's base width: the pencil draws thinner than the pen,
// the highlighter much wider. A marker (highlighter) draws
// translucent, like the stored stroke.
export function updateLiveStroke(points: Pt[], pressures: number[], width: number, marker: boolean, pencil = false, color?: string, opacityPct = 100): void {
  const el = dragPreview("live-stroke", "g");
  while (el.firstChild) el.removeChild(el.firstChild);
  const stroke = color ?? S.api.pen.getColor();
  // A pencil stroke shows its graphite texture while it
  // is being drawn, not only once it is committed.
  if (pencil) el.setAttribute("filter", "url(#pencil-texture)");
  else el.removeAttribute("filter");
  if (pencil && points.length > 0) {
    // Pin the filter region for the whole drag. Without
    // this, the group's box — and so the filter region —
    // grows with every move, and the turbulence is
    // re-generated over the new region each time: the
    // first-stroke lag. A fixed transparent rect holds
    // the box steady, so the noise is generated once and
    // reused while the stroke grows inside it. It paints
    // nothing (fill none) and takes no part in
    // hit-testing. A stroke longer than the rect just
    // outgrows it and the region grows from there.
    const s = points[0];
    el.appendChild(svgEl2("rect", { x: String(s.x - 256), y: String(s.y - 256), width: "512", height: "512", fill: "none" }));
  }
  // The preview paints at the same effective opacity as
  // the committed stroke (see strokeOpacity), so the
  // stroke does not change shade on release.
  const opacity = String(strokeOpacity({ opacity: opacityPct, marker }));
  if (pressures.length === points.length && strokePressuresVary({ pressures })) {
    const pts = smoothStrokeSamples(points);
    const prs = smoothStrokePressures(pressures);
    for (let i = 0; i + 1 < pts.length; i++) {
      const w = pressureWidth(width, (prs[i] + prs[i + 1]) / 2);
      el.appendChild(svgEl2("line", { x1: String(pts[i].x), y1: String(pts[i].y), x2: String(pts[i + 1].x), y2: String(pts[i + 1].y), stroke, "stroke-width": String(w), "stroke-linecap": "round", opacity }));
    }
  } else {
    el.appendChild(svgEl2("path", { d: smoothStrokePath(points), fill: "none", stroke, "stroke-width": String(width), "stroke-linecap": "round", "stroke-linejoin": "round", opacity }));
  }
}
// Remove the live stroke node outright: a drag that ends
// without a commit renders nothing, so only this explicit
// clear ends the preview.
export function clearLiveStroke(): void {
  S.worldEl.querySelector("#live-stroke")?.remove();
}
// The live shape, drawn while a shape tool drags, in the
// pen colour — the same shape the drag commits on release.
// It lives in the preview layer above #cards, so cards
// cannot cover it mid-drag.
export function updateShapePreview(shape: string, x0: number, y0: number, w: number, h: number, color: string, outline: boolean): void {
  // An outline shape previews as a stroke, not a fill.
  const fillAttr = outline ? "none" : color;
  const strokeAttr = outline ? color : "none";
  if (shape === "rect") {
    const el = dragPreview("shape-preview", "rect", true);
    el.setAttribute("x", String(x0)); el.setAttribute("y", String(y0));
    el.setAttribute("width", String(w)); el.setAttribute("height", String(h));
    el.setAttribute("rx", "12");
    el.setAttribute("fill", fillAttr); el.setAttribute("fill-opacity", outline ? "1" : "0.85");
    el.setAttribute("stroke", strokeAttr); el.setAttribute("stroke-width", outline ? "4" : "0");
  } else if (shape === "ellipse") {
    const el = dragPreview("shape-preview", "ellipse", true);
    el.setAttribute("cx", String(x0 + w / 2)); el.setAttribute("cy", String(y0 + h / 2));
    el.setAttribute("rx", String(w / 2)); el.setAttribute("ry", String(h / 2));
    el.setAttribute("fill", fillAttr); el.setAttribute("fill-opacity", outline ? "1" : "0.85");
    el.setAttribute("stroke", strokeAttr); el.setAttribute("stroke-width", outline ? "4" : "0");
  } else {
    const el = dragPreview("shape-preview", "polygon", true);
    el.setAttribute("points", S.api.shapes.previewPoints(shape, x0, y0, w, h));
    el.setAttribute("fill", fillAttr); el.setAttribute("fill-opacity", outline ? "1" : "0.85");
    el.setAttribute("stroke", strokeAttr); el.setAttribute("stroke-width", outline ? "4" : "0");
    el.setAttribute("stroke-linejoin", "round");
  }
}
// Remove the live shape preview node outright: a drag
// that ends without a commit renders nothing, so only
// this explicit clear ends the preview.
export function clearShapePreview(): void {
  S.previewWorldEl.querySelector("#shape-preview")?.remove();
}
// The lasso loop, drawn live while dragging. The path is
// closed (the Z joins the last point back to the first),
// so the fill shows the region the loop will select.
export function updateLassoPreview(points: Pt[]): void {
  const el = dragPreview("lasso-preview", "path");
  el.setAttribute("d", points.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x},${pt.y}`).join(" ") + " Z");
  el.setAttribute("fill", "rgba(0,122,255,0.08)");
  el.setAttribute("stroke", ACCENT);
  el.setAttribute("stroke-width", "1");
}
export function updateDraggedCards(ids: number[]): void {
  // Cards are world-space now, so moving one is a style change on
  // its own node — no markdown, no image re-parse, no rebuild.
  // Element lookups come from the render-built cardEls map, not
  // from three attribute-selector queries per card per move.
  // A cached element that left the DOM (a card edited since the
  // last render had its decorations removed) falls back to a
  // live query, so the drag never moves a detached node.
  for (const id of ids) {
    // The live item: a drag only reads it (position and
    // size), and cloning a stroke's point array on every
    // pointermove was the per-move cost.
    const it = S.api.board.getItemLive(id);
    if (!it) continue;
    const cached = S.cardEls.get(id);
    const el = cached?.card.isConnected
      ? cached.card
      : (S.cardsEl.querySelector(`[data-id="${id}"]`) as HTMLElement | null);
    if (!el) continue;
    el.style.left = `${it.pos.x}px`;
    el.style.top = `${it.pos.y}px`;
    el.style.width = `${it.size.w}px`;
    el.style.height = `${it.size.h}px`;
    // The card's bottom row is a sibling div, not part of the
    // card node, so it does not move with it: move it by the
    // same rule that placed it (see decorations() in cards.ts),
    // or the progress stays behind while the card is dragged.
    // A resize moves it too (its top and the right side follow
    // the card's height and width), so this covers both.
    const top = Math.max(it.pos.y + 4, it.pos.y + it.size.h - 36);
    const leftDeco = cached?.left?.isConnected
      ? cached.left
      : (S.cardsEl.querySelector(`.card-decorations:not(.card-decorations-right)[data-for="${id}"]`) as HTMLElement | null);
    if (leftDeco) {
      leftDeco.style.left = `${it.pos.x + 8}px`;
      leftDeco.style.top = `${top}px`;
      leftDeco.style.width = `${Math.max(it.size.w - 16, 0)}px`;
    }
    const rightDeco = cached?.right?.isConnected
      ? cached.right
      : (S.cardsEl.querySelector(`.card-decorations-right[data-for="${id}"]`) as HTMLElement | null);
    if (rightDeco) {
      rightDeco.style.left = `${it.pos.x + it.size.w - 8}px`;
      rightDeco.style.top = `${top}px`;
    }
  }
  updateDraggedGroupFrames(ids);
}

// The group frame is a derived div, not part of any card,
// so it does not move with the cards it frames: recompute
// its bounds from the live board (the cards already moved)
// and move the frame to match, or it stays behind while the
// group is dragged. A resize moves it too (a member's size
// changes the union), so this covers both. The label is a
// separate element in #groups now, so it moves too — it
// sits at the frame's top-left plus the same offset it
// had as the frame's child.
function updateDraggedGroupFrames(ids: number[]): void {
  if (!S.groupsEl || !S.groupFramesEl) return;
  const groups = new Set<number>();
  for (const id of ids) {
    const it = S.api.board.getItem(id);
    if (it && it.group !== null) groups.add(it.group);
  }
  if (groups.size === 0) return;
  // Membership comes from the last render's board: group
  // membership does not change mid-drag, and scanning it is
  // a plain array pass, not a JSON round-trip. Positions
  // come from getItem, so they reflect the drag move. The
  // old version called api.board.get() — a full deep copy
  // of the board — on every pointermove, and then scanned
  // that copy once per group inside groupBounds.
  const source = S.cachedBoard ?? S.api.board.get();
  for (const g of groups) {
    const memberIds = source.items.filter((it) => it.group === g).map((it) => it.id);
    // A live import is a group even with one card, so its
    // frame exists and must follow the drag too.
    if (memberIds.length < 2 && !source.groups?.[g]?.source) continue;
    const members: Item[] = [];
    for (const id of memberIds) {
      // The live item: positions are read here and the
      // drag already moved them, so this must be live.
      const it = S.api.board.getItemLive(id);
      if (it) members.push(it);
    }
    const b = groupBounds(members, S.api.geometry.itemBounds);
    if (!b) continue;
    const frame = S.groupFramesEl.querySelector(`.group-frame[data-group="${g}"]`) as HTMLElement | null;
    if (!frame) continue;
    frame.style.left = `${b.x}px`;
    frame.style.top = `${b.y}px`;
    frame.style.width = `${b.w}px`;
    frame.style.height = `${b.h}px`;
    const label = S.groupsEl.querySelector(`.group-label[data-group="${g}"]`) as HTMLElement | null;
    if (label) {
      label.style.left = `${b.x + 12}px`;
      label.style.top = `${b.y - 11}px`;
    }
    // The overlay mirrors the frame and label above the
    // cards, so it follows the drag too — otherwise the
    // outline would lag a step behind the group it belongs
    // to, and snap to place only on the drop's render.
    if (S.selectedGroupsEl) {
      const oframe = S.selectedGroupsEl.querySelector(`.group-frame[data-group="${g}"]`) as HTMLElement | null;
      if (oframe) {
        oframe.style.left = `${b.x}px`;
        oframe.style.top = `${b.y}px`;
        oframe.style.width = `${b.w}px`;
        oframe.style.height = `${b.h}px`;
      }
      const olabel = S.selectedGroupsEl.querySelector(`.group-label[data-group="${g}"]`) as HTMLElement | null;
      if (olabel) {
        olabel.style.left = `${b.x + 12}px`;
        olabel.style.top = `${b.y - 11}px`;
      }
    }
  }
}
