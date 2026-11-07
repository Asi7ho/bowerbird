// AI — the chat panel. A message list, an input, a send button.
// The user describes a plugin; the AI replies; when a reply
// contains a plugin (a json manifest + TypeScript code), an
// Install button appears under it. Installing uses
// api.plugins.install, then the new plugin shows up in
// Settings → Plugins, ready to enable.
import type { PluginContext } from "../../src/plugins";
import { hasKey } from "./settings.js";
import { sendChat } from "./client.js";
import { buildMessages, parseGenerated } from "./generate.js";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export function renderPanel(api: PluginContext, container: HTMLElement): void {
  container.textContent = "";

  const list = document.createElement("div");
  list.className = "ai-messages";
  container.appendChild(list);

  const status = document.createElement("p");
  status.className = "ai-status";
  container.appendChild(status);

  const form = document.createElement("div");
  form.className = "ai-form";
  const input = document.createElement("textarea");
  input.placeholder = "Ask anything…";
  input.rows = 3;
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.textContent = "Send";
  form.appendChild(input);
  form.appendChild(sendBtn);
  container.appendChild(form);

  const history: Message[] = [];
  let busy = false;

  const addMessage = (msg: Message): void => {
    const el = document.createElement("div");
    el.className = `ai-message ai-${msg.role}`;
    // The reply may contain fenced code; show it as text, not HTML.
    el.textContent = msg.content;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
  };

  const addInstallButton = (plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string }): void => {
    const wrap = document.createElement("div");
    wrap.className = "ai-install";
    const label = document.createElement("span");
    label.textContent = `Ready: ${plugin.name}.`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Install plugin";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Installing…";
      try {
        await api.plugins.install({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          permissions: plugin.permissions,
          mainCode: plugin.mainCode,
          styleCode: "",
        });
        btn.textContent = "Installed";
        status.textContent = `${plugin.name} is installed. Enable it in Settings → Plugins.`;
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Install plugin";
        status.textContent = e instanceof Error ? e.message : String(e);
      }
    });
    wrap.appendChild(label);
    wrap.appendChild(btn);
    list.appendChild(wrap);
    list.scrollTop = list.scrollHeight;
  };

  const send = async (): Promise<void> => {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    history.push({ role: "user", content: text });
    addMessage({ role: "user", content: text });
    status.textContent = "Thinking…";
    try {
      if (!(await hasKey(api))) {
        status.textContent = "";
        const reply = "No API key saved yet. Add one in Settings → Plugin settings → AI, then ask again.";
        history.push({ role: "assistant", content: reply });
        addMessage({ role: "assistant", content: reply });
        return;
      }
      const reply = await sendChat(api, buildMessages(history));
      history.push({ role: "assistant", content: reply });
      addMessage({ role: "assistant", content: reply });
      status.textContent = "";
      const plugin = parseGenerated(reply);
      if (plugin) addInstallButton(plugin);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  };

  sendBtn.addEventListener("click", () => void send());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  const welcome = document.createElement("div");
  welcome.className = "ai-message ai-assistant";
  welcome.textContent = "Ask me anything — or describe a plugin and I'll build it.";
  list.appendChild(welcome);
}
