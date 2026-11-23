// The board's mutable state, gathered into one object (S) so
// the input, render and plugin modules share one source of
// truth.

import type { PluginContext } from "../plugins/host";
import {
  Anchor, Board, Item, Pt, ShapeKind,
  elementPoint, elementSize, screenToWorld, worldToScreen,
} from "../backend/model";

// Core tools are select/pen/connector/eraser. Plugin tools are strings of
// the form "plugin:<pluginId>:<toolId>" (see src/plugins/host.ts); the
// type stays open so a plugin tool is a valid Tool.
export type Tool = string;
export const ACCENT = "#007AFF";

// The eraser's reach, in world units: a stroke is erased
// when the eraser circle overlaps it. 12 is big enough
// that a sweep feels forgiving, small enough to pick one
// stroke out of a cluster.
export const ERASER_RADIUS = 12;

// The board's mutable state, gathered into one object so the
// file can split (board-state / render / input) without every
// function reaching for module-level lets. All references are
// S.<name>; the object is created once, at module load, and
// activate() fills in the fields it owns (api, the DOM).
// Fields set by activate() start as undefined (the same lie
// the old `let x!` declarations told) and are guarded by the
// same checks render() already had (`if (!S.boardEl) return`).
type DragState = null
  | { kind: "pan"; last: Pt }
  | { kind: "move"; lastWorld: Pt; moved: boolean }
  | { kind: "stroke"; points: Pt[]; pressures: number[]; width: number; marker: boolean; pencil: boolean }
  | { kind: "lasso"; points: Pt[] }
  | { kind: "erase"; erased: boolean }
  | { kind: "connector"; from: Anchor; current: Pt }
  | { kind: "marquee"; start: Pt; current: Pt }
  | { kind: "shape"; shape: ShapeKind; start: Pt; current: Pt }
  | { kind: "rotate"; id: number; origRot: number; moved: boolean }
  | { kind: "resize"; id: number; startWorld: Pt; origW: number; origH: number; moved: boolean }
  // A plugin tool's drag: the tool's full id
  // ("plugin:<pluginId>:<toolId>") owns the gesture, and
  // `last` is the most recent world point, so a cancel
  // (pointercancel, Escape, tool switch) can report where
  // the drag ended. The tool itself keeps its own points;
  // the core only routes the events.
  | { kind: "plugin"; fullId: string; last: Pt };

export type { DragState };

interface BoardState {
  api: PluginContext;
  // The board DOM, built by this plugin in activate().
  boardEl: HTMLDivElement;
  gridEl: HTMLDivElement;
  worldEl: SVGGElement;
  // The draw-preview layer: it sits AFTER #cards in the DOM, so
  // a shape being drawn paints above the existing cards instead
  // of hiding behind them. Same camera transform as #world,
  // cleared by render() like #world, so a preview never
  // outlives its drag.
  previewWorldEl: SVGGElement;
  cardsEl: HTMLDivElement;
  groupsEl: HTMLDivElement;
  // The group frames' dashed borders live in their own layer
  // BELOW the cards, so a card placed over a frame's edge
  // covers the border instead of the border painting over
  // the card. The labels live in #groups, also below the
  // cards, so a note placed over a label covers it the same
  // way. Both are the resting rule only: a SELECTED group's
  // frame and label are mirrored into #selected-groups,
  // above the cards, so the outline travels with the group
  // instead of diving under the cards it passes over.
  groupFramesEl: HTMLDivElement;
  selectedGroupsEl: HTMLDivElement;
  // The board as last rendered (a copy from api.board.get()).
  // The render loop reads bg/grid/items from this; the
  // visible-set check reads it too, so panning does not pay
  // a fresh board copy per mousemove. Refreshed by render().
  cachedBoard: Board | null;
  // Drag path cache (see render): card element plus its two
  // decoration divs, keyed by card id, rebuilt on each render.
  cardEls: Map<number, { card: HTMLElement; left?: HTMLElement; right?: HTMLElement }>;
  // Key of the card/stroke content currently built in the DOM. Camera
  // moves that leave this key unchanged must not rebuild anything.
  lastContentKey: number;
  // Lasso is not a tool of its own — it is a mode of Select,
  // toggled by L, with no toolbar button.
  lassoMode: boolean;
  tool: Tool;
  // The draw tool last chosen (pencil, pen, highlighter or
  // eraser). The P shortcut activates this one, not always
  // the pen — so a pencil stays a pencil.
  lastDrawTool: Tool | null;
  // The geometry shape last chosen (rectangle, ellipse,
  // triangle, …). The R shortcut activates this one, not
  // always the rectangle — so a triangle stays a triangle.
  lastShapeTool: Tool | null;
  // The selection mode last chosen (plain select or lasso).
  // The V shortcut activates this one, not always plain
  // select — so a lasso stays a lasso.
  lastSelectMode: "select" | "lasso" | null;
  editingId: number | null;
  // Set while a render moves the editing card out of #cards
  // and back (see board-render): moving the card blurs its
  // textarea, and the blur would commit the edit mid-render
  // and kick the user out of the text box. While this is
  // set, the commit is a no-op; the render restores focus
  // to the textarea afterwards.
  suppressEditCommit: boolean;
  spaceDown: boolean;
  drag: DragState;
  pluginToolDown: boolean;
  // Double-click tracking: pointer events carry no click count,
  // so a double-click is two presses close in time and space.
  lastPointerDown: { x: number; y: number; t: number };
  // Trackpad zoom coalescing: a pinch sends wheel events at
  // ~120 Hz; ticks only accumulate a factor, one frame applies
  // it as a GPU transform, and content rebuilds once, when
  // the pinch settles.
  pendingZoomFactor: number;
  pendingZoomAnchor: Pt | null;
  zoomFrame: number | null;
  zoomSettleTimer: ReturnType<typeof setTimeout> | null;
  wheelSaveTimer: ReturnType<typeof setTimeout> | null;
  cursorRaf: number;
  pendingCursor: Pt | null;
  // The ring that shows the eraser's reach at the cursor.
  // It is a body-level div, not part of the board SVG, so
  // renderSvgOnly() never wipes it mid-drag.
  eraserRing: HTMLDivElement | null;
  listenersAttached: boolean;
  lastAnnouncedSelection: string;
}

export const S: BoardState = {
  api: undefined as unknown as PluginContext,
  boardEl: undefined as unknown as HTMLDivElement,
  gridEl: undefined as unknown as HTMLDivElement,
  worldEl: undefined as unknown as SVGGElement,
  previewWorldEl: undefined as unknown as SVGGElement,
  cardsEl: undefined as unknown as HTMLDivElement,
  groupsEl: undefined as unknown as HTMLDivElement,
  groupFramesEl: undefined as unknown as HTMLDivElement,
  selectedGroupsEl: undefined as unknown as HTMLDivElement,
  cachedBoard: null,
  cardEls: new Map(),
  lastContentKey: 0,
  lassoMode: false,
  tool: "select",
  lastDrawTool: null,
  lastShapeTool: null,
  lastSelectMode: null,
  editingId: null,
  suppressEditCommit: false,
  spaceDown: false,
  drag: null,
  pluginToolDown: false,
  lastPointerDown: { x: 0, y: 0, t: 0 },
  pendingZoomFactor: 1,
  pendingZoomAnchor: null,
  zoomFrame: null,
  zoomSettleTimer: null,
  wheelSaveTimer: null,
  cursorRaf: 0,
  pendingCursor: null,
  eraserRing: null,
  listenersAttached: false,
  lastAnnouncedSelection: "",
};

// ---------------------------------------------------------------- helpers

export function toScreen(p: Pt): Pt {
  return worldToScreen(p, S.api.view.getCamera());
}
export function toWorld(s: Pt): Pt {
  return screenToWorld(s, S.api.view.getCamera());
}
// The board no longer fills the window: the title bar sits
// above it, so board-local size and points differ from window
// size and client points by the bar's height. Every camera
// centre, cull and input conversion below goes through these,
// never window.innerWidth/innerHeight or raw clientX/Y.
export function boardSize(): Pt {
  return elementSize(S.boardEl);
}
export function boardPoint(clientX: number, clientY: number): Pt {
  return elementPoint(S.boardEl, clientX, clientY);
}

export function isFrameCard(it: Item | undefined): boolean {
  if (!it) return false;
  return S.api.cards.isFrame(it);
}
