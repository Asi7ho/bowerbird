// Command Palette — the command registry. Everything the palette
// can run, built fresh on every open so it never lists a dead
// action: plugin commands, board cards to jump to, views, tools,
// and the core actions the API can reach. Group, Ungroup, Delete,
// Undo and Redo only appear when they can actually do something,
// so the palette never lists an action that silently does nothing.
import type { PluginContext } from "../../src/plugins";
import type { Item } from "../../src/model";

export interface Entry {
  title: string;
  hint: string;
  run: () => void | Promise<void>;
}

function baseName(path: string): string {
  if (!path) return "";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

function truncate(text: string, max: number): string {
  const t = String(text || "");
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}

function cardTitle(item: Item): string {
  const kind = item.kind;
  if ("Text" in kind) {
    const first = String(kind.Text.text || "").split("\n")[0].trim();
    return first ? truncate(first, 48) : "Text note";
  }
  if ("UrlCard" in kind) return truncate(kind.UrlCard.title || kind.UrlCard.url, 48);
  if ("Image" in kind) return truncate(baseName(kind.Image.path) || "Image", 48);
  if ("PdfCard" in kind) return truncate(baseName(kind.PdfCard.path) || "PDF", 48);
  if ("Audio" in kind) return truncate(baseName(kind.Audio.path) || "Audio", 48);
  if ("Video" in kind) return truncate(baseName(kind.Video.source) || "Video", 48);
  if ("Swatch" in kind) return kind.Swatch.hex;
  if ("Plugin" in kind) return truncate(kind.Plugin.plugin + " " + kind.Plugin.kind, 48);
  return "Card";
}

function isGoToItem(item: Item): boolean {
  if ("Stroke" in item.kind || "Connector" in item.kind) return false;
  // A slide frame is a container, not content to jump to, just
  // as Visual Library excludes slide frames from its library.
  if ("Plugin" in item.kind && item.kind.Plugin.kind === "slide") return false;
  return true;
}

export function buildEntries(api: PluginContext): Entry[] {
  const out: Entry[] = [];

  // Plugin commands first: these are the commands other plugins
  // registered, if any. No plugin currently registers one.
  const commands = api.ui.listCommands()
    .sort((a, b) => a.title.localeCompare(b.title));
  for (const c of commands) {
    out.push({
      title: c.title,
      hint: c.pluginName,
      run: () => api.ui.runCommand(c.pluginId, c.id),
    });
  }

  // Board cards, in board order, to jump to.
  for (const item of api.board.getItems()) {
    if (!isGoToItem(item)) continue;
    out.push({
      title: "Go to " + cardTitle(item),
      hint: "Board",
      run: () => {
        api.view.setView("board");
        api.view.centreOn(item.id);
      },
    });
  }

  // Views, including Board, in the order the view switcher shows.
  for (const v of api.view.listViews()) {
    out.push({
      title: "Switch to " + v.title,
      hint: "View",
      run: () => api.view.setView(v.id),
    });
  }

  // Tools: the core tools, then any plugin tools.
  const coreTools = [
    { id: "select", title: "Select" },
    { id: "pen", title: "Pen" },
    { id: "connector", title: "Arrow" },
  ];
  for (const t of coreTools) {
    out.push({ title: "Use " + t.title + " tool", hint: "Tool", run: () => api.ui.setTool(t.id) });
  }
  for (const t of api.ui.listTools()) {
    out.push({ title: "Use " + t.title + " tool", hint: t.pluginName, run: () => api.ui.setTool(t.id) });
  }

  // Core actions the API can reach. Group, Ungroup and Delete
  // only appear when they can actually do something, so the
  // palette never lists an action that silently does nothing.
  const selected = api.board.getSelected();
  const items = api.board.getItems();
  const hasGrouped = selected.some((id) => {
    const it = items.find((i) => i.id === id);
    return it && it.group !== null && it.group !== undefined;
  });
  const zoom = (factor: number): void => {
    const cam = api.view.getCamera();
    api.view.setCamera({ x: cam.x, y: cam.y, zoom: cam.zoom * factor });
  };
  const actions: Array<{ title: string; run: () => void | Promise<void> }> = [
    { title: "Zoom in", run: () => zoom(1.2) },
    { title: "Zoom out", run: () => zoom(1 / 1.2) },
    { title: "Reset view", run: () => api.view.setCamera({ x: 0, y: 0, zoom: 1 }) },
  ];
  // Undo and Redo only appear when they can do something, like
  // Group and Delete below: the palette never lists a dead action.
  // The braces discard the boolean: an entry's run returns void
  // or a promise, and runSelected only awaits a promise.
  if (api.board.canUndo()) actions.push({ title: "Undo", run: () => { api.board.undo(); } });
  if (api.board.canRedo()) actions.push({ title: "Redo", run: () => { api.board.redo(); } });
  if (selected.length >= 2) actions.push({ title: "Group selection", run: () => { api.board.groupSelected(); } });
  if (hasGrouped) actions.push({ title: "Ungroup selection", run: () => { api.board.ungroupSelected(); } });
  if (selected.length >= 1) actions.push({ title: "Delete selection", run: () => { api.board.deleteSelected(); } });
  actions.push(
    { title: "Open Settings", run: () => api.ui.openSettings() },
    { title: "Minimise board", run: () => api.window.minimise().catch(() => undefined) },
    {
      title: "Hide board",
      run: () => {
        // Same order Hide uses: commit, save, then hide, so an
        // open note edit is not lost behind the peek icon.
        api.board.commitEditing();
        api.board.save();
        api.window.hide().catch(() => undefined);
      },
    },
  );
  for (const a of actions) out.push({ title: a.title, hint: "Action", run: a.run });

  return out;
}
