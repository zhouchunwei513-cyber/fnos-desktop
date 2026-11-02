'use strict';

/**
 * 壳页 preload —— 只暴露白名单能力，渲染层不接触 Node。
 * 所有 invoke 通道与 main/ipc.js 一一对应。
 */

const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = [
  'shell:command',
  'shell:bootstrap',
  'shell:navigated',
  'shell:load-failed',
  'shell:crashed',
  'shell:loading',
  'shell:title',
  'shell:fullscreen',
  'shell:appearance',
  'shell:system-theme',
  'settings:changed'
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

  nav: {
    command: (op, payload) => ipcRenderer.invoke('nav:command', op, payload),
    recordUrl: (url) => ipcRenderer.invoke('nav:record-url', url)
  },

  zoom: {
    set: (v) => ipcRenderer.invoke('zoom:set', v),
    get: () => ipcRenderer.invoke('zoom:get')
  },

  window: {
    toggleFullScreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
    show: () => ipcRenderer.invoke('window:show'),
    hide: () => ipcRenderer.invoke('window:hide'),
    toggleToolbar: () => ipcRenderer.invoke('window:toggle-toolbar')
  },

  settingsWindow: {
    open: (tab) => ipcRenderer.invoke('settings-window:open', tab),
    close: () => ipcRenderer.invoke('settings-window:close')
  },

  appearance: {
    set: (part) => ipcRenderer.invoke('settings:patch', { appearance: part })
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
    checkSilent: () => ipcRenderer.invoke('update:check-silent'),
    info: () => ipcRenderer.invoke('update:info')
  },

  about: {
    panel: () => ipcRenderer.invoke('about:panel'),
    diagnostics: () => ipcRenderer.invoke('about:diagnostics')
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

contextBridge.exposeInMainWorld('fnos', api);
