/* FNOS 对话框专用 preload：通过 contextBridge 暴露 IPC */
const { contextBridge, ipcRenderer } = require('electron');

// 主进程在渲染端加载前，通过 once 回调把 options 同步传过来
let cachedOptions = null;
ipcRenderer.on('dialog:options', (_e, opts) => { cachedOptions = opts; });

contextBridge.exposeInMainWorld('fnosDialog', {
  readOptions: () => cachedOptions || { buttons: ['确定'], defaultId: 0, cancelId: 0 },
  respond: (payload) => ipcRenderer.send('dlg:resp', payload),
  resize: (size) => ipcRenderer.send('dlg:resize', size),
  ready: () => ipcRenderer.send('dlg:ready'),
});
