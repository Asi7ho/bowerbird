// Unit tests for app settings parsing (electron/app-settings.ts):
// a settings file from before hardware acceleration existed
// still loads with it on, a bad value does not turn it off,
// and a round trip through serialise keeps what was saved.
import { describe, expect, it } from "vitest";
import { cleanShortcuts, parseAppSettings, serialiseAppSettings } from "../../electron/app-settings";

describe("parseAppSettings", () => {
  it("defaults hardware acceleration to on when the file predates it", () => {
    const s = parseAppSettings({ corner: "bottom-left", dockVisible: true });
    expect(s.hardwareAcceleration).toBe(true);
    expect(s.shortcuts).toEqual({});
  });
  it("keeps an explicit off, and ignores a non-boolean", () => {
    expect(parseAppSettings({ hardwareAcceleration: false }).hardwareAcceleration).toBe(false);
    expect(parseAppSettings({ hardwareAcceleration: "yes" }).hardwareAcceleration).toBe(true);
    expect(parseAppSettings({ hardwareAcceleration: 0 }).hardwareAcceleration).toBe(true);
  });
  it("loads shortcut overrides and drops bad entries", () => {
    const s = parseAppSettings({ shortcuts: { select: "s", pen: 4, undo: "ctrl+z" } });
    expect(s.shortcuts).toEqual({ select: "s", undo: "ctrl+z" });
  });
  it("falls back to defaults for a missing or broken file", () => {
    expect(parseAppSettings(null).hardwareAcceleration).toBe(true);
    expect(parseAppSettings("not json").corner).toBe("bottom-left");
    expect(parseAppSettings([]).dockVisible).toBe(true);
  });
  it("clamps the panel width and keeps a valid corner", () => {
    const s = parseAppSettings({ panelWidth: 9999, corner: "top-right" });
    expect(s.panelWidth).toBe(600);
    expect(s.corner).toBe("top-right");
    expect(parseAppSettings({ corner: "nowhere" }).corner).toBe("bottom-left");
  });
});

describe("cleanShortcuts", () => {
  it("caps at 50 entries and drops non-string values", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) big[`a${i}`] = "x";
    big.bad = 7;
    expect(Object.keys(cleanShortcuts(big)).length).toBe(50);
    expect(cleanShortcuts("nope")).toEqual({});
    expect(cleanShortcuts(null)).toEqual({});
  });
});

describe("serialiseAppSettings", () => {
  it("round-trips the hardware acceleration value", () => {
    const s = parseAppSettings({ hardwareAcceleration: false, shortcuts: { select: "s" } });
    const back = parseAppSettings(JSON.parse(serialiseAppSettings(s)));
    expect(back.hardwareAcceleration).toBe(false);
    expect(back.shortcuts).toEqual({ select: "s" });
  });
});
