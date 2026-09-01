const { contextBridge, ipcRenderer } = require('electron');

// additionalArguments 形如 --dl-id=42
const dlIdArg = (process.argv || []).find((a) => a && a.startsWith('--dl-id='));
const dlId = dlIdArg ? dlIdArg.slice('--dl-id='.length) : '0';

contextBridge.exposeInMainWorld('fnosDownload', {
  id: dlId,
  onStart: (cb) => ipcRenderer.on('download:start', (_e, data) => cb(data)),
  onProgress: (cb) => ipcRenderer.on('download:progress', (_e, data) => cb(data)),
  onDone: (cb) => ipcRenderer.on('download:done', (_e, data) => cb(data)),
  cancel: () => ipcRenderer.invoke(`download:cancel:${dlId}`),
  close: () => ipcRenderer.invoke(`download:close:${dlId}`),
  openFolder: () => ipcRenderer.invoke(`download:open:${dlId}`),
});
