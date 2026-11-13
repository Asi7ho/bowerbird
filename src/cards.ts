// Cards: the HTML for one board card, plus the shape metadata
// the toolbar flyout and the pen preview use. The core renders
// no card itself: card HTML comes from the plugin that
// registered a renderer for the kind (core-cards for the
// built-in kinds, a user plugin for its own kinds). This
// module is the thin wrapper that applies the card chrome
// and dispatches to the right renderer. Board JSON is
// untrusted input here: every value that lands in an
// attribute or as text is coerced or escaped in cardHtml,
// never trusted from the board.
import type { Media } from "./media";
import {
  itemRotation, type Item, type ShapeKind,
} from "./model";
import { getBuiltinCardHtml, getCardDecorations, getCardHtml, getCardRenderer } from "./plugins";

export interface CardContext {
  media: Media;
  isSelected(id: number): boolean;
  getEditingId(): number | null;
}

export interface CardRenderer {
  cardHtml(item: Item, plain?: boolean): string;
  shapeMeta(kind: ShapeKind): { label: string; key: string; svg: string };
  shapeLabel(kind: ShapeKind): string;
  isShapeTool(t: string): t is ShapeKind;
  shapeClipPath(kind: ShapeKind): string | null;
  shapePreviewPoints(kind: ShapeKind, x0: number, y0: number, w: number, h: number): string;
}

// Shapes: one toolbar button, like the pen, with a flyout
// beside it to choose the shape. The table is the single
// source for the flyout, the toolbar button icon, search
// labels and drag previews, so adding a shape means one
// row here, not edits in four places. Keyboard shortcuts
// stay R/E only: the flyout is how the new shapes are
// picked, and no new key is stolen from plugins or text.
export const SHAPES: { kind: ShapeKind; label: string; key: string; svg: string }[] = [
  { kind: "rect", label: "Rectangle", key: "R", svg: '<rect x="4" y="5" width="16" height="14" rx="2" />' },
  { kind: "ellipse", label: "Ellipse", key: "E", svg: '<ellipse cx="12" cy="12" rx="8" ry="6.5" />' },
  { kind: "triangle", label: "Triangle", key: "", svg: '<path d="M12 4 L20 20 L4 20 Z" />' },
  { kind: "diamond", label: "Diamond", key: "", svg: '<path d="M12 3 L21 12 L12 21 L3 12 Z" />' },
  { kind: "hexagon", label: "Hexagon", key: "", svg: '<path d="M8 3 L16 3 L21 12 L16 21 L8 21 L3 12 Z" />' },
  { kind: "star", label: "Star", key: "", svg: '<path d="M12 3 L14.7 9 L21 9.5 L16.2 13.8 L17.8 20 L12 16.5 L6.2 20 L7.8 13.8 L3 9.5 L9.3 9 Z" />' },
  { kind: "arrow", label: "Block arrow", key: "", svg: '<path d="M3 10 H15 V5 L21 12 L15 19 V14 H3 Z" />' },
];

export function shapeMeta(kind: ShapeKind): { label: string; key: string; svg: string } {
  return SHAPES.find((s) => s.kind === kind) ?? SHAPES[0];
}

export function shapeLabel(kind: ShapeKind): string { return shapeMeta(kind).label; }
export function isShapeTool(t: string): t is ShapeKind {
  return SHAPES.some((s) => s.kind === t);
}
// clip-path polygons, in % of the shape's box. The arrow
// points right; rotate it (handle or [ ]) to point
// anywhere else, like any other shape.
export function shapeClipPath(kind: ShapeKind): string | null {
  switch (kind) {
    case "triangle": return "polygon(50% 0, 100% 100%, 0 100%)";
    case "diamond": return "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)";
    case "hexagon": return "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)";
    case "star": return "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)";
    case "arrow": return "polygon(0 40%, 60% 40%, 60% 15%, 100% 50%, 60% 85%, 60% 60%, 0 60%)";
    default: return null;
  }
}
// Drag-preview polygon points, in board coords for a
// box from (x0, y0) sized w x h. Same geometry as the
// clip-paths above, so the preview is the shape drawn.
export function shapePreviewPoints(kind: ShapeKind, x0: number, y0: number, w: number, h: number): string {
  const px = (fx: number, fy: number) => `${x0 + fx * w},${y0 + fy * h}`;
  switch (kind) {
    case "triangle": return [px(0.5, 0), px(1, 1), px(0, 1)].join(" ");
    case "diamond": return [px(0.5, 0), px(1, 0.5), px(0.5, 1), px(0, 0.5)].join(" ");
    case "hexagon": return [px(0.25, 0), px(0.75, 0), px(1, 0.5), px(0.75, 1), px(0.25, 1), px(0, 0.5)].join(" ");
    case "star": return [[0.5, 0], [0.61, 0.35], [0.98, 0.35], [0.68, 0.57], [0.79, 0.91], [0.5, 0.7], [0.21, 0.91], [0.32, 0.57], [0.02, 0.35], [0.39, 0.35]].map(([fx, fy]) => px(fx, fy)).join(" ");
    case "arrow": return [px(0, 0.4), px(0.6, 0.4), px(0.6, 0.15), px(1, 0.5), px(0.6, 0.85), px(0.6, 0.6), px(0, 0.6)].join(" ");
    default: return "";
  }
}

export function createCardRenderer(ctx: CardContext): CardRenderer {
  function cardHtml(item: Item, plain = false): string {
    // Board JSON is untrusted input for this function: a board
    // shared by someone else, or a file dropped with a crafted
    // name, can carry any string in any field. This HTML is
    // inserted with innerHTML, so every value that lands in
    // an attribute must be coerced or escaped — here for the
    // card chrome (position, size, id), and inside each
    // plugin's renderer for its own content. Numbers are
    // forced through Number() (a string like `0" onmouseover="…`
    // becomes NaN, then the fallback, instead of breaking
    // out of the style attribute).
    const num = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const id = num(item.id, 0);
    const sel = plain ? false : ctx.isSelected(id);
    const cls = sel ? "card selected" : "card";
    // Decorations (tags, checklist progress) sit inside the
    // card, as a pill row at its bottom left — never below
    // it on the canvas, and never inside the card's own
    // HTML, which belongs to the renderer. A card being
    // edited renders nothing, so it gets none.
    const decorations = (x: number, y: number, w: number, h: number): string => {
      const html = getCardDecorations(item);
      if (!html) return "";
      const top = Math.max(y + 4, y + h - 28);
      return `<div class="card-decorations" data-for="${id}" style="left:${x + 8}px;top:${top}px;width:${Math.max(w - 16, 0)}px">${html}</div>`;
    };
    if ("Plugin" in item.kind) {
      const ww0 = num(item.size.w, 0), hh0 = num(item.size.h, 0);
      const rot0 = itemRotation(item);
      const style0 = `left:${num(item.pos.x, 0)}px;top:${num(item.pos.y, 0)}px;width:${ww0}px;height:${hh0}px;${rot0 ? `transform:rotate(${rot0}deg);` : ""}`;
      // A renderer returning null hides the card entirely:
      // the core renders nothing for it, not even the frame
      // border. A plugin uses this to show a card only in
      // the context it belongs to.
      const inner = getCardHtml(item);
      if (inner === null) return "";
      const frameCls = getCardRenderer(item)?.frame === true ? " plugin-frame" : "";
      return `<div class="${cls}${frameCls}" data-id="${id}" style="${style0}"><div class="inner">${inner}</div></div>` + decorations(num(item.pos.x, 0), num(item.pos.y, 0), ww0, hh0);
    }
    // Cards live in world coordinates; the whole #cards layer is
    // transformed once by the camera (see applyCamera). Per-card
    // screen positions and per-card scale transforms used to force a
    // full reposition of every card on every pan/zoom frame — that
    // was the main source of lag. Content still scales with zoom,
    // because the layer itself is scaled.
    const ww = num(item.size.w, 0), hh = num(item.size.h, 0);
    const rot = itemRotation(item);
    const style = `left:${num(item.pos.x, 0)}px;top:${num(item.pos.y, 0)}px;width:${ww}px;height:${hh}px;${rot ? `transform:rotate(${rot}deg);` : ""}`;
    // A note being edited renders nothing: the editor DOM is
    // managed separately. This check stays in the core, so a
    // card plugin never has to know about editing state.
    if ("Text" in item.kind && !plain && ctx.getEditingId() === id) return "";
    // The built-in kinds are rendered by the core-cards plugin,
    // through the same registration any plugin uses. A kind
    // with no registered renderer falls through to the
    // placeholder below — the core renders no card itself.
    const builtinHtml = getBuiltinCardHtml(item, plain);
    if (builtinHtml !== null) return builtinHtml + decorations(num(item.pos.x, 0), num(item.pos.y, 0), ww, hh);
    // No plugin registered a renderer for this kind. The
    // core renders no card itself anymore; this is a
    // placeholder so a board never shows a blank hole.
    // (The core-cards plugin provides all eight built-in
    // kinds, so this only fires when it is missing.)
    return `<div class="${cls}" data-id="${id}" style="${style}"><div class="inner" style="padding:12px"><div class="title" style="font-size:14px">Card</div><div class="sub" style="font-size:12px">No plugin provides this card kind.</div></div></div>` + decorations(num(item.pos.x, 0), num(item.pos.y, 0), ww, hh);
  }
  return { cardHtml, shapeMeta, shapeLabel, isShapeTool, shapeClipPath, shapePreviewPoints };
}
