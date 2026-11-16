// UI components: the reusable pieces, so a new control gets
// the app style by construction instead of by remembering a
// CSS rule. A bare <button> falls back to the browser
// default, and a per-id or per-context rule is how a new
// control ships unstyled — so every control is one of the
// classes in styles.css, and this module is the one place
// that builds them. Use the helper when building DOM in
// code; use the class directly in an HTML template string.
//
// The kit, by family:
// - Buttons: createButton (.btn), createIconButton
//   (.icon-btn), createSwatch (.swatch), createPickerOption
//   (.picker-option), createSegButton (.seg-btn).
// - Surfaces: .frosted (material), .palette, .dialog +
//   .dialog-backdrop, .card, .segmented — classes only,
//   each instance sets its own size and position.
// - Text & inputs: .meta, .text-field, .kbd,
//   .search-field — classes only.
// - Layout: .row, .divider, .toast — classes only.
// - Navigation: .tab, .plugin-tab — classes only.
//
// Variants for createButton:
//   neutral (default) — a plain action: white, hairline
//     border, 9px radius, 13px/600. Send feedback, Export,
//     Import, Restore, Open folder, Enable, Disable.
//   danger — an action that undoes work: same shape, red
//     text. Factory reset, Reset plugins.
//   danger-filled — the confirm step of a destructive
//     action: red background, white text. Reset everything.
// Large — 8px 16px instead of 6px 12px, for the
// destructive buttons, which read bigger.
// Armed — the confirm state: red text and red border, a
// deliberate second click, not a toggle. Confirm restore,
// Disable anyway.
export type ButtonVariant = "neutral" | "danger" | "danger-filled";

export interface ButtonOptions {
  id?: string;
  variant?: ButtonVariant;
  large?: boolean;
  armed?: boolean;
  onClick?: () => void;
}

export function createButton(label: string, opts: ButtonOptions = {}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.classList.add("btn");
  if (opts.large) btn.classList.add("btn-lg");
  if (opts.variant === "danger") btn.classList.add("btn-danger");
  if (opts.variant === "danger-filled") btn.classList.add("btn-danger-filled");
  if (opts.armed) btn.classList.add("armed");
  if (opts.id) btn.id = opts.id;
  if (opts.onClick) btn.addEventListener("click", opts.onClick);
  return btn;
}

// An icon button: a square button with a centred icon.
// 40px by default (the toolbar tools); small is 32px
// (title bar, dock tabs). The icon is an SVG string, stroked
// in currentColor by the .icon-btn svg rule. Active is white
// with the toolbar shadow; dim is unavailable (opacity 0.35,
// no hover).
export interface IconButtonOptions {
  id?: string;
  small?: boolean;
  title?: string;
  label?: string;
  active?: boolean;
  dim?: boolean;
  text?: string;
  onClick?: () => void;
}

export function createIconButton(icon: string, opts: IconButtonOptions = {}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.classList.add("icon-btn");
  if (opts.small) btn.classList.add("icon-btn-sm");
  if (opts.active) btn.classList.add("active");
  if (opts.dim) btn.classList.add("dim");
  if (opts.id) btn.id = opts.id;
  if (opts.title) btn.title = opts.title;
  if (opts.label) btn.setAttribute("aria-label", opts.label);
  if (opts.text !== undefined) btn.textContent = opts.text;
  else btn.innerHTML = icon;
  if (opts.onClick) btn.addEventListener("click", opts.onClick);
  return btn;
}

// A colour swatch: a 22px circle in the given colour.
// Active is 26px with an accent ring. The colour is the
// background, set inline.
export function createSwatch(hex: string, opts: { active?: boolean; onClick?: () => void } = {}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.classList.add("swatch");
  btn.style.background = hex;
  btn.title = hex;
  btn.setAttribute("aria-label", hex);
  btn.setAttribute("aria-pressed", String(!!opts.active));
  if (opts.active) btn.classList.add("active");
  if (opts.onClick) btn.addEventListener("click", opts.onClick);
  return btn;
}

// An option inside a palette: a 36px icon button. Active is
// white with the toolbar shadow. The icon is an SVG string.
export function createPickerOption(icon: string, opts: { title?: string; label?: string; active?: boolean; dataset?: Record<string, string>; onClick?: () => void } = {}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.classList.add("picker-option");
  if (opts.active) btn.classList.add("active");
  if (opts.title) btn.title = opts.title;
  if (opts.label) btn.setAttribute("aria-label", opts.label);
  if (opts.dataset) for (const [k, v] of Object.entries(opts.dataset)) btn.dataset[k] = v;
  btn.innerHTML = icon;
  if (opts.onClick) btn.addEventListener("click", opts.onClick);
  return btn;
}

// A segmented text button: one choice in a segmented
// control (the shape picker's Filled/Outline switch, the
// view switcher). Small is the 11px, 64x28 one. Active is
// a white pill with the toolbar shadow and ink text.
export function createSegButton(label: string, opts: { small?: boolean; active?: boolean; onClick?: () => void } = {}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.classList.add("seg-btn");
  if (opts.small) btn.classList.add("seg-btn-sm");
  if (opts.active) btn.classList.add("active");
  btn.textContent = label;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  if (opts.onClick) btn.addEventListener("click", opts.onClick);
  return btn;
}
