'use strict';
/**
 * 设置持久化（macOS 版）
 * 文件：~/Library/Application Support/FNOS/settings.json
 * 字段与 Windows 版同构，保证设置页零改动可用；平台无意义的字段照常落盘（不影响运行）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// 与 Windows 版保持同一份默认值（设置页零改动）；注册全局快捷键时把 Ctrl 映射为 Command
const DEFAULT_SHORTCUTS = { lockApp: 'Ctrl+Alt+L', hideAll: 'Ctrl+Alt+H' };

let cache = null;
let writeTimer = null;

function defaults() {
  return {
    server: '',
    origin: '',
    lastConnectHref: '',
    history: [],
    apps: [],
    currentPartition: 'persist:connect',
    closeAction: '',
    shortcutHideMode: 'tray',
    appPasswordHash: '',
    appPasswordSalt: '',
    shortcuts: Object.assign({}, DEFAULT_SHORTCUTS),
    urlMappings: [],
    autoHideMenuBar: false,
    bypassCors: true,
    themeColor: '#1e1b2e',
    // 标题栏（macOS 下映射到窗口外壳工具栏）
    titleBarOpacity: 96,
    titleBarFrostColor: '#ffffff',
    titleBarFrostAlpha: 10,
    titleBarSolidColor: '#101426',
    titleBarSolidAlpha: 100,
    titleBarDivider: true,
    titleBarColor: '#101426',
    titleBarMaterial: 'solid',
    titleBarBlur: 20,
    titleBarHighlight: 55,
    titleBarAutoHide: false,
    activeSkin: '',
    autoLockMinutes: 0,
    accounts: [],
    activeAccountOrigin: '',
    iptv: {
      iptvBaseUrl: '',
      iptvLine: 'inner',
      iptvFavorites: [],
      iptvEpgUrl: '',
      iptvCacheSeconds: 20,
    },
    disableGpu: false,
    mpv: {
      enabled: true,
      alwaysUse: false,
      hwDecode: 'auto',
      exePath: '',
      extraArgs: '',
      configMode: 'builtin',
      perfPreset: null,
      subStyle: { pos: null, size: null, scale: null },
      resume: true,
    },
    fpkApi: { enabled: false, host: '', port: 18080 },
    windowBounds: null,
    mpvAutoNext: true,
    // macOS 专属
    macVibrancy: 'under-window',
    hideAccountBall: false,
    ballPos: null,
    uiTransparent: false,
    uiTransparentAlpha: 38,
    barCorner: 'round',
    winCorner: 'round',
    globalHotkey: '',
    restoreLastUrl: true,
    hideOnClose: true,
  };
}

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** 递归深合并（数组整体替换，对象逐层合并） */
function deepMerge(base, patch) {
  if (!isObj(patch)) return patch;
  const out = Object.assign({}, isObj(base) ? base : {});
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    out[k] = isObj(pv) && isObj(out[k]) ? deepMerge(out[k], pv) : pv;
  }
  return out;
}

function normalize(raw) {
  const d = defaults();
  const s = isObj(raw) ? raw : {};
  const out = Object.assign({}, d, s);

  // 子对象深合并（缺键补默认，防旧版本配置缺字段）
  out.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, isObj(s.shortcuts) ? s.shortcuts : {});
  out.iptv = Object.assign({}, d.iptv, isObj(s.iptv) ? s.iptv : {});
  out.mpv = Object.assign({}, d.mpv, isObj(s.mpv) ? s.mpv : {});
  out.mpv.subStyle = Object.assign({ pos: null, size: null, scale: null },
    isObj(out.mpv.subStyle) ? out.mpv.subStyle : {});
  out.fpkApi = Object.assign({}, d.fpkApi, isObj(s.fpkApi) ? s.fpkApi : {});

  // v1.17.7：历史代理字段已废弃，读时清理
  if (out.iptv) {
    for (const k of ['enabled', 'prefetch', 'maxCacheSegments', 'maxCacheMB', 'matchHosts', 'defaultPlayer', 'proxyPort']) {
      delete out.iptv[k];
    }
  }

  out.history = Array.isArray(s.history) ? s.history.filter((x) => x && typeof x === 'object').slice(0, 30) : [];
  out.accounts = Array.isArray(s.accounts) ? s.accounts.filter((x) => x && typeof x === 'object').slice(0, 20) : [];
  out.apps = Array.isArray(s.apps) ? s.apps.filter((x) => x && typeof x === 'object').slice(0, 400) : [];
  out.urlMappings = Array.isArray(s.urlMappings)
    ? s.urlMappings.filter((r) => r && r.match && r.replace).slice(0, 80) : [];
  out.iptv.iptvFavorites = Array.isArray(out.iptv.iptvFavorites)
    ? out.iptv.iptvFavorites.filter((x) => typeof x === 'string').slice(0, 500) : [];

  if (!['under-window', 'sidebar', 'content', 'fullscreen-ui', 'none'].includes(out.macVibrancy)) {
    out.macVibrancy = 'under-window';
  }
  if (out.titleBarMaterial !== 'frosted' && out.titleBarMaterial !== 'solid') out.titleBarMaterial = 'solid';
  return out;
}

function load() {
  if (cache) return cache;
  try {
    const p = file();
    if (fs.existsSync(p)) {
      cache = normalize(JSON.parse(fs.readFileSync(p, 'utf8')));
    } else {
      cache = defaults();
    }
  } catch (_) {
    cache = defaults();
  }
  return cache;
}

function writeNow() {
  try {
    const p = file();
    const tmp = p + '.tmp';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (_) { return false; }
}

/** 同步写（关键路径用） */
function save(patch) {
  let s = load();
  if (isObj(patch)) s = deepMerge(s, patch);
  cache = normalize(s);
  writeNow();
  return cache;
}

/** 合并写（1.2s 去抖，用于拖动滑块等高频道写入） */
function saveDebounced(patch, ms) {
  let s = load();
  if (isObj(patch)) s = deepMerge(s, patch);
  cache = normalize(s);
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => { writeTimer = null; writeNow(); }, Math.max(120, Number(ms) || 1200));
  if (writeTimer.unref) writeTimer.unref();
  return cache;
}

function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  return writeNow();
}

// ---------------- 启动密码（scrypt，明文永不落盘） ----------------
function hasPassword() {
  const s = load();
  return !!(s.appPasswordHash && s.appPasswordSalt);
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), Buffer.from(String(salt), 'hex'), 32).toString('hex');
}

function setPassword(oldPw, newPw) {
  const s = load();
  if (hasPassword()) {
    const okHash = hashPassword(oldPw, s.appPasswordSalt);
    if (!crypto.timingSafeEqual(Buffer.from(okHash, 'hex'), Buffer.from(s.appPasswordHash, 'hex'))) {
      const e = new Error('原密码错误');
      e.code = 'BAD_OLD_PASSWORD';
      throw e;
    }
  }
  if (!newPw) {
    save({ appPasswordHash: '', appPasswordSalt: '' });
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  save({ appPasswordHash: hashPassword(newPw, salt), appPasswordSalt: salt });
}

function verifyPassword(pw) {
  const s = load();
  if (!hasPassword()) return true;
  try {
    const h = hashPassword(pw, s.appPasswordSalt);
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(s.appPasswordHash, 'hex'));
  } catch (_) { return false; }
}

// ---------------- UI 透明度（与 Windows 版公式一致） ----------------
function uiAlphaPct(s) {
  const src = s || load();
  if (src.uiTransparentAlpha != null && Number.isFinite(Number(src.uiTransparentAlpha))) {
    return Math.max(0, Math.min(100, Math.round(Number(src.uiTransparentAlpha))));
  }
  return src.uiTransparent ? 38 : 0;
}

function uiAlphaCss(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return Math.round((100 - p)) / 100;
}

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

module.exports = {
  DEFAULT_SHORTCUTS,
  defaults, load, save, saveDebounced, flush, file, normalize,
  hasPassword, setPassword, verifyPassword,
  uiAlphaPct, uiAlphaCss, clampInt,
};
