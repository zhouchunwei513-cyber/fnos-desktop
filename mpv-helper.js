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
      res.on('end', () => resolve(Buffer.concat(chunks)));
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

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ----------------------------- 字幕：在线搜索 -----------------------------
async function searchOnlineSubtitle(query, lang) {
  const q = safeName(query).replace(/_/g, '-');
  const isEn = lang === 'en';
  // 中文先查繁体(zht)，为空再回退简体(chi)；英文直接 eng。
  const codeSeq = isEn ? ['eng'] : ['zht', 'chi'];
  let arr = null;
  for (const code of codeSeq) {
    const url = 'https://rest.opensubtitles.org/search/query-' + encodeURIComponent(q) + '/sublanguageid-' + code;
    const body = await httpGet(url, { 'User-Agent': HTTP_OPENSUB_UA, 'Accept': 'application/json' });
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); } catch (e) { parsed = null; }
    if (Array.isArray(parsed) && parsed.length) { arr = parsed; break; }
  }
  if (!arr) arr = [];
  const out = [];
  for (const r of arr) {
    if (!r || !r.IDSubtitleFile) continue;
    const link = r.SubDownloadLink || '';
    if (!link) continue;
    out.push({
      id: String(r.IDSubtitleFile),
      name: r.SubFileName || ('字幕 ' + r.IDSubtitleFile),
      lang: r.LanguageName || r.SubLanguageID || '',
      langCode: r.SubLanguageID || '',
      rating: (r.SubRating != null ? Number(r.SubRating) : 0) || 0,
      downloads: r.SubDownloadsCnt != null ? Number(r.SubDownloadsCnt) : 0,
      format: (r.SubFormat || '').toLowerCase(),
      downloadUrl: link,
      zipLink: r.ZipDownloadLink || ''
    });
    if (out.length >= 30) break;
  }
  // 下载量高的优先
  out.sort((a, b) => b.downloads - a.downloads);
  return out;
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
  const raw = await httpGet(url, { 'User-Agent': HTTP_OPENSUB_UA, 'Accept-Encoding': 'gzip' });

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
  if (!files.length) throw new Error('字幕包内未识别到 srt/ass/ssa/vtt 文件');

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

// 画中画：切换小窗/还原。实际窗口几何由主进程负责（要与 Electron 几何跟随协调）。
function togglePip() {
  try {
    if (typeof global.__mpvHelperTogglePip === 'function') return global.__mpvHelperTogglePip();
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  return { ok: false, error: '画中画不可用' };
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
          const list = await searchOnlineSubtitle(body.filename || body.query || '', body.lang || 'zh');
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
          return sendJson(res, 200, togglePip());
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
