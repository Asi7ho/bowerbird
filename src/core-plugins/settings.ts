// core-settings: the Settings window as a first-party plugin.
//
// The settings window used to be core code (src/settings.ts plus
// static HTML in index.html). It is now a plugin, built on the
// public PluginContext only — the same API any third-party plugin
// uses. It builds its own DOM, registers itself as the settings
// UI (so the core can open/close it without knowing which plugin
// provides it), and hands the plugin system the container its
// plugin settings sections render into.
//
// It is a first-party plugin: an ES module bundled with the app,
// loaded with activateFirstPartyPlugin, under a manifest that
// declares the same permissions a user plugin would. It has no
// back door into the core. See ARCHITECTURE.md.
import type { PluginContext, PluginManifest } from "../plugins";

export const manifest: PluginManifest = {
  apiVersion: "2",
  id: "core-settings",
  name: "Settings",
  version: "1.0.0",
  description: "Shortcuts, canvas, data, backups, feedback and plugins.",
  main: "settings.js",
  permissions: ["board:read", "board:write", "plugins:install"],
  required: true,
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Feedback goes to the maker's inbox by email. There is no
// server and no account in the app: the message opens in the
// tester's own email app, addressed here, and they press Send
// there. The build id and platform ride along in the body so
// a report can be matched to the exact build that produced it.
const FEEDBACK_EMAIL = "wren7762@gmail.com";

function feedbackMailto(message: string, buildId: string, platform: string): string {
  const subject = "Bowerbird feedback";
  const body = `${message.trim()}\n\n—\nBowerbird ${buildId} on ${platform}`;
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

const SHORTCUTS: Array<[string, string]> = [
  ["V", "Select tool"],
  ["L", "Lasso tool"],
  ["P", "Pen tool"],
  ["A", "Arrow (connector) tool"],
  ["R", "Rectangle tool"],
  ["E", "Ellipse tool"],
  ["Delete / Backspace", "Delete the selection"],
  ["Ctrl / Cmd + Z", "Undo"],
  ["Ctrl / Cmd + Shift + Z", "Redo"],
  ["Ctrl / Cmd + Y", "Redo"],
  ["Ctrl / Cmd + G", "Group the selection"],
  ["Ctrl / Cmd + U", "Ungroup the selection"],
  ["[", "Rotate the selection −15°"],
  ["]", "Rotate the selection +15°"],
  ["+ / =", "Zoom in"],
  ["−", "Zoom out"],
  ["0", "Reset the view"],
  ["Ctrl / Cmd + scroll", "Zoom at the cursor"],
  ["Scroll", "Pan the canvas"],
  ["Space + drag", "Pan the canvas"],
  ["Ctrl / Cmd + ,", "Open settings"],
  ["Esc", "Close settings, commit a note, or clear the selection"],
  ["Tab", "Go to the next element"],
  ["Shift + Tab", "Go to the previous element"],
  ["Ctrl / Cmd + F", "Search the board"],
  ["Enter in search", "Jump to the next match"],
  ["Shift + Enter in search", "Jump to the previous match"],
  ["Arrow down / Ctrl + J in search", "Move to the next match"],
  ["Arrow up / Ctrl + K in search", "Move to the previous match"],
  ["Esc in search", "Clear the search"],
  ["Ctrl / Cmd + K", "Open the command palette"],
  ["Double-click empty space", "New note"],
  ["Double-click a note", "Edit it in place"],
  ["Click a link card", "Open it in your browser"],
  ["Double-click a link card", "Open it in your browser"],
  ["Double-click a PDF or picture", "Open it outside Bowerbird"],
  ["Click a play tile", "Play audio / video"],
  ["Drag a card corner", "Resize the card (nwse cursor on hover)"],
  ["Click the board's corner", "Open the board again"],
  ["Shift + click", "Add to the selection"],
  ["Drag on empty space", "Marquee-select"],
  ["Ctrl / Cmd + V", "Paste a link as a card"],
];

let api: PluginContext | null = null;
let backdrop: HTMLDivElement | null = null;
let settingsOpen = false;

function el<T extends HTMLElement>(id: string): T | null {
  return backdrop?.querySelector(`#${id}`) as T | null;
}

function setSettingsTab(tab: string): void {
  if (!backdrop) return;
  for (const btn of Array.from(backdrop.querySelectorAll("[data-settings-tab]"))) {
    (btn as HTMLElement).classList.toggle("active", (btn as HTMLElement).dataset.settingsTab === tab);
  }
  const sections: Record<string, string> = {
    general: "settings-section-general",
    plugins: "settings-section-plugins",
    "plugin-settings": "settings-section-plugin-settings",
  };
  for (const [key, id] of Object.entries(sections)) {
    const s = el(id);
    if (s) s.style.display = key === tab ? "" : "none";
  }
  const content = el("settings-content");
  if (content) content.scrollTop = 0;
}

function renderShortcutsTable(): void {
  if (!api) return;
  const table = el<HTMLTableElement>("shortcuts-table");
  if (!table) return;
  const allShortcuts: Array<[string, string]> = [...SHORTCUTS];
  for (const s of api.ui.listShortcuts()) allShortcuts.push([s.key.toUpperCase(), `${s.title} (${s.pluginName})`]);
  table.innerHTML = allShortcuts.map(([k, v]) => `<tr><td><kbd>${escapeHtml(k)}</kbd></td><td>${escapeHtml(v)}</td></tr>`).join("");
}

function renderBgOpts(): void {
  if (!api) return;
  // Previews, not text: each option is a swatch of the colour
  // itself, inside a button. The button is the control and the
  // swatch sits inside it, so the active option can use the
  // app's usual selected treatment — a white pill with a soft
  // shadow — and the colour stays visible. The name lives in
  // the tooltip and aria-label only. Colours are circles, the
  // way the toolbar's pen swatches are.
  const opts: Array<[string, string]> = [["White", "#FFFFFF"], ["Paper", "#F7F5F0"], ["Sage", "#EAF3EC"], ["Sky", "#E8F0F7"], ["Ink", "#1C1C1E"]];
  const container = el<HTMLDivElement>("bg-opts");
  if (!container) return;
  container.innerHTML = "";
  const currentBg = api.board.get().bg ?? "#FFFFFF";
  for (const [label, hex] of opts) {
    const b = document.createElement("button");
    b.title = label;
    b.setAttribute("aria-label", label);
    const sw = document.createElement("span");
    sw.className = "bg-swatch";
    sw.style.background = hex;
    b.appendChild(sw);
    if (currentBg.toUpperCase() === hex) b.classList.add("active");
    b.addEventListener("click", () => {
      api!.board.setCanvas({ bg: hex });
      api!.board.save();
      api!.board.render();
      renderBgOpts();
    });
    container.appendChild(b);
  }
}

function renderGridOpts(): void {
  if (!api) return;
  // Previews, not text: each option is a tile showing the
  // pattern itself — dots, lines, or blank for Off — inside a
  // button, the same shape as the colour options. The name
  // lives in the tooltip and aria-label only.
  const opts: Array<[string, string]> = [["Dots", "Dots"], ["Lines", "Lines"], ["Off", "Off"]];
  const container = el<HTMLDivElement>("grid-opts");
  if (!container) return;
  container.innerHTML = "";
  const currentGrid = api.board.get().grid ?? "Dots";
  for (const [label, mode] of opts) {
    const b = document.createElement("button");
    b.title = label;
    b.setAttribute("aria-label", label);
    const tile = document.createElement("span");
    tile.className = "grid-tile";
    if (mode === "Dots") tile.classList.add("grid-dots");
    if (mode === "Lines") tile.classList.add("grid-lines");
    b.appendChild(tile);
    if (currentGrid === mode) b.classList.add("active");
    b.addEventListener("click", () => {
      api!.board.setCanvas({ grid: mode as "Dots" | "Lines" | "Off" });
      api!.board.save();
      api!.board.render();
      renderGridOpts();
    });
    container.appendChild(b);
  }
}

async function renderBackups(): Promise<void> {
  if (!api) return;
  const container = el<HTMLDivElement>("backups-list");
  if (!container) return;
  let list: Array<{ name: string; items: number; size: number }> = [];
  try { list = await api.backups.list(); } catch { list = []; }
  if (list.length === 0) {
    container.innerHTML = `<p class="meta">No backups yet.</p>`;
    return;
  }
  const fmtSize = (n: number): string => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const fmtName = (n: string): string => {
    // Backup folders are YYYY-MM-DD-HHMMSS: show them as a date and time.
    const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(n);
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : n;
  };
  // Only the last backup is shown: listBackups is newest
  // first, so that is list[0]. Older backups are still
  // kept on disk, but they are not listed here.
  const b = list[0];
  container.innerHTML = "";
  const row = document.createElement("div");
  row.className = "backup-row";
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${fmtName(b.name)} · ${b.items} items · ${fmtSize(b.size)}`;
  const btn = document.createElement("button");
  btn.textContent = "Restore";
  let armed = false;
  btn.addEventListener("click", async () => {
    // Two-click confirm, like Delete all data: the first
    // click arms the button, the second restores. The app
    // never uses a native confirm dialog.
    if (!armed) {
      armed = true;
      btn.textContent = "Confirm restore?";
      btn.classList.add("armed");
      setTimeout(() => { if (btn.isConnected) { armed = false; btn.textContent = "Restore"; btn.classList.remove("armed"); } }, 4000);
      return;
    }
    const ok = await api!.backups.restore(b.name);
    if (ok) { setSettings(false); void renderBackups(); }
  });
  row.appendChild(meta);
  row.appendChild(btn);
  container.appendChild(row);
}

function renderPluginSettingsSections(): void {
  if (!api) return;
  api.ui.renderSettingsSections();
  const empty = el("plugin-settings-empty");
  const sections = el("plugin-settings-sections");
  if (empty && sections) empty.style.display = sections.children.length > 0 ? "none" : "";
}

// The plugin awaiting a disable confirmation, with how many
// of its cards are on the board. Disabling a plugin never
// deletes its cards — they stay on the board as placeholders
// ("Install the plugin to view this card. Your data is
// kept.") until it is re-enabled — but the user should know
// before they disable, not after, so a disable with cards
// on the board asks first instead of toggling straight off.
let confirmingDisable: { id: string; count: number; frames: number } | null = null;

// How many of a plugin's cards are on the board, and how
// many of those are frames. A frame hides when its plugin
// is disabled instead of showing a placeholder, so the
// warning can say so — the frame kinds come from the
// plugin's manifest, via plugins.list().
function countPluginCards(pluginId: string): { count: number; frames: number } {
  if (!api) return { count: 0, frames: 0 };
  const frameKinds = new Set(api.plugins.list().find((p) => p.id === pluginId)?.frameKinds ?? []);
  const cards = api.board.getItems().filter((it) => "Plugin" in it.kind && it.kind.Plugin.plugin === pluginId);
  return {
    count: cards.length,
    frames: cards.filter((it) => "Plugin" in it.kind && frameKinds.has(it.kind.Plugin.kind)).length,
  };
}

function renderPluginSettings(): void {
  if (!api) return;
  const list = el<HTMLDivElement>("plugin-list");
  if (!list) return;
  const plugins = api.plugins.list();
  if (plugins.length === 0) {
    list.innerHTML = `<p class="meta">No plugins found.</p>`;
    return;
  }
  // Two groups, core first: the core plugins build the app's
  // own UI (board, title bar, search, toolbar, cards,
  // settings); the extras are the bundled and installed
  // plugins. A heading per group, so the two are never
  // confused. The state is carried by the whole row, not by
  // one word: an active plugin has a filled dot and
  // full-strength text, an inactive one a hollow dot and
  // dimmed text, so active and inactive are told apart at a
  // glance, without reading. Failed and trial rows stay
  // full-strength, so their error and status stay readable.
  const renderRow = (lp: (typeof plugins)[number]): string => {
    // No state word: the dot and the dimming carry it. A
    // trial plugin is not installed yet, so it gets no
    // toggle; a failed plugin shows its error underneath.
    const off = !lp.active;
    let row = `<div class="plugin-row${off ? " plugin-row-off" : ""}"><span class="plugin-dot" aria-hidden="true"></span><div class="plugin-row-text"><div><strong>${escapeHtml(lp.name)}</strong></div>`;
    if (lp.description) row += `<p class="plugin-desc">${escapeHtml(lp.description)}</p>`;
    if (lp.failed && lp.error) row += `<p class="meta"><strong>${escapeHtml(lp.error)}</strong></p>`;
    // The disable warning: when this plugin is awaiting a
    // disable confirmation, say how many of its cards are on
    // the board and what will happen to them, so the user
    // decides with the consequence in front of them. Only an
    // active plugin can be confirming — an off plugin never
    // shows a disable confirm, whatever the stored state is.
    const confirming = lp.active && confirmingDisable?.id === lp.id ? confirmingDisable : null;
    if (confirming) {
      const noun = confirming.count === 1 ? "card" : "cards";
      // When every card is a frame, the cards hide rather
      // than showing as placeholders — say so, so the warning
      // describes what actually happens.
      const outcome = confirming.frames === confirming.count ? "will be hidden" : "will show as placeholders";
      row += `<p class="meta plugin-warn">${confirming.count} ${noun} on the board ${outcome} until you re‑enable this plugin.</p>`;
    }
    // A Settings button, when the plugin has a settings
    // section: it jumps to the Plugin settings tab and
    // scrolls to that plugin's section, so settings are
    // reachable from the plugin list, not only by tab.
    const sections = el("plugin-settings-sections");
    const hasSettings = sections?.querySelector(`[data-plugin="${lp.id}"]`) !== null;
    row += `</div><span style="display:flex;gap:8px;flex:none">`;
    if (lp.active && hasSettings) row += `<button data-plugin-settings="${lp.id}">Settings</button>`;
    // A required plugin has no toggle: it is the foundation
    // (board, Settings) and cannot be disabled, so there is
    // nothing to toggle. Every other plugin gets one. While
    // a disable is awaiting confirmation, the toggle reads
    // as the confirm ("Disable anyway") and is armed red,
    // like other confirm states.
    if (!lp.trial && !lp.required) {
      if (confirming) row += `<button data-plugin-toggle="${lp.id}" class="armed">Disable anyway</button></span>`;
      else row += `<button data-plugin-toggle="${lp.id}">${lp.active ? "Disable" : "Enable"}</button></span>`;
    } else row += `</span>`;
    row += `</div>`;
    return row;
  };
  const core = plugins.filter((lp) => lp.core);
  const extra = plugins.filter((lp) => !lp.core);
  let html = "";
  if (core.length > 0) html += `<h3>Core</h3>` + core.map(renderRow).join("");
  if (extra.length > 0) html += `<h3>Extra</h3>` + extra.map(renderRow).join("");
  // Reset: back to the factory state — core plugins on,
  // extras off. One button under the list; it is reversible
  // by toggling plugins back on.
  html += `<button id="plugins-reset">Reset plugins</button>`;
  list.innerHTML = html;
  el("plugins-reset")?.addEventListener("click", async () => {
    // Resetting turns every extra off at once, so a disable
    // confirmation left open on one of them no longer
    // applies — drop it, or the row would keep showing a
    // "Disable anyway" confirm on a plugin that is already off.
    confirmingDisable = null;
    await api!.plugins.reset();
    renderShortcutsTable();
    renderPluginSettingsSections();
    renderPluginSettings();
    api!.board.render();
  });
  for (const btn of Array.from(list.querySelectorAll("[data-plugin-settings]"))) {
    btn.addEventListener("click", () => {
      const id = (btn as HTMLElement).dataset.pluginSettings ?? "";
      setSettingsTab("plugin-settings");
      const section = backdrop?.querySelector(`#plugin-settings-sections [data-plugin="${id}"]`);
      if (section) section.scrollIntoView({ block: "start" });
    });
  }
  for (const btn of Array.from(list.querySelectorAll("[data-plugin-toggle]"))) {
    btn.addEventListener("click", async () => {
      const id = (btn as HTMLElement).dataset.pluginToggle ?? "";
      const lp = api!.plugins.list().find((x) => x.id === id);
      if (!lp) return;
      if (confirmingDisable?.id === id) {
        // The confirm click: the warning is already shown,
        // so disable now.
        confirmingDisable = null;
        await api!.plugins.setEnabled(id, false);
      } else if (lp.active) {
        // Disabling. If this plugin has cards on the board,
        // ask first instead of toggling straight off: the
        // row re-renders with the warning and a "Disable
        // anyway" confirm. A plugin with no cards on the
        // board disables at once, with nothing to warn about.
        // A confirm left open on another plugin is dropped
        // when this toggle is clicked.
        const { count, frames } = countPluginCards(id);
        if (count > 0) {
          confirmingDisable = { id, count, frames };
          renderPluginSettings();
          return;
        }
        confirmingDisable = null;
        await api!.plugins.setEnabled(id, false);
      } else {
        // Enabling: no warning, the cards come back.
        confirmingDisable = null;
        await api!.plugins.setEnabled(id, true);
      }
      renderShortcutsTable();
      renderPluginSettingsSections();
      renderPluginSettings();
      api!.board.render();
    });
  }
}

function setSettings(open: boolean): void {
  if (!backdrop || !api) return;
  settingsOpen = open;
  backdrop.classList.toggle("open", open);
  // A disable confirmation left open is dropped when the
  // sheet closes, so it is not still armed next time.
  if (!open) confirmingDisable = null;
  if (open) {
    const confirmEl = el<HTMLDivElement>("reset-confirm");
    const resetBtn = el<HTMLButtonElement>("btn-reset");
    if (confirmEl) confirmEl.style.display = "none";
    if (resetBtn) resetBtn.style.display = "";
    const boardDirEl = el("board-dir-meta");
    if (boardDirEl) boardDirEl.textContent = `Board folder: ${api.board.getDir()}`;
    const buildEl = el("build-meta");
    if (buildEl) buildEl.textContent = `Build: ${api.app.getBuildId()}`;
    renderShortcutsTable();
    renderBgOpts();
    renderGridOpts();
    void renderBackups();
    renderPluginSettingsSections();
    renderPluginSettings();
    setSettingsTab("general");
  }
  api.board.render();
}

function refresh(): void {
  // After an undo changed the board, the canvas options (and
  // meta) must match the board again, if Settings is open.
  renderBgOpts();
  renderGridOpts();
  const boardDirEl = el("board-dir-meta");
  if (boardDirEl && api) boardDirEl.textContent = `Board folder: ${api.board.getDir()}`;
  const buildEl = el("build-meta");
  if (buildEl && api) buildEl.textContent = `Build: ${api.app.getBuildId()}`;
}

export function activate(context: PluginContext): void {
  api = context;

  backdrop = document.createElement("div");
  backdrop.id = "settings-backdrop";
  backdrop.innerHTML = `
    <div id="settings">
      <div id="settings-header">
        <h2>Settings</h2>
        <button class="close" id="settings-close" title="Close (Esc)">×</button>
      </div>
      <div id="settings-layout">
        <div id="settings-tabs">
          <button data-settings-tab="general" class="active">General</button>
          <button data-settings-tab="plugins">Plugins</button>
          <button data-settings-tab="plugin-settings">Plugin settings</button>
        </div>
        <div id="settings-content">
          <div id="settings-section-general" class="settings-section">
            <h3>Keyboard shortcuts</h3>
            <table id="shortcuts-table"></table>
            <h3>Canvas</h3>
            <div class="canvas-opt" id="bg-opts"></div>
            <div class="canvas-opt" id="grid-opts"></div>
            <h3>Data</h3>
            <p class="meta" id="board-dir-meta"></p>
            <p class="meta" id="build-meta"></p>
            <button id="btn-factory-reset">Factory reset</button>
            <div id="factory-reset-confirm" style="display:none">
              <p class="meta">Boards, settings, plugins and keys — everything. This cannot be undone.</p>
              <button id="btn-factory-reset-confirm">Reset everything</button>
            </div>
            <h3>Backups</h3>
            <div id="backups-list"></div>
            <h3>Send feedback</h3>
            <p class="meta">Opens in your email app, addressed to <span class="email">wren7762@gmail.com</span>.</p>
            <textarea id="feedback-text" rows="4" placeholder="What happened, or what would you like?"></textarea>
            <button id="btn-feedback">Send feedback</button>
          </div>
          <div id="settings-section-plugins" class="settings-section" style="display:none">
            <div id="plugin-list"></div>
          </div>
          <div id="settings-section-plugin-settings" class="settings-section" style="display:none">
            <div id="plugin-settings-sections"></div>
            <p class="meta" id="plugin-settings-empty" style="display:none">No plugin settings</p>
          </div>
        </div>
      </div>
    </div>`;
  // The backdrop lives on the document body, not inside the
  // board element: Settings is a modal over the app, and it
  // must survive the board being rebuilt or a board plugin
  // being replaced. Appending it to the board meant removing
  // the board took Settings down with it — the soft lock.
  document.body.appendChild(backdrop);

  // The plugin system renders plugin settings sections into
  // this container; the settings plugin provides it.
  const sectionsEl = el("plugin-settings-sections");
  if (sectionsEl) context.ui.setSettingsSectionsContainer(sectionsEl);

  // Wire the window's own controls. These used to live in the
  // core (main.ts); they are settings-window wiring, so they
  // live here now.
  el("settings-close")?.addEventListener("click", () => setSettings(false));
  backdrop.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "settings-backdrop") setSettings(false);
  });
  for (const btn of Array.from(backdrop.querySelectorAll("[data-settings-tab]"))) {
    (btn as HTMLElement).addEventListener("click", () => setSettingsTab((btn as HTMLElement).dataset.settingsTab ?? "general"));
  }
  // Factory reset: two-click confirm, like the old board-data
  // reset. The first click arms it; the second wipes everything
  // (boards, settings, plugins, plugin storage, secure storage)
  // and reloads, so the app boots as if freshly installed.
  el("btn-factory-reset")?.addEventListener("click", () => {
    const confirmEl = el<HTMLDivElement>("factory-reset-confirm");
    const btn = el<HTMLButtonElement>("btn-factory-reset");
    if (confirmEl) confirmEl.style.display = "block";
    if (btn) btn.style.display = "none";
  });
  el("btn-factory-reset-confirm")?.addEventListener("click", async () => {
    const result = await context.app.factoryReset();
    if (result?.ok) {
      window.location.reload();
    } else {
      const confirmEl = el<HTMLDivElement>("factory-reset-confirm");
      const btn = el<HTMLButtonElement>("btn-factory-reset");
      if (confirmEl) confirmEl.style.display = "none";
      if (btn) btn.style.display = "";
      context.ui.toast("Factory reset did not run.");
    }
  });

  // The feedback box and button: the draft survives closing
  // Settings, because this wires once at activation, not on
  // every open. Typing here never reaches board shortcuts:
  // the core keydown handlers return early for a focused
  // textarea.
  const box = el<HTMLTextAreaElement>("feedback-text");
  const btn = el<HTMLButtonElement>("btn-feedback");
  if (box && btn) {
    btn.addEventListener("click", () => {
      if (box.value.trim() === "") {
        context.ui.toast("Write a little first — the message is empty.");
        box.focus();
        return;
      }
      // openExternal shows its own toast if the mail app
      // cannot be opened; on success the draft is in the
      // mail app and the text stays here, so nothing is lost
      // if the draft is closed unsent.
      void context.files.openExternal(feedbackMailto(box.value, context.app.getBuildId(), context.app.getPlatform()))
        .then(() => context.ui.toast("Opened in your email app — press Send there to send it to me."))
        .catch(() => context.ui.toast("Could not open your email app."));
    });
  }

  context.ui.registerSettingsUI({
    open: () => setSettings(true),
    close: () => setSettings(false),
    isOpen: () => settingsOpen,
    setTab: (tab: string) => setSettingsTab(tab),
    refresh: () => refresh(),
  });
}

export function deactivate(): void {
  backdrop?.remove();
  backdrop = null;
  settingsOpen = false;
  api = null;
}
