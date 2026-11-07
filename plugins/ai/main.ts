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
    render: (container) => renderPanel(api, container),
  });
  api.ui.registerSettingsSection({
    id: "ai",
    title: "AI",
    render: (container) => renderSettings(api, container),
  });
}

export function deactivate(): void {}
