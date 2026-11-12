// AI — the chat panel. A message list, an input, a send button.
// The user describes a plugin; the AI replies; when a reply
// contains a plugin (a json manifest + TypeScript code), an
// Install button appears under it. Installing uses
// api.plugins.install, then the new plugin shows up in
// Settings → Plugins, ready to enable.
//
// Chats persist in plugin storage (see chats.ts), so the user
// can continue a previous conversation or start a new one: a
// switcher at the top lists past chats, and "New chat" starts
// a fresh one. The previous chats are kept, so starting new
// never loses an old conversation.
import type { PluginContext } from "../../src/plugins";
import { hasKey } from "./settings.js";
import { sendChat } from "./client.js";
import { buildMessages, parseGenerated } from "./generate.js";
import {
  chatTitle,
  loadChats,
  loadCurrentChatId,
  newChat,
  saveChats,
  saveCurrentChatId,
  type Chat,
  type ChatMessage,
} from "./chats.js";

export function renderPanel(api: PluginContext, container: HTMLElement): void {
  container.textContent = "";
  // A column that fills the panel, so the message list expands
  // and the input stays pinned to the bottom.
  container.classList.add("ai-panel");

  // The chat header: a switcher listing past chats, a + to
  // start a fresh one, and a trash icon to delete the
  // current chat. The switcher takes the room; the two icon
  // buttons never shrink.
  const header = document.createElement("div");
  header.className = "ai-chat-header";
  const chatSelect = document.createElement("select");
  chatSelect.className = "ai-chat-select";
  chatSelect.setAttribute("aria-label", "Chat");
  const newChatBtn = document.createElement("button");
  newChatBtn.type = "button";
  newChatBtn.className = "ai-new-chat";
  newChatBtn.textContent = "+";
  newChatBtn.setAttribute("aria-label", "New chat");
  const deleteChatBtn = document.createElement("button");
  deleteChatBtn.type = "button";
  deleteChatBtn.className = "ai-delete-chat";
  deleteChatBtn.setAttribute("aria-label", "Delete chat");
  // The same trash icon as the toolbar's delete button.
  deleteChatBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" /><path d="M10 10.5v5M14 10.5v5" /></svg>';
  header.appendChild(chatSelect);
  header.appendChild(newChatBtn);
  header.appendChild(deleteChatBtn);
  container.appendChild(header);

  const list = document.createElement("div");
  list.className = "ai-messages";
  container.appendChild(list);

  const status = document.createElement("p");
  status.className = "ai-status";
  container.appendChild(status);

  const form = document.createElement("div");
  form.className = "ai-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Ask anything…";
  input.setAttribute("aria-label", "Message");
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "ai-send";
  sendBtn.textContent = "↑";
  sendBtn.setAttribute("aria-label", "Send");
  sendBtn.disabled = true;
  form.appendChild(input);
  form.appendChild(sendBtn);
  container.appendChild(form);

  let chats: Chat[] = [];
  let current: Chat = newChat();
  let busy = false;

  const save = async (): Promise<void> => {
    current.title = chatTitle(current.messages);
    current.updatedAt = Date.now();
    await saveChats(api, chats);
    await saveCurrentChatId(api, current.id);
  };

  const renderChatSelect = (): void => {
    // Most recent first, so the current conversation is at
    // the top and older ones are a scroll away.
    const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
    chatSelect.textContent = "";
    for (const chat of sorted) {
      const option = document.createElement("option");
      option.value = chat.id;
      option.textContent = chat.title;
      chatSelect.appendChild(option);
    }
    chatSelect.value = current.id;
    // Nothing to delete in an empty chat.
    deleteChatBtn.disabled = current.messages.length === 0;
  };

  const addMessage = (msg: ChatMessage, parent: HTMLElement = list): void => {
    const el = document.createElement("div");
    el.className = `ai-message ai-${msg.role}`;
    // The reply may contain fenced code; show it as text, not HTML.
    el.textContent = msg.content;
    parent.appendChild(el);
    list.scrollTop = list.scrollHeight;
  };

  const addInstallButton = (plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string }): void => {
    const wrap = document.createElement("div");
    wrap.className = "ai-install";
    const label = document.createElement("span");
    label.textContent = `Ready: ${plugin.name}.`;
    // What the plugin asks for, and what installing means:
    // a plugin is code, and it runs with the app's
    // privileges once enabled — the permissions list is a
    // contract, not a sandbox, so this is the moment to
    // decide whether the plugin is trusted.
    const perms = document.createElement("div");
    perms.className = "ai-install-meta";
    perms.textContent = plugin.permissions.length > 0
      ? `Permissions: ${plugin.permissions.join(", ")}`
      : "No permissions requested.";
    const warn = document.createElement("div");
    warn.className = "ai-install-meta";
    warn.textContent = "Runs code in Bowerbird once enabled — only install plugins you trust.";
    const btn = document.createElement("button");
    btn.type = "button";
    // A plugin already installed shows as installed, not as
    // another Install button — reinstalling the same code
    // would only overwrite it.
    const alreadyInstalled = api.plugins.list().some((p) => p.id === plugin.id);
    btn.textContent = alreadyInstalled ? "Installed" : "Install plugin";
    btn.disabled = alreadyInstalled;
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
    wrap.appendChild(perms);
    wrap.appendChild(warn);
    list.appendChild(wrap);
    list.scrollTop = list.scrollHeight;
  };

  // Render the current chat's messages from scratch. An
  // assistant message that built a plugin gets its Install
  // button back, so a restored conversation is still usable.
  const renderMessages = (): void => {
    list.textContent = "";
    for (const msg of current.messages) {
      addMessage(msg);
      if (msg.role === "assistant") {
        const plugin = parseGenerated(msg.content);
        if (plugin) addInstallButton(plugin);
      }
    }
  };

  const switchChat = async (id: string): Promise<void> => {
    if (busy) return;
    const next = chats.find((c) => c.id === id);
    if (!next || next.id === current.id) return;
    // An empty chat left behind is dropped, so the list
    // never fills with blank "New chat" entries.
    if (current.messages.length === 0) chats = chats.filter((c) => c.id !== current.id);
    current = next;
    renderChatSelect();
    renderMessages();
    await saveCurrentChatId(api, current.id);
  };

  const startNewChat = async (): Promise<void> => {
    if (busy) return;
    if (current.messages.length === 0) return;
    const chat = newChat();
    chats.unshift(chat);
    current = chat;
    renderChatSelect();
    renderMessages();
    input.focus();
    await saveCurrentChatId(api, current.id);
  };

  const deleteCurrentChat = async (): Promise<void> => {
    if (busy) return;
    // An empty chat is not persisted, so there is nothing to
    // delete — the button is disabled for it.
    if (current.messages.length === 0) return;
    chats = chats.filter((c) => c.id !== current.id);
    // Fall back to the most recent remaining chat, or a fresh
    // one when the list is now empty.
    current = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? newChat();
    if (!chats.some((c) => c.id === current.id)) chats.unshift(current);
    renderChatSelect();
    renderMessages();
    await saveChats(api, chats);
    await saveCurrentChatId(api, current.id);
    input.focus();
  };

  const send = async (): Promise<void> => {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    chatSelect.disabled = true;
    newChatBtn.disabled = true;
    deleteChatBtn.disabled = true;
    sendBtn.disabled = true;
    input.value = "";
    current.messages.push({ role: "user", content: text });
    addMessage({ role: "user", content: text });
    status.textContent = "Thinking…";
    try {
      if (!(await hasKey(api))) {
        status.textContent = "";
        const reply = "No API key saved yet. Add one in Settings → Plugin settings → AI, then ask again.";
        current.messages.push({ role: "assistant", content: reply });
        addMessage({ role: "assistant", content: reply });
        await save();
        renderChatSelect();
        return;
      }
      const reply = await sendChat(api, buildMessages(current.messages));
      current.messages.push({ role: "assistant", content: reply });
      addMessage({ role: "assistant", content: reply });
      status.textContent = "";
      await save();
      renderChatSelect();
      const plugin = parseGenerated(reply);
      if (plugin) addInstallButton(plugin);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      chatSelect.disabled = false;
      newChatBtn.disabled = false;
      deleteChatBtn.disabled = current.messages.length === 0;
      sendBtn.disabled = input.value.trim().length === 0;
      input.focus();
    }
  };

  chatSelect.addEventListener("change", () => void switchChat(chatSelect.value));
  newChatBtn.addEventListener("click", () => void startNewChat());
  deleteChatBtn.addEventListener("click", () => void deleteCurrentChat());
  sendBtn.addEventListener("click", () => void send());
  input.addEventListener("input", () => {
    sendBtn.disabled = busy || input.value.trim().length === 0;
  });
  input.addEventListener("keydown", (e) => {
    // Without this, the core window keydown handler sees
    // every key typed here: v/p/a would switch tools,
    // Backspace would delete the selected card, +/- would
    // zoom, and so on. The core guards textareas and the
    // board search input, so a plugin input must stop its
    // own keydown — the same as the Visual Library search.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  });

  // Restore the previous chat on open, so the conversation
  // continues where it left off. A stored current id that
  // points at nothing (an empty chat never persisted) falls
  // back to the most recent chat, or a fresh one.
  void (async () => {
    const stored = await loadChats(api);
    const currentId = await loadCurrentChatId(api);
    chats = stored;
    current = chats.find((c) => c.id === currentId) ?? chats[0] ?? newChat();
    if (!chats.some((c) => c.id === current.id)) chats.unshift(current);
    renderChatSelect();
    renderMessages();
  })();

  // No welcome text: the app shows no descriptive or help text.
  // The input's placeholder is the only prompt.
}
