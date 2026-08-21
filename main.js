/**
 * FNOS 桌面客户端 - 主进程 (v1.7.0)
 *
 * 核心设计：
 *  - 每个服务器使用独立的 persist partition，保持各自登录态。
 *  - 多窗口管理：从飞牛主页打开的每个应用/程序在独立的 BrowserWindow 中运行，
 *    返回主页时可选择"后台运行"（保留窗口与状态）或"退出"（关闭窗口）。
 *  - 系统托盘：列出所有已打开窗口，双击图标显示/隐藏主窗口，右键切换窗口。
 *  - 关闭主窗口时弹出"隐藏到托盘 / 退出"选择；用户偏好可记忆。
 *  - v1.7.0：修复玻璃对话框按钮无响应（独立 preload + contextBridge）；菜单栏改为常驻显示。
 *  - 帮助菜单：操作步骤；关于菜单：版本更新内容。
 */
const {
  app, BrowserWindow, Menu, shell, session, ipcMain, dialog, screen, Tray, nativeImage, safeStorage,
  globalShortcut, net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const cp = require('child_process');

// 版本号（与 package.json 保持一致）
const APP_VERSION = '1.10.5';

// Windows 任务栏 / 通知分组所需的 AppUserModelID（必须与 package.json build.appId 一致）
// 未设置时 Windows 会把 Electron 应用归到默认 Electron AUMID，导致任务栏图标显示为 Electron 默认图标
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.fnos.client'); } catch (_) {}
}

// ---------------------- 启动性能开关 ----------------------
// v1.10.5: 重要红线 —— 不影响 NAS 服务器内已安装/将来安装的应用启动与运行。
// 之前为了"性能优化"禁用了 MediaRouter / CastMediaRouteProvider / DialMediaRouteProvider /
// GlobalMediaControls / HardwareMediaKeyHandling 等服务，这些会影响飞牛影视的投屏、
// 媒体控制、硬件多媒体键等功能，v1.10.5 全部恢复，只保留与 NAS 业务无关、纯性能向的开关。
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', [
  'CalculateNativeWinOcclusion',    // 减少窗口遮挡检测开销（不影响业务）
  'Translate',                      // 不需要网页翻译
  'InterestFeedContentSuggestions', // 不需要内容推荐
  'UseChromeOSDirectVideoDecoder',  // Win 上走其他解码器
  'BackForwardCache',               // 关闭 BFC 避免飞牛多窗口状态错乱
  'LazyFrameLoading',               // 子窗口立即加载，避免后台 frame 冻结
  'PrivacySandboxSettings4',        // 隐私沙盒相关，与 NAS 无关
  'OptimizationHints',              // Chrome 优化提示，与 NAS 无关
  'MediaFeeds',                     // 媒体订阅 feed，NAS 不用
].join(','));
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('enable-features', [
  'CanvasOopRasterization',
  'VaapiVideoDecoder',
  'VaapiVideoEncoder',
  'MediaFoundationVideoCapture',
  'RawDraw',
  'ScrollPredictorSmoothness',
  'GpuMemoryBufferCompositorResources',
].join(','));
app.commandLine.appendSwitch('enable-async-dns');
// v1.10.5: 移除 max-connections-per-host=32 和 enable-parallel-downloading
// 原因：过高的并发连接数 + Chromium 并行下载特性，会让部分 NAS（飞牛、群晖等）的
// 下载网关误认为同一文件发起了两次请求，表现为弹出两个保存对话框，甚至触发服务端
// 异常的临时文件清理逻辑。恢复 Chromium 默认值更安全。
app.commandLine.appendSwitch('enable-quic');
app.commandLine.appendSwitch('disk-cache-size', '104857600');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512 --concurrent-recompilation --lite-mode');
// 额外性能/响应速度优化
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-crash-reporter');
app.commandLine.appendSwitch('disable-hang-monitor');
app.commandLine.appendSwitch('disable-ipc-flooding-protection');
app.commandLine.appendSwitch('disable-print-preview');
app.commandLine.appendSwitch('disable-bundled-ppapi-flash');
app.commandLine.appendSwitch('safebrowsing-disable-auto-update');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-precise-memory-info');
app.commandLine.appendSwitch('enable-scroll-prediction');
app.commandLine.appendSwitch('enable-aggressive-domstorage-flushing');

// v1.10.0：修复部分 ARM64 / 集显设备上飞牛影视/音乐出现绿屏或花屏
// - 在 ARM64 设备上禁用硬件加速视频解码（软解），保留 GPU 合成
// - x64 设备保留硬解，发挥显卡解码性能
try {
  const arch = process.arch || '';
  const isArm = arch === 'arm64' || (process.env.PROCESSOR_ARCHITECTURE || '').toLowerCase().includes('arm');
  if (isArm) {
    app.commandLine.appendSwitch('disable-accelerated-video-decode');
    app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
  }
} catch (_) {}

const APP_NAME = 'FNOS';
const IS_DEV = !app.isPackaged;
const LOGIN_PAGE = path.join(__dirname, 'login.html');
const HELP_PAGE = path.join(__dirname, 'help.html');
const DIALOG_PAGE = path.join(__dirname, 'dialog.html');
const DIALOG_PRELOAD = path.join(__dirname, 'dialog-preload.js');
const LOCK_PAGE = path.join(__dirname, 'lock.html');
const LOCK_PRELOAD = path.join(__dirname, 'lock-preload.js');
const SETTINGS_PAGE = path.join(__dirname, 'settings.html');
const SETTINGS_PRELOAD = path.join(__dirname, 'settings-preload.js');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const ICON_PATH = path.join(__dirname, 'icon.ico');
const ICON_PNG = path.join(__dirname, 'icon.png');

const DEFAULT_SHORTCUTS = { lockApp: 'Ctrl+Alt+L', hideAll: 'Ctrl+Alt+H' };
const GITHUB_REPO = 'zhouchunwei513-cyber/fnos-desktop';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

async function checkGitLatestTag() {
  // v1.10.5:
  //  - 使用 Electron net 模块（默认遵循系统代理，开了 Clash/v2ray 等会自动走代理）
  //  - 超时延长到 25 秒（GitHub API 国内偶尔慢）
  //  - 失败时自动重试 1 次
  //  - 显式调用 session.defaultSession.resolveProxy，确保走系统代理
  const ses = session.defaultSession;

  async function onceAttempt() {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { r.abort(); } catch (_) {}
        fn(v);
      };
      const timer = setTimeout(() => {
        finish(reject, new Error('连接 GitHub 超时（25 秒）'));
      }, 25000);

      const r = net.request({
        method: 'GET',
        url: RELEASES_API,
        redirect: 'follow',
        session: ses, // 显式使用 defaultSession，走系统代理
        credentials: 'omit',
        useSessionCookies: false,
        cache: 'no-store',
      });
      r.setHeader('User-Agent', `FNOS-Desktop/${APP_VERSION}`);
      r.setHeader('Accept', 'application/vnd.github+json');
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const data = JSON.parse(body);
          if (data && data.tag_name) {
            finish(resolve, {
              tag: String(data.tag_name).replace(/^v/i, ''),
              name: data.name || data.tag_name,
              notes: data.body || '',
              html_url: data.html_url || RELEASES_PAGE,
            });
          } else if (data && data.message) {
            finish(reject, new Error(String(data.message)));
          } else {
            finish(reject, new Error('未检查到发布版本'));
          }
        } catch (e) { finish(reject, e); }
      });
      r.on('error', (err) => finish(reject, err));
      r.end();
    });
  }

  // 解析系统代理（仅用于诊断，真正的代理使用由 Electron net 自动处理）
  let proxyInfo = 'direct';
  try {
    proxyInfo = await new Promise((resolve) => {
      ses.resolveProxy(RELEASES_API, (p) => resolve(p || 'direct'));
    });
  } catch (_) {}
  console.log(`[update] using proxy: ${proxyInfo}`);

  try {
    return await onceAttempt();
  } catch (e1) {
    console.warn('[update] first attempt failed:', e1?.message, '— retrying...');
    await new Promise((r) => setTimeout(r, 1200));
    return await onceAttempt();
  }
}

async function checkForUpdates(interactive = true) {
  // v1.10.5: 统一使用玻璃风格对话框（和软件其他提示一致），不再自绘 dataURL 弹窗
  let checkingWin = null;
  if (interactive) {
    try {
      // 用 glassMessageBox 显示"正在检查..."的无按钮提示（带转圈通过 detail 中的字符）
      const parentWin = (mainWindow && !mainWindow.isDestroyed())
        ? mainWindow
        : (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]);
      if (parentWin) {
        checkingWin = new BrowserWindow({
          width: 320, height: 130,
          frame: false, transparent: true, resizable: false,
          minimizable: false, maximizable: false, fullscreenable: false,
          alwaysOnTop: true, skipTaskbar: true, show: false,
          parent: undefined, modal: false,
          backgroundColor: '#00000000',
          icon: ICON_PATH,
          webPreferences: {
            contextIsolation: true, nodeIntegration: false, sandbox: false,
            spellcheck: false, backgroundThrottling: false,
          },
        });
        // 玻璃风格：dialog.css 已经定义了 .glass / .glass-card / .btn-primary 等
        const html = `<!doctype html><html><head><meta charset="utf-8">
          <link rel="stylesheet" href="dialog.css">
          <style>
            html,body{margin:0;padding:0;background:transparent;height:100%;overflow:hidden;}
            body{display:flex;align-items:center;justify-content:center;font-family:"Microsoft YaHei","PingFang SC",sans-serif;}
            .glass-card{
              width:280px;padding:22px 22px;border-radius:18px;text-align:center;
              background:linear-gradient(155deg,rgba(20,24,38,.86),rgba(10,12,20,.78));
              border:1px solid rgba(255,255,255,.14);
              box-shadow:0 20px 50px -12px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.15);
              backdrop-filter:blur(28px) saturate(160%);
              -webkit-backdrop-filter:blur(28px) saturate(160%);
              color:#e9efff;
            }
            .sp{
              width:24px;height:24px;margin:0 auto 12px;
              border:3px solid rgba(255,255,255,.18);
              border-top-color:#7cecff;border-right-color:#7c83ff;
              border-radius:50%;animation:r 1s linear infinite;
            }
            @keyframes r{to{transform:rotate(360deg)}}
            .t{font-size:13px;letter-spacing:2px;font-weight:600;}
          </style></head>
          <body><div class="glass-card"><div class="sp"></div><div class="t">正在检查更新…</div></div></body></html>`;
        checkingWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
        checkingWin.once('ready-to-show', () => { try { checkingWin.showInactive(); } catch (_) {} });
      }
    } catch (_) {}
  }
  const closeChecking = () => {
    try { if (checkingWin && !checkingWin.isDestroyed()) checkingWin.close(); } catch (_) {}
    checkingWin = null;
  };
  try {
    const info = await checkGitLatestTag();
    closeChecking();
    const latest = info.tag.replace(/^v/i, '');
    const cmp = compareVersions(latest, APP_VERSION);
    const parentWin = (mainWindow && !mainWindow.isDestroyed())
      ? mainWindow
      : (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]);
    if (!parentWin) return;
    if (cmp > 0) {
      const detail = (info.notes || '').trim().slice(0, 500);
      const { response } = await glassMessageBox(parentWin, {
        type: 'info',
        title: `发现新版本 v${latest}`,
        detail: detail
          ? `${detail}\n\n点击「前往下载」将在浏览器中打开 GitHub Release 页面。`
          : '点击「前往下载」将在浏览器中打开 GitHub Release 页面。',
        buttons: ['前往下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
        width: 520,
      });
      if (response === 0) shell.openExternal(info.html_url || RELEASES_PAGE).catch(() => {});
    } else if (interactive) {
      await glassMessageBox(parentWin, {
        type: 'info',
        title: '已是最新版本',
        detail: `当前版本 v${APP_VERSION} 已是最新版本。`,
        buttons: ['确定'],
        defaultId: 0,
        cancelId: 0,
      });
    }
  } catch (err) {
    closeChecking();
    if (interactive) {
      const w = (mainWindow && !mainWindow.isDestroyed())
        ? mainWindow
        : (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]);
      if (w) {
        await glassErrorBox('检查更新失败',
          `无法连接到 GitHub：\n${err?.message || err}\n\n` +
          `如果你正在使用代理软件，请确认其处于"系统代理"或"TUN 模式"；` +
          `也可以稍后重试，或直接访问：\n${RELEASES_PAGE}`);
      }
    }
  }
}


let mainWindow = null;
let tray = null;
let lockWindow = null;
let settingsWindow = null;
let currentOrigin = '';
let lastConnectHref = '';
let currentPartition = 'persist:connect';
let cachedSettings = null;
let appWindows = []; // {win, title, url, isMain}
let menuRebuildTimer = null;
let isSwitchingPartition = false;
let isLocked = false;
let isCompletelyHidden = false; // 一键隐藏：连托盘也隐藏

// ---------------------- 单实例锁 ----------------------
if (!app.requestSingleInstanceLock()) app.quit();

// ---------------------- 设置持久化 ----------------------
function defaultSettings() {
  return {
    server: '',
    origin: '',
    lastConnectHref: '',
    history: [],
    currentPartition: 'persist:connect',
    closeAction: '', // 'tray' | 'exit'
    // 启动密码（scrypt 哈希 + 随机 salt），明文永不落盘
    appPasswordHash: '',
    appPasswordSalt: '',
    // 全局快捷键（accelerator 字符串），空字符串表示禁用
    shortcuts: { ...DEFAULT_SHORTCUTS },
    // v1.10.0：URL 重写映射，用于外网访问应用时端口/域名映射
    // 格式：[{from:'http://192.168.1.10:5666', to:'https://nas.example.com:10443'}, ...]
    urlMappings: [],
    // v1.10.0：菜单栏自动隐藏（按 Alt 显示）
    autoHideMenuBar: false,
    // v1.10.0：CORS 绕过（直播源跨域），默认开启
    bypassCors: true,
    // v1.10.2：实验性玻璃标题栏（默认关闭，不改变原功能）
    glassTitleBar: false,
    // v1.10.2：主题色（仅影响标题栏叠加色，不动页面内配色）
    // 可选：'#1e1b2e'（默认深紫黑）、'#0f172a'（深蓝）、'#101828'（纯黑）、'#1f2937'（石墨）、'#312e81'（靛蓝）、'#831843'（酒红）
    themeColor: '#1e1b2e',
  };
}

// 把 #RRGGBB 转成 Electron titleBarOverlay 需要的 [r,g,b,a]
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return [30, 27, 46, alpha == null ? 190 : alpha];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha == null ? 190 : alpha];
}

// ---------------------- 启动密码哈希（scrypt + 随机 salt） ----------------------
function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
}
function verifyAppPassword(password) {
  const s = loadSettings();
  if (!s.appPasswordHash || !s.appPasswordSalt) return !password; // 无密码时空密码通过
  if (!password) return false;
  try {
    const hash = hashPassword(password, s.appPasswordSalt);
    // 时序安全比较
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(s.appPasswordHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}
function setAppPassword(oldPassword, newPassword) {
  const s = loadSettings();
  if (s.appPasswordHash) {
    if (!verifyAppPassword(oldPassword || '')) {
      const err = new Error('当前密码不正确');
      err.code = 'BAD_OLD_PASSWORD';
      throw err;
    }
  }
  if (newPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(newPassword, salt);
    saveSettings({ appPasswordHash: hash, appPasswordSalt: salt });
  } else {
    // 清除密码
    saveSettings({ appPasswordHash: '', appPasswordSalt: '' });
  }
  return true;
}
function hasAppPassword() {
  const s = loadSettings();
  return !!(s.appPasswordHash && s.appPasswordSalt);
}

// 使用系统凭据加密保存登录信息/历史/个人偏好（v1.7.0）
function isEncryptionAvailable() {
  try { return safeStorage && safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}
function encryptString(plain) {
  if (!isEncryptionAvailable() || plain == null) return plain;
  try {
    return 'enc:' + safeStorage.encryptString(String(plain)).toString('base64');
  } catch (_) { return plain; }
}
function decryptString(token) {
  if (typeof token !== 'string' || !token.startsWith('enc:')) return token;
  if (!isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(token.slice(4), 'base64'));
  } catch (_) { return ''; }
}

function loadSettings() {
  if (cachedSettings) return cachedSettings;
  let raw = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const text = fs.readFileSync(SETTINGS_FILE, 'utf-8').trim();
      if (text) {
        const parsed = JSON.parse(text);
        // 加密文件格式：{ __enc__: "base64(encrypt(JSON.stringify(settings)))" }
        if (parsed && parsed.__enc__) {
          const json = decryptString(parsed.__enc__);
          raw = json ? JSON.parse(json) : {};
        } else {
          // 兼容旧版本明文设置
          raw = parsed || {};
        }
      }
    }
  } catch (_) { raw = {}; }
  cachedSettings = { ...defaultSettings(), ...raw };
  if (!Array.isArray(cachedSettings.history)) cachedSettings.history = [];
  if (!Array.isArray(cachedSettings.urlMappings)) cachedSettings.urlMappings = [];
  cachedSettings.shortcuts = { ...DEFAULT_SHORTCUTS, ...(raw.shortcuts || {}) };
  return cachedSettings;
}

// v1.10.0：URL 重写（外网访问端口/域名映射）
// urlMappings: [{from:'http://192.168.1.10:5666', to:'https://nas.example.com:10443'}]
// 也支持 from 为前缀匹配（不带协议时按 host:port 匹配）
function rewriteUrl(url) {
  if (!url) return url;
  const s = loadSettings();
  const mappings = Array.isArray(s.urlMappings) ? s.urlMappings : [];
  if (!mappings.length) return url;
  try {
    let rewritten = String(url);
    for (const m of mappings) {
      if (!m || !m.from || !m.to) continue;
      const from = String(m.from).trim();
      const to = String(m.to).trim();
      if (!from || !to) continue;
      if (rewritten.startsWith(from)) {
        rewritten = to + rewritten.slice(from.length);
      }
    }
    return rewritten;
  } catch (_) { return url; }
}
function saveSettings(patch) {
  try {
    cachedSettings = { ...loadSettings(), ...patch, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const payload = JSON.stringify(cachedSettings);
    let out;
    if (isEncryptionAvailable()) {
      out = JSON.stringify({ __enc__: encryptString(payload) });
    } else {
      out = payload;
    }
    fs.writeFileSync(SETTINGS_FILE, out, { mode: 0o600 });
  } catch (e) { console.warn('saveSettings error', e); }
}

// ---------------------- 服务器地址解析 ----------------------
function normalizeServer(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('服务器地址为空');

  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch (_) { throw new Error('服务器地址格式不正确'); }
    return { origin: u.origin, href: u.toString(), isFnId: false };
  }
  const fnIdFromPath = raw.match(/^(?:www\.)?fnos\.net\/([A-Za-z0-9_-]+)\/?$/i);
  if (fnIdFromPath) {
    const fnId = fnIdFromPath[1];
    const href = `https://fnos.net/${encodeURIComponent(fnId)}`;
    return { origin: `https://fnos.net/${encodeURIComponent(fnId)}`, href, isFnId: true, fnId };
  }
  if (/^[A-Za-z0-9_-]+$/.test(raw) && !/^\d+$/.test(raw)) {
    const fnId = raw.replace(/^fn[-_]/i, '');
    const href = `https://fnos.net/${encodeURIComponent(fnId)}`;
    return { origin: `https://fnos.net/${encodeURIComponent(fnId)}`, href, isFnId: true, fnId };
  }
  let u;
  try { u = new URL(`http://${raw}`); } catch (_) { throw new Error('服务器地址格式不正确'); }
  if (!u.port) u.port = '5666';
  return { origin: u.origin, href: u.toString(), isFnId: false };
}

function partitionForServer(parsed) {
  let key;
  if (parsed.isFnId) key = `fn-${parsed.fnId}`;
  else key = 'host-' + crypto.createHash('sha1').update(parsed.origin).digest('hex').slice(0, 16);
  return `persist:nas-${key}`;
}

function upsertHistory(serverInput, parsed) {
  const s = loadSettings();
  const list = Array.isArray(s.history) ? s.history.slice() : [];
  const partition = partitionForServer(parsed);
  const idx = list.findIndex((h) => h.partition === partition);
  const entry = {
    partition,
    label: parsed.isFnId ? `FN ID: ${parsed.fnId}` : (serverInput.trim() || parsed.origin),
    origin: parsed.origin,
    href: parsed.href,
    isFnId: !!parsed.isFnId,
    fnId: parsed.fnId || '',
    serverInput: serverInput.trim(),
    lastConnectedAt: Date.now(),
  };
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(entry);
  saveSettings({
    history: list.slice(0, 10),
    server: serverInput.trim(),
    origin: parsed.origin,
    lastConnectHref: parsed.href,
    currentPartition: partition,
  });
}

function removeHistoryByPartition(partition) {
  const s = loadSettings();
  const list = (s.history || []).filter((h) => h.partition !== partition);
  const patch = { history: list };
  if (s.currentPartition === partition) {
    patch.server = ''; patch.origin = ''; patch.lastConnectHref = '';
    patch.currentPartition = 'persist:connect';
  }
  saveSettings(patch);
  // 清除该分区的存储数据（Cookie / localStorage / 缓存）
  try {
    const ses = session.fromPartition(partition);
    ses.clearStorageData().catch(() => {});
    ses.clearCache().catch(() => {});
  } catch (_) {}
  return list;
}

// ---------------------- User Agent ----------------------
function getNasUA() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
}
function applyUA(partition) {
  try { session.fromPartition(partition).setUserAgent(getNasUA()); } catch (_) {}
  try { installCorsBypass(session.fromPartition(partition)); } catch (_) {}
  try { installDownloadTracker(session.fromPartition(partition)); } catch (_) {}
}

// ---------------------- CORS / 直播源跨域（等效 KNAS 浏览器插件） ----------------------
// 飞牛影视的直播源在 Web 端受 CORS 限制无法播放；KNAS 插件通过修改响应头绕过。
// 这里在主进程统一对所有会话注入相应响应头，让 <video>/XHR/fetch 都能正常加载直播流。
function installCorsBypass(ses) {
  if (!ses || ses.__fnosCorsInstalled) return;
  ses.__fnosCorsInstalled = true;

  const removeHeader = (headers, name) => {
    const lower = name.toLowerCase();
    Object.keys(headers).forEach((k) => {
      if (k.toLowerCase() === lower) delete headers[k];
    });
  };
  const setHeader = (headers, name, value) => {
    removeHeader(headers, name);
    headers[name] = value;
  };

  // 1) 响应头：仅对媒体/直播流补齐 CORS 允许字段；对普通 API 不做修改
  // v1.10.5: 之前对所有响应都注入 Access-Control-Allow-Origin: * + Allow-Credentials: true，
  // 这种组合在规范上是非法的，且可能干扰飞牛 NAS 的 POST/DELETE/取消下载等业务接口。
  // 现在严格收窄到"媒体/直播流"场景（等效 KNAS 浏览器插件的真实行为）。
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    const ct = (headers['content-type'] || headers['Content-Type'] || []).join('').toLowerCase();
    const url = details.url || '';
    const isMedia = /mpegurl|m3u8|mp2t|octet-stream|video\/|audio\/|application\/x-mpegurl/i.test(ct)
      || /\.(m3u8|ts|flv|m4s|mpd|mp4|mkv|aac|flac|webm|mov|wav|ogg)(\?|$)/i.test(url);

    if (isMedia) {
      setHeader(headers, 'Access-Control-Allow-Origin', '*');
      setHeader(headers, 'Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD, PUT, DELETE');
      setHeader(headers, 'Access-Control-Allow-Headers', '*');
      setHeader(headers, 'Access-Control-Expose-Headers', '*');
      setHeader(headers, 'Timing-Allow-Origin', '*');
      removeHeader(headers, 'Cross-Origin-Resource-Policy');
      removeHeader(headers, 'Cross-Origin-Embedder-Policy');
      removeHeader(headers, 'Cross-Origin-Opener-Policy');
      if (!headers['Accept-Ranges']) setHeader(headers, 'Accept-Ranges', 'bytes');
    }
    callback({ responseHeaders: headers });
  });

  // 2) onBeforeSendHeaders：不修改请求头，保持飞牛前端原始请求
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: details.requestHeaders });
  });

  // 3) 仅对媒体/直播流的 OPTIONS 预检直接放行；普通业务 API 的 OPTIONS 透传给 NAS，
  //    避免我们的 204 空响应干扰飞牛的取消下载 / 删除 / 鉴权等接口
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (details.method === 'OPTIONS') {
      const url = details.url || '';
      if (/\.(m3u8|ts|flv|m4s|mpd|mp4|mkv|aac|flac|webm)(\?|$)/i.test(url)) {
        callback({ redirectURL: 'data:text/plain;charset=utf-8,' });
        return;
      }
    }
    // URL 重写（外网端口/域名映射）
    const mapped = rewriteUrl(details.url);
    if (mapped && mapped !== details.url) {
      callback({ redirectURL: mapped });
      return;
    }
    callback({});
  });
}

// ---------------------- 下载进度提示 ----------------------
// v1.10.0：用户反馈"NAS 往桌面下载文件缺少进度条"。
// v1.10.5：
//  1) 修复点下载后弹两个保存对话框（Chromium 并行下载/并发连接 + 飞牛前端可能触发两次）；
//  2) 修复进度框窗口尺寸过小，内容被裁切；
//  3) 修复取消下载可能损坏 NAS 原文件：飞牛服务端在连接被异常中断时会错误清理临时文件，
//     极端情况下波及原文件。客户端策略改为：先 setSavePath 让下载开始，UI 上"取消"
//     按钮先 pause 本地下载，等 1.5 秒让服务端正常收到连接结束信号再 cancel，
//     最大程度避免 RST 切断；且永远不向 NAS 发送 DELETE/PUT 等修改类请求。
function installDownloadTracker(ses) {
  if (!ses || ses.__fnosDlInstalled) return;
  ses.__fnosDlInstalled = true;

  // 同 URL + 同文件名的下载在 1500ms 内只弹一次保存框（防止双弹窗）
  const recentDownloads = new Map(); // key -> timestamp
  const isDuplicate = (url, fname) => {
    const key = `${url}::${fname}`;
    const now = Date.now();
    const last = recentDownloads.get(key) || 0;
    recentDownloads.set(key, now);
    // 清理 5 秒前的记录
    if (recentDownloads.size > 32) {
      for (const [k, t] of recentDownloads) if (now - t > 5000) recentDownloads.delete(k);
    }
    return now - last < 1500;
  };

  ses.on('will-download', async (event, item) => {
    const url = item.getURL() || '';
    const fname = item.getFilename() || '';
    const mimeType = item.getMimeType() || '';

    // 1) 阻止 Chromium 的默认下载行为（否则会直接落到默认下载目录，且和我们的弹框冲突）
    //    Electron 文档：在 will-download 回调里同步调用 event.preventDefault() 可以取消下载。
    //    但我们希望由用户确认后再下载，所以先暂停（pause），等用户选完路径再 resume。
    //    注意：不能在异步弹框期间让默认行为继续，否则会出现"一个默认下载 + 一个我们的弹框"。
    //    这里通过 item.pause() 让下载挂起，弹框由我们自己弹。
    try { item.pause(); } catch (_) {}

    // 2) 去重：同一 URL 在 1.5 秒内第二次触发 will-download，直接取消（不弹框）
    if (isDuplicate(url, fname)) {
      try { item.cancel(); } catch (_) {}
      return;
    }

    // 3) 弹保存对话框
    const defaultPath = app.getPath('downloads');
    let savePath;
    let saveDialogParent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
    try {
      const r = await dialog.showSaveDialog(saveDialogParent, {
        title: '保存文件',
        defaultPath: path.join(defaultPath, fname),
        buttonLabel: '保存',
        filters: [{ name: '所有文件', extensions: ['*'] }],
        // 不显示"标记为已阻止"等额外选项，避免双弹
        properties: [],
      });
      if (r.canceled || !r.filePath) {
        // 用户取消：安全地 cancel（此时尚未向服务端发出完整下载请求，pause 后 cancel 是安全的）
        try { item.cancel(); } catch (_) {}
        return;
      }
      savePath = r.filePath;
    } catch (e) {
      console.error('save dialog failed', e);
      try { item.cancel(); } catch (_) {}
      return;
    }

    // 4) 设置保存路径并恢复下载
    try {
      item.setSavePath(savePath);
    } catch (e) {
      console.error('setSavePath failed', e);
      try { item.cancel(); } catch (_) {}
      return;
    }
    try { item.resume(); } catch (_) {}
    showDownloadProgress(item);
  });
}

let downloadWindows = new Map();
let downloadSeq = 0;
function showDownloadProgress(item) {
  const totalBytes = item.getTotalBytes();
  const fname = item.getFilename();
  const dlId = ++downloadSeq;
  const CH_CANCEL = `download:cancel:${dlId}`;
  const CH_OPEN = `download:open:${dlId}`;
  const CH_CLOSE = `download:close:${dlId}`;

  const win = new BrowserWindow({
    width: 560, height: 200,
    minWidth: 480,
    minHeight: 190,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    icon: ICON_PATH,
    backgroundColor: '#00000000',
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'download-preload.js'),
      additionalArguments: [`--dl-id=${dlId}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  downloadWindows.set(dlId, { win, item });

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch (_) {}
    }
  };
  const fmtMB = (b) => b > 0 ? `${(b / 1024 / 1024).toFixed(2)} MB` : '—';

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { item.removeListener('updated', onUpdated); } catch (_) {}
    try { item.removeListener('done', onDone); } catch (_) {}
    try { ipcMain.removeHandler(CH_CANCEL); } catch (_) {}
    try { ipcMain.removeHandler(CH_OPEN); } catch (_) {}
    try { ipcMain.removeHandler(CH_CLOSE); } catch (_) {}
    downloadWindows.delete(dlId);
    try { rebuildTrayMenu(); } catch (_) {}
  };

  win.loadFile(path.join(__dirname, 'download.html')).catch(() => {});
  win.once('ready-to-show', () => {
    send('download:start', {
      filename: fname,
      savePath: item.getSavePath(),
      totalBytes,
      totalText: fmtMB(totalBytes),
      canResume: item.canResume(),
    });
    if (!win.isDestroyed()) win.showInactive();
  });

  let lastTrayUpdate = 0;
  // v1.10.4: 手动计算下载速度，避免 Electron getCurrentBytesPerSecond 在某些环境下返回异常值
  const SPEED_WINDOW_MS = 3000; // 3 秒滑动窗口
  const speedSamples = []; // {t, bytes}
  let lastUiUpdate = 0;
  let lastSentReceived = 0;
  const onUpdated = (_e, state) => {
    if (state === 'progressing') {
      const received = item.getReceivedBytes();
      const now = Date.now();
      speedSamples.push({ t: now, b: received });
      // 清理 3 秒前的样本
      while (speedSamples.length > 0 && now - speedSamples[0].t > SPEED_WINDOW_MS) {
        speedSamples.shift();
      }
      // 计算窗口内平均速度：至少要有 500ms 跨度和 2 个样本才算有效
      let speedBps = 0;
      if (speedSamples.length >= 2) {
        const oldest = speedSamples[0];
        const newest = speedSamples[speedSamples.length - 1];
        const dt = newest.t - oldest.t;
        if (dt >= 500) {
          speedBps = Math.max(0, Math.round((newest.b - oldest.b) * 1000 / dt));
        }
      }
      const pct = totalBytes > 0 ? Math.min(100, Math.round((received / totalBytes) * 100)) : 0;

      // 节流：UI 最多 250ms 更新一次
      if (now - lastUiUpdate >= 250 || received === totalBytes) {
        lastUiUpdate = now;
        lastSentReceived = received;
        let speedText = '0 KB/s';
        if (speedBps > 0) {
          if (speedBps >= 1024 * 1024) {
            speedText = `${(speedBps / 1024 / 1024).toFixed(2)} MB/s`;
          } else if (speedBps >= 1024) {
            speedText = `${(speedBps / 1024).toFixed(1)} KB/s`;
          } else {
            speedText = `${speedBps} B/s`;
          }
        }
        // 剩余时间
        let etaText = '';
        if (speedBps > 1024 && totalBytes > 0) {
          const remain = Math.max(0, totalBytes - received);
          const secs = Math.round(remain / speedBps);
          if (secs < 60) etaText = `${secs} 秒`;
          else if (secs < 3600) etaText = `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
          else etaText = `${Math.floor(secs / 3600)} 时 ${Math.floor((secs % 3600) / 60)} 分`;
        }
        send('download:progress', {
          received, totalBytes, pct,
          receivedText: fmtMB(received),
          speedBps,
          speedText,
          etaText,
        });
      }

      if (now - lastTrayUpdate > 1500) {
        lastTrayUpdate = now;
        try { rebuildTrayMenu(); } catch (_) {}
      }
    }
  };
  const onDone = (_e, state) => {
    send('download:done', {
      state,
      savePath: item.getSavePath(),
    });
    if (state === 'completed') {
      try {
        if (win && !win.isDestroyed()) {
          win.showInactive();
          win.setAlwaysOnTop(true, 'pop-up-menu');
        }
      } catch (_) {}
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.close();
      }, 2500);
    } else if (state === 'cancelled' || state === 'interrupted') {
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.close();
      }, 1500);
    }
  };

  item.on('updated', onUpdated);
  item.once('done', onDone);
  win.on('closed', cleanup);

  let canceling = false;
  ipcMain.handle(CH_CANCEL, () => {
    if (canceling) return;
    canceling = true;
    // v1.10.5 重要：取消下载时绝不向 NAS 发送任何 DELETE/PUT 请求。
    // 飞牛 NAS 在 TCP RST 强断时可能误清理临时文件、极端情况下波及原文件。
    // 策略：先本地 pause（停止接收数据），等 1.5s 让服务端从容完成当前 chunk 并正常 EOF，
    // 然后再 cancel。pause 在 Electron 中是幂等的，cancel 后会触发 done 事件清理本地临时文件。
    try { item.pause(); } catch (_) {}
    setTimeout(() => {
      try { item.cancel(); } catch (_) {}
    }, 1500);
    try { if (win && !win.isDestroyed()) win.close(); } catch (_) {}
  });
  ipcMain.handle(CH_OPEN, () => {
    try { shell.showItemInFolder(item.getSavePath()); } catch (_) {}
  });
  // 用户点 X 关闭：仅隐藏进度窗口，不取消下载。下载完成后系统通知区提示。
  ipcMain.handle(CH_CLOSE, () => {
    try { if (win && !win.isDestroyed()) win.hide(); } catch (_) {}
    try { rebuildTrayMenu(); } catch (_) {}
  });
  win.on('close', (e) => {
    // 下载未完成时，阻止窗口真正关闭，改为隐藏
    if (!item.isDone() && !closed) {
      e.preventDefault();
      try { win.hide(); } catch (_) {}
    }
  });
}

// ---------------------- 玻璃风格自定义对话框 ----------------------
/**
 * showGlassDialog(parent, options)
 *   options: { title, detail, buttons, defaultId, cancelId, width, height }
 *   返回: Promise<{ response }>
 *
 * 设计极简：仅标题 + 按钮，无图标、无勾选框。
 */
function showGlassDialog(parent, options = {}) {
  return new Promise((resolve) => {
    const buttons = Array.isArray(options.buttons) && options.buttons.length > 0
      ? options.buttons : ['确定'];
    const defaultId = typeof options.defaultId === 'number' ? options.defaultId : 0;
    const cancelId = typeof options.cancelId === 'number' ? options.cancelId
      : (buttons.length > 1 ? buttons.length - 1 : 0);
    const width = options.width || 440;
    const isLong = (options.detail || '').length > 400;
    const initHeight = isLong ? 560 : 220;
    const payload = {
      title: options.title || APP_NAME,
      detail: options.detail || '',
      buttons,
      defaultId,
      cancelId,
    };

    const parentBounds = parent && !parent.isDestroyed() ? parent.getBounds() : null;
    const primaryWorkArea = screen.getPrimaryDisplay().workAreaSize;

    const win = new BrowserWindow({
      width,
      height: initHeight,
      minWidth: 380,
      maxWidth: 560,
      minHeight: 180,
      maxHeight: Math.min(680, primaryWorkArea.height - 40),
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      transparent: true,
      modal: false,
      parent: undefined,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      show: false,
      icon: ICON_PATH,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: DIALOG_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    const centerIn = (w, h) => {
      let x, y;
      if (parentBounds) {
        x = Math.round(parentBounds.x + (parentBounds.width - w) / 2);
        y = Math.round(parentBounds.y + (parentBounds.height - h) / 2);
      } else {
        x = Math.round((primaryWorkArea.width - w) / 2);
        y = Math.round((primaryWorkArea.height - h) / 2);
      }
      x = Math.max(10, Math.min(x, primaryWorkArea.width - w - 10));
      y = Math.max(10, Math.min(y, primaryWorkArea.height - h - 10));
      if (!win.isDestroyed()) win.setPosition(x, y);
    };
    centerIn(width, initHeight);

    let responded = false;
    const finish = (buttonIndex) => {
      if (responded || win.isDestroyed()) return;
      responded = true;
      const idx = typeof buttonIndex === 'number' ? buttonIndex : cancelId;
      try { win.hide(); } catch (_) {}
      setTimeout(() => { try { win.close(); } catch (_) {} }, 0);
      resolve({ response: idx, checkboxChecked: false });
    };

    // 在页面加载前通过 webContents 推送 options（preload 监听一次性事件）
    win.webContents.once('did-start-loading', () => {
      try { win.webContents.send('dialog:options', payload); } catch (_) {}
    });

    const onIpc = (_e, channel, data) => {
      if (channel === 'dlg:resp') {
        const idx = data && typeof data.buttonIndex === 'number'
          ? data.buttonIndex : cancelId;
        finish(idx);
      } else if (channel === 'dlg:resize') {
        if (!data || typeof data.height !== 'number') return;
        const maxH = Math.min(720, primaryWorkArea.height - 40);
        const targetH = Math.max(200, Math.min(Math.round(data.height), maxH));
        const targetW = data.width
          ? Math.max(380, Math.min(Math.round(data.width), 560))
          : width;
        if (!win.isDestroyed()) {
          win.setSize(targetW, targetH);
          centerIn(targetW, targetH);
        }
      } else if (channel === 'dlg:ready') {
        if (!win.isDestroyed()) {
          try { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); win.focus(); win.moveTop(); } catch (_) {}
        }
      }
    };
    win.webContents.on('ipc-message', onIpc);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.once('ready-to-show', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) {
          try { win.showInactive(); win.focus(); } catch (_) {}
        }
      }, 200);
    });
    win.on('closed', () => {
      try { win.webContents.removeListener('ipc-message', onIpc); } catch (_) {}
      if (!responded) resolve({ response: cancelId, checkboxChecked: false });
    });

    win.loadFile(DIALOG_PAGE).catch(() => { finish(cancelId); });
  });
}

// 便捷封装
function flushPartition(partition) {
  if (!partition) return;
  try {
    const ses = session.fromPartition(partition);
    if (ses && typeof ses.cookies.flushStorageData === 'function') {
      try { ses.cookies.flushStorageData(); } catch (_) {}
    }
    if (ses && typeof ses.flushStorageData === 'function') {
      try { ses.flushStorageData(); } catch (_) {}
    }
  } catch (e) { /* noop */ }
}

function persistAllSessions() {
  try {
    flushPartition(currentPartition);
    flushPartition('persist:connect');
    flushPartition('persist:default');
    const sessions = session.getAllSessions ? session.getAllSessions() : [];
    for (const s of sessions) {
      try { s.cookies.flushStorageData(); } catch (_) { /* noop */ }
    }
  } catch (e) { /* noop */ }
}

// ---------------------- 锁屏 / 全局快捷键 / 一键隐藏 ----------------------
function createLockWindow(mode /* 'unlock' | 'setup' | 'change' */ = 'unlock') {
  if (lockWindow && !lockWindow.isDestroyed()) {
    try {
      lockWindow.webContents.send('lock:mode', { mode, hasPassword: hasAppPassword(), version: APP_VERSION });
    } catch (_) {}
    return lockWindow;
  }
  // v1.10.0：改为全屏覆盖（无边框 + 透明），让玻璃卡片正确模糊其下桌面；同时避免固定高度在高 DPI 下被裁切
  const primary = screen.getPrimaryDisplay();
  const { x, y, width: sw, height: sh } = primary.bounds;
  lockWindow = new BrowserWindow({
    x, y, width: sw, height: sh,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: ICON_PATH,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    webPreferences: {
      preload: LOCK_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  lockWindow.setAlwaysOnTop(true, 'screen-saver');
  lockWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 阻止 Alt+F4 关闭锁屏（除非应用正在退出）
  lockWindow.on('close', (e) => {
    if (!app.isQuitting && isLocked) {
      e.preventDefault();
      try { lockWindow.focus(); } catch (_) {}
    }
  });
  lockWindow.on('closed', () => { lockWindow = null; });

  const url = `file://${LOCK_PAGE.replace(/\\/g, '/')}?mode=${encodeURIComponent(mode)}&v=${Date.now()}`;
  lockWindow.loadURL(url).catch(() => {});
  lockWindow.once('ready-to-show', () => {
    if (lockWindow && !lockWindow.isDestroyed()) {
      try { lockWindow.showInactive(); lockWindow.focus(); } catch (_) {}
    }
  });
  return lockWindow;
}

function closeLockWindow() {
  if (lockWindow && !lockWindow.isDestroyed()) {
    try { lockWindow.close(); } catch (_) {}
  }
  lockWindow = null;
}

function hideAllAppWindows() {
  try {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (w === lockWindow) return; // 不隐藏锁屏窗
      if (!w.isDestroyed()) w.hide();
    });
  } catch (_) {}
}

function showAllAppWindows() {
  const home = appWindows.find((e) => e.isHome && e.win && !e.win.isDestroyed());
  if (home) {
    home.win.show();
    home.win.focus();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show(); mainWindow.focus();
  }
  appWindows.forEach((e) => {
    if (!e.isHome && e.win && !e.win.isDestroyed()) {
      // 子窗口默认不抢焦点显示，但任务栏里可切回
    }
  });
}

function lockApp() {
  if (!hasAppPassword()) {
    // 未设置密码时，引导用户到设置页设置
    createSettingsWindow();
    return;
  }
  isLocked = true;
  // 隐藏所有业务窗口，仅保留锁屏窗口
  hideAllAppWindows();
  // 保留托盘（点击托盘需先解锁）
  ensureTray();
  createLockWindow('unlock');
}

function unlockApp() {
  isLocked = false;
  closeLockWindow();
  showAllAppWindows();
  ensureTray();
}

function hideCompletely() {
  isCompletelyHidden = true;
  hideAllAppWindows();
  if (lockWindow && !lockWindow.isDestroyed()) {
    try { lockWindow.hide(); } catch (_) {}
  }
  // 连托盘一起销毁
  if (tray) {
    try { tray.destroy(); } catch (_) {}
    tray = null;
  }
}

function restoreFromCompletelyHidden() {
  isCompletelyHidden = false;
  if (isLocked) {
    // 仍处于锁定状态，只呼出锁屏
    if (!lockWindow || lockWindow.isDestroyed()) createLockWindow('unlock');
    else { try { lockWindow.showInactive(); lockWindow.focus(); } catch (_) {} }
    return;
  }
  ensureTray();
  showAllAppWindows();
}

function toggleCompletelyHidden() {
  if (isCompletelyHidden) restoreFromCompletelyHidden();
  else hideCompletely();
}

function registerGlobalShortcuts() {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  const s = loadSettings();
  const sc = s.shortcuts || DEFAULT_SHORTCUTS;
  try {
    if (sc.lockApp) {
      globalShortcut.register(sc.lockApp, () => {
        if (isCompletelyHidden) { restoreFromCompletelyHidden(); return; }
        if (isLocked) {
          if (!lockWindow || lockWindow.isDestroyed()) createLockWindow('unlock');
          else { try { lockWindow.showInactive(); lockWindow.focus(); } catch (_) {} }
          return;
        }
        lockApp();
      });
    }
  } catch (e) { console.warn('register lock shortcut failed', e); }
  try {
    if (sc.hideAll) {
      globalShortcut.register(sc.hideAll, toggleCompletelyHidden);
    }
  } catch (e) { console.warn('register hide shortcut failed', e); }
}

function isValidAccelerator(acc) {
  if (!acc) return true; // 空 = 禁用
  try { return Menu.buildFromTemplate([{ role: 'reload', accelerator: acc }]) !== null; } catch (_) { return false; }
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try { settingsWindow.show(); settingsWindow.focus(); } catch (_) {}
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 780,
    height: 860,
    minWidth: 620,
    minHeight: 560,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    title: 'FNOS 设置',
    backgroundColor: '#05060a',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      preload: SETTINGS_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(SETTINGS_PAGE).catch(() => {});
  settingsWindow.once('ready-to-show', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show(); settingsWindow.focus();
    }
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    // 关闭设置页后重新注册快捷键
    registerGlobalShortcuts();
  });
  return settingsWindow;
}

// 便捷封装
async function glassMessageBox(parent, options) {
  return showGlassDialog(parent, options);
}
function glassErrorBox(title, message) {
  return showGlassDialog(mainWindow, {
    type: 'error',
    title,
    detail: message,
    buttons: ['确定'],
    defaultId: 0,
  });
}

// ---------------------- 菜单栏（常驻显示） ----------------------
// v1.7.0：按用户要求关闭自动隐藏，菜单栏始终可见
function ensureMenuBarVisible(win) {
  try {
    if (win && !win.isDestroyed()) {
      win.setMenuBarVisibility(true);
      win.setAutoHideMenuBar(false);
    }
  } catch (_) {}
}
function showMenuBarTemporarily() { ensureMenuBarVisible(mainWindow); }
function startMenuAutoHide() { /* no-op，菜单栏常驻 */ }

// ---------------------- 多窗口管理 ----------------------
function registerWindow(win, opts = {}) {
  const entry = {
    win,
    id: win.id,
    title: opts.title || APP_NAME,
    url: opts.url || '',
    isMain: !!opts.isMain,
    isHome: !!opts.isHome,
    partition: opts.partition || currentPartition,
  };
  appWindows.push(entry);

  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    entry.title = title || entry.title;
    if (!entry.isHome && title && title.trim()) win.setTitle(`${APP_NAME} · ${title}`);
    scheduleMenuRebuild();
  });
  win.on('closed', () => {
    appWindows = appWindows.filter((w) => w.win !== win);
    if (entry.isMain) mainWindow = null;
    scheduleMenuRebuild();
  });
  win.webContents.on('did-navigate', (_e, url) => {
    entry.url = url;
    scheduleMenuRebuild();
  });
  win.webContents.on('did-navigate-in-page', (_e, url) => {
    entry.url = url;
  });

  // 渲染进程崩溃：自动重载入口
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('render-process-gone', details);
    if (entry.isHome) {
      if (lastConnectHref) win.loadURL(lastConnectHref).catch(() => {});
      else showConnectPage();
    }
  });

  // 页面无响应：玻璃对话框
  win.webContents.on('unresponsive', () => {
    glassMessageBox(win, {
      type: 'warning', title: '页面无响应',
      buttons: ['重新加载', '等待'],
      defaultId: 0, cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !win.isDestroyed()) win.webContents.forceReload();
    }).catch(() => {});
  });

  // 权限白名单
  win.webContents.session.setPermissionRequestHandler((_w, permission, cb) => {
    cb([
      'notifications', 'clipboard-read', 'clipboard-sanitized-write',
      'fullscreen', 'media', 'pointerLock',
    ].includes(permission));
  });

  // 子窗口的新窗口请求：在客户端内同 partition 打开（保持登录态 & window.opener 可用于 OAuth postMessage）
  win.webContents.setWindowOpenHandler(({ url, features, frameName }) => {
    if (/^(about:blank|javascript:)/i.test(url) || url === '') {
      // OAuth 弹窗常先打开 about:blank 再由脚本跳转，需放行且保留 opener
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1024, height: 720,
          minWidth: 640, minHeight: 480,
          backgroundColor: '#0b0d12',
          autoHideMenuBar: !!loadSettings().autoHideMenuBar,
          icon: ICON_PATH,
          title: APP_NAME,
          webPreferences: {
            partition: entry.partition,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            allowRunningInsecureContent: true,
            backgroundThrottling: false,
            enableBlinkFeatures: 'CSSBackdropFilter',
          },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) {
      // 普通 http(s) 链接：在独立窗口中打开（共享 partition 以保持登录态）
      setImmediate(() => createAppWindow(url, { partition: entry.partition }));
      return { action: 'deny' };
    }
    if (/^(mailto|tel|sms):/i.test(url)) {
      setImmediate(() => shell.openExternal(url).catch(() => {}));
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (/^(https?|file):/i.test(url)) return;
    if (/^(mailto|tel|sms):/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
      return;
    }
    event.preventDefault();
  });

  win.webContents.on('will-redirect', (event, url) => {
    if (!/^https?:/i.test(url)) event.preventDefault();
  });

  // ESC 退出全屏/最大化
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    if (input.alt || input.control || input.meta || input.shift) return;
    const exit = (hasFs) => {
      if (hasFs) return;
      if (win.isFullScreen()) win.setFullScreen(false);
      else if (win.isMaximized()) win.unmaximize();
    };
    win.webContents.executeJavaScript('!!document.fullscreenElement', true)
      .then(exit).catch(() => exit(false));
    event.preventDefault();
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11') return;
    win.setFullScreen(!win.isFullScreen());
    event.preventDefault();
  });

  // 关闭行为：主窗口弹托盘/退出选择；子窗口直接关闭
  win.on('close', (e) => {
    if (entry.isHome && !app.isQuitting && !isSwitchingPartition) {
      e.preventDefault();
      handleMainClose(win);
    }
  });

  scheduleMenuRebuild();
  return entry;
}

function createAppWindow(url, opts = {}) {
  const partition = opts.partition || currentPartition;
  applyUA(partition);

  const useGlass = !!cachedSettings.glassTitleBar;
  const win = new BrowserWindow({
    width: opts.width || 1280,
    height: opts.height || 820,
    minWidth: 900,
    minHeight: 600,
    title: opts.title || APP_NAME,
    backgroundColor: cachedSettings.themeColor || '#0b0d12',
    show: false,
    autoHideMenuBar: false,
    frame: useGlass ? false : true,
    titleBarStyle: useGlass ? 'hidden' : 'default',
    titleBarOverlay: useGlass ? {
      color: cachedSettings.themeColor || '#1e1b2e',
      symbolColor: '#ffffff',
      height: 36,
    } : false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: true,
      spellcheck: false,
      backgroundThrottling: false,
      partition,
      enableBlinkFeatures: 'CSSBackdropFilter',
    },
  });

  // 菜单栏自动隐藏开关（v1.10.0）
  const autoHide = !!loadSettings().autoHideMenuBar;
  win.setAutoHideMenuBar(autoHide);
  win.setMenuBarVisibility(!autoHide);

  const isHome = !!opts.isHome;
  registerWindow(win, {
    url, title: opts.title || APP_NAME, isMain: isHome, isHome, partition,
  });

  if (url) {
    if (/^https?:/i.test(url)) {
      win.loadURL(url, { userAgent: getNasUA() }).catch(() => {});
    } else {
      win.loadFile(url).catch(() => {});
    }
  }

  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 300);

  return win;
}

// ---------------------- 主窗口关闭逻辑 ----------------------
function handleMainClose(win) {
  glassMessageBox(win, {
    title: '关闭 FNOS',
    buttons: ['隐藏到托盘', '退出程序', '取消'],
    defaultId: 0,
    cancelId: 2,
  }).then(({ response }) => {
    if (response === 2 || response === undefined) return;
    if (response === 1) {
      app.isQuitting = true;
      app.quit();
      return;
    }
    BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.hide(); });
    ensureTray();
  }).catch(() => {});
}

// ---------------------- 系统托盘 ----------------------
function ensureTray() {
  if (tray) return tray;
  let iconImage;
  try {
    iconImage = nativeImage.createFromPath(ICON_PNG);
    if (iconImage.isEmpty()) iconImage = nativeImage.createFromPath(ICON_PATH);
  } catch (_) {
    iconImage = nativeImage.createEmpty();
  }
  tray = new Tray(iconImage);
  tray.setToolTip(`${APP_NAME} 桌面客户端`);
  tray.on('click', () => {
    if (isCompletelyHidden) {
      restoreFromCompletelyHidden();
      return;
    }
    if (isLocked) {
      if (!lockWindow || lockWindow.isDestroyed()) createLockWindow('unlock');
      else { try { lockWindow.showInactive(); lockWindow.focus(); } catch (_) {} }
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) mainWindow.focus();
      else mainWindow.show();
    } else {
      // 主窗口已关，重建
      const s = loadSettings();
      if (s.lastConnectHref) {
        connectTo(s.server || '');
      } else {
        showConnectPage();
      }
    }
  });
  tray.on('double-click', () => {
    if (isLocked) {
      if (!lockWindow || lockWindow.isDestroyed()) createLockWindow('unlock');
      else { try { lockWindow.showInactive(); lockWindow.focus(); } catch (_) {} }
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  rebuildTrayMenu();
  return tray;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const windows = appWindows.filter((e) => e.win && !e.win.isDestroyed());
  const items = [];

  if (isLocked || isCompletelyHidden) {
    items.push({ label: isLocked ? 'FNOS 已锁定' : 'FNOS 已隐藏', enabled: false });
    items.push({ label: isLocked ? '输入密码恢复…' : '恢复显示', click: () => {
      if (isCompletelyHidden) restoreFromCompletelyHidden();
      else if (isLocked) {
        if (!lockWindow || lockWindow.isDestroyed()) createLockWindow('unlock');
        else { try { lockWindow.showInactive(); lockWindow.focus(); } catch (_) {} }
      }
    }});
    items.push({ type: 'separator' });
    items.push({ label: '退出', click: () => { app.isQuitting = true; app.quit(); } });
    tray.setContextMenu(Menu.buildFromTemplate(items));
    return;
  }

  items.push({ label: '显示 FNOS 主页', click: () => {
    const home = appWindows.find((e) => e.isHome && e.win && !e.win.isDestroyed());
    if (home) { home.win.show(); home.win.focus(); }
    else if (lastConnectHref) connectTo(loadSettings().server || '');
    else showConnectPage();
  }});

  if (windows.length > 0) {
    items.push({ type: 'separator' });
    items.push({ label: '已打开的程序', enabled: false });
    windows.forEach((e) => {
      items.push({
        label: e.title.length > 30 ? e.title.slice(0, 30) + '…' : e.title,
        click: () => { if (e.win && !e.win.isDestroyed()) { e.win.show(); e.win.focus(); } },
      });
    });
  }

  // 后台下载进度（点 X 隐藏后的下载任务）
  const activeDls = [];
  try {
    for (const [, entry] of downloadWindows) {
      if (entry && entry.win && !entry.win.isDestroyed()) activeDls.push(entry);
    }
  } catch (_) {}
  if (activeDls.length > 0) {
    items.push({ type: 'separator' });
    items.push({ label: '正在下载', enabled: false });
    activeDls.forEach((entry) => {
      let label = entry.item && entry.item.getFilename ? entry.item.getFilename() : '下载任务';
      if (label && label.length > 30) label = label.slice(0, 30) + '…';
      items.push({
        label,
        click: () => {
          try { if (entry.win && !entry.win.isDestroyed()) { entry.win.show(); entry.win.focus(); } } catch (_) {}
        },
      });
    });
  }

  items.push({ type: 'separator' });
  items.push({ label: '切换服务器…', click: () => showConnectPage() });
  if (hasAppPassword()) {
    items.push({ label: '锁定 FNOS', click: () => lockApp() });
  }
  items.push({ label: '设置…', click: () => createSettingsWindow() });
  items.push({ type: 'separator' });
  items.push({ label: '退出', click: () => { app.isQuitting = true; app.quit(); } });

  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------------------- 窗口创建 ----------------------
function createMainWindow(partition, loadTarget) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    isSwitchingPartition = true;
    try { mainWindow.destroy(); } catch (_) {}
    mainWindow = null;
    setTimeout(() => { isSwitchingPartition = false; }, 0);
  }

  currentPartition = partition || 'persist:connect';
  applyUA(currentPartition);

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#0f7a3e',
    show: false,
    autoHideMenuBar: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: true,
      spellcheck: false,
      backgroundThrottling: false,
      partition: currentPartition,
      enableBlinkFeatures: 'CSSBackdropFilter',
    },
  });

  // 菜单栏自动隐藏开关（v1.10.0）
  const mainAutoHide = !!loadSettings().autoHideMenuBar;
  mainWindow.setAutoHideMenuBar(mainAutoHide);
  mainWindow.setMenuBarVisibility(!mainAutoHide);

  registerWindow(mainWindow, {
    url: (loadTarget && loadTarget.href) || LOGIN_PAGE,
    title: APP_NAME,
    isMain: true,
    isHome: true,
    partition: currentPartition,
  });

  if (loadTarget && loadTarget.href) {
    currentOrigin = loadTarget.origin || '';
    lastConnectHref = loadTarget.href;
    safeSetTitle(APP_NAME);
    mainWindow.loadURL(loadTarget.href, { userAgent: getNasUA() }).catch(() => showConnectPage());
  } else {
    showConnectPage();
  }

  buildMenu();
  if (!isLocked) {
    mainWindow.show();
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !isLocked) mainWindow.show();
    }, 200);
  } else {
    // 启动锁定状态：主窗口后台加载，但不显示
    try { mainWindow.hide(); } catch (_) {}
  }
}

function showConnectPage() {
  if (currentPartition !== 'persist:connect') {
    saveSettings({ currentPartition: 'persist:connect' });
    createMainWindow('persist:connect', null);
    return;
  }
  currentOrigin = '';
  lastConnectHref = '';
  safeSetTitle(`${APP_NAME} · 连接服务器`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(LOGIN_PAGE).catch((e) => {
      glassErrorBox('加载失败', `无法打开连接页：${e.message}`);
    });
  }
}

function connectTo(serverInput) {
  const parsed = normalizeServer(serverInput);
  const targetPartition = partitionForServer(parsed);
  upsertHistory(serverInput, parsed);

  if (currentPartition !== targetPartition) {
    // 关闭所有旧窗口，用新 partition 重建
    appWindows.filter((e) => e.win && !e.win.isDestroyed() && !e.isHome).forEach((e) => {
      try { e.win.destroy(); } catch (_) {}
    });
    createMainWindow(targetPartition, { origin: parsed.origin, href: parsed.href });
    return;
  }

  currentOrigin = parsed.origin;
  lastConnectHref = parsed.href;
  safeSetTitle(APP_NAME);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(parsed.href, { userAgent: getNasUA() }).catch((e) => {
      glassErrorBox(
        '连接失败',
        `无法连接到 ${parsed.origin}\n\n${e.message}\n\n请检查：\n• 电脑是否与 NAS 在同一网络\n• 地址与端口是否正确\n• FN ID 是否正确、FN Connect 是否已开启`,
      );
      showConnectPage();
    });
  }
}

function goHomeWithPrompt() {
  // 返回飞牛主页：如果当前主窗口已打开其他程序，提供选项
  const childWindows = appWindows.filter((e) => !e.isHome && e.win && !e.win.isDestroyed());
  if (childWindows.length === 0) {
    goHomeDirect();
    return;
  }

  glassMessageBox(mainWindow, {
    type: 'question',
    title: `返回 FNOS 主页（${childWindows.length} 个程序运行中）`,
    buttons: ['后台运行', '退出这些程序', '取消'],
    defaultId: 0,
    cancelId: 2,
  }).then(({ response }) => {
    if (response === 2 || response === undefined) return;
    if (response === 1) {
      childWindows.forEach((e) => { try { e.win.close(); } catch (_) {} });
    }
    // 隐藏所有子窗口（后台运行）或已关闭
    goHomeDirect();
  });
}

function goHomeDirect() {
  // 隐藏所有子窗口
  appWindows.filter((e) => !e.isHome && e.win && !e.win.isDestroyed()).forEach((e) => {
    e.win.hide();
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (lastConnectHref) {
      mainWindow.loadURL(lastConnectHref, { userAgent: getNasUA() }).catch(() => {});
    } else if (currentOrigin) {
      mainWindow.loadURL(currentOrigin + '/', { userAgent: getNasUA() }).catch(() => {});
    } else {
      showConnectPage();
    }
    mainWindow.show();
    mainWindow.focus();
  } else {
    const s = loadSettings();
    if (s.lastConnectHref) connectTo(s.server || '');
    else showConnectPage();
  }
}

function safeSetTitle(t) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(t);
    appWindows.forEach((e) => {
      if (!e.isHome && e.win && !e.win.isDestroyed()) e.win.setTitle(e.title);
    });
  } catch (_) {}
}

// ---------------------- 菜单构建（含窗口切换列表） ----------------------
function scheduleMenuRebuild() {
  if (menuRebuildTimer) clearTimeout(menuRebuildTimer);
  menuRebuildTimer = setTimeout(() => {
    buildMenu();
    rebuildTrayMenu();
    menuRebuildTimer = null;
  }, 150);
}

function withWebContents(fn) {
  return () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      if (!win || win.isDestroyed()) return;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) return;
      fn(wc, win);
    } catch (e) { console.error('menu action error', e); }
  };
}

// 获取内置 MPV 播放器路径（随安装包打包，bin/mpv/mpv.exe）
function findExternalPlayer() {
  try {
    // 打包后：resources/bin/mpv/mpv.exe（extraResources 复制到 resources/bin/mpv/）
    const prodPath = path.join(process.resourcesPath || '', 'bin', 'mpv', 'mpv.exe');
    if (fs.existsSync(prodPath)) return prodPath;
    // 开发环境：源码目录 bin/mpv/mpv.exe
    const devPath = path.join(__dirname, 'bin', 'mpv', 'mpv.exe');
    if (fs.existsSync(devPath)) return devPath;
  } catch (_) {}
  return null;
}

// 让渲染端从 <video> 中抓取当前播放的视频 URL
async function extractVideoUrl(wc) {
  try {
    const result = await wc.executeJavaScript(`(() => {
      const vs = Array.from(document.querySelectorAll('video'));
      for (const v of vs) {
        if (v && v.src && v.src.startsWith('http')) return v.src;
        if (v && v.currentSrc && v.currentSrc.startsWith('http')) return v.currentSrc;
      }
      // blob: 源需要 MSE，外部播放器无法直接播放；返回 null
      return null;
    })()`, true);
    return result || null;
  } catch (e) {
    console.warn('extract video url failed', e);
    return null;
  }
}

// 用内置 MPV 播放器打开当前视频（硬件解码由 MPV 完成）
function getMpvPath() {
  return findExternalPlayer();
}

async function openInMpv(wc, ownerWin) {
  if (!wc || wc.isDestroyed()) return;
  const mpvPath = getMpvPath();
  if (!mpvPath) {
    await glassMessageBox(ownerWin || mainWindow, {
      type: 'error', buttons: ['我知道了'], defaultId: 0, cancelId: 0,
      title: 'MPV 播放器缺失',
      message: '内置 MPV 播放器组件未找到。',
      detail: '请重新安装 FNOS 客户端，安装包已内置 MPV（GPL 协议开源）。若仍出现此问题，请在 GitHub Issues 反馈。',
    });
    return;
  }
  const url = await extractVideoUrl(wc);
  if (!url) {
    glassMessageBox(ownerWin || mainWindow, {
      type: 'info', buttons: ['我知道了'], defaultId: 0, cancelId: 0,
      title: '未找到可播放视频',
      message: '请先在飞牛影视中打开一个视频并开始播放，再使用此功能。',
      detail: '提示：直播流、受 DRM 保护的视频，或使用 MSE/Blob 的播放源暂不支持 MPV 打开（因为 MPV 拿不到流地址）。普通影片文件（mp4/mkv 等直链）可以正常调用 MPV 硬解播放。',
    });
    return;
  }
  try {
    const targetHost = (() => { try { return new URL(url).host; } catch { return ''; } })();
    let cookieHeader = '';
    try {
      const cookies = await wc.session.cookies.get({});
      const relevant = cookies.filter(c => {
        if (!c.domain) return false;
        return targetHost.includes(c.domain) || c.domain.includes(targetHost.split(':')[0]);
      });
      cookieHeader = relevant.map(c => `${c.name}=${c.value}`).join('; ');
    } catch {}
    const args = [];
    args.push('--hwdec=auto'); // 自动硬件解码
    if (cookieHeader) args.push(`--http-header-fields=Cookie: ${cookieHeader}`);
    args.push(url);
    cp.spawn(mpvPath, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.error('spawn mpv failed', e);
    glassErrorBox(ownerWin || mainWindow, '启动 MPV 播放器失败：' + (e.message || e));
  }
}

function buildMenu() {
  const childWindows = appWindows.filter((e) => !e.isHome && e.win && !e.win.isDestroyed());

  const switchWindowItems = childWindows.length > 0
    ? childWindows.map((e) => ({
        label: e.title.length > 36 ? e.title.slice(0, 36) + '…' : e.title,
        click: () => { if (e.win && !e.win.isDestroyed()) { e.win.show(); e.win.focus(); } },
      }))
    : [{ label: '（暂无后台运行的程序）', enabled: false }];

  const s = loadSettings();
  const lockAcc = (s.shortcuts && s.shortcuts.lockApp) || '';
  const hideAcc = (s.shortcuts && s.shortcuts.hideAll) || '';

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '返回 FNOS 主页', accelerator: 'Alt+H', click: goHomeWithPrompt },
        { label: '切换服务器…', accelerator: 'Ctrl+Shift+L', click: () => {
          glassMessageBox(mainWindow, {
            type: 'question', buttons: ['切换', '取消'],
            defaultId: 0, cancelId: 1,
            title: '切换服务器',
          }).then(({ response }) => {
            if (response === 0) showConnectPage();
          });
        }},
        { type: 'separator' },
        {
          label: '切换窗口',
          submenu: switchWindowItems,
        },
        { type: 'separator' },
        ...(hasAppPassword() ? [{ label: `锁定 FNOS${lockAcc ? `  (${lockAcc})` : ''}`, click: () => lockApp() }] : []),
        { label: `一键隐藏 / 呼出${hideAcc ? `  (${hideAcc})` : ''}`, click: () => toggleCompletelyHidden() },
        { type: 'separator' },
        { role: 'minimize', label: '最小化' },
        {
          label: '隐藏到托盘',
          click: () => {
            BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.hide(); });
            ensureTray();
          },
        },
        { role: 'close', label: '关闭' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '返回上一页', accelerator: 'Alt+Left',
          click: withWebContents((wc) => { if (wc.canGoBack()) wc.goBack(); }) },
        { label: '前进下一页', accelerator: 'Alt+Right',
          click: withWebContents((wc) => { if (wc.canGoForward()) wc.goForward(); }) },
        { type: 'separator' },
        { label: '刷新', accelerator: 'F5',
          click: withWebContents((wc) => wc.reload()) },
        { label: '强制刷新', accelerator: 'Ctrl+F5',
          click: withWebContents((wc) => wc.reloadIgnoringCache()) },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { label: '全屏 / 退出全屏', accelerator: 'F11',
          click: withWebContents((_wc, win) => win.setFullScreen(!win.isFullScreen())) },
        { type: 'separator' },
        { label: '用 MPV 打开当前视频（硬解）',
          click: withWebContents((wc, win) => { openInMpv(wc, win); }) },
        ...(IS_DEV ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
      ],
    },
    {
      label: '设置',
      submenu: [
        { label: '偏好设置…', accelerator: 'Ctrl+,', click: () => createSettingsWindow() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '操作步骤帮助', click: () => {
          const helpWin = new BrowserWindow({
            width: 720, height: 680,
            title: 'FNOS · 操作帮助',
            autoHideMenuBar: false,
            icon: ICON_PATH,
            parent: mainWindow || undefined,
            modal: false,
            webPreferences: { contextIsolation: true, nodeIntegration: false },
          });
          helpWin.setAutoHideMenuBar(false);
          helpWin.setMenuBarVisibility(true);
          helpWin.loadFile(HELP_PAGE).catch(() => {});
        }},
        { label: '检查更新…', click: () => { checkForUpdates(true); } },
        { type: 'separator' },
        { label: `关于 ${APP_NAME}`, click: () => {
          glassMessageBox(mainWindow, {
            type: 'info',
            title: `FNOS  v${APP_VERSION}`,
            buttons: ['确定'],
            width: 380,
          });
        }},
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------- IPC ----------------------
ipcMain.handle('auth:connect', async (_e, payload) => {
  try { connectTo((payload && payload.server) || ''); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message || '连接失败' }; }
});
ipcMain.handle('auth:load-history', async () => {
  const s = loadSettings();
  return { server: s.server || '', origin: s.origin || '', history: Array.isArray(s.history) ? s.history : [] };
});
ipcMain.handle('auth:back-to-connect', async () => { showConnectPage(); return true; });
ipcMain.handle('auth:remove-history', async (_e, payload) => {
  const partition = payload && payload.partition;
  if (!partition || typeof partition !== 'string') return { ok: false };
  return { ok: true, history: removeHistoryByPartition(partition) };
});

// ---------------------- 锁屏 / 设置 IPC ----------------------
ipcMain.handle('lock:get-info', async (e) => {
  // 从 URL query 读取初始 mode
  let mode = 'unlock';
  try {
    const url = e.sender.getURL();
    const u = new URL(url);
    const m = u.searchParams.get('mode');
    if (m === 'setup' || m === 'change' || m === 'unlock') mode = m;
  } catch (_) {}
  return {
    mode,
    hasPassword: hasAppPassword(),
    version: APP_VERSION,
  };
});

ipcMain.handle('lock:verify', async (_e, password) => {
  try {
    if (verifyAppPassword(String(password || ''))) {
      // 验证通过
      setImmediate(() => unlockApp());
      return { ok: true };
    }
    return { ok: false, error: '启动密码不正确' };
  } catch (err) {
    return { ok: false, error: err?.message || '验证失败' };
  }
});

ipcMain.handle('lock:set-password', async (_e, payload) => {
  try {
    const oldP = String(payload?.oldPassword || '');
    const newP = String(payload?.newPassword || '');
    if (newP.length > 0 && newP.length < 4) {
      return { ok: false, error: '新密码至少 4 位' };
    }
    setAppPassword(oldP, newP);
    // 首次设置密码成功，视为解锁
    setImmediate(() => {
      if (!hasAppPassword()) {
        // 清除了密码 — 保持解锁
      }
      // 刷新菜单（显示/隐藏"锁定"项）
      scheduleMenuRebuild();
    });
    return { ok: true };
  } catch (err) {
    if (err?.code === 'BAD_OLD_PASSWORD') return { ok: false, error: err.message };
    return { ok: false, error: err?.message || '保存失败' };
  }
});

ipcMain.handle('settings:get', async () => {
  const s = loadSettings();
  return {
    hasPassword: hasAppPassword(),
    shortcuts: { ...DEFAULT_SHORTCUTS, ...(s.shortcuts || {}) },
    urlRewrites: Array.isArray(s.urlRewrites) ? s.urlRewrites : [],
    autoHideMenuBar: !!s.autoHideMenuBar,
    glassTitleBar: !!s.glassTitleBar,
    themeColor: String(s.themeColor || '#4F6EF7'),
    version: APP_VERSION,
  };
});

ipcMain.handle('settings:set-password', async (_e, payload) => {
  try {
    const oldP = String(payload?.oldPassword || '');
    const newP = String(payload?.newPassword || '');
    if (newP.length > 0 && newP.length < 4) {
      return { ok: false, error: '新密码至少 4 位' };
    }
    setAppPassword(oldP, newP);
    scheduleMenuRebuild();
    return { ok: true };
  } catch (err) {
    if (err?.code === 'BAD_OLD_PASSWORD') return { ok: false, error: err.message };
    return { ok: false, error: err?.message || '保存失败' };
  }
});

ipcMain.handle('settings:set-shortcuts', async (_e, payload) => {
  try {
    const lockAcc = String(payload?.lockApp || '').trim();
    const hideAcc = String(payload?.hideAll || '').trim();
    if (lockAcc && !isValidAccelerator(lockAcc)) {
      return { ok: false, error: '锁定快捷键格式无效' };
    }
    if (hideAcc && !isValidAccelerator(hideAcc)) {
      return { ok: false, error: '隐藏快捷键格式无效' };
    }
    if (lockAcc && hideAcc && lockAcc === hideAcc) {
      return { ok: false, error: '两个快捷键不能相同' };
    }
    saveSettings({ shortcuts: { lockApp: lockAcc, hideAll: hideAcc } });
    registerGlobalShortcuts();
    scheduleMenuRebuild();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '保存失败' };
  }
});

ipcMain.handle('settings:set-url-rewrites', async (_e, list) => {
  try {
    const clean = (Array.isArray(list) ? list : [])
      .filter((r) => r && typeof r.match === 'string' && typeof r.replace === 'string')
      .map((r) => ({ match: r.match.trim(), replace: r.replace.trim() }))
      .filter((r) => r.match && r.replace);
    for (const r of clean) {
      try { new URL(r.replace); } catch { return { ok: false, error: `右侧地址无效：${r.replace}` }; }
    }
    saveSettings({ urlRewrites: clean });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '保存失败' };
  }
});

ipcMain.handle('settings:set-ui-options', async (_e, opts) => {
  try {
    const autoHide = !!opts?.autoHideMenuBar;
    const glassTitle = !!opts?.glassTitleBar;
    const accent = String(opts?.themeColor || cachedSettings.themeColor || '#4F6EF7');
    saveSettings({ autoHideMenuBar: autoHide, glassTitleBar: glassTitle, themeColor: accent });
    cachedSettings.autoHideMenuBar = autoHide;
    cachedSettings.glassTitleBar = glassTitle;
    cachedSettings.themeColor = accent;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.setAutoHideMenuBar(autoHide);
        w.setMenuBarVisibility(!autoHide);
        if (glassTitle && w.titleBarStyle !== 'hidden') {
          w.setTitleBarOverlay({ color: '#00000000', symbolColor: hexToRgba(accent, 0.9), height: 32 });
        }
      } catch (_) {}
    }
    scheduleMenuRebuild();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '保存失败' };
  }
});

ipcMain.on('settings:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('settings:set-accent-color', async (_e, color) => {
  try {
    const c = String(color || '#4F6EF7');
    saveSettings({ themeColor: c });
    cachedSettings.themeColor = c;
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.setTitleBarOverlay({ color: '#00000000', symbolColor: hexToRgba(c, 0.9), height: 32 }); } catch (_) {}
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '保存失败' };
  }
});

// ---------------------- 生命周期 ----------------------
app.on('second-instance', () => {
  if (isCompletelyHidden) {
    restoreFromCompletelyHidden();
    return;
  }
  if (isLocked) {
    if (!lockWindow || lockWindow.isDestroyed()) createLockWindow('unlock');
    else { try { lockWindow.showInactive(); lockWindow.focus(); } catch (_) {} }
    return;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  applyUA('persist:connect');
  applyUA('persist:default');

  const s = loadSettings();
  let initialPartition = 'persist:connect';
  let initialTarget = null;

  if (s.lastConnectHref && s.origin && s.currentPartition) {
    // 兼容旧版本：currentPartition 可能缺少 persist: 前缀
    initialPartition = s.currentPartition.startsWith('persist:')
      ? s.currentPartition
      : `persist:${s.currentPartition}`;
    initialTarget = { origin: s.origin, href: s.lastConnectHref };
    currentOrigin = s.origin;
    lastConnectHref = s.lastConnectHref;
    applyUA(initialPartition);
    try {
      const targetSes = session.fromPartition(initialPartition);
      const u = new URL(s.lastConnectHref);
      targetSes.resolveHost(u.host).catch(() => {});
      if (typeof targetSes.preconnect === 'function') {
        targetSes.preconnect({ url: s.lastConnectHref, numSocketsToPreconnect: 2 });
      }
    } catch (_) {}
  }

  startMenuAutoHide();

  // 启动密码
  if (hasAppPassword()) {
    isLocked = true;
    // 后台预加载主窗口（不显示）
    createMainWindow(initialPartition, initialTarget);
    ensureTray();
    createLockWindow('unlock');
  } else {
    createMainWindow(initialPartition, initialTarget);
    ensureTray();
  }

  // 注册全局快捷键
  registerGlobalShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(initialPartition, initialTarget);
    }
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
  persistAllSessions();
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  persistAllSessions();
});

setInterval(() => {
  if (mainWindow && !mainWindow.isDestroyed()) persistAllSessions();
}, 30000);
app.on('window-all-closed', () => {
  // 有托盘时不退出；用户显式退出时才退出
  if (app.isQuitting) {
    if (process.platform !== 'darwin') app.quit();
  }
});
