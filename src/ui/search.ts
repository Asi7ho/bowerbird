// The board search box is a first-party plugin
// (core-search): it builds the search input, the match
// count, the clear button and the results dropdown into
// the search box container the core-titlebar plugin
// provides, and hands those elements to the search engine
// through api.search.setElements. The engine owns the
// matching, the dimming and the results; this plugin owns
// the box. It uses only the public API.
//
// The box is fixed at 360×34 in every state (the search
// bar's size is locked: the input, count and clear button
// are laid out inside it, and the results dropdown is
// absolutely positioned below it, so it never changes the
// box's size).
import type { PluginContext, PluginManifest } from "../plugins";

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
