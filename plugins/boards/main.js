// Boards — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Multi-board is a plugin, not core UI, by design: the core
// owns one board at a time (its file, its assets, its undo),
// and this plugin is only the list and the switching. The
// core's api.boards does the actual switch — it saves the
// current board, loads the new one, and swaps in that
// board's own undo stack, search and context index, which
// are all per-board — so a plugin cannot strand the core
// in a half-switched state, and creating a board never
// wipes another board's undo.
//
// Layout (see electron/main.js): Main is the default board
// at the base folder's board.json; every other board is a
// folder under boards/, with its own board.json, assets and
// backups. Deleting a board deletes its folder, so it also
// deletes its backups — the panel asks for confirmation
// first, and Main cannot be deleted or renamed, because
// there must always be a board to fall back to.
//
// The panel refreshes on every board event, so switching
// from anywhere (or a board created elsewhere) shows up
// here without a manual refresh. Renaming is inline: click
// a board's name to edit it, Enter to save, Esc to cancel.
let apiRef = null;
let panelEl = null;
let listEl = null;
let nameInput = null;
let onBoardHandler = null;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function refresh() {
  if (!listEl || !apiRef || !apiRef.boards) return;
  let boards = [];
  try { boards = await apiRef.boards.list(); } catch (e) { listEl.innerHTML = `<p class="bd-meta">Could not list boards: ${esc(e.message || e)}</p>`; return; }
  listEl.innerHTML = "";
  for (const b of boards) {
    const row = document.createElement("div");
    row.className = "bd-row" + (b.current ? " bd-current" : "");
    const name = document.createElement("button");
    name.className = "bd-name";
    name.textContent = b.name;
    name.title = b.current ? "Current board — click to rename" : "Click to open this board";
    name.addEventListener("click", async () => {
      if (b.current) { startRename(row, b); return; }
      const ok = await apiRef.boards.switch(b.name);
      if (ok) void refresh();
    });
    row.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "bd-meta";
    meta.textContent = `${b.items} item${b.items === 1 ? "" : "s"}${b.current ? " · current" : ""}`;
    row.appendChild(meta);
    if (b.name !== "Main") {
      const del = document.createElement("button");
      del.className = "bd-del";
      del.textContent = "×";
      del.title = `Delete ${b.name}`;
      del.setAttribute("aria-label", `Delete ${b.name}`);
      // Two-click delete, like Delete all data in Settings:
      // the first click arms the button, the second deletes.
      // No native confirm dialog: the app never uses one.
      let armed = false;
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!armed) {
          armed = true;
          del.textContent = "Confirm?";
          del.classList.add("bd-armed");
          setTimeout(() => { if (del.isConnected) { armed = false; del.textContent = "×"; del.classList.remove("bd-armed"); } }, 4000);
          return;
        }
        try {
          // Deleting the board that is open would leave the
          // renderer on a deleted folder, and its next save
          // would recreate it or overwrite the fallback, so
          // switch to Main first, then delete.
          if (b.current) {
            const ok = await apiRef.boards.switch("Main");
            if (!ok) { apiRef.ui.toast("Could not switch to Main"); return; }
          }
          await apiRef.boards.delete(b.name);
          apiRef.ui.toast(b.current ? `Deleted ${b.name}; back to Main` : `Deleted ${b.name}`);
          void refresh();
        } catch (err) { apiRef.ui.toast(`Could not delete: ${String(err.message || err)}`); }
      });
      row.appendChild(del);
    }
    listEl.appendChild(row);
  }
  if (boards.length === 0) listEl.innerHTML = `<p class="bd-meta">No boards.</p>`;
}

function startRename(row, board) {
  const nameBtn = row.querySelector(".bd-name");
  if (!nameBtn) return;
  const input = document.createElement("input");
  input.className = "bd-rename";
  input.type = "text";
  input.value = board.name;
  input.setAttribute("aria-label", "Rename board");
  const finish = async (save) => {
    const next = input.value.trim();
    if (!save || next === board.name || !next) { void refresh(); return; }
    try {
      await apiRef.boards.rename(board.name, next);
      // Renaming the open board moves its folder, so the
      // renderer's board folder is stale until it reloads:
      // switch to the new name, which saves to the new
      // folder and reloads with the right folder, keeping
      // this board's undo stack (a rename is not a new
      // board, so it must not reset undo either).
      if (board.current) await apiRef.boards.switch(next, true);
      apiRef.ui.toast(`Renamed to ${next}`);
    } catch (err) { apiRef.ui.toast(`Could not rename: ${String(err.message || err)}`); }
    void refresh();
  };
  // Stop every keydown here: without this the core
  // window handler sees the typing — v/p/a switch tools,
  // Backspace deletes the selected card, Esc clears the
  // selection as well as cancelling the rename. Same
  // one-line fix as the Visual Library search input.
  input.addEventListener("keydown", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); void finish(false); }
  });
  input.addEventListener("blur", () => void finish(true));
  row.replaceChild(input, nameBtn);
  input.focus();
  input.select();
}

function renderPanel(container) {
  panelEl = container;
  container.innerHTML = "";
  const intro = document.createElement("p");
  intro.className = "bd-meta";
  intro.textContent = "Click a board to open it. Click the current board's name to rename it.";
  container.appendChild(intro);
  const form = document.createElement("div");
  form.className = "bd-form";
  nameInput = document.createElement("input");
  nameInput.className = "bd-input";
  nameInput.type = "text";
  nameInput.placeholder = "New board name";
  nameInput.setAttribute("aria-label", "New board name");
  const createBtn = document.createElement("button");
  createBtn.className = "bd-create";
  createBtn.textContent = "New board";
  const create = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    try {
      await apiRef.boards.create(name);
      nameInput.value = "";
      const ok = await apiRef.boards.switch(name);
      if (!ok) apiRef.ui.toast(`Created ${name} — click it to open`);
      void refresh();
    } catch (err) { apiRef.ui.toast(`Could not create: ${String(err.message || err)}`); }
  };
  createBtn.addEventListener("click", () => void create());
  // Same stopPropagation as the rename input above:
  // typing a board name must never switch tools or
  // delete the selected card.
  nameInput.addEventListener("keydown", (e) => e.stopPropagation());
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } });
  form.appendChild(nameInput);
  form.appendChild(createBtn);
  container.appendChild(form);
  listEl = document.createElement("div");
  listEl.className = "bd-list";
  container.appendChild(listEl);
  void refresh();
}

function activate(api) {
  apiRef = api;
  onBoardHandler = () => void refresh();
  apiRef.events.on("board", onBoardHandler);
  apiRef.ui.registerPanel({
    id: "boards",
    title: "Boards",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" opacity="0.45" /></svg>',
    render: (container) => renderPanel(container),
  });
}

function deactivate() {
  if (apiRef && onBoardHandler) apiRef.events.off("board", onBoardHandler);
  onBoardHandler = null;
  panelEl = null;
  listEl = null;
  nameInput = null;
  apiRef = null;
}

export { activate, deactivate };
