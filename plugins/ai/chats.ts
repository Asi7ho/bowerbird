// AI — chat storage. Chats persist in plugin storage
// (api.storage), so the user can continue a previous
// conversation or start a new one. A chat is only persisted
// once it has a message; an empty "New chat" lives in memory
// until the first message is sent, so the list never fills
// with blank entries.
import type { PluginContext } from "../../src/plugins";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Chat {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

const CHATS_KEY = "chats";
const CURRENT_KEY = "currentChatId";

export function newChat(): Chat {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: "New chat",
    messages: [],
    updatedAt: Date.now(),
  };
}

// A chat is named by what the user asked — the first user
// message, short enough to read in the switcher.
export function chatTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New chat";
  const text = first.content.trim().replace(/\s+/g, " ");
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function isChat(value: unknown): value is Chat {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.title === "string" && Array.isArray(c.messages);
}

export async function loadChats(api: PluginContext): Promise<Chat[]> {
  const raw = await api.storage.get(CHATS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isChat).map((c) => ({
    id: c.id,
    title: typeof c.title === "string" && c.title ? c.title : chatTitle(c.messages as ChatMessage[]),
    messages: (c.messages as ChatMessage[]).filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    ),
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
  }));
}

export async function saveChats(api: PluginContext, chats: Chat[]): Promise<void> {
  // Only chats with messages are persisted; an empty "New
  // chat" is dropped, so the list never fills with blanks.
  const stored = chats.filter((c) => c.messages.length > 0);
  await api.storage.set(CHATS_KEY, stored);
}

export async function loadCurrentChatId(api: PluginContext): Promise<string | null> {
  const id = await api.storage.get(CURRENT_KEY);
  return typeof id === "string" ? id : null;
}

export async function saveCurrentChatId(api: PluginContext, id: string): Promise<void> {
  await api.storage.set(CURRENT_KEY, id);
}
