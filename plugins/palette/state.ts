// Palette — the picked colour. The wheel, the lightness slider,
// the preview and the palettes all read and write one colour:
// hue and saturation from the wheel, lightness from the slider.
// The preview swatch itself places the picked colour, so the
// exact picked colour is always placeable even when it is not
// in a palette (for example at the lightness extremes, where a
// monochromatic palette is shifted).
//
// Default: the welcome board's blue, #007AFF (hue 211.3,
// saturation 100%, lightness 50% — the hue is fractional
// because #007AFF does not sit on an integer hue).
import type { PluginContext } from "../../src/plugins";
import { hslToHex } from "./color.js";

let api: PluginContext | null = null;

// Default: the welcome board's blue, #007AFF.
let baseH = 211.3;
let baseS = 100;
let baseL = 50;

export function initState(a: PluginContext): void {
  api = a;
}

export function clearState(): void {
  api = null;
}

export function getBase(): { h: number; s: number; l: number } {
  return { h: baseH, s: baseS, l: baseL };
}

export function setBase(h: number, s: number, l: number): void {
  baseH = h;
  baseS = s;
  baseL = l;
}

export function setBaseH(h: number): void {
  baseH = h;
}

export function setBaseS(s: number): void {
  baseS = s;
}

export function setBaseL(l: number): void {
  baseL = l;
}

// While updateAll sets the pen, the pen event it fires
// must not echo back through the pen handler: that handler
// would re-run updateAll and save the pick a second
// time, for every wheel/slider move.
let settingPen = false;

export function isSettingPen(): boolean {
  return settingPen;
}

export function setSettingPen(v: boolean): void {
  settingPen = v;
}

let savePickedTimer: ReturnType<typeof setTimeout> | null = null;

export function savePicked(): void {
  if (!api || !api.storage) return;
  // Debounced: every wheel/slider move used to rewrite
  // the whole plugin-storage file at once (twice per
  // move, counting the pen echo below), which is a full
  // IPC call plus a synchronous disk write per
  // pointermove event. A pick still persists a moment
  // later, and a toolbar pick goes through the same
  // debounce instead of its own immediate write.
  if (savePickedTimer !== null) clearTimeout(savePickedTimer);
  savePickedTimer = setTimeout(() => {
    savePickedTimer = null;
    if (!api || !api.storage) return;
    try {
      const hex = hslToHex(baseH, baseS, baseL);
      void api.storage.set("picked", hex).catch(() => { /* storage is a convenience, not a pick */ });
    } catch { /* same */ }
  }, 250);
}
