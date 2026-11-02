// Plugin Builder: describe a plugin, an AI writes it, you
// try it, and only then keep it — or discard it.
//
// The panel is deliberately small for a person who does
// not code: a box to describe the plugin, a Generate
// button, then a plain-language summary of what the
// plugin adds and what it can do. The code is behind a
// "Show code" button, for people who want it — you do
// not need to read it to try the plugin. Everything
// about the provider — address, model and key — lives
// in Settings, under Plugin settings, so the panel
// never asks for it.
//
// The AI is bring-your-own: you set a provider and model
// in Settings, and enter your key there. The key is only
// ever sent to the provider you set, and is saved once in
// secure storage (see the Settings status for whether
// your system encrypts it). A local model server needs
// no key: set the provider to http://localhost:11434/v1
// (or wherever it runs) and leave the key empty.
//
// Nothing is installed automatically. Try runs the
// plugin in memory only — it is never written to disk,
// and Discard (or quitting the app) removes it
// completely. Keep installs it to your user plugins
// folder, then activates it at once, with no restart.
// Installing a plugin is trusting its code, like any
// plugin; trying it first is how you check it without
// having to read it.
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
let panelEls = null;
// The plugin currently being tried, if any: { id, name }.
// Module-level, so it survives the panel being re-rendered
// when the user switches tabs — the panel restores the
// trial banner from this on every render.
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

function renderSummary(g) {
  const e = panelEls;
  if (!e) return;
  e.summaryName.textContent = g.name || "Unnamed plugin";
  e.summaryDesc.textContent = g.description || "No description given.";
  e.summaryAdds.innerHTML = "";
  const adds = detectedAdditions(g.main);
  if (adds.length === 0) {
    e.summaryAdds.appendChild(el("li", "pres-builder-summary-item",
      "Nothing visible yet — it may only work in the background, or the AI may have missed what you asked for. Tell it what to change below."));
  } else {
    for (const a of adds) e.summaryAdds.appendChild(el("li", "pres-builder-summary-item", a));
  }
  e.summaryPerms.innerHTML = "";
  if (g.permissions.length === 0) {
    e.summaryPerms.appendChild(el("li", "pres-builder-summary-item", "Needs no special access."));
  } else {
    for (const p of g.permissions) {
      e.summaryPerms.appendChild(el("li", "pres-builder-summary-item",
        PERMISSION_TEXT[p] || `Permission: ${p}`));
    }
  }
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

function readGenerated() {
  const e = panelEls;
  return {
    id: e.id.value.trim(),
    name: e.name.value.trim(),
    description: e.desc.value.trim(),
    permissions: e.perms.value.split(",").map((p) => p.trim()).filter(Boolean),
    main: e.main.value,
    style: e.style.value,
  };
}

function showValidation(g) {
  const problems = validate(g);
  panelEls.validation.innerHTML = "";
  if (problems.length === 0) {
    panelEls.validation.appendChild(el("div", "pres-builder-ok", "Ready to try."));
  } else {
    for (const p of problems) panelEls.validation.appendChild(el("div", "pres-builder-bad", p));
  }
  // Try and Install share the same gate: a plugin that does
  // not pass validation is not tried either, because a
  // failed trial tells a non-coder nothing useful.
  if (panelEls.tryBtn) panelEls.tryBtn.disabled = problems.length > 0;
  panelEls.install.disabled = problems.length > 0;
  return problems.length === 0;
}

function fillGenerated(parsed) {
  const e = panelEls;
  e.id.value = typeof parsed.id === "string" ? parsed.id : "";
  e.name.value = typeof parsed.name === "string" ? parsed.name : "";
  e.desc.value = typeof parsed.description === "string" ? parsed.description : "";
  e.perms.value = Array.isArray(parsed.permissions) ? parsed.permissions.join(", ") : "";
  e.main.value = typeof parsed.main === "string" ? parsed.main : "";
  e.style.value = typeof parsed.style === "string" ? parsed.style : "";
  e.resultWrap.style.display = "";
  renderSummary(readGenerated());
  const ok = showValidation(readGenerated());
  return ok;
}

// Restore the trial banner and button state when the panel
// is re-rendered while a trial is running (tab switch).
function restoreTrialUI() {
  const e = panelEls;
  if (!e || !trialState) return;
  e.trialName.textContent = trialState.name;
  e.trialWrap.style.display = "";
  e.tryBtn.disabled = true;
  e.install.disabled = true;
  if (e.gen) e.gen.disabled = true;
  if (e.refine) e.refine.disabled = true;
  e.trialStatus.textContent = "Trying — try its panel, tool or view, then Keep it or Discard it.";
}

function setTrialUI(active) {
  const e = panelEls;
  if (!e) return;
  e.trialWrap.style.display = active ? "" : "none";
  if (active) {
    e.trialName.textContent = trialState ? trialState.name : "";
    e.tryBtn.disabled = true;
    e.install.disabled = true;
    if (e.gen) e.gen.disabled = true;
    if (e.refine) e.refine.disabled = true;
  } else {
    e.tryBtn.disabled = false;
    e.install.disabled = false;
    if (e.gen) e.gen.disabled = false;
    if (e.refine) e.refine.disabled = false;
    showValidation(readGenerated());
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
  const wrap = el("div", "pres-builder");
  const askH = el("h3", "pres-builder-h", "Describe the plugin");
  const ask = el("textarea", "pres-builder-input pres-builder-text");
  ask.placeholder = "A panel that lists every image on the board, with a button to duplicate each one.";
  ask.rows = 4;
  const gen = el("button", "pres-builder-btn pres-builder-wide", "Generate");
  const genStatus = el("div", "pres-builder-status");
  const settingsHint = el("p", "pres-builder-help",
    "Provider, model and key live in Settings → Plugin settings → Plugin Builder.");

  const resultWrap = el("div", "pres-builder-result");
  resultWrap.style.display = "none";
  // The summary card comes first, and is the whole review
  // for a person who does not code: what the plugin is,
  // what it adds, and what it can do, in plain language.
  const summary = el("div", "pres-builder-summary");
  const summaryName = el("div", "pres-builder-summary-name");
  const summaryDesc = el("p", "pres-builder-summary-desc");
  const addsH = el("div", "pres-builder-summary-h", "What you'll get");
  const summaryAdds = el("ul", "pres-builder-summary-list");
  const permsH = el("div", "pres-builder-summary-h", "What it can do");
  const summaryPerms = el("ul", "pres-builder-summary-list");
  const summaryNote = el("p", "pres-builder-summary-note",
    "It can only do what is listed above, plus reading your board. It can never change the app itself.");
  summary.append(summaryName, summaryDesc, addsH, summaryAdds, permsH, summaryPerms, summaryNote);

  // The trial banner, shown only while a trial is running.
  const trialWrap = el("div", "pres-builder-trial");
  trialWrap.style.display = "none";
  const trialText = el("div", "pres-builder-trial-text");
  const trialName = el("strong", "", "");
  trialText.append("Trying ", trialName, " — it is not installed yet.");
  const trialNote = el("p", "pres-builder-trial-note",
    "Try its panel, tool or view. If it changes your board, you can undo that with Ctrl+Z / Cmd+Z. " +
    "A plugin being tried cannot install other plugins, or create, rename or delete boards. " +
    "If you discard it, it is gone completely — but any cards it added stay as placeholders, so delete them if you don't want them.");
  const trialRow = el("div", "pres-builder-row");
  const keepBtn = el("button", "pres-builder-btn", "Keep it");
  const discardBtn = el("button", "pres-builder-btn", "Discard");
  trialRow.append(keepBtn, discardBtn);
  const trialStatus = el("div", "pres-builder-status");
  trialWrap.append(trialText, trialNote, trialRow, trialStatus);

  const resultRow = el("div", "pres-builder-row");
  const tryBtn = el("button", "pres-builder-btn", "Try it");
  tryBtn.disabled = true;
  const install = el("button", "pres-builder-btn", "Install without trying");
  install.disabled = true;
  resultRow.append(tryBtn, install);
  const installStatus = el("div", "pres-builder-status");
  const validation = el("div", "pres-builder-validation");

  // The code, behind a button — there for people who want
  // it, not in the way of people who don't. Name and
  // description stay editable here, and the summary above
  // follows them.
  const showCodeBtn = el("button", "pres-builder-btn pres-builder-wide", "Show code");
  const codeWrap = el("div", "pres-builder-codewrap");
  codeWrap.style.display = "none";
  const idLabel = el("label", "pres-builder-label", "Id");
  const id = el("input", "pres-builder-input");
  const nameLabel = el("label", "pres-builder-label", "Name");
  const name = el("input", "pres-builder-input");
  const descLabel = el("label", "pres-builder-label", "Description");
  const desc = el("input", "pres-builder-input");
  const permsLabel = el("label", "pres-builder-label", "Permissions, comma-separated");
  const perms = el("input", "pres-builder-input");
  const mainLabel = el("label", "pres-builder-label", "main.js");
  const main = el("textarea", "pres-builder-input pres-builder-code");
  main.rows = 20;
  main.spellcheck = false;
  const styleLabel = el("label", "pres-builder-label", "style.css");
  const style = el("textarea", "pres-builder-input pres-builder-code");
  style.rows = 10;
  style.spellcheck = false;
  codeWrap.append(idLabel, id, nameLabel, name, descLabel, desc, permsLabel, perms,
    mainLabel, main, styleLabel, style);

  const steerH = el("h3", "pres-builder-h", "Not quite right? Tell it what to change");
  const steer = el("textarea", "pres-builder-input pres-builder-text");
  steer.placeholder = "Make the list show swatches too, and sort it by size.";
  steer.rows = 3;
  const refine = el("button", "pres-builder-btn pres-builder-wide", "Refine with this");
  const help = el("p", "pres-builder-help",
    "Trying a plugin does not install it. Keeping it installs it, like any plugin — and a plugin you keep " +
    "is trusting its code. The AI only writes plugins — it never sees or changes the core of the app.");
  resultWrap.append(summary, trialWrap, resultRow, installStatus, validation,
    showCodeBtn, codeWrap, steerH, steer, refine, help);

  wrap.append(askH, ask, gen, genStatus, settingsHint, resultWrap);
  container.appendChild(wrap);

  panelEls = { ask, gen, genStatus, resultWrap, id, name, desc, perms, main, style,
    steer, refine, validation, install, installStatus, tryBtn, keepBtn, discardBtn,
    trialWrap, trialName, trialStatus, summaryName, summaryDesc, summaryAdds, summaryPerms,
    showCodeBtn, codeWrap };
  name.addEventListener("input", () => { panelEls.summaryName.textContent = name.value.trim() || "Unnamed plugin"; });
  desc.addEventListener("input", () => { panelEls.summaryDesc.textContent = desc.value.trim() || "No description given."; });
  restoreTrialUI();

  gen.addEventListener("click", async () => {
    const description = ask.value.trim();
    if (!description) { genStatus.textContent = "Describe the plugin first."; return; }
    lastDescription = description;
    genStatus.textContent = "Generating…";
    try {
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: description },
      ];
      const { raw, parsed } = await runChat(messages, genStatus, gen);
      lastMessages = [...messages, { role: "assistant", content: raw }];
      const ok = fillGenerated(parsed);
      genStatus.textContent = ok
        ? "Generated. Try it below — or tell it what to change."
        : "Generated, with problems listed below. Tell it what to change below, instead of editing code.";
    } catch (e) {
      genStatus.textContent = `Generation failed: ${e.message}`;
    }
  });

  refine.addEventListener("click", async () => {
    const steerText = steer.value.trim();
    if (!steerText) { genStatus.textContent = "Write what to change first."; return; }
    if (!lastMessages) { genStatus.textContent = "Generate a plugin first, then steer it."; return; }
    genStatus.textContent = "Refining…";
    try {
      const messages = [...lastMessages, { role: "user", content: steerText }];
      const { raw, parsed } = await runChat(messages, genStatus, refine);
      lastMessages = [...messages, { role: "assistant", content: raw }];
      const ok = fillGenerated(parsed);
      steer.value = "";
      genStatus.textContent = ok
        ? "Refined. Try it below — or tell it what to change again."
        : "Refined, with problems listed below. Tell it what to change below, instead of editing code.";
    } catch (e) {
      genStatus.textContent = `Refinement failed: ${e.message}`;
    }
  });

  showCodeBtn.addEventListener("click", () => {
    const showing = codeWrap.style.display !== "none";
    codeWrap.style.display = showing ? "none" : "";
    showCodeBtn.textContent = showing ? "Show code" : "Hide code";
  });

  tryBtn.addEventListener("click", async () => {
    const g = readGenerated();
    if (!showValidation(g)) { installStatus.textContent = "It needs a fix first — tell the AI what to change below, instead of editing code."; return; }
    if (trialState) { installStatus.textContent = "You're already trying a plugin — Discard it first."; return; }
    tryBtn.disabled = true;
    installStatus.textContent = "Trying…";
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
      setTrialUI(true);
      installStatus.textContent = "";
      panelEls.trialStatus.textContent = "Trying — try its panel, tool or view, then Keep it or Discard it.";
      apiRef.ui.toast(`Trying ${g.name} — not installed yet`);
    } catch (e) {
      installStatus.textContent = `It didn't start: ${e.message}`;
      tryBtn.disabled = false;
    }
  });

  keepBtn.addEventListener("click", async () => {
    if (!trialState) return;
    const trialId = trialState.id;
    keepBtn.disabled = true;
    panelEls.trialStatus.textContent = "Keeping…";
    // End the trial first: installing the same id while the
    // trial is still loaded would leave the real plugin
    // unactivated, because refresh skips ids already loaded.
    let ended = false;
    try {
      await apiRef.plugins.endTrial(trialId);
      ended = true;
      trialState = null;
      const g = readGenerated();
      await apiRef.plugins.install({
        id: g.id,
        name: g.name,
        description: g.description,
        permissions: g.permissions,
        mainCode: g.main,
        styleCode: g.style,
      });
      await apiRef.plugins.refresh();
      setTrialUI(false);
      installStatus.textContent = `Kept ${g.name}. Find it in Settings → Plugins, and in its panel, view or tool.`;
      apiRef.ui.toast(`Kept ${g.name}`);
    } catch (e) {
      // If the trial already ended but the install failed,
      // the plugin is gone either way — clear the banner so
      // the user can fix it and Try again.
      if (ended) trialState = null;
      setTrialUI(false);
      installStatus.textContent = `Keeping failed: ${e.message}`;
      keepBtn.disabled = false;
    }
  });

  discardBtn.addEventListener("click", async () => {
    if (!trialState) return;
    const name = trialState.name;
    discardBtn.disabled = true;
    panelEls.trialStatus.textContent = "Discarding…";
    try {
      await apiRef.plugins.endTrial(trialState.id);
    } catch { /* already gone: discard still means gone */ }
    trialState = null;
    setTrialUI(false);
    discardBtn.disabled = false;
    installStatus.textContent = `Discarded ${name}. Nothing was installed, and it won't come back. If it added cards to your board, those cards stay as placeholders — delete them if you don't want them.`;
  });

  install.addEventListener("click", async () => {
    const g = readGenerated();
    if (trialState) { installStatus.textContent = "You're already trying a plugin — Keep it or Discard it first."; return; }
    if (!showValidation(g)) { installStatus.textContent = "It needs a fix first — tell the AI what to change below, instead of editing code."; return; }
    install.disabled = true;
    installStatus.textContent = "Installing…";
    try {
      await apiRef.plugins.install({
        id: g.id,
        name: g.name,
        description: g.description,
        permissions: g.permissions,
        mainCode: g.main,
        styleCode: g.style,
      });
      await apiRef.plugins.refresh();
      installStatus.textContent = `Installed ${g.name}. Find it in Settings → Plugins, and in its panel, view or tool.`;
      apiRef.ui.toast(`Installed ${g.name}`);
    } catch (e) {
      installStatus.textContent = `Install failed: ${e.message}`;
      install.disabled = false;
    }
  });
}

function activate(api) {
  apiRef = api;
  // Load the saved key early, so Generate works without
  // opening Settings first — that was the whole point of
  // saving it.
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
  // panel there is no Keep/Discard for it, and a trial
  // must never be left running with no way to remove it.
  if (trialState && apiRef) {
    try { await apiRef.plugins.endTrial(trialState.id); } catch { /* already gone */ }
  }
  trialState = null;
  // Only the in-memory copy is cleared here: the saved key
  // stays in secure storage, so disabling and re-enabling
  // the plugin does not make the user retype it. Forget
  // in Settings is what deletes the saved key.
  savedKey = "";
  sessionKey = "";
  panelEls = null;
  lastMessages = null;
  lastDescription = "";
}

export { activate, deactivate };
