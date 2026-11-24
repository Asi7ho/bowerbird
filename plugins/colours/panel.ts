// Colour Library — the panel: a wheel and sliders pick
// the colour, named palettes hold it. Click a tile to
// apply its colour (selected strokes and swatches, or the
// pen); drag a tile to place a swatch on the board. The
// picked colour is the colour new palettes and added
// colours come from.
import type { PluginContext, StrokeGradient } from "bowerbird-plugin-api";
import { applyColour } from "./apply.js";
import { HARMONY_NAMES, colourDistance, deepShadeHex, harmoniesFor, hexToHsl, hexToHsv, hexToRgb, hslToHex, hsvToHex, isHex, normaliseHex, rgbToHex, type HarmonyName } from "./color.js";
import { attachPlaceDrag } from "./place.js";
import {
  addColour,
  createPalette,
  deletePalette,
  emptyStore,
  movePalette,
  recordRecent,
  removeColour,
  renamePalette,
  type ColourStore,
} from "./store.js";
import { createWheel, type WheelHandle } from "./wheel.js";

// The EyeDropper API is not in TypeScript's DOM library, so
// it is declared here, minimally: a constructor whose open()
// resolves with the picked colour as sRGBHex.
interface EyeDropperResult {
  sRGBHex: string;
}

declare global {
  interface Window {
    EyeDropper?: new () => { open: () => Promise<EyeDropperResult> };
  }
}

let api: PluginContext | null = null;
let store: ColourStore = emptyStore();
// The picked colour, as HSL: the wheel and the sliders
// all write the same three numbers, so they never drift.
let base = hexToHsl("#007AFF");
// The picked opacity, 0–100%: the other half of the
// picked state. It moves with the opacity slider and the
// pen, and rides along on every click-apply.
let opacity = 100;
// The picked gradient, null for a solid stroke: the
// third part of the picked state. It moves with the
// gradient editor and the pen, and rides along on every
// click-apply, like the opacity.
let gradient: StrokeGradient | null = null;
// The stop the wheel and sliders edit when a gradient is
// on: clicking a stop selects it, and the picked colour
// targets that stop.
let selectedStop = 0;
// The harmony type: Analogous first, so the middle tile
// of the shown set is the picked colour itself.
let harmony: HarmonyName = "Analogous";
// The recent colours, most recent first: recorded when a
// colour is applied or the picked colour settles, never
// on an intermediate drag tick.
let recent: string[] = [];
// The tweak mode: HSL, RGB, HSV or Hex — different
// editors for the same picked colour, never separate
// state. Persisted, so the panel reopens as left.
export type PickerMode = "hsl" | "rgb" | "hsv" | "hex";

export function parsePickerMode(value: unknown): PickerMode {
  return value === "rgb" || value === "hsv" || value === "hex" ? value : "hsl";
}

let mode: PickerMode = "hsl";
let modeSegButtons: Partial<Record<PickerMode, HTMLButtonElement>> = {};
let harmonyMenuItems: Partial<Record<HarmonyName, HTMLButtonElement>> = {};
let harmonyBtn: HTMLButtonElement | null = null;
let harmonyBtnLabel: HTMLSpanElement | null = null;
let harmonyMenuEl: HTMLDivElement | null = null;
let gradToggleBtn: HTMLButtonElement | null = null;
let gradientEditorEl: HTMLDivElement | null = null;
let gradientStripEl: HTMLDivElement | null = null;
// The stop being dragged on the strip, by index —
// while set, renderGradientStops does not rebuild
// the markers, so the drag never loses its marker
// to a rebuild under the pointer.
let draggingStop: number | null = null;
let controlsEl: HTMLDivElement | null = null;
let harmonyEl: HTMLDivElement | null = null;
let recentSectionEl: HTMLDivElement | null = null;
let recentEl: HTMLDivElement | null = null;
let palettesEl: HTMLDivElement | null = null;
let wheel: WheelHandle | null = null;
let pickedSwatch: HTMLButtonElement | null = null;
let pickedHexEl: HTMLDivElement | null = null;
let hueInput: HTMLInputElement | null = null;
let hueValue: HTMLSpanElement | null = null;
let satInput: HTMLInputElement | null = null;
let satValue: HTMLSpanElement | null = null;
let lightInput: HTMLInputElement | null = null;
let lightValue: HTMLSpanElement | null = null;
let redInput: HTMLInputElement | null = null;
let redValue: HTMLSpanElement | null = null;
let greenInput: HTMLInputElement | null = null;
let greenValue: HTMLSpanElement | null = null;
let blueInput: HTMLInputElement | null = null;
let blueValue: HTMLSpanElement | null = null;
let hsvHueInput: HTMLInputElement | null = null;
let hsvHueValue: HTMLSpanElement | null = null;
let hsvSatInput: HTMLInputElement | null = null;
let hsvSatValue: HTMLSpanElement | null = null;
let hsvValInput: HTMLInputElement | null = null;
let hsvValValue: HTMLSpanElement | null = null;
let hexInput: HTMLInputElement | null = null;
let opacityInput: HTMLInputElement | null = null;
let opacityValue: HTMLSpanElement | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// The native colour-input fallback, if one is open: its
// input listener must be removed when it closes, and a
// cancelled dialog fires no change event, so a stale one
// is removed when the picker opens again.
let eyeDropperFallback: HTMLInputElement | null = null;
let eyeDropperFallbackOnInput: (() => void) | null = null;

export function initPanel(a: PluginContext, initial: ColourStore, initialMode: PickerMode = "hsl", initialRecent: string[] = []): void {
  api = a;
  store = initial;
  mode = initialMode;
  recent = initialRecent;
  if (a.pen) {
    const pen = a.pen.getColor();
    if (isHex(pen)) base = hexToHsl(pen);
    const penOpacity = a.pen.getOpacity();
    if (Number.isFinite(penOpacity)) opacity = Math.min(100, Math.max(0, Math.round(penOpacity)));
    const penGradient = a.pen.getGradient();
    if (penGradient && penGradient.stops.length > 0) {
      gradient = penGradient;
      selectedStop = 0;
      base = hexToHsl(penGradient.stops[0].color);
    }
  }
}

export function clearPanel(): void {
  api = null;
  store = emptyStore();
  harmony = "Analogous";
  opacity = 100;
  gradient = null;
  selectedStop = 0;
  recent = [];
  modeSegButtons = {};
  harmonyMenuItems = {};
  harmonyBtn = null;
  harmonyBtnLabel = null;
  harmonyMenuEl = null;
  gradToggleBtn = null;
  gradientEditorEl = null;
  gradientStripEl = null;
  draggingStop = null;
  controlsEl = null;
  harmonyEl = null;
  recentSectionEl = null;
  recentEl = null;
  palettesEl = null;
  wheel = null;
  pickedSwatch = null;
  pickedHexEl = null;
  hueInput = null;
  hueValue = null;
  satInput = null;
  satValue = null;
  lightInput = null;
  lightValue = null;
  redInput = null;
  redValue = null;
  greenInput = null;
  greenValue = null;
  blueInput = null;
  blueValue = null;
  hsvHueInput = null;
  hsvHueValue = null;
  hsvSatInput = null;
  hsvSatValue = null;
  hsvValInput = null;
  hsvValValue = null;
  hexInput = null;
  opacityInput = null;
  opacityValue = null;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  removeEyeDropperFallback();
}

function scheduleSave(): void {
  if (!api || !api.storage) return;
  // Debounced: every palette edit used to rewrite the
  // whole plugin-storage file at once, which is a full IPC
  // call plus a synchronous disk write per edit. Recents
  // ride the same timer, under their own key.
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!api || !api.storage) return;
    void api.storage.set("palettes", store.palettes).catch(() => { /* storage is a convenience, not a palette */ });
    void api.storage.set("recent", recent).catch(() => { /* storage is a convenience, not a recent list */ });
  }, 250);
}

// Record a colour as the most recent one, and show it.
function recordColour(hex: string): void {
  const next = recordRecent(recent, hex);
  if (next === recent) return;
  recent = next;
  scheduleSave();
  renderRecent();
}

// Apply a colour, and record it: every tile click, the
// preview click, an eyedropper pick and a hex commit all
// go through here, so the recent list holds exactly the
// colours that were applied. The picked opacity rides
// along: a click applies the tile's colour at the picked
// opacity, never at the stroke's old one. With a gradient
// on, the tile's colour sets the selected stop — the
// picked colour targets that stop — and the whole picked
// state (colour, opacity, gradient) is applied: a plain
// colour tile still carries the gradient, because the
// picked state is one thing.
function applyAndRecord(hex: string): void {
  if (!api) return;
  if (gradient) {
    const normalised = normaliseHex(hex);
    if (normalised) {
      base = hexToHsl(normalised);
      syncSelectedStop(normalised);
    }
    const g = gradient;
    if (g) {
      applyColour(api, g.stops[0].color, opacity, g);
      recordColour(normalised ?? hex);
      return;
    }
  }
  // Solid: the null gradient rides along too, so a
  // gradient stroke applied in solid mode goes back to
  // solid instead of keeping its old gradient.
  applyColour(api, hex, opacity, null);
  recordColour(hex);
}

// Write a gradient to the pen and re-read it, so the
// panel's state is exactly the pen's — the core forces
// the angle to 0 and sorts the stops. Setting a
// gradient also moves the pen colour to its first stop.
function setGradient(next: StrokeGradient | null): void {
  if (!api || !api.pen) return;
  if (api.pen.setGradient(next)) {
    gradient = api.pen.getGradient();
    selectedStop = gradient ? Math.min(selectedStop, gradient.stops.length - 1) : 0;
  }
  updatePicked();
}

// The picked colour, as the selected stop's colour: the
// wheel, the sliders, the hex field and a tile click all
// land on that stop when a gradient is on.
function syncSelectedStop(hex: string): void {
  if (!gradient) return;
  const stops = gradient.stops.map((s, i) => (i === selectedStop ? { offset: s.offset, color: hex } : s));
  setGradient({ angle: gradient.angle, stops });
}

function setGradientMode(on: boolean): void {
  if (on === (gradient !== null)) return;
  if (on) {
    // A new gradient runs from the picked colour to a
    // deep shade of it, left to right: a rich fade,
    // never a wash-out to white.
    const hex = pickedHex();
    setGradient({ angle: 0, stops: [{ offset: 0, color: hex }, { offset: 100, color: deepShadeHex(hex) }] });
    selectedStop = 0;
  } else {
    setGradient(null);
    selectedStop = 0;
  }
  renderGradientEditor();
}

function addStop(): void {
  if (!gradient) return;
  // The new stop sits in the middle of the widest gap,
  // in the picked colour, so the gradient gains a stop
  // where it has the most room.
  const stops = [...gradient.stops].sort((a, b) => a.offset - b.offset);
  let gap = 0, at = 50;
  for (let i = 0; i + 1 < stops.length; i++) {
    const g = stops[i + 1].offset - stops[i].offset;
    if (g > gap) { gap = g; at = (stops[i].offset + stops[i + 1].offset) / 2; }
  }
  const offset = Math.round(at);
  const next = [...gradient.stops, { offset, color: pickedHex() }];
  setGradient({ angle: gradient.angle, stops: next });
  if (gradient) selectedStop = Math.max(0, gradient.stops.findIndex((s) => s.offset === offset));
  renderGradientEditor();
}

function removeStop(i: number): void {
  if (!gradient || gradient.stops.length <= 2) return;
  const stops = gradient.stops.filter((_, j) => j !== i);
  selectedStop = Math.min(selectedStop, stops.length - 1);
  setGradient({ angle: gradient.angle, stops });
  renderGradientEditor();
}

function updateStore(next: ColourStore): void {
  if (next === store) return;
  store = next;
  scheduleSave();
  renderPalettes();
}

function pickedHex(): string {
  return hslToHex(base.h, base.s, base.l);
}

// The CSS for a gradient at its opacity: the strip
// and the preview swatch paint the same gradient.
// The gradient is always 0° (left to right); CSS
// angles run 0° bottom-to-top, so 90° is added.
function gradientBackground(stops: { offset: number; color: string }[]): string {
  const cssAngle = (90 + (gradient?.angle ?? 0)) % 360;
  return `linear-gradient(${cssAngle}deg, ${stops.map((s) => {
    const { r, g, b } = hexToRgb(s.color);
    return `rgba(${r}, ${g}, ${b}, ${opacity / 100}) ${s.offset}%`;
  }).join(", ")})`;
}

// Paint the strip from a set of stops: the whole
// gradient at its opacity. A marker drag paints with
// the dragged offsets live and commits on release.
function paintGradientStrip(stops: { offset: number; color: string }[]): void {
  const strip = gradientStripEl;
  if (!strip || !gradient) return;
  strip.style.background = gradientBackground(stops);
}

// Refresh every control that shows the picked colour:
// the preview, its hex, the wheel marker, the current
// mode's controls, and the harmony set, which is made
// from the picked colour and follows it live. With a
// gradient on, the preview shows the gradient, and the
// strip markers follow the wheel — the selected stop's
// marker is the colour being edited.
function updatePicked(): void {
  const hex = pickedHex();
  if (pickedSwatch) {
    if (gradient) {
      // The swatch shows the whole gradient at its
      // opacity, so the preview is what the stroke will
      // look like. The hex beside it still shows the
      // selected stop — the colour the wheel and sliders
      // are editing — and dataset.hex stays that stop's
      // colour.
      pickedSwatch.style.background = gradientBackground(gradient.stops);
      pickedSwatch.dataset.hex = hex;
      pickedSwatch.dataset.opacity = String(opacity);
      pickedSwatch.title = opacity === 100 ? hex : `${hex} at ${opacity}%`;
    } else {
      // The preview shows the picked colour at its picked
      // opacity, so the picked state is visible at a glance.
      const { r, g, b } = hexToRgb(hex);
      pickedSwatch.style.background = `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
      pickedSwatch.dataset.hex = hex;
      pickedSwatch.dataset.opacity = String(opacity);
      pickedSwatch.title = opacity === 100 ? hex : `${hex} at ${opacity}%`;
    }
  }
  // The gradient strip shows the whole picked gradient
  // at its opacity, matching the preview swatch above it.
  if (gradient && gradientStripEl) {
    paintGradientStrip(gradient.stops);
    gradientStripEl.title = opacity === 100 ? `${gradient.stops[0].color} to ${gradient.stops[gradient.stops.length - 1].color} gradient` : `${gradient.stops[0].color} to ${gradient.stops[gradient.stops.length - 1].color} gradient at ${opacity}%`;
  }
  if (pickedHexEl) pickedHexEl.textContent = hex;
  if (opacityInput && Number(opacityInput.value) !== opacity) opacityInput.value = String(opacity);
  if (opacityValue) opacityValue.textContent = `${opacity}%`;
  if (wheel) wheel.setMarker(base.h, base.s);
  renderHarmonies();
  renderGradientStops();
  const setSlider = (input: HTMLInputElement | null, value: HTMLSpanElement | null, v: number, text: string): void => {
    if (input && Number(input.value) !== Math.round(v)) input.value = String(Math.round(v));
    if (value) value.textContent = text;
  };
  if (mode === "hsl") {
    setSlider(hueInput, hueValue, base.h, `${Math.round(base.h)}°`);
    setSlider(satInput, satValue, base.s, `${Math.round(base.s)}%`);
    setSlider(lightInput, lightValue, base.l, `${Math.round(base.l)}%`);
  } else if (mode === "rgb") {
    const rgb = hexToRgb(hex);
    setSlider(redInput, redValue, rgb.r, String(rgb.r));
    setSlider(greenInput, greenValue, rgb.g, String(rgb.g));
    setSlider(blueInput, blueValue, rgb.b, String(rgb.b));
  } else if (mode === "hsv") {
    const hsv = hexToHsv(hex);
    setSlider(hsvHueInput, hsvHueValue, hsv.h, `${Math.round(hsv.h)}°`);
    setSlider(hsvSatInput, hsvSatValue, hsv.s, `${Math.round(hsv.s)}%`);
    setSlider(hsvValInput, hsvValValue, hsv.v, `${Math.round(hsv.v)}%`);
  } else if (hexInput && document.activeElement !== hexInput) {
    hexInput.value = hex;
  }
}

function saveMode(): void {
  if (!api || !api.storage) return;
  // A mode change is a rare, deliberate act: no debounce.
  void api.storage.set("pickerMode", mode).catch(() => { /* storage is a convenience, not a mode */ });
}

function setBase(patch: Partial<typeof base>): void {
  base = { ...base, ...patch };
  // The wheel and sliders edit the selected stop when a
  // gradient is on, not a separate picked colour.
  if (gradient) syncSelectedStop(hslToHex(base.h, base.s, base.l));
  else updatePicked();
}

function setPickedHex(hex: string): void {
  const normalised = normaliseHex(hex);
  if (!normalised) return;
  base = hexToHsl(normalised);
  if (gradient) syncSelectedStop(normalised);
  else updatePicked();
}

function removeEyeDropperFallback(): void {
  if (!eyeDropperFallback) return;
  if (eyeDropperFallbackOnInput) eyeDropperFallback.removeEventListener("input", eyeDropperFallbackOnInput);
  eyeDropperFallback.remove();
  eyeDropperFallback = null;
  eyeDropperFallbackOnInput = null;
}

async function pickWithEyeDropper(): Promise<void> {
  // No await before open(): the call has to stay inside
  // the click's user gesture, or the browser rejects it.
  if (typeof window.EyeDropper === "function") {
    try {
      const result = await new window.EyeDropper().open();
      if (result?.sRGBHex) {
        setPickedHex(result.sRGBHex);
        recordColour(pickedHex());
      }
      return;
    } catch (e) {
      // AbortError is Esc / cancel: nothing to do. Any
      // other failure falls through to the native input,
      // which still picks a colour, just with its dialog.
      if (typeof e === "object" && e !== null && "name" in e && e.name === "AbortError") return;
    }
  }
  removeEyeDropperFallback();
  const fallback = document.createElement("input");
  fallback.type = "color";
  fallback.value = pickedHex();
  fallback.style.cssText = "position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;";
  eyeDropperFallbackOnInput = () => setPickedHex(fallback.value);
  fallback.addEventListener("input", eyeDropperFallbackOnInput);
  // The dialog's change is its close: the pick settles
  // there, not on every input tick while it is open.
  fallback.addEventListener("change", () => {
    recordColour(pickedHex());
    removeEyeDropperFallback();
  }, { once: true });
  eyeDropperFallback = fallback;
  document.body.appendChild(fallback);
  fallback.click();
}

// Icons are inline SVG in the toolbar's style: 24 viewBox,
// stroke paths, no fill. No text glyphs as buttons.
const ICON_CHEVRON_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 14.5 12 8.5l6 6" /></svg>';
const ICON_CHEVRON_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5 12 15.5l6-6" /></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6M14 11v6" /></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>';
// The eyedropper is the one filled icon: solid ink, so it
// reads at small size where the thin outline did not.
const ICON_PICKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="17" cy="6" r="3.6" /><path d="M13.8 6.8 16.2 9.2 10.2 15.2 6.4 17.6 7.8 12.8Z" /><path d="M4.6 17.7C3.1 19.5 2.5 20.4 2.5 21.3a2.1 2.1 0 0 0 4.2 0C6.7 20.4 6.1 19.5 4.6 17.7Z" /></svg>';

function iconButton(label: string, title: string, svg: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "col-icon-btn";
  b.innerHTML = svg;
  b.title = title;
  b.setAttribute("aria-label", label);
  return b;
}

// One slider row: label, slider and value on a single
// line, in the old Palette panel's slider style. The
// change event is the release: a colour is recorded
// there, when the picked colour settles, never on the
// input ticks of a drag.
function sliderRow(label: string, cls: string, max: number, initial: number, onInput: (v: number) => void, onSettle?: () => void): { row: HTMLDivElement; input: HTMLInputElement; value: HTMLSpanElement } {
  const row = document.createElement("div");
  row.className = "col-slider-row";
  const nameEl = document.createElement("span");
  nameEl.className = "col-slider-label";
  nameEl.textContent = label;
  row.appendChild(nameEl);
  const input = document.createElement("input");
  input.className = `col-slider ${cls}`;
  input.type = "range";
  input.min = "0";
  input.max = String(max);
  input.value = String(Math.round(initial));
  input.setAttribute("aria-label", label);
  // Without this, keys pressed while the slider is focused
  // leak to the core handler: +/- zoom, 0 resets the camera,
  // Delete deletes the selection.
  input.addEventListener("keydown", (e) => e.stopPropagation());
  input.addEventListener("input", () => onInput(Number(input.value)));
  if (onSettle) input.addEventListener("change", () => onSettle());
  row.appendChild(input);
  const value = document.createElement("span");
  value.className = "col-slider-value";
  row.appendChild(value);
  return { row, input, value };
}

// The tweak controls for the current mode, rebuilt on
// every mode switch: one mode's controls exist at a time,
// so a selector never matches a stale row. Every mode
// edits the same picked colour, through hex.
function renderControls(): void {
  const host = controlsEl;
  if (!host) return;
  host.innerHTML = "";
  hueInput = hueValue = satInput = satValue = lightInput = lightValue = null;
  redInput = redValue = greenInput = greenValue = blueInput = blueValue = null;
  hsvHueInput = hsvHueValue = hsvSatInput = hsvSatValue = hsvValInput = hsvValValue = null;
  hexInput = null;
  // A slider release records the settled colour; the
  // input ticks of the drag do not.
  const settle = (): void => recordColour(pickedHex());
  if (mode === "hsl") {
    const hue = sliderRow("Hue", "col-slider-hue", 360, base.h, (v) => setBase({ h: v }), settle);
    hueInput = hue.input;
    hueValue = hue.value;
    host.appendChild(hue.row);
    const sat = sliderRow("Saturation", "col-slider-sat", 100, base.s, (v) => setBase({ s: v }), settle);
    satInput = sat.input;
    satValue = sat.value;
    host.appendChild(sat.row);
    const light = sliderRow("Lightness", "col-slider-light", 100, base.l, (v) => setBase({ l: v }), settle);
    lightInput = light.input;
    lightValue = light.value;
    host.appendChild(light.row);
  } else if (mode === "rgb") {
    const rgb = hexToRgb(pickedHex());
    const red = sliderRow("Red", "col-slider-red", 255, rgb.r, (v) => {
      const cur = hexToRgb(pickedHex());
      setPickedHex(rgbToHex(v, cur.g, cur.b));
    }, settle);
    redInput = red.input;
    redValue = red.value;
    host.appendChild(red.row);
    const green = sliderRow("Green", "col-slider-green", 255, rgb.g, (v) => {
      const cur = hexToRgb(pickedHex());
      setPickedHex(rgbToHex(cur.r, v, cur.b));
    }, settle);
    greenInput = green.input;
    greenValue = green.value;
    host.appendChild(green.row);
    const blue = sliderRow("Blue", "col-slider-blue", 255, rgb.b, (v) => {
      const cur = hexToRgb(pickedHex());
      setPickedHex(rgbToHex(cur.r, cur.g, v));
    }, settle);
    blueInput = blue.input;
    blueValue = blue.value;
    host.appendChild(blue.row);
  } else if (mode === "hsv") {
    const hsv = hexToHsv(pickedHex());
    const hue = sliderRow("Hue", "col-slider-hsv-hue", 360, hsv.h, (v) => {
      const cur = hexToHsv(pickedHex());
      setPickedHex(hsvToHex(v, cur.s, cur.v));
    }, settle);
    hsvHueInput = hue.input;
    hsvHueValue = hue.value;
    host.appendChild(hue.row);
    const sat = sliderRow("Saturation", "col-slider-hsv-sat", 100, hsv.s, (v) => {
      const cur = hexToHsv(pickedHex());
      setPickedHex(hsvToHex(cur.h, v, cur.v));
    }, settle);
    hsvSatInput = sat.input;
    hsvSatValue = sat.value;
    host.appendChild(sat.row);
    const val = sliderRow("Value", "col-slider-hsv-val", 100, hsv.v, (v) => {
      const cur = hexToHsv(pickedHex());
      setPickedHex(hsvToHex(cur.h, cur.s, v));
    }, settle);
    hsvValInput = val.input;
    hsvValValue = val.value;
    host.appendChild(val.row);
  } else {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "col-hex-input";
    input.spellcheck = false;
    input.value = pickedHex();
    input.setAttribute("aria-label", "Hex colour");
    input.addEventListener("keydown", (e) => e.stopPropagation());
    const commit = (): void => {
      // A bad hex is ignored, not applied: the field
      // falls back to the last good colour. A good hex
      // is a commit, so it is recorded like any apply.
      if (normaliseHex(input.value)) {
        setPickedHex(input.value);
        recordColour(pickedHex());
      } else input.value = pickedHex();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") input.value = pickedHex();
    });
    input.addEventListener("blur", () => commit());
    hexInput = input;
    host.appendChild(input);
  }
  updatePicked();
}

// The gradient editor: the strip IS the control, with
// the stops as markers on it — rebuilt when the
// gradient turns on or off or a stop is added or
// removed, never on a colour tick, so a marker drag
// never rebuilds the strip under the pointer. The
// markers alone rebuild on a colour tick (see
// renderGradientStops).
function renderGradientEditor(): void {
  const on = gradient !== null;
  if (gradToggleBtn) {
    gradToggleBtn.setAttribute("aria-checked", String(on));
    gradToggleBtn.classList.toggle("on", on);
  }
  const host = gradientEditorEl;
  if (!host) return;
  host.innerHTML = "";
  gradientStripEl = null;
  draggingStop = null;
  if (!on || !gradient) return;
  // The strip first: the whole gradient, tall enough to
  // grab, with the stops as markers on it — click a
  // marker to edit that stop, drag it to move its offset.
  gradientStripEl = document.createElement("div");
  gradientStripEl.className = "col-gradient-strip";
  gradientStripEl.setAttribute("aria-label", "Picked gradient");
  host.appendChild(gradientStripEl);
  // One quiet row under the strip: + to add a stop at
  // the widest gap and × to remove the selected stop
  // (disabled at two stops).
  const controls = document.createElement("div");
  controls.className = "col-gradient-controls";
  const add = iconButton("Add gradient stop", "Add stop", ICON_PLUS);
  add.addEventListener("click", () => addStop());
  controls.appendChild(add);
  const remove = iconButton(`Remove stop ${selectedStop + 1}`, "Remove stop", ICON_CLOSE);
  remove.disabled = gradient.stops.length <= 2;
  remove.addEventListener("click", () => removeStop(selectedStop));
  controls.appendChild(remove);
  host.appendChild(controls);
  renderGradientStops();
  // The strip's background is set in updatePicked, which
  // ran before the strip existed when the gradient was
  // just turned on: refresh it here, or the strip stays
  // blank until the next picked tick.
  updatePicked();
}

// The stops as markers on the strip, one per stop at
// its offset. Clicking a marker selects it — the wheel
// and sliders then edit that stop's colour — and
// dragging it along the strip moves its offset, the
// strip repainting live and the gradient committing on
// release. Arrow keys nudge the focused marker. Rebuilt
// on every picked colour tick, so the selected stop's
// marker follows the wheel; a marker mid-drag never is
// either.
function renderGradientStops(): void {
  if (draggingStop !== null) return;
  const strip = gradientStripEl;
  if (!strip || !gradient) return;
  strip.innerHTML = "";
  gradient.stops.forEach((stop, i) => {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "col-stop-marker" + (i === selectedStop ? " selected" : "");
    marker.style.background = stop.color;
    marker.style.left = `${stop.offset}%`;
    marker.dataset.hex = stop.color;
    marker.dataset.offset = String(stop.offset);
    marker.title = `${stop.color} at ${stop.offset}%`;
    marker.setAttribute("aria-label", `Gradient stop ${i + 1}, ${stop.color} at ${stop.offset}%`);
    marker.setAttribute("aria-pressed", String(i === selectedStop));
    const select = (): void => {
      selectedStop = i;
      base = hexToHsl(stop.color);
      updatePicked();
    };
    // Keyboard: Enter/Space fire click, with no
    // pointerdown — the click is the select.
    marker.addEventListener("click", () => select());
    marker.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopPropagation();
      if (!gradient) return;
      const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
      const offset = Math.min(100, Math.max(0, stop.offset + step));
      if (offset === stop.offset) return;
      const stops = gradient.stops.map((s, j) => (j === i ? { offset, color: s.color } : s));
      setGradient({ angle: gradient.angle, stops });
      if (gradient) selectedStop = Math.max(0, gradient.stops.findIndex((s) => s.offset === offset && s.color === stop.color));
      renderGradientStops();
    });
    marker.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !gradient) return;
      e.preventDefault();
      // Select first, so the wheel follows the stop
      // being dragged; the rebuild is guarded below.
      selectedStop = i;
      base = hexToHsl(stop.color);
      draggingStop = i;
      updatePicked();
      marker.setPointerCapture(e.pointerId);
      const stripEl = gradientStripEl;
      const offsetAt = (clientX: number): number => {
        const rect = stripEl?.getBoundingClientRect();
        if (!rect || rect.width === 0) return stop.offset;
        return Math.round(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
      };
      const move = (ev: PointerEvent): void => {
        if (!gradient) return;
        const offset = offsetAt(ev.clientX);
        marker.style.left = `${offset}%`;
        marker.dataset.offset = String(offset);
        marker.title = `${stop.color} at ${offset}%`;
        marker.setAttribute("aria-label", `Gradient stop ${i + 1}, ${stop.color} at ${offset}%`);
        paintGradientStrip(gradient.stops.map((s, j) => (j === i ? { offset, color: s.color } : s)));
      };
      const finish = (ev: PointerEvent, commit: boolean): void => {
        marker.removeEventListener("pointermove", move);
        marker.removeEventListener("pointerup", up);
        marker.removeEventListener("pointercancel", cancel);
        draggingStop = null;
        if (!commit || !gradient) { renderGradientStops(); return; }
        const offset = offsetAt(ev.clientX);
        if (offset === stop.offset) { renderGradientStops(); return; }
        const stops = gradient.stops.map((s, j) => (j === i ? { offset, color: s.color } : s));
        setGradient({ angle: gradient.angle, stops });
        // setGradient sorts, so the dragged stop may
        // have a new index — follow it, by offset and
        // colour, falling back to offset alone.
        if (gradient) {
          const at = gradient.stops.findIndex((s) => s.offset === offset && s.color === stop.color);
          selectedStop = at >= 0 ? at : Math.max(0, gradient.stops.findIndex((s) => s.offset === offset));
        }
        renderGradientStops();
      };
      const up = (ev: PointerEvent): void => finish(ev, true);
      const cancel = (ev: PointerEvent): void => finish(ev, false);
      marker.addEventListener("pointermove", move);
      marker.addEventListener("pointerup", up);
      marker.addEventListener("pointercancel", cancel);
    });
    strip.appendChild(marker);
  });
}

// The harmony type: Analogous first, so the middle tile
// of the shown set is the picked colour itself. Picked
// from a small menu in the Harmonies head row, not a
// five-tab strip across the panel: five short names
// squeezed into the width read as crammed.
function setHarmony(value: HarmonyName): void {
  if (harmony === value) return;
  harmony = value;
  if (harmonyBtnLabel) harmonyBtnLabel.textContent = value;
  for (const [h, b] of Object.entries(harmonyMenuItems)) {
    const active = h === value;
    b.classList.toggle("active", active);
    b.setAttribute("aria-checked", String(active));
  }
  renderHarmonies();
}

function closeHarmonyMenu(): void {
  if (!harmonyMenuEl || !harmonyMenuEl.classList.contains("open")) return;
  harmonyMenuEl.classList.remove("open");
  harmonyBtn?.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onHarmonyMenuOutside, true);
  document.removeEventListener("keydown", onHarmonyMenuKey, true);
}

function onHarmonyMenuOutside(e: PointerEvent): void {
  // Outside the button and the menu: the menu closes,
  // like any flyout. A click on the button itself is
  // inside, so the button's own click toggles it.
  const target = e.target as Node | null;
  if (target && harmonyMenuEl?.contains(target)) return;
  if (target && harmonyBtn?.contains(target)) return;
  closeHarmonyMenu();
}

function onHarmonyMenuKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeHarmonyMenu();
    harmonyBtn?.focus();
  }
}

function toggleHarmonyMenu(): void {
  if (!harmonyMenuEl || !harmonyBtn) return;
  if (harmonyMenuEl.classList.contains("open")) {
    closeHarmonyMenu();
    return;
  }
  harmonyMenuEl.classList.add("open");
  harmonyBtn.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onHarmonyMenuOutside, true);
  document.addEventListener("keydown", onHarmonyMenuKey, true);
}

// The harmony set for the picked colour: five tiles for
// the selected harmony type, remade whenever the picked
// colour moves. Clicking one applies it like any tile.
// The tile holding the picked colour — middle for
// Analogous and Monochromatic, first for the rest —
// carries a blue ring, so the picked colour's place in
// the set is visible at a glance. Nearest match, not
// exact: a shifted Monochromatic set has no exact hit.
function renderHarmonies(): void {
  const list = harmonyEl;
  if (!list) return;
  list.innerHTML = "";
  const found = harmoniesFor(base.h, base.s, base.l).find((h) => h.name === harmony);
  const colors = found ? found.colors : [];
  const picked = pickedHex();
  let pickedIndex = 0;
  let best = Infinity;
  colors.forEach((hex, i) => {
    const d = colourDistance(hex, picked);
    if (d < best) { best = d; pickedIndex = i; }
  });
  colors.forEach((hex, i) => {
    const wrap = document.createElement("div");
    wrap.className = "col-tile-wrap";
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "col-tile col-harmony-tile" + (i === pickedIndex ? " selected" : "");
    tile.style.background = hex;
    tile.dataset.hex = hex;
    tile.title = hex;
    tile.setAttribute("aria-label", hex);
    tile.setAttribute("aria-pressed", String(i === pickedIndex));
    tile.addEventListener("click", () => applyAndRecord(hex));
    wrap.appendChild(tile);
    list.appendChild(wrap);
  });
}

// The recent colours, most recent first. The section
// hides itself while there is nothing to show, so a
// fresh install shows no empty row.
function renderRecent(): void {
  const section = recentSectionEl;
  const list = recentEl;
  if (!section || !list) return;
  section.style.display = recent.length === 0 ? "none" : "";
  list.innerHTML = "";
  for (const hex of recent) {
    const wrap = document.createElement("div");
    wrap.className = "col-tile-wrap";
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "col-tile col-recent-tile";
    tile.style.background = hex;
    tile.dataset.hex = hex;
    tile.title = hex;
    tile.setAttribute("aria-label", hex);
    tile.addEventListener("click", () => applyAndRecord(hex));
    wrap.appendChild(tile);
    list.appendChild(wrap);
  }
}

function renderPalettes(): void {
  const a = api;
  const list = palettesEl;
  if (!a || !list) return;
  list.innerHTML = "";
  store.palettes.forEach((palette, index) => {
    const wrap = document.createElement("div");
    wrap.className = "col-palette";
    const head = document.createElement("div");
    head.className = "col-palette-head";
    const nameEl = document.createElement("span");
    nameEl.className = "col-palette-name";
    nameEl.textContent = palette.name;
    nameEl.title = palette.name;
    nameEl.addEventListener("dblclick", () => {
      const input = document.createElement("input");
      input.className = "col-rename";
      input.value = palette.name;
      input.setAttribute("aria-label", "Palette name");
      input.addEventListener("keydown", (e) => e.stopPropagation());
      let done = false;
      const commit = (): void => {
        if (done) return;
        done = true;
        updateStore(renamePalette(store, index, input.value));
      };
      const cancel = (): void => {
        if (done) return;
        done = true;
        renderPalettes();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") cancel();
      });
      input.addEventListener("blur", () => commit());
      nameEl.replaceWith(input);
      input.focus();
      input.select();
    });
    head.appendChild(nameEl);
    const up = iconButton("Move palette up", "Move up", ICON_CHEVRON_UP);
    up.disabled = index === 0;
    up.addEventListener("click", () => updateStore(movePalette(store, index, -1)));
    const down = iconButton("Move palette down", "Move down", ICON_CHEVRON_DOWN);
    down.disabled = index === store.palettes.length - 1;
    down.addEventListener("click", () => updateStore(movePalette(store, index, 1)));
    const del = iconButton("Delete palette", "Delete palette", ICON_TRASH);
    del.addEventListener("click", () => updateStore(deletePalette(store, index)));
    head.append(up, down, del);
    wrap.appendChild(head);
    const row = document.createElement("div");
    row.className = "col-tiles";
    palette.colors.forEach((hex, j) => {
      const tileWrap = document.createElement("div");
      tileWrap.className = "col-tile-wrap";
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "col-tile";
      tile.style.background = hex;
      tile.dataset.hex = hex;
      tile.title = hex;
      tile.setAttribute("aria-label", hex);
      tile.addEventListener("click", () => applyAndRecord(hex));
      attachPlaceDrag(a, tile);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "col-tile-x";
      x.innerHTML = ICON_CLOSE;
      x.title = "Remove colour";
      x.setAttribute("aria-label", `Remove ${hex}`);
      x.addEventListener("click", () => updateStore(removeColour(store, index, j)));
      tileWrap.append(tile, x);
      row.appendChild(tileWrap);
    });
    // The + tile adds the picked colour, at the end of
    // the row, the same size as a tile.
    const add = document.createElement("button");
    add.type = "button";
    add.className = "col-add-tile";
    add.innerHTML = ICON_PLUS;
    add.title = "Add picked colour";
    add.setAttribute("aria-label", "Add picked colour");
    add.addEventListener("click", () => updateStore(addColour(store, index, pickedHex())));
    row.appendChild(add);
    wrap.appendChild(row);
    list.appendChild(wrap);
  });
}

export function renderPanel(container: HTMLElement): void {
  const a = api;
  if (!a) return;
  container.innerHTML = "";
  const pickerSection = document.createElement("div");
  pickerSection.className = "col-picker-section";
  // A wheel release records the settled colour; the
  // pointermove ticks of the drag do not.
  wheel = createWheel((h, s) => setBase({ h, s }), () => recordColour(pickedHex()));
  pickerSection.appendChild(wheel.element);
  const previewRow = document.createElement("div");
  previewRow.className = "col-preview-row";
  pickedSwatch = document.createElement("button");
  pickedSwatch.type = "button";
  pickedSwatch.className = "col-picked";
  pickedSwatch.setAttribute("aria-label", "Picked colour");
  pickedSwatch.addEventListener("click", () => applyAndRecord(pickedHex()));
  attachPlaceDrag(a, pickedSwatch);
  previewRow.appendChild(pickedSwatch);
  pickedHexEl = document.createElement("div");
  pickedHexEl.className = "col-hex";
  previewRow.appendChild(pickedHexEl);
  const pickerBtn = document.createElement("button");
  pickerBtn.type = "button";
  pickerBtn.className = "col-picker-btn";
  pickerBtn.title = "Pick a colour from the screen";
  pickerBtn.setAttribute("aria-label", "Pick a colour from the screen");
  pickerBtn.innerHTML = ICON_PICKER;
  pickerBtn.addEventListener("click", () => void pickWithEyeDropper());
  previewRow.appendChild(pickerBtn);
  pickerSection.appendChild(previewRow);
  // The tweak controls, a segmented row: HSL, RGB, HSV or
  // Hex — one picked colour, four editors. They sit with
  // the wheel and preview: picking a colour is the first
  // thing, and the wheel, the preview and these sliders
  // are one control surface.
  const modeSeg = document.createElement("div");
  modeSeg.className = "col-mode-seg";
  modeSeg.setAttribute("role", "group");
  modeSeg.setAttribute("aria-label", "Colour mode");
  for (const [value, label] of [["hsl", "HSL"], ["rgb", "RGB"], ["hsv", "HSV"], ["hex", "Hex"]] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "col-mode-seg-btn" + (value === mode ? " active" : "");
    btn.dataset.mode = value;
    btn.textContent = label;
    btn.setAttribute("aria-label", `${label} mode`);
    btn.setAttribute("aria-pressed", String(value === mode));
    btn.addEventListener("click", () => {
      if (mode === value) return;
      mode = value;
      for (const [m, b] of Object.entries(modeSegButtons)) {
        const active = m === value;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      }
      renderControls();
      saveMode();
    });
    modeSegButtons[value] = btn;
    modeSeg.appendChild(btn);
  }
  pickerSection.appendChild(modeSeg);
  controlsEl = document.createElement("div");
  controlsEl.className = "col-controls";
  pickerSection.appendChild(controlsEl);
  // The picked opacity sits with the tweak controls, right
  // after the mode's sliders: it is a property of the
  // colour being picked, not of the fill. One slider, in
  // the same style, that never rebuilds on a mode switch.
  // It moves the picked state and the pen on every tick,
  // like the wheel moves the colour; it never recolours
  // selected strokes by itself — the picked state only
  // lands on a click-apply.
  const opacityRow = sliderRow("Opacity", "col-slider-opacity", 100, opacity, (v) => {
    opacity = v;
    a.pen.setOpacity(v);
    updatePicked();
  });
  opacityInput = opacityRow.input;
  opacityValue = opacityRow.value;
  pickerSection.appendChild(opacityRow.row);
  // The fill control follows the opacity row directly:
  // no hairline, no section of its own. It is a binary
  // toggle, not a second segmented row — Solid on the
  // left, Gradient on the right, one switch between
  // them, the knob sliding to the active side. The
  // gradient editor follows from it. Turning the
  // gradient off clears it, and the picked state is
  // solid again.
  gradToggleBtn = document.createElement("button");
  gradToggleBtn.type = "button";
  gradToggleBtn.className = "col-fill-toggle";
  gradToggleBtn.setAttribute("role", "switch");
  gradToggleBtn.setAttribute("aria-label", "Gradient stroke");
  gradToggleBtn.setAttribute("aria-checked", String(gradient !== null));
  const solidLabel = document.createElement("span");
  solidLabel.className = "col-fill-toggle-label";
  solidLabel.textContent = "Solid";
  gradToggleBtn.appendChild(solidLabel);
  const toggleTrack = document.createElement("span");
  toggleTrack.className = "col-fill-toggle-track";
  const toggleKnob = document.createElement("span");
  toggleKnob.className = "col-fill-toggle-knob";
  toggleTrack.appendChild(toggleKnob);
  gradToggleBtn.appendChild(toggleTrack);
  const gradientLabel = document.createElement("span");
  gradientLabel.className = "col-fill-toggle-label";
  gradientLabel.textContent = "Gradient";
  gradToggleBtn.appendChild(gradientLabel);
  gradToggleBtn.addEventListener("click", () => setGradientMode(gradient === null));
  pickerSection.appendChild(gradToggleBtn);
  gradientEditorEl = document.createElement("div");
  gradientEditorEl.className = "col-gradient-editor";
  pickerSection.appendChild(gradientEditorEl);
  renderGradientEditor();
  container.appendChild(pickerSection);
  renderControls();
  // Harmonies of the picked colour: the type is a small
  // menu in the head row, showing the current type, with
  // five tiles below it.
  const harmoniesSection = document.createElement("div");
  harmoniesSection.className = "col-section col-section-harmonies";
  const harmoniesHead = document.createElement("div");
  harmoniesHead.className = "col-harmonies-head";
  const harmoniesTitle = document.createElement("span");
  harmoniesTitle.className = "col-section-title";
  harmoniesTitle.textContent = "Harmonies";
  harmoniesHead.appendChild(harmoniesTitle);
  harmonyBtn = document.createElement("button");
  harmonyBtn.type = "button";
  harmonyBtn.className = "col-harmony-btn";
  harmonyBtn.setAttribute("aria-label", "Harmony type");
  harmonyBtn.setAttribute("aria-haspopup", "menu");
  harmonyBtn.setAttribute("aria-expanded", "false");
  harmonyBtnLabel = document.createElement("span");
  harmonyBtnLabel.textContent = harmony;
  harmonyBtn.appendChild(harmonyBtnLabel);
  const harmonyChevron = document.createElement("span");
  harmonyChevron.className = "col-harmony-chevron";
  harmonyChevron.innerHTML = ICON_CHEVRON_DOWN;
  harmonyBtn.appendChild(harmonyChevron);
  harmonyBtn.addEventListener("click", () => toggleHarmonyMenu());
  harmoniesHead.appendChild(harmonyBtn);
  harmonyMenuEl = document.createElement("div");
  harmonyMenuEl.className = "col-harmony-menu";
  harmonyMenuEl.setAttribute("role", "menu");
  harmonyMenuEl.setAttribute("aria-label", "Harmony type");
  for (const value of HARMONY_NAMES) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "col-harmony-menu-item" + (value === harmony ? " active" : "");
    item.dataset.harmony = value;
    item.textContent = value;
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(value === harmony));
    item.addEventListener("click", () => {
      setHarmony(value);
      closeHarmonyMenu();
    });
    harmonyMenuItems[value] = item;
    harmonyMenuEl.appendChild(item);
  }
  harmoniesHead.appendChild(harmonyMenuEl);
  harmoniesSection.appendChild(harmoniesHead);
  harmonyEl = document.createElement("div");
  harmonyEl.className = "col-tiles";
  harmoniesSection.appendChild(harmonyEl);
  container.appendChild(harmoniesSection);
  renderHarmonies();
  // The recent colours: the last applied or settled
  // colours, most recent first.
  recentSectionEl = document.createElement("div");
  recentSectionEl.className = "col-section";
  const recentTitle = document.createElement("span");
  recentTitle.className = "col-section-title";
  recentTitle.textContent = "Recent";
  recentSectionEl.appendChild(recentTitle);
  recentEl = document.createElement("div");
  recentEl.className = "col-tiles";
  recentSectionEl.appendChild(recentEl);
  container.appendChild(recentSectionEl);
  renderRecent();
  // The palettes head their own section: "Saved Palettes"
  // with a + button at the right end, instead of a
  // separate button under the list.
  const palettesHead = document.createElement("div");
  palettesHead.className = "col-palettes-head";
  const palettesTitle = document.createElement("span");
  palettesTitle.className = "col-palettes-title";
  palettesTitle.textContent = "Saved Palettes";
  palettesHead.appendChild(palettesTitle);
  const newBtn = iconButton("New palette", "New palette", ICON_PLUS);
  // A new palette starts from the picked colour: the
  // picked colour already follows the pen on open, so a
  // separate "from pen" action would add nothing.
  newBtn.addEventListener("click", () => updateStore(createPalette(store, [pickedHex()]).store));
  palettesHead.appendChild(newBtn);
  container.appendChild(palettesHead);
  palettesEl = document.createElement("div");
  palettesEl.className = "col-palettes";
  container.appendChild(palettesEl);
  renderPalettes();
  updatePicked();
}
