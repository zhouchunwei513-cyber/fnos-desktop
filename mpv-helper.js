'use strict';

// mpv-helper.js —— 内置 MPV 播放器的"本地助手服务"
// ----------------------------------------------------------------------------
// 背景与架构（不改现有软件逻辑/操作方式/窗口方式，只给现有嵌入 MPV 补能力）：
//   现有 MPV 是无边框置顶覆盖窗，画面由 mpv 子进程直接绘制，网页 DOM 浮不到它上面，
//   所以控制 UI 仍走 mpv 自带的中文右键菜单（mpv-config/scripts/fnos-menu.lua）。
//   但 lua 做"文件选择对话框 / 在线字幕搜索·下载·解压"很吃力。方案：
//     主进程在 127.0.0.1 随机端口起一个极简 HTTP 服务，只监听本地回环；
//     mpv 内 lua 通过 Windows 自带 curl.exe 调用；
//     所有网络字幕（OpenSubtitles）、zip/gz 解压、本地字幕文件对话框都在【主进程】完成，
//     再通过 mpv 命名管道 JSON-RPC 执行 `sub-add <绝对路径>` 把字幕灌进 mpv。
//   端口经环境变量 FNOS_MPV_HELPER_PORT 在 spawn mpv 时注入，lua 用 os.getenv 读取。
//
// 安全：仅监听 127.0.0.1（不暴露到局域网）；所有请求需带 ?token=<启动时生成>，
//       token 只经环境变量传给本应用自己拉起的 mpv 子进程，不写入任何网页/磁盘。
// 技术基线：Electron 22 + Node 原生（http/https/zlib/fs/child_process），唯一第三方包 adm-zip。

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

let AdmZip = null;
try { AdmZip = require('adm-zip'); } catch (_) { AdmZip = null; }

const SUB_EXTS = ['.srt', '.ass', '.ssa', '.vtt', '.sub'];
const HTTP_OPENSUB_UA = 'FNOS Desktop Player';

// 在线字幕搜索结果内存缓存（key: query|lang -> {ts,list}），10 分钟内复用，二次打开菜单秒出
const SUB_SEARCH_CACHE = new Map();
const SUB_CACHE_TTL = 10 * 60 * 1000;

// 清洗片名，提升在线命中率：去掉扩展名、年份、分辨率、压制组、来源/编码、季集标记中的杂质
function cleanTitle(raw) {
  let t = String(raw || '').replace(/\.(mkv|mp4|avi|ts|m2ts|iso|rmvb|flv|mov|webm|ass|srt)$/i, '');
  // 点/下划线/常见分隔统一为空格
  t = t.replace(/[._\-–]+/g, ' ');
  // 去掉分辨率
  t = t.replace(/\b(2160p|1080p|720p|480p|4k|8k|uhd|hdr|hdr10|dolby|remux)\b/gi, ' ');
  // 去掉来源/压制/编码
  t = t.replace(/\b(bluray|blu-ray|bdrip|bd|web-?dl|webrip|web|dvdrip|dvd|hdtv|hdcam|cam|x264|x265|h264|h265|hevc|aac|ac3|dts|ddp?5?1?|10bit|8bit|6ch|2ch)\b/gi, ' ');
  // 去掉常见站点/压制组括号（[xxx]、【xxx】）
  t = t.replace(/[\[\【].*?[\]\】]/g, ' ');
  // 季集标记：S01E02 / 第x集 / E02，保留主名，去掉 SxxExx（射手按文件名+hash，整名也行；这里仅去掉噪声）
  t = t.replace(/\bs\d{1,2}e\d{1,3}\b/gi, ' ').replace(/第\s*\d+\s*[季集]/g, ' ').replace(/\be\d{1,3}\b/gi, ' ');
  // 年份可保留（帮助匹配），但去掉多余空格
  t = t.replace(/\s+/g, ' ').trim();
  return t || String(raw || '').trim();
}

// ----------------------------- 小工具 -----------------------------
function log(level, event, data) {
  try {
    // 复用主进程的结构化诊断日志（dlog 由 init 注入）；没有则退回 console
    if (typeof global.__mpvHelperLog === 'function') global.__mpvHelperLog(level, 'mpv.sub.' + event, data);
    else if (level === 'warn' || level === 'error') console.warn('[mpv-helper]', event, data || '');
  } catch (_) {}
}

// 字幕缓存目录：appData/fn-electron/cache/subtitle（按需求用 app.getPath('appData') 拼，禁止硬编码 %appdata%）
function getSubtitleCacheDir() {
  let base;
  try {
    const { app } = require('electron');
    base = path.join(app.getPath('appData'), 'fn-electron', 'cache', 'subtitle');
  } catch (_) {
    base = path.join(os.tmpdir(), 'fn-electron', 'cache', 'subtitle');
  }
  try { fs.mkdirSync(base, { recursive: true }); } catch (_) {}
  return base;
}

function safeName(s) {
  return String(s || 'sub').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120) || 'sub';
}

function httpGet(urlStr, headers, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('无效链接')); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(urlStr, { headers: headers || {}, timeout: 25000 }, (res) => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && redirects < 6) {
        res.resume();
        const next = new URL(res.headers.location, urlStr).toString();
        return resolve(httpGet(next, headers, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        // 自动解压 gzip/deflate/br（B站弹幕 xml 等接口按 Accept-Encoding 返回压缩流）
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (_) { /* 解压失败就用原始缓冲 */ }
        resolve(buf);
      });
    });
    req.on('timeout', () => { try { req.destroy(new Error('请求超时')); } catch (_) {} });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  try {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
  } catch (_) {}
}

// POST application/json，返回响应体（自动处理 gzip/deflate）
function httpPostJson(urlStr, payload, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('无效链接')); }
    const lib = u.protocol === 'http:' ? http : https;
    const bodyBuf = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    const req = lib.request(urlStr, {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': bodyBuf.length,
        'Accept-Encoding': 'gzip, deflate'
      }, headers || {}),
      timeout: 25000
    }, (resp) => {
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('HTTP ' + resp.statusCode)); }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(resp.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
        } catch (_) {}
        resolve(buf);
      });
    });
    req.on('timeout', () => { try { req.destroy(new Error('请求超时')); } catch (_) {} });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ----------------------------- 字幕：在线搜索 -----------------------------
// 射手网(伪) assrt.net —— 中文主力字幕源（免登录、网页检索、zip 直链下载，实测可用）。
// 链路：搜索页 /sub/?searchword=<片名>(UTF-8) → 详情页 /xml/sub/<g>/<id>.xml → 下载 /download/<id>/<名>.zip
// 说明：旧 www.shooter.cn/search/<片名>/ 已 404；射手 subapi 按文件哈希匹配、纯片名返空；
//       OpenSubtitles 旧 REST(rest.opensubtitles.org) 已 302 失效。故改用 assrt.net 网页检索。
const ASSRT_BASE = 'https://assrt.net';
const ASSRT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Referer': ASSRT_BASE + '/',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function searchAssrtSubtitle(title, lang) {
  const out = [];
  let searchHtml = '';
  try {
    const buf = await httpGet(ASSRT_BASE + '/sub/?searchword=' + encodeURIComponent(title), ASSRT_HEADERS);
    searchHtml = buf.toString('utf8');
  } catch (e) {
    log('warn', 'assrt.search.fail', { title, err: String(e && e.message || e) });
    return [];
  }
  // 详情页链接：/xml/sub/<g>/<id>.xml（锚点文本为字幕标题）
  const links = [];
  const seen = {};
  let m;
  const re = /href="(\/xml\/sub\/\d+\/\d+\.xml)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = re.exec(searchHtml)) !== null) {
    const u = m[1];
    if (!seen[u]) { seen[u] = 1; links.push({ u: u, name: stripHtml(m[2]) }); }
    if (links.length >= 15) break;
  }
  log('info', 'assrt.search', { title, links: links.length });
  for (const it of links) {
    try {
      const dbuf = await httpGet(ASSRT_BASE + it.u, ASSRT_HEADERS);
      const dh = dbuf.toString('utf8');
      // 标题：<title>片名 (年份) 字幕 - 射手网(伪)</title>
      const titleM = dh.match(/<title>([\s\S]*?)<\/title>/i);
      let pageTitle = titleM ? stripHtml(String(titleM[1]).replace(/字幕[\s\S]*$/, '').replace(/\([0-9]{4}\).*$/, '')) : '';
      // 下载链接：优先 zip（主进程可解压）；rar 无法解压，跳过
      const zipM = dh.match(/\/download\/\d+\/[^"'\s]*?\.zip/i);
      const rarM = dh.match(/\/download\/\d+\/[^"'\s]*?\.rar/i);
      if (!zipM) { log('info', 'assrt.skip', { page: it.u, reason: rarM ? 'rar-only' : 'no-download' }); continue; }
      const dlPath = zipM[0].replace(/&amp;/g, '&');
      const fileM = dh.match(/文件名[：:]\s*([^<\r\n]+)/);
      const fileName = fileM ? stripHtml(fileM[1]) : '';
      let name = cleanSubName(fileName || pageTitle || it.name || title) || (title + ' 字幕');
      // 语言粗判（页面无结构化语言字段，按文件名/标题关键字推断）
      let langLabel = '简体/繁体中文', langCode = 'chn';
      if (/english|英文|[\s.\[]en[\s.\]]/i.test(name + ' ' + pageTitle)) { langLabel = 'English'; langCode = 'eng'; }
      else if (/繁体|繁體|cht|traditional/i.test(name)) { langLabel = '繁体中文'; langCode = 'cht'; }
      out.push({
        id: 'assrt_' + ((dlPath.match(/\/download\/(\d+)\//) || [])[1] || 'x') + '_' + crypto.createHash('md5').update(dlPath).digest('hex').slice(0, 6),
        name,
        lang: lang === 'en' ? 'English' : langLabel,
        langCode: lang === 'en' ? 'eng' : langCode,
        rating: 0,
        downloads: 999999 - out.length,
        format: 'zip',
        downloadUrl: ASSRT_BASE + dlPath,
        zipLink: '',
        source: '射手网(伪)'
      });
      if (out.length >= 20) break;
    } catch (e) { /* 单条详情失败忽略，继续下一条 */ }
  }
  log('info', 'assrt.result', { title, count: out.length });
  return out;
}

function cleanSubName(s) {
  return String(s || '').replace(/[_\-]?射手网[\s\S]*$/i, '').replace(/\s*-\s*字幕下载[\s\S]*$/i, '').replace(/\.(ass|srt|ssa|zip|rar)$/i, '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

// 在线字幕搜索（扁平化：点"在线搜索字幕"直接出结果列表，搜到为空即显示无结果）。
// 主力源：射手网(伪) assrt.net（免登录网页检索 + zip 直链，中文/英文片均可命中）。
async function searchOnlineSubtitle(rawQuery, lang) {
  const title = cleanTitle(rawQuery);
  const ck = (lang || 'zh') + '|' + title;
  const hit = SUB_SEARCH_CACHE.get(ck);
  if (hit && Date.now() - hit.ts < SUB_CACHE_TTL) return hit.list;

  let result = [];
  try {
    const assrt = await searchAssrtSubtitle(title, lang);
    result = assrt.slice(0, 40);
  } catch (e) {
    log('warn', 'sub.search.err', { title, err: String(e && e.message || e) });
  }

  SUB_SEARCH_CACHE.set(ck, { ts: Date.now(), list: result });
  log('info', 'sub.search.done', { query: String(rawQuery).slice(0, 80), cleanTitle: title, count: result.length });
  if (SUB_SEARCH_CACHE.size > 60) {
    const oldest = SUB_SEARCH_CACHE.keys().next().value;
    SUB_SEARCH_CACHE.delete(oldest);
  }
  return result;
}

// ----------------------------- 字幕：下载 + 解压 + 加载 -----------------------------
function pickSubtitleFilesFromZip(zipPath, destDir) {
  if (!AdmZip) throw new Error('缺少解压组件 adm-zip');
  const zip = new AdmZip(zipPath);
  const written = [];
  const entries = zip.getEntries();
  for (const ent of entries) {
    if (ent.isDirectory) continue;
    const name = ent.entryName.split(/[\\/]/).pop() || '';
    const ext = path.extname(name).toLowerCase();
    if (SUB_EXTS.indexOf(ext) < 0) continue;
    const target = path.join(destDir, safeName(path.basename(name, ext) + ext));
    try { fs.writeFileSync(target, ent.getData()); written.push(target); } catch (_) {}
  }
  return written;
}

async function downloadSubtitle(item) {
  const url = String((item && item.downloadUrl) || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('缺少字幕下载地址');
  const dir = getSubtitleCacheDir();
  const stamp = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  // 按下载域名带 Referer/UA：assrt.net 直链需带站点 Referer，否则可能返回错误页
  const dlHeaders = { 'Accept-Encoding': 'gzip', 'User-Agent': ASSRT_HEADERS['User-Agent'] };
  try {
    const u0 = new URL(url);
    if (/assrt\.net$/i.test(u0.hostname) || u0.hostname.endsWith('.assrt.net')) {
      dlHeaders['Referer'] = ASSRT_BASE + '/';
    }
  } catch (_) { /* 链接非法时下方会抛错 */ }
  const raw = await httpGet(url, dlHeaders);
  log('info', 'sub.download', { source: item && item.source, name: String(item && item.name || '').slice(0, 60), bytes: raw.length, head: raw.slice(0, 2).toString('hex') });

  let files = [];
  // 统一字幕文件名：以 item.name（SubFileName 通常已含 .srt/.ass）为基础，缺扩展名才补，避免 .srt.srt
  const baseName = safeName(String(item.name || 'subtitle'));
  const wantExt = (() => {
    const e = '.' + String(item.format || 'srt').toLowerCase().replace(/^\./, '');
    return SUB_EXTS.indexOf(e) >= 0 ? e : (path.extname(baseName) || '.srt');
  })();
  const subPath = () => {
    const stem = path.extname(baseName) ? path.basename(baseName, path.extname(baseName)) : baseName;
    return path.join(dir, stem + wantExt);
  };
  // 1) gzip 单字幕（dl.../filead/<id>.gz）
  try {
    const ungz = zlib.gunzipSync(raw);
    fs.writeFileSync(subPath(), ungz);
    files.push(subPath());
  } catch (eg) {
    // 2) 不是 gzip：可能是 zip 多文件，或已是纯文本
    const head = raw.slice(0, 4);
    const isZip = head[0] === 0x50 && head[1] === 0x4b; // PK
    if (isZip) {
      const zipPath = path.join(dir, 'sub-' + stamp + '.zip');
      fs.writeFileSync(zipPath, raw);
      files = pickSubtitleFilesFromZip(zipPath, dir);
      try { fs.unlinkSync(zipPath); } catch (_) {}
    } else {
      // 纯文本字幕兜底
      fs.writeFileSync(subPath(), raw);
      files.push(subPath());
    }
  }

  // 去重 + 仅保留字幕文件
  files = files.filter((f, i) => f && files.indexOf(f) === i && SUB_EXTS.indexOf(path.extname(f).toLowerCase()) >= 0);
  if (!files.length) {
    // assrt 个别条目下载到的是"网盘链接/积分不足"说明包（zip 内只有 txt/url，或为 HTML 页）
    const isHtml = (raw[0] === 0x3c /* '<' */);
    log('warn', 'sub.download.empty', { source: item && item.source, name: String(item && item.name || '').slice(0, 60), bytes: raw.length, isHtml });
    throw new Error(isHtml ? '该字幕需要登录/积分，换一条试试' : '该字幕为网盘外链，换一条试试');
  }

  // 多字幕文件：交给用户在主进程弹窗选择（禁止默认加载第一个）
  let chosen = files;
  if (files.length > 1) {
    chosen = await pickFilesViaDialog(files);
    if (!chosen || !chosen.length) throw new Error('已取消选择字幕');
  }
  await loadSubtitlesIntoMpv(chosen);
  return { files, loaded: chosen };
}

// 多字幕文件选择：用 Electron 原生 dialog（主进程执行，符合"文件对话框只在主进程"）
function pickFilesViaDialog(filesAbs) {
  return new Promise((resolve) => {
    try {
      const { dialog } = require('electron');
      const labels = filesAbs.map((f) => path.basename(f));
      // 用 showMessageBox 列出文件让用户选（比 showOpenDialog 更贴合"从已解压文件里选"）
      dialog.showMessageBox({
        type: 'info',
        title: '选择要加载的字幕',
        message: '该字幕包含多个文件，请选择要加载的字幕（可取消）：',
        buttons: labels.concat(['取消']),
        cancelId: labels.length,
        defaultId: 0,
        noLink: true
      }).then((r) => {
        const idx = r && r.response;
        if (idx == null || idx >= filesAbs.length) return resolve([]);
        resolve([filesAbs[idx]]);
      }).catch(() => resolve([]));
    } catch (e) { resolve([]); }
  });
}

// 本地字幕文件对话框：过滤 srt/ass/ssa/vtt，回传【绝对路径】
function openSubtitleFileDialog() {
  return new Promise((resolve) => {
    try {
      const { dialog, BrowserWindow } = require('electron');
      const parent = BrowserWindow.getFocusedWindow() || undefined;
      dialog.showOpenDialog(parent, {
        title: '选择本地字幕文件',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '字幕文件', extensions: ['srt', 'ass', 'ssa', 'vtt', 'sub'] }, { name: '所有文件', extensions: ['*'] }]
      }).then((r) => {
        if (r && !r.canceled && Array.isArray(r.filePaths) && r.filePaths.length) {
          resolve(r.filePaths.map((f) => path.resolve(f)));
        } else resolve([]);
      }).catch(() => resolve([]));
    } catch (e) { resolve([]); }
  });
}

// 把字幕文件通过 mpv JSON-RPC `sub-add` 加载进当前活动 mpv（绝对路径）
async function loadSubtitlesIntoMpv(absPaths) {
  const player = global.__mpvHelperGetActivePlayer && global.__mpvHelperGetActivePlayer();
  if (!player || typeof player.command !== 'function') throw new Error('播放器未就绪');
  let okCount = 0;
  for (const f of absPaths) {
    const abs = path.resolve(f);
    // mpv sub-add：<绝对路径> select(自动选中) title
    try { await player.command(['sub-add', abs.replace(/\//g, '\\'), 'select', path.basename(abs)]); okCount++; }
    catch (e) { log('warn', 'subadd-fail', { file: abs, err: String(e && e.message || e) }); }
  }
  // 确保字幕可见
  try { await player.command(['set_property', 'sub-visibility', 'yes']); } catch (_) {}
  if (!okCount) throw new Error('字幕加载失败');
  return okCount;
}

// ----------------------------- 弹幕：B站数据源（免 Key，公开接口） -----------------------------
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BILI_HEADERS = { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/', 'Accept': 'application/json, text/xml, */*' };

function biliGetText(urlStr) {
  return httpGet(urlStr, BILI_HEADERS, 2).then(b => b.toString('utf8'));
}

// ---- B 站 wbi 签名（search/type 等 wbi 端点必须签名，否则风控返回空）----
const WBI_MIXIN_TAB = [
  46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,
  12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,
  57,62,11,36,20,34,44,52
];
let _wbiKeys = null; // {imgKey, subKey, ts}
async function getWbiKeys() {
  const now = Date.now();
  if (_wbiKeys && now - _wbiKeys.ts < 30 * 60 * 1000) return _wbiKeys;
  const txt = await biliGetText('https://api.bilibili.com/x/web-interface/nav');
  let j; try { j = JSON.parse(txt); } catch (e) { j = null; }
  const wbi = j && j.data && j.data.wbi_img;
  if (!wbi || !wbi.img_url) throw new Error('wbi keys unavailable');
  const base = (u) => String(u || '').split('/').pop().split('.')[0];
  _wbiKeys = { imgKey: base(wbi.img_url), subKey: base(wbi.sub_url), ts: now };
  return _wbiKeys;
}
async function biliSignedUrl(baseUrl, params) {
  const keys = await getWbiKeys();
  const mixinRaw = keys.imgKey + keys.subKey;
  let mixin = '';
  for (const i of WBI_MIXIN_TAB) mixin += mixinRaw[i];
  mixin = mixin.slice(0, 32);
  const q = Object.assign({}, params);
  q.wts = Math.round(Date.now() / 1000);
  const keys2 = Object.keys(q).sort();
  const parts = [];
  for (const k of keys2) {
    const v = String(q[k] == null ? '' : q[k]).replace(/[!'()*]/g, '');
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  const w_rid = crypto.createHash('md5').update(parts.join('&') + mixin).digest('hex');
  parts.push('w_rid=' + w_rid);
  return baseUrl + '?' + parts.join('&');
}

// 用片名搜索 B 站视频，返回候选（bvid/标题/时长/作者），弹幕通常聚集在完整正片/合集
async function searchBiliVideos(keyword) {
  let url;
  try {
    url = await biliSignedUrl('https://api.bilibili.com/x/web-interface/wbi/search/type', {
      search_type: 'video', order: 'totalrank', page: 1, keyword: keyword
    });
  } catch (e) {
    // wbi 取不到 key 时回退旧 URL（尽力而为）
    url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&order=totalrank&page=1&' +
      'keyword=' + encodeURIComponent(keyword);
  }
  const txt = await biliGetText(url);
  let j; try { j = JSON.parse(txt); } catch (e) { j = null; }
  const out = [];
  const arr = (j && j.data && Array.isArray(j.data.result)) ? j.data.result : [];
  for (const it of arr) {
    if (!it || !it.bvid) continue;
    const title = String(it.title || '').replace(/<[^>]+>/g, '');
    const dur = String(it.duration || '');
    // 时长 "HH:MM:SS" / "MM:SS" 转秒
    let sec = 0; const parts = dur.split(':').map(Number);
    for (const p of parts) { if (!isNaN(p)) sec = sec * 60 + p; }
    out.push({ bvid: it.bvid, cid: it.cid ? Number(it.cid) : 0, aid: it.aid ? Number(it.aid) : 0,
      title, author: it.author || '', duration: sec, play: Number(it.play) || 0 });
    if (out.length >= 25) break;
  }
  return out;
}

// 取某视频的分页列表（bvid -> cid）。
// 注意：必须用 bvid 请求。search/type 返回的 aid 是加密/旧字段，传给 pagelist?aid= 会报错取不到 cid，
// 曾导致"搜索到 20 条但全部 cid=0、弹幕结果为 0"。bvid 稳定可靠。
async function biliPagelist(bvid /*, aid 已弃用，保留参数位不影响调用方 */) {
  if (!bvid) return [];
  const url = 'https://api.bilibili.com/x/player/pagelist?bvid=' + encodeURIComponent(bvid);
  const txt = await biliGetText(url);
  let j; try { j = JSON.parse(txt); } catch (e) { j = null; }
  const arr = (j && j.code === 0 && Array.isArray(j.data)) ? j.data : [];
  if (!arr.length) log('warn', 'bili.pagelist.empty', { bvid, code: j && j.code, msg: j && j.message });
  return arr.map(p => ({ cid: Number(p.cid), page: p.page, part: p.part || '', duration: Number(p.duration) || 0 }));
}

// 最小 protobuf 读取器（仅解码 B 站弹幕 seg.so 需要的字段）
function parseBiliSegProto(buf) {
  const out = [];
  let i = 0;
  const readVarint = () => { let s = 0, r = 0; while (true) { const b = buf[i++]; r |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; } return r >>> 0; };
  while (i < buf.length) {
    const tag = readVarint(); const field = tag >> 3, wt = tag & 7;
    if (wt === 0) { readVarint(); }
    else if (wt === 2) {
      const len = readVarint(); const val = buf.slice(i, i + len); i += len;
      if (field === 1) { // DanmakuElem
        let j = 0; let prog = 0, mode = 1, fs = 25, color = 0xffffff, content = '';
        const rv = () => { let s = 0, r = 0; while (true) { const b = val[j++]; r |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; } return r >>> 0; };
        let safe = 0;
        while (j < val.length && safe++ < 200) {
          const t = rv(); const f = t >> 3, w = t & 7;
          if (w === 0) { const v = rv(); if (f === 2) prog = v; else if (f === 3) mode = v; else if (f === 4) fs = v; else if (f === 5) color = v; }
          else if (w === 2) { const l = rv(); const s2 = j; j += l; if (f === 7) { try { content = val.slice(s2, j).toString('utf8'); } catch (_) {} } }
          else break;
        }
        content = String(content || '').replace(/\s+/g, ' ').trim();
        if (content) {
          if (content.length > 80) content = content.slice(0, 80);
          out.push({ t: Math.round((prog / 1000) * 1000) / 1000, text: content, color, size: fs, type: mode });
        }
      }
    } else break;
  }
  return out;
}

// 生成随机 buvid3（降低数据中心/无 cookie 时 B 站风控导致 seg.so 返回空的概率）
function _biliBuvid() {
  const hex = crypto.randomBytes(16).toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20) + 'infoc';
}
let _biliCookie = null;
function biliHeaders() {
  if (!_biliCookie) _biliCookie = 'buvid3=' + _biliBuvid() + '; buvid4=' + crypto.randomBytes(16).toString('hex');
  return Object.assign({}, BILI_HEADERS, { 'Cookie': _biliCookie });
}

// 解析历史 XML 弹幕（<d p="出现时间,模式,字号,颜色,...">文本</d>），作为 seg.so 被风控时的回退。
function parseBiliXml(buf) {
  const t = buf.toString('utf8');
  const out = [];
  const re = /<d\s+[^>]*p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const f = m[1].split(',');
    const prog = parseFloat(f[0]) || 0;
    const mode = parseInt(f[1], 10) || 1;
    const fs = parseInt(f[2], 10) || 25;
    const color = parseInt(f[3], 10) || 0xffffff;
    let text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text) {
      if (text.length > 80) text = text.slice(0, 80);
      out.push({ t: Math.round(prog * 1000) / 1000, text, color, size: fs, type: mode });
    }
  }
  return out;
}

// 拉取并解析某 cid 的弹幕：优先 seg.so（protobuf，按每 6 分钟一段）；
// 若 seg.so 被风控（返回字节数很小/无弹幕元素），回退历史 XML 接口（comment.bilibili.com）。
// light=true 时只拉前几段用于搜索预览计数（轻量），否则拉全片。
async function fetchBiliDanmaku(cid, light) {
  let out = [];
  const maxSeg = light ? 3 : 60; // 预览取前 3 段（约 18 分钟）估算密度
  let segOk = false;
  for (let seg = 1; seg <= maxSeg; seg++) {
    let batch;
    try {
      const url = 'https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=' + cid + '&segment_index=' + seg;
      const buf = await httpGet(url, biliHeaders(), 2);
      batch = parseBiliSegProto(buf);
    } catch (e) { break; }
    if (!batch || !batch.length) { break; }
    segOk = true;
    for (const d of batch) out.push(d);
    if (light && out.length > 400) break; // 预览足够
    if (!light && batch.length < 5) break; // 末段通常很少
  }
  // seg.so 风控回退：历史 XML 弹幕（无需登录）
  if (!segOk || out.length === 0) {
    try {
      const xbuf = await httpGet('https://comment.bilibili.com/' + cid + '.xml', biliHeaders(), 2);
      const xmlDm = parseBiliXml(xbuf);
      log('info', 'danmaku.xml-fallback', { cid: String(cid), count: xmlDm.length });
      for (const d of xmlDm) out.push(d);
    } catch (e) { log('warn', 'danmaku.xml-fallback-fail', { cid: String(cid), err: String(e && e.message || e) }); }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// 搜索弹幕：返回候选视频（含弹幕数预览，便于用户选择最匹配正片）
async function danmakuSearch(keyword) {
  log('info', 'danmaku.search.req', { keyword: String(keyword || '').slice(0, 80) });
  const videos = await searchBiliVideos(keyword);
  log('info', 'danmaku.search.videos', { keyword: String(keyword || '').slice(0, 40), videos: Array.isArray(videos) ? videos.length : 0 });
  // 正片判定：时长 ≥ 40 分钟优先；其次按时长、再按播放量。避免把"解说/混剪"排在完整正片前。
  const isFull = (s) => s >= 2400;
  const ranked = videos.slice().sort((a, b) => {
    const fa = isFull(a.duration) ? 1 : 0, fb = isFull(b.duration) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    if (a.duration >= 600 && b.duration >= 600 && Math.abs(a.duration - b.duration) > 600) return b.duration - a.duration;
    return b.play - a.play;
  });
  const top = ranked.slice(0, 12);
  const results = [];
  for (const v of top) {
    try {
      let cid = v.cid;
      if (!cid) {
        const pages = await biliPagelist(v.bvid, v.aid);
        // 正片取最长分页
        pages.sort((a, b) => b.duration - a.duration);
        cid = pages.length ? pages[0].cid : 0;
      }
      if (!cid) continue;
      const dm = await fetchBiliDanmaku(cid, true);
      if (!dm.length) continue;
      results.push({
        id: String(cid), // 用 cid 作为下载键
        bvid: v.bvid, cid,
        name: v.title + (v.author ? ' · ' + v.author : '') + '（约' + dm.length + '+条弹幕）',
        title: v.title, count: dm.length, duration: v.duration
      });
      if (results.length >= 8) break;
    } catch (e) { log('warn', 'danmaku.search.item', { err: String(e && e.message || e) }); }
  }
  log('info', 'danmaku.search.done', { keyword: String(keyword || '').slice(0, 40), results: results.length });
  return results;
}

async function danmakuDownload(cid) {
  const list = await fetchBiliDanmaku(Number(cid));
  log('info', 'danmaku.download', { cid: String(cid), count: list.length });
  if (!list.length) throw new Error('该视频暂无弹幕');
  return { ok: true, count: list.length, danmaku: list };
}

// 画中画：mode='enter'|'exit'|'toggle'，sizePx 小窗宽度。几何/窗口由主进程负责。
function togglePip(mode, sizePx) {
  try {
    if (typeof global.__mpvHelperSetPiP === 'function') return global.__mpvHelperSetPiP(mode || 'toggle', sizePx);
    if (typeof global.__mpvHelperTogglePip === 'function') return global.__mpvHelperTogglePip(mode, sizePx);
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  return { ok: false, error: '画中画不可用' };
}

// 把弹幕 JSON 通过 mpv IPC 推给弹幕渲染脚本
async function pushDanmakuToMpv(danmaku, key) {
  try {
    if (typeof global.__mpvHelperSendPlayerCommand === 'function') {
      const payload = JSON.stringify({ danmaku });
      const r = await global.__mpvHelperSendPlayerCommand([
        'script-message', 'fnos-danmaku-data', payload, String(key || '')
      ]);
      log('info', 'danmaku.push', { key: String(key || ''), count: Array.isArray(danmaku) ? danmaku.length : 0, ok: !!(r && r.ok), error: (r && r.error) || '' });
      return r;
    }
    log('warn', 'danmaku.push', { key: String(key || ''), error: 'no-send-channel' });
  } catch (e) { log('warn', 'danmaku.push', { key: String(key || ''), error: String(e && e.message || e) }); return { ok: false, error: String(e && e.message || e) }; }
  return { ok: false, error: '弹幕通道不可用' };
}

// ----------------------------- HTTP 服务 -----------------------------
let server = null;
let token = '';

function start() {
  if (server) return Promise.resolve({ port: getPort(), token });
  token = crypto.randomBytes(12).toString('hex');
  return new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.searchParams.get('token') !== token) return sendJson(res, 403, { ok: false, error: 'forbidden' });
        const route = u.pathname;
        const body = req.method === 'POST' ? await readBody(req) : {};

        if (route === '/ping') return sendJson(res, 200, { ok: true, pip: !!global.__mpvHelperPip });

        if (route === '/subtitle/search') {
          const q = body.filename || body.title || body.query || body.keyword || '';
          log('info', 'sub.search.req', { raw: String(q).slice(0, 80), lang: body.lang || 'zh' });
          const list = await searchOnlineSubtitle(q, body.lang || 'zh');
          return sendJson(res, 200, { ok: true, results: list });
        }
        if (route === '/subtitle/download') {
          const r = await downloadSubtitle(body.item || {});
          return sendJson(res, 200, { ok: true, loaded: r.loaded, count: r.loaded.length });
        }
        if (route === '/subtitle/open-dialog') {
          const files = await openSubtitleFileDialog();
          if (files && files.length) {
            await loadSubtitlesIntoMpv(files);
            return sendJson(res, 200, { ok: true, loaded: files });
          }
          return sendJson(res, 200, { ok: true, loaded: [], cancelled: true });
        }
        if (route === '/pip/toggle') {
          // togglePip 返回 Promise，必须 await 后再序列化；否则 JSON.stringify(Promise)==='{}'，
          // lua 端 data.ok 为 nil 会误报"画中画切换失败"（而后端其实已切换成功）。
          const pipMode = body.mode || 'toggle';
          let r;
          try {
            r = await togglePip(pipMode, body.size);
          } catch (e) {
            r = { ok: false, error: String(e && e.message || e), pip: false };
          }
          log(r && r.ok ? 'info' : 'warn', 'pip.toggle', { mode: pipMode, size: body.size || 0, ok: !!(r && r.ok), pip: !!(r && r.pip), error: r && r.error || '' });
          return sendJson(res, 200, r || { ok: false, error: '无结果', pip: false });
        }
        if (route === '/danmaku/search') {
          const list = await danmakuSearch(body.keyword || body.filename || body.query || '');
          return sendJson(res, 200, { ok: true, results: list });
        }
        if (route === '/danmaku/download') {
          const r = await danmakuDownload(body.cid || body.id);
          if (r.ok && r.danmaku && r.danmaku.length) {
            await pushDanmakuToMpv(r.danmaku, body.cid || body.id);
          }
          return sendJson(res, 200, { ok: r.ok, count: r.count });
        }
        return sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        log('warn', 'http-err', { err: String(e && e.message || e) });
        sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
      }
    });
    server.on('error', (e) => { log('error', 'server-error', { err: String(e && e.message || e) }); server = null; });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      log('info', 'helper-up', { port: addr && addr.port });
      resolve({ port: addr && addr.port, token });
    });
  });
}

function getPort() { return server && server.address() ? server.address().port : 0; }
function getToken() { return token; }

module.exports = { start, getPort, getToken };
