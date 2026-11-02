'use strict';

/**
 * 设置存储：~/Library/Application Support/FNOS/settings.json（app.getPath('userData')）
 * 写入采用 tmp + rename 原子替换，避免半截文件。
 * 首次启动按默认值落盘；读取时与默认值深合并（新增字段自动补齐）。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MATERIALS = ['under-window', 'sidebar', 'content', 'fullscreen-ui', 'none'];
const THEMES = ['system', 'light', 'dark'];

const DEFAULTS = {
  version: 1,
  servers: [],            // [{ url, name, lastUsedAt }]
  activeServer: '',       // url
  lastUrl: '',            // 上次停留的页面
  appearance: {
    theme: 'system',      // system | light | dark
    material: 'under-window', // macOS vibrancy 材质；none = 纯色不透明
    uiAlpha: 62,          // 界面透明度 0~100（0 = 实色，100 = 全透）
    toolbarHeight: 52,    // 工具栏高度（macOS 规范 52pt）
    accent: 'system'      // 强调色：system = 跟随系统
  },
  behavior: {
    launchAtLogin: false,
    hideOnClose: true,    // 关闭窗口时隐藏到 Dock（macOS 惯例）
    restoreLastUrl: true,
    confirmQuit: false,
    globalHotkey: ''      // 全局快捷键，形如 Command+Shift+F；空 = 不注册
  },
  window: { width: 1200, height: 800, x: null, y: null },
  zoom: 0,
  update: { lastCheckAt: 0, skipVersion: '' }
};

let cache = null;
let filePath = '';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (isPlainObject(pv) && isPlainObject(base[k])) out[k] = merge(base[k], pv);
    else if (pv !== undefined) out[k] = pv;
  }
  return out;
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function normalize(raw) {
  const s = merge(DEFAULTS, isPlainObject(raw) ? raw : {});
  if (!Array.isArray(s.servers)) s.servers = [];
  s.servers = s.servers
    .filter((x) => x && typeof x.url === 'string' && x.url)
    .map((x) => ({
      url: x.url,
      name: typeof x.name === 'string' && x.name ? x.name : x.url,
      lastUsedAt: Number(x.lastUsedAt) || 0
    }))
    .slice(0, 20);
  if (typeof s.activeServer !== 'string') s.activeServer = '';
  if (THEMES.indexOf(s.appearance.theme) < 0) s.appearance.theme = 'system';
  if (MATERIALS.indexOf(s.appearance.material) < 0) s.appearance.material = 'under-window';
  s.appearance.uiAlpha = Math.round(clamp(s.appearance.uiAlpha, 0, 100));
  s.appearance.toolbarHeight = Math.round(clamp(s.appearance.toolbarHeight, 40, 96));
  s.zoom = clamp(s.zoom, -3, 5);
  s.window.width = Math.round(clamp(s.window.width, 860, 6000));
  s.window.height = Math.round(clamp(s.window.height, 560, 4000));
  return s;
}

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'settings.json');
  return filePath;
}

function load() {
  if (cache) return cache;
  let raw = null;
  try {
    const p = file();
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    raw = null;
  }
  cache = normalize(raw);
  if (!raw) save();
  return cache;
}

function save() {
  const p = file();
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

function get() {
  return JSON.parse(JSON.stringify(load()));
}

function patch(part) {
  cache = normalize(merge(load(), isPlainObject(part) ? part : {}));
  save();
  return get();
}

function set(keyPath, value) {
  const parts = String(keyPath || '').split('.').filter(Boolean);
  if (!parts.length) return get();
  const next = JSON.parse(JSON.stringify(load()));
  let cur = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  cache = normalize(next);
  save();
  return get();
}

function upsertServer(url, name) {
  const s = load();
  const now = Date.now();
  const idx = s.servers.findIndex((x) => x.url === url);
  if (idx >= 0) {
    s.servers[idx].lastUsedAt = now;
    if (name) s.servers[idx].name = name;
  } else {
    s.servers.unshift({ url, name: name || url, lastUsedAt: now });
  }
  s.servers = s.servers.slice(0, 20);
  s.activeServer = url;
  cache = normalize(s);
  save();
  return get();
}

function removeServer(url) {
  const s = load();
  s.servers = s.servers.filter((x) => x.url !== url);
  if (s.activeServer === url) s.activeServer = s.servers.length ? s.servers[0].url : '';
  cache = normalize(s);
  save();
  return get();
}

function reset() {
  cache = normalize({});
  save();
  return get();
}

module.exports = {
  DEFAULTS,
  MATERIALS,
  THEMES,
  load,
  get,
  patch,
  set,
  save,
  reset,
  upsertServer,
  removeServer,
  getPath: file
};
