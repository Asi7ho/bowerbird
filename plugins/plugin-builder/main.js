// Plugin Builder: describe a plugin, an AI writes it, you
// check the code, and only then install it.
//
// The panel is deliberately small: a box to describe the
// plugin, a Generate button, then the generated plugin,
// and a box to steer the AI if the first version is not
// right. Everything about the provider — address, model
// and key — lives in Settings, under Plugin settings, so
// the panel never asks for it.
//
// The AI is bring-your-own: you set a provider and model
// in Settings, and enter your key there. The key is never
// saved to disk, never put in a board, and never sent
// anywhere except the provider you set. It lives only in
// memory for this session, and is forgotten when the app
// closes or this plugin is disabled. The provider and
// model are not secrets, so those are saved in plugin
// storage. A local model server needs no key: set the
// provider to http://localhost:11434/v1 (or wherever it
// runs) and leave the key empty.
//
// Nothing is installed automatically. Generation only
// fills the code boxes below. Install writes the plugin
// to your user plugins folder, then activates it at
// once, with no restart. Installing a plugin is trusting
// its code, like any plugin, so read it first.
//
// The AI never sees or changes the core of the app. It
// only writes a plugin, using the api object in its
// prompt. A request that would need a core change gets
// the closest plugin-only version, not a core edit.

let apiRef = null;
// Session-only, never stored: see the note above.
let sessionKey = "";
let panelEls = null;
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
    panelEls.validation.appendChild(el("div", "pres-builder-ok", "Looks good. Read the code, then Install."));
  } else {
    for (const p of problems) panelEls.validation.appendChild(el("div", "pres-builder-bad", p));
  }
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
  const ok = showValidation(readGenerated());
  return ok;
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

async function runChat(messages, statusEl, busyBtn) {
  const { baseUrl, model } = await loadProviderSettings();
  const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(baseUrl + "/");
  if (!sessionKey && !isLocal) {
    throw new Error("Enter an API key in Settings → Plugin settings → Plugin Builder, or point the provider at a local model.");
  }
  busyBtn.disabled = true;
  try {
    const raw = await apiRef.ai.chat({
      baseUrl,
      model,
      key: sessionKey,
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
  const keyLabel = el("label", "pres-builder-label", "API key (this session only, never saved)");
  const key = el("input", "pres-builder-input");
  key.type = "password";
  key.placeholder = "Leave empty for a local model";
  key.autocomplete = "off";
  const row = el("div", "pres-builder-row");
  const save = el("button", "pres-builder-btn", "Save provider");
  const forget = el("button", "pres-builder-btn", "Forget key");
  row.append(save, forget);
  const status = el("div", "pres-builder-status",
    sessionKey ? "Key entered for this session." : "No key entered yet.");
  const help = el("p", "pres-builder-help",
    "Your key is only sent to the provider you set above, and is forgotten when the app closes. " +
    "Provider and model are saved on this computer, in plugin storage; the key never is. " +
    "Calls are charged by your provider. The AI only writes plugins, using the plugin api — it never sees or changes the core of the app.");
  wrap.append(baseLabel, base, modelLabel, model, keyLabel, key, row, status, help);
  container.appendChild(wrap);

  // Saved provider and model only; the key is never read back.
  apiRef.storage.get("settings").then((saved) => {
    if (saved && typeof saved === "object") {
      if (typeof saved.baseUrl === "string") base.value = saved.baseUrl;
      if (typeof saved.model === "string") model.value = saved.model;
    }
  }).catch(() => {});

  save.addEventListener("click", async () => {
    const baseUrl = base.value.trim() || "https://api.openai.com/v1";
    const modelName = model.value.trim() || "gpt-4o-mini";
    base.value = baseUrl;
    model.value = modelName;
    if (key.value) sessionKey = key.value;
    key.value = "";
    try {
      await apiRef.storage.set("settings", { baseUrl, model: modelName });
      status.textContent = sessionKey
        ? "Provider saved. Key entered for this session."
        : "Provider saved. No key entered yet.";
    } catch (e) {
      status.textContent = `Could not save provider: ${e.message}`;
    }
  });

  forget.addEventListener("click", () => {
    sessionKey = "";
    key.value = "";
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
  const resultH = el("h3", "pres-builder-h", "Generated plugin");
  const idLabel = el("label", "pres-builder-label", "Id");
  const id = el("input", "pres-builder-input");
  const nameLabel = el("label", "pres-builder-label", "Name");
  const name = el("input", "pres-builder-input");
  const descLabel = el("label", "pres-builder-label", "Description");
  const desc = el("input", "pres-builder-input");
  const permsLabel = el("label", "pres-builder-label", "Permissions, comma-separated");
  const perms = el("input", "pres-builder-input");
  const mainLabel = el("label", "pres-builder-label", "main.js — read this before installing");
  const main = el("textarea", "pres-builder-input pres-builder-code");
  main.rows = 20;
  main.spellcheck = false;
  const styleLabel = el("label", "pres-builder-label", "style.css");
  const style = el("textarea", "pres-builder-input pres-builder-code");
  style.rows = 10;
  style.spellcheck = false;
  const steerH = el("h3", "pres-builder-h", "Steer the AI");
  const steer = el("textarea", "pres-builder-input pres-builder-text");
  steer.placeholder = "Make the list show swatches too, and sort it by size.";
  steer.rows = 3;
  const refine = el("button", "pres-builder-btn pres-builder-wide", "Refine with this");
  const validation = el("div", "pres-builder-validation");
  const resultRow = el("div", "pres-builder-row");
  const check = el("button", "pres-builder-btn", "Check code");
  const install = el("button", "pres-builder-btn", "Install");
  install.disabled = true;
  resultRow.append(check, install);
  const installStatus = el("div", "pres-builder-status");
  const help = el("p", "pres-builder-help",
    "Installing a plugin is trusting its code, like any plugin. Read the code above before you press Install. " +
    "The AI only writes plugins — it never sees or changes the core of the app.");
  resultWrap.append(resultH, idLabel, id, nameLabel, name, descLabel, desc, permsLabel, perms,
    mainLabel, main, styleLabel, style, steerH, steer, refine, validation, resultRow, installStatus, help);

  wrap.append(askH, ask, gen, genStatus, settingsHint, resultWrap);
  container.appendChild(wrap);

  panelEls = { ask, gen, genStatus, resultWrap, id, name, desc, perms, main, style,
    steer, refine, validation, check, install, installStatus };

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
        ? "Generated. Read the code below, then Install — or steer it further."
        : "Generated, with problems listed below. Fix the code, then Check code again.";
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
        ? "Refined. Read the code below, then Install — or steer it again."
        : "Refined, with problems listed below. Fix the code, then Check code again.";
    } catch (e) {
      genStatus.textContent = `Refinement failed: ${e.message}`;
    }
  });

  check.addEventListener("click", () => {
    showValidation(readGenerated());
    installStatus.textContent = "";
  });

  install.addEventListener("click", async () => {
    const g = readGenerated();
    if (!showValidation(g)) { installStatus.textContent = "Fix the problems above first."; return; }
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

function deactivate() {
  // The key is session-only by design: forgetting it here
  // means disabling the plugin forgets it too, not just
  // closing the app.
  sessionKey = "";
  panelEls = null;
  lastMessages = null;
  lastDescription = "";
}

export { activate, deactivate };
