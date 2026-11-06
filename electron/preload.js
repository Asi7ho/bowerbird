// Preload bridge: the only privileged surface the renderer sees.
// The renderer runs with context isolation on and no Node access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bowerbird', {
  isDemo: process.env.BOWERBIRD_DEMO === '1',
  platform: process.platform,
  loadBoard: () => ipcRenderer.invoke('bowerbird:load-board'),
  saveBoard: (json) => ipcRenderer.invoke('bowerbird:save-board', json),
  listBoards: () => ipcRenderer.invoke('bowerbird:list-boards'),
  createBoard: (name) => ipcRenderer.invoke('bowerbird:create-board', name),
  switchBoard: (name) => ipcRenderer.invoke('bowerbird:switch-board', name),
  renameBoard: (oldName, newName) => ipcRenderer.invoke('bowerbird:rename-board', oldName, newName),
  deleteBoard: (name) => ipcRenderer.invoke('bowerbird:delete-board', name),
  listBackups: () => ipcRenderer.invoke('bowerbird:list-backups'),
  restoreBackup: (name) => ipcRenderer.invoke('bowerbird:restore-backup', name),
  resetBoard: () => ipcRenderer.invoke('bowerbird:reset-board'),
  restoreShowcase: () => ipcRenderer.invoke('bowerbird:restore-showcase'),
  readFileBase64: (filePath) => ipcRenderer.invoke('bowerbird:read-file-base64', filePath),
  contextEmbedImage: (filePath) => ipcRenderer.invoke('bowerbird:context-embed-image', filePath),
  contextEmbedFrame: (dataUrl) => ipcRenderer.invoke('bowerbird:context-embed-frame', dataUrl),
  contextEmbedText: (text) => ipcRenderer.invoke('bowerbird:context-embed-text', text),
  contextClassifyAudio: (pcm) => ipcRenderer.invoke('bowerbird:context-classify-audio', pcm),
  contextIndexLoad: () => ipcRenderer.invoke('bowerbird:context-index-load'),
  contextIndexSave: (index) => ipcRenderer.invoke('bowerbird:context-index-save', index),
  contextIndexSaveSync: (index) => ipcRenderer.sendSync('bowerbird:context-index-save-sync', index),
  checkFile: (filePath) => ipcRenderer.invoke('bowerbird:check-file', filePath),
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
  maximise: () => ipcRenderer.invoke('bowerbird:maximise'),
  windowState: () => ipcRenderer.invoke('bowerbird:window-state'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // app-file://localhost + path, NOT app-file:// + path:
  // Chromium lowercases the hostname of a standard
  // scheme, so app-file:///Users/x became app-file://users/x
  // and the handler's board-local check rejected it — the
  // Mac media failure. With a literal localhost host, the
  // real path stays in the pathname, whose case Chromium
  // preserves.
  fileUrl: (filePath) => 'app-file://localhost' + (filePath.startsWith('/') ? '' : '/') + filePath.split('/').map(encodeURIComponent).join('/'),
  // Plugins (see PLUGIN_API.md): discovery, file serving and
  // per-plugin storage, all through the main process. The renderer
  // never reads plugin folders directly.
  listPlugins: () => ipcRenderer.invoke('bowerbird:list-plugins'),
  readPluginFile: (pluginId, relativePath) => ipcRenderer.invoke('bowerbird:read-plugin-file', pluginId, relativePath),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke('bowerbird:set-plugin-enabled', pluginId, enabled),
  installPlugin: (plugin) => ipcRenderer.invoke('bowerbird:install-plugin', plugin),
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
