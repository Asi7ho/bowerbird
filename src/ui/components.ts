// UI components: the reusable pieces, so a new control gets
// the app style by construction instead of by remembering a
// CSS rule. A bare <button> falls back to the browser
// default, and a per-id rule is how a new button ships
// unstyled — so every action button is .btn, and this module
// is the one place that knows what that means.
//
// The button is the first component. More go here as they
// are extracted, following the same pattern: one class (or
// a small set of classes) in styles.css, and a helper here
// that builds the element with the class already on it.
//
// Variants:
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
