// 锁屏页 preload — 通过 contextBridge 暴露 fnosLock API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnosLock', {
  getInfo: () => ipcRenderer.invoke('lock:get-info'),
  verify: (password) => ipcRenderer.invoke('lock:verify', String(password || '')),
  setPassword: (payload) =>
    ipcRenderer.invoke('lock:set-password', {
      oldPassword: String(payload?.oldPassword || ''),
      newPassword: String(payload?.newPassword || ''),
    }),
});
