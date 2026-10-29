// Preload bridge: the only privileged surface the renderer sees.
// The renderer runs with context isolation on and no Node access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bowerbird', {
  loadBoard: () => ipcRenderer.invoke('bowerbird:load-board'),
  saveBoard: (json) => ipcRenderer.invoke('bowerbird:save-board', json),
  embedFile: (filePath) => ipcRenderer.invoke('bowerbird:embed-file', filePath),
  readTextFile: (filePath) => ipcRenderer.invoke('bowerbird:read-text-file', filePath),
  fileSize: (filePath) => ipcRenderer.invoke('bowerbird:file-size', filePath),
  fetchPreview: (url) => ipcRenderer.invoke('bowerbird:fetch-preview', url),
  createEmbed: (label, url, x, y, w, h) => ipcRenderer.invoke('bowerbird:create-embed', label, url, x, y, w, h),
  moveEmbed: (label, x, y, w, h) => ipcRenderer.invoke('bowerbird:move-embed', label, x, y, w, h),
  hideEmbed: (label) => ipcRenderer.invoke('bowerbird:hide-embed', label),
  destroyEmbed: (label) => ipcRenderer.invoke('bowerbird:destroy-embed', label),
  openExternal: (target) => ipcRenderer.invoke('bowerbird:open-external', target),
  minimise: () => ipcRenderer.invoke('bowerbird:minimise'),
  closeWindow: () => ipcRenderer.invoke('bowerbird:close-window'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  fileUrl: (filePath) => 'app-file://' + filePath.split('/').map(encodeURIComponent).join('/'),
});
