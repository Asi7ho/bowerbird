// core-draw: the built-in drawing tools as a first-party
// plugin on the drag-tool API, consuming only the plugin
// API plus pure stroke geometry — the way a third-party
// brush would. It activates before the toolbar.

import type { Anchor, Kind, PluginContext, PluginManifest, Pt, ShapeKind, Size, StrokeGradient } from "bowerbird-plugin-api";
import { applyPressureCurve, rectFromPoints, splitStrokeByEraser, strokeMaxWidth } from "../backend/model";

export const manifest: PluginManifest = {
  apiVersion: "2",
  id: "core-draw",
  name: "Drawing tools",
  version: "1.0.0",
  description: "Pen, eraser, arrow and shapes.",
  main: "drawing-tools.js",
  permissions: ["board:read", "board:write", "pen"],
  // The toolbar buttons and the P/A/R/X shortcuts all route
  // through these tools: disabling the plugin would leave
  // them setting a tool that no longer exists, so the
  // drawing tools cannot be disabled, like the board.
  required: true,
};

// The eraser's reach, in world units: a stroke is erased
// when the eraser circle overlaps it. 12 is big enough
// that a sweep feels forgiving, small enough to pick one
// stroke out of a cluster.
export const ERASER_RADIUS = 12;

// The tool ids, in the plugin form the core routes on:
// "plugin:<pluginId>:<toolId>". The board and the toolbar
// compare against these, never against the bare kinds.
const PLUGIN_PREFIX = "plugin:core-draw:";
export type DrawKind = "pen" | "eraser";
const DRAW_KINDS: DrawKind[] = ["pen", "eraser"];
// The built-in stroke width of a stroke tool, used
// when no plugin set a width for it: pen 3, pencil 2,
// highlighter 12. One place, so the toolbar's size
// control and the tools agree on the fallback. Only
// the pen is a tool now; the other widths are the
// fallbacks the Brush Library's presets use.
export function builtinStrokeWidth(kind: "pen" | "pencil" | "highlighter"): number {
  return kind === "highlighter" ? 12 : kind === "pencil" ? 2 : 3;
}
export function drawToolId(kind: DrawKind): string {
  return `${PLUGIN_PREFIX}${kind}`;
}
export function shapeToolId(kind: string): string {
  return `${PLUGIN_PREFIX}${kind}`;
}
export const PEN_TOOL_ID = drawToolId("pen");
export const ERASER_TOOL_ID = drawToolId("eraser");
export const CONNECTOR_TOOL_ID = `${PLUGIN_PREFIX}connector`;
// The draw kind behind a tool id, or null when it is not
// one of the four draw tools.
export function drawKindOf(tool: string): DrawKind | null {
  if (!tool.startsWith(PLUGIN_PREFIX)) return null;
  const suffix = tool.slice(PLUGIN_PREFIX.length);
  return (DRAW_KINDS as string[]).includes(suffix) ? (suffix as DrawKind) : null;
}
export function isDrawToolId(tool: string): boolean {
  return drawKindOf(tool) !== null;
}
// Whether a tool id is one of the shape tools. A shape id
// is the plugin prefix plus a shape kind: anything else
// under the prefix is a draw tool or the connector.
export function isShapeToolId(tool: string): boolean {
  if (!tool.startsWith(PLUGIN_PREFIX)) return false;
  const suffix = tool.slice(PLUGIN_PREFIX.length);
  return suffix !== "connector" && !(DRAW_KINDS as string[]).includes(suffix);
}
// The shape kind behind a shape tool id, or null when the
// tool is not a shape.
export function shapeKindOf(tool: string): string | null {
  return isShapeToolId(tool) ? tool.slice(PLUGIN_PREFIX.length) : null;
}

// The toolbar's icons for these tools, so a tool button
// created for one (by the plugin system, or a future
// toolbar) shows the same mark as the toolbar's own.
const ICONS = {
  pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5 5.6 15 16.2 4.4a2.12 2.12 0 0 1 3 3L8.6 18l-4.1 1.5Z" fill="none"/><path d="M14.5 6.5l3 3" /></svg>',
  eraser: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" /></svg>',
  connector: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20 20 4" /><path d="M14 4h6v6" /></svg>',
};

// ---------------------------------------------------------------- pure helpers
// The commit math for each tool, kept pure so unit tests
// cover it without a board.

export interface PlacedItem {
  kind: Kind;
  pos: Pt;
  size: Size;
}

// A finished stroke: the points as drawn, in the pen
// colour, at the tool's width. A drag of one point is not
// a stroke — the old core path only committed two or more.
// An opacity of 100 (or none) is stored as nothing: old
// boards carry no opacity field, and missing means 100.
// A gradient is stored as given — the pen hands over a
// validated one — and a null gradient is stored as
// nothing, like an opacity of 100: missing means solid.
export function buildStrokeItem(points: Pt[], pressures: number[], color: string, width: number, marker: boolean, pencil: boolean, opacity?: number, gradient?: StrokeGradient | null, texture?: string): PlacedItem | null {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const pos = { x: Math.min(...xs), y: Math.min(...ys) };
  const size = { w: Math.max(1, Math.max(...xs) - pos.x), h: Math.max(1, Math.max(...ys) - pos.y) };
  return {
    kind: { Stroke: { points, color, width, marker, ...(pressures.length > 0 ? { pressures } : {}), ...(pencil ? { pencil: true } : {}), ...(opacity !== undefined && opacity !== 100 ? { opacity } : {}), ...(gradient ? { gradient } : {}), ...(texture ? { texture } : {}) } },
    pos,
    size,
  };
}

// A shape drag's box: the dragged corner against its
// start, normalised so the origin is the top-left.
export function shapeBox(start: Pt, current: Pt): { x0: number; y0: number; w: number; h: number } {
  return {
    x0: Math.min(start.x, current.x),
    y0: Math.min(start.y, current.y),
    w: Math.abs(current.x - start.x),
    h: Math.abs(current.y - start.y),
  };
}

// A finished shape: the shape in its drag box, filled in
// the pen colour, or outlined. A drag smaller than 10x10
// is a click, not a shape, and places nothing. An outlined
// shape carries its outline width, from the toolbar size.
export function buildShapeItem(shape: ShapeKind, start: Pt, current: Pt, fill: string, outline: boolean, width = 4): PlacedItem | null {
  const box = shapeBox(start, current);
  if (box.w < 10 || box.h < 10) return null;
  return {
    kind: { Shape: { shape, fill, ...(outline ? { outline: true, width } : {}) } },
    pos: { x: box.x0, y: box.y0 },
    size: { w: box.w, h: box.h },
  };
}

// A finished connector: the line between its two anchors.
// A card-to-itself connector would be a 1x1 item that can
// never be selected or deleted, so it places nothing —
// as does a line under 4 world units from a point anchor.
// The line carries its width, from the toolbar size.
export function buildConnectorItem(from: Anchor, to: Anchor, a: Pt | null, b: Pt, color: string, width = 2): PlacedItem | null {
  const degenerate = a !== null && "Point" in to && Math.hypot(a.x - to.Point.x, a.y - to.Point.y) < 4;
  const selfConnector = "Item" in from && "Item" in to && from.Item === to.Item;
  if (degenerate || selfConnector) return null;
  const aPt = a ?? { x: 0, y: 0 };
  const { pos, size } = rectFromPoints(aPt, b);
  return { kind: { Connector: { from, to, color, width } }, pos, size };
}

// A stroke's fields, as the eraser reads them off the
// board: the stored stroke, not yet split.
export interface StrokeProps {
  points: Pt[];
  pressures?: number[];
  color: string;
  width: number;
  marker: boolean;
  pencil?: boolean;
  opacity?: number;
  gradient?: StrokeGradient | null;
  texture?: string;
}

// The pieces of a stroke that survive an eraser pass at
// this point: the runs either side of the eraser circle,
// as items in the stroke's own colour, width, texture
// and gradient. A stroke the eraser covers whole leaves
// no pieces.
export function eraserSplitItems(stroke: StrokeProps, at: Pt, radius: number): PlacedItem[] {
  const runs = splitStrokeByEraser(stroke.points, stroke.pressures, at, radius, strokeMaxWidth(stroke) / 2);
  return runs.map((run) => {
    const xs = run.points.map((p) => p.x), ys = run.points.map((p) => p.y);
    const pos = { x: Math.min(...xs), y: Math.min(...ys) };
    const size = { w: Math.max(1, Math.max(...xs) - pos.x), h: Math.max(1, Math.max(...ys) - pos.y) };
    return {
      kind: { Stroke: { points: run.points, color: stroke.color, width: stroke.width, marker: stroke.marker, ...(run.pressures && run.pressures.length > 0 ? { pressures: run.pressures } : {}), ...(stroke.pencil ? { pencil: true } : {}), ...(stroke.opacity !== undefined && stroke.opacity !== 100 ? { opacity: stroke.opacity } : {}), ...(stroke.gradient ? { gradient: stroke.gradient } : {}), ...(stroke.texture ? { texture: stroke.texture } : {}) } },
      pos,
      size,
    };
  });
}

// ---------------------------------------------------------------- activation

export function activate(api: PluginContext): void {
  // New items land on the default layer: when that layer is
  // locked, a tool's drag commits nothing instead of drawing
  // onto a layer that does not edit. The preview still shows
  // while dragging; only the commit is dropped.
  const defaultLayerLocked = (): boolean =>
    api.board.getLayers().find((l) => l.id === "default")?.locked ?? false;
  // One stroke tool: the pen. Pencil, highlighter and
  // every other style live in the Brush Library, which
  // configures this tool through the pen's stroke
  // defaults instead of adding tools of its own. The
  // width, texture, marker and pressure curve come from
  // those defaults when a brush set them; unset fields
  // use the built-ins below, so the pen draws plain ink
  // with the plugin off. The pencil flag travels with old
  // strokes so they keep their texture through erasing
  // and reloads — no new stroke sets it.
  const registerStrokeTool = (): void => {
    const builtinWidth = builtinStrokeWidth("pen");
    const builtinMarker = false;
    const pencil = false;
    let points: Pt[] = [];
    let pressures: number[] = [];
    let width = builtinWidth;
    let marker = builtinMarker;
    let texture: string | undefined;
    let curve: Array<{ x: number; y: number }> | null = null;
    api.ui.registerTool({
      id: "pen",
      title: "Pen",
      icon: ICONS.pen,
      onPointerDown: (world, ev) => {
        const defaults = api.pen.getStrokeDefaults("pen");
        width = defaults.width ?? builtinWidth;
        marker = defaults.marker ?? builtinMarker;
        texture = defaults.texture ?? undefined;
        curve = defaults.curve ?? null;
        points = [world];
        // A stylus records its pressure per point, so the
        // stroke can thicken and thin with the press; a
        // mouse or finger records none, and draws a uniform
        // stroke. A set curve bends the pressure first.
        pressures = ev.pointerType === "pen" && !marker ? [applyPressureCurve(ev.pressure, curve)] : [];
      },
      onPointerMove: (world, ev) => {
        const last = points[points.length - 1];
        if (!last) return;
        if (Math.hypot(world.x - last.x, world.y - last.y) > 2 / api.view.getCamera().zoom) {
          points.push(world);
          if (ev.pointerType === "pen" && !marker) pressures.push(applyPressureCurve(ev.pressure, curve));
          api.board.previewStroke(points, pressures, { width, marker, pencil, texture, opacity: api.pen.getOpacity(), gradient: api.pen.getGradient() });
        }
      },
      onPointerUp: () => {
        const item = buildStrokeItem(points, pressures, api.pen.getColor(), width, marker, pencil, api.pen.getOpacity(), api.pen.getGradient(), texture);
        points = [];
        pressures = [];
        if (item && !defaultLayerLocked()) api.board.addItem(item.kind, item.pos, item.size);
      },
      onPointerCancel: () => {
        points = [];
        pressures = [];
      },
    });
  };
  registerStrokeTool();

  // The eraser: only the ink under it goes, and a stroke it
  // passes through breaks into the pieces either side. The
  // board is not saved here — the drag saves once, on
  // pointerup, so a whole sweep is one undo step.
  let erased = false;
  const eraseAt = (world: Pt): boolean => {
    const ids = api.board.strokesNear(world, ERASER_RADIUS);
    if (ids.length === 0) return false;
    let changed = false;
    // A locked layer does not erase: its strokes stay whole.
    // (removeItems refuses locked items too, but without this
    // the split pieces would still be added, duplicating the
    // stroke the eraser could not remove.)
    const layers = api.board.getLayers();
    for (const id of ids) {
      const it = api.board.getItem(id);
      if (!it || !("Stroke" in it.kind)) continue;
      if (layers.find((l) => l.id === (it.layer ?? "default"))?.locked) continue;
      const pieces = eraserSplitItems(it.kind.Stroke, world, ERASER_RADIUS);
      api.board.removeItems([id]);
      for (const piece of pieces) api.board.addItemSilent(piece.kind, piece.pos, piece.size);
      changed = true;
    }
    if (changed) api.board.render();
    return changed;
  };
  api.ui.registerTool({
    id: "eraser",
    title: "Eraser",
    icon: ICONS.eraser,
    onPointerDown: (world) => {
      erased = eraseAt(world);
    },
    onPointerMove: (world) => {
      if (eraseAt(world)) erased = true;
    },
    onPointerUp: () => {
      // A sweep that erased anything is one undo step. A
      // click that erased nothing leaves no step behind.
      if (erased) api.board.save();
      erased = false;
    },
    onPointerCancel: () => {
      // The erasure already happened, live, during the
      // drag: a cancel keeps it (and its undo step) rather
      // than leaving the board changed but unsaved.
      if (erased) api.board.save();
      erased = false;
    },
  });

  // The connector: a line from the press anchor to the
  // release anchor; the preview is a live stroke between them.
  // Its width is the toolbar size, read when the drag starts.
  let from: Anchor | null = null;
  let connectorWidth = 2;
  api.ui.registerTool({
    id: "connector",
    title: "Arrow",
    icon: ICONS.connector,
    onPointerDown: (world) => {
      const hit = api.board.hitTest(world);
      const hitItem = hit !== null ? api.board.getItem(hit) : undefined;
      const anchorable = hitItem && !("Stroke" in hitItem.kind) && !("Connector" in hitItem.kind);
      from = hitItem && anchorable ? { Item: hitItem.id } : { Point: world };
      connectorWidth = api.pen.getStrokeDefaults("pen").width ?? 2;
    },
    onPointerMove: (world) => {
      if (!from) return;
      const a = api.geometry.anchorPoint(from);
      if (a) api.board.previewStroke([a, world], [], { width: connectorWidth });
    },
    onPointerUp: (world) => {
      if (!from) return;
      const f = from;
      from = null;
      const to = api.board.hitTest(world);
      const toItem = to !== null ? api.board.getItem(to) : undefined;
      const toAnchorable = toItem && !("Stroke" in toItem.kind) && !("Connector" in toItem.kind);
      const toAnchor: Anchor = toItem && toAnchorable ? { Item: toItem.id } : { Point: world };
      const a = api.geometry.anchorPoint(f);
      // toAnchor is an Item exactly when toItem exists, so
      // its centre comes from toItem — no second lookup.
      const bPt = "Point" in toAnchor ? toAnchor.Point : (toItem ? api.geometry.centre(toItem) : { x: 0, y: 0 });
      const item = buildConnectorItem(f, toAnchor, a, bPt, api.pen.getColor(), connectorWidth);
      if (item && !defaultLayerLocked()) api.board.addItem(item.kind, item.pos, item.size);
    },
    onPointerCancel: () => {
      from = null;
    },
  });

  // One tool per shape kind, from the shape table: the
  // table is the single source for the flyout, the button
  // icon and the drag preview, so adding a shape means one
  // row there, not edits here. An outlined shape's width
  // is the toolbar size, read when the drag starts.
  for (const meta of api.shapes.list()) {
    let start: Pt | null = null;
    let shapeWidth = 4;
    const kind = meta.kind as ShapeKind;
    api.ui.registerTool({
      id: meta.kind,
      title: meta.label,
      icon: `<svg viewBox="0 0 24 24" aria-hidden="true">${meta.svg}</svg>`,
      onPointerDown: (world) => {
        start = world;
        shapeWidth = api.pen.getStrokeDefaults("pen").width ?? 4;
      },
      onPointerMove: (world) => {
        if (!start) return;
        const box = shapeBox(start, world);
        api.board.previewShape(meta.kind, box.x0, box.y0, box.w, box.h, { color: api.pen.getColor(), outline: api.shapes.getOutline(), width: shapeWidth });
      },
      onPointerUp: (world) => {
        if (!start) return;
        const s = start;
        start = null;
        const item = buildShapeItem(kind, s, world, api.pen.getColor(), api.shapes.getOutline(), shapeWidth);
        if (item && !defaultLayerLocked()) api.board.addItem(item.kind, item.pos, item.size);
      },
      onPointerCancel: () => {
        start = null;
      },
    });
  }
}
