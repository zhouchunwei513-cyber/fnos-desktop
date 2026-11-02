'use strict';
/** 设置 / 皮肤 / 日志 / 开机自启 / FPK API / 播放器运行时 */
const { ipcMain, app, dialog, shell, BrowserWindow, net } = require('electron');
const path = require('path');
const fs = require('fs');
const prefs = require('./prefs');
const win = require('./win');
const skin = require('./skin');
const nav = require('./nav');
const menu = require('./menu');
const logger = require('../logger');

function settingsForRenderer() {
  const s = prefs.load();
  const alphaPct = prefs.uiAlphaPct(s);
  return {
    hasPassword: prefs.hasPassword(),
    shortcuts: s.shortcuts,
    urlRewrites: s.urlMappings,
    autoHideMenuBar: !!s.autoHideMenuBar,
    titleBarAutoHide: !!s.titleBarAutoHide,
    titleBarOpacity: prefs.clampInt(s.titleBarOpacity, 0, 100, 96),
    titleBarColor: s.titleBarColor,
    titleBarMaterial: s.titleBarMaterial === 'frosted' ? 'frosted' : 'solid',
    titleBarBlur: prefs.clampInt(s.titleBarBlur, 0, 40, 20),
    titleBarFrostColor: s.titleBarFrostColor,
    titleBarFrostAlpha: prefs.clampInt(s.titleBarFrostAlpha, 2, 35, 10),
    titleBarSolidColor: s.titleBarSolidColor,
    titleBarSolidAlpha: prefs.clampInt(s.titleBarSolidAlpha, 90, 100, 100),
    titleBarDivider: s.titleBarDivider !== false,
    titleBarHighlight: prefs.clampInt(s.titleBarHighlight, 0, 100, 55),
    themeColor: s.themeColor,
    activeSkin: s.activeSkin || '',
    hideAccountBall: !!s.hideAccountBall,
    uiTransparent: alphaPct > 0,
    uiTransparentAlpha: alphaPct,
    barCorner: s.barCorner,
    winCorner: s.winCorner,
    ballPos: s.ballPos,
    autoLockMinutes: prefs.clampInt(s.autoLockMinutes, 0, 240, 0),
    shortcutHideMode: s.shortcutHideMode === 'minimize' ? 'minimize' : 'tray',
    fpkBaseUrl: s.fpkApi && s.fpkApi.enabled ? ('http://' + (s.fpkApi.host || '') + ':' + (s.fpkApi.port || 18080)) : '',
    iptv: {
      iptvBaseUrl: (s.iptv && s.iptv.iptvBaseUrl) || '',
      iptvLine: (s.iptv && s.iptv.iptvLine) || 'inner',
      iptvFavorites: (s.iptv && s.iptv.iptvFavorites) || [],
      iptvEpgUrl: (s.iptv && s.iptv.iptvEpgUrl) || '',
      iptvCacheSeconds: (s.iptv && s.iptv.iptvCacheSeconds) || 20,
    },
    version: app.getVersion(),
    platform: process.platform,
    fpkApi: { enabled: !!(s.fpkApi && s.fpkApi.enabled), host: (s.fpkApi && s.fpkApi.host) || '', port: (s.fpkApi && s.fpkApi.port) || 18080 },
    mpv: Object.assign({}, s.mpv, { platform: 'darwin', available: false }),
  };
}

function afterUiChange(reason) {
  try { win.broadcastTheme(); } catch (_) {}
  try { menu.refresh(); } catch (_) {}
  try { logger.log('info', 'settings', 'ui changed', { reason }); } catch (_) {}
}

function testFpk(host, port) {
  return new Promise((resolve) => {
    if (!host) { resolve({ ok: false, error: '未配置服务地址' }); return; }
    const url = 'http://' + host + ':' + (port || 18080) + '/api/status';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const req = net.request({ method: 'GET', url, timeout: 5000 });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => { body += c.toString(); if (body.length > 4096) body = body.slice(0, 4096); });
        res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body: body.slice(0, 400) }));
      });
      req.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
      req.on('timeout', () => { try { req.abort(); } catch (_) {} finish({ ok: false, error: '连接超时' }); });
      req.end();
      setTimeout(() => finish({ ok: false, error: '连接超时' }), 6000);
    } catch (e) { finish({ ok: false, error: String((e && e.message) || e) }); }
  });
}

function register() {
  // ── 读取 ──
  ipcMain.handle('settings:get', () => {
    try { return settingsForRenderer(); } catch (e) {
      logger.log('error', 'settings', 'get failed', { err: e });
      return settingsForRenderer();
    }
  });

  // ── 密码 ──
  ipcMain.handle('settings:set-password', (_e, payload) => {
    try {
      const oldPw = String((payload && payload.oldPassword) || '');
      const newPw = String((payload && payload.newPassword) || '');
      prefs.setPassword(oldPw, newPw);
      menu.refresh();
      return { ok: true, hasPassword: prefs.hasPassword() };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' };
    }
  });

  // ── 快捷键（macOS 用 Command 组合） ──
  ipcMain.handle('settings:set-shortcuts', (_e, payload) => {
    try {
      const lockApp = String((payload && payload.lockApp) || '').trim();
      const hideAll = String((payload && payload.hideAll) || '').trim();
      prefs.save({ shortcuts: { lockApp, hideAll } });
      menu.refresh();
      return { ok: true, shortcuts: prefs.load().shortcuts };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('settings:set-auto-lock', (_e, payload) => {
    try {
      const m = prefs.clampInt(payload && payload.minutes, 0, 240, 0);
      prefs.save({ autoLockMinutes: m });
      return { ok: true, autoLockMinutes: m };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('settings:set-url-rewrites', (_e, list) => {
    try {
      const arr = Array.isArray(list) ? list.filter((r) => r && r.match && r.replace).slice(0, 80) : [];
      prefs.save({ urlMappings: arr });
      return { ok: true, urlRewrites: arr };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ── UI 选项 ──
  ipcMain.handle('settings:set-ui-options', (_e, opts) => {
    try {
      const o = opts || {};
      const patch = {};
      if (typeof o.autoHideMenuBar === 'boolean') patch.autoHideMenuBar = o.autoHideMenuBar;
      if (o.themeColor) patch.themeColor = String(o.themeColor);
      if (typeof o.titleBarAutoHide === 'boolean') patch.titleBarAutoHide = o.titleBarAutoHide;
      if (o.titleBarOpacity != null && Number.isFinite(Number(o.titleBarOpacity))) {
        patch.titleBarOpacity = prefs.clampInt(o.titleBarOpacity, 0, 100, 96);
      }
      if (o.titleBarColor) patch.titleBarColor = String(o.titleBarColor);
      if (o.titleBarMaterial) patch.titleBarMaterial = String(o.titleBarMaterial) === 'frosted' ? 'frosted' : 'solid';
      if (o.titleBarBlur != null && Number.isFinite(Number(o.titleBarBlur))) {
        patch.titleBarBlur = prefs.clampInt(o.titleBarBlur, 0, 40, 20);
      }
      if (o.titleBarHighlight != null && Number.isFinite(Number(o.titleBarHighlight))) {
        patch.titleBarHighlight = prefs.clampInt(o.titleBarHighlight, 0, 100, 55);
      }
      if (o.titleBarFrostColor) patch.titleBarFrostColor = String(o.titleBarFrostColor);
      if (o.titleBarFrostAlpha != null && Number.isFinite(Number(o.titleBarFrostAlpha))) {
        patch.titleBarFrostAlpha = prefs.clampInt(o.titleBarFrostAlpha, 2, 35, 10);
      }
      if (o.titleBarSolidColor) patch.titleBarSolidColor = String(o.titleBarSolidColor);
      if (o.titleBarSolidAlpha != null && Number.isFinite(Number(o.titleBarSolidAlpha))) {
        patch.titleBarSolidAlpha = prefs.clampInt(o.titleBarSolidAlpha, 90, 100, 100);
      }
      if (typeof o.titleBarDivider === 'boolean') patch.titleBarDivider = o.titleBarDivider;
      if (o.activeSkin != null) patch.activeSkin = String(o.activeSkin);
      if (typeof o.hideAccountBall === 'boolean') patch.hideAccountBall = o.hideAccountBall;
      if (typeof o.uiTransparent === 'boolean') {
        patch.uiTransparent = o.uiTransparent;
        if (!o.uiTransparent) patch.uiTransparentAlpha = 0;
      }
      if (o.uiTransparentAlpha != null && Number.isFinite(Number(o.uiTransparentAlpha))) {
        const p = prefs.clampInt(o.uiTransparentAlpha, 0, 100, 38);
        patch.uiTransparentAlpha = p;
        patch.uiTransparent = p > 0;
      }
      if (o.barCorner === 'round' || o.barCorner === 'square' || o.barCorner === 'half') patch.barCorner = o.barCorner;
      if (o.winCorner === 'round' || o.winCorner === 'square' || o.winCorner === 'half') patch.winCorner = o.winCorner;

      prefs.save(patch);
      win.setThemeOverride(null);
      afterUiChange('save');
      return { ok: true, settings: settingsForRenderer() };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 实时预览：只广播不落盘
  ipcMain.handle('settings:preview-titlebar', (_e, opts) => {
    try {
      const o = opts || {};
      win.setThemeOverride({
        themeColor: o.themeColor,
        titleBarMaterial: o.titleBarMaterial,
        titleBarOpacity: o.titleBarOpacity,
        titleBarBlur: o.titleBarBlur,
        titleBarHighlight: o.titleBarHighlight,
        titleBarFrostColor: o.titleBarFrostColor,
        titleBarFrostAlpha: o.titleBarFrostAlpha,
        titleBarSolidColor: o.titleBarSolidColor,
        titleBarSolidAlpha: o.titleBarSolidAlpha,
        titleBarDivider: o.titleBarDivider,
        barCorner: o.barCorner,
        winCorner: o.winCorner,
      });
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('settings:set-accent-color', (_e, color) => {
    try {
      prefs.save({ themeColor: String(color || '#5865F2') });
      afterUiChange('accent');
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // Windows titlebar-inject 的轮询点；macOS 无需注入
  ipcMain.on('settings:get-titlebar', (e) => { try { e.returnValue = { inject: false, platform: 'darwin' }; } catch (_) {} });
  ipcMain.handle('settings:get-titlebar', () => ({ inject: false, platform: 'darwin' }));

  // ── 快捷方式打开后的后台化方式 ──
  ipcMain.handle('settings:set-shortcut-hide-mode', (_e, mode) => {
    try {
      const m = String(mode) === 'minimize' ? 'minimize' : 'tray';
      prefs.save({ shortcutHideMode: m });
      return { ok: true, shortcutHideMode: m };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ── FPK 图标管理 API ──
  ipcMain.handle('settings:set-fpk-api', (_e, patch) => {
    try {
      const p = patch || {};
      const cur = prefs.load().fpkApi || {};
      const next = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : !!cur.enabled,
        host: p.host != null ? String(p.host).trim() : (cur.host || ''),
        port: p.port != null ? prefs.clampInt(p.port, 1, 65535, 18080) : (cur.port || 18080),
      };
      prefs.save({ fpkApi: next });
      return { ok: true, fpkApi: next };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('settings:test-fpk-api', async () => {
    const s = prefs.load().fpkApi || {};
    return testFpk(s.host, s.port);
  });

  // ── 开机自启（macOS：登录项） ──
  function autostartEnabled() {
    try { return !!app.getLoginItemSettings().openAtLogin; } catch (_) { return false; }
  }
  function setAutostart(enabled) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: false });
      return autostartEnabled();
    } catch (_) { return false; }
  }
  ipcMain.handle('settings:get-autostart', () => ({ ok: true, enabled: autostartEnabled() }));
  ipcMain.handle('settings:set-autostart', (_e, payload) => {
    const en = !!(payload && payload.enabled);
    return { ok: true, enabled: setAutostart(en) };
  });
  ipcMain.handle('set-auto-launch', (_e, payload) => {
    const en = !!(payload && payload.enable);
    return { ok: true, enabled: setAutostart(en) };
  });

  // ── 播放器（macOS 使用系统 AVFoundation / 内建 HLS，不加载外部 MPV 二进制） ──
  ipcMain.handle('settings:set-vlc', (_e, patch) => {
    try {
      const p = patch || {};
      const cur = prefs.load().mpv || {};
      const next = Object.assign({}, cur);
      for (const k of ['enabled', 'alwaysUse', 'hwDecode', 'exePath', 'extraArgs', 'configMode', 'resume']) {
        if (p[k] !== undefined) next[k] = p[k];
      }
      prefs.save({ mpv: next });
      return { ok: true, mpv: Object.assign({}, next, { platform: 'darwin', available: false }) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('settings:vlc-runtime', () => ({
    ok: true,
    available: false,
    platform: 'darwin',
    engine: 'avfoundation',
    note: 'macOS 版使用系统媒体框架与内建 HLS 播放，无需外部播放器内核',
  }));

  ipcMain.handle('settings:pick-mpv-exe', () => ({
    ok: false, canceled: true,
    error: 'macOS 版不加载 Windows 的 mpv.exe，播放使用系统媒体框架',
  }));

  ipcMain.handle('settings:clear-progress', () => {
    try {
      const p = path.join(app.getPath('userData'), 'play-progress.json');
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ── 日志 ──
  ipcMain.handle('log:list-files', () => {
    try { return { ok: true, dir: logger.dir(), files: logger.list() }; }
    catch (e) { return { ok: false, files: [], error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('log:read', (_e, params) => {
    try {
      const name = typeof params === 'string' ? params : (params && (params.name || params.file));
      return logger.read(name, params && params.maxBytes);
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('log:get-status', () => {
    try {
      return { ok: true, dir: logger.dir(), files: logger.list().length, keepDays: 7 };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ── 皮肤 ──
  ipcMain.handle('settings:list-skins', () => {
    try { return { ok: true, skins: skin.list(), active: prefs.load().activeSkin || '' }; }
    catch (e) { return { ok: false, skins: [], error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('settings:install-skin', async (e) => {
    try {
      const parent = BrowserWindow.fromWebContents(e.sender);
      const r = await skin.install(parent);
      if (r.ok) { afterUiChange('skin-install'); }
      return r;
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });

  ipcMain.handle('settings:delete-skin', (_e, payload) => {
    try {
      const r = skin.remove(payload && payload.name);
      if (r.ok) afterUiChange('skin-delete');
      return r;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.on('settings:close', (e) => {
    try {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && !w.isDestroyed()) w.close();
    } catch (_) {}
  });
}

module.exports = { register, settingsForRenderer, afterUiChange, autostart: null };
