// The title bar is a first-party plugin (core-titlebar):
// it builds the frameless window's title bar — window
// controls, app name, undo/redo, and the panels toggle —
// plus the empty search box the core-search plugin mounts
// into. It uses only the public API: window controls via
// api.window, undo/redo via api.board, the platform via
// api.app, and the panels toggle + search box through the
// shell (registerShellElements / setSearchBoxEl), the same
// way the toolbar plugin provides the tools segment.
//
// The DOM uses the same ids and classes as the old static
// title bar, so src/styles.css applies unchanged, and the
// window controls are drawn the way the OS the app is
// running on draws them — macOS traffic lights on the
// left, Windows caption buttons on the right, GNOME-style
// round buttons on the right on Linux (see the per-platform
// CSS). The platform comes from the preload bridge, with
// a user-agent fallback, and the group is moved to the
// right-hand actions only on non-macOS platforms; on macOS
// it stays at the far left. Close quits the app (commit,
// save, then quit, which destroys the peek window too),
// minimise minimises, full screen toggles full screen on
// macOS, maximise toggles maximise on Windows/Linux. The
// buttons opt out of the title bar's drag region in CSS,
// so a click acts instead of moving the window.
import type { PluginContext, PluginManifest } from "../plugins";

export const manifest: PluginManifest = {
  id: "core-titlebar",
  name: "Title Bar",
  description: "Window controls, app name, undo/redo and the search box.",
  version: "1.0.0",
  apiVersion: "2",
  main: "titlebar.js",
  permissions: ["board:read", "board:write", "window"],
};

let bar: HTMLElement | null = null;
let controls: HTMLElement | null = null;
let actions: HTMLElement | null = null;
let winFullscreen: HTMLButtonElement | null = null;
let winMaximise: HTMLButtonElement | null = null;

const syncWindowState = async (api: PluginContext): Promise<void> => {
  try {
    const state = await api.window.getWindowState();
    winMaximise?.classList.toggle("is-maximised", state.maximised);
    winFullscreen?.classList.toggle("is-fullscreen", state.fullscreen);
  } catch { /* icons keep their last state */ }
};

export function activate(api: PluginContext): void {
  bar = document.createElement("div");
  bar.id = "title-bar";
  bar.innerHTML = `
    <div id="title-bar-left">
      <div id="window-controls" aria-label="Window controls">
        <button id="win-close" class="win-close" title="Close" aria-label="Close"><svg class="icon-mac" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8" /></svg><svg class="icon-os" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" /></svg></button>
        <button id="win-minimise" class="win-minimise" title="Minimise" aria-label="Minimise"><svg class="icon-mac" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6" /></svg><svg class="icon-os" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h10" /></svg></button>
        <button id="win-fullscreen" class="win-fullscreen" title="Full screen" aria-label="Full screen"><svg class="icon-enter" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 7.5L7.5 2.5M5.5 2.5H7.5V4.5M4.5 7.5H2.5V5.5" /></svg><svg class="icon-exit" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5L7.5 7.5M5.5 7.5H7.5V5.5M4.5 2.5H2.5V4.5" /></svg></button>
        <button id="win-maximise" class="win-maximise" title="Maximise" aria-label="Maximise"><svg class="icon-maximise" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" /></svg><svg class="icon-restore" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7H6z" /><path d="M3 6h7v7H3z" fill="#fff" /></svg></button>
      </div>
      <span id="title-bar-name">Bowerbird</span>
      <div id="title-bar-undo">
        <button id="btn-undo" title="Undo (Ctrl / Cmd + Z)" aria-label="Undo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5 3.5 8.5 7 12" /><path d="M3.5 8.5H13a5.5 5.5 0 0 1 0 11H10" /></svg></button>
        <button id="btn-redo" title="Redo (Ctrl / Cmd + Shift + Z)" aria-label="Redo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 5l3.5 3.5L17 12" /><path d="M20.5 8.5H11a5.5 5.5 0 0 0 0 11h3" /></svg></button>
      </div>
    </div>
    <div id="search-box"></div>
    <div id="title-bar-actions">
      <button id="panels-toggle" title="Show or hide plugin panels" aria-label="Show or hide plugin panels"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg></button>
    </div>`;
  // The title bar sits above the board, inside the main
  // column: insert it immediately before the board element.
  api.ui.boardEl.insertAdjacentElement("beforebegin", bar);

  controls = bar.querySelector<HTMLElement>("#window-controls");
  actions = bar.querySelector<HTMLElement>("#title-bar-actions");
  winFullscreen = bar.querySelector<HTMLButtonElement>("#win-fullscreen");
  winMaximise = bar.querySelector<HTMLButtonElement>("#win-maximise");

  // The panels toggle and the search box are shell elements
  // the plugin system and the core-search plugin read: the
  // toggle is hidden when no plugin panels exist, and the
  // search plugin mounts its input into the box.
  const panelsToggle = bar.querySelector<HTMLElement>("#panels-toggle");
  if (panelsToggle) api.ui.setPanelsToggleEl(panelsToggle);
  const searchBox = bar.querySelector<HTMLElement>("#search-box");
  if (searchBox) api.ui.setSearchBoxEl(searchBox);

  // Platform: the group moves to the right-hand actions
  // only on non-macOS platforms; on macOS it stays at the
  // far left. The body class drives the per-platform CSS.
  const osPlatform = ((): "darwin" | "win32" | "linux" => {
    const p = api.app.getPlatform();
    if (p === "darwin" || p === "win32" || p === "linux") return p;
    const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
    if (ua === "macOS") return "darwin";
    if (ua === "Windows") return "win32";
    return "linux";
  })();
  document.body.classList.add(`platform-${osPlatform}`);
  if (osPlatform !== "darwin" && controls && actions) actions.appendChild(controls);

  bar.querySelector<HTMLButtonElement>("#btn-undo")?.addEventListener("click", () => { api.board.undo(); });
  bar.querySelector<HTMLButtonElement>("#btn-redo")?.addEventListener("click", () => { api.board.redo(); });

  bar.querySelector<HTMLButtonElement>("#win-close")?.addEventListener("click", async () => {
    api.board.commitEditing();
    api.board.save();
    api.window.close().catch(() => undefined);
  });
  bar.querySelector<HTMLButtonElement>("#win-minimise")?.addEventListener("click", () => {
    api.window.minimise().catch(() => undefined);
  });
  winFullscreen?.addEventListener("click", async () => {
    try {
      const fullscreen = await api.window.fullscreen();
      winFullscreen?.classList.toggle("is-fullscreen", fullscreen);
    } catch { /* state sync on resize will correct the icon */ }
  });
  winMaximise?.addEventListener("click", async () => {
    try {
      const maximised = await api.window.maximise();
      winMaximise?.classList.toggle("is-maximised", maximised);
    } catch { /* state sync on resize will correct the icon */ }
  });
  // A maximise or full screen done outside the buttons (an
  // OS shortcut, a snap) still has to flip the icon, so
  // re-read the real window state after resizes settle and
  // once at startup.
  let windowStateTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(() => { void syncWindowState(api); }, 200);
  });
  void syncWindowState(api);
}

export function deactivate(): void {
  bar?.remove();
  bar = null;
  controls = null;
  actions = null;
  winFullscreen = null;
  winMaximise = null;
}
