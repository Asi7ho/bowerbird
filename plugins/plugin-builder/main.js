// Plugin Builder: a chat panel. Describe a plugin, the
// AI builds it and puts it straight into the sandbox,
// and the only choice after a generation is Install
// Plugin or Clean Sandbox.
//
// There is no code to read, no separate steer box, and
// no trial banner: steering is just sending another
// message, and the two buttons are the trial. The
// assistant's reply is a plain-language summary of what
// the plugin adds and what it can do. Everything about
// the provider — address, model and key — lives in
// Settings, under Plugin settings, so the panel never
// asks for it.
//
// The AI is bring-your-own: you set a provider and model
// in Settings, and enter your key there. The key is only
// ever sent to the provider you set, and is saved once in
// secure storage (see the Settings status for whether
// your system encrypts it). A local model server needs
// no key: set the provider to http://localhost:11434/v1
// (or wherever it runs) and leave the key empty.
//
// Nothing is installed automatically. A generation runs
// in the sandbox in memory only — it is never written
// to disk, and Clean Sandbox (or quitting the app)
// removes it completely. Install Plugin installs it to
// your user plugins folder, then activates it at once,
// with no restart. Installing a plugin is trusting its
// code, like any plugin; trying it first is how you
// check it without having to read it.
//
// The AI never sees or changes the core of the app. It
// only writes a plugin, using the api object in its
// prompt. A request that would need a core change gets
// the closest plugin-only version, not a core edit.

let apiRef = null;
// The key, once saved, survives restarts: it lives in secure
// storage (encrypted by the OS keychain where the OS can
// encrypt, plain where it cannot — the Settings status says
// which), and is loaded into memory on activate. sessionKey
// is only a fallback for a save that failed: a key entered
// but not saved still works for this session.
let savedKey = "";
let sessionKey = "";
let chatEls = null;
// The plugin currently being tried, if any: { id, name }.
// Module-level, so it survives the panel being re-rendered
// when the user switches tabs — the chat log is rebuilt
// from chatHistory on every render, and only this trial's
// summary message keeps live buttons.
let trialState = null;
// The last generation, as a chat history, so a steer
// message refines that version instead of starting over:
// system prompt, first description, assistant JSON, then
// each steer message and its revised JSON.
let lastMessages = null;
let lastDescription = "";

const KNOWN_PERMISSIONS = [
  "board:write",
  "window",
  "view:replace",
  "files:read",
  "files:embed",
  "storage",
  "ai",
  "plugins:install",
];

// Permissions in plain language, for the summary card.
// A plugin can only do what is listed here, plus reading
// the board (which needs no permission) — and it can
// never change the app itself.
const PERMISSION_TEXT = {
  "board:write": "Can add, move and delete cards on your board",
  "window": "Can hide, show and minimise the app window",
  "view:replace": "Can replace the board with its own full view",
  "files:read": "Can read files and open links",
  "files:embed": "Can save files into your board",
  "storage": "Can save its own settings on this computer",
  "ai": "Can ask the AI provider you set in Settings",
  "plugins:install": "Can install other plugins",
};

// What the generated code adds, detected from the code
// itself — not from what the AI claimed in its description.
// Titles are taken from the registration call when the
// code gives one; otherwise the kind of thing is enough.
function detectedAdditions(main) {
  const out = [];
  const kinds = [
    ["registerPanel", "panel"],
    ["registerTool", "toolbar tool"],
    ["registerView", "full-board view"],
    ["registerCommand", "command (in Cmd/Ctrl+K)"],
    ["registerSettingsSection", "settings section"],
    ["registerOverlay", "overlay"],
    ["registerShortcut", "keyboard shortcut"],
  ];
  for (const [fn, label] of kinds) {
    let idx = main.indexOf(fn + "(");
    while (idx !== -1) {
      const slice = main.slice(idx, idx + 300);
      const title = slice.match(/title:\s*["'`]([^"'`]+)["'`]/);
      out.push(title ? `A ${label}: ${title[1]}` : `A ${label}`);
      idx = main.indexOf(fn + "(", idx + 1);
    }
  }
  const cardKinds = [...main.matchAll(/cards\.register\(\{\s*kind:\s*["'`]([^"'`]+)["'`]/g)];
  for (const m of cardKinds) out.push(`A new card kind: ${m[1]}`);
  return out;
}

const SYSTEM_PROMPT = `You write plugins for Bowerbird, a macOS-style infinite whiteboard app. API version is "1". Return JSON only, no markdown, no explanation outside the JSON, with exactly these fields: id, name, description, permissions, main, style.
- id: lowercase letters, digits and hyphens only, e.g. "my-plugin".
- name: a short human name. description: one sentence.
- permissions: a subset of ["board:write", "window", "view:replace", "files:read", "files:embed", "storage", "ai", "plugins:install"]. Reading the board needs no permission. Writing the board, adding cards, grouping, undo and redo need "board:write". Hiding, showing or minimising the window needs "window". Replacing the board with a view needs "view:replace". Opening links and reading files needs "files:read". Saving plugin settings needs "storage".
- The core of the app is not yours to know or change. You only write a plugin, using the api object below. Do not modify, reference or ask to change any core file (src/, electron/, package.json, or the app's own code), do not use window.bowerbird, ipcRenderer, contextBridge, or any API not listed below, and do not invent new core APIs. If what was asked would need a core change, say so in the description field and write the closest plugin-only version, without inventing a core feature.
- main: the complete contents of a single-file main.js. It must use named exports: export { activate, deactivate }. It must not use import, require, process, fs, child_process, eval, Function, fetch, or XMLHttpRequest. It must not use Node or the network, except through the api object below.
- style: the complete contents of style.css, or "" if the plugin needs no CSS. Panel CSS must be prefixed with .plugin-panel-body. View CSS must be prefixed with #plugin-view. Never use a global selector, and never style the board itself.
- activate(api) receives the api object. deactivate() must remove every listener it added, and close anything it opened.
The api object:
- api.board.get(), getItems(), getItem(id), renderCard(id), getSelected(), setSelected(ids), addItem(kind, pos, size), addPluginCard(kind, data, pos, size), updateItem(id, {pos, size, group, data}), moveItem(id, toIndex), removeItem(id), save(), render(), commitEditing(), groupSelected(), ungroupSelected(), deleteSelected(), undo(), redo(), canUndo(), canRedo(). A plugin may only rewrite its own plugin card's data. Board item kinds are Text, Image, UrlCard, PdfCard, Swatch, Audio, Video, and Plugin cards with { plugin, kind, data }.
- api.ui.registerPanel({id, title, icon, render}), registerTool({id, title, icon, onSelect}), registerCommand({id, title, run}), registerView({id, title, render, onShow, onHide}), registerOverlay({id, title, render}), registerSettingsSection({id, title, render}), registerShortcut({key, title, run}), showPanel(id), hidePanel(id), toast(msg), listCommands(), listTools(), runCommand(pluginId, id), setTool(id), openSettings(), closeSettings(), isSettingsOpen(). A panel's render(container) fills the container with DOM; a view's render(container, board) does the same for a full-board view. Tool icons and panel icons are SVG strings with no script tag.
- api.cards.register({kind, title, frame, render, onDoubleClick, searchText}). render(item) returns HTML for a plugin card. frame: true makes it a transparent frame card, hit after other cards.
- api.view.getCamera(), setCamera(cam), centreOn(id), getView(), setView(id), listViews().
- api.window.hide(), show(), minimise(), move(dx, dy), getCorner(), setCorner(corner).
- api.pen.getColor(), setColor(hex). The pen's colour, shared with the toolbar's pen swatches.
- api.files.embedFile(path), listLibrary(), createLibraryCategory(name), moveLibraryItem(path, category), addToLibrary(path), fileUrl(path), readTextFile(path), fileSize(path), openExternal(target), fetchPreview(url).
- api.storage.get(key), set(key, value), delete(key). Values must be JSON. Never store secrets here.
- api.events.on(event, handler), off(event, handler). Events are "board", "selection", "view", "tool", "pen".
- api.geometry.centre(item), anchorPoint(anchor), rectCrossing(from, to, pos, w, h, entry), clippedEnds(from, to), segmentIntersectsRect(a, b, rect), rectsOverlap(a, b).
- api.has(capability) reports whether a capability exists.
Write the simplest plugin that does what was asked, in the app's quiet style: white surfaces, hairline borders, core grey for secondary text, no accent colour unless the plugin itself is about colour. Do not add features that were not asked for.`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function validate(g) {
  const problems = [];
  if (!/^[a-z0-9-]+$/.test(g.id)) problems.push("Id must be lowercase letters, digits and hyphens.");
  if (!g.name.trim()) problems.push("Name is required.");
  if (!g.main.trim()) problems.push("Code is required.");
  if (!g.main.includes("activate")) problems.push("Code must export activate.");
  if (!g.main.includes("export")) problems.push("Code must use a named export, not a default export.");
  const banned = ["import ", "require(", "process.", "child_process", "eval(", "Function(", "fetch(", "XMLHttpRequest",
    "window.bowerbird", "ipcRenderer", "contextBridge", "src/main", "src/plugins"];
  for (const b of banned) {
    if (g.main.includes(b)) problems.push(`Code must not use ${b.trim()}. A plugin only uses the api object, never the core.`);
  }
  const unknown = g.permissions.filter((p) => !KNOWN_PERMISSIONS.includes(p));
  if (unknown.length) problems.push(`Unknown permission: ${unknown.join(", ")}.`);
  // A syntax check that never runs the code: new Function
  // parses but does not execute, and a plugin that fails
  // this will fail to load, so it should not be installed.
  // Plugin code is a module, so its export statements are
  // stripped for this check only; they are kept on install.
  try {
    const forParse = g.main
      .replace(/export\s*\{[^}]*\}\s*;?/g, "")
      .replace(/export\s+(?=function|const|let|class)/g, "");
    // eslint-disable-next-line no-new-func
    new Function(forParse);
  } catch (e) {
    problems.push(`Code does not parse: ${e.message}`);
  }
  return problems;
}

// Chat helpers for the Plugin Builder panel. The panel is a
// chat: the user describes a plugin, the assistant builds
// it and puts it straight into the sandbox, and the only
// choice after a generation is Install Plugin or Clean
// Sandbox. There is no code to read, no separate steer
// box, and no trial banner — steering is just sending
// another message, and the two buttons are the trial.
let chatHistory = [];
// chatHistory entries:
//   { kind: "user", text }
//   { kind: "assistant", text }
//   { kind: "summary", g, decided: null | "installed" | "cleaned" | "superseded" | "failed" | "working" }
// A summary entry's buttons are only live while its trial
// is the current one: decided is set on Install, Clean,
// a new generation superseding it, or a failed trial.

function scrollChatLog() {
  const log = chatEls && chatEls.log;
  if (log) log.scrollTop = log.scrollHeight;
}

function summaryMessageEl(entry) {
  const g = entry.g;
  const msg = el("div", "pres-builder-msg pres-builder-msg-assistant");
  msg.appendChild(el("div", "pres-builder-msg-name", g.name || "Unnamed plugin"));
  msg.appendChild(el("p", "pres-builder-msg-desc", g.description || "No description given."));
  const adds = detectedAdditions(g.main);
  const addsEl = el("ul", "pres-builder-msg-list");
  if (adds.length === 0) {
    addsEl.appendChild(el("li", "", "Nothing visible yet — tell me what to change and I'll try again."));
  } else {
    for (const a of adds) addsEl.appendChild(el("li", "", a));
  }
  msg.appendChild(addsEl);
  const permsEl = el("ul", "pres-builder-msg-list");
  if (g.permissions.length === 0) {
    permsEl.appendChild(el("li", "", "Needs no special access."));
  } else {
    for (const p of g.permissions) {
      permsEl.appendChild(el("li", "", PERMISSION_TEXT[p] || `Permission: ${p}`));
    }
  }
  msg.appendChild(permsEl);
  if (entry.decided === "failed") {
    msg.appendChild(el("p", "pres-builder-msg-note", "It didn't start. Tell me what to change and I'll try again."));
  } else if (entry.decided === "installed") {
    msg.appendChild(el("p", "pres-builder-msg-note", "Installed."));
  } else if (entry.decided === "cleaned") {
    msg.appendChild(el("p", "pres-builder-msg-note", "Sandbox cleaned."));
  } else {
    msg.appendChild(el("p", "pres-builder-msg-note",
      "It's running in the sandbox now — try its panel, tool or view, then choose below."));
  }
  const row = el("div", "pres-builder-msg-actions");
  const installBtn = el("button", "pres-builder-btn", "Install Plugin");
  const cleanBtn = el("button", "pres-builder-btn", "Clean Sandbox");
  const live = entry.decided === null && trialState && trialState.id === g.id;
  installBtn.disabled = !live;
  cleanBtn.disabled = !live;
  installBtn.addEventListener("click", () => void onInstallPlugin(entry));
  cleanBtn.addEventListener("click", () => void onCleanSandbox(entry));
  row.append(installBtn, cleanBtn);
  msg.appendChild(row);
  return msg;
}

function renderChatLog() {
  const log = chatEls && chatEls.log;
  if (!log) return;
  log.innerHTML = "";
  if (chatHistory.length === 0) {
    const welcome = el("div", "pres-builder-msg pres-builder-msg-assistant");
    welcome.appendChild(el("p", "pres-builder-msg-desc",
      "Describe the plugin you want, and I'll build it and put it in the sandbox for you to try."));
    log.appendChild(welcome);
    return;
  }
  for (const entry of chatHistory) {
    if (entry.kind === "user") {
      const msg = el("div", "pres-builder-msg pres-builder-msg-user");
      msg.appendChild(el("p", "pres-builder-msg-desc", entry.text));
      log.appendChild(msg);
    } else if (entry.kind === "assistant") {
      const msg = el("div", "pres-builder-msg pres-builder-msg-assistant");
      msg.appendChild(el("p", "pres-builder-msg-desc", entry.text));
      log.appendChild(msg);
    } else if (entry.kind === "summary") {
      log.appendChild(summaryMessageEl(entry));
    }
  }
  scrollChatLog();
}

function pushChat(entry) {
  chatHistory.push(entry);
  renderChatLog();
}

function setChatBusy(busy) {
  if (!chatEls) return;
  chatEls.input.disabled = busy;
  chatEls.send.disabled = busy;
}

async function onInstallPlugin(entry) {
  const g = entry.g;
  if (!trialState || trialState.id !== g.id) return;
  entry.decided = "working";
  renderChatLog();
  let ended = false;
  try {
    // End the trial first: installing the same id while
    // the trial is still loaded would leave the real
    // plugin unactivated, because refresh skips ids
    // already loaded.
    await apiRef.plugins.endTrial(g.id);
    ended = true;
    trialState = null;
    await apiRef.plugins.install({
      id: g.id,
      name: g.name,
      description: g.description,
      permissions: g.permissions,
      mainCode: g.main,
      styleCode: g.style,
    });
    await apiRef.plugins.refresh();
    entry.decided = "installed";
    pushChat({ kind: "assistant", text: `Installed ${g.name}. Find it in Settings → Plugins, and in its panel, view or tool.` });
    apiRef.ui.toast(`Installed ${g.name}`);
  } catch (e) {
    if (ended) trialState = null;
    entry.decided = "failed";
    pushChat({ kind: "assistant", text: `Installing failed: ${e.message} — send a message to try again.` });
  }
}

async function onCleanSandbox(entry) {
  const g = entry.g;
  if (!trialState || trialState.id !== g.id) return;
  entry.decided = "working";
  renderChatLog();
  try {
    await apiRef.plugins.endTrial(g.id);
  } catch { /* already gone: clean still means gone */ }
  trialState = null;
  entry.decided = "cleaned";
  pushChat({ kind: "assistant", text: `Sandbox cleaned. ${g.name} is gone, nothing was installed. If it added cards to your board, those cards stay as placeholders — delete them if you don't want them.` });
}

async function onChatSend() {
  if (!chatEls) return;
  const text = chatEls.input.value.trim();
  if (!text) return;
  chatEls.input.value = "";
  // Back to its starting height for the next message.
  chatEls.input.style.height = "";
  chatEls.input.style.overflowY = "hidden";
  pushChat({ kind: "user", text });
  setChatBusy(true);
  try {
    // A new message supersedes the running trial: the
    // next generation replaces it, so the old plugin
    // must not stay in the sandbox alongside the new one.
    if (trialState) {
      const old = chatHistory.find((e) => e.kind === "summary" && e.g.id === trialState.id);
      try { await apiRef.plugins.endTrial(trialState.id); } catch { /* already gone */ }
      trialState = null;
      if (old) old.decided = "superseded";
      renderChatLog();
    }
    const messages = lastMessages
      ? [...lastMessages, { role: "user", content: text }]
      : [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }];
    const { raw, parsed } = await runChat(messages, null, chatEls.send);
    lastMessages = [...messages, { role: "assistant", content: raw }];
    const g = {
      id: typeof parsed.id === "string" ? parsed.id : "",
      name: typeof parsed.name === "string" ? parsed.name : "",
      description: typeof parsed.description === "string" ? parsed.description : "",
      permissions: Array.isArray(parsed.permissions) ? parsed.permissions : [],
      main: typeof parsed.main === "string" ? parsed.main : "",
      style: typeof parsed.style === "string" ? parsed.style : "",
    };
    const problems = validate(g);
    if (problems.length > 0) {
      // No code problems in the chat: a non-coder cannot
      // act on them, so the reply is just "try again in
      // words", and the next message refines the attempt.
      pushChat({ kind: "assistant", text: "That one didn't come out right — tell me what to change and I'll try again." });
      return;
    }
    const entry = { kind: "summary", g, decided: null };
    pushChat(entry);
    try {
      await apiRef.plugins.try({
        id: g.id,
        name: g.name,
        description: g.description,
        permissions: g.permissions,
        mainCode: g.main,
        styleCode: g.style,
      });
      trialState = { id: g.id, name: g.name };
      renderChatLog();
      apiRef.ui.toast(`Trying ${g.name} — not installed yet`);
    } catch (e) {
      entry.decided = "failed";
      pushChat({ kind: "assistant", text: `It didn't start: ${e.message} — tell me what to change.` });
    }
  } catch (e) {
    pushChat({ kind: "assistant", text: e.message });
  } finally {
    setChatBusy(false);
    chatEls.input.focus();
  }
}

async function loadProviderSettings() {
  // Settings live in Settings, not in the panel, so read
  // them fresh on every generation: a change in Settings
  // applies to the next Generate without reopening this
  // panel. Defaults are only a fallback for a user who
  // has never opened Settings.
  let saved = null;
  try {
    saved = await apiRef.storage.get("settings");
  } catch { /* defaults stand */ }
  const baseUrl = saved && typeof saved.baseUrl === "string" && saved.baseUrl.trim()
    ? saved.baseUrl.trim() : "https://api.openai.com/v1";
  const model = saved && typeof saved.model === "string" && saved.model.trim()
    ? saved.model.trim() : "gpt-4o-mini";
  return { baseUrl, model };
}

async function loadSavedKey() {
  try {
    const k = await apiRef.secureStorage.get("apiKey");
    if (typeof k === "string" && k) savedKey = k;
  } catch { /* no saved key yet */ }
}

async function runChat(messages, statusEl, busyBtn) {
  const { baseUrl, model } = await loadProviderSettings();
  await loadSavedKey();
  const key = savedKey || sessionKey;
  const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(baseUrl + "/");
  if (!key && !isLocal) {
    throw new Error("Enter an API key in Settings → Plugin settings → Plugin Builder, or point the provider at a local model.");
  }
  busyBtn.disabled = true;
  try {
    const raw = await apiRef.ai.chat({
      baseUrl,
      model,
      key,
      messages,
    });
    const jsonText = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error(`The provider did not return JSON. It said: ${raw.slice(0, 500)}`);
    }
    return { raw, parsed };
  } finally {
    busyBtn.disabled = false;
  }
}

function renderSettings(container) {
  container.innerHTML = "";
  const wrap = el("div", "pres-builder");
  const baseLabel = el("label", "pres-builder-label", "Provider address");
  const base = el("input", "pres-builder-input");
  base.type = "text";
  base.placeholder = "https://api.openai.com/v1";
  const modelLabel = el("label", "pres-builder-label", "Model");
  const model = el("input", "pres-builder-input");
  model.type = "text";
  model.placeholder = "gpt-4o-mini";
  const keyLabel = el("label", "pres-builder-label", "API key (saved once, so you don't retype it)");
  const key = el("input", "pres-builder-input");
  key.type = "password";
  key.placeholder = "Leave empty for a local model, or to keep the saved key";
  key.autocomplete = "off";
  const row = el("div", "pres-builder-row");
  const save = el("button", "pres-builder-btn", "Save provider");
  const forget = el("button", "pres-builder-btn", "Forget key");
  row.append(save, forget);
  const status = el("div", "pres-builder-status", "Loading saved key…");
  const help = el("p", "pres-builder-help",
    "Your key is only sent to the provider you set above. " +
    "It is saved once, in secure storage — encrypted by your system's keychain where the system can encrypt it — " +
    "so you don't have to type it again after a restart. " +
    "Provider and model are saved on this computer, in plugin storage. " +
    "Calls are charged by your provider. The AI only writes plugins, using the plugin api — it never sees or changes the core of the app.");
  wrap.append(baseLabel, base, modelLabel, model, keyLabel, key, row, status, help);
  container.appendChild(wrap);

  // Saved provider, model and key: an empty key field keeps
  // the saved key, it does not clear it — only Forget does.
  const refreshStatus = async () => {
    await loadSavedKey();
    let encrypted = true;
    try { encrypted = await apiRef.secureStorage.available(); } catch { /* assume encrypted */ }
    if (savedKey) {
      status.textContent = encrypted
        ? "Key saved, encrypted by your system's keychain. You won't need to type it again."
        : "Key saved, but your system can't encrypt it — it is stored on this computer in plain text. Anyone with access to this computer could read it.";
    } else if (sessionKey) {
      status.textContent = "Key entered for this session only (it could not be saved).";
    } else {
      status.textContent = "No key saved yet.";
    }
  };
  apiRef.storage.get("settings").then((saved) => {
    if (saved && typeof saved === "object") {
      if (typeof saved.baseUrl === "string") base.value = saved.baseUrl;
      if (typeof saved.model === "string") model.value = saved.model;
    }
  }).catch(() => {});
  void refreshStatus();

  save.addEventListener("click", async () => {
    const baseUrl = base.value.trim() || "https://api.openai.com/v1";
    const modelName = model.value.trim() || "gpt-4o-mini";
    base.value = baseUrl;
    model.value = modelName;
    const newKey = key.value.trim();
    key.value = "";
    try {
      await apiRef.storage.set("settings", { baseUrl, model: modelName });
      if (newKey) {
        try {
          await apiRef.secureStorage.set("apiKey", newKey);
          savedKey = newKey;
          sessionKey = "";
        } catch {
          // Saving failed: keep it for this session, and say so.
          sessionKey = newKey;
        }
      }
      await refreshStatus();
      status.textContent = "Provider saved. " + status.textContent;
    } catch (e) {
      status.textContent = `Could not save provider: ${e.message}`;
    }
  });

  forget.addEventListener("click", async () => {
    savedKey = "";
    sessionKey = "";
    key.value = "";
    try { await apiRef.secureStorage.delete("apiKey"); } catch { /* already gone */ }
    status.textContent = "Key forgotten.";
  });
}

function initPanel(container) {
  container.innerHTML = "";
  const wrap = el("div", "pres-builder pres-builder-chat");
  const log = el("div", "pres-builder-log");
  const inputRow = el("div", "pres-builder-chat-input-row");
  const input = el("textarea", "pres-builder-input pres-builder-text");
  input.placeholder = "A panel that lists every image on the board, with a button to duplicate each one.";
  input.rows = 5;
  const send = el("button", "pres-builder-btn pres-builder-send");
  // Icon only, no text: a paper plane, in the app's
  // line-icon style, so the button takes as little of
  // the row as possible and the text box gets the rest.
  send.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
  send.setAttribute("aria-label", "Send");
  send.title = "Send (Enter)";
  inputRow.append(input, send);
  wrap.append(log, inputRow);
  container.appendChild(wrap);
  chatEls = { log, input, send };
  renderChatLog();
  // The box starts tall and grows as you type, up to a
  // cap, then scrolls internally — a two-row box is too
  // small for describing a plugin.
  const autosize = () => {
    input.style.height = "auto";
    const h = Math.min(input.scrollHeight, 180);
    input.style.height = h + "px";
    input.style.overflowY = input.scrollHeight > 180 ? "auto" : "hidden";
  };
  input.addEventListener("input", autosize);
  autosize();
  send.addEventListener("click", () => void onChatSend());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onChatSend();
    }
  });
}

function activate(api) {
  apiRef = api;
  // Load the saved key early, so sending a message works
  // without opening Settings first — that was the whole
  // point of saving it.
  void loadSavedKey();
  api.ui.registerPanel({
    id: "builder",
    title: "Plugin Builder",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><path d="M19 15l1 2.5L22.5 19 20 20l-1 2.5L18 20l-2.5-1L18 17.5z" fill="currentColor" stroke="none"/></svg>',
    render: (container) => initPanel(container),
  });
  api.ui.registerSettingsSection({
    id: "provider",
    title: "Plugin Builder",
    render: (container) => renderSettings(container),
  });
}

async function deactivate() {
  // If a trial is running, end it: without the Builder
  // panel there are no Install/Clean buttons for it, and
  // a trial must never be left running with no way to
  // remove it.
  if (trialState && apiRef) {
    try { await apiRef.plugins.endTrial(trialState.id); } catch { /* already gone */ }
  }
  trialState = null;
  chatHistory = [];
  // Only the in-memory copy is cleared here: the saved key
  // stays in secure storage, so disabling and re-enabling
  // the plugin does not make the user retype it. Forget
  // in Settings is what deletes the saved key.
  savedKey = "";
  sessionKey = "";
  chatEls = null;
  lastMessages = null;
  lastDescription = "";
}

export { activate, deactivate };
