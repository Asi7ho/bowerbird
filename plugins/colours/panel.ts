// Colour Library — the panel: a wheel and sliders pick
// the colour, named palettes hold it. Click a tile to
// apply its colour (selected strokes and swatches, or the
// pen); drag a tile to place a swatch on the board. The
// picked colour is the colour new palettes and added
// colours come from.
import type { PluginContext } from "bowerbird-plugin-api";
import { applyColour } from "./apply.js";
import { hexToHsl, hslToHex, isHex, normaliseHex } from "./color.js";
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
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// The native colour-input fallback, if one is open: its
// input listener must be removed when it closes, and a
// cancelled dialog fires no change event, so a stale one
// is removed when the picker opens again.
let eyeDropperFallback: HTMLInputElement | null = null;
let eyeDropperFallbackOnInput: (() => void) | null = null;

export function initPanel(a: PluginContext, initial: ColourStore): void {
  api = a;
  store = initial;
  if (a.pen) {
    const pen = a.pen.getColor();
    if (isHex(pen)) base = hexToHsl(pen);
  }
}

export function clearPanel(): void {
  api = null;
  store = emptyStore();
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
// the preview, its hex, the wheel marker, the sliders.
function updatePicked(): void {
  const hex = pickedHex();
  if (pickedSwatch) {
    pickedSwatch.style.background = hex;
    pickedSwatch.dataset.hex = hex;
    pickedSwatch.title = hex;
  }
  if (pickedHexEl) pickedHexEl.textContent = hex;
  if (wheel) wheel.setMarker(base.h, base.s);
  if (hueInput && Number(hueInput.value) !== Math.round(base.h)) hueInput.value = String(Math.round(base.h));
  if (hueValue) hueValue.textContent = `${Math.round(base.h)}°`;
  if (satInput && Number(satInput.value) !== Math.round(base.s)) satInput.value = String(Math.round(base.s));
  if (satValue) satValue.textContent = `${Math.round(base.s)}%`;
  if (lightInput && Number(lightInput.value) !== Math.round(base.l)) lightInput.value = String(Math.round(base.l));
  if (lightValue) lightValue.textContent = `${Math.round(base.l)}%`;
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
const ICON_PICKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.5 19.5 9.5 9 20H4v-5L14.5 4.5Z" /><path d="M13 6l5 5" /><path d="M18 3l3 3" /></svg>';

function iconButton(label: string, title: string, svg: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "col-icon-btn";
  b.innerHTML = svg;
  b.title = title;
  b.setAttribute("aria-label", label);
  return b;
}

// One slider row: a label, its value, and the range
// input below, in the old Palette panel's slider style.
function sliderRow(label: string, max: number, initial: number, onInput: (v: number) => void): { row: HTMLDivElement; input: HTMLInputElement; value: HTMLSpanElement } {
  const row = document.createElement("div");
  row.className = "col-slider-row";
  const head = document.createElement("div");
  head.className = "col-slider-head";
  const nameEl = document.createElement("span");
  nameEl.className = "col-slider-label";
  nameEl.textContent = label;
  head.appendChild(nameEl);
  const value = document.createElement("span");
  value.className = "col-slider-value";
  head.appendChild(value);
  row.appendChild(head);
  const input = document.createElement("input");
  input.className = "col-slider";
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
  return { row, input, value };
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
  const hue = sliderRow("Hue", 360, base.h, (v) => setBase({ h: v }));
  hueInput = hue.input;
  hueValue = hue.value;
  pickerSection.appendChild(hue.row);
  const sat = sliderRow("Saturation", 100, base.s, (v) => setBase({ s: v }));
  satInput = sat.input;
  satValue = sat.value;
  pickerSection.appendChild(sat.row);
  const light = sliderRow("Lightness", 100, base.l, (v) => setBase({ l: v }));
  lightInput = light.input;
  lightValue = light.value;
  pickerSection.appendChild(light.row);
  container.appendChild(pickerSection);
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
  palettesEl = document.createElement("div");
  palettesEl.className = "col-palettes";
  container.appendChild(palettesEl);
  renderPalettes();
  updatePicked();
}
