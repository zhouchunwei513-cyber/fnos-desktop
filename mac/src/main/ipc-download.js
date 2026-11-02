'use strict';
/**
 * 下载管理（macOS）
 * 统一走 Electron 原生 DownloadItem：webview 内点击下载 / download:start 都汇到 session 的 will-download。
 * 每个任务一个进度小窗，事件通道与 Windows 版一致（download:start / progress / done）。
 */
const { ipcMain, session, app, shell, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const win = require('./win');
const prefs = require('./prefs');
const logger = require('../logger');

let seq = 0;
const tasks = new Map();      // id -> task
const itemToId = new Map();   // DownloadItem -> id

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / 1073741824).toFixed(2) + ' GB';
  if (v >= 1024 * 1024) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
}

function fmtSpeed(bps) {
  const v = Number(bps) || 0;
  if (v <= 0) return '';
  return fmtBytes(v) + '/s';
}

function fmtEta(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!isFinite(s) || s <= 0) return '';
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  return Math.floor(s / 3600) + ' 时 ' + Math.floor((s % 3600) / 60) + ' 分';
}

function defaultDir() {
  try { return app.getPath('downloads'); } catch (_) { return app.getPath('home'); }
}

function publicTask(t) {
  return {
    id: t.id,
    filename: t.filename,
    savePath: t.savePath,
    totalBytes: t.totalBytes,
    receivedBytes: t.receivedBytes,
    pct: t.pct,
    totalText: t.totalText,
    receivedText: t.receivedText,
    speedText: t.speedText,
    etaText: t.etaText,
    state: t.state,
  };
}

function push(t, channel) {
  try {
    const w = win.dlWindow(t.id);
    if (w) w.webContents.send(channel, publicTask(t));
  } catch (_) {}
}

function tick(t) {
  const now = Date.now();
  const dt = (now - t.lastTick) / 1000;
  if (dt > 0.4) {
    const db = t.receivedBytes - t.lastBytes;
    t.speed = db / dt;
    t.lastBytes = t.receivedBytes;
    t.lastTick = now;
  }
  const remain = t.totalBytes > 0 ? t.totalBytes - t.receivedBytes : 0;
  t.speedText = fmtSpeed(t.speed);
  t.etaText = t.speed > 0 && remain > 0 ? fmtEta(remain / t.speed) : '';
  t.totalText = t.totalBytes > 0 ? fmtBytes(t.totalBytes) : '未知';
  t.receivedText = fmtBytes(t.receivedBytes);
  t.pct = t.totalBytes > 0 ? Math.max(0, Math.min(100, (t.receivedBytes / t.totalBytes) * 100)) : 0;
}

function attach(webContentsSession) {
  const ses = webContentsSession || session.fromPartition('persist:connect');
  ses.on('will-download', (event, item, wc) => {
    try {
      const id = ++seq;
      const filename = item.getFilename() || 'download';
      const savePath = path.join(defaultDir(), filename);

      const t = {
        id, item, filename, savePath,
        totalBytes: item.getTotalBytes() || 0,
        receivedBytes: item.getReceivedBytes() || 0,
        pct: 0, totalText: '', receivedText: '', speedText: '', etaText: '',
        speed: 0, lastTick: Date.now(), lastBytes: 0,
        state: 'downloading', target: wc ? wc.id : 0,
      };
      tasks.set(id, t);
      itemToId.set(item, id);

      try { item.setSavePath(savePath); } catch (_) {}

      // 动态通道：与 download-preload 约定的 download:cancel:<id> / close:<id> / open:<id>
      ipcMain.handle('download:cancel:' + id, () => {
        try { item.cancel(); } catch (_) {}
        t.state = 'canceled';
        return { ok: true };
      });
      ipcMain.handle('download:close:' + id, () => {
        const w = win.dlWindow(id);
        if (w) { try { w.close(); } catch (_) {} }
        return { ok: true };
      });
      ipcMain.handle('download:open:' + id, () => {
        try {
          const p = t.savePath;
          if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return { ok: true }; }
          shell.openPath(defaultDir());
          return { ok: true };
        } catch (_) { return { ok: false }; }
      });

      // 打开进度窗（延迟一点，等 guest 页面稳定）
      setImmediate(() => {
        try {
          win.openDownloadWindow(id);
          setTimeout(() => { push(t, 'download:start'); }, 260);
        } catch (_) {}
      });

      item.on('updated', (_e, state) => {
        try {
          t.receivedBytes = item.getReceivedBytes();
          t.totalBytes = item.getTotalBytes() || t.totalBytes;
          t.state = state === 'interrupted' ? 'paused' : 'downloading';
          tick(t);
          push(t, 'download:progress');
        } catch (_) {}
      });

      item.once('done', (_e, state) => {
        try {
          t.receivedBytes = item.getReceivedBytes();
          t.totalBytes = item.getTotalBytes() || t.totalBytes;
          tick(t);
          t.state = state === 'completed' ? 'done' : (state === 'cancelled' ? 'canceled' : 'failed');
          t.savePath = item.getSavePath() || t.savePath;
          push(t, 'download:done');
          logger.log('info', 'download', 'done', { id, state, file: t.savePath });
          setTimeout(() => {
            try {
              const w = win.dlWindow(id);
              if (w && !w.isDestroyed()) w.close();
            } catch (_) {}
          }, state === 'completed' ? 4000 : 2500);
        } catch (_) {}
      });
    } catch (err) {
      logger.log('error', 'download', 'will-download failed', { err });
      try { event.preventDefault(); } catch (_) {}
    }
  });
}

function register() {
  ipcMain.handle('download:start', (e, payload) => {
    try {
      const p = payload || {};
      const url = String(p.url || p.href || '');
      if (!url) return { ok: false, error: '缺少下载地址' };
      const wc = e.sender;
      const opts = {};
      if (p.filename) opts.filename = String(p.filename);
      wc.downloadURL(url, opts);
      return { ok: true };
    } catch (err) {
      logger.log('error', 'download', 'start failed', { err });
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('download:list', () => {
    try {
      return { ok: true, list: Array.from(tasks.values()).map(publicTask) };
    } catch (_) { return { ok: true, list: [] }; }
  });

  ipcMain.handle('download:get-default-path', () => ({ ok: true, path: defaultDir() }));

  ipcMain.handle('download:pause', (_e, payload) => {
    try {
      const id = Number(payload && (payload.id || payload.dlId));
      const t = tasks.get(id);
      if (!t) return { ok: false, error: '任务不存在' };
      t.item.pause();
      t.state = 'paused';
      push(t, 'download:progress');
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('download:resume', (_e, payload) => {
    try {
      const id = Number(payload && (payload.id || payload.dlId));
      const t = tasks.get(id);
      if (!t) return { ok: false, error: '任务不存在' };
      t.item.resume();
      t.state = 'downloading';
      push(t, 'download:progress');
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('download:cancel', (_e, payload) => {
    try {
      const id = Number(payload && (payload.id || payload.dlId));
      const t = tasks.get(id);
      if (!t) return { ok: false, error: '任务不存在' };
      t.item.cancel();
      t.state = 'canceled';
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 更新下载取消（更新进度窗）
  ipcMain.on('upd:cancel-download', () => {
    try { global.__fnosUpdCancel && global.__fnosUpdCancel(); } catch (_) {}
    try { win.closeUpdateProgress(); } catch (_) {}
  });
}

module.exports = { register, attach, defaultDir, tasks, publicTask };
