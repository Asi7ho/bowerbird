// Preload bridge: the only privileged surface the renderer sees.
// The renderer runs with context isolation on and no Node access.
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("bowerbird", {
  platform: process.platform,
  loadBoard: () => ipcRenderer.invoke("bowerbird:load-board"),
  saveBoard: (json: string) => ipcRenderer.invoke("bowerbird:save-board", json),
  saveBoardSync: (json: string) => ipcRenderer.sendSync("bowerbird:save-board-sync", json),
  onExternalBoardChange: (cb: () => void) => { ipcRenderer.on("bowerbird:board-changed-external", () => cb()); },
  setWatchedSources: (paths: string[]) => ipcRenderer.invoke("bowerbird:set-watched-sources", paths),
  onSourceChanged: (cb: (ev: { path: string; exists: boolean; size: number; mtimeMs: number }) => void) => { ipcRenderer.on("bowerbird:source-changed", (_event, ev) => cb(ev)); },
  listBoards: () => ipcRenderer.invoke("bowerbird:list-boards"),
  createBoard: (name: string) => ipcRenderer.invoke("bowerbird:create-board", name),
  switchBoard: (name: string) => ipcRenderer.invoke("bowerbird:switch-board", name),
  renameBoard: (oldName: string, newName: string) => ipcRenderer.invoke("bowerbird:rename-board", oldName, newName),
  deleteBoard: (name: string, opts?: { confirmed?: boolean }) => ipcRenderer.invoke("bowerbird:delete-board", name, opts),
  listBackups: () => ipcRenderer.invoke("bowerbird:list-backups"),
  listAllBackups: () => ipcRenderer.invoke("bowerbird:list-all-backups"),
  restoreBackup: (name: string) => ipcRenderer.invoke("bowerbird:restore-backup", name),
  // Crash recovery (see electron/recovery.ts): the journal is
  // written synchronously before every save and cleared once
  // the save lands, so unsaved edits survive a kill.
  recoveryWriteSync: (json: string) => ipcRenderer.sendSync("bowerbird:recovery-write-sync", json),
  recoveryClear: (json: string) => ipcRenderer.invoke("bowerbird:recovery-clear", json),
  recoveryStatus: () => ipcRenderer.invoke("bowerbird:recovery-status"),
  recoveryRestore: () => ipcRenderer.invoke("bowerbird:recovery-restore"),
  recoveryDiscard: () => ipcRenderer.invoke("bowerbird:recovery-discard"),
  openBackupsFolder: () => ipcRenderer.invoke("bowerbird:open-backups-folder"),
  exportBoard: () => ipcRenderer.invoke("bowerbird:export-board"),
  importBoard: () => ipcRenderer.invoke("bowerbird:import-board"),
  resetBoard: (opts?: { confirmed?: boolean }) => ipcRenderer.invoke("bowerbird:reset-board", opts),
  factoryReset: (opts?: { confirmed?: boolean }) => ipcRenderer.invoke("bowerbird:factory-reset", opts),
  restoreShowcase: () => ipcRenderer.invoke("bowerbird:restore-showcase"),
  readFileBase64: (filePath: string) => ipcRenderer.invoke("bowerbird:read-file-base64", filePath),
  contextEmbedImage: (filePath: string) => ipcRenderer.invoke("bowerbird:context-embed-image", filePath),
  contextEmbedFrame: (dataUrl: string) => ipcRenderer.invoke("bowerbird:context-embed-frame", dataUrl),
  contextEmbedText: (text: string) => ipcRenderer.invoke("bowerbird:context-embed-text", text),
  contextClassifyAudio: (pcm: Float32Array) => ipcRenderer.invoke("bowerbird:context-classify-audio", pcm),
  transcribeAudio: (pcm: Float32Array) => ipcRenderer.invoke("bowerbird:transcribe-audio", pcm),
  contextIndexLoad: () => ipcRenderer.invoke("bowerbird:context-index-load"),
  contextIndexSave: (index: unknown) => ipcRenderer.invoke("bowerbird:context-index-save", index),
  contextIndexSaveSync: (index: unknown) => ipcRenderer.sendSync("bowerbird:context-index-save-sync", index),
  checkFile: (filePath: string) => ipcRenderer.invoke("bowerbird:check-file", filePath),
  embedFile: (filePath: string) => ipcRenderer.invoke("bowerbird:embed-file", filePath),
  embedFileBytes: (name: string, data: ArrayBuffer | Uint8Array) => ipcRenderer.invoke("bowerbird:embed-file-bytes", name, data),
  readTextFile: (filePath: string) => ipcRenderer.invoke("bowerbird:read-text-file", filePath),
  fileSize: (filePath: string) => ipcRenderer.invoke("bowerbird:file-size", filePath),
  fetchPreview: (url: string) => ipcRenderer.invoke("bowerbird:fetch-preview", url),
  // The AI key never travels through here: ai-chat reads it
  // in the main process, and ai-set-key is write-only.
  aiChat: (opts: { base: string; model: string; messages: Array<{ role: string; content: string }> }) => ipcRenderer.invoke("bowerbird:ai-chat", opts),
  aiHasKey: () => ipcRenderer.invoke("bowerbird:ai-has-key"),
  aiSetKey: (key: string) => ipcRenderer.invoke("bowerbird:ai-set-key", key),
  openExternal: (target: string) => ipcRenderer.invoke("bowerbird:open-external", target),
  getAppSettings: () => ipcRenderer.invoke("bowerbird:get-app-settings"),
  setPanelWidth: (width: number) => ipcRenderer.invoke("bowerbird:set-panel-width", width),
  setDockVisible: (visible: boolean) => ipcRenderer.invoke("bowerbird:set-dock-visible", visible),
  setCorner: (corner: string) => ipcRenderer.invoke("bowerbird:set-corner", corner),
  setPanelOrder: (order: string[]) => ipcRenderer.invoke("bowerbird:set-panel-order", order),
  setShortcuts: (overrides: Record<string, string>) => ipcRenderer.invoke("bowerbird:set-shortcuts", overrides),
  setHardwareAcceleration: (enabled: boolean) => ipcRenderer.invoke("bowerbird:set-hardware-acceleration", enabled),
  restart: () => ipcRenderer.invoke("bowerbird:restart"),
  collapse: () => ipcRenderer.invoke("bowerbird:collapse"),
  moveWindow: (dx: number, dy: number) => ipcRenderer.send("bowerbird:move-window", dx, dy),
  restore: () => ipcRenderer.invoke("bowerbird:restore"),
  minimise: () => ipcRenderer.invoke("bowerbird:minimise"),
  closeWindow: () => ipcRenderer.invoke("bowerbird:close-window"),
  quit: () => ipcRenderer.invoke("bowerbird:quit"),
  fullscreen: () => ipcRenderer.invoke("bowerbird:fullscreen"),
  maximise: () => ipcRenderer.invoke("bowerbird:maximise"),
  windowState: () => ipcRenderer.invoke("bowerbird:window-state"),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  // app-file://localhost + path, NOT app-file:// + path:
  // Chromium lowercases the hostname of a standard
  // scheme, so app-file:///Users/x became app-file://users/x
  // and the handler's board-local check rejected it — the
  // Mac media failure. With a literal localhost host, the
  // real path stays in the pathname, whose case Chromium
  // preserves.
  fileUrl: (filePath: string) => "app-file://localhost" + (filePath.startsWith("/") ? "" : "/") + filePath.split("/").map(encodeURIComponent).join("/"),
  // Plugins (see PLUGIN_API.md): discovery, file serving and
  // per-plugin storage, all through the main process. The renderer
  // never reads plugin folders directly.
  listPlugins: () => ipcRenderer.invoke("bowerbird:list-plugins"),
  readPluginFile: (pluginId: string, relativePath: string) => ipcRenderer.invoke("bowerbird:read-plugin-file", pluginId, relativePath),
  getPluginEnabled: () => ipcRenderer.invoke("bowerbird:get-plugin-enabled"),
  setPluginEnabled: (pluginId: string, enabled: boolean) => ipcRenderer.invoke("bowerbird:set-plugin-enabled", pluginId, enabled),
  installPlugin: (plugin: unknown) => ipcRenderer.invoke("bowerbird:install-plugin", plugin),
  pluginStorageGet: (pluginId: string, key: string) => ipcRenderer.invoke("bowerbird:plugin-storage-get", pluginId, key),
  pluginStorageSet: (pluginId: string, key: string, value: unknown) => ipcRenderer.invoke("bowerbird:plugin-storage-set", pluginId, key, value),
  pluginStorageDelete: (pluginId: string, key: string) => ipcRenderer.invoke("bowerbird:plugin-storage-delete", pluginId, key),
  secureStorageAvailable: () => ipcRenderer.invoke("bowerbird:secure-storage-available"),
  secureStorageGet: (pluginId: string, key: string) => ipcRenderer.invoke("bowerbird:secure-storage-get", pluginId, key),
  secureStorageSet: (pluginId: string, key: string, value: string) => ipcRenderer.invoke("bowerbird:secure-storage-set", pluginId, key, value),
  secureStorageDelete: (pluginId: string, key: string) => ipcRenderer.invoke("bowerbird:secure-storage-delete", pluginId, key),
  listLibrary: () => ipcRenderer.invoke("bowerbird:list-library"),
  createLibraryCategory: (name: string) => ipcRenderer.invoke("bowerbird:create-library-category", name),
  moveLibraryItem: (relativePath: string, category: string | null) => ipcRenderer.invoke("bowerbird:move-library-item", relativePath, category),
});
