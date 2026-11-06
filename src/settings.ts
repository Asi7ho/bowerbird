// Settings: the two-pane Settings window (General, Plugins,
// Plugin settings). The panel renders from the board and the
// loaded plugins; the core owns the board itself, so canvas
// changes go through the context (save + re-render), and a
// backup restore goes through the core's restoreBoardBackup.
import { api } from "./api";
import { escapeHtml, type Board } from "./model";
import {
  listLoadedPlugins, listPluginShortcuts, renderSettingsSections, setPluginEnabled,
} from "./plugins";

export interface SettingsContext {
  getBoard(): Board;
  isDemo(): boolean;
  save(): void;
  requestRender(): void;
  restoreBackup(name: string): Promise<boolean>;
}

export interface SettingsPanel {
  setSettings(open: boolean): void;
  isOpen(): boolean;
  setSettingsTab(tab: string): void;
  renderBgOpts(): void;
  renderGridOpts(): void;
  renderBackups(): Promise<void>;
  renderPluginSettings(): void;
  renderPluginSettingsSections(): void;
}

export function createSettingsPanel(ctx: SettingsContext): SettingsPanel {

const SHORTCUTS: Array<[string, string]> = [
  ["V", "Select tool"],
  ["P", "Pen tool"],
  ["A", "Arrow (connector) tool"],
  ["Delete / Backspace", "Delete the selection"],
  ["Ctrl / Cmd + Z", "Undo"],
  ["Ctrl / Cmd + Shift + Z", "Redo"],
  ["Ctrl / Cmd + Y", "Redo"],
  ["Ctrl / Cmd + G", "Group the selection"],
  ["Ctrl / Cmd + U", "Ungroup the selection"],
  ["+ / =", "Zoom in"],
  ["−", "Zoom out"],
  ["0", "Reset the view"],
  ["Ctrl / Cmd + scroll", "Zoom at the cursor"],
  ["Scroll", "Pan the canvas"],
  ["Space + drag", "Pan the canvas"],
  ["?", "Open settings"],
  ["Esc", "Close settings, commit a note, or clear the selection"],
  ["Tab", "Go to the next element"],
  ["Shift + Tab", "Go to the previous element"],
  ["Ctrl / Cmd + F", "Search the board"],
  ["Enter in search", "Jump to the next match"],
  ["Shift + Enter in search", "Jump to the previous match"],
  ["Esc in search", "Clear the search"],
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

  let settingsOpen = false;

  function renderPluginSettings(): void {
    const list = document.getElementById("plugin-list") as HTMLDivElement | null;
    if (!list) return;
    const plugins = listLoadedPlugins();
    if (plugins.length === 0) {
      list.innerHTML = `<p class="meta">No plugins found. Drop a plugin folder into your plugins folder, then reopen Settings. See PLUGIN_API.md in the repo for the format.</p>`;
      return;
    }
    const descriptions: Record<string, string> = {
      hide: "Hides the board into a corner.",
      "visual-library": "The board's cards, as a library.",
      palette: "Colour palettes to place as swatches.",
      presentation: "Slides on the board, played in order.",
      "command-palette": "Every command, from one place.",
      "plugin-builder": "Describe a plugin, and an AI writes it for you to try, then keep or discard.",
    };
    let html = "";
    for (const lp of plugins) {
      const m = lp.manifest;
      // A trial plugin is not installed yet: the Builder panel
      // owns it, so it shows as Trying and gets no toggle.
      const state = lp.trial ? "Trying" : lp.failed ? "Failed" : lp.active ? "On" : "Off";
      html += `<div class="plugin-row"><div class="plugin-row-text"><div><strong>${escapeHtml(m.name)}</strong> <span class="meta">${state}</span></div>`;
      const desc = descriptions[m.id];
      if (desc) html += `<p class="meta">${desc}</p>`;
      if (lp.failed && lp.error) html += `<p class="meta"><strong>${escapeHtml(lp.error)}</strong></p>`;
      // No Run buttons: commands are run from the command
      // palette (Cmd/Ctrl+K), not from Settings, and the
      // palette's own Open command was the only command any
      // plugin registered, so a Run button here was just a
      // second way to open the palette.
      // A Settings button, when the plugin has a settings
      // section: it jumps to the Plugin settings tab and
      // scrolls to that plugin's section, so settings are
      // reachable from the plugin list, not only by tab.
      const hasSettings = document.querySelector(`#plugin-settings-sections [data-plugin="${m.id}"]`) !== null;
      html += `</div><span style="display:flex;gap:8px;flex:none">`;
      if (lp.active && hasSettings) html += `<button data-plugin-settings="${m.id}">Settings</button>`;
      if (!lp.trial) html += `<button data-plugin-toggle="${m.id}">${lp.active ? "Disable" : "Enable"}</button></span>`;
      else html += `</span>`;
      html += `</div>`;
    }
    list.innerHTML = html;
    for (const btn of Array.from(list.querySelectorAll("[data-plugin-settings]"))) {
      btn.addEventListener("click", () => {
        const id = (btn as HTMLElement).dataset.pluginSettings ?? "";
        setSettingsTab("plugin-settings");
        const section = document.querySelector(`#plugin-settings-sections [data-plugin="${id}"]`);
        if (section) section.scrollIntoView({ block: "start" });
      });
    }
    for (const btn of Array.from(list.querySelectorAll("[data-plugin-toggle]"))) {
      btn.addEventListener("click", async () => {
        const id = (btn as HTMLElement).dataset.pluginToggle ?? "";
        const lp = listLoadedPlugins().find((x) => x.manifest.id === id);
        if (!lp) return;
        await setPluginEnabled(id, !lp.active);
        renderShortcutsTable();
        renderPluginSettingsSections();
        renderPluginSettings();
        ctx.requestRender();
      });
    }
  }

  function renderPluginSettingsSections(): void {
    renderSettingsSections();
    const empty = document.getElementById("plugin-settings-empty") as HTMLElement | null;
    const el = document.getElementById("plugin-settings-sections") as HTMLElement | null;
    if (empty && el) empty.style.display = el.children.length > 0 ? "none" : "";
  }

  function setSettingsTab(tab: string): void {
    for (const btn of Array.from(document.querySelectorAll("[data-settings-tab]"))) {
      (btn as HTMLElement).classList.toggle("active", (btn as HTMLElement).dataset.settingsTab === tab);
    }
    const sections: Record<string, string> = {
      general: "settings-section-general",
      plugins: "settings-section-plugins",
      "plugin-settings": "settings-section-plugin-settings",
    };
    for (const [key, id] of Object.entries(sections)) {
      const el = document.getElementById(id) as HTMLElement | null;
      if (el) el.style.display = key === tab ? "" : "none";
    }
    const content = document.getElementById("settings-content") as HTMLElement | null;
    if (content) content.scrollTop = 0;
  }

  function renderShortcutsTable(): void {
    const table = document.getElementById("shortcuts-table") as HTMLTableElement;
    if (!table) return;
    const allShortcuts: Array<[string, string]> = [...SHORTCUTS];
    for (const s of listPluginShortcuts()) allShortcuts.push([s.key.toUpperCase(), `${s.title} (${s.pluginName})`]);
    table.innerHTML = allShortcuts.map(([k, v]) => `<tr><td><kbd>${escapeHtml(k)}</kbd></td><td>${escapeHtml(v)}</td></tr>`).join("");
  }

  function setSettings(open: boolean): void {
    settingsOpen = open;
    const backdrop = document.getElementById("settings-backdrop") as HTMLDivElement;
    backdrop.classList.toggle("open", open);
    if (open) {
      const confirmEl = document.getElementById("reset-confirm") as HTMLDivElement;
      const resetBtn = document.getElementById("btn-reset") as HTMLButtonElement;
      if (confirmEl) confirmEl.style.display = "none";
      if (resetBtn) resetBtn.style.display = "";
      renderShortcutsTable();
      renderBgOpts();
      renderGridOpts();
      void renderBackups();
      renderPluginSettingsSections();
      renderPluginSettings();
      setSettingsTab("general");
    }
    ctx.requestRender();
  }

  async function renderBackups(): Promise<void> {
    const el = document.getElementById("backups-list") as HTMLElement | null;
    if (!el) return;
    if (ctx.isDemo()) { el.innerHTML = `<p class="meta">Backups are not available in demo mode.</p>`; return; }
    let list: Array<{ name: string; items: number; size: number }> = [];
    try { list = await api.listBackups(); } catch { list = []; }
    if (list.length === 0) {
      el.innerHTML = `<p class="meta">No backups yet. The first one is made within an hour of working on this board.</p>`;
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
    el.innerHTML = "";
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
      const ok = await ctx.restoreBackup(b.name);
      if (ok) { setSettings(false); void renderBackups(); }
    });
    row.appendChild(meta);
    row.appendChild(btn);
    el.appendChild(row);
  }

  function renderBgOpts(): void {
    const opts: Array<[string, string]> = [["White", "#FFFFFF"], ["Paper", "#F7F5F0"], ["Sage", "#EAF3EC"], ["Sky", "#E8F0F7"], ["Ink", "#1C1C1E"]];
    const el = document.getElementById("bg-opts") as HTMLDivElement;
    el.innerHTML = "";
    for (const [label, hex] of opts) {
      const b = document.createElement("button");
      b.textContent = label;
      if (ctx.getBoard().bg.toUpperCase() === hex) b.classList.add("active");
      b.addEventListener("click", () => { ctx.getBoard().bg = hex; ctx.save(); ctx.requestRender(); renderBgOpts(); });
      el.appendChild(b);
    }
  }
  function renderGridOpts(): void {
    const opts: Array<[string, Board["grid"]]> = [["Dots", "Dots"], ["Lines", "Lines"], ["Off", "Off"]];
    const el = document.getElementById("grid-opts") as HTMLDivElement;
    el.innerHTML = "";
    for (const [label, mode] of opts) {
      const b = document.createElement("button");
      b.textContent = label;
      if (ctx.getBoard().grid === mode) b.classList.add("active");
      b.addEventListener("click", () => { ctx.getBoard().grid = mode; ctx.save(); ctx.requestRender(); renderGridOpts(); });
      el.appendChild(b);
    }
  }

  function isOpen(): boolean {
    return settingsOpen;
  }

  return {
    setSettings,
    isOpen,
    setSettingsTab,
    renderBgOpts,
    renderGridOpts,
    renderBackups,
    renderPluginSettings,
    renderPluginSettingsSections,
  };
}
