// AI — the chat call. One thin wrapper around api.ai.chat, which
// runs in the main process (not the renderer). The only error
// handling here is turning a provider failure into a short,
// human sentence for the chat.
import type { PluginContext } from "../../src/plugins";
import { getConfig } from "./settings.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function sendChat(
  api: PluginContext,
  messages: ChatMessage[]
): Promise<string> {
  const config = await getConfig(api);
  if (!config) {
    throw new Error("No API key saved yet. Add one in Settings → Plugin settings → AI.");
  }
  try {
    return await api.ai.chat({
      base: config.base,
      key: config.key,
      model: config.model,
      messages,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Electron wraps an IPC failure as "Error invoking remote
    // method 'bowerbird:ai-chat': <the real error>". Strip the
    // wrapper so the chat shows the provider's message only.
    const prefix = "Error invoking remote method 'bowerbird:ai-chat': ";
    const clean = msg.startsWith(prefix) ? msg.slice(prefix.length) : msg;
    // And the main process throws "Error: ..." — drop that too.
    throw new Error(clean.startsWith("Error: ") ? clean.slice("Error: ".length) : clean);
  }
}
