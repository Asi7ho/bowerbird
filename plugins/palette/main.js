// Palette — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// A colour wheel, not a fixed palette list. Pick a colour
// on the wheel and five palettes are made from it, live,
// following colour theory — no fixed palettes, no network,
// no storage.
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
//
// Palettes, each five colours, in order:
//   Monochromatic — same hue, lightness steps, dark to
//     light. Steps are -24, -12, 0, +12, +24 lightness,
//     shifted as a whole to fit 5–95% so no two steps
//     collapse to the same colour at the extremes.
//   Analogous — hues -30, -15, 0, +15, +30, same
//     saturation and lightness: colours next to each
//     other on the wheel.
//   Complementary — opposite colours, then tints and
//     a shade to fill five: base, opposite, base light,
//     opposite light, base dark.
//   Split complementary — base, opposite +30, opposite
//     -30 (that is, +150 and +210), then tints of the
//     first two: base light, +150 light.
//   Triadic — base, +120, +240, then tints of the first
//     two: base light, +120 light.
// Saturation never changes inside a palette; only hue
// (by harmony) and lightness (by tint, shade, or the
// monochromatic steps) do, so a palette stays harmonious
// instead of drifting muddy. Lightness is clamped to
// 5–95% so a swatch is never pure black or pure white.
// The preview swatch itself places the picked colour, so
// the exact picked colour is always placeable even when
// it is not in a palette (for example at the lightness
// extremes, where a monochromatic palette is shifted).
//
// Click a tile or the preview to place a 120x120 swatch
// at the camera centre. Drag a tile or the preview to
// place it at the drop point, centred there, the same
// interaction as Visual Library. A placed swatch is an
// ordinary board item of kind Swatch, not a plugin card,
// so it survives disabling the plugin.
//
// Board geometry lives in #board now, below the title bar:
// its client size is the visible board, and its top edge is
// the board's origin in client coordinates. Centre and drop
// points go through it, never window size or raw client
// coordinates, or a swatch lands 48px low.
let apiRef = null;

// Default: the welcome board's blue, #007AFF (hue 211.3,
// saturation 100%, lightness 50% — the hue is fractional
// because #007AFF does not sit on an integer hue).
let baseH = 211.3;
let baseS = 100;
let baseL = 50;

let wheelCanvas = null;
let wheelMarker = null;
let previewSwatch = null;
let previewHex = null;
let lightnessSlider = null;
let lightnessValue = null;
let palettesEl = null;
let paletteTiles = [];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapHue = (h) => ((h % 360) + 360) % 360;

function hslToHex(h, s, l) {
  h = wrapHue(h);
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 5, 95) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function palettesFor(h, s, l) {
  const col = (dh, dl) => hslToHex(h + dh, s, l + dl);
  // Monochromatic: lightness steps, shifted to fit 5–95.
  const steps = [-24, -12, 0, 12, 24].map((dl) => l + dl);
  const lo = Math.min(...steps), hi = Math.max(...steps);
  const shift = lo < 5 ? 5 - lo : hi > 95 ? 95 - hi : 0;
  const mono = steps.map((v) => hslToHex(h, s, v + shift));
  return [
    { name: "Monochromatic", desc: "Same colour, different lightness.", colors: mono },
    { name: "Analogous", desc: "Colours next to each other on the wheel.", colors: [-30, -15, 0, 15, 30].map((dh) => col(dh, 0)) },
    { name: "Complementary", desc: "Opposite colours.", colors: [col(0, 0), col(180, 0), col(0, 15), col(180, 15), col(0, -15)] },
    { name: "Split complementary", desc: "Opposite, split in two.", colors: [col(0, 0), col(150, 0), col(210, 0), col(0, 15), col(150, 15)] },
    { name: "Triadic", desc: "Three colours, evenly spaced.", colors: [col(0, 0), col(120, 0), col(240, 0), col(0, 15), col(120, 15)] },
  ];
}

function boardGeometry() {
  const el = document.getElementById("board");
  if (!el) return { w: window.innerWidth, h: window.innerHeight, left: 0, top: 0 };
  const r = el.getBoundingClientRect();
  return { w: el.clientWidth, h: el.clientHeight, left: r.left, top: r.top };
}

function cameraCentreWorld() {
  const cam = apiRef.view.getCamera();
  const b = boardGeometry();
  return { x: cam.x + b.w / 2 / cam.zoom, y: cam.y + b.h / 2 / cam.zoom };
}

function dropWorld(clientX, clientY) {
  const cam = apiRef.view.getCamera();
  const b = boardGeometry();
  return { x: (clientX - b.left) / cam.zoom + cam.x, y: (clientY - b.top) / cam.zoom + cam.y };
}

function placeAt(hex, point) {
  if (!apiRef) return;
  apiRef.board.addItem({ Swatch: { hex } }, { x: point.x - 60, y: point.y - 60 }, { w: 120, h: 120 });
}

function attachPlaceInteractions(el) {
  // The colour is read from the element at click/drop time,
  // not captured when the handler is attached, so updating
  // a tile's colour never needs its handlers re-attached.
  el.addEventListener("click", () => {
    if (el.dataset.hex) placeAt(el.dataset.hex, cameraCentreWorld());
  });
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !el.dataset.hex) return;
    const hex = el.dataset.hex;
    let moved = false;
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost = null;
    const onMove = (me) => {
      if (!moved && Math.hypot(me.clientX - startX, me.clientY - startY) > 5) {
        moved = true;
        ghost = document.createElement("div");
        ghost.className = "pal-ghost";
        ghost.style.background = hex;
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = `${me.clientX + 12}px`;
        ghost.style.top = `${me.clientY + 12}px`;
      }
    };
    const onUp = (me) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (ghost) ghost.remove();
      if (!moved) return;
      // A drop onto the visible board places the swatch.
      // A drop back onto any UI cancels.
      const target = document.elementFromPoint(me.clientX, me.clientY);
      if (!target) return;
      if (target.closest && (target.closest(".plugin-panel") || target.closest("#toolbar") || target.closest("#title-bar") || target.closest("#settings-backdrop") || target.closest("#view-switcher") || target.closest(".plugin-tabs"))) return;
      placeAt(hex, dropWorld(me.clientX, me.clientY));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function drawWheel() {
  if (!wheelCanvas) return;
  const size = wheelCanvas.width;
  const ctx = wheelCanvas.getContext("2d");
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

function updateAll() {
  const hex = hslToHex(baseH, baseS, baseL);
  if (previewSwatch) {
    previewSwatch.style.background = hex;
    previewSwatch.dataset.hex = hex;
    previewSwatch.title = hex;
  }
  if (previewHex) previewHex.textContent = hex;
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

function pickFromWheel(clientX, clientY) {
  if (!wheelCanvas) return;
  const rect = wheelCanvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = clientX - cx, dy = clientY - cy;
  const radius = rect.width / 2;
  const r = Math.min(1, Math.hypot(dx, dy) / radius);
  baseH = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
  baseS = r * 100;
  updateAll();
}

function renderPanel(container) {
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
  attachPlaceInteractions(previewSwatch);
  previewRow.appendChild(previewSwatch);
  previewHex = document.createElement("div");
  previewHex.className = "pal-hex";
  previewRow.appendChild(previewHex);
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
  lightnessSlider = document.createElement("input");
  lightnessSlider.className = "pal-slider";
  lightnessSlider.type = "range";
  lightnessSlider.min = "0";
  lightnessSlider.max = "100";
  lightnessSlider.value = String(Math.round(baseL));
  lightnessSlider.setAttribute("aria-label", "Lightness");
  lightnessSlider.addEventListener("input", () => {
    baseL = Number(lightnessSlider.value);
    updateAll();
  });
  wheelSection.appendChild(lightnessSlider);
  container.appendChild(wheelSection);

  palettesEl = document.createElement("div");
  palettesEl.className = "pal-sections";
  paletteTiles = [];
  for (const palette of palettesFor(baseH, baseS, baseL)) {
    const wrap = document.createElement("div");
    wrap.className = "pal-palette";
    const head = document.createElement("div");
    head.className = "pal-head";
    head.textContent = palette.name;
    wrap.appendChild(head);
    const desc = document.createElement("div");
    desc.className = "pal-desc";
    desc.textContent = palette.desc;
    wrap.appendChild(desc);
    const row = document.createElement("div");
    row.className = "pal-row";
    for (let i = 0; i < 5; i++) {
      const tile = document.createElement("button");
      tile.className = "pal-tile";
      attachPlaceInteractions(tile);
      paletteTiles.push(tile);
      row.appendChild(tile);
    }
    wrap.appendChild(row);
    palettesEl.appendChild(wrap);
  }
  container.appendChild(palettesEl);

  drawWheel();
  updateAll();

  const onPointerDown = (e) => {
    pickFromWheel(e.clientX, e.clientY);
    const onMove = (me) => pickFromWheel(me.clientX, me.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  wheelWrap.addEventListener("pointerdown", onPointerDown);
  wheelWrap._palPointerDown = onPointerDown;
}

function activate(api) {
  apiRef = api;
  apiRef.ui.registerPanel({
    id: "palette",
    title: "Palette",
    // Colour-wheel dots, hue round the wheel as in the
    // panel itself: red at the top, clockwise through
    // orange, yellow, green, blue and purple.
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4.5" r="2.8" fill="#FF3B30"/><circle cx="18.5" cy="8.25" r="2.8" fill="#FF9500"/><circle cx="18.5" cy="15.75" r="2.8" fill="#FFCC00"/><circle cx="12" cy="19.5" r="2.8" fill="#34C759"/><circle cx="5.5" cy="15.75" r="2.8" fill="#007AFF"/><circle cx="5.5" cy="8.25" r="2.8" fill="#AF52DE"/></svg>',
    render: (container) => renderPanel(container),
  });
}

function deactivate() {
  wheelCanvas = null;
  wheelMarker = null;
  previewSwatch = null;
  previewHex = null;
  lightnessSlider = null;
  lightnessValue = null;
  palettesEl = null;
  paletteTiles = [];
  apiRef = null;
}

export { activate, deactivate };
