'use strict';
/**
 * 窗口管理（macOS）
 *
 * 策略：
 *  - 主窗：titleBarStyle 'hiddenInset'，外壳 shell.html 自绘工具栏（绝不注入 NAS 页面）
 *  - 设置 / 关于 / 帮助 / 下载 / 登录 / 错误 / 直播 / 播放器：系统标准标题栏（macOS 规范，内容绝不被遮挡）
 *  - 对话框 / 菜单弹层 / 更新进度 / 锁屏：无边框（frameless）
 */
const { BrowserWindow, screen, shell, app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const prefs = require('./prefs');

let rendererDir = '';
let assetsDir = '';
let appIcon = null;
let mainWin = null;
const pool = new Map();

let skinProvider = () => null;
let themeOverride = null;

function init(opts) {
  rendererDir = opts.rendererDir;
  assetsDir = opts.assetsDir;
  try {
    const p = path.join(opts.assetsDir, 'fnos-logo.png');
    if (fs.existsSync(p)) appIcon = nativeImage.createFromPath(p);
  } catch (_) {}
}

function file(name) { return path.join(rendererDir, name); }
function asset(name) { return path.join(assetsDir, name); }

// ───────────────────────── 主题 ─────────────────────────
function themePayload(extra) {
  const s = prefs.load();
  const alpha = prefs.uiAlphaCss(prefs.uiAlphaPct(s));
  const base = {
    themeColor: themeOverride && themeOverride.themeColor ? themeOverride.themeColor : s.themeColor,
    titleBarMaterial: (themeOverride && themeOverride.titleBarMaterial) || s.titleBarMaterial,
    titleBarOpacity: themeOverride && themeOverride.titleBarOpacity != null ? themeOverride.titleBarOpacity : s.titleBarOpacity,
    titleBarBlur: themeOverride && themeOverride.titleBarBlur != null ? themeOverride.titleBarBlur : s.titleBarBlur,
    titleBarHighlight: themeOverride && themeOverride.titleBarHighlight != null ? themeOverride.titleBarHighlight : s.titleBarHighlight,
    titleBarFrostColor: (themeOverride && themeOverride.titleBarFrostColor) || s.titleBarFrostColor,
    titleBarFrostAlpha: themeOverride && themeOverride.titleBarFrostAlpha != null ? themeOverride.titleBarFrostAlpha : s.titleBarFrostAlpha,
    titleBarSolidColor: (themeOverride && themeOverride.titleBarSolidColor) || s.titleBarSolidColor,
    titleBarSolidAlpha: themeOverride && themeOverride.titleBarSolidAlpha != null ? themeOverride.titleBarSolidAlpha : s.titleBarSolidAlpha,
    titleBarDivider: themeOverride && themeOverride.titleBarDivider != null ? themeOverride.titleBarDivider : s.titleBarDivider,
    titleBarColor: (themeOverride && themeOverride.titleBarColor) || s.titleBarColor,
    titleBarAutoHide: !!s.titleBarAutoHide,
    barCorner: (themeOverride && themeOverride.barCorner) || s.barCorner,
    winCorner: (themeOverride && themeOverride.winCorner) || s.winCorner,
    uiTransparent: alpha < 1,
    uiAlpha: alpha,
    skin: skinProvider(),
  };
  return Object.assign(base, extra || {});
}

function broadcastTheme(extra) {
  const payload = themePayload(extra);
  for (const [, w] of pool) {
    try {
      if (!w || w.isDestroyed()) continue;
      w.webContents.send('shell:theme', payload);
    } catch (_) {}
  }
}

/** 实时预览（不落盘），null = 清除预览回到真实配置 */
function setThemeOverride(o) { themeOverride = o || null; broadcastTheme(); }

// ───────────────────────── 通用创建 ─────────────────────────
function preloadFor(name) { return path.join(rendererDir, name); }

function commonWebPreferences(preloadName, extra) {
  return Object.assign({
    preload: preloadFor(preloadName),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
    backgroundThrottling: false,
    webSecurity: true,
  }, extra || {});
}

function register(key, win) {
  pool.set(key, win);
  win.on('closed', () => { if (pool.get(key) === win) pool.delete(key); });
  return win;
}

function centerOnScreen(win, parent) {
  try {
    if (parent && !parent.isDestroyed()) {
      const pb = parent.getBounds();
      const b = win.getBounds();
      win.setPosition(
        Math.round(pb.x + (pb.width - b.width) / 2),
        Math.round(pb.y + (pb.height - b.height) / 2)
      );
    }
  } catch (_) {}
}

// ───────────────────────── 主窗 ─────────────────────────
function loadBounds() {
  const s = prefs.load();
  const b = s.windowBounds;
  const area = screen.getPrimaryDisplay().workArea;
  const def = { width: Math.min(1280, area.width - 80), height: Math.min(820, area.height - 80) };
  if (b && b.width > 600 && b.height > 400) {
    return {
      width: Math.min(b.width, area.width), height: Math.min(b.height, area.height),
      x: Number.isFinite(b.x) ? b.x : undefined, y: Number.isFinite(b.y) ? b.y : undefined,
    };
  }
  return def;
}

function saveBounds(win) {
  try {
    if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    const b = win.getBounds();
    prefs.saveDebounced({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } }, 800);
  } catch (_) {}
}

function createMain(opts) {
  if (mainWin && !mainWin.isDestroyed()) { focusMain(); return mainWin; }
  const o = opts || {};
  const bounds = loadBounds();
  const s = prefs.load();
  const win = new BrowserWindow(Object.assign({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 580,
    show: false,
    title: 'FNOS',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: '#00000000',
    vibrancy: s.macVibrancy === 'none' ? undefined : s.macVibrancy,
    visualEffectState: 'active',
    roundedCorners: true,
    fullscreenable: true,
    webPreferences: commonWebPreferences('shell-preload.js', {
      webviewTag: true,
      allowRunningInsecureContent: true,
      webSecurity: false,
      partition: undefined,
    }),
  }, o.windowOptions || {}));

  win.loadFile(file('shell.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });

  const pushOpen = () => {
    try {
      win.webContents.send('shell:open', {
        replace: true,
        partition: o.partition || s.currentPartition || 'persist:connect',
        url: o.url || 'about:blank',
      });
      win.webContents.send('shell:theme', themePayload());
    } catch (_) {}
  };
  win.webContents.on('did-finish-load', pushOpen);

  win.on('resize', () => saveBounds(win));
  win.on('move', () => saveBounds(win));
  win.on('focus', () => { try { win.webContents.send('shell:theme', themePayload({ focused: true })); } catch (_) {} });
  win.on('blur', () => { try { win.webContents.send('shell:theme', themePayload({ focused: false })); } catch (_) {} });
  win.on('enter-full-screen', () => {
    try { win.webContents.send('shell:maximized', true); } catch (_) {}
  });
  win.on('leave-full-screen', () => {
    try { win.webContents.send('shell:maximized', false); } catch (_) {}
  });
  // macOS：关闭按钮只隐藏主窗（与 Windows 版 closeAction 语义一致）
  win.on('close', (e) => {
    saveBounds(win);
    const st = prefs.load();
    const action = st.closeAction || 'hide';
    if (action === 'hide' && !app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  mainWin = register('main', win);
  return win;
}

function getMain() {
  return mainWin && !mainWin.isDestroyed() ? mainWin : null;
}

function focusMain() {
  const w = getMain();
  if (!w) return null;
  if (w.isMinimized()) w.restore();
  if (!w.isVisible()) w.show();
  w.focus();
  return w;
}

function shellOpen(target) {
  const w = getMain();
  if (!w) return false;
  try { w.webContents.send('shell:open', target); return true; } catch (_) { return false; }
}

function shellNavigate(action) {
  const w = getMain();
  if (!w) return;
  try { w.webContents.send('shell:navigate', action); } catch (_) {}
}

function shellTitle(t) {
  const w = getMain();
  if (!w) return;
  try { w.webContents.send('shell:title', t); } catch (_) {}
}

function shellLoadFile(u) {
  const w = getMain();
  if (!w) return;
  try { w.webContents.send('shell:load-file', u); } catch (_) {}
}

function shellMaximized(v) {
  const w = getMain();
  if (!w) return;
  try { w.webContents.send('shell:maximized', v); } catch (_) {}
}

// ───────────────────────── 设置窗 ─────────────────────────
function openSettings(section) {
  const exist = pool.get('settings');
  if (exist && !exist.isDestroyed()) {
    exist.show();
    exist.focus();
    if (section) { try { exist.webContents.send('settings:goto', section); } catch (_) {} }
    return exist;
  }
  const win = new BrowserWindow({
    width: 940,
    height: 660,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: '设置',
    backgroundColor: '#14161c',
    webPreferences: commonWebPreferences('settings-preload.js'),
  });
  win.setMenuBarVisibility(false);
  win.loadFile(file('settings.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { setThemeOverride(null); });
  register('settings', win);
  return win;
}

function closeSettings() {
  const w = pool.get('settings');
  if (w && !w.isDestroyed()) w.close();
}

// ───────────────────────── 关于 / 帮助 / 下载 ─────────────────────────
function openSimple(key, opts) {
  const exist = pool.get(key);
  if (exist && !exist.isDestroyed()) { exist.show(); exist.focus(); return exist; }
  const o = opts || {};
  const win = new BrowserWindow({
    width: o.width || 920,
    height: o.height || 700,
    minWidth: o.minWidth || 620,
    minHeight: o.minHeight || 420,
    show: false,
    title: o.title || 'FNOS',
    backgroundColor: '#14161c',
    // about / help / download / login / error 共用注入页 preload（fnApi 全在 preload.js 里）
    webPreferences: commonWebPreferences(o.preload || 'preload.js'),
  });
  win.loadFile(file(o.html));
  win.once('ready-to-show', () => win.show());
  register(key, win);
  return win;
}

function openAbout() {
  return openSimple('about', { html: 'about.html', title: '关于 FNOS', width: 620, height: 560 });
}
function openHelp() {
  return openSimple('help', { html: 'help.html', title: '帮助', width: 940, height: 720 });
}
function openDownload() {
  return openSimple('download', { html: 'download.html', title: '下载', width: 780, height: 560 });
}
function openLogin(opts) {
  return openSimple('login', Object.assign({ html: 'login.html', title: '登录', width: 520, height: 620 }, opts || {}));
}
function openError(opts) {
  return openSimple('error', Object.assign({ html: 'error.html', title: '出错了', width: 900, height: 660 }, opts || {}));
}
function openLive(opts) {
  const o = opts || {};
  const exist = pool.get('live');
  if (exist && !exist.isDestroyed()) { exist.show(); exist.focus(); return exist; }
  const win = new BrowserWindow({
    width: o.width || 1200, height: o.height || 780,
    minWidth: 860, minHeight: 520,
    show: false, title: o.title || '电视直播',
    backgroundColor: '#0b0d12',
    webPreferences: commonWebPreferences('live-preload.js', { nodeIntegration: false }),
  });
  win.loadFile(file('live.html'));
  win.once('ready-to-show', () => win.show());
  if (o.query) {
    win.webContents.once('did-finish-load', () => {
      try { win.webContents.send('live:open', o.query); } catch (_) {}
    });
  }
  register('live', win);
  return win;
}
function openPlayer(opts) {
  const o = opts || {};
  const exist = pool.get('player');
  if (exist && !exist.isDestroyed()) {
    try { exist.webContents.send('player:open', o); } catch (_) {}
    exist.show(); exist.focus();
    return exist;
  }
  const win = new BrowserWindow({
    width: o.width || 1024, height: o.height || 640,
    minWidth: 640, minHeight: 400,
    show: false, title: o.title || '播放',
    backgroundColor: '#000000',
    webPreferences: commonWebPreferences('preload.js', { nodeIntegration: false, webSecurity: false, allowRunningInsecureContent: true }),
  });
  win.loadFile(file('player.html'));
  win.webContents.once('did-finish-load', () => {
    try { win.webContents.send('player:open', o); } catch (_) {}
  });
  win.once('ready-to-show', () => win.show());
  register('player', win);
  return win;
}

// ───────────────────────── 锁屏 ─────────────────────────
function openLock() {
  const exist = pool.get('lock');
  if (exist && !exist.isDestroyed()) { exist.show(); exist.focus(); return exist; }
  const parent = getMain();
  const b = parent ? parent.getBounds() : { width: 900, height: 600 };
  const win = new BrowserWindow({
    width: b.width, height: b.height,
    x: parent ? b.x : undefined, y: parent ? b.y : undefined,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0b0d12',
    webPreferences: commonWebPreferences('lock-preload.js'),
  });
  win.loadFile(file('lock.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.setAlwaysOnTop(true, 'screen-saver');
  register('lock', win);
  return win;
}
function closeLock() {
  const w = pool.get('lock');
  if (w && !w.isDestroyed()) w.destroy();
  const m = getMain();
  if (m) { try { m.setAlwaysOnTop(false); } catch (_) {} }
}

// ───────────────────────── 对话框 ─────────────────────────
function openDialog(opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    const parent = o.parent && !o.parent.isDestroyed() ? o.parent : getMain();
    const win = new BrowserWindow({
      width: o.width || 460,
      height: o.height || 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      modal: !!parent,
      parent: parent || undefined,
      title: o.title || '提示',
      backgroundColor: '#1b1e26',
      webPreferences: commonWebPreferences('dialog-preload.js'),
    });
    centerOnScreen(win, parent);

    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      resolve(payload);
      try { if (!win.isDestroyed()) win.close(); } catch (_) {}
    };

    const onResp = (_e, payload) => finish(payload);
    const onReady = () => {
      try { win.webContents.send('dialog:options', o); } catch (_) {}
    };
    const onResize = (_e, size) => {
      try {
        const w = Math.max(300, Math.min(720, Number(size && size.width) || 460));
        const h = Math.max(140, Math.min(720, Number(size && size.height) || 220));
        win.setContentSize(Math.round(w), Math.round(h));
        centerOnScreen(win, parent);
      } catch (_) {}
    };
    win.webContents.ipc.on('dlg:resp', onResp);
    win.webContents.ipc.on('dlg:ready', onReady);
    win.webContents.ipc.on('dlg:resize', onResize);

    win.loadFile(file('dialog.html'));
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    win.on('closed', () => {
      try {
        win.webContents.ipc.removeListener('dlg:resp', onResp);
        win.webContents.ipc.removeListener('dlg:ready', onReady);
        win.webContents.ipc.removeListener('dlg:resize', onResize);
      } catch (_) {}
      if (!done) { done = true; resolve({ buttonId: o.cancelId != null ? o.cancelId : 0, canceled: true }); }
    });
  });
}

// ───────────────────────── 菜单弹层（自绘应用菜单） ─────────────────────────
function openMenuPopup(payload) {
  return new Promise((resolve) => {
    const o = payload || {};
    const parent = getMain();
    const win = new BrowserWindow({
      width: o.width || 220,
      height: o.height || 40,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: commonWebPreferences('menu-popup-preload.js', { transparent: true }),
    });

    // 按锚点定位（o.x / o.y 为屏幕坐标最佳；否则按主窗相对坐标换算）
    try {
      if (Number.isFinite(o.screenX) && Number.isFinite(o.screenY)) {
        win.setPosition(Math.round(o.screenX), Math.round(o.screenY));
      } else if (parent && Number.isFinite(o.x) && Number.isFinite(o.y)) {
        const pb = parent.getBounds();
        const cb = parent.getContentBounds();
        win.setPosition(pb.x + Math.round(o.x), pb.y + (pb.height - cb.height) + Math.round(o.y));
      }
    } catch (_) {}

    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
      try { if (!win.isDestroyed()) win.close(); } catch (_) {}
    };

    const onReady = (_e, size) => {
      try {
        const w = Math.max(120, Math.min(420, Number(size && size.width) || 220));
        const h = Math.max(30, Math.min(700, Number(size && size.height) || 40));
        win.setContentSize(Math.round(w), Math.round(h));
      } catch (_) {}
      try { win.show(); win.focus(); } catch (_) {}
    };
    const onInvoke = (_e, id) => finish({ id });
    const onClose = () => finish({ id: '' });

    win.webContents.ipc.on('fnmenu:ready', onReady);
    win.webContents.ipc.on('fnmenu:invoke', onInvoke);
    win.webContents.ipc.on('fnmenu:close', onClose);
    win.on('blur', () => { setTimeout(() => finish({ id: '' }), 120); });
    win.on('closed', () => {
      try {
        win.webContents.ipc.removeListener('fnmenu:ready', onReady);
        win.webContents.ipc.removeListener('fnmenu:invoke', onInvoke);
        win.webContents.ipc.removeListener('fnmenu:close', onClose);
      } catch (_) {}
      if (!done) { done = true; resolve({ id: '' }); }
    });

    win.loadFile(file('menu-popup.html'));
    win.webContents.once('did-finish-load', () => {
      try { win.webContents.send('fnmenu:data', o.data || {}); } catch (_) {}
    });
  });
}

// ───────────────────────── 更新进度 ─────────────────────────
function openUpdateProgress() {
  const exist = pool.get('upd');
  if (exist && !exist.isDestroyed()) { exist.show(); exist.focus(); return exist; }
  const win = new BrowserWindow({
    width: 480, height: 180,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#1b1e26',
    webPreferences: commonWebPreferences('update-progress-preload.js'),
  });
  centerOnScreen(win, getMain());
  win.loadFile(file('update-progress.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  register('upd', win);
  return win;
}
function sendUpdProgress(data) {
  const w = pool.get('upd');
  if (w && !w.isDestroyed()) { try { w.webContents.send('upd:progress', data); } catch (_) {} }
}
function closeUpdateProgress() {
  const w = pool.get('upd');
  if (w && !w.isDestroyed()) w.close();
}

// ───────────────────────── 下载窗（每任务一个） ─────────────────────────
const downloads = new Map(); // id -> win

function openDownloadWindow(id, partition) {
  const key = 'dl:' + id;
  const exist = downloads.get(String(id));
  if (exist && !exist.isDestroyed()) { exist.show(); exist.focus(); return exist; }
  const win = new BrowserWindow({
    width: 520, height: 200,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#1b1e26',
    webPreferences: commonWebPreferences('download-preload.js', {
      additionalArguments: ['--dl-id=' + String(id)],
      partition: partition || undefined,
    }),
  });
  win.loadFile(file('download.html'));
  win.once('ready-to-show', () => win.show());
  downloads.set(String(id), win);
  register(key, win);
  win.on('closed', () => downloads.delete(String(id)));
  return win;
}

function dlWindow(id) {
  const w = downloads.get(String(id));
  return w && !w.isDestroyed() ? w : null;
}

// ───────────────────────── 应用窗（NAS 子应用独立窗） ─────────────────────────
const appWins = new Map();

function openAppWindow(opts) {
  const o = opts || {};
  const key = String(o.appId || o.url || 'app');
  const exist = appWins.get(key);
  if (exist && !exist.isDestroyed()) { exist.show(); exist.focus(); return exist; }

  const win = new BrowserWindow({
    width: o.width || 1180,
    height: o.height || 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: o.title || 'FNOS',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: '#0b0d12',
    webPreferences: commonWebPreferences('preload.js', {
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      additionalArguments: ['--fnos-app-window'],
      partition: o.partition || undefined,
    }),
  });
  if (o.url) win.loadURL(o.url);
  else win.loadFile(file(o.html || 'embed-shell.html'));
  win.once('ready-to-show', () => win.show());
  centerOnScreen(win, getMain());
  appWins.set(key, win);
  register('app:' + key, win);
  win.on('closed', () => appWins.delete(key));
  return win;
}

// ───────────────────────── 广播 / 枚举 ─────────────────────────
function all() { return Array.from(pool.values()).filter((w) => w && !w.isDestroyed()); }

function sendToAll(channel, payload) {
  for (const w of all()) { try { w.webContents.send(channel, payload); } catch (_) {} }
}

function hideMain() {
  const w = getMain();
  if (w) { try { w.hide(); } catch (_) {} }
}

function toggleMain() {
  const w = getMain();
  if (!w) return;
  if (w.isVisible() && w.isFocused()) w.hide();
  else focusMain();
}

function closeAll() {
  for (const w of all()) { try { w.destroy(); } catch (_) {} }
  mainWin = null;
  pool.clear();
}

module.exports = {
  init,
  file, asset,
  themePayload, broadcastTheme, setThemeOverride, setSkinProvider: (fn) => { skinProvider = fn; },
  createMain, getMain, focusMain, hideMain, toggleMain,
  shellOpen, shellNavigate, shellTitle, shellLoadFile, shellMaximized,
  openSettings, closeSettings,
  openAbout, openHelp, openDownload, openLogin, openError, openLive, openPlayer, openSimple,
  openLock, closeLock,
  openDialog, openMenuPopup,
  openUpdateProgress, sendUpdProgress, closeUpdateProgress,
  openDownloadWindow, dlWindow,
  openAppWindow,
  sendToAll, all, closeAll,
};
