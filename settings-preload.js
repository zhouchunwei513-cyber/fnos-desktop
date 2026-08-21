// 设置页 preload — 通过 contextBridge 暴露 fnosSettings API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnosSettings', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setPassword: (payload) =>
    ipcRenderer.invoke('settings:set-password', {
      oldPassword: String(payload?.oldPassword || ''),
      newPassword: String(payload?.newPassword || ''),
    }),
  setShortcuts: (payload) =>
    ipcRenderer.invoke('settings:set-shortcuts', {
      lockApp: String(payload?.lockApp || ''),
      hideAll: String(payload?.hideAll || ''),
    }),
  close: () => ipcRenderer.send('settings:close'),
});
