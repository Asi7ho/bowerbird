// Boards — the Versions section: the recovery journal (unsaved
// changes, when there is one) and every kept backup, newest
// first, each restorable. Restoring is two-click, like delete
// and like the Settings backup restore: the first click arms
// the button, the second restores. The app never uses a native
// confirm dialog. A restore backs the current board up first
// (see electron/backups.ts), so restoring is reversible.
import type { PluginContext } from "bowerbird-plugin-api";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtName(n: string): string {
  // Backup folders are YYYY-MM-DD-HHMMSS: show them as a date and time.
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(n);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : n;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

let historyEl: HTMLDivElement | null = null;
// What the armed restore button is for: a backup name, or
// "recovery" for the journal entry. Stored by key, not by a
// closure over the button, which refresh() rebuilds — the
// same reason the board list keeps its armed delete by name.
let armedKey: string | null = null;
let armedTimer: number | null = null;

function arm(key: string, refresh: () => void): boolean {
  if (armedKey !== key) {
    armedKey = key;
    if (armedTimer !== null) clearTimeout(armedTimer);
    armedTimer = setTimeout(() => { armedKey = null; armedTimer = null; refresh(); }, 4000);
    refresh();
    return false;
  }
  armedKey = null;
  if (armedTimer !== null) { clearTimeout(armedTimer); armedTimer = null; }
  return true;
}

export function renderHistorySection(api: PluginContext, container: HTMLElement): void {
  const section = document.createElement("div");
  section.className = "bd-history";
  const title = document.createElement("h3");
  title.className = "bd-history-title";
  title.textContent = "Versions";
  section.appendChild(title);
  historyEl = document.createElement("div");
  historyEl.className = "bd-history-list";
  section.appendChild(historyEl);
  container.appendChild(section);
  void refreshHistory(api);
}

export function clearHistory(): void {
  historyEl = null;
  armedKey = null;
  if (armedTimer !== null) { clearTimeout(armedTimer); armedTimer = null; }
}

export async function refreshHistory(api: PluginContext): Promise<void> {
  const el = historyEl;
  if (!el) return;
  const refresh = () => void refreshHistory(api);
  let backups: Array<{ name: string; items: number; size: number; mtimeMs: number }> = [];
  let recovery: { hasRecovery: boolean; savedAt: number | null } = { hasRecovery: false, savedAt: null };
  try {
    [backups, recovery] = await Promise.all([api.backups.listAll(), api.backups.recoveryStatus()]);
  } catch (e) {
    el.innerHTML = `<p class="bd-meta">Could not list versions: ${esc((e as { message?: unknown })?.message || e)}</p>`;
    return;
  }
  el.innerHTML = "";
  if (recovery.hasRecovery && typeof recovery.savedAt === "number") {
    const row = document.createElement("div");
    row.className = "bd-version-row bd-recovery-row";
    const meta = document.createElement("span");
    meta.className = "bd-meta";
    meta.textContent = `Unsaved changes · ${fmtWhen(recovery.savedAt)}`;
    row.appendChild(meta);
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "bd-restore" + (armedKey === "recovery" ? " bd-armed" : "");
    restoreBtn.textContent = armedKey === "recovery" ? "Confirm restore?" : "Restore";
    restoreBtn.addEventListener("click", async () => {
      if (!arm("recovery", refresh)) return;
      try {
        const ok = await api.backups.restoreRecovery();
        if (ok) { api.ui.toast("Unsaved changes restored"); refresh(); }
      } catch (err) { api.ui.toast(`Could not restore: ${String((err as { message?: unknown })?.message || err)}`); }
    });
    row.appendChild(restoreBtn);
    const discardBtn = document.createElement("button");
    discardBtn.className = "bd-discard" + (armedKey === "recovery-discard" ? " bd-armed" : "");
    discardBtn.textContent = armedKey === "recovery-discard" ? "Confirm discard?" : "Discard";
    discardBtn.addEventListener("click", async () => {
      if (!arm("recovery-discard", refresh)) return;
      try {
        await api.backups.discardRecovery();
        api.ui.toast("Unsaved changes discarded");
        refresh();
      } catch (err) { api.ui.toast(`Could not discard: ${String((err as { message?: unknown })?.message || err)}`); }
    });
    row.appendChild(discardBtn);
    el.appendChild(row);
  }
  for (const b of backups) {
    const row = document.createElement("div");
    row.className = "bd-version-row";
    const meta = document.createElement("span");
    meta.className = "bd-meta";
    meta.textContent = `${fmtName(b.name)} · ${b.items} item${b.items === 1 ? "" : "s"} · ${fmtSize(b.size)}`;
    row.appendChild(meta);
    const btn = document.createElement("button");
    btn.className = "bd-restore" + (armedKey === b.name ? " bd-armed" : "");
    btn.textContent = armedKey === b.name ? "Confirm restore?" : "Restore";
    btn.addEventListener("click", async () => {
      if (!arm(b.name, refresh)) return;
      try {
        const ok = await api.backups.restore(b.name);
        if (ok) { api.ui.toast("Backup restored"); refresh(); }
      } catch (err) { api.ui.toast(`Could not restore: ${String((err as { message?: unknown })?.message || err)}`); }
    });
    row.appendChild(btn);
    el.appendChild(row);
  }
  if (!recovery.hasRecovery && backups.length === 0) {
    el.innerHTML = `<p class="bd-meta">No versions yet — a backup is made at most once an hour, and before a reset or a restore.</p>`;
  }
}
