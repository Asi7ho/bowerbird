// Hello Card — sample plugin for Bowerbird Plugin API v1.
// See PLUGIN_API.md in the repo root. Copy this folder to start
// a new plugin; keep the manifest and the activate() shape, and
// replace the Hello card with your own kind.
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function activate(api) {
  // Storage: count activations, so the file in userData proves
  // the storage API works without any UI for it.
  api.storage.get("helloCount").then((v) => {
    const n = typeof v === "number" ? v + 1 : 1;
    api.storage.set("helloCount", n).catch(() => undefined);
  }).catch(() => undefined);

  // Card kind: renders its data, with a button that increments
  // its own greet count through the board API (a plugin may only
  // rewrite its own plugin card data — see PLUGIN_API.md).
  api.cards.register({
    kind: "Hello",
    title: "Hello card",
    render: (item, data) => {
      data = data || {};
      const greets = typeof data.greets === "number" ? data.greets : 0;
      return `<div style="padding:12px"><div class="title" style="font-size:14px">Hello</div>`
        + `<div style="font-size:13px">${escapeHtml(data.text ?? "Hello!")}</div>`
        + (greets > 0 ? `<div class="sub" style="font-size:12px">Greeted ${greets} time${greets === 1 ? "" : "s"}</div>` : "")
        + `<button data-plugin-action="greet" data-id="${item.id}">Say hello</button></div>`;
    },
    onAction: (action, item, data) => {
      if (action !== "greet") return;
      data = data || {};
      const greets = (typeof data.greets === "number" ? data.greets : 0) + 1;
      api.board.updateItem(item.id, { data: { ...data, greets } });
      api.ui.toast(`Hello from card ${item.id}!`);
    },
    onDoubleClick: (item) => {
      api.ui.toast(`Hello card ${item.id} double-clicked`);
    },
    searchText: (data) => (data && data.text ? String(data.text) : ""),
  });

  // Tool: click the board to stamp a Hello card there.
  api.ui.registerTool({
    id: "stamp",
    title: "Hello stamp",
    icon: `<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18" /></svg>`,
    onMouseDown: (world) => {
      api.board.addPluginCard("Hello", { text: "Stamped hello", greets: 0 },
        { x: Math.round(world.x - 130), y: Math.round(world.y - 48) }, { w: 260, h: 96 });
    },
  });

  // Panel: shows board and selection counts, updated on events.
  // The panel body is rendered once on registration; events keep
  // it fresh afterwards.
  function updatePanel() {
    const body = api.ui.getPanelElement("hello");
    if (!body) return;
    const countEl = body.querySelector("[data-hello-count]");
    if (!countEl) return;
    const items = api.board.getItems();
    const selected = api.board.getSelected();
    countEl.textContent = `Board has ${items.length} items, ${selected.length} selected.`;
  }
  api.ui.registerPanel({
    id: "hello",
    title: "Hello",
    render: (container) => {
      container.innerHTML = `<p data-hello-count>Loading…</p><button data-hello-add>Add a hello card</button>`;
      const btn = container.querySelector("[data-hello-add]");
      if (btn) {
        btn.addEventListener("click", () => {
          const cam = api.view.getCamera();
          const cx = cam.x + window.innerWidth / 2 / cam.zoom - 130;
          const cy = cam.y + window.innerHeight / 2 / cam.zoom - 48;
          api.board.addPluginCard("Hello", { text: "Hello from the panel", greets: 0 }, { x: Math.round(cx), y: Math.round(cy) }, { w: 260, h: 96 });
        });
      }
      updatePanel();
    },
  });
  api.events.on("board", updatePanel);
  api.events.on("selection", updatePanel);

  // Command: add a Hello card at a fixed spot, from Settings.
  api.ui.registerCommand({
    id: "add-hello",
    title: "Add a hello card",
    run: () => {
      api.board.addPluginCard("Hello", { text: "Hello from command", greets: 0 }, { x: 100, y: 100 }, { w: 260, h: 96 });
    },
  });

  // View: a list view of the board, proving canvas replacement.
  // Clicking a list item selects it, centres on it, and returns
  // to the 2D board — the core-owned way back, plus a plugin way.
  api.ui.registerView({
    id: "list",
    title: "List view",
    render: (container, board) => {
      const rows = board.items.filter((it) => {
        const k = Object.keys(it.kind)[0];
        return k !== "Stroke" && k !== "Connector";
      }).map((it) => {
        const k = it.kind;
        let label = Object.keys(k)[0];
        if (k.Text) label = `Note: ${k.Text.text.slice(0, 40)}`;
        else if (k.Plugin) label = `Plugin: ${k.Plugin.plugin} / ${k.Plugin.kind}`;
        else if (k.Image) label = `Image: ${String(k.Image.path).split("/").pop()}`;
        return `<li><button data-list-id="${it.id}">${escapeHtml(label)}</button></li>`;
      }).join("");
      container.innerHTML = `<h2 style="margin:0 0 12px">Board as a list</h2><p style="color:#666">Click an item to go back to the board and centre on it.</p><ul>${rows}</ul>`;
      for (const btn of container.querySelectorAll("[data-list-id]")) {
        btn.addEventListener("click", () => {
          const id = Number(btn.dataset.listId);
          api.board.setSelected([id]);
          api.view.setView("board");
          api.view.centreOn(id);
        });
      }
    },
  });
}

export function deactivate() {
  // The core unregisters this plugin's tools, panels, commands,
  // views and card kinds on deactivate. Event listeners registered
  // in activate are not removed in v1 — updatePanel guards on a
  // missing panel element, so they become no-ops after deactivate.
  // See PLUGIN_API.md, "What is not in v1".
}
