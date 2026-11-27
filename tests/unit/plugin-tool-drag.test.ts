// Unit tests for the plugin drag-tool routing
// (src/ui/plugin-tool-drag.ts): drag-tool detection,
// event conversion, down -> move -> up/cancel. The DOM
// half is covered by the e2e drag-tool check instead.
import { describe, expect, it } from "vitest";
import {
  NEUTRAL_PLUGIN_POINTER_EVENT,
  beginPluginDrag,
  cancelPluginDrag,
  endPluginDrag,
  hasPluginDragCallbacks,
  movePluginDrag,
  toPluginPointerEvent,
  type PluginDragState,
} from "../../src/ui/plugin-tool-drag";
import type { PluginPointerEvent, PluginToolDef, Pt } from "bowerbird-plugin-api";

function toolDef(overrides: Partial<PluginToolDef> = {}): PluginToolDef {
  return { id: "brush", title: "Brush", ...overrides };
}

function pointerEvent(overrides: Partial<PluginPointerEvent> = {}): PluginPointerEvent {
  return {
    pressure: 0.7,
    tiltX: 10,
    tiltY: -5,
    pointerType: "pen",
    pointerId: 4,
    buttons: 1,
    isPrimary: true,
    ...overrides,
  };
}

describe("hasPluginDragCallbacks", () => {
  it("is false for a click-only tool", () => {
    expect(hasPluginDragCallbacks(toolDef({ onMouseDown: () => {} }))).toBe(false);
    expect(hasPluginDragCallbacks(toolDef())).toBe(false);
  });
  it("is true when any drag callback is defined, even only a move", () => {
    expect(hasPluginDragCallbacks(toolDef({ onPointerMove: () => {} }))).toBe(true);
    expect(hasPluginDragCallbacks(toolDef({ onPointerCancel: () => {} }))).toBe(true);
  });
});

describe("toPluginPointerEvent", () => {
  it("copies the brush fields off the event", () => {
    const ev = toPluginPointerEvent({ pressure: 0.7, tiltX: 10, tiltY: -5, pointerType: "pen", pointerId: 4, buttons: 1, isPrimary: false });
    expect(ev).toEqual({ pressure: 0.7, tiltX: 10, tiltY: -5, pointerType: "pen", pointerId: 4, buttons: 1, isPrimary: false });
  });
  it("reads a missing field as its neutral value", () => {
    expect(toPluginPointerEvent({})).toEqual(NEUTRAL_PLUGIN_POINTER_EVENT);
  });
  it("reads a mouse event's zero pressure, not a pen default", () => {
    expect(toPluginPointerEvent({ pressure: 0, pointerType: "mouse" }).pressure).toBe(0);
  });
});

describe("plugin drag transitions", () => {
  const fullId = "plugin:brush-plugin:brush";
  const down: Pt = { x: 100, y: 100 };
  const mid: Pt = { x: 120, y: 110 };
  const up: Pt = { x: 140, y: 120 };

  it("drives a tool through down -> move -> up with pressure on every move", () => {
    const seen: Array<{ kind: string; world: Pt; ev: PluginPointerEvent }> = [];
    const def = toolDef({
      onPointerDown: (world, ev) => seen.push({ kind: "down", world, ev }),
      onPointerMove: (world, ev) => seen.push({ kind: "move", world, ev }),
      onPointerUp: (world, ev) => seen.push({ kind: "up", world, ev }),
    });
    const state = beginPluginDrag(def, fullId, down, pointerEvent());
    expect(state).toEqual({ kind: "plugin", fullId, last: down });
    const moved = movePluginDrag(def, state, mid, pointerEvent({ pressure: 0.9 }));
    expect(moved).toEqual({ kind: "plugin", fullId, last: mid });
    endPluginDrag(def, up, pointerEvent({ pressure: 0 }));
    expect(seen.map((s) => s.kind)).toEqual(["down", "move", "up"]);
    expect(seen.map((s) => s.world)).toEqual([down, mid, up]);
    expect(seen.every((s) => s.ev.pointerType === "pen")).toBe(true);
    expect(seen[1].ev.pressure).toBe(0.9);
  });

  it("starts a drag for a move-only tool without calling a down callback", () => {
    const moves: Pt[] = [];
    const def = toolDef({ onPointerMove: (world) => moves.push(world) });
    const state = beginPluginDrag(def, fullId, down, pointerEvent());
    expect(state.kind).toBe("plugin");
    movePluginDrag(def, state, mid, pointerEvent());
    expect(moves).toEqual([mid]);
  });

  it("ignores a move with no button down, leaving the drag where it was", () => {
    const moves: Pt[] = [];
    const def = toolDef({ onPointerMove: (world) => moves.push(world) });
    const state = beginPluginDrag(def, fullId, down, pointerEvent());
    const kept = movePluginDrag(def, state, mid, pointerEvent({ buttons: 0 }));
    expect(moves).toEqual([]);
    expect(kept).toEqual(state);
    movePluginDrag(def, state, mid, pointerEvent());
    expect(moves).toEqual([mid]);
  });

  it("cancels at the drag's last point, not at a fresh position", () => {
    const cancelled: Array<{ world: Pt; ev: PluginPointerEvent }> = [];
    const def = toolDef({ onPointerCancel: (world, ev) => cancelled.push({ world, ev }) });
    const state: PluginDragState = beginPluginDrag(def, fullId, down, pointerEvent());
    const moved = movePluginDrag(def, state, mid, pointerEvent());
    cancelPluginDrag(def, moved, NEUTRAL_PLUGIN_POINTER_EVENT);
    expect(cancelled).toEqual([{ world: mid, ev: NEUTRAL_PLUGIN_POINTER_EVENT }]);
  });

  it("skips a callback the tool does not define, without throwing", () => {
    const def = toolDef();
    const state = beginPluginDrag(def, fullId, down, pointerEvent());
    expect(() => movePluginDrag(def, state, mid, pointerEvent())).not.toThrow();
    expect(() => endPluginDrag(def, up, pointerEvent())).not.toThrow();
    expect(() => cancelPluginDrag(def, state, NEUTRAL_PLUGIN_POINTER_EVENT)).not.toThrow();
  });
});
