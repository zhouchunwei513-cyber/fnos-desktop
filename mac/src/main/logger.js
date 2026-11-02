'use strict';

/**
 * 日志：userData/logs/fnos-YYYY-MM-DD.log
 * macOS 规范：日志放 ~/Library/Logs/FNOS（由 index.js 传入 logsDir）
 * 单文件按天切割，保留 7 天。
 */

const fs = require('fs');
const path = require('path');

const RETAIN_DAYS = 7;
const MAX_BYTES_PER_DAY = 8 * 1024 * 1024;

let logsDir = '';
let day = '';
let stream = null;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function dayStamp(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

function sessionStamp(d) {
  const t = d || new Date();
  return dayStamp(t) + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) +
    '.' + String(t.getMilliseconds()).padStart(3, '0');
}

function ensureDir() {
  if (!logsDir) return false;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

function closeStream() {
  if (stream) {
    try { stream.end(); } catch (_) {}
    stream = null;
  }
}

function openStream() {
  const d = dayStamp();
  if (stream && d === day) return true;
  closeStream();
  if (!ensureDir()) return false;
  day = d;
  const file = path.join(logsDir, 'fnos-' + d + '.log');
  try {
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > MAX_BYTES_PER_DAY) {
      // 单日过大：滚动成 .1
      try { fs.renameSync(file, file + '.1'); } catch (_) {}
    }
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => { stream = null; });
    return true;
  } catch (_) {
    stream = null;
    return false;
  }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (_) { return '"[unserializable]"'; }
}

function write(level, scope, message, extra) {
  const line = sessionStamp() + ' [' + String(level).toUpperCase() + '] ' +
    (scope ? '[' + scope + '] ' : '') + String(message) +
    (extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : safeJson(extra))) + '\n';
  try {
    if (!openStream()) {
      process.stdout.write(line);
      return;
    }
    stream.write(line);
  } catch (_) {
    try { process.stdout.write(line); } catch (_) {}
  }
}

function info(scope, message, extra) { write('info', scope, message, extra); }
function warn(scope, message, extra) { write('warn', scope, message, extra); }
function error(scope, message, extra) { write('error', scope, message, extra); }

function cleanup() {
  if (!logsDir || !fs.existsSync(logsDir)) return;
  let names = [];
  try { names = fs.readdirSync(logsDir); } catch (_) { return; }
  const now = Date.now();
  for (const name of names) {
    if (!/^fnos-\d{4}-\d{2}-\d{2}\.log(\.\d)?$/.test(name)) continue;
    const full = path.join(logsDir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > RETAIN_DAYS * 24 * 3600 * 1000) fs.unlinkSync(full);
    } catch (_) {}
  }
}

function listFiles() {
  if (!logsDir || !fs.existsSync(logsDir)) return [];
  try {
    return fs.readdirSync(logsDir)
      .filter((n) => /^fnos-.*\.log(\.\d)?$/.test(n))
      .map((n) => {
        const full = path.join(logsDir, n);
        let size = 0;
        let mtime = 0;
        try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (_) {}
        return { name: n, size, mtime };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch (_) {
    return [];
  }
}

function readFile(name) {
  if (!logsDir) return '';
  const base = path.basename(String(name || ''));
  if (!/^fnos-.*\.log(\.\d)?$/.test(base)) return '';
  const full = path.join(logsDir, base);
  try {
    const st = fs.statSync(full);
    const max = 512 * 1024;
    if (st.size <= max) return fs.readFileSync(full, 'utf8');
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(max);
    fs.readSync(fd, buf, 0, max, st.size - max);
    fs.closeSync(fd);
    return '…（仅显示最后 512KB）\n' + buf.toString('utf8');
  } catch (_) {
    return '';
  }
}

function init(dir) {
  logsDir = dir;
  ensureDir();
  cleanup();
}

module.exports = {
  init,
  info,
  warn,
  error,
  log: write,
  cleanup,
  listFiles,
  readFile,
  getDir: () => logsDir,
  close: closeStream
};
