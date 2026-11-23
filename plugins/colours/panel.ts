// Colour Library — the panel: named palettes, each a row of
// colour tiles. Click a tile to apply its colour (selected
// strokes and swatches, or the pen); drag a tile to place a
// swatch on the board. The picked colour at the top is the
// colour new palettes and added colours come from.
import type { PluginContext } from "bowerbird-plugin-api";
import { applyColour } from "./apply.js";
import { isHex, normaliseHex } from "./color.js";
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
let picked = "#007AFF";
let palettesEl: HTMLDivElement | null = null;
let pickedSwatch: HTMLButtonElement | null = null;
let pickedInput: HTMLInputElement | null = null;
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
    if (isHex(pen)) picked = normaliseHex(pen) as string;
  }
}

export function clearPanel(): void {
  api = null;
  store = emptyStore();
  palettesEl = null;
  pickedSwatch = null;
  pickedInput = null;
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

function setPicked(hex: string): void {
  const normalised = normaliseHex(hex);
  if (!normalised) return;
  picked = normalised;
  if (pickedSwatch) {
    pickedSwatch.style.background = picked;
    pickedSwatch.dataset.hex = picked;
    pickedSwatch.title = picked;
  }
  if (pickedInput && pickedInput.value !== picked) pickedInput.value = picked;
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
      if (result?.sRGBHex) setPicked(result.sRGBHex);
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
  fallback.value = picked;
  fallback.style.cssText = "position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;";
  eyeDropperFallbackOnInput = () => setPicked(fallback.value);
  fallback.addEventListener("input", eyeDropperFallbackOnInput);
  fallback.addEventListener("change", () => removeEyeDropperFallback(), { once: true });
  eyeDropperFallback = fallback;
  document.body.appendChild(fallback);
  fallback.click();
}

function iconButton(label: string, title: string, text: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "col-icon-btn";
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", label);
  return b;
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
    const up = iconButton("Move palette up", "Move up", "↑");
    up.disabled = index === 0;
    up.addEventListener("click", () => updateStore(movePalette(store, index, -1)));
    const down = iconButton("Move palette down", "Move down", "↓");
    down.disabled = index === store.palettes.length - 1;
    down.addEventListener("click", () => updateStore(movePalette(store, index, 1)));
    const del = iconButton("Delete palette", "Delete palette", "×");
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
      x.textContent = "×";
      x.title = "Remove colour";
      x.setAttribute("aria-label", `Remove ${hex}`);
      x.addEventListener("click", () => updateStore(removeColour(store, index, j)));
      tileWrap.append(tile, x);
      row.appendChild(tileWrap);
    });
    wrap.appendChild(row);
    const addRow = document.createElement("div");
    addRow.className = "col-add-row";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "col-btn";
    add.textContent = "Add picked colour";
    add.addEventListener("click", () => updateStore(addColour(store, index, picked)));
    addRow.appendChild(add);
    wrap.appendChild(addRow);
    list.appendChild(wrap);
  });
}

export function renderPanel(container: HTMLElement): void {
  const a = api;
  if (!a) return;
  container.innerHTML = "";
  const pickedRow = document.createElement("div");
  pickedRow.className = "col-picked-row";
  pickedSwatch = document.createElement("button");
  pickedSwatch.type = "button";
  pickedSwatch.className = "col-picked";
  pickedSwatch.style.background = picked;
  pickedSwatch.dataset.hex = picked;
  pickedSwatch.title = picked;
  pickedSwatch.setAttribute("aria-label", "Picked colour");
  pickedSwatch.addEventListener("click", () => {
    if (api) applyColour(api, picked);
  });
  attachPlaceDrag(a, pickedSwatch);
  pickedRow.appendChild(pickedSwatch);
  const hexLabel = document.createElement("label");
  hexLabel.className = "col-hex-label";
  hexLabel.textContent = "Hex";
  pickedRow.appendChild(hexLabel);
  pickedInput = document.createElement("input");
  pickedInput.className = "col-hex-input";
  pickedInput.type = "text";
  pickedInput.value = picked;
  pickedInput.spellcheck = false;
  pickedInput.setAttribute("aria-label", "Picked colour hex");
  // Without this, keys pressed while the input is focused
  // leak to the core handler: +/- zoom, 0 resets the camera,
  // Delete deletes the selection.
  pickedInput.addEventListener("keydown", (e) => e.stopPropagation());
  pickedInput.addEventListener("change", () => {
    if (!pickedInput) return;
    const hex = normaliseHex(pickedInput.value);
    if (hex) setPicked(hex);
    else pickedInput.value = picked;
  });
  pickedRow.appendChild(pickedInput);
  const pickerBtn = document.createElement("button");
  pickerBtn.type = "button";
  pickerBtn.className = "col-picker-btn";
  pickerBtn.title = "Pick a colour from the screen";
  pickerBtn.setAttribute("aria-label", "Pick a colour from the screen");
  pickerBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.5 19.5 9.5 9 20H4v-5L14.5 4.5Z" /><path d="M13 6l5 5" /><path d="M18 3l3 3" /></svg>';
  pickerBtn.addEventListener("click", () => void pickWithEyeDropper());
  pickedRow.appendChild(pickerBtn);
  container.appendChild(pickedRow);
  const createRow = document.createElement("div");
  createRow.className = "col-create-row";
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "col-btn";
  newBtn.textContent = "New palette";
  newBtn.addEventListener("click", () => updateStore(createPalette(store).store));
  const penBtn = document.createElement("button");
  penBtn.type = "button";
  penBtn.className = "col-btn";
  penBtn.textContent = "From pen colour";
  penBtn.addEventListener("click", () => {
    if (api && api.pen) updateStore(createPalette(store, [api.pen.getColor()]).store);
  });
  const pickedBtn = document.createElement("button");
  pickedBtn.type = "button";
  pickedBtn.className = "col-btn";
  pickedBtn.textContent = "New from picked";
  pickedBtn.addEventListener("click", () => updateStore(createPalette(store, [picked]).store));
  createRow.append(newBtn, penBtn, pickedBtn);
  container.appendChild(createRow);
  palettesEl = document.createElement("div");
  palettesEl.className = "col-palettes";
  container.appendChild(palettesEl);
  renderPalettes();
}
