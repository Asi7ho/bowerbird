// Hide — the corner picker in Settings. A segmented control of
// text buttons (see style.css): the active corner is a white pill
// on the grey track, the rest dimmed labels, so which corner is
// active is obvious at a glance.
import type { PluginContext } from "../../src/plugins";
import { CORNERS, OPTIONS, getCorner, setCorner } from "./corner.js";
import type { Corner } from "./corner.js";
import { positionButton } from "./button.js";

export function renderSettings(api: PluginContext, container: HTMLElement): void {
  container.innerHTML = "";
  const desc = document.createElement("p");
  desc.className = "meta";
  desc.textContent = "The corner the board hides into.";
  container.appendChild(desc);
  const opts = document.createElement("div");
  opts.className = "hide-opt";
  for (const [label, value] of OPTIONS) {
    const b = document.createElement("button");
    b.textContent = label;
    if (getCorner() === value) b.classList.add("active");
    b.addEventListener("click", async () => {
      try {
        const next = await api.window.setCorner(value);
        if ((CORNERS as readonly string[]).includes(next)) setCorner(next as Corner);
      } catch {
        // Keep the old corner.
      }
      positionButton();
      for (const sib of opts.querySelectorAll("button")) {
        sib.classList.toggle("active", sib === b && getCorner() === value);
      }
    });
    opts.appendChild(b);
  }
  container.appendChild(opts);
}
