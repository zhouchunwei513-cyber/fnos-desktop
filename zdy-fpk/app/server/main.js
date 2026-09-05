/*
 * ZDY 飞牛 NAS 增强插件服务端（方案B：外网请求统一由 NAS 发起）
 * 零第三方依赖，原生 Node.js http/https。
 *
 * 能力：
 *   弹幕  - 弹弹play 开源 API（名称+季+集精确匹配），B站兜底
 *   字幕  - assrt.net / 射手 网页聚合检索与下载
 *   片头片尾 - SkipIntro 时间戳库（按片名/季/集返回 intro/outro 秒数）
 *   认证  - 两层：
 *           ① 授权码 authCode：服务端自动生成，客户端填入后即可调用弹幕/字幕/片头片尾服务 API
 *           ② 管理密码 adminPwd：登录管理网页、查看/重置授权码、修改配置（PBKDF2 加盐哈希）
 *
 * 运行于飞牛 fnOS（FPK），端口由 manifest service_port / TRIM_SERVICE_PORT 注入。
 */
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(
  process.env.TRIM_SERVICE_PORT ||
  process.env.FPK_SERVICE_PORT ||
  process.env.DEPLOY_RUN_PORT ||
  process.env.PORT ||
  '34510',
  10
);
const BIND_HOST = '::';
const DATA_DIR = process.env.TRIM_PKGVAR
  ? path.join(process.env.TRIM_PKGVAR, 'data')
  : path.join(__dirname, '..', 'data');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

// ---------------------------------------------------------------------------
// 配置（授权码 / 片头片尾时间戳 / 缓存）
// ---------------------------------------------------------------------------
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG = {
  // 授权码：服务端首次启动随机生成，客户端填入后开通服务；管理员可在管理页重置
  authCode: '',
  // 管理密码（PBKDF2 加盐哈希）；默认未设置（null），首次进入管理页时引导设置
  adminSalt: null,
  adminHash: null,
  // 片头片尾默认时长（秒），可被 SkipIntro 精确时间戳覆盖
  defaultIntro: 90,
  defaultOutro: 60,
  // 是否启用B站兜底弹幕
  enableBiliFallback: true,
};

let config = loadConfig();

function loadConfig() {
  let c;
  try {
    c = Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (e) {
    c = Object.assign({}, DEFAULT_CONFIG);
  }
  let dirty = false;
  if (!c.authCode) { c.authCode = genAuthCode(); dirty = true; }
  if (dirty) { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); } catch (e2) {} }
  return c;
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {}
}

function genAuthCode() {
  return 'ZDY-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

// ---- 管理密码（PBKDF2）与会话 ----
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.pbkdf2Sync(String(password), s, 50000, 32, 'sha256').toString('hex');
  return { salt: s, hash: h };
}
function verifyPassword(password) {
  if (!config.adminHash || !config.adminSalt) return false;
  const h = crypto.pbkdf2Sync(String(password), config.adminSalt, 50000, 32, 'sha256').toString('hex');
  // 恒定时间比较
  const a = Buffer.from(h, 'hex'), b = Buffer.from(config.adminHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
// 管理会话 token：{ token: expireTs }，2 小时有效
const ADMIN_SESSIONS = new Map();
function makeAdminSession() {
  const t = crypto.randomBytes(24).toString('hex');
  ADMIN_SESSIONS.set(t, Date.now() + 2 * 3600 * 1000);
  return t;
}
function isAdmin(req, url) {
  const auth = req.headers['authorization'] || '';
  const t = (auth.match(/Bearer\s+(\S+)/i) || [])[1] || url.searchParams.get('admin') || url.searchParams.get('token') || '';
  const exp = ADMIN_SESSIONS.get(t);
  if (exp && exp > Date.now()) return true;
  return false;
}

// 内存缓存（5 分钟）+ 磁盘持久化缓存（弹幕/字幕搜索结果 7 天，弹幕内容 30 天）。
// 作用：客户端再次打开同一部影片时直接命中本地缓存秒返回，不必重新访问外网，
//       既快又稳定（也规避数据中心/家庭网络对弹幕站点的临时限流）。
const CACHE = new Map();
const MEM_TTL = 5 * 60 * 1000;
function cacheGet(key) {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < MEM_TTL) return hit.v;
  if (hit) CACHE.delete(key);
  return null;
}
function cacheSet(key, v) { CACHE.set(key, { t: Date.now(), v }); }

const DISK_CACHE_DIR = path.join(DATA_DIR, 'cache');
try { fs.mkdirSync(DISK_CACHE_DIR, { recursive: true }); } catch (e) {}
function _diskPath(key) {
  const h = crypto.createHash('md5').update(String(key)).digest('hex');
  return path.join(DISK_CACHE_DIR, h + '.json');
}
// ttlMs: 磁盘有效期
function diskGet(key, ttlMs) {
  try {
    const p = _diskPath(key);
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > ttlMs) return null;
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    cacheSet(key, obj); // 回填内存
    return obj;
  } catch (e) { return null; }
}
function diskSet(key, v) {
  try { cacheSet(key, v); fs.writeFileSync(_diskPath(key), JSON.stringify(v)); } catch (e) {}
}
// 先内存→再磁盘（按 ttl）
function persistentGet(key, ttlMs) {
  return cacheGet(key) || diskGet(key, ttlMs);
}
const TTL_SEARCH = 7 * 24 * 3600 * 1000;   // 搜索结果 7 天
const TTL_DANMAKU = 30 * 24 * 3600 * 1000; // 弹幕内容 30 天

function log(...a) {
  const msg = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(msg);
  try { fs.appendFileSync(path.join(DATA_DIR, 'zdy.log'), msg + '\n'); } catch (e) {}
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function httpGet(urlStr, headers, redirs, asBuffer) {
  redirs = redirs || 0;
  headers = headers || { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' };
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(urlStr, { headers, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirs < 6) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, urlStr).toString(), headers, redirs + 1, asBuffer));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
        } catch (e) {}
        resolve(asBuffer ? buf : buf.toString('utf8'));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

// ---------------------------------------------------------------------------
// 弹幕：弹弹play
// ---------------------------------------------------------------------------
// 弹弹play 需要 App 标识。使用社区开源客户端通用标识；无强制密钥。
const DANDAN_UA = 'ZDY-FPK/1.0';
function dandan(pathWithQuery) {
  return httpGet('https://api.dandanplay.net' + pathWithQuery, {
    'User-Agent': DANDAN_UA,
    'Accept': 'application/json',
    'X-Api-Client': 'ZDY-FPK',
    'X-Api-Version': '1.0',
  }, 0, false).then((t) => JSON.parse(t));
}

async function dandanSearch(keyword) {
  // 先按名称搜剧集
  const r = await dandan('/api/v2/search/episodes?anime=' + encodeURIComponent(keyword));
  const list = (r && r.success && r.animes) || [];
  const results = [];
  for (const anime of list.slice(0, 3)) {
    const eps = anime.episodes || [];
    for (const ep of eps.slice(0, 3)) {
      results.push({
        source: 'dandanplay',
        animeTitle: anime.animeTitle || anime.title || keyword,
        episodeTitle: ep.episodeTitle || ('第' + ep.episodeNumber + '集'),
        episodeId: ep.episodeId,
        animeId: anime.animeId,
        episodeNumber: ep.episodeNumber,
        typeDescription: anime.typeDescription || '',
      });
    }
  }
  return results;
}

async function dandanDanmaku(episodeId, withRelated) {
  // 弹弹play 弹幕下载：POST /api/v2/comment/{episodeId}（withRelated=true 合并相似剧集）
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ withRelated: withRelated !== false });
    const u = new URL('https://api.dandanplay.net/api/v2/comment/' + episodeId + '?withRelated=' + (withRelated !== false));
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'User-Agent': DANDAN_UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Api-Client': 'ZDY-FPK',
        'X-Api-Version': '1.0',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          let buf = Buffer.concat(chunks);
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          const j = JSON.parse(buf.toString('utf8'));
          if (!j.success) return resolve([]);
          // 弹弹play 弹幕格式：[{cid,p,time,content,...}] p="时间,模式,颜色,uid,..."
          const out = [];
          const conv = (arr) => (arr || []).forEach((c) => {
            const parts = String(c.p || '').split(',');
            out.push({
              time: parseFloat(parts[0]) || c.time || 0,
              mode: parseInt(parts[1] || '1', 10),
              color: parseInt(parts[2] || '16777215', 10),
              text: c.m || c.content || '',
            });
          });
          conv(j.comments);
          (j.related || []).forEach((rel) => conv(rel.comments));
          resolve(sanitizeDanmaku(out));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 弹幕：B站兜底（wbi 签名 + XML 历史接口）
// ---------------------------------------------------------------------------
const WBI_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let wbiCache = { t: 0, img: '', sub: '' };

async function getWbiKeys() {
  if (wbiCache.t && Date.now() - wbiCache.t < 30 * 60 * 1000 && wbiCache.img) return wbiCache;
  const t = await httpGet('https://api.bilibili.com/x/web-interface/nav', { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' });
  const j = JSON.parse(t);
  const b = (u) => String(u).split('/').pop().split('.')[0];
  wbiCache = { t: Date.now(), img: b(j.data.wbi_img.img_url), sub: b(j.data.wbi_img.sub_url) };
  return wbiCache;
}
function mixinKey(img, sub) {
  const raw = img + sub;
  let m = '';
  for (const i of WBI_TAB) m += raw[i];
  return m.slice(0, 32);
}
async function biliSigned(path, params) {
  const k = await getWbiKeys();
  const mixin = mixinKey(k.img, k.sub);
  params = Object.assign({ wts: Math.round(Date.now() / 1000) }, params);
  const keys = Object.keys(params).sort();
  const parts = [];
  for (const key of keys) {
    const v = String(params[key] == null ? '' : params[key]).replace(/[!'()*]/g, '');
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
  }
  const wRid = md5(parts.join('&') + mixin);
  parts.push('w_rid=' + wRid);
  return httpGet('https://api.bilibili.com' + path + '?' + parts.join('&'), { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' });
}

async function biliSearch(keyword) {
  let r;
  try {
    r = JSON.parse(await biliSigned('/x/web-interface/wbi/search/type', { search_type: 'video', order: 'totalrank', page: 1, keyword }));
  } catch (e) {
    r = JSON.parse(await httpGet('https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(keyword), { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' }));
  }
  const arr = (r && r.data && r.data.result) || [];
  return arr.filter((v) => v.bvid).slice(0, 8).map((v) => ({
    source: 'bilibili',
    bvid: v.bvid,
    aid: v.aid,
    title: String(v.title || '').replace(/<[^>]+>/g, ''),
    duration: v.duration || '',
    play: v.play || 0,
  }));
}

async function biliPagelist(bvid) {
  const t = await httpGet('https://api.bilibili.com/x/player/pagelist?bvid=' + encodeURIComponent(bvid), { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' });
  const j = JSON.parse(t);
  return (j.data || []).map((p) => ({ cid: p.cid, page: p.page, duration: p.duration || 0, part: p.part || '' }));
}

// 弹幕条目清洗：数据中心 IP 下 seg.so/XML 可能被风控，粗解析会产出 time 天文数字、
// mode/color 越界的脏数据。这里只保留时间在 [0, 12h]、mode 1~9、color 0~0xFFFFFF、文本非空的条目。
// 若脏数据占比过高（说明整体解析错位），返回空数组，宁可不显示也不上花屏乱码弹幕。
function sanitizeDanmaku(list) {
  if (!Array.isArray(list)) return [];
  const good = [];
  for (const c of list) {
    const t = Number(c && c.time);
    const mode = parseInt(c && c.mode, 10);
    const color = parseInt(c && c.color, 10);
    const text = String((c && c.text) || '').trim();
    if (!isFinite(t) || t < 0 || t > 12 * 3600) continue;
    if (!mode || mode < 1 || mode > 9) continue;
    if (!isFinite(color) || color < 0 || color > 0xFFFFFF) continue;
    if (!text || text.length > 200) continue;
    good.push({ time: t, mode: mode > 6 ? 1 : mode, color, text });
  }
  // 若清洗后存活率 < 30% 且原始条目不少，视为整体解析错位（风控/空响应被误解析），丢弃
  if (list.length >= 20 && good.length < list.length * 0.3) {
    log('danmaku sanitize: discard low-yield parse', { total: list.length, good: good.length });
    return [];
  }
  return good;
}

async function biliDanmaku(cid) {
  // 优先历史 XML 接口（无需登录、稳定），失败回退 seg.so
  try {
    const xml = await httpGet('https://comment.bilibili.com/' + cid + '.xml', { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' });
    const out = [];
    const re = /<d\s+[^>]*p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const attr = m[1].split(',');
      out.push({
        time: parseFloat(attr[0]) || 0,
        mode: parseInt(attr[1] || '1', 10),
        color: parseInt(attr[2] || '16777215', 10),
        text: m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'),
      });
    }
    const clean = sanitizeDanmaku(out);
    if (clean.length) return clean;
  } catch (e) {}
  // seg.so 回退（粗解析 protobuf 文本字段）
  try {
    const cidNum = parseInt(String(cid).replace(/^cid=/, ''), 10) || cid;
    const buvid = crypto.randomBytes(8).toString('hex') + crypto.randomBytes(8).toString('hex');
    const buf = await httpGet('https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=' + cidNum + '&segment_index=1', { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/', 'Cookie': 'buvid3=' + buvid }, 0, true);
    return sanitizeDanmaku(parseSegDanmaku(buf));
  } catch (e) { return []; }
}

function parseSegDanmaku(buf) {
  const out = [];
  let i = 0;
  const readVarint = (b, p) => { let r = 0n, s = 0n; while (p < b.length) { const x = b[p]; r |= BigInt(x & 0x7f) << s; p++; if (!(x & 0x80)) break; s += 7n; } return [r, p]; };
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 2) {
      let ln;
      [ln, i] = readVarint(buf, i);
      const end = i + Number(ln);
      if (field === 1) { // DanmakuElem
        let j = i;
        let time = 0;
        let mode = 1;
        let color = 16777215;
        let text = '';
        while (j < end) {
          let k2; [k2, j] = readVarint(buf, j);
          const f2 = Number(k2 >> 3n), w2 = Number(k2 & 7n);
          if (w2 === 2) {
            let l2; [l2, j] = readVarint(buf, j);
            const e2 = j + Number(l2);
            if (f2 === 7) text = buf.toString('utf8', j, e2);
            j = e2;
          } else if (w2 === 0) {
            let v; [v, j] = readVarint(buf, j);
            if (f2 === 1) time = Number(v) / 1000;
            else if (f2 === 2) mode = Number(v);
            else if (f2 === 3) color = Number(v);
          } else if (w2 === 5) { j += 4; } else if (w2 === 1) { j += 8; } else break;
        }
        if (text) out.push({ time, mode, color, text });
      }
      i = end;
    } else if (wire === 0) { let v; [v, i] = readVarint(buf, i); }
    else if (wire === 5) { i += 4; }
    else if (wire === 1) { i += 8; }
    else break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 字幕：assrt.net 网页聚合
// ---------------------------------------------------------------------------
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, '').replace(/\s+/g, ' ').trim();
}

// 提取核心片名：去年份/季集/分辨率/编码/来源等噪声，用于字幕相关性匹配，
// 避免把同名不同作品、花絮预告、合集等字幕当成正片字幕。
function coreTitleOf(t) {
  return String(t || '')
    .replace(/[（(【\[].*?[)）】\]]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/gi, ' ')
    .replace(/\bS\d{1,2}\s*[-x~]?\s*E?\d{0,3}\b/gi, ' ')
    .replace(/第\s*\d+\s*[季集期部]/g, ' ')
    .replace(/\b\d{3,4}p\b|\b[248]k\b/gi, ' ')
    .replace(/web[ -]?dl|webrip|bluray|bdrip|hdrip|dvdrip|x264|x265|h\.?264|h\.?265|hevc|aac|ac3|mp3|10bit|hdr|remux|proper/gi, ' ')
    .replace(/[\s._\-—·,，、]+/g, '')
    .trim();
}

// 字幕条目相关性评分：核心片名必须命中；简体/正片优先；花絮预告降权。
function scoreSubtitle(name, core) {
  const n = coreTitleOf(name);
  let score = 0;
  if (core && n) {
    if (n.includes(core) || core.includes(n)) score += 50;
    else score -= 100; // 核心片名对不上，基本是别的影片
  }
  // 语言：简体/中英优先
  if (/简体|简英|中英|双语|GB2312|GBK/i.test(name)) score += 20;
  else if (/繁体|繁體|港台|Big5/i.test(name)) score += 5;
  else if (/english|英文/i.test(name)) score -= 5;
  // 非正片内容降权
  if (/花絮|预告|特辑|彩蛋|制作|幕后|访谈|综艺|动画版|电视剧版|舞台剧|纪录片|合集|删减|加长版/.test(name) && !/花絮|预告|纪录片/.test(core)) score -= 60;
  // 名称越接近纯核心片名越可能是正片主字幕
  if (core && n) score -= Math.abs(n.length - core.length) * 0.5;
  return score;
}

async function searchAssrt(title) {
  const core = coreTitleOf(title);
  const h = await httpGet('https://assrt.net/sub/?searchword=' + encodeURIComponent(title), { 'User-Agent': UA, 'Referer': 'https://assrt.net/', 'Accept-Language': 'zh-CN' });
  const links = [];
  const seen = {};
  let m;
  const re = /href="(\/xml\/sub\/\d+\/\d+\.xml)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = re.exec(h)) !== null) {
    if (!seen[m[1]]) { seen[m[1]] = 1; links.push({ detailUrl: 'https://assrt.net' + m[1], name: stripHtml(m[2]) || title }); }
    if (links.length >= 15) break;
  }
  const scored = [];
  for (const it of links) {
    try {
      const dh = await httpGet(it.detailUrl, { 'User-Agent': UA, 'Referer': 'https://assrt.net/' });
      const zip = dh.match(/\/download\/\d+\/[^"'\s]*?\.zip/i);
      if (!zip) continue; // 网盘外链/需积分 rar 跳过
      const name = stripHtml((dh.match(/<title>([^<]+)<\/title>/) || [])[1]) || it.name;
      const lang = /简体|简英|中英|双语|GB2312|GBK/i.test(name) ? '简' : (/繁体|繁體|Big5/i.test(name) ? '繁' : '中');
      scored.push({
        source: 'assrt',
        id: 'assrt_' + (it.detailUrl.match(/\/(\d+)\.xml/) || [])[1],
        name: name.slice(0, 80),
        lang,
        score: scoreSubtitle(name, core),
        downloadUrl: 'https://assrt.net' + zip[0].replace(/&amp;/g, '&'),
        referer: 'https://assrt.net/',
      });
    } catch (e) {}
  }
  // 相关性排序，丢弃核心片名不符的条目
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// 片头片尾时间戳（SkipIntro 思路：内置常用 + 可在设置页配置）
// ---------------------------------------------------------------------------
const SKIP_FILE = path.join(DATA_DIR, 'skipdb.json');
let skipDb = loadSkipDb();
function loadSkipDb() {
  try { return JSON.parse(fs.readFileSync(SKIP_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveSkipDb() { try { fs.writeFileSync(SKIP_FILE, JSON.stringify(skipDb, null, 2)); } catch (e) {} }

async function getSkipTimestamps(title, episode) {
  const key = (title || '').replace(/\s+/g, '').toLowerCase();
  // 精确匹配
  for (const k of Object.keys(skipDb)) {
    if (k.replace(/\s+/g, '').toLowerCase() === key) {
      const hit = skipDb[k];
      const ep = episode ? (hit.episodes && hit.episodes[String(episode)]) : null;
      return ep || { introStart: hit.introStart || 0, introEnd: hit.introEnd != null ? hit.introEnd : config.defaultIntro, outroStart: hit.outroStart != null ? hit.outroStart : null, outroEnd: hit.outroEnd != null ? hit.outroEnd : null };
    }
  }
  // 无精确数据：返回默认片头时长
  return { introStart: 0, introEnd: config.defaultIntro, outroStart: null, outroEnd: config.defaultOutro };
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve({}); }
    });
  });
}

// 服务 API（客户端调用）：用授权码
function serviceAuthorized(req, url) {
  const auth = req.headers['authorization'] || '';
  const token = (auth.match(/Bearer\s+(\S+)/i) || [])[1] || url.searchParams.get('token') || '';
  return !!config.authCode && token === config.authCode;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    return res.end();
  }

  // 健康检查（免认证）
  if (route === '/ping') return sendJson(res, 200, { ok: true, service: 'zdy-fpk', version: '1.2.0' });

  // 设置页静态资源（免认证，页面内登录管理密码）
  if (route === '/' || route === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(SETTINGS_HTML);
  }

  // ============ 管理 API（管理密码） ============
  if (route === '/admin/info' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, hasAdminPassword: !!config.adminHash });
  }

  if (route === '/admin/login' && req.method === 'POST') {
    const body = await readBody(req);
    const pwd = String(body.password || '');
    // 未设置过管理密码：首次提交即设置
    if (!config.adminHash) {
      if (pwd.length < 4) return sendJson(res, 400, { ok: false, error: '管理密码至少 4 位' });
      const { salt, hash } = hashPassword(pwd);
      config.adminSalt = salt; config.adminHash = hash;
      saveConfig();
      log('admin password initialized');
      return sendJson(res, 200, { ok: true, token: makeAdminSession() });
    }
    if (!verifyPassword(pwd)) {
      log('admin login failed');
      return sendJson(res, 401, { ok: false, error: '管理密码错误' });
    }
    return sendJson(res, 200, { ok: true, token: makeAdminSession() });
  }

  if (route === '/admin/state' && req.method === 'GET') {
    if (!isAdmin(req, url)) return sendJson(res, 401, { ok: false, error: '未登录' });
    return sendJson(res, 200, {
      ok: true,
      authCode: config.authCode,
      defaultIntro: config.defaultIntro,
      defaultOutro: config.defaultOutro,
      enableBiliFallback: config.enableBiliFallback,
    });
  }

  if (route === '/admin/update' && req.method === 'POST') {
    if (!isAdmin(req, url)) return sendJson(res, 401, { ok: false, error: '未登录' });
    const body = await readBody(req);
    // 片头片尾 / 兜底开关
    if (body.defaultIntro != null) config.defaultIntro = Math.max(0, parseInt(body.defaultIntro, 10) || 0);
    if (body.defaultOutro != null) config.defaultOutro = Math.max(0, parseInt(body.defaultOutro, 10) || 0);
    if (body.enableBiliFallback != null) config.enableBiliFallback = !!body.enableBiliFallback;
    // 修改管理密码
    if (body.newPassword) {
      if (String(body.newPassword).length < 4) return sendJson(res, 400, { ok: false, error: '新密码至少 4 位' });
      const { salt, hash } = hashPassword(body.newPassword);
      config.adminSalt = salt; config.adminHash = hash;
    }
    saveConfig();
    log('admin config updated');
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/admin/regenerate-code' && req.method === 'POST') {
    if (!isAdmin(req, url)) return sendJson(res, 401, { ok: false, error: '未登录' });
    config.authCode = genAuthCode();
    saveConfig();
    log('authCode regenerated');
    return sendJson(res, 200, { ok: true, authCode: config.authCode });
  }

  // ============ 服务 API（客户端用授权码） ============
  if (!serviceAuthorized(req, url)) {
    log('service auth failed', route, (req.headers['authorization'] || '').slice(0, 12));
    return sendJson(res, 401, { ok: false, error: '授权码无效或缺失，请在客户端填入本服务生成的授权码' });
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};

    // 弹幕搜索（内存+磁盘持久化缓存，TTL 7 天；再次打开同片秒返回）
    if (route === '/danmaku/search') {
      const kw = body.keyword || body.title || body.filename || '';
      log('danmaku search', kw);
      const ck = 'dmsearch_' + String(kw).replace(/\s+/g, '').toLowerCase();
      let results = persistentGet(ck, TTL_SEARCH);
      let cached = !!results;
      if (!results) {
        results = [];
        // 弹弹play 优先
        try { results = await dandanSearch(kw); } catch (e) { log('dandan search fail', e.message); }
        // B站兜底
        if ((!results.length) && config.enableBiliFallback) {
          try { results = await biliSearch(kw); } catch (e) { log('bili search fail', e.message); }
        }
        if (results.length) diskSet(ck, results);
      }
      return sendJson(res, 200, { ok: true, results, cached });
    }

    // 弹幕下载（内容缓存 30 天，按 episodeId/cid 唯一）
    if (route === '/danmaku/download') {
      const item = body.item || body;
      const uid = 'dmdl_' + (item.episodeId || item.cid || item.bvid || '');
      log('danmaku download', item.source, item.episodeId || item.bvid, item.cid);
      let cached = persistentGet(uid, TTL_DANMAKU);
      let comments = cached || [];
      if (!comments.length) {
        if (item.source === 'dandanplay' || item.episodeId) {
          try { comments = await dandanDanmaku(item.episodeId, true); } catch (e) { log('dandan dm fail', e.message); }
        }
        if ((!comments.length) && (item.bvid || item.cid)) {
          try {
            let cid = item.cid;
            if (!cid && item.bvid) {
              const pages = await biliPagelist(item.bvid);
              cid = (pages.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] || {}).cid;
            }
            if (cid) comments = await biliDanmaku(cid);
          } catch (e) { log('bili dm fail', e.message); }
        }
        if (comments.length) diskSet(uid, comments);
      }
      return sendJson(res, 200, { ok: comments.length > 0, count: comments.length, comments, cached: !!cached });
    }

    // 字幕搜索（持久化缓存 7 天）
    if (route === '/subtitle/search') {
      const title = body.title || body.filename || body.query || body.keyword || '';
      log('subtitle search', title);
      const ck = 'sub_' + String(title).replace(/\s+/g, '').toLowerCase();
      let results = persistentGet(ck, TTL_SEARCH);
      let cached = !!results;
      if (!results) {
        try { results = await searchAssrt(title); } catch (e) { log('assrt fail', e.message); results = []; }
        if (results.length) diskSet(ck, results);
      }
      return sendJson(res, 200, { ok: true, results, cached });
    }

    // 字幕下载（返回 zip 流）
    if (route === '/subtitle/download') {
      const dl = body.downloadUrl || body.url;
      if (!dl) return sendJson(res, 400, { ok: false, error: 'missing downloadUrl' });
      const referer = body.referer || 'https://assrt.net/';
      log('subtitle download', dl.slice(0, 70));
      const buf = await httpGet(dl, { 'User-Agent': UA, 'Referer': referer }, 0, true);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="subtitle.zip"', 'Access-Control-Allow-Origin': '*' });
      return res.end(buf);
    }

    // 片头片尾时间戳
    if (route === '/skip/timestamps') {
      const title = body.title || body.filename || '';
      const episode = body.episode || body.season;
      const ts = await getSkipTimestamps(title, episode);
      return sendJson(res, 200, { ok: true, ...ts });
    }
    if (route === '/skip/save' && req.method === 'POST') {
      const title = (body.title || '').trim();
      if (!title) return sendJson(res, 400, { ok: false, error: 'missing title' });
      skipDb[title.replace(/\s+/g, '').toLowerCase()] = {
        introStart: body.introStart || 0,
        introEnd: body.introEnd,
        outroStart: body.outroStart,
        outroEnd: body.outroEnd,
        episodes: body.episodes || {},
      };
      saveSkipDb();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: 'not found: ' + route });
  } catch (e) {
    log('route error', route, e.stack || e.message);
    return sendJson(res, 500, { ok: false, error: e.message });
  }
});

// 设置页 HTML（管理密码登录；授权码由服务端生成、客户端填入）
const SETTINGS_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZDY 增强插件管理</title>
<style>
body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#0f1115;color:#e6e8ec;margin:0;padding:24px;}
.card{max-width:600px;margin:0 auto;background:#171a21;border:1px solid #262b36;border-radius:12px;padding:24px;}
h1{font-size:20px;margin:0 0 4px;} .sub{color:#8b93a5;font-size:13px;margin-bottom:20px;}
label{display:block;font-size:13px;color:#aab2c5;margin:14px 0 6px;}
input{width:100%;box-sizing:border-box;background:#0f1115;border:1px solid #2c3242;border-radius:8px;color:#e6e8ec;padding:10px 12px;font-size:14px;}
button{margin-top:20px;background:#3b82f6;border:0;color:#fff;padding:11px 18px;border-radius:8px;font-size:15px;cursor:pointer;}
button:hover{background:#2f6fe0;} button.ghost{background:#262b36;margin-left:8px;}
.tip{font-size:12px;color:#6b7280;margin-top:10px;line-height:1.7;}
.ok{color:#34d399;font-size:13px;margin-top:12px;} code{background:#0f1115;padding:3px 8px;border-radius:4px;color:#f472b6;font-size:15px;}
.codebox{display:flex;align-items:center;gap:10px;} .codebox code{flex:1;display:block;text-align:center;font-size:18px;letter-spacing:1px;padding:10px;}
hr{border:0;border-top:1px solid #262b36;margin:22px 0;} .hidden{display:none;}
</style></head><body>
<div class="card">
  <h1>ZDY 飞牛增强插件</h1>
  <div class="sub">弹幕 · 字幕 · 跳过片头片尾 服务管理</div>

  <div id="loginBox">
    <label id="pwdLabel">管理密码</label>
    <input id="pwd" type="password" placeholder="请输入管理密码" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()" id="loginBtn">登录</button>
    <div class="ok" id="loginMsg"></div>
    <div class="tip" id="loginTip"></div>
  </div>

  <div id="mainBox" class="hidden">
    <label>授权码（把它填入 PC 客户端「设置 → 增强服务」即可开通）</label>
    <div class="codebox"><code id="authCode">---</code>
      <button class="ghost" onclick="regen()">重置授权码</button></div>

    <hr>
    <label>默认片头时长（秒）</label>
    <input id="intro" type="number" value="90">
    <label>默认片尾时长（秒）</label>
    <input id="outro" type="number" value="60">
    <label style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" id="bili" style="width:auto;"> 弹弹play 不可用时回退 B 站弹幕
    </label>
    <button onclick="savePrefs()">保存偏好</button>
    <span class="ok" id="prefMsg"></span>

    <hr>
    <label>修改管理密码（留空则不改）</label>
    <input id="newPwd" type="password" placeholder="新管理密码（至少 4 位）">
    <button onclick="savePrefs()">应用修改</button>
    <div class="tip">桌面客户端「设置 → 增强服务」填写本 NAS 地址（形如 <code>http://NAS内网IP:${PORT}</code>）和上面的授权码。<br>
    授权码供客户端调用服务使用；本管理页用管理密码保护，二者分开。</div>
  </div>
</div>
<script>
let TOKEN=null;
async function api(p,opt,opt2){opt=opt||{};opt.headers=Object.assign({'Content-Type':'application/json'},opt.headers||{});if(TOKEN)opt.headers['Authorization']='Bearer '+TOKEN;const r=await fetch(p,opt);return r.json();}
function show(el){document.getElementById(el).classList.remove('hidden');}
function hide(el){document.getElementById(el).classList.add('hidden');}
async function boot(){
  try{const j=await fetch('/admin/info').then(r=>r.json());
    if(!j.hasAdminPassword){
      document.getElementById('pwdLabel').textContent='设置管理密码（首次使用，至少 4 位）';
      document.getElementById('loginBtn').textContent='设置并进入';
      document.getElementById('loginTip').textContent='该密码用于登录本管理页；客户端连接用的授权码会在进入后生成/展示。';
    } else {
      document.getElementById('loginTip').textContent='管理密码用于登录本页查看授权码与管理设置。';
    }
  }catch(e){}
}
async function login(){
  const pwd=document.getElementById('pwd').value;
  const msg=document.getElementById('loginMsg');
  if(!pwd){msg.textContent='请输入密码';return;}
  const j=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})}).then(r=>r.json());
  if(j.ok){TOKEN=j.token;sessionStorage.setItem('zdyAdmin',TOKEN);hide('loginBox');show('mainBox');loadState();}
  else{msg.textContent=j.error||'登录失败';}
}
async function loadState(){
  // 自动恢复会话
  if(!TOKEN){const t=sessionStorage.getItem('zdyAdmin');if(t){TOKEN=t;try{const t0=await fetch('/admin/state',{headers:{'Authorization':'Bearer '+TOKEN}}).then(r=>r.json());if(t0.ok){hide('loginBox');show('mainBox');}else{TOKEN=null;sessionStorage.removeItem('zdyAdmin');}}catch(e){}}}
  if(!TOKEN)return;
  const j=await api('/admin/state');
  if(!j.ok){TOKEN=null;sessionStorage.removeItem('zdyAdmin');return;}
  document.getElementById('authCode').textContent=j.authCode;
  document.getElementById('intro').value=j.defaultIntro;
  document.getElementById('outro').value=j.defaultOutro;
  document.getElementById('bili').checked=!!j.enableBiliFallback;
}
async function regen(){
  const j=await api('/admin/regenerate-code',{method:'POST'});
  if(j.ok){document.getElementById('authCode').textContent=j.authCode;alert('已重置授权码，客户端需重新填入新授权码');}
}
async function savePrefs(){
  const body={defaultIntro:parseInt(document.getElementById('intro').value||'90',10),
    defaultOutro:parseInt(document.getElementById('outro').value||'60',10),
    enableBiliFallback:document.getElementById('bili').checked,
    newPassword:document.getElementById('newPwd').value||undefined};
  const j=await api('/admin/update',{method:'POST',body:JSON.stringify(body)});
  const m=document.getElementById('prefMsg');
  if(j.ok){m.textContent='已保存 ✓';document.getElementById('newPwd').value='';setTimeout(()=>m.textContent='',2500);}
  else{m.style.color='#f87171';m.textContent=j.error||'保存失败';setTimeout(()=>{m.style.color='';m.textContent='';},3000);}
}
boot();loadState();
</script></body></html>`;

server.listen(PORT, BIND_HOST, () => {
  const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4').map((a) => a.address);
  log('ZDY FPK listening', { port: PORT, bind: BIND_HOST, addrs, authCode: config.authCode });
});
