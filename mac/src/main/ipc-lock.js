'use strict';
/** 应用锁（离开自动锁定 / 密码校验） */
const { ipcMain, app } = require('electron');
const crypto = require('crypto');
const prefs = require('./prefs');
const win = require('./win');
const logger = require('../logger');

let isLocked = false;
let lastActivity = Date.now();
let timer = null;

function hashPassword(pwd, salt) {
  return crypto.scryptSync(String(pwd), String(salt), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function hasPassword() {
  const s = prefs.load();
  return !!(s.appPasswordHash && s.appPasswordSalt);
}

function verify(pwd) {
  const s = prefs.load();
  if (!s.appPasswordHash || !s.appPasswordSalt) return { ok: true, noPassword: true };
  try {
    const h = hashPassword(pwd, s.appPasswordSalt);
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(s.appPasswordHash, 'hex');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, error: ok ? null : '密码不正确' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function unlock() {
  isLocked = false;
  lastActivity = Date.now();
  try { win.closeLock(); } catch (_) {}
}

function lock(reason) {
  if (!hasPassword()) return false;
  if (isLocked) return true;
  isLocked = true;
  logger.log('info', 'lock', 'locked', { params: { reason: String(reason || 'manual') } });
  try { win.openLock(); } catch (_) {}
  return true;
}

function touch() {
  lastActivity = Date.now();
  if (isLocked) return;
  try {
    const s = prefs.load();
    if (s.autoHideMenuBar === undefined) { /* noop */ }
  } catch (_) {}
}

function checkAutoLock() {
  if (isLocked || !hasPassword()) return;
  const mins = Number((prefs.load().autoLockMinutes) || 0);
  if (!(mins > 0)) return;
  if (Date.now() - lastActivity >= mins * 60 * 1000) lock('idle');
}

function startAutoLockWatcher() {
  if (timer) clearInterval(timer);
  timer = setInterval(checkAutoLock, 30 * 1000);
  if (timer.unref) timer.unref();
}

function register() {
  ipcMain.handle('lock:get-info', () => {
    const s = prefs.load();
    return {
      ok: true,
      hasPassword: !!(s.appPasswordHash && s.appPasswordSalt),
      autoLockMinutes: Math.max(0, Math.min(240, Number(s.autoLockMinutes) || 0)),
      locked: isLocked,
    };
  });

  ipcMain.handle('lock:verify', (_e, payload) => {
    const pwd = typeof payload === 'string' ? payload : (payload && (payload.password || payload.pwd)) || '';
    const r = verify(pwd);
    if (r.ok) { unlock(); return { ok: true }; }
    logger.log('warn', 'lock', 'verify failed');
    return { ok: false, error: r.error || '密码不正确' };
  });

  ipcMain.handle('lock:set-password', (_e, payload) => {
    const p = payload || {};
    const oldPwd = p.oldPassword || p.old || '';
    const newPwd = p.newPassword != null ? p.newPassword : (p.password != null ? p.password : p.pwd);
    const s = prefs.load();
    if (s.appPasswordHash) {
      const v = verify(oldPwd);
      if (!v.ok) return { ok: false, error: '当前密码不正确' };
    }
    if (newPwd === '' || newPwd == null) {
      prefs.save({ appPasswordHash: '', appPasswordSalt: '' });
      isLocked = false;
      try { win.closeLock(); } catch (_) {}
      return { ok: true, cleared: true };
    }
    const pwd = String(newPwd);
    if (pwd.length < 4) return { ok: false, error: '密码至少 4 位' };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(pwd, salt);
    prefs.save({ appPasswordHash: hash, appPasswordSalt: salt });
    logger.log('info', 'lock', 'password set');
    return { ok: true };
  });

  // 手动锁定（菜单 / 快捷键调用）
  ipcMain.handle('lock:lock-now', () => ({ ok: lock('manual') }));
}

module.exports = { register, lock, unlock, touch, startAutoLockWatcher, hasPassword, isLocked: () => isLocked };
