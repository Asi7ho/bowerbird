// AI — settings. The provider, the API key and the model.
//
// The key is the only secret: it lives in secure storage (the OS
// keychain where the OS can encrypt), never in plain storage and
// never in the chat. The provider and model are plain settings.
// The key is never shown back — the settings only say whether
// one is saved.
import type { PluginContext } from "../../src/plugins";

export interface Provider {
  id: string;
  label: string;
  base: string;
  defaultModel: string;
}

export const PROVIDERS: Provider[] = [
  { id: "openai", label: "OpenAI", base: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { id: "ollama", label: "Ollama Cloud", base: "https://ollama.com/v1", defaultModel: "gpt-oss:120b" },
];

export function providerById(id: string): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export interface AiConfig {
  base: string;
  key: string;
  model: string;
}

const KEY_KEY = "apiKey";
const PROVIDER_KEY = "provider";
const MODEL_KEY = "model";

export async function getConfig(api: PluginContext): Promise<AiConfig | null> {
  const providerId = (await api.storage.get(PROVIDER_KEY)) as string | undefined;
  const provider = providerById(typeof providerId === "string" ? providerId : "openai");
  const key = (await api.secureStorage.get(KEY_KEY)) as string | undefined;
  if (typeof key !== "string" || !key.trim()) return null;
  const model = (await api.storage.get(MODEL_KEY)) as string | undefined;
  return {
    base: provider.base,
    key: key.trim(),
    model: typeof model === "string" && model.trim() ? model.trim() : provider.defaultModel,
  };
}

export async function hasKey(api: PluginContext): Promise<boolean> {
  const key = (await api.secureStorage.get(KEY_KEY)) as string | undefined;
  return typeof key === "string" && key.trim().length > 0;
}

export function renderSettings(api: PluginContext, container: HTMLElement): void {
  container.textContent = "";

  const intro = document.createElement("p");
  intro.textContent = "Chat with an AI. Paste your API key and it just works.";
  container.appendChild(intro);

  // Provider.
  const providerField = document.createElement("div");
  providerField.className = "ai-field";
  const providerLabel = document.createElement("label");
  providerLabel.textContent = "Provider";
  const providerSelect = document.createElement("select");
  for (const p of PROVIDERS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    providerSelect.appendChild(opt);
  }
  providerField.appendChild(providerLabel);
  providerField.appendChild(providerSelect);
  container.appendChild(providerField);

  // API key.
  const keyField = document.createElement("div");
  keyField.className = "ai-field";
  const keyLabel = document.createElement("label");
  keyLabel.textContent = "API key";
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.placeholder = "Paste your API key";
  keyInput.autocomplete = "off";
  keyField.appendChild(keyLabel);
  keyField.appendChild(keyInput);
  container.appendChild(keyField);

  const keyState = document.createElement("p");
  keyState.className = "ai-key-state";
  container.appendChild(keyState);

  // Model.
  const modelField = document.createElement("div");
  modelField.className = "ai-field";
  const modelLabel = document.createElement("label");
  modelLabel.textContent = "Model";
  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.autocomplete = "off";
  modelField.appendChild(modelLabel);
  modelField.appendChild(modelInput);
  container.appendChild(modelField);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  container.appendChild(saveBtn);

  const refresh = async (): Promise<void> => {
    const providerId = (await api.storage.get(PROVIDER_KEY)) as string | undefined;
    const provider = providerById(typeof providerId === "string" ? providerId : "openai");
    providerSelect.value = provider.id;
    const model = (await api.storage.get(MODEL_KEY)) as string | undefined;
    modelInput.value = typeof model === "string" && model.trim() ? model : provider.defaultModel;
    modelInput.placeholder = provider.defaultModel;
    const saved = await hasKey(api);
    keyState.textContent = saved ? "Key saved." : "No key saved yet.";
    keyInput.value = "";
    keyInput.placeholder = saved ? "Saved — paste a new key to replace it" : "Paste your API key";
  };

  providerSelect.addEventListener("change", async () => {
    const provider = providerById(providerSelect.value);
    await api.storage.set(PROVIDER_KEY, provider.id);
    // A new provider gets its default model; the user can change it after.
    await api.storage.set(MODEL_KEY, provider.defaultModel);
    await refresh();
  });

  saveBtn.addEventListener("click", async () => {
    const provider = providerById(providerSelect.value);
    await api.storage.set(PROVIDER_KEY, provider.id);
    const model = modelInput.value.trim();
    await api.storage.set(MODEL_KEY, model || provider.defaultModel);
    const key = keyInput.value.trim();
    if (key) {
      await api.secureStorage.set(KEY_KEY, key);
    }
    await refresh();
    saveBtn.textContent = "Saved";
    window.setTimeout(() => {
      saveBtn.textContent = "Save";
    }, 1500);
  });

  void refresh();
}
