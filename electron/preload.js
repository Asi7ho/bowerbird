// Preload bridge: the only privileged surface the renderer sees.
// The renderer runs with context isolation on and no Node access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bowerbird', {
  isDemo: process.env.BOWERBIRD_DEMO === '1',
  loadBoard: () => ipcRenderer.invoke('bowerbird:load-board'),
  saveBoard: (json) => ipcRenderer.invoke('bowerbird:save-board', json),
  resetBoard: () => ipcRenderer.invoke('bowerbird:reset-board'),
  embedFile: (filePath) => ipcRenderer.invoke('bowerbird:embed-file', filePath),
  readTextFile: (filePath) => ipcRenderer.invoke('bowerbird:read-text-file', filePath),
  fileSize: (filePath) => ipcRenderer.invoke('bowerbird:file-size', filePath),
  fetchPreview: (url) => ipcRenderer.invoke('bowerbird:fetch-preview', url),
  openExternal: (target) => ipcRenderer.invoke('bowerbird:open-external', target),
  getAppSettings: () => ipcRenderer.invoke('bowerbird:get-app-settings'),
  setCorner: (corner) => ipcRenderer.invoke('bowerbird:set-corner', corner),
  setPanelOrder: (order) => ipcRenderer.invoke('bowerbird:set-panel-order', order),
  collapse: () => ipcRenderer.invoke('bowerbird:collapse'),
  moveWindow: (dx, dy) => ipcRenderer.send('bowerbird:move-window', dx, dy),
  restore: () => ipcRenderer.invoke('bowerbird:restore'),
  minimise: () => ipcRenderer.invoke('bowerbird:minimise'),
  closeWindow: () => ipcRenderer.invoke('bowerbird:close-window'),
  quit: () => ipcRenderer.invoke('bowerbird:quit'),
  fullscreen: () => ipcRenderer.invoke('bowerbird:fullscreen'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  fileUrl: (filePath) => 'app-file://' + filePath.split('/').map(encodeURIComponent).join('/'),
  // Plugins (see PLUGIN_API.md): discovery, file serving and
  // per-plugin storage, all through the main process. The renderer
  // never reads plugin folders directly.
  listPlugins: () => ipcRenderer.invoke('bowerbird:list-plugins'),
  readPluginFile: (pluginId, relativePath) => ipcRenderer.invoke('bowerbird:read-plugin-file', pluginId, relativePath),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke('bowerbird:set-plugin-enabled', pluginId, enabled),
  installPlugin: (plugin) => ipcRenderer.invoke('bowerbird:install-plugin', plugin),
  llmChat: (req) => ipcRenderer.invoke('bowerbird:llm-chat', req),
  pluginStorageGet: (pluginId, key) => ipcRenderer.invoke('bowerbird:plugin-storage-get', pluginId, key),
  pluginStorageSet: (pluginId, key, value) => ipcRenderer.invoke('bowerbird:plugin-storage-set', pluginId, key, value),
  pluginStorageDelete: (pluginId, key) => ipcRenderer.invoke('bowerbird:plugin-storage-delete', pluginId, key),
  secureStorageAvailable: () => ipcRenderer.invoke('bowerbird:secure-storage-available'),
  secureStorageGet: (pluginId, key) => ipcRenderer.invoke('bowerbird:secure-storage-get', pluginId, key),
  secureStorageSet: (pluginId, key, value) => ipcRenderer.invoke('bowerbird:secure-storage-set', pluginId, key, value),
  secureStorageDelete: (pluginId, key) => ipcRenderer.invoke('bowerbird:secure-storage-delete', pluginId, key),
  listLibrary: () => ipcRenderer.invoke('bowerbird:list-library'),
  createLibraryCategory: (name) => ipcRenderer.invoke('bowerbird:create-library-category', name),
  addToLibrary: (filePath) => ipcRenderer.invoke('bowerbird:add-to-library', filePath),
  moveLibraryItem: (relativePath, category) => ipcRenderer.invoke('bowerbird:move-library-item', relativePath, category),
});
