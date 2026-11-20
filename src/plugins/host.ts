// Bowerbird Plugin API v1 — renderer side (see PLUGIN_API.md).
//
// A plugin is a folder with a manifest.json and a main.js
// module. A plugin may be multiple files: main.js is loaded
// as an ES module over the plugin: scheme, so its relative
// imports resolve against its own folder, exactly like a
// first-party plugin. The main process discovers plugins and
// serves their files through IPC and the plugin: scheme; this
// module loads them, builds the per-plugin API object, and owns
// the registries for cards, tools, panels, views and commands. The core (src/main.ts) owns the board
// state and the DOM; it passes a Host with closures over that state
// into initPlugins, and calls back into this module at the points
// where a plugin can contribute (card rendering, tool clicks,
// double-clicks, card actions, search text, toolbar state, render).
//
// Trust model, stated honestly: a locally installed plugin runs in
// the renderer with this API object. It does not get Node or the
// filesystem directly — every privileged call goes through the
// preload bridge — but it does run in the same renderer as the
// core, so installing a plugin is trusting its code, like an
// Obsidian or VS Code extension. Within that, plugins are
// isolated from each other: the host enforces caller identity at
// the PluginContext boundary, so a plugin can only trigger its
// own commands, shortcuts and card actions, can never emit a
// core event, and can never replace a core delegation (the board
// controller, the settings UI, the shell elements). The app's own
// UI (src/ui/) is trusted and dispatches on the user's behalf.
// The API is the supported contract; reaching past it into core
// DOM is unsupported and may break. A future version may sandbox
// panels and views harder; v1 does not pretend otherwise.

// The public plugin API types live in the bowerbird-plugin-api
// package (plugin-api/) so plugins import them by name without
// reaching into the core. This module re-exports them, so existing
// core imports from "./plugins/host" keep working.
import type { Anchor, ArrangeOptions, Board, BoardController, Camera, Item, Kind, PluginBridge, PluginBuiltinCardDef, PluginCardDecoratorDef, PluginCardDef, PluginCommandDef, PluginContext, PluginCreateActionDef, PluginHost, PluginManifest, PluginOverlayDef, PluginPanelDef, PluginSettingsSectionDef, PluginShortcutDef, PluginToolDef, PluginViewDef, Pt, SettingsUI, ShellElements, Size } from "bowerbird-plugin-api";
export type { Anchor, ArrangeOptions, Board, BoardController, Camera, Item, Kind, PluginBridge, PluginBuiltinCardDef, PluginCardDecoratorDef, PluginCardDef, PluginCommandDef, PluginContext, PluginCreateActionDef, PluginHost, PluginManifest, PluginOverlayDef, PluginPanelDef, PluginSettingsSectionDef, PluginShortcutDef, PluginToolDef, PluginViewDef, Pt, SettingsUI, ShellElements, Size };
import { anchorPoint, arrangeItems, AUDIO_H, AUDIO_TRANSCRIPT_HIDDEN_H, AUDIO_TRANSCRIPT_SHOWN_H, boardGet, centre, checklistProgress, clippedEnds, domainOf, elide, escapeHtml, fitCamera, itemBounds, itemRotation, parseHex, rectCrossing, rectFromPoints, renderMarkdownHtml, rotatePoint, segmentIntersectsRect, select, setChecklistDone, tileColorFor, tint, toggleTaskLine } from "../backend/model";
import { cardDecorators, cards, commands, CORE_EVENTS, createActions, listeners, loaded, overlays, panels, settingsSections, shell, shortcuts, tools, views } from "./host-state";
import { applySavedPanelSettings, bindPanelDeps, deactivateMissingActivePanel, deactivatePanelIfActive, ensureResizeHandle, isPanelActive as isPanelActiveKey, registerPanel, setActivePanel, updatePanelDock, wirePanelsToggle } from "./host-panels";
import { bindViewDeps, getActiveView, refreshActiveView, registerView, renderViewSwitcher, setActiveView } from "./host-views";
import { bindCardDeps, domId, getCardRenderer, handlePluginCardAction, handlePluginCardDoubleClick, isPluginCard, listPluginCommands, getPluginTool, registerBuiltinCard, runPluginCommand, syncPluginToolButtons } from "./host-cards";
// getBuiltinCardHtml, getCardHtml, getCardRenderer,
// getPluginCardSearchText and builtinKindName moved to
// host-cards with the card registry; re-exported here so
// existing imports from this module (src/backend/cards.ts,
// src/backend/search.ts, src/main.ts) keep working.
export { builtinKindName, getBuiltinCardHtml, getCardHtml, getCardRenderer, getPluginCardSearchText } from "./host-cards";
// getCardDecorations moved to host-state with the cardDecorators
// registry; re-exported here so existing imports from this
// module (src/backend/cards.ts) keep working.
export { getCardDecorations } from "./host-state";


// ---------------------------------------------------------------- state
//
// The registries (cards, tools, panels, views, commands, ...),
// the shell element bag and the LoadedPlugin record live in
// host-state.ts; this module imports them. The host/bridge
// singletons stay here — they are set once by initPlugins.

let host: PluginHost | null = null;
let bridge: PluginBridge | null = null;
let toolButtonsSynced = false;
let pluginsReady = false;

export function registerShellElements(els: Partial<ShellElements>): void {
  Object.assign(shell, els);
}

// Read the board DOM elements the core-board plugin built
// (the board element, the canvas layers, the plugin view,
// overlays, view switcher and toast). The core reads them
// after the board plugin activates; before that they are
// undefined. The core never queries them by id.
export function getBoardElements(): { board?: HTMLElement; canvas?: HTMLElement[]; pluginView?: HTMLElement; overlays?: HTMLElement; viewSwitcher?: HTMLElement; toast?: HTMLElement } {
  return {
    board: shell.boardEl,
    canvas: shell.boardCanvasEls,
    pluginView: shell.pluginViewEl,
    overlays: shell.overlaysEl,
    viewSwitcher: shell.viewSwitcherEl,
    toast: shell.toastEl,
  };
}

let settingsUI: SettingsUI | null = null;
export function registerSettingsUI(ui: SettingsUI): void {
  settingsUI = ui;
}
export function openSettingsUI(): void {
  settingsUI?.open();
}
export function closeSettingsUI(): void {
  settingsUI?.close();
}
export function isSettingsUIOpen(): boolean {
  return settingsUI?.isOpen() ?? false;
}
export function refreshSettingsUI(): void {
  settingsUI?.refresh();
}

let boardController: BoardController | null = null;
export function registerBoardController(c: BoardController): void {
  boardController = c;
}
export function boardRender(): void {
  boardController?.render();
}
export function boardUpdateSelection(): void {
  boardController?.updateSelection();
}
export function boardCommitEditing(): void {
  boardController?.commitEditing();
}
export function boardClearEditing(): void {
  boardController?.clearEditing();
}
export function boardGetEditingId(): number | null {
  return boardController?.getEditingId() ?? null;
}
export function boardSetTool(tool: string): void {
  boardController?.setTool(tool);
}
export function boardGetTool(): string {
  return boardController?.getTool() ?? "select";
}
export function boardSetSelectMode(mode: "select" | "lasso"): void {
  boardController?.setSelectMode(mode);
}
export function boardGetSelectMode(): "select" | "lasso" {
  return boardController?.getSelectMode() ?? "select";
}
export function boardGroupSelected(): boolean {
  return boardController?.groupSelected() ?? false;
}
export function boardUngroupSelected(): boolean {
  return boardController?.ungroupSelected() ?? false;
}
export function boardDeleteSelected(): boolean {
  return boardController?.deleteSelected() ?? false;
}

// ---------------------------------------------------------------- panels
//
// The panel dock (tabs, resizable dock, active panel,
// registration) lives in host-panels.ts; this module imports
// the functions it calls. The panel state is owned there;
// host.ts reaches it only through those functions and the
// deps bound in initPlugins.

// ---------------------------------------------------------------- events

// "items-moved" is coalesced to one emission per animation
// frame (see emitPluginEvent): this is the pending flag.
let itemsMovedPending = false;

export function emitPluginEvent(event: string): void {
  // "items-moved" fires on every pointermove of a drag,
  // and every listener (the toolbar's note colour bar)
  // re-renders on each one. Coalesce it to one emission
  // per animation frame: a listener reads the live board
  // when it runs, so it sees the latest positions anyway,
  // and the eye cannot use more than a frame.
  if (event === "items-moved") {
    if (itemsMovedPending) return;
    itemsMovedPending = true;
    requestAnimationFrame(() => {
      itemsMovedPending = false;
      emitPluginEventNow("items-moved");
    });
    return;
  }
  emitPluginEventNow(event);
}

function emitPluginEventNow(event: string): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try {
      fn();
    } catch {
      // A plugin event handler must never break the core.
    }
  }
}

function onEvent(event: string, handler: () => void): void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(handler);
}

function offEvent(event: string, handler: () => void): void {
  listeners.get(event)?.delete(handler);
}

// ---------------------------------------------------------------- helpers

function requirePerm(manifest: PluginManifest, perm: string): void {
  const perms = manifest.permissions ?? [];
  if (perms.includes(perm)) return;
  throw new Error(`Plugin ${manifest.id} lacks permission ${perm}`);
}

// ---------------------------------------------------------------- API builder

function createContext(manifest: PluginManifest, opts?: { trial?: boolean; firstParty?: boolean }): PluginContext {
  const pluginId = manifest.id;
  const trial = !!opts?.trial;
  // Trust boundary: the app's own UI (src/ui/) is trusted — it
  // dispatches on behalf of the user and the core. A plugin,
  // bundled or user-installed, is not: it may only affect its
  // own registrations. Anything that would trigger another
  // plugin, fake a core event, or replace a core delegation
  // is rejected. First-party here means the bundled UI modules
  // the core imports (src/ui/), not the bundled plugins/ folder.
  const trusted = !!opts?.firstParty;
  const require = (perm: string) => requirePerm(manifest, perm);
  const requireTrusted = (what: string): void => {
    if (!trusted) throw new Error(`Only the app's own UI can ${what}`);
  };
  const requireOwn = (ownerId: string, what: string): void => {
    if (!trusted && ownerId !== pluginId) {
      throw new Error(`Plugin ${pluginId} cannot ${what}: owned by ${ownerId}`);
    }
  };
  // A trial plugin is still a plugin, so it runs with the same
  // permission checks as an installed one — but it must not be
  // able to make anything permanent while it is only being
  // tried: no installing other plugins, and no creating,
  // renaming, switching or deleting boards. Board writes it
  // does make (adding or deleting cards) are undoable, like
  // any board write, and the Builder panel says so while
  // a trial is running.
  const requireNotTrial = (what: string) => {
    if (trial) throw new Error(`a plugin being tried cannot ${what}`);
  };
  return {
    version: "2",
    plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
    has: (capability: string) => {
      // Capabilities in v1: every domain documented in PLUGIN_API.md.
      // A future core may add more; a plugin should check before
      // using a capability that was added after v1.
      return ["board", "boards", "app", "backups", "view", "window", "ui", "cards", "files", "storage", "events", "tools", "panels", "commands", "views", "overlays", "settingsSections", "shortcuts", "library", "plugins", "pen", "media", "text", "geometry", "shapes"].includes(capability);
    },
    board: {
      get: () => {
        const b = host!.getBoard();
        return JSON.parse(JSON.stringify(b)) as Board;
      },
      getItems: () => JSON.parse(JSON.stringify(host!.getBoard().items)) as Item[],
      getItem: (id: number) => {
        const it = host!.getBoard().items.find((i) => i.id === id);
        return it ? (JSON.parse(JSON.stringify(it)) as Item) : undefined;
      },
      // Live reads, for the app's own UI only. The UI's
      // hot paths (render, drags) read the board every
      // frame; cloning it — or a stroke's point array — on
      // every frame is the cost. A plugin gets an error
      // here and must use get / getItem, which return a
      // copy. The returned board and item are live and
      // must never be mutated.
      getLive: () => {
        requireTrusted("read the live board");
        return host!.getBoard();
      },
      getItemLive: (id: number) => {
        requireTrusted("read a live board item");
        return host!.getBoard().items.find((i) => i.id === id);
      },
      // Render a board item exactly as the board renders it, at
      // position 0,0 and with no selection or editing state, so a
      // plugin can show the same card in a panel or view. A plugin
      // can already read the item via getItems, so this needs no
      // extra permission; strokes and connectors render as null.
      renderCard: (id: number) => host!.renderBoardCard(id),
      // The same card as it appears on the board: real position,
      // selection state and editing exclusion. The board view
      // builds the card DOM from this; a plugin embedding a card
      // elsewhere uses renderCard instead.
      renderCardAt: (id: number) => host!.renderBoardCardAt(id),
      hitTest: (world: Pt) => host!.hitTest(world),
      marqueeSelect: (a: Pt, b: Pt) => host!.marqueeSelect(a, b),
      lassoSelect: (points: Pt[]) => host!.lassoSelect(points),
      strokesNear: (point: Pt, radius: number) => host!.strokesNear(point, radius),
      moveItems: (ids: number[], dx: number, dy: number) => {
        require("board:write");
        host!.moveItems(ids, dx, dy);
      },
      resizeItem: (id: number, w: number, h: number) => {
        require("board:write");
        host!.resizeItem(id, w, h);
      },
      setItemRotation: (id: number, rot: number) => {
        require("board:write");
        host!.setItemRotation(id, rot);
      },
      removeItems: (ids: number[]) => {
        require("board:write");
        host!.removeItems(ids);
      },
      bringToFront: (ids: number[]) => {
        require("board:write");
        host!.bringToFront(ids);
      },
      setTextContent: (id: number, text: string) => {
        require("board:write");
        return host!.setTextContent(id, text);
      },
      createGroup: (ids: number[]) => {
        require("board:write");
        return host!.createGroup(ids);
      },
      setGroupLabel: (group: number, label: string) => {
        require("board:write");
        return host!.setGroupLabel(group, label);
      },
      setAudioTitle: (id: number, title: string) => {
        require("board:write");
        return host!.setAudioTitle(id, title);
      },
      getSelected: () => host!.getSelected(),
      setSelected: (ids: number[]) => host!.setSelected(ids),
      selectCard: (selected: number[], id: number, additive: boolean) => select(host!.getBoard(), selected, id, additive),
      addItem: (kind: Kind, pos: Pt, size: Size) => {
        require("board:write");
        const id = host!.addItem(kind, pos, size);
        return id;
      },
      addItemSilent: (kind: Kind, pos: Pt, size: Size) => {
        require("board:write");
        return host!.addItemSilent(kind, pos, size);
      },
      addPluginCard: (kind: string, data: unknown, pos: Pt, size: Size) => {
        require("board:write");
        const id = host!.addItem({ Plugin: { plugin: pluginId, kind, data } }, pos, size);
        return id;
      },
      addItems: (items: Array<{ kind: Kind; pos: Pt; size: Size }>) => {
        require("board:write");
        return host!.addItems(items);
      },
      arrange: (ids: number[], options: ArrangeOptions) => {
        require("board:write");
        const patches = arrangeItems(host!.getBoard(), ids, options);
        if (patches.length === 0) return false;
        return host!.updateItems(patches);
      },
      connect: (fromId: number, toId: number, options?: { color?: string }) => {
        require("board:write");
        const board = host!.getBoard();
        const from = boardGet(board, fromId);
        const to = boardGet(board, toId);
        if (!from || !to) return null;
        // The connector's pos/size is the bounding box of the
        // line between the two card centres, the same box the
        // connector tool uses when it draws one by hand.
        const a = centre(from);
        const b = centre(to);
        const { pos, size } = rectFromPoints(a, b);
        return host!.addItem(
          { Connector: { from: { Item: fromId }, to: { Item: toId }, color: options?.color ?? "#333333" } },
          pos,
          size
        );
      },
      updateItem: (id: number, patch: { pos?: Pt; size?: Size; group?: number | null; data?: unknown }) => {
        require("board:write");
        // A plugin may only rewrite its own plugin card data. Core
        // pos/size/group edits are allowed for any card, because
        // moving a card is not editing its content.
        if (patch.data !== undefined) {
          const it = host!.getBoard().items.find((i) => i.id === id);
          if (!it || !isPluginCard(it) || it.kind.Plugin.plugin !== pluginId) {
            throw new Error(`Plugin ${pluginId} cannot edit another plugin's card data`);
          }
        }
        const ok = host!.updateItem(id, patch);
        return ok;
      },
      updateItems: (patches: Array<{ id: number; pos?: Pt; size?: Size; group?: number | null; data?: unknown }>) => {
        require("board:write");
        // Same data rule as updateItem, per patch: a plugin
        // may only rewrite its own plugin card data.
        for (const patch of patches) {
          if (patch.data !== undefined) {
            const it = host!.getBoard().items.find((i) => i.id === patch.id);
            if (!it || !isPluginCard(it) || it.kind.Plugin.plugin !== pluginId) {
              throw new Error(`Plugin ${pluginId} cannot edit another plugin's card data`);
            }
          }
        }
        return host!.updateItems(patches);
      },
      moveItem: (id: number, toIndex: number) => {
        require("board:write");
        return host!.moveItem(id, toIndex);
      },
      removeItem: (id: number) => {
        require("board:write");
        const ok = host!.removeItem(id);
        return ok;
      },
      save: () => {
        require("board:write");
        host!.save();
      },
      saveWithoutUndo: () => {
        require("board:write");
        host!.saveWithoutUndo();
      },
      saveSync: () => {
        require("board:write");
        // Change-detecting (see undo.ts saveSync): only a
        // board that changed since the last save is written,
        // so the unload flush can never overwrite a restore
        // with the stale board it replaced.
        host!.saveSync();
      },
      render: () => host!.render(),
      commitEditing: () => {
        require("board:write");
        host!.commitEditing();
      },
      groupSelected: () => {
        require("board:write");
        return host!.groupSelection();
      },
      ungroupSelected: () => {
        require("board:write");
        return host!.ungroupSelection();
      },
      deleteSelected: () => {
        require("board:write");
        return host!.deleteSelection();
      },
      // Undo is a board change, so it needs board:write, like any
      // other board write. canUndo/canRedo only read stack state.
      undo: () => {
        require("board:write");
        return host!.undo();
      },
      redo: () => {
        require("board:write");
        return host!.redo();
      },
      canUndo: () => host!.canUndo(),
      canRedo: () => host!.canRedo(),
      setCanvas: (patch: { bg?: string; grid?: Board["grid"] }) => {
        require("board:write");
        host!.setCanvas(patch);
      },
      setNoteBackground: (ids: number[], hex: string) => {
        require("board:write");
        host!.setNoteBackground(ids, hex);
      },
      reset: async (opts?: { confirmed?: boolean }) => {
        require("board:write");
        requireNotTrial("reset the board");
        return host!.resetBoard(opts);
      },
      getDir: () => host!.getBoardDir(),
      registerController: (controller: BoardController) => {
        requireTrusted("register the board controller");
        registerBoardController(controller);
      },
    },
    boards: {
      list: async () => bridge!.listBoards(),
      current: async () => {
        const list = await bridge!.listBoards();
        return list.find((b) => b.current)?.name ?? "Main";
      },
      create: async (name: string) => {
        require("board:write");
        requireNotTrial("create a board");
        return bridge!.createBoard(name);
      },
      switch: async (name: string, preserveUndo = false) => {
        require("board:write");
        requireNotTrial("switch boards");
        return host!.switchBoard(name, preserveUndo);
      },
      rename: async (oldName: string, newName: string) => {
        require("board:write");
        requireNotTrial("rename a board");
        return bridge!.renameBoard(oldName, newName);
      },
      delete: async (name: string, opts?: { confirmed?: boolean }) => {
        require("board:write");
        requireNotTrial("delete a board");
        return bridge!.deleteBoard(name, opts);
      },
    },
    app: {
      getBuildId: () => host!.getBuildId(),
      getPlatform: () => bridge!.platform,
      factoryReset: async (opts?: { confirmed?: boolean }) => {
        require("board:write");
        requireNotTrial("factory reset");
        return bridge!.factoryReset(opts);
      },
    },
    backups: {
      list: async () => bridge!.listBackups(),
      // Every kept backup, newest first — the Versions
      // history in the Boards panel. list() above stays
      // newest-only for Settings, which never pays for all ten.
      listAll: async () => bridge!.listAllBackups(),
      restore: async (name: string) => {
        require("board:write");
        requireNotTrial("restore a backup");
        return host!.restoreBackup(name);
      },
      openFolder: async () => bridge!.openBackupsFolder(),
      // Crash recovery (see electron/recovery.ts): whether
      // the journal holds edits board.json does not, and
      // restoring or discarding them. Restoring loads the
      // journalled board like a backup restore, so it needs
      // board:write; discarding only deletes the journal.
      recoveryStatus: async () => bridge!.recoveryStatus(),
      restoreRecovery: async () => {
        require("board:write");
        requireNotTrial("restore unsaved changes");
        return host!.restoreRecovery();
      },
      discardRecovery: async () => bridge!.recoveryDiscard(),
    },
    exportBoard: async () => bridge!.exportBoard(),
    importBoard: async () => {
      require("board:write");
      requireNotTrial("import a board");
      return host!.importBoard();
    },
    window: {
      hide: async () => {
        require("window");
        return bridge!.collapse();
      },
      show: async () => {
        require("window");
        return bridge!.restore();
      },
      minimise: async () => {
        require("window");
        return bridge!.minimise();
      },
      close: async () => {
        require("window");
        return bridge!.quit();
      },
      fullscreen: async () => {
        require("window");
        return bridge!.fullscreen();
      },
      maximise: async () => {
        require("window");
        return bridge!.maximise();
      },
      getWindowState: async () => {
        require("window");
        return bridge!.windowState();
      },
      move: (dx: number, dy: number) => {
        require("window");
        bridge!.moveWindow(dx, dy);
      },
      getCorner: async () => {
        require("window");
        return (await bridge!.getAppSettings()).corner;
      },
      setCorner: async (corner: string) => {
        require("window");
        return bridge!.setCorner(corner);
      },
    },
    view: {
      getCamera: () => ({ ...host!.getCamera() }),
      setCamera: (cam: Camera) => host!.setCamera(cam),
      setCameraSilent: (cam: Camera) => host!.setCameraSilent(cam),
      zoomBy: (factor: number) => host!.zoomBy(factor),
      centreOn: (id: number) => host!.centreOn(id),
      getView: () => getActiveView(),
      setView: (id: string) => setActiveView(id),
      listViews: () => {
        const out: Array<{ id: string; title: string; plugin: string | null }> = [{ id: "board", title: "Board", plugin: null }];
        for (const v of views.values()) out.push({ id: v.id, title: v.title, plugin: v.pluginId });
        return out;
      },
      refresh: () => refreshActiveView(),
    },
    shapes: {
      list: () => host!.listShapes(),
      previewPoints: (kind: string, x0: number, y0: number, w: number, h: number) => host!.shapePreviewPoints(kind, x0, y0, w, h),
      getOutline: () => host!.getShapeOutline(),
      setOutline: (outline: boolean) => host!.setShapeOutline(outline),
    },
    search: {
      setElements: (els: { input: HTMLInputElement; count: HTMLElement; clear: HTMLButtonElement; results: HTMLElement }) => {
        requireTrusted("provide the search elements");
        host!.setSearchElements(els);
      },
      update: () => host!.updateSearch(),
      clear: () => host!.clearSearch(),
      jumpTo: (idx: number) => host!.jumpToSearchIndex(idx),
    },
    pen: {
      getColor: () => host!.getPenColor(),
      setColor: (hex: string) => host!.setPenColor(hex),
    },
    ui: {
      toast: (msg: string) => host!.toast(msg),
      registerTool: (def: PluginToolDef) => registerTool(pluginId, def),
      registerPanel: (def: PluginPanelDef) => registerPanel(pluginId, def),
      registerCommand: (def: PluginCommandDef) => registerCommand(pluginId, def),
      registerCreateAction: (def: PluginCreateActionDef) => registerCreateAction(pluginId, def),
      listCreateActions: () => getCreateActions(),
      // Commands are user actions, not code: listing them is
      // what Settings' Run buttons and the palette do, so any
      // plugin can list them. Running one is different: a
      // plugin runs only its own commands. The app's own UI
      // is exempt — it dispatches on the user's behalf — but
      // a plugin that runs another plugin's command would be
      // making that plugin act without the user asking it to.
      // A command still runs with its own plugin's API
      // object, so it cannot do anything its plugin could not
      // do itself; the isolation is about who may trigger it.
      listCommands: () => listPluginCommands().map((c) => ({ pluginId: c.pluginId, pluginName: c.pluginName, id: c.id, title: c.title })),
      listTools: () => Array.from(tools.values()).map((t) => ({ pluginId: t.pluginId, pluginName: loaded.get(t.pluginId)?.manifest.name ?? t.pluginId, id: t.fullId, title: t.title })),
      getToolDef: (id: string) => getPluginTool(id),
      runCommand: async (pid: string, cid: string) => {
        requireOwn(pid, "run a command");
        await runPluginCommand(pid, cid);
      },
      // Routing, not executing: the command palette is a list
      // the user picks from, not an executor. When the user
      // picks a plugin command, the palette reports the pick
      // here and the host runs the command as its owning
      // plugin — the command's `run` closure already belongs
      // to that plugin, so it cannot do anything the plugin
      // could not do itself. Only the palette may route: any
      // other plugin calling this is trying to trigger
      // another plugin's command, which isolation forbids.
      // The id is safe to check: the bundled palette is
      // loaded from the app's own plugins directory, its
      // manifest is always in `loaded` (even when disabled),
      // and installing a plugin with a duplicate id is
      // rejected, so no other plugin can hold this id.
      routeCommand: async (pid: string, cid: string) => {
        if (pluginId !== "command-palette") throw new Error("only the command palette can route a command");
        await runPluginCommand(pid, cid);
      },
      setTool: (id: string) => host!.setTool(id),
      getTool: () => host!.getTool(),
      setSelectMode: (mode: "select" | "lasso") => host!.setSelectMode(mode),
      getSelectMode: () => host!.getSelectMode(),
      setToolbarToolsEl: (el: HTMLElement) => {
        requireTrusted("provide the toolbar tools element");
        shell.toolbarToolsEl = el;
      },
      setBoardElements: (els: { board: HTMLElement; canvas: HTMLElement[]; pluginView: HTMLElement; overlays: HTMLElement; viewSwitcher: HTMLElement; toast: HTMLElement }) => {
        requireTrusted("provide the board elements");
        registerShellElements({
          boardEl: els.board,
          boardCanvasEls: els.canvas,
          pluginViewEl: els.pluginView,
          overlaysEl: els.overlays,
          viewSwitcherEl: els.viewSwitcher,
          toastEl: els.toast,
        });
      },
      setPanelsToggleEl: (el: HTMLElement) => {
        requireTrusted("provide the panels toggle element");
        registerShellElements({ panelsToggleEl: el });
      },
      openSettings: () => host!.openSettings(),
      closeSettings: () => host!.closeSettings(),
      isSettingsOpen: () => host!.isSettingsOpen(),
      registerView: (def: PluginViewDef) => {
        require("view:replace");
        registerView(pluginId, def);
      },
      registerOverlay: (def: PluginOverlayDef) => registerOverlay(pluginId, def),
      registerSettingsSection: (def: PluginSettingsSectionDef) => registerSettingsSection(pluginId, def),
      renderSettingsSections: () => renderSettingsSections(),
      registerShortcut: (def: PluginShortcutDef) => registerShortcut(pluginId, def),
      listShortcuts: () => listPluginShortcuts(),
      // Offer a key to the shortcuts. A plugin dispatches
      // only its own: the key's owner is the plugin whose
      // handler would run, and triggering another plugin's
      // handler is triggering that plugin. The board view —
      // the app's own UI — dispatches for keys no core
      // handler claims, so a plugin shortcut works anywhere
      // on the board. No shortcut for the key means false,
      // not an error.
      dispatchShortcut: (key: string) => {
        const owner = shortcutOwner(key);
        if (owner !== null) requireOwn(owner, "dispatch a shortcut");
        return handlePluginShortcut(key);
      },
      // The board element, built by the core-board plugin.
      // Read from the shell (set by the board plugin when it
      // activates) so a plugin activating after the board
      // plugin — the title bar, which inserts before it —
      // sees it even before the core has read it back.
      boardEl: (shell.boardEl ?? host!.boardEl) as HTMLElement,
      registerSettingsUI: (ui: { open: () => void; close: () => void; isOpen: () => boolean; setTab: (tab: string) => void; refresh: () => void }) => {
        requireTrusted("register the settings UI");
        registerSettingsUI(ui);
      },
      setSettingsSectionsContainer: (el: HTMLElement) => {
        requireTrusted("provide the settings sections container");
        registerShellElements({ settingsSectionsEl: el });
      },
      // The search box container, built by the core-titlebar
      // plugin. The core-search plugin mounts its input,
      // count, clear button and results into it.
      setSearchBoxEl: (el: HTMLElement) => {
        requireTrusted("provide the search box element");
        registerShellElements({ searchBoxEl: el });
      },
      getSearchBoxEl: () => shell.searchBoxEl ?? null,
      showPanel: (id: string) => {
        // Showing a panel activates its tab, so the user
        // actually sees it — a new tab in the background
        // would be easy to miss.
        const key = `${pluginId}:${id}`;
        const p = panels.get(key);
        if (p) { p.hidden = false; setActivePanel(key); host?.render(); }
      },
      hidePanel: (id: string) => {
        const key = `${pluginId}:${id}`;
        const p = panels.get(key);
        if (!p) return;
        p.hidden = true;
        deactivatePanelIfActive(key);
        updatePanelDock();
        host?.render();
      },
      isPanelActive: (id: string) => isPanelActiveKey(`${pluginId}:${id}`),
      getPanelElement: (id: string) => {
        const p = panels.get(`${pluginId}:${id}`);
        return p ? p.body : null;
      },
    },
    cards: {
      register: (def: PluginCardDef) => {
        cards.set(`${pluginId}:${def.kind}`, { ...def, pluginId });
      },
      registerBuiltin: (def: PluginBuiltinCardDef) => {
        registerBuiltinCard(pluginId, def);
      },
      registerDecorator: (def: PluginCardDecoratorDef) => {
        cardDecorators.set(`${pluginId}:${def.id}`, { ...def, pluginId });
      },
      getChecklistProgress: (item: Item) => {
        if (!("Text" in item.kind)) return null;
        return checklistProgress(item.kind.Text.text);
      },
      setChecklistProgress: (id: number, done: number) => {
        require("board:write");
        const board = host!.getBoard();
        const it = boardGet(board, id);
        if (!it || !("Text" in it.kind)) return false;
        const next = setChecklistDone(it.kind.Text.text, done);
        if (next === null) return false;
        return host!.setTextContent(id, next);
      },
      isFrame: (item: Item) => {
        if (!isPluginCard(item)) return false;
        const { plugin, kind } = item.kind.Plugin;
        // A frame by its stored kind: the manifest declares
        // it, so it holds even when the plugin is disabled
        // and no renderer is registered. A slide must never
        // rotate.
        const lp = loaded.get(plugin);
        const declared = (lp?.manifest.contributions?.cards ?? []).some((c) => c.kind === kind && c.frame === true);
        if (declared) return true;
        return getCardRenderer(item)?.frame === true;
      },
      dispatchAction: (action: string, item: Item) => {
        // Route a card action to the plugin that rendered the
        // card — and only that plugin. A plugin dispatches
        // actions on its own cards; dispatching on another
        // plugin's card would run that plugin's handler. A
        // card that is not a plugin card has no owner and no
        // handler, so it returns false as before. The board
        // view — the app's own UI — dispatches clicks on any
        // plugin card's action button.
        if (isPluginCard(item)) requireOwn(item.kind.Plugin.plugin, "dispatch a card action");
        return handlePluginCardAction(action, item);
      },
      dispatchDoubleClick: (item: Item) => {
        // Same ownership rule as dispatchAction: only the
        // plugin that rendered the card handles its
        // double-click. The board view dispatches
        // double-clicks on any plugin card.
        if (isPluginCard(item)) requireOwn(item.kind.Plugin.plugin, "dispatch a card double-click");
        return handlePluginCardDoubleClick(item);
      },
      audioHeights: { plain: AUDIO_H, transcriptHidden: AUDIO_TRANSCRIPT_HIDDEN_H, transcriptShown: AUDIO_TRANSCRIPT_SHOWN_H },
    },
    media: {
      audioFailed: (path: string) => host!.audioFailed(path),
      getAudioState: () => host!.getAudioState(),
      getAudioDuration: (path: string) => host!.getAudioDuration(path),
      loadAudioDuration: (id: number, path: string) => host!.loadAudioDuration(id, path),
      transcribeAudio: (blob: Blob) => host!.transcribeAudio(blob),
      formatAudioTime: (sec: number) => host!.formatAudioTime(sec),
      toggleAudio: (id: number, path: string) => host!.toggleAudio(id, path),
      playVideo: (id: number) => host!.playVideo(id),
      getVideoState: () => host!.getVideoState(),
      seekAudio: (id: number, time: number) => host!.seekAudio(id, time),
      pdfFailed: (path: string) => host!.pdfFailed(path),
      getPdfPage: (id: number) => host!.getPdfPage(id),
      loadPdfPage: (id: number, path: string) => host!.loadPdfPage(id, path),
      setPdfPage: (id: number, path: string, page: number) => host!.setPdfPage(id, path, page),
    },
    text: {
      escapeHtml,
      renderMarkdownHtml,
      domainOf,
      elide,
      tileColorFor,
      tint,
      parseHex,
      toggleTaskLine,
    },
    files: {
      embedFile: async (file: File | string) => {
        require("files:embed");
        if (typeof file !== "string") {
          return bridge!.embedFileBytes(file.name, await file.arrayBuffer());
        }
        return bridge!.embedFile(file);
      },
      listLibrary: async () => {
        require("files:read");
        return bridge!.listLibrary();
      },
      createLibraryCategory: async (name: string) => {
        require("files:embed");
        return bridge!.createLibraryCategory(name);
      },
      moveLibraryItem: async (relativePath: string, category: string | null) => {
        require("files:embed");
        return bridge!.moveLibraryItem(relativePath, category);
      },
      fileUrl: (path: string) => bridge!.fileUrl(path),
      readTextFile: async (path: string) => {
        require("files:read");
        return bridge!.readTextFile(path);
      },
      readFileBase64: async (path: string) => {
        require("files:read");
        return bridge!.readFileBase64(path);
      },
      fileSize: async (path: string) => {
        require("files:read");
        return bridge!.fileSize(path);
      },
      openExternal: async (target: string) => {
        require("files:read");
        return bridge!.openExternal(target);
      },
      fetchPreview: async (url: string) => {
        require("files:read");
        return bridge!.fetchPreview(url);
      },
    },
    ai: {
      chat: async (opts: { base: string; model: string; messages: Array<{ role: string; content: string }> }) => {
        require("ai");
        return bridge!.aiChat(opts);
      },
      hasKey: async () => {
        require("ai");
        return bridge!.aiHasKey();
      },
      setKey: async (key: string) => {
        require("ai");
        return bridge!.aiSetKey(key);
      },
    },
    storage: {
      get: async (key: string) => {
        require("storage");
        return bridge!.pluginStorageGet(pluginId, key);
      },
      set: async (key: string, value: unknown) => {
        require("storage");
        return bridge!.pluginStorageSet(pluginId, key, value);
      },
      delete: async (key: string) => {
        require("storage");
        return bridge!.pluginStorageDelete(pluginId, key);
      },
    },
    secureStorage: {
      available: async () => bridge!.secureStorageAvailable(),
      get: async (key: string) => {
        require("storage");
        return bridge!.secureStorageGet(pluginId, key);
      },
      set: async (key: string, value: string) => {
        require("storage");
        return bridge!.secureStorageSet(pluginId, key, value);
      },
      delete: async (key: string) => {
        require("storage");
        return bridge!.secureStorageDelete(pluginId, key);
      },
    },
    plugins: {
      list: () => Array.from(loaded.values()).map((lp) => ({
        id: lp.manifest.id,
        name: lp.manifest.name,
        version: lp.manifest.version,
        description: lp.manifest.description ?? "",
        core: !!lp.firstParty,
        required: !!lp.manifest.required,
        active: lp.active,
        failed: lp.failed,
        error: lp.error,
        trial: !!lp.trial,
        // The card kinds that are frames, from the manifest:
        // a frame hides when its plugin is disabled instead
        // of showing a placeholder, so a settings UI can say
        // so. Empty when the plugin has no frame cards.
        frameKinds: (lp.manifest.contributions?.cards ?? [])
          .filter((c) => c.frame === true)
          .map((c) => c.kind),
      })),
      setEnabled: async (id: string, enabled: boolean) => {
        require("plugins:install");
        requireNotTrial("enable or disable a plugin");
        await setPluginEnabled(id, enabled);
      },
      reset: async () => {
        require("plugins:install");
        requireNotTrial("reset plugins");
        // Factory state: core plugins on, extras off. A
        // required plugin is on by definition, so it is never
        // turned off here. Trial plugins are not installed, so
        // they are untouched.
        for (const lp of Array.from(loaded.values())) {
          if (lp.trial) continue;
          await setPluginEnabled(lp.manifest.id, !!lp.firstParty);
        }
      },
      install: async (plugin) => {
        require("plugins:install");
        requireNotTrial("install a plugin");
        return bridge!.installPlugin(plugin);
      },
      refresh: async () => {
        require("plugins:install");
        requireNotTrial("install a plugin");
        await refreshPlugins();
      },
      try: async (plugin) => {
        require("plugins:install");
        requireNotTrial("try a plugin");
        return tryPlugin(plugin);
      },
      endTrial: async (id: string) => {
        require("plugins:install");
        requireNotTrial("end a trial");
        await endTrial(id);
      },
    },
    events: {
      on: (event: string, handler: () => void) => onEvent(event, handler),
      off: (event: string, handler: () => void) => offEvent(event, handler),
      // Fire an event for every listener. Listening is open:
      // a plugin follows the board, the tool, the view. Firing
      // is not: a core event name is rejected, so no plugin can
      // fake a board save, a tool change, or any other core
      // state change. A custom event name is the plugin's own
      // channel — the core never fires or listens for one — so
      // it is emitted as-is. The board view (the app's own UI)
      // emits "selection" and "tool" when they change.
      emit: (event: string) => {
        if (!trusted && CORE_EVENTS.has(event)) {
          throw new Error(`Plugin ${pluginId} cannot emit the core event "${event}"`);
        }
        emitPluginEvent(event);
      },
    },
    geometry: {
      centre: (item: Item) => centre(item),
      anchorPoint: (anchor: Anchor) => anchorPoint(host!.getBoard(), anchor),
      rectCrossing: (from: Pt, to: Pt, pos: Pt, w: number, h: number, entry: boolean) => rectCrossing(from, to, pos, w, h, entry),
      clippedEnds: (from: Anchor, to: Anchor) => clippedEnds(host!.getBoard(), from, to),
      segmentIntersectsRect: (a: Pt, b: Pt, rect: { x: number; y: number; w: number; h: number }) => segmentIntersectsRect(a, b, rect),
      rectsOverlap: (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,
      itemRotation: (item: Item) => itemRotation(item),
      itemBounds: (item: Item) => itemBounds(host!.getBoard(), item),
      rotatePoint: (p: Pt, c: Pt, deg: number) => rotatePoint(p, c, deg),
      fitCamera: (viewport: Size, padding?: number) => fitCamera(host!.getBoard(), viewport, padding),
    },
  };
}

// ---------------------------------------------------------------- registration

function registerCreateAction(pluginId: string, def: PluginCreateActionDef): void {
  if (def.icon && /<script/i.test(def.icon)) throw new Error(`Plugin ${pluginId} create action icon contains <script>`);
  createActions.set(`${pluginId}:${def.id}`, { ...def, pluginId });
}

// Every registered creation action, for the core's text
// editor (the first one's icon sits beside the text box).
// In registration order.
export function getCreateActions(): Array<PluginCreateActionDef & { pluginId: string }> {
  return Array.from(createActions.values());
}

function registerTool(pluginId: string, def: PluginToolDef): void {
  const fullId = `plugin:${pluginId}:${def.id}`;
  tools.set(fullId, { ...def, pluginId, fullId });
  if (!host) return;
  const btn = document.createElement("button");
  btn.id = domId(pluginId, "tool", def.id);
  btn.title = def.title;
  btn.setAttribute("aria-label", def.title);
  if (def.icon) {
    if (/<script/i.test(def.icon)) throw new Error(`Plugin ${pluginId} tool icon contains <script>`);
    btn.innerHTML = def.icon;
  } else {
    btn.textContent = def.title.slice(0, 1).toUpperCase();
  }
  btn.addEventListener("click", () => host!.setTool(fullId));
  shell.toolbarToolsEl?.appendChild(btn);
}

function registerCommand(pluginId: string, def: PluginCommandDef): void {
  commands.set(`${pluginId}:${def.id}`, { ...def, pluginId });
}

function registerOverlay(pluginId: string, def: PluginOverlayDef): void {
  if (!host) return;
  // An overlay container covers the board area but takes no
  // clicks itself (pointer-events: none in CSS). Interactive
  // elements a plugin puts inside it must set pointer-events:
  // auto on themselves, so board clicks pass through everywhere
  // except on the plugin's own controls. That is how a corner
  // button can sit in a corner without blocking the board.
  const wrap = document.createElement("div");
  wrap.className = "plugin-overlay";
  wrap.dataset.plugin = pluginId;
  wrap.dataset.overlay = def.id;
  shell.overlaysEl?.appendChild(wrap);
  overlays.set(`${pluginId}:${def.id}`, { ...def, pluginId, el: wrap });
  try {
    def.render(wrap);
  } catch (e) {
    wrap.textContent = `Overlay failed to render: ${String(e)}`;
  }
}

function registerSettingsSection(pluginId: string, def: PluginSettingsSectionDef): void {
  // Stored only; the core renders sections when Settings opens
  // (see renderSettingsSections), so a section registered while
  // Settings is already open appears on the next open, or when
  // the core re-renders sections after a plugin toggle.
  settingsSections.set(`${pluginId}:${def.id}`, { ...def, pluginId });
}

export function renderSettingsSections(): void {
  if (!host) return;
  const el = shell.settingsSectionsEl;
  if (!el) return;
  el.innerHTML = "";
  for (const s of settingsSections.values()) {
    const wrap = document.createElement("div");
    wrap.className = "plugin-settings-section";
    wrap.dataset.plugin = s.pluginId;
    // The section title is just a heading now: the Disable
    // button used to sit beside it, so a plugin could be
    // turned off from its own settings, but it duplicated
    // the Plugins tab's toggle and cluttered the section.
    // Enabling and disabling lives in the Plugins tab only.
    const head = document.createElement("h3");
    head.textContent = s.title;
    const body = document.createElement("div");
    wrap.appendChild(head);
    wrap.appendChild(body);
    el.appendChild(wrap);
    try {
      s.render(body);
    } catch (e) {
      body.textContent = `Settings section failed to render: ${String(e)}`;
    }
  }
}

function registerShortcut(pluginId: string, def: PluginShortcutDef): void {
  // Shortcuts in v1 are single keys, no modifiers. Core keys win:
  // the core checks its own shortcuts first, and handlePluginShortcut
  // is only called for keys the core did not handle, with Ctrl/Cmd
  // held keys excluded, so a plugin cannot steal Ctrl+G or similar.
  shortcuts.set(`${pluginId}:${def.key.toLowerCase()}`, { ...def, pluginId });
}

export function listPluginShortcuts(): Array<PluginShortcutDef & { pluginId: string; pluginName: string }> {
  const out: Array<PluginShortcutDef & { pluginId: string; pluginName: string }> = [];
  for (const s of shortcuts.values()) {
    const lp = loaded.get(s.pluginId);
    out.push({ ...s, pluginName: lp?.manifest.name ?? s.pluginId });
  }
  return out;
}

// The plugin that owns the first shortcut registered for a
// key, or null when no plugin registered one. Keys are
// single, lowercased, no modifiers — the same match rule
// handlePluginShortcut uses, so the owner here is the
// plugin whose handler that function would run.
export function shortcutOwner(key: string): string | null {
  const lower = key.toLowerCase();
  for (const s of shortcuts.values()) {
    if (s.key.toLowerCase() === lower) return s.pluginId;
  }
  return null;
}

export function handlePluginShortcut(key: string): boolean {
  // The core has already applied its guards (not in a textarea or
  // search box, Settings closed, not editing). Tab, Escape and
  // Space are core-owned and never reach here from the core handler.
  const lower = key.toLowerCase();
  if (lower === "tab" || lower === "escape" || lower === " ") return false;
  for (const s of shortcuts.values()) {
    if (s.key.toLowerCase() !== lower) continue;
    try {
      const r = s.run();
      if (r instanceof Promise) r.catch(() => undefined);
    } catch (e) {
      host?.toast(`Plugin shortcut failed: ${String(e)}`);
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- loading

// Drop every entry a plugin registered under its
// `pluginId:` prefix. Five maps are keyed that way
// (cards, decorators, create actions, commands, settings
// sections); the others are keyed differently and are
// handled by their own loops below.
function deletePrefixed<V>(map: Map<string, V>, pluginId: string): void {
  for (const key of Array.from(map.keys())) {
    if (key.startsWith(`${pluginId}:`)) map.delete(key);
  }
}

function unregisterPlugin(pluginId: string): void {
  deletePrefixed(cards, pluginId);
  deletePrefixed(cardDecorators, pluginId);
  for (const [fullId, t] of Array.from(tools.entries())) {
    if (t.pluginId === pluginId) {
      tools.delete(fullId);
      document.getElementById(domId(pluginId, "tool", t.id))?.remove();
    }
  }
  for (const [key, p] of Array.from(panels.entries())) {
    if (p.pluginId === pluginId) {
      panels.delete(key);
      p.tab.remove();
      p.el.remove();
    }
  }
  deactivateMissingActivePanel();
  updatePanelDock();
  for (const [key, v] of Array.from(views.entries())) {
    if (v.pluginId === pluginId) views.delete(key);
  }
  deletePrefixed(createActions, pluginId);
  deletePrefixed(commands, pluginId);
  for (const [key, o] of Array.from(overlays.entries())) {
    if (o.pluginId === pluginId) {
      overlays.delete(key);
      o.el.remove();
    }
  }
  deletePrefixed(settingsSections, pluginId);
  for (const [key, s] of Array.from(shortcuts.entries())) {
    if (s.pluginId === pluginId) shortcuts.delete(key);
  }
  if (host && getActiveView() !== "board") {
    const v = views.get(getActiveView());
    if (!v) setActiveView("board");
  }
  renderViewSwitcher();
  host?.render();
}

async function activatePlugin(manifest: PluginManifest, source?: { mainCode: string; styleCode: string }): Promise<void> {
  const lp = loaded.get(manifest.id);
  if (!lp || !bridge) return;
  // A first-party plugin's module is a bundled import, not a
  // file on disk: re-activate the retained module instead of
  // fetching plugin://<id>/main.js, which does not exist.
  // This is what makes disabling and re-enabling a core
  // plugin (toolbar, title bar, search, cards) work at
  // runtime; without it the re-enable 404s and the plugin
  // is left failed.
  if (lp.firstPartyModule) {
    const mod = lp.firstPartyModule;
    if (typeof mod.activate !== "function") {
      throw new Error(`Plugin ${manifest.id} does not export activate(api)`);
    }
    lp.module = mod;
    const api = createContext(manifest, { trial: !!lp.trial });
    await mod.activate(api);
    lp.active = true;
    lp.failed = false;
    lp.error = null;
    return;
  }
  // Styles first, so the plugin's first render already looks right.
  // A trial plugin has no files on disk, so its stylesheet comes
  // from the supplied code instead of the bridge.
  if (source) {
    if (source.styleCode.trim()) {
      const style = document.createElement("style");
      style.dataset.plugin = manifest.id;
      style.textContent = source.styleCode;
      document.head.appendChild(style);
    }
  } else {
    for (const stylePath of manifest.styles ?? []) {
      try {
        const css = await bridge.readPluginFile(manifest.id, stylePath);
        const style = document.createElement("style");
        style.dataset.plugin = manifest.id;
        style.textContent = css;
        document.head.appendChild(style);
      } catch (e) {
        // A missing stylesheet must not block the plugin.
        console.warn(`Plugin ${manifest.id} stylesheet ${stylePath} failed: ${String(e)}`);
      }
    }
  }
  // A user plugin loads as an ES module over the plugin:
  // scheme, so its main.js has a real URL base and its
  // relative imports resolve against its own folder — the
  // same as a first-party plugin. A blob URL has no base,
  // so a relative import cannot resolve at all; that is
  // why user plugins were single-file until now. A trial
  // plugin has no files on disk, so it still loads from a
  // blob URL — a single-file plugin is the special case.
  let url: string | null = null;
  if (source) {
    const blob = new Blob([source.mainCode], { type: "text/javascript" });
    url = URL.createObjectURL(blob);
  } else {
    const mainPath = manifest.main.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    url = `plugin://${encodeURIComponent(manifest.id)}/${mainPath}`;
  }
  try {
    const mod = (await import(/* @vite-ignore */ url)) as {
      activate?: (api: PluginContext) => void | Promise<void>;
      deactivate?: () => void | Promise<void>;
    };
    if (typeof mod.activate !== "function") {
      throw new Error(`Plugin ${manifest.id} main.js does not export activate(api)`);
    }
    lp.module = mod;
    const api = createContext(manifest, { trial: !!lp.trial });
    await mod.activate(api);
    lp.active = true;
    lp.failed = false;
    lp.error = null;
  } finally {
    if (source && url) URL.revokeObjectURL(url);
  }
}

// First-party plugins: bundled UI plugins that ship with the
// app. They are ES modules imported by the core. A user plugin
// is the same: an ES module loaded over the plugin: scheme, so
// it can be multiple files with relative imports. The only
// difference is loading (bundled import vs plugin: URL). They
// get the same PluginContext, the same permission checks, and
// the same manifest, and they appear in the plugin list the
// same way. A first-party plugin has no back door: if it needs
// something, that something is in the API.
export async function activateFirstPartyPlugin(
  manifest: PluginManifest,
  mod: { activate?: (api: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> },
): Promise<void> {
  if (!bridge || !host) throw new Error("plugins are not ready yet");
  if (loaded.has(manifest.id)) throw new Error(`a plugin called ${manifest.id} already exists`);
  if (typeof mod.activate !== "function") {
    throw new Error(`Plugin ${manifest.id} does not export activate(api)`);
  }
  loaded.set(manifest.id, { manifest, firstParty: true, firstPartyModule: mod, active: false, failed: false, error: null, module: null });
  const lp = loaded.get(manifest.id)!;
  try {
    lp.module = mod;
    const api = createContext(manifest, { firstParty: true });
    await mod.activate(api);
    lp.active = true;
    lp.failed = false;
    lp.error = null;
  } catch (e) {
    lp.failed = true;
    lp.error = String(e);
    lp.active = false;
    lp.module = null;
    unregisterPlugin(manifest.id);
    throw e;
  }
  renderViewSwitcher();
  updatePanelDock();
}

async function deactivatePlugin(manifest: PluginManifest): Promise<void> {
  const lp = loaded.get(manifest.id);
  if (!lp) return;
  if (lp.module?.deactivate) {
    try {
      await lp.module.deactivate();
    } catch {
      // Deactivate failures must not trap the user with the plugin on.
    }
  }
  lp.module = null;
  lp.active = false;
  unregisterPlugin(manifest.id);
  document.querySelectorAll(`style[data-plugin="${manifest.id}"]`).forEach((el) => el.remove());
}

// ---------------------------------------------------------------- trial plugins
//
// A trial plugin is activated from the supplied code, in memory
// only — nothing is written to the plugins folder, so ending the
// trial (or quitting the app) removes it completely. This is a
// reversibility trial, not a code sandbox: the plugin still runs
// in the renderer with the same permission checks as an installed
// plugin, and the trial guards in createContext only stop it
// making permanent changes (installing plugins, creating or
// deleting boards). A trial plugin's own storage writes, if it
// has the storage permission, are scoped by its id and inert
// once the trial ends, because no plugin with that id exists
// to read them again. The Builder panel says all of this in
// plain language while a trial is running; it must not be
// presented to the user as a security sandbox.
export async function tryPlugin(plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string; styleCode: string }): Promise<PluginManifest> {
  if (!bridge || !host) throw new Error("plugins are not ready yet");
  if (typeof plugin.id !== "string" || !/^[a-z0-9-]+$/.test(plugin.id)) throw new Error("plugin id must be lowercase letters, digits and hyphens");
  if (typeof plugin.name !== "string" || !plugin.name.trim() || typeof plugin.mainCode !== "string" || !plugin.mainCode.trim()) throw new Error("plugin name and code are required");
  if (plugin.mainCode.length > 200000 || (typeof plugin.styleCode === "string" && plugin.styleCode.length > 200000)) throw new Error("plugin code is too large");
  if (!Array.isArray(plugin.permissions) || plugin.permissions.some((p) => typeof p !== "string")) throw new Error("plugin permissions must be strings");
  if (loaded.has(plugin.id)) throw new Error(`a plugin called ${plugin.id} already exists`);
  const manifest: PluginManifest = {
    apiVersion: "2",
    id: plugin.id,
    name: plugin.name.trim(),
    description: typeof plugin.description === "string" ? plugin.description : "",
    version: "1.0.0",
    main: "main.js",
    styles: typeof plugin.styleCode === "string" && plugin.styleCode.trim() ? ["style.css"] : [],
    permissions: plugin.permissions,
  };
  loaded.set(plugin.id, { manifest, trial: true, active: false, failed: false, error: null, module: null });
  try {
    await activatePlugin(manifest, { mainCode: plugin.mainCode, styleCode: plugin.styleCode ?? "" });
  } catch (e) {
    loaded.delete(plugin.id);
    throw e;
  }
  renderViewSwitcher();
  host.render();
  return manifest;
}

export async function endTrial(id: string): Promise<void> {
  const lp = loaded.get(id);
  if (!lp || !lp.trial) return;
  await deactivatePlugin(lp.manifest);
  loaded.delete(id);
  host?.render();
}

// Activate one manifest, marking it failed on error.
// Shared by initPlugins, refreshPlugins and
// setPluginEnabled's retry — the version check and the
// failure bookkeeping are identical at each site.
async function tryActivateManifest(m: PluginManifest): Promise<void> {
  if (m.apiVersion !== "2") {
    const lp = loaded.get(m.id)!;
    lp.failed = true;
    lp.error = `Requires plugin API ${m.apiVersion}, this app provides 2`;
    return;
  }
  try {
    await activatePlugin(m);
  } catch (e) {
    const lp = loaded.get(m.id)!;
    lp.failed = true;
    lp.error = String(e);
    lp.active = false;
    unregisterPlugin(m.id);
    host!.toast(`Plugin ${m.name} failed to load: ${String(e)}`);
  }
}

export async function initPlugins(
  h: PluginHost,
  b: PluginBridge,
  firstParty: Array<{ manifest: PluginManifest; module: { activate?: (api: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> } }> = [],
): Promise<void> {
  host = h;
  bridge = b;
  // The panel dock reads the host, bridge and pluginsReady
  // through getter closures over these lets (host-panels).
  bindPanelDeps({
    getHost: () => host,
    getBridge: () => bridge,
    isPluginsReady: () => pluginsReady,
  });
  // The view switcher reads the host and the plugin event
  // bus through getter closures (host-views).
  bindViewDeps({
    getHost: () => host,
    emitEvent: (event: string) => emitPluginEvent(event),
  });
  // The card registry reads the host for toasts on a failed
  // card action/command (host-cards).
  bindCardDeps({
    getHost: () => host,
  });
  // The plugin tool buttons are the plugin system's own DOM,
  // so it syncs their active state when the tool changes —
  // the board just emits "tool" and never reaches into the
  // plugin system to sync them.
  if (!toolButtonsSynced) {
    toolButtonsSynced = true;
    onEvent("tool", () => syncPluginToolButtons(boardGetTool()));
  }
  wirePanelsToggle();
  ensureResizeHandle();
  try {
    const settings = await b.getAppSettings();
    applySavedPanelSettings(settings);
  } catch {
    // No saved width: keep the default.
  }
  // First-party UI plugins first, so the UI exists before user
  // plugins register panels, views, tools and settings sections
  // into it. A first-party plugin that fails to load is a
  // broken app, so the failure is surfaced, not swallowed.
  // A first-party plugin is enabled unless the user explicitly
  // disabled it in Settings → Plugins: the same enabled map
  // that gates user plugins gates these too, so the core
  // plugins and user plugins behave the same. (Absent from the
  // map means enabled — the built-in UI is on by default.)
  let enabledMap: Record<string, boolean> = {};
  try {
    enabledMap = await b.getPluginEnabled();
  } catch {
    // No map yet: everything is enabled.
  }
  for (const fp of firstParty) {
    // A required plugin is always enabled, whatever the
    // enabled map says: a stale "false" in plugins.json
    // (from before the plugin became required, or from a
    // hand edit) must not lock the app out of its own
    // board or its Settings window.
    if (enabledMap[fp.manifest.id] === false && !fp.manifest.required) {
      // Still register it as loaded-but-inactive, so it
      // shows in Settings and can be re-enabled there. A
      // plugin skipped here never entered the loaded map,
      // so it vanished from the list entirely and the only
      // way back was editing plugins.json by hand. Its
      // bundled module is retained, so re-enabling it
      // re-activates the same module.
      loaded.set(fp.manifest.id, { manifest: fp.manifest, firstParty: true, firstPartyModule: fp.module, active: false, failed: false, error: null, module: null });
      continue;
    }
    try {
      await activateFirstPartyPlugin(fp.manifest, fp.module);
    } catch (e) {
      h.toast(`Built-in plugin ${fp.manifest.name} failed to load: ${String(e)}`);
    }
  }
  let manifests: PluginManifest[] = [];
  try {
    manifests = await b.listPlugins();
  } catch (e) {
    h.toast(`Could not list plugins: ${String(e)}`);
    pluginsReady = true;
    return;
  }
  for (const m of manifests) {
    loaded.set(m.id, { manifest: m, active: false, failed: false, error: null, module: null });
  }
  for (const m of manifests) {
    if (m.enabled === false) continue;
    await tryActivateManifest(m);
  }
  renderViewSwitcher();
  updatePanelDock();
  pluginsReady = true;
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  if (!bridge || !host) return;
  const lp = loaded.get(id);
  if (!lp) return;
  // A required plugin cannot be disabled: it is the
  // foundation (board, Settings) whose absence would
  // remove the only way to re-enable it.
  if (!enabled && lp.manifest.required) throw new Error(`${lp.manifest.name} is required and cannot be disabled`);
  // A trial plugin is owned by the Builder panel (Install/Clean),
  // not by the Settings toggle, so a toggle must not desync it
  // or write a persisted enabled state for a plugin that is
  // not on disk.
  if (lp.trial) return;
  await bridge.setPluginEnabled(id, enabled);
  lp.manifest.enabled = enabled;
  if (enabled && !lp.active) {
    // A previously failed plugin gets one retry on re-enable; a
    // plugin that failed to load is not retried silently on every
    // toggle — the user re-enabling it is the retry. Clearing
    // the failure first is a no-op for a plugin that never
    // failed.
    lp.failed = false;
    lp.error = null;
    await tryActivateManifest(lp.manifest);
  } else if (!enabled && lp.active) {
    await deactivatePlugin(lp.manifest);
  }
  host.render();
}

// Re-scan for plugins installed since startup, and activate
// any new ones that are enabled. Used after an install, so
// a new plugin runs without restarting the app. Existing
// plugins are untouched: this only adds manifests that are
// not already in the loaded map.
export async function refreshPlugins(): Promise<void> {
  if (!bridge || !host) return;
  let manifests: PluginManifest[] = [];
  try {
    manifests = await bridge.listPlugins();
  } catch {
    return;
  }
  for (const m of manifests) {
    if (loaded.has(m.id)) continue;
    loaded.set(m.id, { manifest: m, active: false, failed: false, error: null, module: null });
    if (m.enabled === false) continue;
    await tryActivateManifest(m);
  }
  renderViewSwitcher();
  updatePanelDock();
  host.render();
}
