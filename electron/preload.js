// Preload bridge: the only privileged surface the renderer sees.
// The renderer runs with context isolation on and no Node access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bowerbird', {
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
  collapse: () => ipcRenderer.invoke('bowerbird:collapse'),
  restore: () => ipcRenderer.invoke('bowerbird:restore'),
  minimise: () => ipcRenderer.invoke('bowerbird:minimise'),
  closeWindow: () => ipcRenderer.invoke('bowerbird:close-window'),
  quit: () => ipcRenderer.invoke('bowerbird:quit'),
  fullscreen: () => ipcRenderer.invoke('bowerbird:fullscreen'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  fileUrl: (filePath) => 'app-file://' + filePath.split('/').map(encodeURIComponent).join('/'),
});
