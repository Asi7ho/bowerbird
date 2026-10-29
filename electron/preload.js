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
  openExternal: (target) => ipcRenderer.invoke('bowerbird:open-external', target),
  minimise: () => ipcRenderer.invoke('bowerbird:minimise'),
  closeWindow: () => ipcRenderer.invoke('bowerbird:close-window'),
  fullscreen: () => ipcRenderer.invoke('bowerbird:fullscreen'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  fileUrl: (filePath) => 'app-file://' + filePath.split('/').map(encodeURIComponent).join('/'),
});
