'use strict';

/**
 * 偏好设置窗 preload —— 同样只走白名单 IPC。
 */

const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = [
  'settings:changed',
  'settings:goto-tab',
  'shell:appearance',
  'shell:system-theme'
];

function on(channel, cb) {
  if (EVENT_CHANNELS.indexOf(channel) < 0) return () => {};
  const handler = (_e, payload) => {
    try { cb(payload); } catch (_) {}
  };
  ipcRenderer.on(channel, handler);
  return () => {
    try { ipcRenderer.removeListener(channel, handler); } catch (_) {}
  };
}

const api = {
  platform: 'darwin',

  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  version: () => ipcRenderer.invoke('app:version'),
  paths: () => ipcRenderer.invoke('app:paths'),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    patch: (part) => ipcRenderer.invoke('settings:patch', part),
    reset: () => ipcRenderer.invoke('settings:reset'),
    path: () => ipcRenderer.invoke('settings:path'),
    applied: () => ipcRenderer.send('settings:applied')
  },

  server: {
    list: () => ipcRenderer.invoke('server:list'),
    add: (input) => ipcRenderer.invoke('server:add', input),
    remove: (url) => ipcRenderer.invoke('server:remove', url),
    switchTo: (url) => ipcRenderer.invoke('server:switch', url),
    test: (input) => ipcRenderer.invoke('server:test', input)
  },

  log: {
    list: () => ipcRenderer.invoke('log:list'),
    read: (name) => ipcRenderer.invoke('log:read', name),
    openFolder: () => ipcRenderer.invoke('log:open-folder'),
    write: (level, scope, message, extra) => ipcRenderer.invoke('log:write', level, scope, message, extra),
    saveAs: (content, name) => ipcRenderer.invoke('log:save-as', content, name)
  },

  update: {
    check: () => ipcRenderer.invoke('update:check'),
    info: () => ipcRenderer.invoke('update:info')
  },

  about: {
    panel: () => ipcRenderer.invoke('about:panel'),
    diagnostics: () => ipcRenderer.invoke('about:diagnostics')
  },

  window: {
    close: () => ipcRenderer.invoke('settings-window:close'),
    toggleFullScreen: () => ipcRenderer.invoke('window:toggle-fullscreen')
  },

  app: {
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    revealPath: (p) => ipcRenderer.invoke('app:reveal-path', p),
    copy: (text) => ipcRenderer.invoke('app:copy', text),
    quit: () => ipcRenderer.invoke('app:quit'),
    hide: () => ipcRenderer.invoke('app:hide')
  },

  on
};

contextBridge.exposeInMainWorld('fnosSettings', api);
