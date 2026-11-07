// Hide — the floating corner button. Click it to hide the board
// into the corner; the title bar moves the window, so the button
// is click-to-hide only now. It used to drag the window too.
import type { PluginContext } from "../../src/plugins";
import { getCorner } from "./corner.js";

let button: HTMLButtonElement | null = null;

export function positionButton(): void {
  if (!button) return;
  const corner = getCorner();
  button.className = `hide-button corner-${corner}`;
  button.title = corner === "off"
    ? "Corner is off"
    : `Click to hide into the ${corner.replace("-", " ")} corner`;
  button.setAttribute("aria-label", button.title);
  button.style.display = corner === "off" ? "none" : "";
}

export function createButton(api: PluginContext, container: HTMLElement): void {
  button = document.createElement("button");
  button.style.pointerEvents = "auto";
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14" /><path d="M12 19h7v-7" /></svg>`;
  container.appendChild(button);
  positionButton();

  // Click hides only. Moving the window is the title bar's
  // job now, so there is no drag tracking here and no
  // api.window.move call: a plain click hides, full stop.
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    // Same order the core used: commit any note being edited,
    // save, then hide. Without the commit, an edit open at hide
    // time would stay uncommitted in the board JSON.
    api.board.commitEditing();
    api.board.save();
    api.window.hide().catch(() => undefined);
  });
}

export function clearButton(): void {
  button = null;
}
