// Preload bridge: the only privileged surface the renderer sees.
// The renderer runs with context isolation on and no Node access.
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("bowerbird", {
  isDemo: process.env.BOWERBIRD_DEMO === "1",
  platform: process.platform,
  loadBoard: () => ipcRenderer.invoke("bowerbird:load-board"),
  saveBoard: (json: string) => ipcRenderer.invoke("bowerbird:save-board", json),
  listBoards: () => ipcRenderer.invoke("bowerbird:list-boards"),
  createBoard: (name: string) => ipcRenderer.invoke("bowerbird:create-board", name),
  switchBoard: (name: string) => ipcRenderer.invoke("bowerbird:switch-board", name),
  renameBoard: (oldName: string, newName: string) => ipcRenderer.invoke("bowerbird:rename-board", oldName, newName),
  deleteBoard: (name: string) => ipcRenderer.invoke("bowerbird:delete-board", name),
  listBackups: () => ipcRenderer.invoke("bowerbird:list-backups"),
  restoreBackup: (name: string) => ipcRenderer.invoke("bowerbird:restore-backup", name),
  resetBoard: () => ipcRenderer.invoke("bowerbird:reset-board"),
  restoreShowcase: () => ipcRenderer.invoke("bowerbird:restore-showcase"),
  readFileBase64: (filePath: string) => ipcRenderer.invoke("bowerbird:read-file-base64", filePath),
  contextEmbedImage: (filePath: string) => ipcRenderer.invoke("bowerbird:context-embed-image", filePath),
  contextEmbedFrame: (dataUrl: string) => ipcRenderer.invoke("bowerbird:context-embed-frame", dataUrl),
  contextEmbedText: (text: string) => ipcRenderer.invoke("bowerbird:context-embed-text", text),
  contextClassifyAudio: (pcm: Float32Array) => ipcRenderer.invoke("bowerbird:context-classify-audio", pcm),
  contextIndexLoad: () => ipcRenderer.invoke("bowerbird:context-index-load"),
  contextIndexSave: (index: unknown) => ipcRenderer.invoke("bowerbird:context-index-save", index),
  contextIndexSaveSync: (index: unknown) => ipcRenderer.sendSync("bowerbird:context-index-save-sync", index),
  checkFile: (filePath: string) => ipcRenderer.invoke("bowerbird:check-file", filePath),
  embedFile: (filePath: string) => ipcRenderer.invoke("bowerbird:embed-file", filePath),
  readTextFile: (filePath: string) => ipcRenderer.invoke("bowerbird:read-text-file", filePath),
  fileSize: (filePath: string) => ipcRenderer.invoke("bowerbird:file-size", filePath),
  fetchPreview: (url: string) => ipcRenderer.invoke("bowerbird:fetch-preview", url),
  aiChat: (opts: { base: string; key: string; model: string; messages: Array<{ role: string; content: string }> }) => ipcRenderer.invoke("bowerbird:ai-chat", opts),
  openExternal: (target: string) => ipcRenderer.invoke("bowerbird:open-external", target),
  getAppSettings: () => ipcRenderer.invoke("bowerbird:get-app-settings"),
  setCorner: (corner: string) => ipcRenderer.invoke("bowerbird:set-corner", corner),
  setPanelOrder: (order: string[]) => ipcRenderer.invoke("bowerbird:set-panel-order", order),
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
  addToLibrary: (filePath: string) => ipcRenderer.invoke("bowerbird:add-to-library", filePath),
  moveLibraryItem: (relativePath: string, category: string | null) => ipcRenderer.invoke("bowerbird:move-library-item", relativePath, category),
});
