const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnosDownload', {
  onStart: (cb) => ipcRenderer.on('download:start', (_e, data) => cb(data)),
  onProgress: (cb) => ipcRenderer.on('download:progress', (_e, data) => cb(data)),
  onDone: (cb) => ipcRenderer.on('download:done', (_e, data) => cb(data)),
  cancel: () => ipcRenderer.invoke('download:cancel'),
  close: () => ipcRenderer.invoke('download:close'),
  openFolder: () => ipcRenderer.invoke('download:open-folder'),
});
