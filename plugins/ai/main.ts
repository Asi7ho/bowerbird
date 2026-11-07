// AI — a general AI chat in Bowerbird. Ask anything; when the
// user asks for a plugin, the AI writes it and it can be installed
// from the reply. The API key lives in secure storage (see
// settings.ts) and the chat call runs in the main process
// (api.ai.chat), not the renderer.
import type { PluginContext } from "../../src/plugins";
import { renderPanel } from "./panel.js";
import { renderSettings } from "./settings.js";

export function activate(api: PluginContext): void {
  api.ui.registerPanel({
    id: "ai-chat",
    title: "AI",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M21 11.5a2.5 2.5 0 0 1-2.5 2.5H12l-4 4v-4H5.5A2.5 2.5 0 0 1 3 11.5v-7A2.5 2.5 0 0 1 5.5 2h13A2.5 2.5 0 0 1 21 4.5z"/></svg>',
    render: (container) => renderPanel(api, container),
  });
  api.ui.registerSettingsSection({
    id: "ai",
    title: "AI",
    render: (container) => renderSettings(api, container),
  });
}

export function deactivate(): void {}
