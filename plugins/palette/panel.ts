// Palette — the colour wheel panel. The wheel (hue round the
// wheel, saturation centre to edge), the lightness slider, the
// preview swatch with its hex, and the five palettes. Picking
// a colour — on the wheel, on the lightness slider, or with the
// picker icon beside the preview — also sets the pen to that
// colour, through api.pen.setColor, so the next pen stroke is
// the colour just picked, and the toolbar's pen swatches show
// it (as a custom swatch when it is not one of the six fixed
// colours).
//
// The wheel is hue + saturation: angle round the wheel is
// hue (red at the top, clockwise), distance from the
// centre is saturation (grey centre, vivid edge). It is
// drawn on a canvas at lightness 50%, pixel by pixel in
// HSL, so the colour under the marker is exactly the hue
// and saturation picked — a conic-gradient with a white
// overlay would show light pinks where the picked colour
// is a muted red, which is wrong for a colour tool. The
// lightness slider below the wheel sets lightness, and
// the preview swatch shows the finished colour: hue and
// saturation from the wheel, lightness from the slider.
// At the default lightness (50%) the preview matches the
// wheel pixel exactly.
import type { PluginContext } from "../../src/plugins";
import { hexToHsl, hslToHex, palettesFor } from "./color.js";
import { getBase, savePicked, setBase, setBaseH, setBaseL, setBaseS, setSettingPen } from "./state.js";
import { attachPlaceInteractions } from "./place.js";

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
let wheelCanvas: HTMLCanvasElement | null = null;
let wheelMarker: HTMLDivElement | null = null;
let previewSwatch: HTMLButtonElement | null = null;
let previewHex: HTMLDivElement | null = null;
let lightnessSlider: HTMLInputElement | null = null;
let lightnessValue: HTMLSpanElement | null = null;
let palettesEl: HTMLDivElement | null = null;
let paletteTiles: HTMLButtonElement[] = [];

export function initPanel(a: PluginContext): void {
  api = a;
}

export function clearPanel(): void {
  api = null;
  wheelCanvas = null;
  wheelMarker = null;
  previewSwatch = null;
  previewHex = null;
  lightnessSlider = null;
  lightnessValue = null;
  palettesEl = null;
  paletteTiles = [];
}

function drawWheel(): void {
  if (!wheelCanvas) return;
  const size = wheelCanvas.width;
  const ctx = wheelCanvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(size, size);
  const centre = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre, dy = y - centre;
      const r = Math.hypot(dx, dy) / centre;
      const i = (y * size + x) * 4;
      if (r > 1) { img.data[i + 3] = 0; continue; }
      const h = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
      const s = r * 100;
      // HSL at lightness 50%, converted inline (same maths
      // as hslToHex, without the hex step).
      const c = (1 - Math.abs(2 * 0.5 - 1)) * (s / 100);
      const xx = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = 0.5 - c / 2;
      let rr = 0, gg = 0, bb = 0;
      if (h < 60) { rr = c; gg = xx; }
      else if (h < 120) { rr = xx; gg = c; }
      else if (h < 180) { gg = c; bb = xx; }
      else if (h < 240) { gg = xx; bb = c; }
      else if (h < 300) { rr = xx; bb = c; }
      else { rr = c; bb = xx; }
      img.data[i] = Math.round((rr + m) * 255);
      img.data[i + 1] = Math.round((gg + m) * 255);
      img.data[i + 2] = Math.round((bb + m) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function updateAll(setPen: boolean): void {
  const { h: baseH, s: baseS, l: baseL } = getBase();
  const hex = hslToHex(baseH, baseS, baseL);
  if (setPen) savePicked();
  if (previewSwatch) {
    previewSwatch.style.background = hex;
    previewSwatch.dataset.hex = hex;
    previewSwatch.title = hex;
  }
  if (previewHex) previewHex.textContent = hex;
  // Picking sets the pen, but only when a pick actually
  // happened: the initial render must not overwrite the
  // pen colour the user already had with Palette's
  // default blue, and a pen change coming back from the
  // toolbar must not echo back into a pen set.
  if (setPen && api && api.pen) {
    setSettingPen(true);
    try { api.pen.setColor(hex); } finally { setSettingPen(false); }
  }
  if (lightnessValue) lightnessValue.textContent = `${Math.round(baseL)}%`;
  if (lightnessSlider && Number(lightnessSlider.value) !== Math.round(baseL)) lightnessSlider.value = String(Math.round(baseL));
  if (wheelMarker && wheelCanvas) {
    const rect = wheelCanvas.getBoundingClientRect();
    const radius = rect.width / 2;
    const angle = (baseH - 90) * Math.PI / 180;
    const r = (baseS / 100) * radius;
    wheelMarker.style.left = `${radius + r * Math.cos(angle)}px`;
    wheelMarker.style.top = `${radius + r * Math.sin(angle)}px`;
  }
  const palettes = palettesFor(baseH, baseS, baseL);
  let idx = 0;
  for (const palette of palettes) {
    for (const color of palette.colors) {
      const tile = paletteTiles[idx++];
      if (!tile) continue;
      tile.style.background = color;
      tile.dataset.hex = color;
      tile.title = color;
      tile.setAttribute("aria-label", `${palette.name} ${color}`);
    }
  }
}

function pickFromWheel(clientX: number, clientY: number): void {
  if (!wheelCanvas) return;
  const rect = wheelCanvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = clientX - cx, dy = clientY - cy;
  const radius = rect.width / 2;
  const r = Math.min(1, Math.hypot(dx, dy) / radius);
  setBaseH((Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360);
  setBaseS(r * 100);
  updateAll(true);
}

function applyPickedHex(hex: string | undefined): void {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const hsl = hexToHsl(hex);
  setBase(hsl.h, hsl.s, hsl.l);
  updateAll(true);
}

async function pickWithEyeDropper(): Promise<void> {
  // No await before open(): the call has to stay inside
  // the click's user gesture, or the browser rejects it.
  if (typeof window.EyeDropper === "function") {
    try {
      const result = await new window.EyeDropper().open();
      applyPickedHex(result?.sRGBHex);
      return;
    } catch (e) {
      // AbortError is Esc / cancel: nothing to do. Any
      // other failure (no sampler on this platform, no
      // secure context) falls through to the native input,
      // which still picks a colour, just with its dialog.
      if (typeof e === "object" && e !== null && "name" in e && e.name === "AbortError") return;
    }
  }
  const fallback = document.createElement("input");
  fallback.type = "color";
  fallback.value = hslToHex(getBase().h, getBase().s, getBase().l);
  fallback.style.cssText = "position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;";
  fallback.addEventListener("input", () => applyPickedHex(fallback.value));
  fallback.addEventListener("change", () => fallback.remove(), { once: true });
  document.body.appendChild(fallback);
  fallback.click();
}

export function renderPanel(container: HTMLElement): void {
  const a = api;
  if (!a) return;
  container.innerHTML = "";
  const wheelSection = document.createElement("div");
  wheelSection.className = "pal-wheel-section";
  const wheelWrap = document.createElement("div");
  wheelWrap.className = "pal-wheel-wrap";
  wheelCanvas = document.createElement("canvas");
  wheelCanvas.className = "pal-wheel";
  const cssSize = 180;
  const dpr = window.devicePixelRatio || 1;
  wheelCanvas.width = Math.round(cssSize * dpr);
  wheelCanvas.height = Math.round(cssSize * dpr);
  wheelCanvas.style.width = `${cssSize}px`;
  wheelCanvas.style.height = `${cssSize}px`;
  wheelCanvas.setAttribute("aria-label", "Colour wheel: hue round the wheel, saturation from centre to edge");
  wheelWrap.appendChild(wheelCanvas);
  wheelMarker = document.createElement("div");
  wheelMarker.className = "pal-marker";
  wheelWrap.appendChild(wheelMarker);
  wheelSection.appendChild(wheelWrap);
  const previewRow = document.createElement("div");
  previewRow.className = "pal-preview-row";
  previewSwatch = document.createElement("button");
  previewSwatch.className = "pal-preview";
  previewSwatch.setAttribute("aria-label", "Selected colour");
  attachPlaceInteractions(a, previewSwatch);
  previewRow.appendChild(previewSwatch);
  previewHex = document.createElement("div");
  previewHex.className = "pal-hex";
  previewRow.appendChild(previewHex);
  // The eyedropper, directly — not a native colour
  // input. A native <input type="color"> opens its own
  // colour dialog, and that dialog has yet another
  // eyedropper inside it, which is the tool that actually
  // samples a colour from the screen: two steps where
  // one was wanted. The browser's EyeDropper API is the
  // sampler itself: clicking this icon starts sampling
  // at once, and the next click anywhere picks that
  // colour. It must be called from the click itself, with
  // nothing awaited first, or the browser refuses it as
  // not a user gesture. Picking here sets the wheel, the
  // palettes and the pen, like any other pick. Esc (an
  // AbortError) just cancels, silently.
  const pickerBtn = document.createElement("button");
  pickerBtn.type = "button";
  pickerBtn.className = "pal-picker-wrap";
  pickerBtn.title = "Pick a colour from the screen";
  pickerBtn.setAttribute("aria-label", "Pick a colour from the screen");
  pickerBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.5 19.5 9.5 9 20H4v-5L14.5 4.5Z" /><path d="M13 6l5 5" /><path d="M18 3l3 3" /></svg>';
  pickerBtn.addEventListener("click", () => void pickWithEyeDropper());
  previewRow.appendChild(pickerBtn);
  wheelSection.appendChild(previewRow);
  const sliderRow = document.createElement("div");
  sliderRow.className = "pal-slider-row";
  const sliderLabel = document.createElement("label");
  sliderLabel.className = "pal-slider-label";
  sliderLabel.textContent = "Lightness";
  sliderRow.appendChild(sliderLabel);
  lightnessValue = document.createElement("span");
  lightnessValue.className = "pal-slider-value";
  sliderRow.appendChild(lightnessValue);
  wheelSection.appendChild(sliderRow);
  // Built in a local first: the input handler closes over
  // the slider, and a module-level variable is possibly
  // null inside a closure, so the local is published to
  // the module state only once it is fully wired.
  const slider = document.createElement("input");
  slider.className = "pal-slider";
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = String(Math.round(getBase().l));
  slider.setAttribute("aria-label", "Lightness");
  // Without this, keys pressed while the slider is
  // focused leak to the core handler: +/- zoom, 0
  // resets the camera, Delete deletes the selection.
  slider.addEventListener("keydown", (e) => e.stopPropagation());
  slider.addEventListener("input", () => {
    setBaseL(Number(slider.value));
    updateAll(true);
  });
  lightnessSlider = slider;
  wheelSection.appendChild(slider);
  container.appendChild(wheelSection);

  palettesEl = document.createElement("div");
  palettesEl.className = "pal-sections";
  paletteTiles = [];
  for (const palette of palettesFor(getBase().h, getBase().s, getBase().l)) {
    const wrap = document.createElement("div");
    wrap.className = "pal-palette";
    const head = document.createElement("div");
    head.className = "pal-head";
    head.textContent = palette.name;
    wrap.appendChild(head);
    const row = document.createElement("div");
    row.className = "pal-row";
    for (let i = 0; i < 5; i++) {
      const tile = document.createElement("button");
      tile.className = "pal-tile";
      attachPlaceInteractions(a, tile);
      paletteTiles.push(tile);
      row.appendChild(tile);
    }
    wrap.appendChild(row);
    palettesEl.appendChild(wrap);
  }
  container.appendChild(palettesEl);

  drawWheel();
  updateAll(false);

  const onPointerDown = (e: PointerEvent): void => {
    pickFromWheel(e.clientX, e.clientY);
    const onMove = (me: PointerEvent): void => pickFromWheel(me.clientX, me.clientY);
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  wheelWrap.addEventListener("pointerdown", onPointerDown);
  // Stashed on the wrapper, as before: nothing in the app
  // reads it, but the handler stays reachable from the DOM
  // for a re-render that wants to detach it.
  (wheelWrap as HTMLDivElement & { _palPointerDown?: (e: PointerEvent) => void })._palPointerDown = onPointerDown;
}
