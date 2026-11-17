// The plugin views: the board/plugin view switcher, the
// active view, and view registration.
//
// The active view and the view-switcher DOM live here, with
// the functions that own them. setActiveView needs the host
// (the live board, re-render) and the plugin event bus
// ("view"), and it reads them through the deps bound by
// initPlugins — getter closures over host.ts's host let and
// emitPluginEvent, so this module always sees the live
// values without owning them, and before initPlugins binds
// them the functions no-op exactly as they did when host
// was null.
import type { PluginHost, PluginViewDef } from "bowerbird-plugin-api";
import { shell, views } from "./host-state";
import { createSegButton } from "../ui/components";

export interface ViewDeps {
  getHost: () => PluginHost | null;
  emitEvent: (event: string) => void;
}

let deps: ViewDeps | null = null;
export function bindViewDeps(d: ViewDeps): void {
  deps = d;
}

let activeView = "board";

export function getActiveView(): string {
  return activeView;
}

export function renderViewSwitcher(): void {
  if (!deps?.getHost()) return;
  const el = shell.viewSwitcherEl;
  if (!el) return;
  el.innerHTML = "";
  if (views.size === 0) {
    el.style.display = "none";
    return;
  }
  el.style.display = "flex";
  const mk = (id: string, title: string) => {
    const b = createSegButton(title, {
      active: activeView === id,
      onClick: () => setActiveView(id),
    });
    el.appendChild(b);
  };
  mk("board", "Board");
  for (const v of views.values()) mk(v.id, v.title);
}

export function setActiveView(id: string): void {
  const host = deps?.getHost();
  if (!host) return;
  if (id !== "board" && !views.has(id)) return;
  const prev = views.get(activeView);
  if (prev?.onHide) {
    try {
      prev.onHide();
    } catch {
      // A view's onHide must never trap the user in the view.
    }
  }
  activeView = id;
  const viewEl = shell.pluginViewEl;
  const canvasEls = shell.boardCanvasEls;
  if (id === "board") {
    for (const el of canvasEls ?? []) el.style.display = "";
    if (viewEl) {
      viewEl.style.display = "none";
      viewEl.innerHTML = "";
    }
  } else if (viewEl) {
    for (const el of canvasEls ?? []) el.style.display = "none";
    viewEl.style.display = "";
    const v = views.get(id)!;
    viewEl.innerHTML = "";
    viewEl.dataset.plugin = v.pluginId;
    try {
      v.render(viewEl, host.getBoard());
    } catch (e) {
      viewEl.textContent = `View failed to render: ${String(e)}`;
    }
    if (v.onShow) {
      try {
        v.onShow();
      } catch {
        // See onHide above.
      }
    }
  }
  renderViewSwitcher();
  deps?.emitEvent("view");
  host.render();
}

export function refreshActiveView(): void {
  const host = deps?.getHost();
  if (!host || activeView === "board") return;
  const v = views.get(activeView);
  if (!v) {
    setActiveView("board");
    return;
  }
  const viewEl = shell.pluginViewEl;
  if (!viewEl) return;
  try {
    v.render(viewEl, host.getBoard());
  } catch (e) {
    viewEl.textContent = `View failed to render: ${String(e)}`;
  }
}

export function registerView(pluginId: string, def: PluginViewDef): void {
  views.set(def.id, { ...def, pluginId });
  renderViewSwitcher();
}
