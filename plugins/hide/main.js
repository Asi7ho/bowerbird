// Hide — bundled Bowerbird plugin (see PLUGIN_API.md).
// This used to be core code: a floating button in a corner of the
// board, a corner picker in Settings, and H to minimise. It moved
// here so the Plugin API has to prove it can handle a window-level
// feature, not just cards and panels.
//
// What stays in the core, because a renderer plugin cannot do it:
// hiding the window, showing the peek icon, and remembering the
// corner for the peek (electron/main.js, collapse/restore/peek,
// and the corner setting file). Everything the user sees — the
// button, its drag-to-move behaviour, the corner picker, the H
// shortcut — lives in this file and talks to the core only through
// api.window, api.board and api.ui.
const CORNERS = ["bottom-left", "bottom-right", "top-left", "top-right", "off"];
const OPTIONS = [
  ["Bottom-left", "bottom-left"],
  ["Bottom-right", "bottom-right"],
  ["Top-left", "top-left"],
  ["Top-right", "top-right"],
  ["Off", "off"],
];

let apiRef = null;
let corner = "bottom-left";
let button = null;
let dragged = false;

function positionButton() {
  if (!button) return;
  button.className = `hide-button corner-${corner}`;
  button.title = corner === "off"
    ? "Corner is off"
    : `Drag to move the window, click to hide into the ${corner.replace("-", " ")} corner`;
  button.setAttribute("aria-label", button.title);
  button.style.display = corner === "off" ? "none" : "";
}

function createButton(container) {
  button = document.createElement("button");
  button.style.pointerEvents = "auto";
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14" /><path d="M12 19h7v-7" /></svg>`;
  container.appendChild(button);
  positionButton();

  // Drag handle, same logic the core used to own: screen
  // coordinates, not client coordinates, so a window move does
  // not feed back into itself and shake. Past 5px it is a drag,
  // and the following click is suppressed, so a drag never
  // collapses on release.
  button.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragged = false;
    let lastX = e.screenX, lastY = e.screenY;
    let moved = 0;
    const onMove = (me) => {
      const dx = me.screenX - lastX, dy = me.screenY - lastY;
      lastX = me.screenX; lastY = me.screenY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 5) {
        dragged = true;
        if (dx !== 0 || dy !== 0) apiRef.window.move(dx, dy);
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dragged) { dragged = false; return; }
    // Same order the core used: commit any note being edited,
    // save, then hide. Without the commit, an edit open at hide
    // time would stay uncommitted in the board JSON.
    apiRef.board.commitEditing();
    apiRef.board.save();
    apiRef.window.hide().catch(() => undefined);
  });
}

function renderSettings(container) {
  container.innerHTML = "";
  const intro = document.createElement("p");
  intro.className = "meta";
  intro.textContent = "Drag the corner button to move the window, click it to hide into the corner.";
  container.appendChild(intro);
  const opts = document.createElement("div");
  opts.className = "canvas-opt";
  for (const [label, value] of OPTIONS) {
    const b = document.createElement("button");
    b.textContent = label;
    if (corner === value) b.classList.add("active");
    b.addEventListener("click", async () => {
      try { corner = await apiRef.window.setCorner(value); } catch { /* keep old corner */ }
      positionButton();
      for (const sib of opts.querySelectorAll("button")) {
        sib.classList.toggle("active", sib === b && corner === value);
      }
    });
    opts.appendChild(b);
  }
  container.appendChild(opts);
  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = "The board hides into this corner, and clicking its corner opens it again.";
  container.appendChild(note);
}

export async function activate(api) {
  apiRef = api;
  // Load the stored corner before registering, so the button's
  // first position and the settings section's active button are
  // correct, not just the default.
  try {
    const c = await api.window.getCorner();
    if (CORNERS.includes(c)) corner = c;
  } catch { /* default stands */ }

  api.ui.registerOverlay({
    id: "corner-button",
    render: (container) => createButton(container),
  });
  api.ui.registerSettingsSection({
    id: "corner",
    title: "Hide",
    render: (container) => renderSettings(container),
  });
  api.ui.registerShortcut({
    key: "h",
    title: "Hide the board (minimise)",
    run: () => { api.window.minimise().catch(() => undefined); },
  });
}

export function deactivate() {
  // The core removes the overlay, the settings section and the
  // shortcut on deactivate. Button listeners die with the removed
  // overlay DOM.
  apiRef = null;
  button = null;
}
