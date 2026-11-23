// Plugin tool drags: the pure half of the drag-tool API.
// The input loop owns the DOM events; this module owns the
// routing decisions, so they are testable without a board.

import type { PluginPointerEvent, PluginToolDef, Pt } from "bowerbird-plugin-api";
import type { DragState } from "./board-state";

// A drag state for a plugin tool: the tool's full id
// ("plugin:<pluginId>:<toolId>") owns the gesture, and
// `last` is the most recent world point.
export type PluginDragState = Extract<DragState, { kind: "plugin" }>;

// Whether a tool defines any drag callback. A tool with
// none keeps the old click behaviour (onMouseDown /
// onMouseUp); a tool with at least one owns its gesture
// from pointerdown, even if it only cares about moves.
export function hasPluginDragCallbacks(def: PluginToolDef): boolean {
  return (
    def.onPointerDown !== undefined ||
    def.onPointerMove !== undefined ||
    def.onPointerUp !== undefined ||
    def.onPointerCancel !== undefined
  );
}

// The pointer behind a drag callback: only the fields a
// brush needs, copied off the DOM event. A missing field
// reads as its neutral value, so a synthetic event that
// omits tilt still routes.
export function toPluginPointerEvent(e: {
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  pointerType?: string;
  pointerId?: number;
  buttons?: number;
  isPrimary?: boolean;
}): PluginPointerEvent {
  return {
    pressure: e.pressure ?? 0,
    tiltX: e.tiltX ?? 0,
    tiltY: e.tiltY ?? 0,
    pointerType: e.pointerType ?? "mouse",
    pointerId: e.pointerId ?? -1,
    buttons: e.buttons ?? 0,
    isPrimary: e.isPrimary ?? true,
  };
}

// The event for a cancel with no pointer behind it (Escape,
// tool switch): a neutral mouse event, so the callback
// still gets a well-formed value.
export const NEUTRAL_PLUGIN_POINTER_EVENT: PluginPointerEvent = {
  pressure: 0,
  tiltX: 0,
  tiltY: 0,
  pointerType: "mouse",
  pointerId: -1,
  buttons: 0,
  isPrimary: true,
};

// Start a plugin drag: call onPointerDown when the tool
// defines it, and return the drag state the input loop
// keeps until pointerup or cancel.
export function beginPluginDrag(def: PluginToolDef, fullId: string, world: Pt, ev: PluginPointerEvent): PluginDragState {
  def.onPointerDown?.(world, ev);
  return { kind: "plugin", fullId, last: world };
}

// Route a move to the tool and advance the drag's last
// point, so a later cancel reports where the drag ended.
export function movePluginDrag(def: PluginToolDef, state: PluginDragState, world: Pt, ev: PluginPointerEvent): PluginDragState {
  def.onPointerMove?.(world, ev);
  return { ...state, last: world };
}

// End a plugin drag on pointerup. The tool commits whatever
// it drew (usually one addItem) in this callback; the input
// loop clears the preview afterwards.
export function endPluginDrag(def: PluginToolDef, world: Pt, ev: PluginPointerEvent): void {
  def.onPointerUp?.(world, ev);
}

// Cancel a plugin drag (pointercancel, Escape, tool
// switch). The world point is the drag's last point: a
// cancel carries no fresh position of its own.
export function cancelPluginDrag(def: PluginToolDef, state: PluginDragState, ev: PluginPointerEvent): void {
  def.onPointerCancel?.(state.last, ev);
}
