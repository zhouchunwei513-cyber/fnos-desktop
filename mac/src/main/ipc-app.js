'use strict';
/** 应用（NAS 子应用）管理 / 桌面快捷方式 / 更新 / 重启 / 图标 */
const { ipcMain, app, shell, net, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const prefs = require('./prefs');
const win = require('./win');
const nav = require('./nav');
const shortcut = require('./shortcut');
const logger = require('../logger');

const REPO = 'zhouchunwei513-cyber/fnos-desktop';
const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases';

function appsFile() { return path.join(app.getPath('userData'), 'apps.json'); }

function loadApps() {
  try {
    const p = appsFile();
    if (!fs.existsSync(p)) return [];
    const a = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch (_) { return []; }
}

function saveApps(list) {
  try {
    fs.mkdirSync(path.dirname(appsFile()), { recursive: true });
    fs.writeFileSync(appsFile(), JSON.stringify(list.slice(0, 400), null, 2), 'utf8');
  } catch (_) {}
}

function resolveAppUrl(payload) {
  const p = payload || {};
  if (p.url) return nav.applyUrlMappings(String(p.url), prefs.load().urlMappings);
  const base = nav.originOf(p.nasAddress || prefs.load().server || '');
  const id = String(p.appId || p.appName || '').trim();
  if (!base || !id) return '';
  return base + '/app/' + encodeURIComponent(id);
}

function readIconBase64(payload) {
  const p = payload || {};
  if (p.iconData) {
    const s = String(p.iconData);
    return { b64: s.replace(/^data:image\/[a-z0-9+.-]+;base64,/i, ''), ext: (p.iconExt || 'png').replace(/^\./, '') };
  }
  if (p.iconPath) {
    try {
      const buf = fs.readFileSync(p.iconPath);
      return { b64: buf.toString('base64'), ext: path.extname(p.iconPath).replace(/^\./, '') || 'png' };
    } catch (_) {}
  }
  return { b64: '', ext: 'png' };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    try {
      const req = net.request({ method: 'GET', url, timeout: 8000 });
      req.setHeader('User-Agent', 'FNOS-macOS');
      req.setHeader('Accept', 'application/vnd.github+json');
      let body = '';
      req.on('response', (res) => {
        res.on('data', (c) => { body += c.toString(); if (body.length > 512 * 1024) { try { req.abort(); } catch (_) {} } });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          } else reject(new Error('HTTP ' + res.statusCode));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { try { req.abort(); } catch (_) {} reject(new Error('timeout')); });
      req.end();
      setTimeout(() => reject(new Error('timeout')), 9000);
    } catch (e) { reject(e); }
  });
}

function cmpVersion(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function register() {
  ipcMain.handle('get-installed-apps', () => {
    try {
      const list = loadApps().map((a) => ({
        appId: a.appId, appName: a.appName, url: a.url,
        path: a.path, icon: a.icon || '', installedAt: a.installedAt || 0,
      }));
      return { success: true, msg: '', data: list };
    } catch (e) { return { success: false, msg: String((e && e.message) || e), data: [] }; }
  });

  ipcMain.handle('install-nas-app', (_e, payload) => {
    try {
      const p = payload || {};
      const appId = String(p.appId || p.appName || '').trim();
      const appName = String(p.appName || appId || 'FNOS 应用').trim();
      if (!appId) return { success: false, msg: '缺少应用标识', data: null };

      const url = resolveAppUrl(p);
      if (!url) return { success: false, msg: '缺少服务器地址', data: null };

      const icon = readIconBase64(p);
      const r = shortcut.createAppBundle({
        dir: shortcut.appsDir(),
        name: appName,
        url,
        iconBase64: icon.b64,
        iconExt: icon.ext,
      });
      if (!r.ok) return { success: false, msg: r.error || '创建失败', data: null };

      const list = loadApps().filter((a) => a.appId !== appId);
      list.unshift({ appId, appName, url, path: r.path, icon: p.iconData || p.iconPath || '', installedAt: Date.now() });
      saveApps(list);
      logger.log('info', 'app', 'install', { appId, appName, path: r.path });
      return { success: true, msg: '已安装', data: { appId, appName, path: r.path } };
    } catch (e) { return { success: false, msg: String((e && e.message) || e), data: null }; }
  });

  ipcMain.handle('uninstall-nas-app', (_e, payload) => {
    try {
      const appId = String((payload && payload.appId) || '');
      const list = loadApps();
      const hit = list.find((a) => a.appId === appId);
      if (hit && hit.path) {
        try { fs.rmSync(hit.path, { recursive: true, force: true }); } catch (_) {}
      }
      saveApps(list.filter((a) => a.appId !== appId));
      return { success: true, msg: '已卸载', data: null };
    } catch (e) { return { success: false, msg: String((e && e.message) || e), data: null }; }
  });

  ipcMain.handle('create-desktop-shortcut', (_e, payload) => {
    try {
      const p = payload || {};
      const appName = String(p.appName || p.appId || 'FNOS').trim();
      const url = resolveAppUrl(p);
      if (!url) return { success: false, msg: '缺少应用地址', data: null };
      const icon = readIconBase64(p);
      const r = shortcut.createAppBundle({
        dir: shortcut.desktopDir(),
        name: appName,
        url,
        iconBase64: icon.b64,
        iconExt: icon.ext,
      });
      if (!r.ok) return { success: false, msg: r.error || '创建失败', data: null };
      logger.log('info', 'app', 'desktop shortcut', { appName, path: r.path });
      return { success: true, msg: '已在桌面创建快捷方式', data: { path: r.path } };
    } catch (e) { return { success: false, msg: String((e && e.message) || e), data: null }; }
  });

  // SVG → PNG：主进程无 SVG 光栅化能力，交由渲染层 canvas 处理；这里明确回报不支持
  ipcMain.handle('app:convert-svg-icon', (_e, payload) => {
    try {
      const raw = String((payload && (payload.svg || payload.data)) || '');
      if (!raw) return { ok: false, error: '无 SVG 内容' };
      const b64 = 'data:image/svg+xml;base64,' + Buffer.from(raw, 'utf8').toString('base64');
      return { ok: false, error: 'macOS 版请在渲染层用 canvas 转换', svgDataUrl: b64 };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('app:check-update', async () => {
    const current = app.getVersion();
    try {
      const rel = await getJson('https://api.github.com/repos/' + REPO + '/releases/latest');
      const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
      const hasUpdate = latest ? cmpVersion(latest, current) > 0 : false;
      return {
        ok: true, current, latest, hasUpdate,
        url: rel.html_url || RELEASES_PAGE,
        notes: String(rel.body || '').slice(0, 4000),
        assets: (rel.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
      };
    } catch (e) {
      return { ok: false, current, latest: '', hasUpdate: false, url: RELEASES_PAGE, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('app:open-release', () => {
    try { shell.openExternal(RELEASES_PAGE); return { ok: true }; } catch (_) { return { ok: false }; }
  });

  ipcMain.handle('app:show-in-folder', (_e, payload) => {
    try {
      const p = typeof payload === 'string' ? payload : (payload && (payload.path || payload.file));
      if (!p) return { ok: false, error: '缺少路径' };
      if (fs.existsSync(p) && fs.statSync(p).isFile()) shell.showItemInFolder(p);
      else shell.openPath(fs.existsSync(p) ? p : path.dirname(p));
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('app:about-close', (e) => {
    try {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && !w.isDestroyed()) w.close();
      return { ok: true };
    } catch (_) { return { ok: false }; }
  });

  ipcMain.handle('app:restart', () => {
    try {
      app.isQuitting = true;
      app.relaunch({ args: process.argv.slice(1).concat(['--relaunch']) });
      setTimeout(() => app.exit(0), 120);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { register, loadApps };
