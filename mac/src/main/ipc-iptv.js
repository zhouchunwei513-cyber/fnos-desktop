'use strict';
/**
 * 电视直播（IPTV / XTE）—— macOS
 * Windows 版直播逻辑（XTE 基地址探测、M3U 解析、XMLTV EPG、回看地址、TS 录制、缓存与日志）
 * 在 macOS 上的移植；IPC 名称与返回结构保持一致。
 */
const { ipcMain, app, shell, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const prefs = require('./prefs');
const win = require('./win');
const logger = require('../logger');

const APP_VERSION = app.getVersion();

// 可选模块：MPV 渲染面与播放器（与 Windows 版同源，缺失时自动降级到 hls.js）
let MpvSurfaceMod = null;
let MpvPlayerMod = null;
try { MpvSurfaceMod = require('./mpv-surface'); } catch (_) { MpvSurfaceMod = null; }
try { MpvPlayerMod = require('./mpv-player'); } catch (_) { MpvPlayerMod = null; }
const XTE_DEFAULT_PORT = 34500;
const XTE_PORT_CANDIDATES = [XTE_DEFAULT_PORT, 5666, 8340, 8080, 80, 5000];
let g_cachedXteBase = '';
let g_cachedXteBaseAt = 0;
const XTE_CACHE_TTL_MS = 5 * 60 * 1000;

let mainWindow = null;
function setMainWindow(w) { mainWindow = w; }
function getMpvSettings() {
  const s = prefs.load();
  return (s && s.mpv) || {
    enabled: false, alwaysUse: false, hwDecode: 'auto', exePath: '', extraArgs: '',
    configMode: 'builtin', perfPreset: 'balanced',
    subStyle: { pos: 90, size: 32, scale: 100 }, resume: true,
  };
}
function broadcast(channel, payload) {
  try { win.sendToAll(channel, payload); } catch (_) {}
}
function currentOriginOf() {
  const s = prefs.load();
  if (s.origin) return String(s.origin);
  if (s.lastConnectHref) { try { return new URL(s.lastConnectHref).origin; } catch (_) {} }
  return '';
}

// 探测某 origin 上的 XTE 服务是否可用（通过 /health 端点），返回可用的完整 base
function probeXteBase(origin, timeoutMs) {
  return new Promise((resolve) => {
    try {
      let u;
      try { u = new URL(origin); } catch (_) { return resolve(null); }
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const req = lib.request(
        { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: '/health', method: 'GET', timeout: timeoutMs || 2500,
          headers: { 'User-Agent': 'FNOS-Desktop/' + APP_VERSION, 'Accept': '*/*' } },
        (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500 ? origin : null); }
      );
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    } catch (_) { resolve(null); }
  });
}

// 在指定 host 上依次尝试 XTE 端口候选，返回第一个可用的 http://host:port
async function discoverXteOnHost(hostname, preferHttps) {
  if (!hostname) return null;
  const schemes = preferHttps ? ['https', 'http'] : ['http', 'https'];
  for (const scheme of schemes) {
    for (const port of XTE_PORT_CANDIDATES) {
      const origin = `${scheme}://${hostname}:${port}`;
      // eslint-disable-next-line no-await-in-loop
      const ok = await probeXteBase(origin, 2000);
      if (ok) return origin;
    }
  }
  return null;
}

// 规范化直播基地址：自动补全 http:// 前缀，去除尾部斜杠与多余空白。
// 允许用户填 "192.168.1.10:34500" 这种省略协议头的形式。
function normalizeIptvBase(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let v = raw.trim();
  if (!v) return '';
  // 去除路径以外的尾部斜杠（保留 path 中的内部结构，但通常 XTE 基地址只到 origin）
  v = v.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  try {
    const u = new URL(v);
    // 只取 origin 部分，避免用户把路径一起粘进来导致拼接 /m3u/xxx 出错
    return u.origin;
  } catch (_) {
    return '';
  }
}

// 解析当前可用的 NAS 直播基地址与线路。
// v1.16.2 规则（严格按用户要求）：
//   1. 用户填写了「直播基地址」时，直接使用该地址（自动补 http://），
//      不再 fallback 到 5666 / currentOriginOf()，不做端口猜测。
//   2. 未填写时才回退到自动探测：在当前 NAS host 上依次尝试 34500 等候选端口。
//   3. 所有直播列表请求、流地址拼接统一使用这里返回的 base。
async function resolveIptvBaseAsync() {
  const s = prefs.load();
  const c = s.iptv || {};
  // 1) 用户显式配置了 iptvBaseUrl —— 强制使用，禁止回退
  const userBase = normalizeIptvBase(c.iptvBaseUrl);
  if (userBase) {
    g_cachedXteBase = userBase;
    g_cachedXteBaseAt = Date.now();
    return userBase;
  }
  // 2) 进程缓存命中
  if (g_cachedXteBase && Date.now() - g_cachedXteBaseAt < XTE_CACHE_TTL_MS) {
    return g_cachedXteBase;
  }
  // 3) 取最近连接的 NAS origin 作为探测起点
  let nasOrigin = '';
  if (currentOriginOf()) nasOrigin = currentOriginOf();
  else if ((prefs.load().lastConnectHref || '')) { try { nasOrigin = new URL((prefs.load().lastConnectHref || '')).origin; } catch (_) {} }
  else if (s.origin) nasOrigin = String(s.origin);
  if (!nasOrigin) return '';
  // 4) 直接在当前 host 上探测 34500 等候选端口（跳过 5666，飞牛 Web 端口不可能跑 XTE）
  try {
    const u = new URL(nasOrigin);
    const discovered = await discoverXteOnHost(u.hostname, u.protocol === 'https:');
    if (discovered) { g_cachedXteBase = discovered; g_cachedXteBaseAt = Date.now(); return discovered; }
  } catch (_) {}
  // 5) 全失败：兜底返回 nasOrigin，让上层报 404 并给出明确排查提示
  g_cachedXteBase = nasOrigin.replace(/\/+$/, '');
  g_cachedXteBaseAt = Date.now();
  return g_cachedXteBase;
}

// 同步版本：供 IPC / 同步上下文使用。v1.16.2：若用户配置了基地址，同步直出；
// 否则返回缓存（异步 resolveIptvBaseAsync 会在后台预热缓存）。
function resolveIptvBase() {
  const s = prefs.load();
  const c = s.iptv || {};
  const userBase = normalizeIptvBase(c.iptvBaseUrl);
  if (userBase) return userBase;
  if (g_cachedXteBase) return g_cachedXteBase;
  if (currentOriginOf()) return currentOriginOf().replace(/\/+$/, '');
  if ((prefs.load().lastConnectHref || '')) { try { return new URL((prefs.load().lastConnectHref || '')).origin; } catch (_) {} }
  if (s.origin) return String(s.origin).replace(/\/+$/, '');
  return '';
}

// 预热 XTE 基地址缓存（应用启动/连接服务器后调用，不阻塞 UI）
function warmupXteBase() {
  resolveIptvBaseAsync().then((base) => {
    if (base) console.log('[IPTV] XTE base warmed up:', base);
  }).catch(() => {});
}

// 拉取指定线路的 M3U（在主进程完成，避免渲染端 CORS）
// v1.16.1：使用异步 resolveIptvBaseAsync 自动探测 XTE 端口；404 给出明确排查提示
async function fetchIptvPlaylist(line) {
  const base = await resolveIptvBaseAsync();
  if (!base) throw new Error('未配置 NAS 地址，请先连接服务器或在设置中填写直播基地址');
  const which = ['inner', 'ipv6', 'frp', 'all'].includes(line) ? line : 'inner';
  const url = `${base}/m3u/${which}.m3u8`;
  const lib = url.startsWith('https:') ? require('https') : require('http');
  const body = await new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 FNOS-Desktop/' + APP_VERSION, 'Accept': '*/*' },
    }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        // 404 通常意味着 XTE.fpk 未安装/未启动，或端口不对
        reject(new Error(`HTTP 404：请检查 NAS 侧 XTE.fpk 是否已安装并启动（当前基地址 ${base}）。若 XTE 使用非默认端口，请在「设置 → 直播基地址」中填写完整地址（如 http://NAS_IP:34500）。`));
        return;
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; let n = 0;
      res.on('data', (d) => { n += d.length; if (n > 20 * 1024 * 1024) req.destroy(new Error('播放列表过大')); chunks.push(d); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('拉取播放列表超时（' + base + '），请检查网络或在设置中确认直播基地址')));
    req.on('error', (e) => reject(new Error('无法连接到直播服务（' + base + '）：' + (e && e.message ? e.message : e) + '。请确认 XTE.fpk 已启动且地址端口正确。')));
    req.end();
  });
  return { baseUrl: base, line: which, text: body };
}

function parseM3uChannels(text, baseUrl) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const channels = [];
  let cur = null;
  // v1.23.0：从 #EXTM3U 头提取 EPG 地址（x-tvg-url / url-tvg）
  let headerEpgUrl = '';
  // 去重：同频道（按 tvg-id 优先，其次按流 URL 的 pathname 去掉分片序号后再按 name）
  // 保留首次出现顺序，避免重复条目刷屏
  const seenKeys = new Set();

  // 提取 #EXTINF 之后的纯频道名。
  // 标准格式：#EXTINF:<duration> [key="value" ...],<频道名>
  // 部分上游格式不规范：属性与名称之间可能没有逗号、或名称里含多余空白。
  const extractName = (line) => {
    // 1) 优先取最后一个逗号之后的内容（标准写法）
    const commaIdx = line.lastIndexOf(',');
    if (commaIdx >= 0) {
      const tail = line.slice(commaIdx + 1).trim();
      if (tail) return tail;
    }
    // 2) 兜底：取所有 tvg-name="..." 的值
    const tvgNameM = /tvg-name="([^"]*)"/i.exec(line);
    if (tvgNameM && tvgNameM[1].trim()) return tvgNameM[1].trim();
    // 3) 再兜底：去掉时长、所有引号属性后剩下的文本
    let s = line.replace(/^#EXTINF:\s*-?\d*(\.\d+)?/, '');
    s = s.replace(/[A-Za-z0-9_-]+="[^"]*"/g, '').trim();
    return s || '未命名';
  };

  const attr = (line, key) => {
    const m = new RegExp(key + '="([^"]*)"', 'i').exec(line);
    return m ? m[1] : '';
  };

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      const epg = attr(line, 'x-tvg-url') || attr(line, 'url-tvg');
      if (epg) {
        headerEpgUrl = epg;
        if (!/^https?:\/\//i.test(headerEpgUrl)) {
          try { headerEpgUrl = new URL(headerEpgUrl, baseUrl).toString(); } catch (_) {}
        }
      }
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const name = extractName(line);
      const logoM = /tvg-logo="([^"]*)"/i.exec(line);
      const groupM = /group-title="([^"]*)"/i.exec(line);
      const idM = /tvg-id="([^"]*)"/i.exec(line);
      const shiftM = /tvg-shift="([^"]*)"/i.exec(line);
      // v1.23.10：飞牛网页直播地址为 http://NAS:5666/v/live/<64位hex>，
      // 与 XTE m3u8 的短 ID 不同。扫描 EXTINF 行所有属性，找出 64 位 hex 值作为飞牛直播 ID。
      let fnosLiveId = '';
      const valRe = /="([^"]*)"/g;
      let vm;
      while ((vm = valRe.exec(line)) !== null) {
        const v = vm[1] || '';
        if (/^[0-9a-f]{40,}$/i.test(v) && v.length >= 40) { fnosLiveId = v.toLowerCase(); break; }
      }
      cur = {
        name,
        logo: logoM ? logoM[1] : '',
        group: groupM ? groupM[1].trim() : '未分组',
        tvgId: idM ? idM[1] : '',
        // v1.23.0：EPG/回看元数据
        tvgName: attr(line, 'tvg-name'),
        tvgShift: shiftM ? shiftM[1] : '',
        catchup: attr(line, 'catchup'),
        catchupSource: attr(line, 'catchup-source'),
        catchupDays: attr(line, 'catchup-days'),
        fnosLiveId,
      };
    } else if (!line.startsWith('#')) {
      if (cur) {
        let streamUrl = line;
        if (!/^https?:\/\//i.test(streamUrl)) {
          try { streamUrl = new URL(streamUrl, baseUrl).toString(); } catch (_) {}
        }
        // 去重 key：优先 tvg-id，其次流路径（去掉 .ts 序号/查询），再其次频道名
        let key = '';
        try {
          const u = new URL(streamUrl);
          // 去掉形如 seg-12.ts / 12.ts 的分片序号，以及查询串
          const p = u.pathname.replace(/[-_]?\d+\.ts$/i, '.ts');
          key = (cur.tvgId ? 'id:' + cur.tvgId : 'path:' + u.host + p).toLowerCase();
        } catch (_) {
          key = (cur.tvgId ? 'id:' + cur.tvgId : 'name:' + cur.name).toLowerCase();
        }
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          channels.push({ ...cur, url: streamUrl });
        }
        cur = null;
      }
    }
  }
  channels._epgUrl = headerEpgUrl;
  return channels;
}

// v1.17.1：内置播放器把诊断日志写到主进程 fnos-diag.log
ipcMain.handle('diag:log', async (_e, line) => {
  try { diagLog('[LIVE] ' + String(line || '')); } catch (_) {}
  return true;
});

// v1.17.7：设置页 FPK 会话状态面板 —— 主进程代理拉取 /api/sessions，规避 CORS
ipcMain.handle('iptv:get-context', async () => {
  const s = prefs.load();
  const c = s.iptv || {};
  return {
    baseUrl: resolveIptvBase(),
    line: c.iptvLine || 'inner',
    favorites: Array.isArray(c.iptvFavorites) ? c.iptvFavorites : [],
    // v1.23.0：直播缓冲秒数（渲染端 hls.js 读取）
    cacheSeconds: Math.max(0, Math.min(120, parseInt(c.iptvCacheSeconds, 10) || 30)),
    // v1.17.7：本地代理已移除，这两个字段保留为固定值供旧 renderer 安全读取
    proxyBase: null,
    proxyListening: false,
    defaultPlayer: 'web',
  };
});

// v1.17.7：iptv:get-proxy-base-sync 历史上由 webview 内 hook 同步读取代理基地址，
// 代理移除后统一返回 null，保持 preload 调用不报错。
ipcMain.on('iptv:get-proxy-base-sync', (e) => {
  e.returnValue = null;
});

ipcMain.handle('iptv:fetch-playlist', async (_e, line) => {
  const { baseUrl, text } = await fetchIptvPlaylist(line);
  const chs = parseM3uChannels(text, baseUrl);
  const s = prefs.load();
  const userEpg = (s.iptv && s.iptv.iptvEpgUrl) || '';
  let epgUrl = userEpg || chs._epgUrl || '';
  if (epgUrl && !/^https?:\/\//i.test(epgUrl)) {
    try { epgUrl = new URL(epgUrl, baseUrl).toString(); } catch (_) {}
  }
  const channels = chs.map((c) => { const { _epgUrl, ...rest } = c; return rest; });
  return { baseUrl, channels, epgUrl };
});

ipcMain.handle('iptv:set-line', async (_e, line) => {
  const next = ['inner', 'ipv6', 'frp'].includes(line) ? line : 'inner';
  prefs.save({ iptv: { ...prefs.load().iptv, iptvLine: next } });
  return next;
});

// v1.16.1：按「内网 > IPv6 > FRP」顺序依次探测三条线路连通性。
// 判定标准：HTTP 200 + 响应内容包含 #EXTM3U；单条超时 3s；第一条可用即返回。
// 结果缓存 5 分钟（进程级），避免短时间重复探测。
let g_lineProbeCache = null; // { at, best, results, base }
const LINE_PROBE_TTL_MS = 5 * 60 * 1000;
const LINE_PROBE_TIMEOUT_MS = 3000;

ipcMain.handle('iptv:probe-lines', async (_e, opts) => {
  const force = !!(opts && opts.force);
  if (!force && g_lineProbeCache && Date.now() - g_lineProbeCache.at < LINE_PROBE_TTL_MS) {
    return g_lineProbeCache;
  }
  const base = await resolveIptvBaseAsync();
  const results = [];
  let best = null;
  if (base) {
    for (const line of ['inner', 'ipv6', 'frp']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await probeLineLatency(base, line);
      results.push(r);
      if (r.ok && !best) best = line; // 顺序探测，第一条可用即停止继续判断
    }
  } else {
    for (const line of ['inner', 'ipv6', 'frp']) {
      results.push({ line, ok: false, latencyMs: -1, error: '未配置 NAS 地址' });
    }
  }
  const out = { at: Date.now(), base, results, best };
  g_lineProbeCache = out;
  return out;
});

function probeLineLatency(base, line) {
  return new Promise((resolve) => {
    if (!base) return resolve({ line, ok: false, latencyMs: -1, error: 'no base' });
    const url = `${base}/m3u/${line}.m3u8`;
    const start = Date.now();
    let lib;
    try { lib = url.startsWith('https:') ? require('https') : require('http'); }
    catch (_) { return resolve({ line, ok: false, latencyMs: -1, error: 'bad url' }); }
    const req = lib.request(url, {
      method: 'GET', timeout: LINE_PROBE_TIMEOUT_MS,
      headers: { 'User-Agent': 'FNOS-Desktop/' + APP_VERSION, 'Accept': '*/*' },
    }, (res) => {
      const ms = Date.now() - start;
      const chunks = [];
      let n = 0;
      res.on('data', (d) => {
        n += d.length;
        if (n <= 4096) chunks.push(d); // 只需读开头判断 #EXTM3U
        if (n > 64 * 1024) try { req.destroy(); } catch (_) {}
      });
      res.on('end', () => {
        const head = Buffer.concat(chunks).toString('utf-8').trimStart();
        const ok = res.statusCode >= 200 && res.statusCode < 400 && head.startsWith('#EXTM3U');
        resolve({ line, ok, latencyMs: ms, error: ok ? null : (head.startsWith('#EXTM3U') ? 'HTTP ' + res.statusCode : '非 M3U 响应') });
      });
      res.on('error', (e) => resolve({ line, ok: false, latencyMs: ms, error: e && e.message }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ line, ok: false, latencyMs: -1, error: 'timeout' }); });
    req.on('error', (e) => resolve({ line, ok: false, latencyMs: -1, error: e && e.message }));
    req.end();
  });
}

ipcMain.handle('iptv:toggle-favorite', async (_e, name) => {
  const c = { ...prefs.load().iptv };
  const favs = new Set(Array.isArray(c.iptvFavorites) ? c.iptvFavorites : []);
  if (favs.has(name)) favs.delete(name); else favs.add(name);
  c.iptvFavorites = Array.from(favs);
  prefs.save({ iptv: c });
  return c.iptvFavorites;
});

// ================= v1.23.0：EPG 节目单 / 回看 / 录制 / 缓存 / 增强日志 =================

// ---------- 结构化日志（写入 userData/fnos-live.log，2MB 轮转保留 3 份） ----------
const LIVE_LOG_PATH = path.join(app.getPath('userData'), 'fnos-live.log');
function liveLog(level, event, data) {
  try {
    let line;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), level, event, data: data == null ? undefined : data }) + '\n';
    } catch (_) {
      line = JSON.stringify({ ts: new Date().toISOString(), level, event, data: String(data) }) + '\n';
    }
    fs.appendFileSync(LIVE_LOG_PATH, line);
    try {
      const st = fs.statSync(LIVE_LOG_PATH);
      if (st.size > 2 * 1024 * 1024) {
        for (let i = 2; i >= 1; i--) {
          const from = LIVE_LOG_PATH + '.' + i;
          const to = LIVE_LOG_PATH + '.' + (i + 1);
          if (fs.existsSync(from)) fs.renameSync(from, to);
        }
        fs.renameSync(LIVE_LOG_PATH, LIVE_LOG_PATH + '.1');
      }
    } catch (_) {}
  } catch (_) {}
}
ipcMain.handle('iptv:log', async (_e, level, event, data) => {
  liveLog(level || 'info', event || 'renderer', data);
  return true;
});

// ---------- 内存缓存（TTL 毫秒） ----------
const MEM_CACHE = new Map();
function cacheGet(key) {
  const hit = MEM_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { MEM_CACHE.delete(key); return null; }
  return hit.val;
}
function cacheSet(key, val, ttlMs) {
  MEM_CACHE.set(key, { val, exp: Date.now() + ttlMs });
}
function getIptvCacheDir() {
  const dir = path.join(app.getPath('userData'), 'iptv-cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// ---------- 通用 HTTP GET（超时/重试/重定向/大小上限），返回 Buffer ----------
function httpGetBuffer(url, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 20000;
  const maxBytes = opts.maxBytes || 60 * 1024 * 1024;
  const headers = opts.headers || {};
  const follow = opts.follow != null ? opts.follow : 5;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('非法 URL: ' + url)); }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(url, {
      method: 'GET', timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate',
        ...headers,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && follow > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpGetBuffer(next, { ...opts, follow: follow - 1 }));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const chunks = []; let n = 0;
      res.on('data', (d) => {
        n += d.length;
        if (n > maxBytes) { req.destroy(new Error('响应过大（>' + maxBytes + '）')); return; }
        chunks.push(d);
      });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip' || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
            buf = require('zlib').gunzipSync(buf);
          } else if (enc === 'deflate') {
            buf = require('zlib').inflateSync(buf);
          }
        } catch (e) { /* 返回原始 buffer */ }
        resolve(buf);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时: ' + url)));
    req.on('error', reject);
    req.end();
  });
}

// 拆分多个 EPG 地址（逗号/中文逗号/换行/分号分隔），去空白
function splitEpgUrls(raw) {
  return String(raw || '')
    .split(/[,，\n;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- XMLTV EPG 解析（无 XML 库，正则提取） ----------
function parseXmltvTime(s) {
  // 形如 20240101120000 +0800
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(s).trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, Se, tz] = m;
  let iso = `${Y}-${Mo}-${D}T${H}:${Mi}:${Se || '00'}`;
  if (tz) iso += tz.slice(0, 3) + ':' + tz.slice(3);
  else iso += 'Z';
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}
function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function parseXmltv(xml) {
  const text = String(xml || '');
  const channels = {}; // id -> {id, name, icon}
  const reCh = /<channel\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/gi;
  let m;
  while ((m = reCh.exec(text))) {
    const id = m[1];
    const body = m[2];
    const dn = /<display-name[^>]*>([\s\S]*?)<\/display-name>/i.exec(body);
    const ic = /<icon[^>]*src="([^"]*)"/i.exec(body);
    channels[id] = { id, name: decodeXmlEntities((dn && dn[1]) || '').trim(), icon: ic ? ic[1] : '' };
  }
  const programmes = [];
  const rePr = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  while ((m = rePr.exec(text))) {
    const attrs = m[1];
    const body = m[2];
    const ch = /\bchannel="([^"]*)"/i.exec(attrs);
    const st = /\bstart="([^"]*)"/i.exec(attrs);
    const sp = /\bstop="([^"]*)"/i.exec(attrs);
    const tt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
    const dd = /<desc[^>]*>([\s\S]*?)<\/desc>/i.exec(body);
    const start = parseXmltvTime(st && st[1]);
    const stop = parseXmltvTime(sp && sp[1]);
    if (!ch || !start || !stop) continue;
    programmes.push({
      channel: ch[1],
      start, stop,
      title: decodeXmlEntities((tt && tt[1]) || '').trim() || '未知节目',
      desc: decodeXmlEntities((dd && dd[1]) || '').trim(),
    });
  }
  for (const p of programmes) {
    p._channelName = (channels[p.channel] && channels[p.channel].name) || '';
  }
  // 按 start 排序
  programmes.sort((a, b) => a.start - b.start);
  return { channels, programmes };
}

// 拉取单个 EPG 地址并解析
async function fetchOneEpg(oneUrl) {
  const buf = await httpGetBuffer(oneUrl, { timeout: 25000, maxBytes: 150 * 1024 * 1024 });
  return parseXmltv(buf.toString('utf-8'));
}
function mergeEpg(target, src) {
  if (!src) return;
  if (src.channels) {
    for (const [id, ch] of Object.entries(src.channels)) {
      if (!target.channels[id]) target.channels[id] = ch;
    }
  }
  if (Array.isArray(src.programmes)) {
    for (const p of src.programmes) target.programmes.push(p);
  }
}

// 拉取并缓存 EPG（内存 + 磁盘 6 小时，支持多个逗号分隔地址）
let EPG_CACHE = null; // { urlKey, time, data }
async function fetchEpg(rawUrl) {
  const urls = splitEpgUrls(rawUrl);
  if (!urls.length) throw new Error('未配置 EPG 地址');
  const urlKey = urls.join('|');
  const now = Date.now();
  if (EPG_CACHE && EPG_CACHE.urlKey === urlKey && now - EPG_CACHE.time < 6 * 3600 * 1000) {
    return EPG_CACHE.data;
  }
  // 磁盘缓存
  const cacheFile = path.join(getIptvCacheDir(), 'epg.json');
  try {
    if (fs.existsSync(cacheFile) && !EPG_CACHE) {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (j && j.urlKey === urlKey && now - j.time < 6 * 3600 * 1000) {
        EPG_CACHE = j;
        return j.data;
      }
    }
  } catch (_) {}

  const merged = { channels: {}, programmes: [] };
  const errors = [];
  // 并行拉取所有 EPG 源，单个失败不影响其他源
  const results = await Promise.allSettled(urls.map((u) => fetchOneEpg(u)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      mergeEpg(merged, r.value);
    } else {
      errors.push(urls[i] + '：' + (r.reason && r.reason.message ? r.reason.message : r.reason));
    }
  });
  merged.programmes.sort((a, b) => a.start - b.start);
  if (!merged.programmes.length && errors.length) {
    throw new Error('所有 EPG 源均加载失败：' + errors.join('；'));
  }
  EPG_CACHE = { urlKey, time: now, data: merged, errors };
  try { fs.writeFileSync(cacheFile, JSON.stringify({ urlKey, time: now, data: merged })); } catch (_) {}
  if (errors.length) liveLog('warn', 'epg.partial', { errors });
  return merged;
}
ipcMain.handle('iptv:fetch-epg', async (_e, url) => {
  try {
    const target = url || (prefs.load().iptv && prefs.load().iptv.iptvEpgUrl) || '';
    liveLog('info', 'epg.fetch', { urls: splitEpgUrls(target) });
    const data = await fetchEpg(target);
    return { ok: true, count: data.programmes.length, programmes: data.programmes, channels: data.channels };
  } catch (e) {
    liveLog('error', 'epg.fetch', { error: e.message });
    return { ok: false, error: e.message, programmes: [], channels: {} };
  }
});

// ---------- 回看 URL 构造（catchup-source 模板） ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function buildCatchupUrl(ch, startMs, stopMs) {
  // ch: { url, catchup, catchupSource, catchupDays, ... }
  // 优先用频道自带 catchup-source；否则用默认 append 形式
  const start = new Date(startMs);
  const Y = start.getUTCFullYear();
  const m = pad2(start.getUTCMonth() + 1);
  const d = pad2(start.getUTCDate());
  const H = pad2(start.getUTCHours());
  const M = pad2(start.getUTCMinutes());
  const S = pad2(start.getUTCSeconds());
  const utc = `${Y}${m}${d}${H}${M}${S} Z`; // 常见 {utc} 形式 YYYYMMDDHHMMSS
  const lutc = Math.floor(startMs / 1000);
  const duration = Math.max(1, Math.round((stopMs - startMs) / 1000));
  let tpl = ch && ch.catchupSource;
  let base = ch && ch.url;
  if (!tpl) {
    // 默认 shift 模式：在流 URL 上追加 ?utc=...&lutc=...
    // v1.23.2：先清掉 base 上已有的 line 等参数（回看不需要 line=inner），避免重复拼接 utc/lutc
    if (base) {
      try {
        const u = new URL(base);
        u.search = '';
        base = u.toString();
      } catch (_) {}
    }
    const sep = base && base.includes('?') ? '&' : '?';
    tpl = base + sep + 'utc={utc}&lutc={lutc}';
    base = '';
  }
  let out = tpl
    .replace(/\{utc\}/gi, encodeURIComponent(utc))
    .replace(/\{lutc\}/gi, String(lutc))
    .replace(/\{start\}/gi, String(lutc))
    .replace(/\{end\}/gi, String(Math.floor(stopMs / 1000)))
    .replace(/\{duration\}/gi, String(duration))
    .replace(/\{Y\}/g, String(Y)).replace(/\{m\}/g, m).replace(/\{d\}/g, d)
    .replace(/\{H\}/g, H).replace(/\{M\}/g, M).replace(/\{S\}/g, S);
  return out;
}
ipcMain.handle('iptv:catchup-url', async (_e, ch, startMs, stopMs) => {
  try {
    const url = buildCatchupUrl(ch, startMs, stopMs);
    liveLog('info', 'catchup.build', { title: ch && ch.name, start: startMs, stop: stopMs, url });
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===================== v1.25.0：MPV 外部播放器 IPC =====================
// v1.25.0 起移除内嵌 libVLC 方案，改用参考客户端 fntv 的方式：
//   MPV（自带 ffmpeg 全编解码）以独立窗口播放，通吃 HEVC/10bit/4K/MKV/HLS。
// 内置电视直播仍走窗口内 hls.js（功能不变）；以下 vlc:* 通道保留为“不可用”存根，
// 使旧渲染层调用安全回退到 hls.js，不产生报错。
ipcMain.handle('vlc:status', async () => {
  try {
    const settings = getMpvSettings();
    return { available: false, reason: '', version: '', source: '', hwDecode: settings.hwDecode, enabled: false, mpv: true };
  } catch (_) { return { available: false, enabled: false }; }
});
ipcMain.handle('vlc:play', async () => ({ ok: false, fallback: true, reason: '内置直播使用 hls.js' }));
ipcMain.handle('vlc:rect', async () => ({ ok: true }));
ipcMain.handle('vlc:visible', async () => ({ ok: true }));
ipcMain.handle('vlc:control', async () => ({ ok: true }));
ipcMain.handle('vlc:set', async () => ({ ok: true }));
ipcMain.handle('vlc:destroy', async () => ({ ok: true }));

// ---- 从所有已知会话查找某 origin 的登录 Cookie（MPV 播放需鉴权）----
function gatherCookiesForOrigin(originUrl) {
  return new Promise((resolve) => {
    try {
      const u = new URL(originUrl);
      const candidates = [session.defaultSession];
      try { if (SHARED_PARTITION) candidates.push(session.fromPartition(SHARED_PARTITION)); } catch (_) {}
      // v2.17.54：补上"当前账号实际使用的分区"。v2.0.0 多账号后应用窗 cookie 存在
      // persist:nas-{hash}，此前候选里没有它，只能从 defaultSession 拿到 osrt，
      // 缺 ost / Trim-MC-token，media/range 于是被服务端当业务请求返回 JSON。
      try { if (currentPartition) candidates.push(session.fromPartition(currentPartition)); } catch (_) {}
      try { candidates.push(session.fromPartition('persist:connect')); } catch (_) {}
      try {
        const hst = prefs.load();
        (hst.history || []).forEach((h) => { if (h && h.partition) { try { candidates.push(session.fromPartition(h.partition)); } catch (_) {} } });
      } catch (_) {}
      // v2.17.54：再补所有存活 webContents 所属会话（应用窗/直播窗真正在用的分区，最权威）
      try {
        const allWc = require('electron').webContents.getAllWebContents();
        for (const wc of allWc) {
          try { const ses = wc && wc.session; if (ses && candidates.indexOf(ses) < 0) candidates.push(ses); } catch (_) {}
        }
      } catch (_) {}
      Promise.all(candidates.map((ses) => ses.cookies.get({ url: u.origin }).then((l) => l || []).catch(() => [])))
        .then((results) => {
          // v2.17.54：合并所有会话的 Cookie（同名以后出现的为准），不再"取第一个非空会话就返回"。
          // 旧逻辑只要 defaultSession 里有 osrt 就早退，把应用窗分区里的 ost / Trim-MC-token
          // 丢掉，MPV 仅带 osrt 请求 /v/api/v1/media/range/<guid> → 服务端 200 + application/json
          // （业务报错）→ mpv "Failed to recognize file format"，表现为"用 MPV 打开播不出画面"。
          const map = new Map();
          for (const list of results) {
            if (!list || !list.length) continue;
            for (const c of list) { if (c && c.name) map.set(c.name, c.value); }
          }
          if (!map.size) return resolve('');
          resolve(Array.from(map.entries()).map(([k, v]) => k + '=' + v).join('; '));
        }).catch(() => resolve(''));
    } catch (_) { resolve(''); }
  });
}

// v2.17.54：MPV 取流前探活——把 media/range 的真实状态码 / Content-Type / 首段 body 记进日志。
// 服务端回 200 + application/json 就说明鉴权或接口不对（mpv 侧只会报 Failed to recognize
// file format，看不到原因）。读到 300 字节即 abort，不影响正常取流与带宽。
function probeMediaRange(url, headers) {
  try {
    if (!url || !/^https?:/i.test(url)) return;
    const { net } = require('electron');
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    try {
      Object.keys(headers || {}).forEach((k) => { try { req.setHeader(k, String(headers[k])); } catch (_) {} });
    } catch (_) {}
    let done = false;
    const report = (status, type, buf) => {
      dlog('info', 'mpv.probe.range', { status: status, type: String(type || ''), head: String(buf || '').slice(0, 300).replace(/\s+/g, ' ') });
    };
    req.on('response', (res) => {
      let buf = '';
      const ctype = (res.headers && res.headers['content-type']) || '';
      res.on('data', (chunk) => {
        if (done) return;
        if (buf.length < 300) buf += chunk.slice(0, 300).toString('utf8');
        if (buf.length >= 300) { done = true; try { req.abort(); } catch (_) {} report(res.statusCode, ctype, buf); }
      });
      res.on('end', () => { if (!done) { done = true; report(res.statusCode, ctype, buf); } });
      res.on('error', () => {});
    });
    req.on('error', (e) => { if (!done) { done = true; dlog('warn', 'mpv.probe.err', { msg: String((e && e.message) || e) }); } });
    req.end();
  } catch (_) {}
}

// 用 MPV 播放媒体地址（自动注入飞牛登录 Cookie / Referer / UA）
// 记录上一次 VOD 播放的片名，用于直播场景识别 renderer 残留的旧片名
let __lastVodTitle = '';
async function playMediaWithMpv(mediaUrl, opts) {
  opts = opts || {};
  try {
    if (!MpvPlayerMod || !MpvSurfaceMod) return { ok: false, reason: 'MPV 模块未加载' };
    const st = getMpvSettings();
    if (!st.enabled) return { ok: false, reason: 'MPV 播放已在设置中关闭' };
    if (process.platform !== 'win32' && process.platform !== 'darwin') return { ok: false, reason: 'MPV 外部播放器仅支持 Windows/macOS' };
    const info = MpvPlayerMod.getMpvInfo();
    if (!info.available) {
      try { glassMessageBox(mainWindow, { type: 'warning', title: 'MPV 不可用', message: info.reason || '未找到内置 MPV 播放器', buttons: ['确定'] }); } catch (_) {}
      return { ok: false, reason: info.reason };
    }
    const url = String(mediaUrl || '');
    if (!/^https?:/i.test(url)) return { ok: false, reason: '仅支持网络播放地址' };
    const cookie = await gatherCookiesForOrigin(url);
    let referer = '';
    try { referer = new URL(url).origin + '/'; } catch (_) {}

    // v1.32.3：独立播放器也走【IPC 受控】的无边框窗口（standalone MpvSurface）。
    //   旧实现用 detached spawn 的外部 mpv（无 IPC、带系统标题栏），导致画中画/字幕/弹幕/倍速
    //   等中文菜单请求到本地 helper 时找不到受控播放器 → "画中画切换失败"、字幕/弹幕无结果。
    //   现在复用 MpvPlayer（IPC）+ MpvSurface(standalone)，菜单功能全部可用，窗口无边框、
    //   可移动/缩放/双击全屏、任务栏可见；画中画退出可还原窗口几何。
    const STANDALONE_KEY = '__standalone__';
    let surf = mpvSurfaces.get(STANDALONE_KEY);
    if (surf && !surf.isAlive()) { try { surf.destroy(); } catch (_) {} mpvSurfaces.delete(STANDALONE_KEY); surf = null; }
    if (!surf) {
      surf = new MpvSurfaceMod.MpvSurface(null, null, {
        standalone: true,
        settings: st,
        // v2.21.0：字幕样式回采（用户调过的字幕位置/字号写回设置，下次起播沿用）
        onSubStyle: saveMpvSubStyle,
        // v1.48.0：拖回吸附——返回当前飞牛主窗口内容区屏幕几何，独立播放器窗口拖入即自动贴合跟随。
        resolveDockTarget: () => {
          try {
            const host = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
              ? mainWindow
              : (appWindows.find(e => e.isHome && e.win && !e.win.isDestroyed() && e.win.isVisible() && !e.win.isMinimized()) || {}).win;
            if (!host) return null;
            const cb = host.getContentBounds();
            return { x: cb.x, y: cb.y, width: cb.width, height: cb.height };
          } catch (_) { return null; }
        }
      });
      mpvSurfaces.set(STANDALONE_KEY, surf);
      surf.player.on('log', msg => dlog('info', 'mpv.player.log', { msg: String(msg).slice(0, 400) }));
      const onExit = (code, _sig, userClosed) => {
        dlog('info', 'mpv.player.exit', { code, userClosed: !!userClosed, standalone: true });
        try { if (mpvSurfaces.get(STANDALONE_KEY) === surf) mpvSurfaces.delete(STANDALONE_KEY); } catch (_) {}
      };
      surf.player.on('exit', onExit);
      surf.player.on('user-closed', () => {
        try { dlog('info', 'mpv.player.userclosed', { standalone: true }); surf.destroy(); if (mpvSurfaces.get(STANDALONE_KEY) === surf) mpvSurfaces.delete(STANDALONE_KEY); } catch (_) {}
      });
    }

    const headers = {};
    if (cookie) headers['Cookie'] = cookie;
    if (referer) headers['Referer'] = referer;
    headers['User-Agent'] = getNasUA();

    const rawTitle = String(opts.title || '').trim();
    const isLive = !!opts.isLive;
    let finalTitle = rawTitle;
    if (isLive) {
      // 直播频道：renderer 可能残留上一部 VOD 片名，若与上次片名一致（或为空）则清空，
      // 交给 mpv 从直播流元数据（icy-title / #EXTINF）读取真实频道名，避免串台
      if (!rawTitle || rawTitle === __lastVodTitle) {
        finalTitle = '';
      }
    } else if (rawTitle) {
      __lastVodTitle = rawTitle;  // 记录 VOD 片名，供直播残留判断
    }

    // v2.22.0：独立窗口播放也走同一套进度记忆
    const pgKeyS = progressKeyFor(null, opts, null, url, finalTitle);
    const pgPosS = resumePosFor(pgKeyS, isLive);
    try { hookProgressMemory(surf, pgKeyS, finalTitle); } catch (_) {}
    if (pgPosS > 0) { try { armResumeNotice(surf, pgPosS); } catch (_) {} }

    try {
      await surf.play(url, headers, { isLive, title: finalTitle || '飞牛影视', hwDecode: st.hwDecode, resumePos: pgPosS > 0 ? pgPosS : undefined });
      try { liveLog('info', 'mpv.play', { ok: true, reason: '', isLive: !!opts.isLive, standalone: true }); } catch (_) {}
      return { ok: true };
    } catch (e) {
      const reason = String(e && e.message || e);
      try { liveLog('warn', 'mpv.play', { ok: false, reason, isLive: !!opts.isLive }); } catch (_) {}
      try { glassMessageBox(mainWindow, { type: 'error', title: 'MPV 播放失败', message: reason, buttons: ['确定'] }); } catch (_) {}
      return { ok: false, reason };
    }
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

ipcMain.handle('mpv:status', async () => {
  try {
    if (!MpvPlayerMod) return { available: false, reason: 'MPV 模块未加载', enabled: getMpvSettings().enabled };
    const st = getMpvSettings();
    const info = process.platform === 'win32' ? MpvPlayerMod.getMpvInfo() : { available: false, reason: '仅支持 Windows', version: '', source: '' };
    return Object.assign({}, info, { enabled: st.enabled, hwDecode: st.hwDecode });
  } catch (e) { return { available: false, reason: e.message }; }
});

// v2.20.0：网页 preload 读取 MPV 设置（决定是否"默认用 MPV 播放"，不等解码失败）
ipcMain.handle('mpv:get-settings', async () => {
  try { return getMpvSettings(); } catch (_) { return { enabled: true, alwaysUse: false, hwDecode: 'auto', cacheLevel: 'smooth' }; }
});

ipcMain.handle('mpv:play', async (_e, payload) => {
  const p = payload || {};
  if (!p.url) return { ok: false, reason: '缺少播放地址' };
  return playMediaWithMpv(p.url, { title: p.title, isLive: !!p.isLive, volume: p.volume });
});

// ---------- 应用内"视觉嵌入" MPV（mpv 原生无边框置顶窗口覆盖视频区，fntv 同款）----------
const mpvSurfaces = new Map(); // key(hostWinId) -> MpvSurface
try { global.__mpvSettings = getMpvSettings(); } catch (_) {}

// v1.63：嵌入 mpv 存活时，置顶 mpv 会挡住宿主顶部标题栏区域的鼠标事件，渲染进程的
// mouseenter/mousemove 有时收不到，导致"自动隐藏标题栏后打开 mpv，鼠标推到顶部调不出来"。
// 主进程用全局光标位置兜底：光标进入【聚焦宿主】的顶部标题栏带内 -> 通知强制显示标题栏；
// 离开 -> 通知恢复（由标题栏模块按自动隐藏设置决定是否淡出）。不依赖渲染进程是否收到鼠标事件。
let _titlebarForceShow = false; // 当前是否处于"顶部强制显示"
let _titlebarForceWin = null;   // 被强制显示标题栏的宿主窗口
function _broadcastTitlebarForce(hostWin, show) {
  try {
    hostWin.webContents.send('titlebar:force-show', { show: !!show });
    try {
      for (const wc of require('electron').webContents.getAllWebContents()) {
        try { if (hostWin && wc.hostWebContents === hostWin.webContents) wc.send('titlebar:force-show', { show: !!show }); } catch (_) {}
      }
    } catch (_) {}
  } catch (_) {}
}
function _clearTitlebarForce() {
  if (_titlebarForceWin && !_titlebarForceWin.isDestroyed()) { try { _broadcastTitlebarForce(_titlebarForceWin, false); } catch (_) {} }
  _titlebarForceWin = null;
  _titlebarForceShow = false;
}
setInterval(() => {
  try {
    let activeHost = null;
    let activeSurf = null;
    for (const [, surf] of mpvSurfaces) {
      try {
        if (!surf || surf._standalone || surf._dead || surf._pip) continue;
        const w = surf.parent;
        if (!w || w.isDestroyed() || w.isMinimized() || !w.isVisible()) continue;
        if (!surf.isAlive || !surf.isAlive()) continue;
        if (!w.isFocused()) continue; // 只处理当前聚焦窗口
        activeHost = w; activeSurf = surf; break;
      } catch (_) {}
    }
    if (!activeHost) { if (_titlebarForceShow) _clearTitlebarForce(); return; }
    const { screen } = require('electron');
    const pt = screen.getCursorScreenPoint();
    const cb = activeHost.getContentBounds();
    const inStrip = pt.x >= cb.x && pt.x <= cb.x + cb.width &&
                    pt.y >= cb.y && pt.y <= cb.y + __titlebarStrip;
    if (inStrip && !__mpvMenuOpening) {
      // 用户鼠标推到顶部标题栏带（正要去点最小化/最大化/关闭或拖动）：
      // 立即把嵌入 mpv 强制对齐到标题栏【下方】(y=34) 并置顶，确保顶部 34px 按钮区
      // 不被 mpv 原生窗盖住——即使 mpv 此前发生位置漂移，伸手点按钮这一刻也会被压回。
      try { if (activeSurf) { activeSurf._applyGeometry && activeSurf._applyGeometry(); activeSurf._raiseMpv && activeSurf._raiseMpv(); } } catch (_) {}
      if (!_titlebarForceShow) {
        _titlebarForceShow = true; _titlebarForceWin = activeHost; _broadcastTitlebarForce(activeHost, true);
      }
    } else if (!inStrip && _titlebarForceShow) {
      _clearTitlebarForce();
    }
  } catch (_) {}
}, 120);



// ---- 内置 MPV 本地助手（mpv-helper.js）需要的全局钩子 ----
// mpv 内中文右键菜单 lua 经 curl 调本地助手完成"在线字幕/本地字幕/画中画"。
// 助手需要：取当前活动 mpv（用于 sub-add 等命令）、切画中画、写诊断日志。
try {
  global.__mpvHelperLog = (level, event, data) => { try { dlog(level || 'info', event, data); } catch (_) {} };
  // 当前活动的播放层：优先非 PiP、最近使用的存活 surface
  global.__mpvHelperGetActivePlayer = () => {
    try {
      let best = null;
      for (const surf of mpvSurfaces.values()) {
        try { if (!surf || !surf.isAlive || !surf.isAlive()) continue; } catch (_) { continue; }
        if (!best) best = surf;
        else { try { if (!best.isPip || !best.isPip()) best = surf; } catch (_) {} }
      }
      return best && best.player ? best.player : null;
    } catch (_) { return null; }
  };
  global.__mpvHelperPip = false;
  global.__mpvHelperTogglePip = async () => {
    try {
      let target = null;
      for (const surf of mpvSurfaces.values()) {
        try { if (surf && surf.isAlive && surf.isAlive()) { target = surf; break; } } catch (_) {}
      }
      if (!target) return { ok: false, error: '播放器未运行', pip: false };
      const r = await target.togglePiP();
      global.__mpvHelperPip = !!(r && r.pip);
      dlog('info', 'mpv.pip', { pip: global.__mpvHelperPip });
      try { refreshMpvLayer(); } catch (_) {}
      return r;
    } catch (e) { return { ok: false, error: String(e && e.message || e), pip: false }; }
  };

  // 画中画：明确进入/退出/切换 + 尺寸调节（供 helper 调用）
  global.__mpvHelperSetPiP = async (mode, sizePx) => {
    try {
      let target = null;
      for (const surf of mpvSurfaces.values()) {
        try { if (surf && surf.isAlive && surf.isAlive()) { target = surf; break; } } catch (_) {}
      }
      if (!target) return { ok: false, error: '播放器未运行', pip: false };
      const r = await target.setPiP(mode || 'toggle', sizePx);
      global.__mpvHelperPip = !!(r && r.pip);
      dlog('info', 'mpv.pip', { mode: mode || 'toggle', size: sizePx, pip: global.__mpvHelperPip });
      try { refreshMpvLayer(); } catch (_) {}
      return r;
    } catch (e) { return { ok: false, error: String(e && e.message || e), pip: false }; }
  };

  // 给当前活动 mpv 发送任意命令（用于弹幕脚本消息等）
  global.__mpvHelperSendPlayerCommand = async (cmdArr) => {
    try {
      const player = global.__mpvHelperGetActivePlayer && global.__mpvHelperGetActivePlayer();
      if (!player || !player.command) return { ok: false, error: 'no player' };
      await player.command(cmdArr);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  };
} catch (_) {}

// 设置页 / 对话框等应用级子窗口激活时，mpv 是无边框置顶独立窗，会盖住这些窗口。
// 这里统一在"应用子弹窗打开"时把所有 mpv 降为非置顶，子弹窗全部关闭后恢复置顶。
// 另外：用户切到微信等【外部程序】时，宿主主窗口会失焦，此时也必须取消 mpv 置顶，
// 否则 --ontop=yes 的独立 mpv 窗会一直浮在所有窗口之上、盖住微信。回到飞牛主窗再恢复置顶。
let _mpvSuppressed = false;
const _mpvHostWins = new Set(); // 挂载了 mpv 的宿主主窗口（用于跟随其 blur/focus 切层级）

// 任一宿主主窗口当前是否处于前台（focused）。主窗失焦（切到外部 App）即视为应降层。
function _anyHostFocused() {
  try {
    for (const w of _mpvHostWins) {
      try { if (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused()) return w; } catch (_) {}
    }
    return null;
  } catch (_) { return null; }
}
// 给宿主主窗口挂 blur/focus 监听（仅挂一次），切换到外部程序/回到飞牛时自动调层级。
function attachMpvHostFocusTracking(hostWin) {
  try {
    if (!hostWin || hostWin.__mpvFocusTracked) return;
    hostWin.__mpvFocusTracked = true;
    _mpvHostWins.add(hostWin);
    const onChange = () => { try { refreshMpvLayer(); } catch (_) {} };
    hostWin.on('blur', onChange);
    hostWin.on('focus', onChange);
    hostWin.on('minimize', onChange);
    hostWin.on('restore', onChange);
    hostWin.on('closed', () => { try { _mpvHostWins.delete(hostWin); } catch (_) {} });
  } catch (_) {}
}
// 依据 on 置顶所有活着 MPV：为 true 时只置顶"当前聚焦宿主"对应的那个 MPV，
// 其余宿主的 MPV（非画中画）降层，避免多个窗口（飞牛影视/直播等各带 MPV）同时浮最上互相盖窗。
function setAllMpvOntop(on, focusedHostId) {
  try {
    // mpvSurfaces 以"宿主窗口数字 id (win.id)" 为键；focusedHostId 也须归一为数字 id。
    let hostKey = null;
    if (typeof focusedHostId === 'number') hostKey = focusedHostId;
    else if (typeof focusedHostId === 'string' && /^\d+$/.test(focusedHostId)) hostKey = Number(focusedHostId);
    if (on && !hostKey) {
      // 未显式给出聚焦宿主时，尝试现场探测当前聚焦宿主（窗口 id）。
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          if (!w || w.isDestroyed() || !w.isFocused()) continue;
          if (w.__isSettings || w.__isGlassDialog || w.__isCheckWin) continue;
          hostKey = w.id;
          break;
        } catch (_) {}
      }
    }
    for (const [hostId, surf] of mpvSurfaces.entries()) {
      try {
        if (!surf) continue;
        // 画中画小窗始终置顶（即便切到外部 App 也浮着），不降层。
        if (surf.isPip && surf.isPip()) { try { surf.setOntop && surf.setOntop(true); } catch (_) {} continue; }
        if (on) {
          // 置顶态：是否为本宿主（聚焦宿主）——非聚焦宿主的 MPV 一律降层
          const isSelf = hostKey ? (hostId === hostKey) : true;
          try { surf.setOntop && surf.setOntop(isSelf); } catch (_) {}
        } else {
          try { surf.setOntop && surf.setOntop(false); } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) {}
}
// 当前是否存在"活着"（已启动且未死亡）的 mpv 播放层。
// 用户关掉 mpv 后对应 surface 已销毁，此时宿主窗失焦与 mpv 无关，不应再做任何置顶跟随。
function _hasLiveMpvSurface() {
  try {
    for (const surf of mpvSurfaces.values()) {
      try { if (surf && surf.isAlive && surf.isAlive()) return true; } catch (_) {}
    }
    return false;
  } catch (_) { return false; }
}
// 外部失焦降层防抖句柄：只有宿主窗"持续失焦"超过阈值才取消 mpv 置顶，
// 避免瞬时焦点抢占（弹窗/菜单/网页控件/mpv 自有窗抢焦）让 ontop 在 true/false 间快速横跳。
let _mpvBlurLayerTimer = null;
function _clearMpvBlurLayerTimer() {
  if (_mpvBlurLayerTimer) { try { clearTimeout(_mpvBlurLayerTimer); } catch (_) {} _mpvBlurLayerTimer = null; }
}
// 遍历"应浮于 mpv 之上"的应用窗口（设置页/玻璃对话框/更新检查窗），返回是否存在且可见。
function _forEachBlockingWindow(cb) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w || w.isDestroyed() || !w.isVisible()) continue;
        if (w.__isSettings || w.__isGlassDialog || w.__isCheckWin) cb(w);
      } catch (_) {}
    }
  } catch (_) {}
}
function _blockingWindowsExist() {
  let found = false;
  _forEachBlockingWindow(() => { found = true; });
  return found;
}
// 依据当前是否存在"应浮于 mpv 之上"的应用窗口（设置页、对话框等），自动切换层级。
// 做法：有阻挡窗时——mpv 取消置顶(ontop=no) + 阻挡窗置顶(alwaysOnTop, screen-saver 级高于 mpv 的 ontop)；
//       无阻挡窗时——恢复 mpv 置顶、阻挡窗取消置顶。双向置顶确保设置页一定压得住 mpv。
//
// v1.28.7：
//  - 仅当存在"活着"的 mpv 播放层时才做"外部失焦跟随"；mpv 已关闭后宿主窗失焦与 mpv 无关，
//    不再反复判定（此前会无意义地刷 host-blurred/host-focused）。
//  - 外部失焦降层加防抖：宿主窗 blur 后需持续失焦 ~500ms 才真正 ontop=no；focus 立即恢复并取消。
//    避免弹窗/菜单/网页 video 控件/mpv 自有窗等"瞬时焦点抢占"让置顶态高频横跳（连带帧率抖动）。
function _applyMpvLayer(shouldSuppress, reason, focusedHostId) {
  _clearMpvBlurLayerTimer();
  _mpvSuppressed = shouldSuppress;
  if (!focusedHostId) {
    const fh = _anyHostFocused();
    if (fh && !fh.isDestroyed()) focusedHostId = fh.id;
  }
  // 恢复置顶时按"聚焦宿主"粒度：只置顶该宿主对应的 MPV，其余（非画中画）降层，
  // 避免并发打开飞牛影视+直播等多宿主各带 MPV 时相互抢置顶导致不能正常前置后置。
  setAllMpvOntop(!shouldSuppress, focusedHostId || undefined);
  _forEachBlockingWindow((w) => {
    try {
      if (shouldSuppress) {
        // v3.0.24（用户反馈「偏好设置页 / 下载进度条前置等级太高，按正常逻辑」）——
        // 不再给这类窗口设 screen-saver（Windows 上会压住本程序以外的所有窗口，
        // 连任务管理器都顶不起来）。这里 mpv 已经被 setAllMpvOntop(false) 降层，
        // 普通 z-order 足够让对话框浮在最上面；标了 __noTop 的窗口顺手清掉历史置顶。
        if (w.__noTop) {
          if (w.isAlwaysOnTop()) w.setAlwaysOnTop(false);
          // 非置顶也要浮在 mpv / 主窗之上：把窗口提到本程序 z-order 顶部即可
          try { w.moveTop(); } catch (_) {}
        } else if (!w.isAlwaysOnTop()) {
          w.setAlwaysOnTop(true, 'screen-saver');
        }
      } else {
        if (w.isAlwaysOnTop()) w.setAlwaysOnTop(false);
      }
    } catch (_) {}
  });
  dlog('info', 'mpv.layer', { ontop: !shouldSuppress, reason });
}
function refreshMpvLayer() {
  try {
    const hasBlocking = _blockingWindowsExist();

    // 1) 应用内阻挡窗（设置页/对话框）：立即降层，且保持阻挡窗置顶。这是最高优先级。
    if (hasBlocking) {
      if (!_mpvSuppressed) _applyMpvLayer(true, 'app-dialog-open');
      else {
        // 状态未变但仍有阻挡窗（如新弹窗替换旧弹窗）：确保它们处于置顶
        _forEachBlockingWindow((w) => {
          try {
            // v3.0.24：__noTop 窗口保持普通层级（只提到本程序 z-order 顶部，不做系统级置顶）
            if (w.__noTop) {
              if (w.isAlwaysOnTop()) w.setAlwaysOnTop(false);
              try { w.moveTop(); } catch (_) {}
            } else if (!w.isAlwaysOnTop()) w.setAlwaysOnTop(true, 'screen-saver');
          } catch (_) {}
        });
      }
      return;
    }

    // 2) 外部失焦跟随：仅在有"活着"的 mpv 播放层时才介入。
    const liveMpv = _hasLiveMpvSurface();
    if (!liveMpv) {
      // 没有活动 mpv：清掉失焦防抖，若处于降层态（此前误判）则恢复一次。
      _clearMpvBlurLayerTimer();
      if (_mpvSuppressed) _applyMpvLayer(false, 'no-live-mpv');
      return;
    }

    const hostFocused = _anyHostFocused();
    if (hostFocused) {
      // 回到前台：立即取消防抖并恢复置顶。
      _clearMpvBlurLayerTimer();
      if (_mpvSuppressed) _applyMpvLayer(false, 'host-focused');
    } else {
      // 宿主窗当前失焦：防抖后再降层，滤掉瞬时焦点抢占。
      if (!_mpvSuppressed && !_mpvBlurLayerTimer) {
        _mpvBlurLayerTimer = setTimeout(() => {
          _mpvBlurLayerTimer = null;
          // 防抖窗口结束后重新判定：仍无任何宿主窗在前台、也没有阻挡窗，才真正降层。
          if (!_blockingWindowsExist() && !_anyHostFocused()) {
            _applyMpvLayer(true, 'host-blurred-external');
          }
        }, 500);
        if (_mpvBlurLayerTimer.unref) _mpvBlurLayerTimer.unref();
      }
    }
  } catch (e) { dlog('warn', 'mpv.layer.err', { err: String(e && e.message || e) }); }
}

// 飞牛影视运行在 shell.html 内的 <webview>（guest）。<webview> 不是 BrowserView，
// getBrowserViews() 拿不到，必须在 app 级 web-contents-created 里按 type==='webview' 捕获。
// 可能同时存在多个窗口/guest，用 Map 记录，并跟踪最近活动与当前 URL，菜单触发时选最合适的目标。
const fnosGuests = new Map(); // guestWc.id -> { wc, url, at }
function rememberGuest(contents, url) {
  try {
    const rec = fnosGuests.get(contents.id) || { wc: contents, url: '', at: 0 };
    rec.wc = contents;
    if (typeof url === 'string' && url) rec.url = url;
    rec.at = Date.now();
    fnosGuests.set(contents.id, rec);
  } catch (_) {}
}
function pickMenuGuest() {
  try {
    const now = Date.now();
    let best = null;
    for (const rec of fnosGuests.values()) {
      const wc = rec.wc;
      if (!wc || wc.isDestroyed()) continue;
      // 正在播放页（/v/video|movie|tv|folder）的 guest 优先
      const onPlayPage = /\/v\/(video|movie|tv|folder|media)\//.test(rec.url || '');
      const score = (onPlayPage ? 1000000 : 0) - (now - rec.at);
      if (!best || score > best._score) best = { rec, _score: score };
    }
    return best ? best.rec.wc : null;
  } catch (_) { return null; }
}
try {
  app.on('web-contents-created', (_e, contents) => {
    try {
      // v3.0.27：任何窗口/webContents 加载完成都主动下发一次标题栏+皮肤配置。
      // preload 阶段那次 sendSync 在冷启动/部分窗口会拿不到皮肤（日志实证 109/121 次 skinDir 为空），
      // 主进程主动推送是唯一可靠路径 —— 主窗 / 设置页 / 帮助页 / 应用窗 / appview 一律覆盖。
      try {
        if (contents.getType() === 'window') {
          contents.on('did-finish-load', () => { try { __pushTitlebarTo(contents, 'loaded'); } catch (_) {} });
          [900, 3000].forEach((ms) => setTimeout(() => { try { __pushTitlebarTo(contents, 'late' + ms); } catch (_) {} }, ms));
        }
      } catch (_) {}
      // 记录 webview guest（用于 mpv 嵌入坐标测量）
      if (contents.getType() === 'webview') {
        rememberGuest(contents, contents.getURL ? contents.getURL() : '');
        dlog('info', 'mpv.guest.attached', { guestId: contents.id });
        contents.on('did-navigate', (_ev, url) => rememberGuest(contents, url));
        contents.on('did-navigate-in-page', (_ev, url) => rememberGuest(contents, url));
        contents.on('destroyed', () => { try { fnosGuests.delete(contents.id); } catch (_) {} });
      }
      // v1.54.0：【全局开窗兜底】对所有 webContents（webview guest、飞牛官方应用、
      // FNDESK 内置应用等）统一安装 setWindowOpenHandler。此前只拦了部分路径，导致
      // 文件管理等飞牛官方应用仍用 Electron 默认方式开窗（带系统原生标题栏、无注入）。
      // 主窗口 / createAppWindow / 直播窗 在自身创建后会再次 setWindowOpenHandler，
      // 后设置的会覆盖此兜底，故不影响它们的既有逻辑。
      try {
        contents.setWindowOpenHandler(({ url, frameName, features }) => {
          try {
            const u = String(url || '');
            // v3.0.4：程序内打开（guest window.open）也解析 fnos-anchor / fnos-embed-style，
            // 让 catchall 链路反推出 appId + 窗口形态，日志可与快捷方式 launch 链对齐对比。
            let __anchorIn = '';
            try { const __mIn = /fnos-anchor=([^,]+)/.exec(String(features || '')); if (__mIn) { try { __anchorIn = decodeURIComponent(__mIn[1]); } catch (_) { __anchorIn = __mIn[1]; } } } catch (_) {}
            const __embedIn = /fnos-embed-style/.test(String(features || ''));
            // DevTools / chrome 内部页交给默认处理
            if (/^(devtools|chrome-extension:|chrome:)/i.test(u)) {
              return { action: 'allow' };
            }
            // 统一的无边框 + preload 开窗覆盖项（所有由网页 window.open 弹出的窗口都走这个，
            // 彻底杜绝 Electron 默认带系统原生标题栏的窗口）
            const frameLessOverride = () => ({
              frame: process.platform === 'darwin', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
              backgroundColor: '#0b0d12',
              autoHideMenuBar: true,
              icon: ICON_PATH,
              title: APP_NAME,
              // 注意：这里【不能】设置 webPreferences.partition——window.open 弹窗继承调用方
              // 的 session，显式指定 partition 会抛 "partition can only be set on top-level windows"
              // 导致开窗失败；登录态由继承的 session 保证（webview/app 窗本身已用共享 partition）。
              webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true, webviewTag: true,
                nodeIntegration: false,
                sandbox: false, // v1.56：preload 需 require 本地 titlebar-inject
                webSecurity: true,
                allowRunningInsecureContent: true,
                backgroundThrottling: false,
                spellcheck: false,
                enableBlinkFeatures: 'CSSBackdropFilter',
              },
            });
            // 空 URL / about:blank / javascript：由自身脚本跳转，直接无边框放行（保留 opener）
            if (!u || /^(about:blank|javascript:)/i.test(u)) {
              dlog('info', 'appwin.open.aboutblank-frameless', { frameName: String(frameName || '').slice(0, 40) });
              return { action: 'allow', overrideBrowserWindowOptions: frameLessOverride() };
            }
            // 直播/电视直播流链接走原有直播唤起流程，放行（仍无边框）
            if (isIptvStreamUrl(u)) {
              return { action: 'allow', overrideBrowserWindowOptions: frameLessOverride() };
            }
            // v2.2.3：FNID 生态域识别——*.fnos.net（FN Connect 隧道域，如 dashuaibi888.fnos.net）
            // 与 fnos.net 检测页同属飞牛生态，点击后应在主窗口内导航（保持登录态），
            // 不应创建独立应用窗口。此前该域名被 preauth 判为 external-app 反复建窗，
            // 且服务端又 302 回检测页，形成窗口循环导致 FNID 登录后不跳转主页。
            if (/^https?:/i.test(u)) {
              try {
                const _u = new URL(u);
                const _h = String(_u.hostname || '').toLowerCase();
                if (_h === 'fnos.net' || _h.endsWith('.fnos.net')) {
                  setImmediate(() => {
                    try {
                      if (mainWindow && !mainWindow.isDestroyed()) {
                        dlog && dlog('info', 'appwin.open.fnos-domain-in-main', { url: u.slice(0, 140), from: 'catchall' });
                        mainWindow.webContents.loadURL(u);
                      }
                    } catch (_) {}
                  });
                  return { action: 'deny' };
                }
              } catch (_) {}
              // v2.4.7：流程期拦截已随复用窗方案移除——模拟点击后前端 window.open 应正常
              // 走 createAppWindow = 跳出窗（用户定案形态），拦截会破坏等价点击链路。
              // v3.0.4：程序内打开收口——反推 appId（fnos-anchor 优先，URL 反查兜底），
              // 带 source=in-app，让 popout.load / load.done 日志可与快捷方式 launch 链对比。
              const __appIdIn = (() => {
                try { if (__anchorIn) return String(__anchorIn).slice(0, 120); } catch (_) {}
                try { return String(fpkAppNameFromUrl(u) || '').slice(0, 120); } catch (_) {}
                return '';
              })();
              setImmediate(() => {
                try { createAppWindow(u, { partition: SHARED_PARTITION, title: APP_NAME, appId: __appIdIn, source: 'in-app' }); } catch (_) {}
              });
              dlog('info', 'appwin.open.catchall', { url: u.slice(0, 120), appId: __appIdIn, windowType: __embedIn ? 'embed' : 'popout', source: 'in-app' });
              return { action: 'deny' };
            }
            // mailto/tel/sms 等外部协议交给系统
            if (/^(mailto|tel|sms):/i.test(u)) {
              setImmediate(() => { try { shell.openExternal(u); } catch (_) {} });
              return { action: 'deny' };
            }
            // 其它一律无边框放行（兜底，避免出现系统原生标题栏）
            dlog('info', 'appwin.open.fallback-frameless', { url: u.slice(0, 80) });
            return { action: 'allow', overrideBrowserWindowOptions: frameLessOverride() };
          } catch (_) {
            return { action: 'deny' };
          }
        });
      } catch (_) {}
    } catch (_) {}
  });
} catch (_) {}

// 测量 <webview> 元素在【外壳内容区视口】中的边界（DIP）。
// shell.html 中 webview 为 absolute inset:0（铺满内容区），但可能存在自定义标题栏偏移。
// 返回 {x,y,width,height}；测量失败返回 null。
async function measureWebviewRect(hostWin) {
  try {
    if (hostWin && !hostWin.isDestroyed()) {
      const res = await hostWin.webContents.executeJavaScript(
        '(function(){try{' +
        'var w=document.querySelector("webview");' +
        'if(!w){return null;}' +
        'var r=w.getBoundingClientRect();' +
        'return {x:Math.round(r.left||0),y:Math.round(r.top||0),width:Math.round(r.width||0),height:Math.round(r.height||0)};' +
        '}catch(e){return null;}})()',
        true
      );
      if (res && typeof res.y === 'number' && res.width > 0) return res;
    }
  } catch (_) {}
  return null;
}

// 找到 guest webContents 对应的宿主外壳窗口
function hostWindowFromSender(sender) {
  try {
    const hostWc = (sender && sender.hostWebContents) ? sender.hostWebContents : sender;
    let win = BrowserWindow.fromWebContents(hostWc);
    if (!win && sender) win = BrowserWindow.fromWebContents(sender);
    if (win) return win;
  } catch (_) {}
  return mainWindow;
}

// guest 上报的视频区矩形（相对其视口 DIP）规范化
function normalizeDipRect(rect) {
  try {
    return {
      x: Math.max(0, Math.round(rect.x || 0)),
      y: Math.max(0, Math.round(rect.y || 0)),
      width: Math.max(160, Math.round(rect.width || 800)),
      height: Math.max(90, Math.round(rect.height || 450))
    };
  } catch (_) {
    return { x: 0, y: 0, width: 800, height: 450 };
  }
}

// 通知飞牛网页（guest）mpv 已关闭：恢复被隐藏的 <video>、重置接管状态
function notifyGuestMpvClosed(guestWc, byUser) {
  try {
    const wc = guestWc;
    if (wc && !wc.isDestroyed() && typeof wc.send === 'function') {
      // v2.24.7：带上 byUser——页面据此判定'用户主动关窗'，10 分钟内不再自动接管回来
      try { wc.send('mpv:embed-closed', { byUser: !!byUser }); } catch (_) {}
    }
  } catch (_) {}
  // v1.60：同时广播给全部 webContents，标题栏模块据此撤除标题栏下方的沉浸黑条
  try {
    for (const w of require('electron').webContents.getAllWebContents()) {
      try { if (!w.isDestroyed()) w.send('mpv:embed-state', { active: false }); } catch (_) {}
    }
  } catch (_) {}
}

// v1.60：嵌入激活时广播（标题栏模块据此在标题栏区域垫一条纯黑，保证自动隐藏后顶部与 mpv 黑边一致）
function broadcastMpvEmbedActive(hostWin) {
  try {
    const hostId = hostWin && !hostWin.isDestroyed() ? hostWin.id : -1;
    for (const w of require('electron').webContents.getAllWebContents()) {
      try {
        if (w.isDestroyed()) continue;
        const same = hostId === -1 || (() => { try { return BrowserWindow.fromWebContents(w) && BrowserWindow.fromWebContents(w).id === hostId; } catch (_) { return true; } })();
        w.send('mpv:embed-state', { active: true, hostId, same: !!same });
      } catch (_) {}
    }
  } catch (_) {}
}

// 点播断流恢复：让飞牛网页（preload）重新走 play/info → media/range 取一条新鲜签名地址。
// 返回 {url, headers, isLive} 供 mpv 续播；失败返回 null（mpv 侧会回放旧地址兜底）。
async function refreshVodStreamUrl(guestWc) {
  try {
    const wc = guestWc;
    if (!wc || wc.isDestroyed() || typeof wc.executeJavaScript !== 'function') return null;
    dlog('info', 'mpv.refresh.request', {});
    const fresh = await wc.executeJavaScript(
      'Promise.resolve(window.fnos && window.fnos.__refreshMpvMedia ? window.fnos.__refreshMpvMedia() : null)',
      true
    );
    if (fresh && fresh.url) {
      const headers = {};
      try {
        const origin = fresh.origin || '';
        const u = new URL(fresh.url);
        const oHost = origin ? new URL(origin).host : '';
        const sameOrigin = origin ? u.host === oHost : true;
        if (sameOrigin) {
          const ck = await gatherCookiesForOrigin(origin || fresh.url);
          if (ck) headers['Cookie'] = ck;
          // v2.15.95：media/range 点播取流只用 Cookie session 鉴权（与 embedMpvPlay 一致）。
          // preload 捕获的 Authorization 是飞牛网页登录 JWT（有时效），带过期 JWT 请求 media/range
          // 会命中 "Auth Failed"(code=-2) 返回 JSON，导致 mpv "Failed to recognize file format"、
          // 续播反复失败直至放弃。media/range 一律不带 Authorization，只用 Cookie。
          const isMediaRange = /\/v\/api\/v1\/media\/range\//i.test(fresh.url);
          if (fresh.token && !isMediaRange) headers['Authorization'] = String(fresh.token);
          if (fresh.playLink) headers['Play-Link'] = String(fresh.playLink);
          if (origin) headers['Referer'] = origin.replace(/\/?$/, '/');
        }
      } catch (_) {}
      headers['User-Agent'] = getNasUA();
      dlog('info', 'mpv.refresh.ok', { url: String(fresh.url).slice(0, 100), hasCookie: !!headers['Cookie'], isLive: !!fresh.isLive });
      return { url: fresh.url, headers, isLive: !!fresh.isLive };
    }
    dlog('warn', 'mpv.refresh.nourl', {});
    return null;
  } catch (e) {
    dlog('warn', 'mpv.refresh.err', { err: String(e && e.message || e) });
    return null;
  }
}

async function embedMpvPlay(hostWin, payload) {
  if ((process.platform !== 'win32' && process.platform !== 'darwin') || !MpvSurfaceMod || !MpvPlayerMod) {
    dlog('warn', 'mpv.embed.skip', { reason: 'platform-or-module', platform: process.platform, hasSurface: !!MpvSurfaceMod, hasPlayer: !!MpvPlayerMod });
    return { ok: false, reason: 'MPV 仅支持 Windows/macOS 且模块已加载' };
  }
  let exePath = MpvPlayerMod.getMpvExe();
  if (!exePath) {
    // v2.21.0：内置内核缺失但用户配了可用的自定义 mpv.exe → 仍然可以播放
    try {
      const want = String(getMpvSettings().exePath || '').trim();
      if (want && fs.existsSync(want)) exePath = want;
    } catch (_) {}
  }
  if (!exePath) {
    // mpv.exe 缺失（如 CI 未下载内置内核/打包遗漏）：明确记录，避免静默无任何日志
    dlog('warn', 'mpv.embed.skip', { reason: 'mpv.exe-missing', resourcesPath: process.resourcesPath || '' });
    return { ok: false, reason: '未找到内置 mpv.exe（内置内核缺失，请重新下载完整安装包）' };
  }
  const st = getMpvSettings();
  try { global.__mpvSettings = st; } catch (_) {}
  // v2.24.7（用户反馈 6：偏好设置里「默认启用 MPV 播放」开关不起作用，一直用 MPV）——
  // 旧逻辑是 alwaysUse 覆盖 enabled（两者任一为真就接管），等于开关点了没用。
  // 现在 enabled=false 一律拒绝接管（alwaysUse 只在 enabled=true 时决定"是否直接接管"）。
  if (st.enabled === false) {
    dlog('info', 'mpv.embed.skip', { reason: 'disabled-in-settings' });
    return { ok: false, reason: 'MPV 已在设置中关闭' };
  }

  let url = String(payload.url || '');
  if (!/^https?:/i.test(url)) {
    const wc = payload._sender;
    const ids = [];
    if (wc) { ids.push(wc.id); try { wc.hostWebContents && ids.push(wc.hostWebContents.id); } catch (_) {} }
    for (const id of ids) {
      const rec = lastMediaByWc.get(id);
      if (rec && rec.url && /^https?:/i.test(rec.url) && (Date.now() - rec.at) < 30 * 60 * 1000) { url = rec.url; break; }
    }
  }
  if (!/^https?:/i.test(url)) return { ok: false, reason: '未解析到可播放的视频直链' };

  // guest 上报的视频区坐标（相对其视口 DIP）
  const dipRect = normalizeDipRect(payload.rect || { x: 0, y: 0, width: 1280, height: 720 });
  // <webview> 在外壳内容区中的位置（DIP）。电影/直播统一用真实测量值；
  // webview 铺满内容区时为 {0,0}，有自定义标题栏时为其偏移。不再对 live 做 {0,0} 特判。
  const wvRect = await measureWebviewRect(hostWin);
  const viewOffset = wvRect ? { x: wvRect.x, y: wvRect.y } : { x: 0, y: 0 };

  dlog('info', 'mpv.embed.play', {
    host: hostWin.id, scope: payload.scope || 'fnos', isLive: !!payload.isLive,
    url: url.slice(0, 110), dipRect, viewOffset, hasToken: !!payload.token, origin: (payload.origin || '').slice(0, 60)
  });

  const hostId = hostWin.id;
  // 宿主主窗口前后台跟踪：切到微信等外部程序时 blur → 取消 mpv 置顶；回到飞牛 focus → 恢复置顶。
  try { attachMpvHostFocusTracking(hostWin); } catch (_) {}
  // guest（飞牛网页 webContents）：用于"点播断流时重新签名取新鲜地址"与"通知网页恢复显示"
  const guestWc = payload._sender || hostWin.webContents;
  let surf = mpvSurfaces.get(hostId);
  if (surf && !surf.isAlive()) { try { surf.destroy(); } catch (_) {} mpvSurfaces.delete(hostId); surf = null; }
  if (!surf) {
    // 点播断流（飞牛 media/range 签名链接约 10 分钟失效）时，让飞牛网页重新走 play/info→media/range
    // 取一条新鲜签名地址返回，mpv 用它续播（并续播到断点）。
    const onNeedFreshUrl = () => refreshVodStreamUrl(guestWc);
    surf = new MpvSurfaceMod.MpvSurface(hostWin, dipRect, {
      viewOffsetX: viewOffset.x, viewOffsetY: viewOffset.y,
      titlebarHeight: hostWin === mainWindow ? 36 : 34,
      settings: st,
      // v2.21.0：字幕样式回采（同上）
      onSubStyle: saveMpvSubStyle,
      onNeedFreshUrl
    });
    mpvSurfaces.set(hostId, surf);
    // v2.17.55：宿主若已处于全屏（以主进程状态机为准），创建时立即按全屏几何铺满，避免首帧错位
    try { surf.setHostState({ fs: (__isFsOn(hostWin) || hostWin.isFullScreen()) }); } catch (_) {}
    surf.player.on('log', msg => dlog('info', 'mpv.player.log', { msg: String(msg).slice(0, 400) }));
    surf.player.on('surface-log', msg => dlog('info', 'mpv.player.log', { msg: String(msg).slice(0, 400) }));
    // v2.20.0：控制条「上一集 / 下一集」→ 通知网页切集（网页切集后会重新走 embed 接管）
    // v2.24.6：MPV 右键菜单 / 「☰」菜单里的「自动播放下一集」开关（Lua 写 epnav=autonext:…）
    surf.player.on('autonext-toggle', () => {
      try {
        const next = !(getMpvSettings().autoNext !== false);
        saveMpvAutoNext(next);
        pushAutoNext(surf);
        dlog('info', 'mpv.autonext.toggle', { host: hostId, on: next });
        try { surf.player.command(['show-text', next ? '自动播放下一集：开' : '自动播放下一集：关', 2000]); } catch (_) {}
      } catch (err) { dlog('warn', 'mpv.autonext.toggle.err', { err: String(err && err.message || err) }); }
    });
    surf.player.on('epnav', (dir) => {
      try {
        const d = dir === 'prev' ? 'prev' : 'next';
        dlog('info', 'mpv.epnav.cmd', { host: hostId, dir: d });
        guestWc.send('mpv:episode-nav', { dir: d, auto: false });
      } catch (err) { dlog('warn', 'mpv.epnav.cmd.err', { err: String(err && err.message || err) }); }
    });
    // v2.20.1：MPV 菜单「选集 ▸」选中某一集 → 通知网页跳到该 item guid
    surf.player.on('epnav-go', (g) => {
      try {
        const gg = String(g || '');
        if (!gg) return;
        dlog('info', 'mpv.epnav.go', { host: hostId, guid: gg });
        guestWc.send('mpv:episode-goto', { guid: gg });
      } catch (err) { dlog('warn', 'mpv.epnav.go.err', { err: String(err && err.message || err) }); }
    });
    // v2.20.0：正常播完（eof）且网页报告还有下一集 → 自动连播
    // v2.24.13（用户反馈：菜单开「自动播放下一集」不生效）——
    // 根因：mpv 带 --keep-open=yes 播完不发 end-file(reason=eof)，只在随后切集/卸载时
    // 以 reason=stop 发；用户机日志实测 379 次 end-file 全是 stop/error/quit、eof 为 0 次，
    // 所以原来 if(reason==='eof') 的连播分支永远不成立。改由 player 的 natural-eof
    // （eof-reached 属性且非提前断流）触发，end-file(eof) 保留兼容，二者 3s 内去重。
    let __autoNextAt = 0;
    const __tryAutoNext = (src) => {
      try {
        if (!surf.__hasNext) { dlog('info', 'mpv.epnav.autonext.skip', { host: hostId, src, why: 'no-next' }); return; }
        if (getMpvSettings().autoNext === false) { dlog('info', 'mpv.epnav.autonext.skip', { host: hostId, src, why: 'off' }); return; }
        if (Date.now() - __autoNextAt < 3000) { dlog('info', 'mpv.epnav.autonext.dedup', { host: hostId, src }); return; }
        __autoNextAt = Date.now();
        dlog('info', 'mpv.epnav.autonext', { host: hostId, src });
        guestWc.send('mpv:episode-nav', { dir: 'next', auto: true });
      } catch (err) { dlog('warn', 'mpv.epnav.autonext.err', { err: String(err && err.message || err) }); }
    };
    surf.player.on('natural-eof', () => {
      dlog('info', 'mpv.player.natural-eof', { host: hostId });
      __tryAutoNext('eof-reached');
    });
    surf.player.on('end-file', reason => {
      dlog('info', 'mpv.player.end', { reason: String(reason) });
      if (String(reason) === 'eof') __tryAutoNext('end-file');
    });
    // exit 第三参 userClosed：true=用户点 mpv 窗口 X（正常关闭），false=进程崩溃
    surf.player.on('exit', (code, _sig, userClosed) => {
      dlog('info', 'mpv.player.exit', { code, userClosed: !!userClosed });
      if (userClosed) {
        // 用户主动关闭 mpv：回收嵌入层、通知网页恢复 <video>，避免 mpv 被崩溃自愈重启。
        try {
          if (!surf.isAlive()) { surf.destroy && surf.destroy(); }
          if (mpvSurfaces.get(hostId) === surf) mpvSurfaces.delete(hostId);
          notifyGuestMpvClosed(guestWc, true);
        } catch (_) {}
      }
    });
    // 用户点 mpv 窗口 X（end-file reason=quit）：立即回收 + 通知网页
    surf.player.on('user-closed', () => {
      try {
        dlog('info', 'mpv.player.userclosed', { host: hostId });
        surf.destroy();
        if (mpvSurfaces.get(hostId) === surf) mpvSurfaces.delete(hostId);
        notifyGuestMpvClosed(guestWc, true);
      } catch (_) {}
    });
  } else {
    surf.setRect(dipRect, viewOffset);
  }

  // v2.20.2：surface 建好后立刻补一次剧集 user-data，并在 IPC 就绪/新文件加载完成后重放。
  //（mpv 进程启动前写入会被丢弃；mpv 重启后 user-data 清空，必须重放才能点亮按钮/菜单项）
  try {
    epUdApply(hostId, surf, true);
    if (!surf.__epUdHooked) {
      surf.__epUdHooked = true;
      surf.player.on('ipc-ready', () => { try { epUdApply(hostId, surf, true); } catch (_) {} });
      surf.player.on('loaded', () => { try { epUdApply(hostId, surf, true); } catch (_) {} });
    }
  } catch (_) {}

  // 鉴权头：Cookie（session 自动取）+ Authorization（preload 捕获）+ Referer + UA
  const headers = {};
  const origin = payload.origin || '';
  // 判断流是否与 NAS 同源；跨域的第三方直连源（如运营商 IPTV：chinamobile.com / IPv6 直连地址）
  // 不应携带 NAS 的 Referer/Cookie/Auth 头，否则可能被源站拒绝或触发异常。
  let sameOrigin = false;
  try {
    const uHost = new URL(url).host;
    const oHost = origin ? new URL(origin).host : '';
    sameOrigin = !!oHost && uHost === oHost;
  } catch (_) { sameOrigin = !/^https?:\/\//i.test(url) ? true : false; }
  if (sameOrigin) {
    try {
      const ck = await gatherCookiesForOrigin(origin || url);
      if (ck) headers['Cookie'] = ck;
    } catch (e) { dlog('warn', 'mpv.embed.cookie', { err: String(e && e.message || e) }); }
    // v2.15.88：media/range 点播取流走 Cookie session 鉴权；preload 捕获的 Authorization 是
    // 飞牛网页登录 JWT（有时效），一旦过期，带它请求 media/range 会命中 "Auth Failed"(code=-2) 返回
    // JSON，导致 mpv/ffmpeg "Failed to recognize file format"。点播 media/range 一律不带 Authorization，
    // 只用 Cookie（实测带 Cookie 返回 206 MP4 流正常）；跨域直播/直连源不受影响（本就在 sameOrigin 分支外）。
    const isMediaRange = /\/v\/api\/v1\/media\/range\//i.test(url);
    if (payload.token && !isMediaRange) headers['Authorization'] = payload.token;
    // 飞牛影视网页内直播：/wp/m3u8 转码网关要求 Play-Link 头（hls.js/flv.js 原样携带），否则 401/403
    if (payload.playLink) headers['Play-Link'] = String(payload.playLink);
    if (origin) headers['Referer'] = origin.replace(/\/?$/, '/');
  }
  headers['User-Agent'] = getNasUA();

  // v2.22.0：本地续播——按 item guid 记位置，下次打开同一集自动接上
  const pgIsLive = !!payload.isLive || payload.scope === 'live';
  const pgTitle = payload.title || '';
  const pgKey = progressKeyFor(hostId, payload, guestWc, url, pgTitle);
  const pgLocalPos = resumePosFor(pgKey, pgIsLive);
  // v2.23.0：与飞牛网页端观看记录互通——payload.serverTs 是网页端"继续观看"记住的位置，
  // 与本机记录取较新者；前 30s 与"看到 95% 以上"的规则与网页端/本机一致。
  const pgSync = getMpvSettings().resume !== false;
  const pgSrvTs = Math.floor(Number(payload.serverTs) || 0);
  const pgSrvDur = Math.floor(Number(payload.serverDur) || 0);
  const pgSrvOk = pgSync && !pgIsLive && pgSrvTs > 30 && !(pgSrvDur > 0 && pgSrvTs > pgSrvDur * 0.95);
  const pgPos = Math.max(pgLocalPos, pgSrvOk ? pgSrvTs : 0);
  const pgRemote = (pgSync && !pgIsLive && payload.itemGuid) ? {
    wc: guestWc,
    itemGuid: String(payload.itemGuid),
    mediaGuid: String(payload.mediaGuid || ''),
    videoGuid: String(payload.videoGuid || ''),
    audioGuid: String(payload.audioGuid || ''),
    playLink: String(payload.playLink || ''),
    dur: pgSrvDur,
  } : null;
  try { hookProgressMemory(surf, pgKey, pgTitle, pgRemote); } catch (_) {}
  if (pgPos > 0) { try { armResumeNotice(surf, pgPos); } catch (_) {} }

  try {
    await surf.play(url, headers, { isLive: pgIsLive, title: pgTitle, resumePos: pgPos > 0 ? pgPos : undefined });
    dlog('info', 'mpv.embed.ok', { host: hostId, hasCookie: !!headers['Cookie'], hasAuth: !!headers['Authorization'], isLive: !!payload.isLive || payload.scope === 'live',
      // v2.17.54：只记 Cookie 名字（不记值），便于排查"缺 ost/Trim-MC-token"这类鉴权不全问题
      cookieNames: String(headers['Cookie'] || '').split('; ').map((s) => String(s).split('=')[0]).filter(Boolean).join(',') });
    // v2.17.54：播放前探一次真实响应，日志按需定位（见 probeMediaRange 注释）
    try { probeMediaRange(payload.url, headers); } catch (_) {}
    try { broadcastMpvEmbedActive(hostWin); } catch (_) {}
    return { ok: true };
  } catch (err) {
    dlog('warn', 'mpv.embed.fail', { err: String(err && err.message || err) });
    return { ok: false, reason: String(err && err.message || err) };
  }
}

// 片名异步就绪后实时更新：把真实片名推给当前存活的 MPV 播放器
// （解决 MKV 首次打开时 playinfo 尚未返回、标题栏/状态栏先显示"飞牛影视"的问题）
ipcMain.handle('mpv:update-title', async (e, args) => {
  try {
    const title = args && args.title ? String(args.title).trim() : '';
    if (!title) return { ok: false };
    // 只更新"发起该播放请求的宿主窗口"对应的播放器，避免点播片名被广播到直播/其他独立窗口。
    const senderWin = hostWindowFromSender(e && e.sender) || mainWindow;
    let applied = 0;
    for (const [key, surf] of mpvSurfaces.entries()) {
      try {
        if (!surf || !surf.isAlive || !surf.isAlive() || !surf.player || !surf.player.setMediaTitle) continue;
        // 直播流不接受点播片名（直播窗口标题应是频道名，且直播无 force-media-title 时显频道/URL）
        if (surf.player._isLive) { dlog('info', 'mpv.title.skip-live', { title, key: String(key) }); continue; }
        // 只作用于同一宿主窗口的 surface（独立窗 standalone 与嵌入窗分属不同宿主）
        if (surf.parent && senderWin && surf.parent !== senderWin) {
          dlog('info', 'mpv.title.skip-other-window', { title }); continue;
        }
        await surf.player.setMediaTitle(title);
        applied++;
      } catch (_) {}
    }
    dlog('info', 'mpv.title.update', { title, applied });
    return { ok: applied > 0, applied };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('mpv:embed', async (e, payload) => {
  try {
    const p = payload || {};
    p._sender = e && e.sender;
    const hostWin = hostWindowFromSender(e && e.sender) || mainWindow;
    dlog('info', 'mpv.embed.invoke', { from: (e && e.sender && e.sender.getType()) || 'unknown', scope: p.scope, hasUrl: !!p.url });
    // v2.15.2：mpv 内核启动失败/IPC 未就绪时 embedMpvPlay 可能永久 pending → ipcMain.handle 的 reply 永不返回
    // （渲染进程 invoke 永久等待，报 "reply was never sent"→"打开失败"）。加 20s 超时兜底必回结果。
    return await Promise.race([
      embedMpvPlay(hostWin, p),
      new Promise(res => setTimeout(() => res({ ok: false, reason: 'MPV 启动超时（内核未就绪，请检查内置 mpv）' }), 20000)),
    ]);
  } catch (err) { dlog('warn', 'mpv.embed.invoke.error', { err: String(err && err.message || err) }); return { ok: false, reason: err.message }; }
});

// guest 持续上报视频区坐标（窗口缩放/网页滚动时跟随）
ipcMain.on('mpv:embed-rect', (e, rect) => {
  try {
    const hostWin = hostWindowFromSender(e && e.sender) || mainWindow;
    const surf = mpvSurfaces.get(hostWin.id);
    if (surf && rect) {
      // v2.24.5：记住上报方（guest webContents），过渡期要给页面发"密集上报"指令
      try { surf._guestWc = e.sender; } catch (_) {}
      // 只更新视频区坐标（相对 webview 视口），viewOffset（webview 在外壳内的偏移）保持 embed 时的测量值
      surf.setRect(normalizeDipRect(rect), null);
    }
  } catch (_) {}
});

// v2.20.0：网页上报剧集导航能力（是否有上一集/下一集），主进程写入 mpv user-data，
// 中文控制条/菜单据此点亮上一集、下一集（单文件播放时 playlist-count==1，原生恒灰）。
// v2.20.2 修复「一开始能亮、切集后永久变灰/菜单项消失」的两个真因：
//   1) mpv 进程尚未连上 IPC 时 command() 直接 reject（静默丢弃），而旧的"仅变化时写"去重
//      让后续永远不会补写 → 新一集 mpv 里 user-data 一直是空；
//   2) 能力上报早于 mpv 表面创建时被整体丢弃，没有任何缓存可复用。
// 现在改为「按 host 记住期望值 + IPC 就绪/加载完成后重放」，任何时刻写都能落到活进程。
const epUdByHost = new Map(); // hostId -> { prev:'yes'|'no', next:'yes'|'no', list, cur }

function epUdPush(surf, key, val) {
  try {
    const p = surf && surf.player;
    if (!p) return;
    const doWrite = () => { try { p.command(['set', 'user-data/fnos/' + key, val]); } catch (_) {} };
    if (!p.connected) { try { p.once('ipc-ready', doWrite); } catch (_) {} return; }
    doWrite();
  } catch (_) {}
}

function epUdApply(hostId, surf, force) {
  try {
    const d = epUdByHost.get(hostId);
    const p = surf && surf.player;
    if (!d || !p) return;
    // 兼容既有逻辑：eof 自动连播读 surf.__hasNext
    surf.__hasPrev = d.prev === 'yes';
    surf.__hasNext = d.next === 'yes';
    const w = (field, key) => {
      const slot = '__ud_' + field;
      if (force || surf[slot] !== d[field]) { surf[slot] = d[field]; epUdPush(surf, key, d[field]); }
    };
    w('prev', 'ep-prev');
    w('next', 'ep-next');
    w('list', 'ep-list');
    w('cur', 'ep-cur');
    try { pushAutoNext(surf); } catch (_) {}
  } catch (_) {}
}

ipcMain.on('mpv:episode-ability', (e, info) => {
  try {
    const hostWin = hostWindowFromSender(e && e.sender) || mainWindow;
    if (!hostWin) return;
    const hostId = hostWin.id;
    const hasPrev = !!(info && info.hasPrev);
    const hasNext = !!(info && info.hasNext);
    let epsJson = '';
    try {
      const eps = Array.isArray(info && info.episodes) ? info.episodes : [];
      epsJson = eps.length > 1 ? JSON.stringify(eps) : '';
    } catch (_) {}
    const curGuid = String((info && info.itemGuid) || '');
    epUdByHost.set(hostId, { prev: hasPrev ? 'yes' : 'no', next: hasNext ? 'yes' : 'no', list: epsJson, cur: curGuid });
    const surf = mpvSurfaces.get(hostId);
    if (surf) epUdApply(hostId, surf, false);
    dlog('info', 'mpv.epnav.ability', {
      host: hostId, hasPrev, hasNext, total: info && info.total, source: info && info.source,
      hasSurf: !!surf, ipc: !!(surf && surf.player && surf.player.connected), eps: (info && info.episodes && info.episodes.length) || 0
    });
  } catch (err) { dlog('warn', 'mpv.epnav.ability.err', { err: String(err && err.message || err) }); }
});

ipcMain.handle('mpv:embed-close', async (e) => {
  try {
    const hostWin = hostWindowFromSender(e && e.sender) || mainWindow;
    const surf = mpvSurfaces.get(hostWin.id);
    if (surf) { try { surf.destroy(); } catch (_) {} mpvSurfaces.delete(hostWin.id); }
    // 通知 guest 网页恢复 <video> 显示
    try { notifyGuestMpvClosed(e && e.sender); } catch (_) {}
    return { ok: true };
  } catch (_) { return { ok: false }; }
});


// ---------- 录制（顺序下载 HLS TS 分片到本地 .ts） ----------
const RECORDINGS = new Map();
function fmtRecTs(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// 拉取 m3u8 并选择最高码率变体（主播放列表）或直接媒体列表
async function fetchM3u8Variant(streamUrl) {
  const buf = await httpGetBuffer(streamUrl, { timeout: 15000, maxBytes: 10 * 1024 * 1024 });
  const text = buf.toString('utf-8');
  if (!/^#EXTM3U/.test(text.trim())) throw new Error('返回内容不是有效的 M3U8');
  if (!text.includes('#EXT-X-STREAM-INF')) return { playlistUrl: streamUrl, text };
  // 解析变体，挑 BANDWIDTH 最高
  const lines = text.split(/\r?\n/);
  let bestBw = -1, bestUrl = '';
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.startsWith('#EXT-X-STREAM-INF')) {
      const bw = /BANDWIDTH=(\d+)/i.exec(L);
      const v = bw ? parseInt(bw[1], 10) : 0;
      const target = lines[i + 1];
      if (target && !target.startsWith('#')) {
        let abs = target.trim();
        if (!/^https?:\/\//i.test(abs)) { try { abs = new URL(abs, streamUrl).toString(); } catch (_) {} }
        if (v > bestBw) { bestBw = v; bestUrl = abs; }
      }
    }
  }
  if (!bestUrl) throw new Error('未在主播放列表中找到变体');
  const vbuf = await httpGetBuffer(bestUrl, { timeout: 15000, maxBytes: 10 * 1024 * 1024 });
  return { playlistUrl: bestUrl, text: vbuf.toString('utf-8') };
}
async function recordStart(channel) {
  if (!channel || !channel.url) throw new Error('无效频道');
  const id = 'rec_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const recDir = path.join(app.getPath('videos') || app.getPath('home'), 'FNOS-Recordings');
  try { fs.mkdirSync(recDir, { recursive: true }); } catch (_) {}
  const safeName = String(channel.name || 'channel').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  const filePath = path.join(recDir, `${safeName}-${fmtRecTs(Date.now())}.ts`);
  const fd = fs.openSync(filePath, 'w');
  const state = {
    id, channel, filePath, recDir, fd,
    stopped: false, segmentCount: 0, bytes: 0,
    lastSeq: -1, playlistUrl: '', startedAt: Date.now(),
  };
  RECORDINGS.set(id, state);
  liveLog('info', 'record.start', { id, name: channel.name, filePath });
  const send = (ev, extra) => {
    try { BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('iptv:recording-' + ev, { id, name: channel.name, bytes: state.bytes, segmentCount: state.segmentCount, filePath, ...extra })); } catch (_) {}
  };
  send('state', { running: true });

  const loop = async () => {
    try {
      const { playlistUrl, text } = await fetchM3u8Variant(channel.url);
      state.playlistUrl = playlistUrl;
      const lines = text.split(/\r?\n/);
      const segs = [];
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i].trim();
        if (L && !L.startsWith('#')) {
          const sn = /#EXT-X-MEDIA-SEQUENCE:(\d+)/i.exec(lines.slice(Math.max(0, i - 5), i).join('\n'));
          let abs = L;
          if (!/^https?:\/\//i.test(abs)) { try { abs = new URL(abs, playlistUrl).toString(); } catch (_) { continue; } }
          segs.push({ url: abs, seq: sn ? parseInt(sn[1], 10) + segs.length : segs.length });
        }
      }
      // 从最新分片开始（回看旧分片通常已 404）
      for (const seg of segs) {
        if (state.stopped) break;
        if (seg.seq <= state.lastSeq) continue;
        state.lastSeq = seg.seq;
        try {
          const buf = await httpGetBuffer(seg.url, { timeout: 20000, maxBytes: 60 * 1024 * 1024 });
          if (state.stopped) break;
          fs.writeSync(fd, buf);
          state.bytes += buf.length;
          state.segmentCount += 1;
          send('progress');
        } catch (e) {
          liveLog('warn', 'record.segment', { id, error: e.message, url: seg.url });
        }
      }
    } catch (e) {
      liveLog('warn', 'record.playlist', { id, error: e.message });
    }
    if (!state.stopped) {
      // HLS 直播分片通常 4-10 秒，固定间隔轮询
      state.timer = setTimeout(loop, 4000);
    }
  };
  loop();
  return { id, filePath, recDir };
}
function recordStop(id) {
  const state = RECORDINGS.get(id);
  if (!state) return { ok: false, error: '录制未找到' };
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  try { fs.closeSync(state.fd); } catch (_) {}
  RECORDINGS.delete(id);
  liveLog('info', 'record.stop', { id, bytes: state.bytes, segmentCount: state.segmentCount, filePath: state.filePath });
  try { BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('iptv:recording-state', { id, name: state.channel.name, running: false, bytes: state.bytes, segmentCount: state.segmentCount, filePath: state.filePath })); } catch (_) {}
  return { ok: true, filePath: state.filePath, bytes: state.bytes, segmentCount: state.segmentCount };
}
ipcMain.handle('iptv:record-start', async (_e, channel) => {
  try {
    const r = await recordStart(channel);
    return { ok: true, ...r };
  } catch (e) {
    liveLog('error', 'record.start', { error: e.message });
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('iptv:record-stop', async (_e, id) => recordStop(id));
ipcMain.handle('iptv:record-list', async () => {
  return Array.from(RECORDINGS.values()).map((s) => ({ id: s.id, name: s.channel.name, bytes: s.bytes, segmentCount: s.segmentCount, filePath: s.filePath, startedAt: s.startedAt, running: !s.stopped }));
});
ipcMain.handle('iptv:record-open-folder', async (_e, id) => {
  try {
    const s = RECORDINGS.get(id);
    const dir = s ? s.recDir : path.join(app.getPath('videos') || app.getPath('home'), 'FNOS-Recordings');
    require('child_process').exec((process.platform === 'win32' ? 'explorer.exe "' + dir + '"' : process.platform === 'darwin' ? 'open "' + dir + '"' : 'xdg-open "' + dir + '"'));
    return { ok: true, dir };
  } catch (e) { return { ok: false, error: e.message }; }
});

// v1.17.7：代理状态/配置 IPC 大幅精简——本地代理已移除，仅保留 iptvBaseUrl/
// iptvLine/iptvFavorites/debug（debug 仅用于诊断日志开关，不再驱动代理）。
ipcMain.handle('iptv:get-status', async () => {
  try {
    const s = prefs.load().iptv || {};
    return {
      ok: true,
      config: {
        enabled: false,
        iptvBaseUrl: s.iptvBaseUrl || '',
        iptvLine: s.iptvLine || 'inner',
        favorites: Array.isArray(s.iptvFavorites) ? s.iptvFavorites : [],
      },
      // 代理运行状态固定为未启用，renderer 旧代码读取这些字段不会崩
      status: { listening: false, port: 0, segments: 0, bytes: 0, sessions: 0 },
    };
  } catch (err) {
    return { ok: false, error: err?.message || '获取状态失败' };
  }
});

ipcMain.handle('iptv:set-config', async (_e, patch) => {
  try {
    const cur = prefs.load().iptv || {};
    const next = { ...cur };
    if (patch && typeof patch === 'object') {
      if (typeof patch.iptvBaseUrl === 'string') {
        const v = patch.iptvBaseUrl.trim();
        const normBefore = normalizeIptvBase(next.iptvBaseUrl);
        next.iptvBaseUrl = v;
        const normAfter = normalizeIptvBase(v);
        if (normBefore !== normAfter) { g_cachedXteBase = ''; g_cachedXteBaseAt = 0; }
      }
      if (['inner', 'ipv6', 'frp'].includes(patch.iptvLine)) next.iptvLine = patch.iptvLine;
      // v1.23.0：EPG 地址与缓冲秒数
      if (typeof patch.iptvEpgUrl === 'string') next.iptvEpgUrl = patch.iptvEpgUrl.trim();
      if (patch.iptvCacheSeconds != null) {
        const n = parseInt(patch.iptvCacheSeconds, 10);
        if (Number.isFinite(n)) next.iptvCacheSeconds = Math.max(0, Math.min(120, n));
      }
      // EPG 地址变更时清空 EPG 缓存，强制下次重新拉取
      if (typeof patch.iptvEpgUrl === 'string') { EPG_CACHE = null; try { fs.unlinkSync(path.join(getIptvCacheDir(), 'epg.json')); } catch (_) {} }
    }
    prefs.save({ iptv: next });
    cachedSettings.iptv = next;
    return { ok: true, status: { listening: false, port: 0 } };
  } catch (err) {
    return { ok: false, error: err?.message || '保存失败' };
  }
});

// v1.17.7：缓存清空已无意义（无本地代理），保留 IPC 名称仅为兼容旧 renderer 调用。
ipcMain.handle('iptv:clear-cache', async () => ({ ok: true, status: { listening: false, port: 0, segments: 0, bytes: 0, sessions: 0 } }));

// ── Windows 侧外部依赖的 macOS 等价实现（MPV 在 macOS 降级为 hls.js，相关钩子为安全空实现）──
function MpvSurface() {
  const noop = () => {};
  return {
    setBounds: noop, resize: noop, show: noop, hide: noop, destroy: noop, dispose: noop,
    play: () => Promise.resolve(null), pause: noop, stop: noop, seek: noop, setVolume: noop,
    load: () => Promise.resolve(null), loadFile: () => Promise.resolve(null),
    on: noop, once: noop, off: noop, removeAllListeners: noop, send: noop,
    available: false, supported: false,
  };
}
function __isFsOn(w) { try { return !!(w && !w.isDestroyed() && w.isFullScreen()); } catch (_) { return false; } }
function __pushTitlebarTo() {}
function armResumeNotice() {}
function hookProgressMemory() {}
function progressKeyFor(url) { return 'p:' + String(url || '').slice(0, 180); }
function resumePosFor() { return 0; }
function pushAutoNext() {}
function saveMpvAutoNext(v) { try { prefs.save({ mpvAutoNext: !!v }); } catch (_) {} }
function createAppWindow() { try { return win.openAppWindow.apply(null, arguments); } catch (_) { return null; } }
function diagLog(line) { try { logger.log('info', 'diag', String(line || '').slice(0, 800)); } catch (_) {} }
function dlog(level, ev, data) { try { logger.log(level || 'info', 'live', String(ev || ''), { params: data }); } catch (_) {} }
function fpkAppNameFromUrl(u) {
  try {
    const p = new URL(String(u)).pathname.replace(/\/+$/, '');
    const seg = p.split('/').filter(Boolean);
    return seg.length ? decodeURIComponent(seg[seg.length - 1]) : '';
  } catch (_) { return ''; }
}
function getNasUA() {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FNOS-Desktop/' + APP_VERSION;
}
function glassMessageBox(opts) {
  try { return dialog.showMessageBox(BrowserWindow.getFocusedWindow() || undefined, opts || {}); } catch (_) { return Promise.resolve({ response: 0 }); }
}
function isIptvStreamUrl(u) { return /\.(m3u8|ts|mp4|flv)(\?|$)/i.test(String(u || '')); }
function getBrowserViews(w) { try { return (w && w.getBrowserViews()) || []; } catch (_) { return []; } }

// 本模块的 IPC 通道在 require 时即完成注册（与 Windows 版一致）
function register() {
  try { setMainWindow(win.getMain()); } catch (_) {}
  return true;
}

module.exports = {
  register, setMainWindow,
  resolveIptvBase, resolveIptvBaseAsync, normalizeIptvBase,
  fetchIptvPlaylist, parseM3uChannels,
};
