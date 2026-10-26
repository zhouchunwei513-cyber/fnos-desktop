// v2.18.6：更新下载进度窗专用 preload——只暴露进度订阅与取消，能力最小化。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updApi', {
  onProgress: (cb) => {
    const h = (_e, data) => {
      try { if (typeof cb === 'function') cb(data); } catch (_) {}
    };
    ipcRenderer.on('upd:progress', h);
    return () => {
      try { ipcRenderer.removeListener('upd:progress', h); } catch (_) {}
    };
  },
  cancel: () => {
    try { ipcRenderer.send('upd:cancel-download'); } catch (_) {}
  },
});
