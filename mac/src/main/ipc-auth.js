'use strict';
/** 连接、账号、标题栏注入判定 */
const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const prefs = require('./prefs');
const nav = require('./nav');
const win = require('./win');
const logger = require('../logger');

const PARTITION = 'persist:connect';

function historyList() {
  const s = prefs.load();
  return (s.history || []).map((h) => ({
    href: h.href, url: h.href, label: h.label || nav.hostOf(h.href) || h.href,
    origin: h.origin || nav.originOf(h.href), lastUsed: h.lastUsed || 0,
  }));
}

function pushHistory(origin, label) {
  const s = prefs.load();
  const list = (s.history || []).filter((h) => nav.originOf(h.href || h.url) !== origin);
  list.unshift({ href: origin, origin, label: label || nav.hostOf(origin), lastUsed: Date.now() });
  prefs.save({ history: list.slice(0, 12) });
}

function accountList() {
  const s = prefs.load();
  const activeOrigin = s.activeAccountOrigin || nav.originOf(s.server);
  return (s.accounts || []).map((a) => ({
    origin: a.origin,
    label: a.label || nav.hostOf(a.origin) || a.origin,
    isActive: !!(activeOrigin && a.origin === activeOrigin),
    lastUsed: a.lastUsed || 0,
  }));
}

function upsertAccount(origin) {
  if (!origin) return;
  const s = prefs.load();
  const list = (s.accounts || []).filter((a) => a && a.origin !== origin);
  list.unshift({ origin, label: nav.hostOf(origin), lastUsed: Date.now() });
  prefs.save({ accounts: list.slice(0, 10), activeAccountOrigin: origin });
}

function connectTo(serverInput) {
  const r = nav.normalizeServer(serverInput);
  if (!r.ok) return { ok: false, error: r.error };
  const origin = r.url;
  prefs.save({ server: origin, origin, lastConnectHref: origin, currentPartition: PARTITION });
  pushHistory(origin);
  upsertAccount(origin);

  const w = win.getMain();
  const target = { replace: true, partition: PARTITION, url: origin + '/' };
  if (w) {
    win.shellOpen(target);
    win.focusMain();
  } else {
    win.createMain({ partition: PARTITION, url: origin + '/' });
  }
  logger.log('info', 'auth', 'connect', { origin });
  return { ok: true, origin };
}

function showConnectPage() {
  const w = win.getMain();
  const fileUrl = 'file://' + String(win.file('login.html')).replace(/\\/g, '/');
  const target = { replace: true, partition: PARTITION, url: fileUrl };
  if (w) { win.shellOpen(target); win.focusMain(); }
  else win.createMain({ partition: PARTITION, url: fileUrl });
  return { ok: true };
}

function switchAccount(originInput) {
  const origin = nav.originOf(originInput) || String(originInput || '');
  if (!origin) return { ok: false, error: '账号地址无效' };
  prefs.save({ server: origin, origin, activeAccountOrigin: origin, lastConnectHref: origin });
  pushHistory(origin);
  const target = { replace: true, partition: PARTITION, url: origin + '/' };
  if (win.getMain()) { win.shellOpen(target); win.focusMain(); }
  else win.createMain({ partition: PARTITION, url: origin + '/' });
  logger.log('info', 'auth', 'switch account', { origin });
  return { ok: true, origin };
}

function register() {
  ipcMain.handle('auth:connect', (_e, payload) => {
    const server = payload && (payload.server || payload.url || payload.href);
    try { return connectTo(server); } catch (e) {
      logger.log('error', 'auth', 'connect failed', { err: e });
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('auth:load-history', () => {
    try { return { ok: true, history: historyList() }; } catch (_) { return { ok: true, history: [] }; }
  });

  ipcMain.handle('auth:remove-history', (_e, payload) => {
    try {
      const href = typeof payload === 'string' ? payload : (payload && (payload.href || payload.url)) || '';
      const origin = nav.originOf(href) || String(href || '');
      const s = prefs.load();
      const list = (s.history || []).filter((h) => nav.originOf(h.href || h.url) !== origin);
      prefs.save({ history: list });
      return { ok: true, history: historyList() };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('auth:back-to-connect', () => {
    try { return showConnectPage(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('account:list', () => {
    try { return { ok: true, accounts: accountList() }; } catch (_) { return { ok: true, accounts: [] }; }
  });

  ipcMain.handle('account:get-active', () => {
    try {
      const s = prefs.load();
      const origin = s.activeAccountOrigin || nav.originOf(s.server);
      return { ok: true, origin, label: nav.hostOf(origin) || origin, isActive: !!origin };
    } catch (_) { return { ok: true, origin: '' }; }
  });

  ipcMain.handle('account:switch', (_e, payload) => {
    try {
      return switchAccount((payload && (payload.origin || payload.accountId)) || '');
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('account:remove', (_e, payload) => {
    try {
      const id = String((payload && (payload.accountId || payload.origin)) || '');
      const s = prefs.load();
      const list = (s.accounts || []).filter((a) => a && a.origin !== id && a.label !== id);
      prefs.save({ accounts: list });
      return { ok: true, accounts: accountList() };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // Windows 版用于判断远端页面是否要注入自绘标题栏；macOS 恒为 false（外壳承担标题栏）
  ipcMain.on('titlebar:should-inject', (e) => {
    try { e.returnValue = false; } catch (_) {}
  });
}

module.exports = { register, PARTITION, historyList, accountList, connectTo, showConnectPage, switchAccount, pushHistory, upsertAccount };
