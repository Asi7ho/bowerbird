// Colour Library — the colour wheel. Hue round the wheel,
// saturation centre to edge, drawn on a canvas at
// lightness 50%, pixel by pixel in HSL, like the old
// Palette panel's wheel: a conic-gradient with a white
// overlay would show light pinks where the picked colour
// is a muted red, which is wrong for a colour tool. The
// caller owns the picked colour; the wheel only reports
// picks (hue, saturation) and moves its marker.
export interface WheelHandle {
  element: HTMLElement;
  setMarker: (h: number, s: number) => void;
}

// The wheel pixels, cached by canvas size: the wheel is
// drawn at fixed lightness 50% and never depends on
// state, so the pixels are identical every time.
let wheelPixels: { size: number; data: ImageData } | null = null;

export function createWheel(onPick: (h: number, s: number) => void, onSettle?: () => void, onPickStart?: () => void): WheelHandle {
  const wrap = document.createElement("div");
  wrap.className = "col-wheel-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "col-wheel";
  const cssSize = 180;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  canvas.setAttribute("aria-label", "Colour wheel: hue round the wheel, saturation from centre to edge");
  wrap.appendChild(canvas);
  const marker = document.createElement("div");
  marker.className = "col-marker";
  wrap.appendChild(marker);

  const drawWheel = (): void => {
    const size = canvas.width;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (wheelPixels && wheelPixels.size === size) {
      ctx.putImageData(wheelPixels.data, 0, 0);
      return;
    }
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
        // HSL at lightness 50%, converted inline (same
        // maths as hslToHex, without the hex step).
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
    wheelPixels = { size, data: img };
  };

  const pickFromWheel = (clientX: number, clientY: number): void => {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx, dy = clientY - cy;
    const radius = rect.width / 2;
    const r = Math.min(1, Math.hypot(dx, dy) / radius);
    onPick((Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360, r * 100);
  };

  const setMarker = (h: number, s: number): void => {
    const rect = canvas.getBoundingClientRect();
    const radius = rect.width / 2;
    const angle = (h - 90) * Math.PI / 180;
    const r = (s / 100) * radius;
    marker.style.left = `${radius + r * Math.cos(angle)}px`;
    marker.style.top = `${radius + r * Math.sin(angle)}px`;
  };

  wrap.addEventListener("pointerdown", (e: PointerEvent) => {
    // The drag starts here, before the first pick, so
    // the caller can brighten its preview for the drag.
    onPickStart?.();
    pickFromWheel(e.clientX, e.clientY);
    // Pointermove fires faster than a full panel update
    // costs, and each one reads layout twice: coalesce
    // to one pick per animation frame.
    let raf = 0;
    let latestX = e.clientX;
    let latestY = e.clientY;
    const onMove = (me: PointerEvent): void => {
      latestX = me.clientX;
      latestY = me.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        pickFromWheel(latestX, latestY);
      });
    };
    // A drag ending outside the window fires pointercancel,
    // not pointerup: without it the listeners linger and the
    // next drag adds a second pair. The release is also the
    // settle point: the picked colour is recorded there,
    // not on the pointermove ticks of the drag.
    const onUp = (): void => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      onSettle?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  });

  drawWheel();
  return { element: wrap, setMarker };
}
