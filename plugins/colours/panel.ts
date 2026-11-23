// Colour Library — the panel: a wheel and sliders pick
// the colour, named palettes hold it. Click a tile to
// apply its colour (selected strokes and swatches, or the
// pen); drag a tile to place a swatch on the board. The
// picked colour is the colour new palettes and added
// colours come from.
import type { PluginContext } from "bowerbird-plugin-api";
import { applyColour } from "./apply.js";
import { hexToHsl, hexToHsv, hexToRgb, hslToHex, hsvToHex, isHex, normaliseHex, rgbToHex } from "./color.js";
import { attachPlaceDrag } from "./place.js";
import {
  addColour,
  createPalette,
  deletePalette,
  emptyStore,
  movePalette,
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
// The tweak mode: HSL, RGB, HSV or Hex — different
// editors for the same picked colour, never separate
// state. Persisted, so the panel reopens as left.
export type PickerMode = "hsl" | "rgb" | "hsv" | "hex";

export function parsePickerMode(value: unknown): PickerMode {
  return value === "rgb" || value === "hsv" || value === "hex" ? value : "hsl";
}

let mode: PickerMode = "hsl";
let modeSegButtons: Partial<Record<PickerMode, HTMLButtonElement>> = {};
let controlsEl: HTMLDivElement | null = null;
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
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// The native colour-input fallback, if one is open: its
// input listener must be removed when it closes, and a
// cancelled dialog fires no change event, so a stale one
// is removed when the picker opens again.
let eyeDropperFallback: HTMLInputElement | null = null;
let eyeDropperFallbackOnInput: (() => void) | null = null;

export function initPanel(a: PluginContext, initial: ColourStore, initialMode: PickerMode = "hsl"): void {
  api = a;
  store = initial;
  mode = initialMode;
  if (a.pen) {
    const pen = a.pen.getColor();
    if (isHex(pen)) base = hexToHsl(pen);
  }
}

export function clearPanel(): void {
  api = null;
  store = emptyStore();
  modeSegButtons = {};
  controlsEl = null;
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
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  removeEyeDropperFallback();
}

function scheduleSave(): void {
  if (!api || !api.storage) return;
  // Debounced: every palette edit used to rewrite the
  // whole plugin-storage file at once, which is a full IPC
  // call plus a synchronous disk write per edit.
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!api || !api.storage) return;
    void api.storage.set("palettes", store.palettes).catch(() => { /* storage is a convenience, not a palette */ });
  }, 250);
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

// Refresh every control that shows the picked colour:
// the preview, its hex, the wheel marker, and the
// current mode's controls. The wheel draws in HSL, so
// its marker is always the HSL position, in every mode.
function updatePicked(): void {
  const hex = pickedHex();
  if (pickedSwatch) {
    pickedSwatch.style.background = hex;
    pickedSwatch.dataset.hex = hex;
    pickedSwatch.title = hex;
  }
  if (pickedHexEl) pickedHexEl.textContent = hex;
  if (wheel) wheel.setMarker(base.h, base.s);
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
  updatePicked();
}

function setPickedHex(hex: string): void {
  const normalised = normaliseHex(hex);
  if (!normalised) return;
  base = hexToHsl(normalised);
  updatePicked();
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
      if (result?.sRGBHex) setPickedHex(result.sRGBHex);
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
  fallback.addEventListener("change", () => removeEyeDropperFallback(), { once: true });
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
// line, in the old Palette panel's slider style.
function sliderRow(label: string, cls: string, max: number, initial: number, onInput: (v: number) => void): { row: HTMLDivElement; input: HTMLInputElement; value: HTMLSpanElement } {
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
  if (mode === "hsl") {
    const hue = sliderRow("Hue", "col-slider-hue", 360, base.h, (v) => setBase({ h: v }));
    hueInput = hue.input;
    hueValue = hue.value;
    host.appendChild(hue.row);
    const sat = sliderRow("Saturation", "col-slider-sat", 100, base.s, (v) => setBase({ s: v }));
    satInput = sat.input;
    satValue = sat.value;
    host.appendChild(sat.row);
    const light = sliderRow("Lightness", "col-slider-light", 100, base.l, (v) => setBase({ l: v }));
    lightInput = light.input;
    lightValue = light.value;
    host.appendChild(light.row);
  } else if (mode === "rgb") {
    const rgb = hexToRgb(pickedHex());
    const red = sliderRow("Red", "col-slider-red", 255, rgb.r, (v) => {
      const cur = hexToRgb(pickedHex());
      setPickedHex(rgbToHex(v, cur.g, cur.b));
    });
    redInput = red.input;
    redValue = red.value;
    host.appendChild(red.row);
    const green = sliderRow("Green", "col-slider-green", 255, rgb.g, (v) => {
      const cur = hexToRgb(pickedHex());
      setPickedHex(rgbToHex(cur.r, v, cur.b));
    });
    greenInput = green.input;
    greenValue = green.value;
    host.appendChild(green.row);
    const blue = sliderRow("Blue", "col-slider-blue", 255, rgb.b, (v) => {
      const cur = hexToRgb(pickedHex());
      setPickedHex(rgbToHex(cur.r, cur.g, v));
    });
    blueInput = blue.input;
    blueValue = blue.value;
    host.appendChild(blue.row);
  } else if (mode === "hsv") {
    const hsv = hexToHsv(pickedHex());
    const hue = sliderRow("Hue", "col-slider-hsv-hue", 360, hsv.h, (v) => {
      const cur = hexToHsv(pickedHex());
      setPickedHex(hsvToHex(v, cur.s, cur.v));
    });
    hsvHueInput = hue.input;
    hsvHueValue = hue.value;
    host.appendChild(hue.row);
    const sat = sliderRow("Saturation", "col-slider-hsv-sat", 100, hsv.s, (v) => {
      const cur = hexToHsv(pickedHex());
      setPickedHex(hsvToHex(cur.h, v, cur.v));
    });
    hsvSatInput = sat.input;
    hsvSatValue = sat.value;
    host.appendChild(sat.row);
    const val = sliderRow("Value", "col-slider-hsv-val", 100, hsv.v, (v) => {
      const cur = hexToHsv(pickedHex());
      setPickedHex(hsvToHex(cur.h, cur.s, v));
    });
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
      // falls back to the last good colour.
      if (normaliseHex(input.value)) setPickedHex(input.value);
      else input.value = pickedHex();
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
      tile.addEventListener("click", () => {
        if (api) applyColour(api, hex);
      });
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
  wheel = createWheel((h, s) => setBase({ h, s }));
  pickerSection.appendChild(wheel.element);
  const previewRow = document.createElement("div");
  previewRow.className = "col-preview-row";
  pickedSwatch = document.createElement("button");
  pickedSwatch.type = "button";
  pickedSwatch.className = "col-picked";
  pickedSwatch.setAttribute("aria-label", "Picked colour");
  pickedSwatch.addEventListener("click", () => {
    if (api) applyColour(api, pickedHex());
  });
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
  // The mode control, a segmented row: HSL, RGB, HSV or
  // Hex — one picked colour, four editors.
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
  container.appendChild(pickerSection);
  renderControls();
  palettesEl = document.createElement("div");
  palettesEl.className = "col-palettes";
  container.appendChild(palettesEl);
  // The one primary action, at the bottom of the panel,
  // under the palettes — not above them.
  const createRow = document.createElement("div");
  createRow.className = "col-create-row";
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "col-btn";
  newBtn.innerHTML = `${ICON_PLUS}<span>New palette</span>`;
  newBtn.setAttribute("aria-label", "New palette");
  // A new palette starts from the picked colour: the
  // picked colour already follows the pen on open, so a
  // separate "from pen" action would add nothing.
  newBtn.addEventListener("click", () => updateStore(createPalette(store, [pickedHex()]).store));
  createRow.appendChild(newBtn);
  container.appendChild(createRow);
  renderPalettes();
  updatePicked();
}
