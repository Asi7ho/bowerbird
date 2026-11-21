// Unit tests for the shortcut registry (src/ui/shortcuts.ts):
// binding parse and normalize, matching (including the +/=
// and delete/backspace aliases and the Ctrl/Cmd equivalence),
// capture from a key press, and reset restoring the default.
import { describe, expect, it } from "vitest";
import { binding, bindingFromEvent, loadOverrides, allOverrides, matches, normalizeBinding, reset, resetAll, set } from "../../src/ui/shortcuts";

function keyEvent(key: string, opts?: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }): KeyboardEvent {
  return {
    key,
    ctrlKey: opts?.ctrl ?? false,
    metaKey: opts?.meta ?? false,
    shiftKey: opts?.shift ?? false,
    altKey: opts?.alt ?? false,
  } as KeyboardEvent;
}

describe("normalizeBinding", () => {
  it("orders modifiers ctrl, alt, shift before the key", () => {
    expect(normalizeBinding("Shift+Ctrl+Z")).toBe("ctrl+shift+z");
    expect(normalizeBinding("ALT+ctrl+f")).toBe("ctrl+alt+f");
  });
  it("keeps a lone + as the key", () => {
    expect(normalizeBinding("+")).toBe("+");
    expect(normalizeBinding("ctrl++")).toBe("ctrl++");
  });
  it("rejects a binding with no key", () => {
    expect(normalizeBinding("ctrl")).toBeNull();
    expect(normalizeBinding("ctrl+shift")).toBeNull();
    expect(normalizeBinding("")).toBeNull();
  });
  it("rejects an unknown modifier", () => {
    expect(normalizeBinding("super+z")).toBeNull();
  });
});

describe("matches", () => {
  it("keeps Ctrl+Z (undo) apart from Ctrl+Shift+Z (redo)", () => {
    expect(matches(keyEvent("z", { ctrl: true }), "undo")).toBe(true);
    expect(matches(keyEvent("z", { ctrl: true, shift: true }), "undo")).toBe(false);
    expect(matches(keyEvent("z", { ctrl: true, shift: true }), "redo")).toBe(true);
    expect(matches(keyEvent("z", { ctrl: true }), "redo")).toBe(false);
  });
  it("treats Cmd like Ctrl", () => {
    expect(matches(keyEvent("z", { meta: true }), "undo")).toBe(true);
    expect(matches(keyEvent("g", { meta: true }), "group")).toBe(true);
  });
  it("does not fire a tool key while Ctrl is held", () => {
    expect(matches(keyEvent("v", { ctrl: true }), "select")).toBe(false);
    expect(matches(keyEvent("v"), "select")).toBe(true);
  });
  it("lets + match both + and =", () => {
    expect(matches(keyEvent("+", { shift: true }), "zoom-in")).toBe(true);
    expect(matches(keyEvent("="), "zoom-in")).toBe(true);
    expect(matches(keyEvent("-"), "zoom-in")).toBe(false);
  });
  it("lets delete match both Delete and Backspace", () => {
    expect(matches(keyEvent("Delete"), "delete")).toBe(true);
    expect(matches(keyEvent("Backspace"), "delete")).toBe(true);
    expect(matches(keyEvent("Delete", { ctrl: true }), "delete")).toBe(false);
  });
  it("follows a rebind", () => {
    loadOverrides({ "zoom-fit": "ctrl+0" });
    expect(matches(keyEvent("0", { ctrl: true }), "zoom-fit")).toBe(true);
    expect(matches(keyEvent("f"), "zoom-fit")).toBe(false);
    resetAll();
  });
});

describe("bindingFromEvent", () => {
  it("reads a bare letter without Shift, so Shift+V binds V", () => {
    expect(bindingFromEvent(keyEvent("V", { shift: true }))).toBe("v");
  });
  it("keeps Shift when Ctrl is held, so Ctrl+Shift+Z stays distinct", () => {
    expect(bindingFromEvent(keyEvent("Z", { ctrl: true, shift: true }))).toBe("ctrl+shift+z");
  });
  it("reads Shift+= as +", () => {
    expect(bindingFromEvent(keyEvent("+", { shift: true }))).toBe("+");
  });
  it("ignores a pure modifier press", () => {
    expect(bindingFromEvent(keyEvent("Shift", { shift: true }))).toBeNull();
    expect(bindingFromEvent(keyEvent("Control", { ctrl: true }))).toBeNull();
  });
  it("records Shift for a named key", () => {
    expect(bindingFromEvent(keyEvent("Delete", { shift: true }))).toBe("shift+delete");
  });
});

describe("set and reset", () => {
  it("stores only what differs from the default", () => {
    resetAll();
    expect(set("select", "s")).toBe(true);
    expect(binding("select")).toBe("s");
    expect(allOverrides()).toEqual({ select: "s" });
    // Setting it back to the default drops the override.
    expect(set("select", "v")).toBe(true);
    expect(allOverrides()).toEqual({});
    resetAll();
  });
  it("reset restores the default for that action only", () => {
    loadOverrides({ select: "s", pen: "d" });
    reset("select");
    expect(binding("select")).toBe("v");
    expect(binding("pen")).toBe("d");
    resetAll();
  });
  it("loadOverrides ignores unknown actions and bad bindings", () => {
    loadOverrides({ nope: "x", select: "ctrl" });
    expect(allOverrides()).toEqual({});
    expect(binding("select")).toBe("v");
    resetAll();
  });
});
