// v3.0.64：自绘应用菜单 preload（只暴露最小能力，渲染层拿不到 node/ipcRenderer 本体）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnMenu', {
  onData: (cb) => { ipcRenderer.on('fnmenu:data', (_e, d) => { try { cb(d); } catch (_) {} }); },
  ready: (size) => ipcRenderer.send('fnmenu:ready', size),
  invoke: (id) => ipcRenderer.send('fnmenu:invoke', id),
  close: () => ipcRenderer.send('fnmenu:close'),
});
