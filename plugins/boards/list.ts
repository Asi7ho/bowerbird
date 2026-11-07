// Boards — the board list: rows, delete, rename. The panel
// refreshes on every board event, so switching from anywhere
// (or a board created elsewhere) shows up here without a
// manual refresh. Renaming is inline: click a board's name
// to edit it, Enter to save, Esc to cancel.
import type { PluginContext } from "../../src/plugins";

export interface BoardInfo {
  name: string;
  current: boolean;
  items: number;
}

// The board whose delete button is armed, by name —
// not a closure over the button, which refresh()
// rebuilds on every board event. The old closure lost
// the armed state on any board save mid-arm, so the
// second click silently re-armed instead of deleting.
let armedBoard: string | null = null;
let armedTimer: number | null = null;

export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function refresh(api: PluginContext, listEl: HTMLDivElement): Promise<void> {
  let boards: BoardInfo[] = [];
  try { boards = await api.boards.list(); } catch (e) { listEl.innerHTML = `<p class="bd-meta">Could not list boards: ${esc((e as { message?: unknown })?.message || e)}</p>`; return; }
  listEl.innerHTML = "";
  for (const b of boards) {
    const row = document.createElement("div");
    row.className = "bd-row" + (b.current ? " bd-current" : "");
    const name = document.createElement("button");
    name.className = "bd-name";
    name.textContent = b.name;
    name.title = b.current ? "Current board — click to rename" : "Click to open this board";
    name.addEventListener("click", async () => {
      if (b.current) { startRename(api, listEl, row, b); return; }
      const ok = await api.boards.switch(b.name);
      if (ok) void refresh(api, listEl);
    });
    row.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "bd-meta";
    meta.textContent = `${b.items} item${b.items === 1 ? "" : "s"}${b.current ? " · current" : ""}`;
    row.appendChild(meta);
    if (b.name !== "Main") {
      const del = document.createElement("button");
      del.className = "bd-del";
      if (armedBoard === b.name) {
        del.textContent = "Confirm?";
        del.classList.add("bd-armed");
      } else {
        del.textContent = "×";
      }
      del.title = `Delete ${b.name}`;
      del.setAttribute("aria-label", `Delete ${b.name}`);
      // Two-click delete, like Delete all data in Settings:
      // the first click arms the button, the second deletes.
      // No native confirm dialog: the app never uses one.
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (armedBoard !== b.name) {
          armedBoard = b.name;
          if (armedTimer !== null) clearTimeout(armedTimer);
          armedTimer = setTimeout(() => { armedBoard = null; armedTimer = null; void refresh(api, listEl); }, 4000);
          void refresh(api, listEl);
          return;
        }
        armedBoard = null;
        if (armedTimer !== null) { clearTimeout(armedTimer); armedTimer = null; }
        try {
          // Deleting the board that is open would leave the
          // renderer on a deleted folder, and its next save
          // would recreate it or overwrite the fallback, so
          // switch to Main first, then delete.
          if (b.current) {
            const ok = await api.boards.switch("Main");
            if (!ok) { api.ui.toast("Could not switch to Main"); return; }
          }
          await api.boards.delete(b.name);
          api.ui.toast(b.current ? `Deleted ${b.name}; back to Main` : `Deleted ${b.name}`);
          void refresh(api, listEl);
        } catch (err) { api.ui.toast(`Could not delete: ${String((err as { message?: unknown })?.message || err)}`); }
      });
      row.appendChild(del);
    }
    listEl.appendChild(row);
  }
  if (boards.length === 0) listEl.innerHTML = `<p class="bd-meta">No boards.</p>`;
}

export function startRename(api: PluginContext, listEl: HTMLDivElement, row: HTMLDivElement, board: BoardInfo): void {
  const nameBtn = row.querySelector(".bd-name");
  if (!nameBtn) return;
  const input = document.createElement("input");
  input.className = "bd-rename";
  input.type = "text";
  input.value = board.name;
  input.setAttribute("aria-label", "Rename board");
  const finish = async (save: boolean): Promise<void> => {
    const next = input.value.trim();
    if (!save || next === board.name || !next) { void refresh(api, listEl); return; }
    try {
      await api.boards.rename(board.name, next);
      // Renaming the open board moves its folder, so the
      // renderer's board folder is stale until it reloads:
      // switch to the new name, which saves to the new
      // folder and reloads with the right folder, keeping
      // this board's undo stack (a rename is not a new
      // board, so it must not reset undo either).
      if (board.current) await api.boards.switch(next, true);
      api.ui.toast(`Renamed to ${next}`);
    } catch (err) { api.ui.toast(`Could not rename: ${String((err as { message?: unknown })?.message || err)}`); }
    void refresh(api, listEl);
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
