'use strict';
/** 外壳 / 窗口 / 主题 / 悬浮球 / 诊断 / 缩放 */
const { ipcMain, BrowserWindow, Menu, nativeTheme, app, net } = require('electron');
const prefs = require('./prefs');
const win = require('./win');
const menu = require('./menu');
const nav = require('./nav');
const logger = require('../logger');

let guestProvider = () => null;
function setGuestProvider(fn) { guestProvider = fn; }

function senderWin(e) {
  try {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) return w;
  } catch (_) {}
  return win.getMain();
}

function zoomTarget() {
  try {
    const g = guestProvider();
    if (g && !g.isDestroyed()) return g;
  } catch (_) {}
  const m = win.getMain();
  return m ? m.webContents : null;
}

function applyZoom(kind) {
  const wc = zoomTarget();
  if (!wc || wc.isDestroyed()) return 1;
  try {
    let z = wc.getZoomFactor() || 1;
    if (kind === 'reset') z = 1;
    else if (kind === 'in') z = Math.min(2.5, z * 1.1);
    else if (kind === 'out') z = Math.max(0.5, z / 1.1);
    else if (Number.isFinite(Number(kind))) z = Math.max(0.5, Math.min(2.5, Number(kind)));
    wc.setZoomFactor(z);
    return z;
  } catch (_) { return 1; }
}

function register() {
  // ── 外壳 ──
  ipcMain.handle('shell:minimize', () => {
    const w = win.getMain();
    if (w) { try { w.minimize(); } catch (_) {} }
    return true;
  });

  ipcMain.handle('shell:toggle-maximize', () => {
    const w = win.getMain();
    if (!w) return false;
    try {
      const fs = w.isFullScreen();
      w.setFullScreen(!fs);
      win.shellMaximized(!fs);
      return !fs;
    } catch (_) { return false; }
  });

  ipcMain.handle('shell:close', () => {
    const w = win.getMain();
    if (!w) return true;
    try { w.close(); } catch (_) {}
    return true;
  });

  ipcMain.handle('shell:popup-menu', (e, payload) => {
    const w = senderWin(e);
    menu.popupAt(w, payload);
    return true;
  });

  ipcMain.on('shell:report-apps', (_e, apps) => {
    try {
      const list = Array.isArray(apps) ? apps.filter((a) => a && a.name && a.url).slice(0, 300) : [];
      prefs.saveDebounced({ apps: list }, 1500);
    } catch (_) {}
  });

  // ── 旧窗口控制通道（渲染层各处仍在用） ──
  ipcMain.on('window-minimize', (e) => { try { senderWin(e).minimize(); } catch (_) {} });
  ipcMain.on('window-maximize', (e) => {
    try {
      const w = senderWin(e);
      if (!w) return;
      const fs = w.isFullScreen();
      w.setFullScreen(!fs);
      win.shellMaximized(!fs);
    } catch (_) {}
  });
  ipcMain.on('window-close', (e) => {
    try {
      const w = senderWin(e);
      if (!w) return;
      if (w === win.getMain()) w.close(); else w.close();
    } catch (_) {}
  });
  ipcMain.on('window-is-maximized', (e) => {
    try { e.returnValue = !!(senderWin(e) && senderWin(e).isFullScreen()); } catch (_) { e.returnValue = false; }
  });
  ipcMain.handle('window-is-maximized', (e) => {
    try { return !!(senderWin(e) && senderWin(e).isFullScreen()); } catch (_) { return false; }
  });
  ipcMain.on('win-fs-state', (e) => {
    try { e.returnValue = !!(senderWin(e) && senderWin(e).isFullScreen()); } catch (_) { e.returnValue = false; }
  });

  // macOS 原生拖动由 -webkit-app-region 承担，这些通道收下但不做位移计算（避免与原生拖拽打架）
  ipcMain.on('window-drag', () => {});
  ipcMain.on('win-drag-start', () => {});
  ipcMain.on('win-drag-move', () => {});
  ipcMain.on('win-drag-end', () => {});

  // ── 主题 ──
  ipcMain.on('theme:sys-dark', (e) => { try { e.returnValue = nativeTheme.shouldUseDarkColors; } catch (_) {} });
  ipcMain.handle('theme:sys-dark', () => nativeTheme.shouldUseDarkColors);
  ipcMain.on('theme:mode', (e) => { try { e.returnValue = nativeTheme.themeSource; } catch (_) {} });
  ipcMain.handle('theme:mode', () => nativeTheme.themeSource);

  // ── 悬浮球 ──
  ipcMain.on('ball:get-pos', (e) => { try { e.returnValue = prefs.load().ballPos || null; } catch (_) {} });
  ipcMain.handle('ball:get-pos', () => prefs.load().ballPos || null);
  ipcMain.on('ball:set-pos', (_e, pos) => {
    try {
      const p = pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))
        ? { x: Math.round(Number(pos.x)), y: Math.round(Number(pos.y)) } : null;
      prefs.saveDebounced({ ballPos: p }, 600);
    } catch (_) {}
  });
  ipcMain.handle('ball:set-pos', (_e, pos) => {
    const p = pos && Number.isFinite(Number(pos.x)) ? { x: Math.round(Number(pos.x)), y: Math.round(Number(pos.y)) } : null;
    prefs.saveDebounced({ ballPos: p }, 600);
    return { ok: true };
  });

  // ── 缩放 ──
  ipcMain.on('fnos:zoom-get', (e) => {
    try { const wc = zoomTarget(); e.returnValue = wc && !wc.isDestroyed() ? wc.getZoomFactor() : 1; } catch (_) { e.returnValue = 1; }
  });
  ipcMain.on('fnos:zoom-set', (e, v) => {
    try { e.returnValue = applyZoom(v); } catch (_) {}
  });

  // ── 日志 ──
  ipcMain.on('diag:log', (_e, data) => { logger.fromRenderer(data); });
  ipcMain.on('fnos:media-log', (_e, data) => { logger.fromRenderer(Object.assign({ module: 'media' }, data || {})); });

  // ── 网络状态 ──
  ipcMain.handle('network:get-status', () => new Promise((resolve) => {
    const s = prefs.load();
    const origin = nav.originOf(s.server || s.origin || '');
    if (!origin) { resolve({ ok: true, online: false, reason: 'not-connected' }); return; }
    let done = false;
    const done2 = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const started = Date.now();
      const req = net.request({ method: 'HEAD', url: origin + '/', timeout: 4000 });
      req.on('response', (res) => done2({ ok: true, online: res.statusCode > 0, status: res.statusCode, ms: Date.now() - started }));
      req.on('error', (err) => done2({ ok: true, online: false, error: String((err && err.message) || err) }));
      req.end();
      setTimeout(() => done2({ ok: true, online: false, error: 'timeout' }), 4500);
    } catch (e) { done2({ ok: true, online: false, error: String((e && e.message) || e) }); }
  }));

  // ── 应用菜单（自绘入口）：用原生 Menu 在坐标处弹出，选择后回传 ──
  ipcMain.on('app-popup-menu', (e, anchor) => {
    try {
      const w = senderWin(e);
      const items = (anchor && (anchor.items || anchor.menu)) || null;
      let tpl;
      if (Array.isArray(items) && items.length) {
        tpl = items.map((it) => ({
          label: String((it && (it.label || it.name)) || ''),
          type: it && it.type === 'separator' ? 'separator' : 'normal',
          enabled: !(it && it.enabled === false),
          click: () => {
            try { e.sender.send('app-popup-result', { id: (it && (it.id || it.key || it.label)) || '' }); } catch (_) {}
          },
        }));
      } else {
        tpl = [
          { label: '重新加载', click: () => { try { w && w.reload(); } catch (_) {} } },
          { label: '返回首页', click: () => { try { w && w.webContents.send('shell:navigate', 'home'); } catch (_) {} } },
          { type: 'separator' },
          { label: '偏好设置…', click: () => win.openSettings() },
        ];
      }
      const x = anchor && Number.isFinite(anchor.x) ? Math.round(anchor.x) : undefined;
      const y = anchor && Number.isFinite(anchor.y) ? Math.round(anchor.y) : undefined;
      Menu.buildFromTemplate(tpl).popup({ window: w || undefined, x, y });
    } catch (err) { logger.log('warn', 'menu', 'app-popup-menu failed', { err }); }
  });

  nativeTheme.on('updated', () => {
    try { win.sendToAll('theme:sys-dark-changed', nativeTheme.shouldUseDarkColors); } catch (_) {}
  });
}

module.exports = { register, setGuestProvider, applyZoom };
