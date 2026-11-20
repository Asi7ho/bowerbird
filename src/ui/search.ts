// core-search: the search box as a first-party plugin.

import type { PluginContext, PluginManifest } from "../plugins/host";

export const manifest: PluginManifest = {
  id: "core-search",
  name: "Search",
  description: "Board search: text, colour, image, audio and video.",
  version: "1.0.0",
  apiVersion: "2",
  main: "search.js",
  permissions: ["board:read"],
};

let box: HTMLElement | null = null;

export function activate(api: PluginContext): void {
  box = api.ui.getSearchBoxEl();
  if (!box) return;
  box.innerHTML = `
    <input id="search-input" type="text" placeholder="Search board" aria-label="Search board" autocomplete="off" spellcheck="false" />
    <span id="search-count" aria-live="polite"></span>
    <button id="search-clear" title="Clear search (Esc)" aria-label="Clear search">×</button>
    <div id="search-results" style="display:none"></div>`;
  const input = box.querySelector<HTMLInputElement>("#search-input");
  const count = box.querySelector<HTMLElement>("#search-count");
  const clear = box.querySelector<HTMLButtonElement>("#search-clear");
  const results = box.querySelector<HTMLElement>("#search-results");
  if (!input || !count || !clear || !results) return;
  // Hand the engine the box elements, so it can run the
  // search, dim the board and render the results into
  // them. The engine attaches its own input and keyboard
  // listeners here.
  api.search.setElements({ input, count, clear, results });
}

export function deactivate(): void {
  if (box) box.innerHTML = "";
  box = null;
}
