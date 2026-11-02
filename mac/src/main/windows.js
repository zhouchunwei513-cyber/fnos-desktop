'use strict';

/**
 * 窗口管理（macOS）
 *  - 主窗：titleBarStyle hiddenInset + vibrancy，红绿灯内嵌工具栏
 *  - 偏好设置窗：独立小窗，隐藏标题栏，Cmd+, 打开，关闭仅销毁
 *  - 全屏切换、窗口几何持久化、webview 安全策略
 */

const path = require('path');
const { BrowserWindow, nativeTheme, screen, shell } = require('electron');
const store = require('./store');
const nav = require('./nav');
const logger = require('./logger');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload');

const TOOLBAR_HEIGHT = 52;
const TRAFFIC = { x: 18, y: 19 };

let mainWin = null;
let settingsWin = null;
let saveTimer = null;
let quitting = false;

function rendererFile(name) {
  return 'file://' + path.join(RENDERER, name).replace(/\\/g, '/');
}

function isUsable(win) {
  return !!win && !win.isDestroyed();
}

function clampToDisplay(bounds) {
  try {
    const displays = screen.getAllDisplays();
    const ok = displays.some((d) => {
      const a = d.workArea;
      return (
        bounds.x + 120 > a.x &&
        bounds.x < a.x + a.width - 120 &&
        bounds.y + 80 > a.y &&
        bounds.y < a.y + a.height - 80
      );
    });
    return ok ? bounds : null;
  } catch (_) {
    return null;
  }
}

function persistedBounds() {
  const s = store.get().window || {};
  const w = Math.round(Number(s.width) || 1200);
  const h = Math.round(Number(s.height) || 800);
  if (s.x == null || s.y == null) return { width: w, height: h };
  const hit = clampToDisplay({ x: Number(s.x), y: Number(s.y), width: w, height: h });
  if (!hit) return { width: w, height: h };
  return { x: hit.x, y: hit.y, width: w, height: h };
}

function scheduleBoundsSave(win) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!isUsable(win)) return;
    if (win.isFullScreen() || win.isMaximized() || win.isMinimized()) return;
    const b = win.getBounds();
    store.set('window', { x: b.x, y: b.y, width: b.width, height: b.height });
  }, 400);
}

function applyMaterial(win, material) {
  if (!isUsable(win)) return;
  const m = store.MATERIALS.indexOf(material) >= 0 ? material : 'under-window';
  try {
    if (m === 'none') {
      win.setVibrancy(null);
      win.setBackgroundColor('#14161c');
    } else {
      win.setVibrancy(m);
      win.setBackgroundColor('#00000000');
    }
  } catch (e) {
    logger.warn('window', 'setVibrancy failed: ' + (e && e.message));
  }
}

function applyTheme(theme) {
  const t = store.THEMES.indexOf(theme) >= 0 ? theme : 'system';
  nativeTheme.themeSource = t;
}

function sendToShell(channel, payload) {
  if (!isUsable(mainWin)) return;
  try { mainWin.webContents.send(channel, payload); } catch (_) {}
}

function sendToSettings(channel, payload) {
  if (!isUsable(settingsWin)) return;
  try { settingsWin.webContents.send(channel, payload); } catch (_) {}
}

function broadcast(channel, payload) {
  sendToShell(channel, payload);
  sendToSettings(channel, payload);
}

/** 给渲染层的引导数据（只在 renderer 说 ready 后下发） */
function bootstrapPayload() {
  const s = store.get();
  return {
    appVersion: require('electron').app.getVersion(),
    platform: 'darwin',
    arch: process.arch,
    settings: s,
    servers: s.servers,
    server: s.activeServer || '',
    lastUrl: s.behavior.restoreLastUrl !== false ? s.lastUrl : '',
    toolbarHeight: s.appearance.toolbarHeight || TOOLBAR_HEIGHT,
    trafficLightInset: 78,
    isFullScreen: isUsable(mainWin) ? mainWin.isFullScreen() : false,
    systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    logsDir: logger.getDir()
  };
}

function attachGuestPolicy(guest) {
  if (!guest) return;
  try {
    guest.setWindowOpenHandler(({ url }) => {
      const servers = store.get().servers;
      if (nav.isAllowedNavigation(url, servers)) return { action: 'allow' };
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
  } catch (_) {}

  guest.on('will-navigate', (e, url) => {
    const servers = store.get().servers;
    if (nav.isAllowedNavigation(url, servers)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    logger.warn('webview', 'blocked navigation: ' + url);
  });

  guest.on('did-navigate', (_e, url) => {
    store.set('lastUrl', url);
    sendToShell('shell:navigated', { url });
  });

  guest.on('did-navigate-in-page', (_e, url) => {
    sendToShell('shell:navigated', { url });
  });

  guest.on('page-title-updated', (_e, title) => {
    if (isUsable(mainWin)) mainWin.setTitle(title || 'FNOS');
    sendToShell('shell:title', { title: String(title || '') });
  });

  guest.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // ABORTED
    logger.warn('webview', 'did-fail-load ' + code + ' ' + desc + ' ' + url);
    sendToShell('shell:load-failed', { code, desc, url });
  });

  guest.on('render-process-gone', (_e, details) => {
    logger.error('webview', 'render-process-gone ' + JSON.stringify(details));
    sendToShell('shell:crashed', details);
  });

  guest.on('did-start-loading', () => sendToShell('shell:loading', { loading: true }));
  guest.on('did-stop-loading', () => sendToShell('shell:loading', { loading: false }));

  guest.on('context-menu', (_e, params) => {
    // macOS 惯例：右键交给系统默认（含拼写、拷贝、查看源）；这里仅拦截"在新窗口打开链接"
    if (params && params.linkURL && params.linkURL !== params.pageURL) {
      // 交给 webview 的 window-open 处理，不额外弹菜单
    }
  });
}

function createMainWindow() {
  const s = store.get();
  const bounds = persistedBounds();
  const material = s.appearance.material;

  mainWin = new BrowserWindow(Object.assign({}, bounds, {
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'FNOS',
    backgroundColor: material === 'none' ? '#14161c' : '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC,
    vibrancy: material === 'none' ? undefined : material,
    visualEffectState: 'active',
    roundedCorners: true,
    tabbingIdentifier: 'fnos-main',
    webPreferences: {
      preload: path.join(PRELOAD, 'app-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: true,
      backgroundThrottling: false,
      partition: 'persist:fnos'
    }
  }));

  applyTheme(s.appearance.theme);
  applyMaterial(mainWin, material);

  mainWin.once('ready-to-show', () => {
    mainWin.show();
  });

  mainWin.on('resize', () => scheduleBoundsSave(mainWin));
  mainWin.on('move', () => scheduleBoundsSave(mainWin));

  mainWin.on('enter-full-screen', () => {
    sendToShell('shell:fullscreen', { fullscreen: true });
  });
  mainWin.on('leave-full-screen', () => {
    sendToShell('shell:fullscreen', { fullscreen: false });
  });

  mainWin.on('close', (e) => {
    if (quitting) return;
    if (store.get().behavior.hideOnClose) {
      e.preventDefault();
      mainWin.hide();
      logger.info('window', 'main window hidden (close-to-tray)');
    }
  });

  mainWin.on('closed', () => {
    mainWin = null;
  });

  // 主窗本身（壳页）不允许外部导航
  mainWin.webContents.on('will-navigate', (e) => {
    e.preventDefault();
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWin.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    const src = (params && params.src) || '';
    if (src && src !== 'about:blank' && !nav.isAllowedNavigation(src, store.get().servers)) {
      logger.warn('webview', 'blocked attach src: ' + src);
      e.preventDefault();
    }
  });

  mainWin.webContents.on('did-attach-webview', (_e, guest) => {
    attachGuestPolicy(guest);
  });

  const startUrl = (s.behavior.restoreLastUrl !== false && s.lastUrl) ? s.lastUrl : (s.activeServer || '');
  const hash = startUrl ? '#url=' + encodeURIComponent(startUrl) : '';
  mainWin.loadURL(rendererFile('shell.html') + hash);

  mainWin.webContents.on('did-finish-load', () => {
    logger.info('window', 'shell loaded');
  });

  return mainWin;
}

function createSettingsWindow() {
  if (isUsable(settingsWin)) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }

  settingsWin = new BrowserWindow({
    width: 760,
    height: 660,
    minWidth: 680,
    minHeight: 560,
    show: false,
    title: '偏好设置',
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    roundedCorners: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      partition: 'persist:fnos-settings'
    }
  });

  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });

  settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  settingsWin.loadURL(rendererFile('settings.html'));
  return settingsWin;
}

function getMainWindow() {
  return isUsable(mainWin) ? mainWin : null;
}

function getSettingsWindow() {
  return isUsable(settingsWin) ? settingsWin : null;
}

function showMain() {
  if (!isUsable(mainWin)) {
    createMainWindow();
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function closeSettings() {
  if (isUsable(settingsWin)) settingsWin.close();
}

function toggleMainVisibility() {
  if (!isUsable(mainWin)) {
    createMainWindow();
    return true;
  }
  if (mainWin.isVisible() && !mainWin.isMinimized()) {
    mainWin.hide();
    return false;
  }
  showMain();
  return true;
}

function toggleFullScreen() {
  if (!isUsable(mainWin)) return;
  mainWin.setFullScreen(!mainWin.isFullScreen());
}

function markQuitting() {
  quitting = true;
}

function applyAppearance(settings) {
  const s = settings || store.get();
  applyTheme(s.appearance.theme);
  if (isUsable(mainWin)) applyMaterial(mainWin, s.appearance.material);
  broadcast('shell:appearance', {
    theme: s.appearance.theme,
    material: s.appearance.material,
    uiAlpha: s.appearance.uiAlpha,
    toolbarHeight: s.appearance.toolbarHeight,
    systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  });
}

module.exports = {
  TOOLBAR_HEIGHT,
  createMainWindow,
  createSettingsWindow,
  getMainWindow,
  getSettingsWindow,
  showMain,
  closeSettings,
  toggleMainVisibility,
  toggleFullScreen,
  markQuitting,
  applyAppearance,
  applyMaterial,
  applyTheme,
  sendToShell,
  sendToSettings,
  broadcast,
  bootstrapPayload,
  rendererFile
};
