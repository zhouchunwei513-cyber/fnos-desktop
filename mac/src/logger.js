'use strict';
/**
 * 统一日志 —— 主进程与渲染进程共用（macOS 版重写）
 * 目录：~/Library/Logs/FNOS（由 index.js 通过 app.setAppLogsPath() 决定后 init）
 * 文件：fnos-YYYY-MM-DD.log，保留 RETAIN_DAYS 天
 */
const fs = require('fs');
const path = require('path');

const RETAIN_DAYS = 7;
const SECRET_KEYS = /password|token|secret|authorization|cookie|passwd/i;

let logDir = '';
let curDay = '';
let stream = null;

function pad(n) { return n < 10 ? '0' + n : String(n); }

function dayStr(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

function init(dir) {
  logDir = String(dir || '');
  if (!logDir) return;
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
  rotate();
  cleanup();
}

function rotate() {
  const d = dayStr();
  if (d === curDay && stream) return;
  curDay = d;
  try { if (stream) stream.end(); } catch (_) {}
  try {
    stream = fs.createWriteStream(path.join(logDir, 'fnos-' + d + '.log'), { flags: 'a' });
    stream.on('error', () => { try { stream = null; } catch (_) {} });
  } catch (_) { stream = null; }
}

function sanitize(v, depth) {
  const d = depth || 0;
  if (v == null) return v;
  if (d > 4) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => sanitize(x, d + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 40)) {
      o[k] = SECRET_KEYS.test(k) ? '***' : sanitize(v[k], d + 1);
    }
    return o;
  }
  if (typeof v === 'string' && v.length > 800) return v.slice(0, 800) + '…';
  return v;
}

function line(level, proc, module, msg, opts) {
  const o = opts || {};
  let s = '[' + new Date().toISOString() + '] [' + String(level || 'info').toUpperCase() + '] [' +
    proc + '] [' + (module || '-') + '] ' + String(msg == null ? '' : msg);
  if (o.params !== undefined) {
    try { s += ' ' + JSON.stringify(sanitize(o.params)); } catch (_) { s += ' [params unserializable]'; }
  }
  if (o.ret !== undefined) {
    try { s += ' ret=' + JSON.stringify(sanitize(o.ret)); } catch (_) {}
  }
  if (o.err) {
    const e = o.err;
    s += '\n  Error: ' + String((e && e.message) || e);
    if (e && e.stack) s += '\n' + String(e.stack).split('\n').slice(1, 8).join('\n');
  }
  return s;
}

function log(level, module, msg, opts) {
  try {
    const s = line(level, 'main', module, msg, opts);
    if (level === 'error') console.error(s); else if (level === 'warn') console.warn(s); else console.log(s);
    if (logDir) { rotate(); if (stream) stream.write(s + '\n'); }
  } catch (_) {}
}

/** 渲染进程用：把 console 与日志一起送到主进程写盘 */
function forRenderer(send) {
  return {
    log: function (level, module, msg, fields) {
      try {
        const fn = console[level] || console.log;
        fn('[FNOS] [' + level + '] [renderer] [' + module + '] ' + msg, (fields && fields.params) || '');
      } catch (_) {}
      try {
        send({
          level: level, module: module, msg: msg,
          params: fields && fields.params,
          err: fields && fields.err ? { message: String(fields.err.message || fields.err), stack: fields.err.stack } : undefined,
        });
      } catch (_) {}
    },
  };
}

/** 渲染进程送来的日志落盘 */
function fromRenderer(data) {
  try {
    const d = data || {};
    const s = line(d.level || 'info', 'renderer', d.module, d.msg, { params: d.params, err: d.err });
    if (logDir) { rotate(); if (stream) stream.write(s + '\n'); }
  } catch (_) {}
}

function list() {
  try {
    if (!logDir) return [];
    return fs.readdirSync(logDir)
      .filter((f) => /^fnos-.*\.log$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(logDir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) { return []; }
}

function read(name, maxBytes) {
  try {
    const safe = path.basename(String(name || ''));
    const p = path.join(logDir, safe);
    if (!p.startsWith(logDir)) return { ok: false, error: '非法路径' };
    const st = fs.statSync(p);
    const cap = Math.max(4096, Number(maxBytes) || 512 * 1024);
    const start = Math.max(0, st.size - cap);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(cap, st.size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { ok: true, name: safe, size: st.size, truncated: start > 0, text: buf.toString('utf8') };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function cleanup() {
  try {
    if (!logDir) return;
    const keep = RETAIN_DAYS * 86400000;
    const now = Date.now();
    for (const f of fs.readdirSync(logDir)) {
      if (!/^fnos-.*\.log$/.test(f)) continue;
      const p = path.join(logDir, f);
      try { if (now - fs.statSync(p).mtimeMs > keep) fs.unlinkSync(p); } catch (_) {}
    }
  } catch (_) {}
}

module.exports = {
  init, log, fromRenderer, forRenderer, list, read, cleanup, sanitize,
  dir: () => logDir,
};
