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
  setUrlRewrites: (list) =>
    ipcRenderer.invoke(
      'settings:set-url-rewrites',
      Array.isArray(list)
        ? list
            .filter((r) => r && typeof r.match === 'string' && typeof r.replace === 'string')
            .map((r) => ({ match: r.match.trim(), replace: r.replace.trim() }))
            .filter((r) => r.match && r.replace)
        : []
    ),
  setUIOptions: (opts) =>
    ipcRenderer.invoke('settings:set-ui-options', {
      autoHideMenuBar: !!opts?.autoHideMenuBar,
      glassTitleBar: !!opts?.glassTitleBar,
    }),
  setAccentColor: (color) =>
    ipcRenderer.invoke('settings:set-accent-color', String(color || '#5865F2')),
  close: () => ipcRenderer.send('settings:close'),
});
