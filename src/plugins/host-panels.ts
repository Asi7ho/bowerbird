// The plugin panel dock: tabs, the resizable dock, the
// active panel, and panel registration.
//
// The dock state (active panel, visibility, width, tab
// elements, tab-drag state) lives here, with the functions
// that own it. It needs three things the host owns — the
// PluginHost (panel order, re-render), the PluginBridge
// (persisting width/visibility) and the pluginsReady flag —
// and it reads them through the deps bound by initPlugins.
// The deps are getter closures over host.ts's lets, so this
// module always sees the live values without owning them,
// and before initPlugins binds them the functions no-op
// exactly as they did when host was null.
import type { PluginBridge, PluginHost, PluginPanelDef } from "bowerbird-plugin-api";
import { panels, shell } from "./host-state";

export interface PanelDeps {
  getHost: () => PluginHost | null;
  getBridge: () => PluginBridge | null;
  isPluginsReady: () => boolean;
}

let deps: PanelDeps | null = null;
export function bindPanelDeps(d: PanelDeps): void {
  deps = d;
}

// Panel tabs state: one panel shown at a time, switched by
// its tab. `hidden` is the showPanel/hidePanel state (a
// panel with no tab); `activePanelKey` is which shown panel
// is on screen. `dockVisible` is the tab-bar close and
// title-bar toggle state — the dock can be closed while
// panels are still shown, so it can be reopened with its
// tabs and active panel intact.
let activePanelKey: string | null = null;
let dockVisible = true;
let panelWidth = 290;
let tabsEl: HTMLElement | null = null;
let tabsListEl: HTMLElement | null = null;
let tabsToggleWired = false;
// Tab drag state: a tab drag is a reorder, not a click, so
// the click that fires after mouseup must be suppressed when
// the pointer actually moved. The saved order is the tab
// DOM order, so a dragged tab stays where the user left it
// across restarts, and a new panel appends at the end.
let tabDrag: { key: string; startX: number; dragged: boolean } | null = null;
let suppressTabClick = false;

function applyPanelOrder(): void {
  const host = deps?.getHost();
  if (!host || !tabsListEl) return;
  const order = host.getPanelOrder();
  if (order.length === 0) return;
  const sorted = Array.from(panels.entries()).sort((a, b) => {
    const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
    if (ia < 0 && ib < 0) return 0;
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
  panels.clear();
  for (const [key, p] of sorted) {
    panels.set(key, p);
    tabsListEl.appendChild(p.tab);
  }
}

function panelDomOrder(): string[] {
  if (!tabsListEl) return [];
  const keys: string[] = [];
  for (const child of Array.from(tabsListEl.children)) {
    for (const [key, p] of panels.entries()) {
      if (p.tab === child) keys.push(key);
    }
  }
  return keys;
}

export function wirePanelsToggle(): void {
  // Title-bar toggle, wired once: it lives outside the
  // dock, so it is still there when the dock is closed,
  // and is how a closed dock comes back.
  const host = deps?.getHost();
  if (!host || !shell.panelsToggleEl || tabsToggleWired) return;
  tabsToggleWired = true;
  shell.panelsToggleEl.addEventListener("click", () => {
    if (Array.from(panels.values()).every((p) => p.hidden)) return;
    setDockVisible(!dockVisible);
    deps?.getHost()?.render();
  });
}

// The dock is resizable: a thin handle on its left edge. Drag
// left to widen, right to narrow; the width is clamped to
// 200–600px and saved when the drag ends, so it survives a
// restart. The handle lives inside the dock, so the board's
// own mousedown never sees it.
export function ensureResizeHandle(): void {
  if (!deps?.getHost() || !shell.panelsEl || shell.panelsEl.querySelector(".panel-resize-handle")) return;
  const handle = document.createElement("div");
  handle.className = "panel-resize-handle";
  handle.title = "Drag to resize panels";
  handle.setAttribute("aria-label", "Resize panels");
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMove = (ev: MouseEvent) => {
      // The dock is on the right edge: dragging left widens it.
      const next = Math.min(600, Math.max(200, startWidth - (ev.clientX - startX)));
      panelWidth = next;
      if (shell.panelsEl) shell.panelsEl.style.width = `${next}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      void deps?.getBridge()?.setPanelWidth(panelWidth);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  shell.panelsEl.appendChild(handle);
}

function ensureTabsBar(): void {
  if (!deps?.getHost() || tabsEl) return;
  tabsEl = document.createElement("div");
  tabsEl.id = "plugin-tabs";
  tabsEl.className = "plugin-tabs";
  tabsListEl = document.createElement("div");
  tabsListEl.className = "plugin-tabs-list";
  const close = document.createElement("button");
  close.className = "plugin-tabs-close";
  close.textContent = "×";
  close.title = "Hide panels";
  close.setAttribute("aria-label", "Hide panels");
  close.addEventListener("click", () => {
    setDockVisible(false);
    deps?.getHost()?.render();
  });
  tabsEl.appendChild(tabsListEl);
  tabsEl.appendChild(close);
  shell.panelsEl?.appendChild(tabsEl);
  wirePanelsToggle();
}

function visiblePanels(): Array<[string, PluginPanelDef & { pluginId: string; el: HTMLElement; body: HTMLElement; tab: HTMLElement; hidden: boolean }]> {
  return Array.from(panels.entries()).filter(([, p]) => !p.hidden);
}

export function updatePanelDock(): void {
  if (!deps?.getHost()) return;
  const visible = visiblePanels();
  const open = dockVisible && visible.length > 0;
  if (shell.panelsEl) shell.panelsEl.style.width = open ? `${panelWidth}px` : "0px";
  if (tabsEl) tabsEl.style.display = open ? "" : "none";
  for (const [key, p] of panels.entries()) {
    const active = !p.hidden && key === activePanelKey;
    p.tab.style.display = p.hidden ? "none" : "";
    p.tab.classList.toggle("active", active);
    p.el.style.display = active ? "" : "none";
  }
  if (shell.panelsToggleEl) {
    shell.panelsToggleEl.classList.toggle("active", open);
    // No plugin panels at all: the toggle has nothing to
    // show, so it is hidden, not dimmed. A dimmed button
    // that does nothing reads as broken; and the toggle
    // stays visible whenever panels exist, even with the
    // dock closed — that is how a closed dock comes back.
    shell.panelsToggleEl.style.display = visible.length === 0 ? "none" : "";
  }
}

export function setActivePanel(key: string): void {
  const p = panels.get(key);
  if (!p || p.hidden) return;
  // The board re-renders when the active panel changes,
  // so a plugin whose board content depends on its panel
  // being open — a slide frame, for example — appears and
  // disappears with the panel. Clicking the already-active
  // tab changes nothing, so it renders nothing. No render
  // while plugins are still loading: the board renders once
  // after they all activate.
  const prev = activePanelKey;
  activePanelKey = key;
  updatePanelDock();
  if (deps?.isPluginsReady() && prev !== key) deps?.getHost()?.render();
}

function setDockVisible(visible: boolean): void {
  // Same as setActivePanel: closing the dock leaves no
  // panel open, so panel-dependent board content hides,
  // and opening it shows it again.
  const prev = dockVisible;
  dockVisible = visible;
  updatePanelDock();
  if (deps?.isPluginsReady() && prev !== visible) deps?.getHost()?.render();
  // The dock's visibility is a preference, like its
  // width: remember it, so a closed dock stays closed
  // across a reload instead of reopening.
  if (prev !== visible) void deps?.getBridge()?.setDockVisible(visible);
}

// True when the panel with this registry key is the one on
// screen: the dock is open and it is the active panel.
// (createContext's ui.isPanelActive delegates here.)
export function isPanelActive(key: string): boolean {
  return dockVisible && activePanelKey === key;
}

// When the active panel is hidden, the next visible panel
// becomes active (or none, if there is no visible panel).
// (createContext's ui.hidePanel delegates here.)
export function deactivatePanelIfActive(key: string): void {
  if (activePanelKey === key) {
    const next = visiblePanels()[0];
    activePanelKey = next ? next[0] : null;
  }
}

// When the active panel is gone from the registry (its
// plugin was unregistered), the next visible panel becomes
// active (or none, if there is no visible panel).
// (unregisterPlugin delegates here.)
export function deactivateMissingActivePanel(): void {
  if (activePanelKey && !panels.has(activePanelKey)) {
    const next = visiblePanels()[0];
    activePanelKey = next ? next[0] : null;
  }
}

// Called by initPlugins with the saved dock settings: the
// width is clamped to the same 200–600px as the drag handle.
export function applySavedPanelSettings(settings: { panelWidth?: unknown; dockVisible?: unknown }): void {
  if (typeof settings.panelWidth === "number") {
    panelWidth = Math.min(600, Math.max(200, Math.round(settings.panelWidth)));
  }
  if (typeof settings.dockVisible === "boolean") {
    dockVisible = settings.dockVisible;
  }
}

export function registerPanel(pluginId: string, def: PluginPanelDef): void {
  const host = deps?.getHost();
  if (!host) return;
  ensureTabsBar();
  // No per-panel header: the tab is the header. A panel
  // is a body only; the tab bar, with one tab per panel,
  // sits above the active panel and switches between them.
  const wrap = document.createElement("div");
  wrap.className = "plugin-panel";
  wrap.dataset.plugin = pluginId;
  wrap.dataset.panel = def.id;
  const body = document.createElement("div");
  body.className = "plugin-panel-body";
  wrap.appendChild(body);
  shell.panelsEl?.appendChild(wrap);
  const tab = document.createElement("button");
  tab.className = "plugin-tab";
  // Tabs are icons only: the title stays as the tooltip
  // and aria-label, so the panel is still named on hover
  // and to screen readers, without text in the tab bar.
  // A panel with no icon falls back to its title text,
  // as tabs did before, so an icon is optional, not
  // required for a panel to be usable.
  if (def.icon) {
    if (/<script/i.test(def.icon)) throw new Error(`Plugin ${pluginId} panel icon contains <script>`);
    tab.innerHTML = def.icon;
    tab.classList.add("has-icon");
  } else {
    tab.textContent = def.title;
  }
  tab.title = `${def.title} — drag to reorder`;
  tab.setAttribute("aria-label", def.title);
  const key = `${pluginId}:${def.id}`;
  tab.addEventListener("click", () => {
    if (suppressTabClick) { suppressTabClick = false; return; }
    setActivePanel(key);
  });
  // Drag a tab left or right to reorder the tabs. A drag is
  // any pointer move over 4px; a smaller move is a click.
  // The tab follows the pointer live, and the new order is
  // saved on mouseup, so it survives a restart.
  tab.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0) return;
    tabDrag = { key, startX: e.clientX, dragged: false };
    const onMove = (ev: MouseEvent) => {
      if (!tabDrag || tabDrag.key !== key) return;
      if (Math.abs(ev.clientX - tabDrag.startX) <= 4) return;
      tabDrag.dragged = true;
      tab.classList.add("dragging");
      if (!tabsListEl) return;
      const visible = Array.from(tabsListEl.children).filter((c) => (c as HTMLElement).style.display !== "none");
      let target: Element | null = null;
      for (const c of visible) {
        if (c === tab) continue;
        const r = c.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) { target = c; break; }
      }
      if (target) tabsListEl.insertBefore(tab, target);
      else tabsListEl.appendChild(tab);
      // DOM order is the order that gets saved on mouseup;
      // the panel map order does not affect what is shown.
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      tab.classList.remove("dragging");
      if (tabDrag && tabDrag.dragged) {
        // Suppress only the click that belongs to this drag:
        // it fires right after mouseup, before the timeout
        // below runs. A drag that ends outside a tab fires
        // no click at all, and without the timeout the flag
        // would stay set and swallow the user's next real
        // tab click — the extra click this fix removes.
        suppressTabClick = true;
        setTimeout(() => { suppressTabClick = false; }, 0);
        deps?.getHost()?.setPanelOrder(panelDomOrder());
      }
      tabDrag = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  tabsListEl!.appendChild(tab);
  panels.set(key, { ...def, pluginId, el: wrap, body, tab, hidden: false });
  applyPanelOrder();
  try {
    def.render(body);
  } catch (e) {
    body.textContent = `Panel failed to render: ${String(e)}`;
  }
  // First panel becomes active; later panels do not steal
  // focus from the panel the user is already looking at.
  if (activePanelKey === null) activePanelKey = key;
  updatePanelDock();
  host.render();
}
