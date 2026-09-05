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
  setAutoLock: (minutes) =>
    ipcRenderer.invoke('settings:set-auto-lock', { minutes: Number(minutes) || 0 }),
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
      themeColor: opts?.themeColor ? String(opts.themeColor) : undefined,
    }),
  setAccentColor: (color) =>
    ipcRenderer.invoke('settings:set-accent-color', String(color || '#5865F2')),
  // 直播源基地址/线路配置（非代理；仅保留源配置）
  iptvSetConfig: (patch) => ipcRenderer.invoke('iptv:set-config', patch || {}),
  // v1.25.0：兼容性播放器（MPV）设置（通道名沿用 set-vlc/vlc-runtime）
  setVlc: (patch) => ipcRenderer.invoke('settings:set-vlc', patch || {}),
  vlcRuntime: () => ipcRenderer.invoke('settings:vlc-runtime'),
  // v1.34.0：ZDY 增强服务（弹幕/字幕/片头片尾走 NAS）；v1.36.0 起支持三通道（lan/ddns/frp）
  setEnhance: (patch) => ipcRenderer.invoke('settings:set-enhance', patch || {}),
  enhancePing: (cfgOrUrl, token) => {
    // 兼容旧签名 enhancePing(baseUrl, token)
    let cfg = cfgOrUrl;
    if (typeof cfgOrUrl === 'string') {
      cfg = { lan: String(cfgOrUrl || '').trim(), authCode: String(token || '').trim() };
    }
    return ipcRenderer.invoke('settings:enhance-ping', cfg || {});
  },
  restartApp: () => ipcRenderer.invoke('app:restart'),
  close: () => ipcRenderer.send('settings:close'),
});
