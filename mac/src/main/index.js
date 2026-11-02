'use strict';
/**
 * FNOS 桌面客户端 —— macOS 主进程入口
 *
 * 架构：主窗（外壳 shell.html + webview 承载 NAS 页面）+ 多类独立窗口
 * 规范：macOS 原生菜单栏 / 红绿灯交通灯 / 标准标题栏（非主窗）/ Dock 与 activate 行为
 */
const { app, BrowserWindow, Menu, globalShortcut, session, shell, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const logger = require('../logger');
const prefs = require('./prefs');
const nav = require('./nav');
const win = require('./win');
const menu = require('./menu');
const skin = require('./skin');

const ipcAuth = require('./ipc-auth');
const ipcSettings = require('./ipc-settings');
const ipcShell = require('./ipc-shell');
const ipcApp = require('./ipc-app');
const ipcDownload = require('./ipc-download');
const ipcLock = require('./ipc-lock');

const APP_VERSION = app.getVersion();
const REPO = 'zhouchunwei513-cyber/fnos-desktop';

let rendererDir = '';
let assetsDir = '';
let ipcIptv = null;
let guestWc = null;
let pendingOpen = '';
let ready = false;

app.setName('FNOS');

// ─────────────── 内置扩展（knas-media 播放桥接）───────────────
function loadExtensions() {
  const dir = path.join(__dirname, '..', '..', 'extensions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  const sessions = [session.defaultSession];
  try { sessions.push(session.fromPartition('persist:connect')); } catch (_) {}
  for (const name of names) {
    const p2 = path.join(dir, name);
    try {
      if (!fs.statSync(p2).isDirectory()) continue;
      if (!fs.existsSync(path.join(p2, 'manifest.json'))) continue;
    } catch (_) { continue; }
    for (const ses of sessions) {
      try { ses.loadExtension(p2, { allowFileAccess: true }); }
      catch (e) { logger.log('warn', 'ext', 'load failed', { name: name, err: e }); }
    }
  }
}


// ─────────────── 单实例（--app / --launch-app / --nas / --fnos-open）───────────────
function parseOpenArgs(argv) {
  const out = { url: '', appId: '', nas: '' };
  for (let i = 0; i < (argv || []).length; i++) {
    const a = String(argv[i] || '');
    const take = (prefix) => {
      if (a.startsWith(prefix + '=')) return a.slice(prefix.length + 1);
      if (a === prefix && argv[i + 1]) return String(argv[i + 1]);
      return null;
    };
    let v;
    if ((v = take('--fnos-open')) !== null) { out.url = v; continue; }
    if ((v = take('--app')) !== null) { out.url = v; continue; }
    if ((v = take('--launch-app')) !== null) { out.appId = v; continue; }
    if ((v = take('--open-app')) !== null) { out.appId = v; continue; }
    if ((v = take('--nas')) !== null) { out.nas = v; continue; }
  }
  try {
    if (out.url) out.url = decodeURIComponent(out.url);
    if (out.nas) out.nas = decodeURIComponent(out.nas);
  } catch (_) {}
  return out;
}

function resolveLaunchTarget(o) {
  const base = nav.originOf(o.nas || prefs.load().server || prefs.load().origin || '');
  if (o.url && /^https?:\/\//i.test(o.url)) return o.url;
  if (o.url && base) { try { return new URL(o.url, base).toString(); } catch (_) {} }
  if (o.appId && base) return base + '/app/' + encodeURIComponent(o.appId);
  return '';
}

const firstArgs = parseOpenArgs(process.argv.slice(1));
pendingOpen = resolveLaunchTarget(firstArgs);

const gotLock = app.requestSingleInstanceLock({ argv: process.argv.slice(1) });
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const o = parseOpenArgs(argv);
    const target = resolveLaunchTarget(o);
    if (target) openTarget(target);
    else win.focusMain();
  });
}

// ─────────────── 早期开关（ready 前生效）───────────────
try {
  const s0 = prefs.load();
  if (s0.disableGpu) app.disableHardwareAcceleration();
} catch (_) {}

// ─────────────── 打开目标（主窗 webview 或独立应用窗）───────────────
function openTarget(url) {
  if (!url) return;
  const s = prefs.load();
  const mapped = nav.applyUrlMappings(url, s.urlMappings);
  const origin = nav.originOf(mapped);
  const base = nav.originOf(s.server || s.origin || '');
  if (origin && base && origin !== base) {
    // 外部站点：交给默认浏览器
    try { shell.openExternal(mapped); } catch (_) {}
    return;
  }
  const w = win.getMain();
  if (w) {
    win.focusMain();
    win.shellOpen({ replace: false, partition: s.currentPartition || 'persist:connect', url: mapped });
  } else {
    pendingOpen = mapped;
    bootMain();
  }
}

// ─────────────── 会话配置 ───────────────
function configureSession(ses) {
  try {
    ses.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FNOS-Desktop/' + APP_VERSION
    );
  } catch (_) {}

  // NAS 多为自签证书：仅对私有网段 / 已连接主机放行，公网地址仍走系统校验
  try {
    ses.setCertificateVerifyProc((req, cb) => {
      const host = String(req.hostname || '');
      const s = prefs.load();
      let sameHost = false;
      try { sameHost = !!host && host === new URL(nav.originOf(s.server || s.origin || '')).hostname; } catch (_) {}
      const isPrivate = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /\.local$/i.test(host) || host === 'localhost';
      if (isPrivate || sameHost) { cb(0); return; }
      cb(-3);
    });
  } catch (_) {}

  try {
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      const allow = ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write', 'media', 'notifications', 'pointerLock'];
      callback(allow.includes(permission));
    });
  } catch (_) {}

  try { ipcDownload.attach(ses); } catch (_) {}
}

// ─────────────── 启动主窗 ───────────────
function bootMain() {
  const s = prefs.load();
  const partition = s.currentPartition || 'persist:connect';
  let url = pendingOpen;
  if (!url) {
    const last = s.lastConnectHref || s.origin || '';
    const lastOrigin = nav.originOf(last);
    const restore = s.restoreLastUrl !== false;
    if (lastOrigin && restore) url = last;
    else if (lastOrigin) url = lastOrigin + '/';
    else url = '';
  }
  pendingOpen = '';
  if (!url) url = 'about:blank';
  win.createMain({ partition, url });
  try { menu.refresh(); } catch (_) {}
}

// ─────────────── 快捷键 ───────────────
function toAccel(k) {
  const s = String(k || '').trim();
  if (!s) return '';
  return s.replace(/\bCtrl\b/gi, 'CommandOrControl').replace(/\bCmd\b/gi, 'Command')
    .replace(/\bAlt\b/gi, 'Alt').replace(/\bSuper\b/gi, 'Command');
}

function registerShortcuts() {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  const s = prefs.load();
  const sc = s.shortcuts || {};
  const map = {
    lockApp: () => { ipcLock.lock('hotkey'); },
    hideAll: () => { win.toggleMain(); },
  };
  for (const key of Object.keys(map)) {
    const acc = toAccel(sc[key]);
    if (!acc) continue;
    try { globalShortcut.register(acc, () => { try { map[key](); } catch (_) {} }); } catch (_) {}
  }
}

// ─────────────── 应用菜单/托盘的上下文 ───────────────
function menuContext() {
  return {
    assetsDir,
    settings: prefs.load(),
    downloadList: () => Array.from(ipcDownload.tasks.values()).map(ipcDownload.publicTask),
    openDownloadWindow: (id) => { const w = win.dlWindow(id); if (w) { w.show(); w.focus(); } },
    openAbout: () => win.openAbout(),
    openSettings: (section) => win.openSettings(section),
    openHelp: () => win.openHelp(),
    openLive: () => win.openLive(),
    goHome: () => {
      const s = prefs.load();
      const o = nav.originOf(s.server || s.origin || '');
      if (o) win.shellOpen({ replace: true, partition: s.currentPartition || 'persist:connect', url: o + '/' });
    },
    showConnectPage: () => {
      try { ipcAuth.showConnectPage(); } catch (_) {}
    },
    accounts: () => (prefs.load().accounts || []).map((a) => ({
      origin: a.origin, label: a.label || a.name || a.origin,
      isActive: a.origin === nav.originOf(prefs.load().server || prefs.load().origin || ''),
    })),
    switchAccount: (origin) => { try { ipcAuth.switchAccount(origin); } catch (_) {} },
    windowList: () => {
      const list = [];
      const main = win.getMain();
      if (main) list.push({ label: 'FNOS 主窗口', click: () => win.focusMain() });
      for (const w of win.all()) {
        if (w === main) continue;
        try { list.push({ label: w.getTitle() || '窗口', click: () => { w.show(); w.focus(); } }); } catch (_) {}
      }
      return list.length ? list : [{ label: '（暂无其它窗口）', enabled: false }];
    },
    lockApp: () => { if (!ipcLock.lock('menu')) win.openSettings('security'); },
    toggleHidden: () => win.toggleMain(),
    navigate: (action) => win.shellNavigate(action),
    zoom: (kind) => ipcShell.applyZoom(kind),
    toggleFullScreen: () => {
      const w = win.getMain();
      if (!w) return;
      const fs = w.isFullScreen();
      w.setFullScreen(!fs);
      win.shellMaximized(!fs);
    },
    copyLink: () => {
      try {
        const s = prefs.load();
        const u = (guestWc && !guestWc.isDestroyed() && guestWc.getURL()) || s.lastConnectHref || '';
        if (u) require('electron').clipboard.writeText(u);
      } catch (_) {}
    },
    openLogs: () => { try { shell.openPath(logger.dir()); } catch (_) {} },
    checkUpdate: async () => {
      win.openAbout();
      try { win.sendToAll('app:update-check', true); } catch (_) {}
    },
    openHomepage: () => { try { shell.openExternal('https://github.com/' + REPO); } catch (_) {} },
    hideAllWindows: () => { try { app.hide(); } catch (_) {} },
    focusMain: () => win.focusMain(),
    quit: () => { app.isQuitting = true; app.quit(); },
  };
}

// ─────────────── web-contents 全局钩子 ───────────────
function wireWebContents() {
  app.on('web-contents-created', (_e, wc) => {
    let type = '';
    try { type = wc.getType(); } catch (_) {}

    // <webview>（NAS 页面）——注册为 guest
    if (type === 'webview') {
      guestWc = wc;
      try { ipcShell.setGuestProvider(() => guestWc); } catch (_) {}
      try { ipcIptv && ipcIptv.setMainWindow(win.getMain()); } catch (_) {}

      wc.setWindowOpenHandler(({ url, disposition }) => {
        try {
          if (!url || /^(about|javascript|blob|data|chrome):/i.test(url)) return { action: 'deny' };
          const s = prefs.load();
          const origin = nav.originOf(url);
          const base = nav.originOf(s.server || s.origin || '');
          const sameSite = origin && base && origin === base;
          if (!sameSite && disposition !== 'foreground-tab' && disposition !== 'new-window') {
            shell.openExternal(url);
            return { action: 'deny' };
          }
          if (!sameSite) { shell.openExternal(url); return { action: 'deny' }; }
          // 同站新窗口 → 客户端独立应用窗
          setImmediate(() => { try { win.openAppWindow({ url, appId: nav.appIdOf(url) }); } catch (_) {} });
          return { action: 'deny' };
        } catch (_) { return { action: 'deny' }; }
      });

      wc.on('did-finish-load', () => {
        try {
          const u = wc.getURL();
          if (u && /^https?:/i.test(u)) {
            const s = prefs.saveDebounced({ lastConnectHref: u }, 900);
            if (s && !s.origin) {
              try { prefs.saveDebounced({ origin: nav.originOf(u), server: nav.originOf(u) }, 1500); } catch (_) {}
            }
          }
        } catch (_) {}
      });

      wc.on('did-fail-load', (_e2, code, desc, url) => {
        if (code === -3) return; // 用户主动中断
        logger.log('warn', 'webview', 'load failed', { params: { code, desc, url: String(url || '').slice(0, 200) } });
      });

      wc.on('render-process-gone', (_e2, details) => {
        logger.log('error', 'webview', 'renderer gone', { params: details });
      });

      wc.on('before-input-event', (_e2, input) => {
        try {
          if (input.type !== 'keyDown') return;
          const mod = input.meta || input.control;
          if (!mod) return;
          if (input.key === 'r' && !input.shift) win.shellNavigate('reload');
          else if (input.key === 'R' || (input.key === 'r' && input.shift)) win.shellNavigate('forceReload');
          else if (input.key === '[') win.shellNavigate('back');
          else if (input.key === ']') win.shellNavigate('forward');
        } catch (_) {}
      });
      return;
    }

    // 其它窗口：统一拦外链
    try {
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) {
          const s = prefs.load();
          const origin = nav.originOf(url);
          const base = nav.originOf(s.server || s.origin || '');
          if (origin && base && origin === base) {
            setImmediate(() => { try { win.openAppWindow({ url }); } catch (_) {} });
          } else {
            shell.openExternal(url);
          }
        }
        return { action: 'deny' };
      });
    } catch (_) {}
  });
}

// ─────────────── 启动 ───────────────
app.whenReady().then(() => {
  rendererDir = path.join(__dirname, '..', 'renderer');
  assetsDir = path.join(__dirname, '..', '..', 'assets');

  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); } catch (_) {}
  try { logger.init(path.join(app.getPath('userData'), 'logs'), 'main'); } catch (_) {}
  logger.log('info', 'app', 'starting', { params: { version: APP_VERSION, electron: process.versions.electron, argv: process.argv.slice(1).slice(0, 6) } });

  win.init({ rendererDir, assetsDir });
  try { win.setSkinProvider(() => skin.activePayload()); } catch (_) {}

  // 会话
  configureSession(session.fromPartition(prefs.load().currentPartition || 'persist:connect'));
  configureSession(session.defaultSession);

  // IPTV（通道在 require 时注册）
  try { ipcIptv = require('./ipc-iptv'); } catch (e) { logger.log('error', 'iptv', 'load failed', { err: e }); }

  // IPC 域
  try { loadExtensions(); } catch (_) {}
  ipcAuth.register();
  ipcSettings.register();
  ipcShell.register();
  ipcApp.register();
  ipcDownload.register();
  ipcLock.register();
  try { ipcIptv && ipcIptv.register(); } catch (_) {}

  wireWebContents();

  // 菜单 / 托盘 / 快捷键
  menu.init(menuContext());
  try { menu.ensureTray(); } catch (_) {}
  registerShortcuts();
  ipcLock.startAutoLockWatcher();

  try {
    app.setAboutPanelOptions({
      applicationName: 'FNOS',
      applicationVersion: APP_VERSION,
      version: 'Electron ' + process.versions.electron,
      copyright: '飞牛 NAS 桌面客户端 · macOS 版',
      credits: 'https://github.com/' + REPO,
    });
  } catch (_) {}

  // 主窗
  bootMain();
  ready = true;

  // 主题变化
  nativeTheme.on('updated', () => { try { win.broadcastTheme(); } catch (_) {} });
}).catch((e) => {
  try { logger.log('error', 'app', 'whenReady failed', { err: e }); } catch (_) {}
  try { dialog.showErrorBox('FNOS 启动失败', String((e && e.stack) || e)); } catch (_) {}
});

// ─────────────── 生命周期（macOS 规范）───────────────
app.on('activate', () => {
  if (!ready) return;
  if (!win.getMain()) bootMain();
  else win.focusMain();
});

app.on('window-all-closed', () => {
  // macOS：关掉所有窗口不退出应用，保留在 Dock
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try { prefs.flush(); } catch (_) {}
  try { globalShortcut.unregisterAll(); } catch (_) {}
  try { menu.destroyTray(); } catch (_) {}
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
});

// 未捕获异常
process.on('uncaughtException', (e) => {
  try { logger.log('error', 'app', 'uncaughtException', { err: e }); } catch (_) {}
});
process.on('unhandledRejection', (e) => {
  try { logger.log('error', 'app', 'unhandledRejection', { err: e }); } catch (_) {}
});

module.exports = {};
