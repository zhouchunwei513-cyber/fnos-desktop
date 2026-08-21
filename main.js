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
const APP_VERSION = '1.13.0';
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
// v1.12: 磁盘缓存回调到 128MB（在"减少媒体重复下载"和"降低磁盘占用"之间折中）
app.commandLine.appendSwitch('disk-cache-size', '134217728');
// v1.12: V8 老生代 512MB 足够飞牛前端；新生代半空间 32MB 降低每个渲染进程的基础占用；
// --concurrent-recompilation 保持 JIT 并发；--jitless 不开启（会影响 WASM / 视频播放器性能）
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512 --max-semi-space-size=32 --concurrent-recompilation');
// 额外性能 / 响应速度优化（v1.12 合并 + 追加）
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
// v1.12 新增：降低空闲 / 后台资源占用，均不影响投屏 / 媒体键 / 自动更新等常见服务
app.commandLine.appendSwitch('disable-renderer-accessibility');      // 关闭渲染进程可访问性树，降低 CPU/内存（屏幕阅读器用户受影响，但极小众）
app.commandLine.appendSwitch('disable-speech-api');                 // 关闭 Web Speech，飞牛不使用
app.commandLine.appendSwitch('disable-notifications');             // 关闭网页 Notification API（飞牛不依赖，避免后台弹窗占资源）
app.commandLine.appendSwitch('disable-geolocation');                // 关闭地理位置
app.commandLine.appendSwitch('disable-remote-fonts');               // 禁止远程字体下载，避免字体服务长连接
app.commandLine.appendSwitch('disable-logging');                    // 关闭 Chromium 日志写盘
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
app.commandLine.appendSwitch('disable-features', [
  'CalculateNativeWinOcclusion',
  'Translate',
  'InterestFeedContentSuggestions',
  'UseChromeOSDirectVideoDecoder',
  'BackForwardCache',
  'LazyFrameLoading',
  'PrivacySandboxSettings4',
  'OptimizationHints',
  'MediaFeeds',
  // v1.12 新增：以下均为飞牛不使用、且常驻会消耗 CPU / 网络 / 内存的组件，
  // 不会影响投屏（MediaRouter/Cast/DIAL 已保留）、媒体键、自动更新、NAS 业务。
  'AccessibilityObjectModel',
  'AutoDisableAccessibility',
  'CertificateTransparencyComponentUpdater',
  'DesktopPWAsRunOnOsLogin',
  'GlobalMediaControlsCastStartStop',
  'HeavyAdPrivacyMitigations',
  'ImprovedCookieControls',
  'InfiniteSessionRestore',
  'LazyFrameLoading',
  'MediaRouterDialogController',
  'NotificationPlatformBridge',
  'OutOfBlinkCors',
  'PaymentApp',
  'PaymentRequest',
  'PermissionNotRecommendedIndicator',
  'PushMessaging',
  'QuietNotificationPrompts',
  'SafetyTip',
  'SharedArrayBuffer',
  'SigninFlowAsync',
  'SitePerProcess',                 // 关闭站点隔离：降低多进程内存占用（会轻微降低站点间安全隔离，但仅访问受信任的 NAS）
  'StoragePressureUI',
  'SubframeShutdownWaiter',
  'SyncDisclaimer',
  'ThumbnailCapturerWin',
  'TranslateInfoBar',
  'UiDevTools',
  'UseOfDeprecatedTlsCipherSuites',
  'WebBluetooth',
  'WebPayments',
  'WebUsb',
  'WebXr',
].join(','));

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
// v1.12.1：历史服务器列表单独存一份到 servers.json，并写 .bak 备份。
// 这是"历史地址不记录"的兜底：即使 settings.json 因 DPAPI/损坏/写入失败而读空，
// servers.json 仍是明文、原子写入、带备份，历史与上次连接信息不会丢。
const HISTORY_FILE = path.join(app.getPath('userData'), 'servers.json');
// v1.12.1：确保 userData 目录存在，避免便携版 / 首次运行时 settings.json 写入失败，
// 导致"历史地址不记录"（saveSettings 的 mkdir 在某些环境下静默失败）。
try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); } catch (_) {}
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
  raw = mergeHistoryStore(raw);
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
    // v1.12.1：settings.json 改为明文 JSON 存储。
    // 之前用 safeStorage(DPAPI) 加密，便携版换目录/换 Windows 账户或 DPAPI 异常时，
    // 解密会静默返回空，导致每次启动都读成空设置——表现为"历史地址不记录、
    // 上次服务器/登录状态丢失"。设置中仅含服务器地址等非敏感信息（不含密码，
    // NAS 登录态保存在各自 partition 的 Cookie 中），明文更可靠且可移植。
    const payload = JSON.stringify(cachedSettings);
    fs.writeFileSync(SETTINGS_FILE, payload, { mode: 0o600 });
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
  // v1.12.1：同步写入独立历史文件（明文 + 备份），双保险防丢失
  writeHistoryStore({
    history: list.slice(0, 10),
    server: serverInput.trim(),
    origin: parsed.origin,
    lastConnectHref: parsed.href,
    currentPartition: partition,
    lastConnectedAt: Date.now(),
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
  // v1.12.1：同步更新独立历史文件
  try {
    const hs = readHistoryStore();
    const hsList = (Array.isArray(hs.history) ? hs.history : []).filter((h) => h.partition !== partition);
    const hsPatch = { ...hs, history: hsList };
    if (hs.currentPartition === partition) {
      hsPatch.server = ''; hsPatch.origin = ''; hsPatch.lastConnectHref = '';
      hsPatch.currentPartition = 'persist:connect';
    }
    writeHistoryStore(hsPatch);
  } catch (_) {}
  // 清除该分区的存储数据（Cookie / localStorage / 缓存）
  try {
    const ses = session.fromPartition(partition);
    ses.clearStorageData().catch(() => {});
    ses.clearCache().catch(() => {});
  } catch (_) {}
  return list;
}

// v1.12.1：历史服务器独立持久化（明文 + 原子写 + .bak 备份），
// 不依赖可能受 DPAPI/损坏影响的 settings.json。仅存地址信息，不含密码。
function readHistoryStore() {
  const readOne = (p) => {
    try {
      if (fs.existsSync(p)) {
        const t = fs.readFileSync(p, 'utf-8').trim();
        if (t) {
          const o = JSON.parse(t);
          if (o && typeof o === 'object') return o;
        }
      }
    } catch (_) {}
    return null;
  };
  return readOne(HISTORY_FILE) || readOne(HISTORY_FILE + '.bak') || {};
}
function writeHistoryStore(store) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    // 先备份旧文件，再原子替换
    try { if (fs.existsSync(HISTORY_FILE)) fs.copyFileSync(HISTORY_FILE, HISTORY_FILE + '.bak'); } catch (_) {}
    fs.renameSync(tmp, HISTORY_FILE);
    return true;
  } catch (e) {
    console.warn('writeHistoryStore error', e);
    return false;
  }
}
// 供 loadSettings 合并：把 servers.json 里的历史/上次连接信息并入设置
function mergeHistoryStore(raw) {
  try {
    const hs = readHistoryStore();
    const hsList = Array.isArray(hs.history) ? hs.history : [];
    const curList = Array.isArray(raw.history) ? raw.history : [];
    if (hsList.length > 0 || curList.length > 0) {
      // 以 partition 去重合并，settings 里的优先（更新鲜）
      const map = new Map();
      for (const h of hsList) if (h && h.partition) map.set(h.partition, h);
      for (const h of curList) if (h && h.partition) map.set(h.partition, h);
      const merged = Array.from(map.values())
        .sort((a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0))
        .slice(0, 10);
      raw.history = merged;
    }
    // 上次连接信息：servers.json 与 settings 取最新
    if (!raw.server && hs.server) raw.server = hs.server;
    if (!raw.origin && hs.origin) raw.origin = hs.origin;
    if (!raw.lastConnectHref && hs.lastConnectHref) raw.lastConnectHref = hs.lastConnectHref;
    if ((!raw.currentPartition || raw.currentPartition === 'persist:connect') && hs.currentPartition) {
      raw.currentPartition = hs.currentPartition;
    }
  } catch (_) {}
  return raw;
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
// v1.11.0:
//  1) 彻底修复双保存对话框：使用跨 session 的全局下载注册表 + 活跃文件锁，
//     不论飞牛前端触发几次 will-download、URL 是否带 query、是否跨 redirect，
//     同一目标文件只弹一次保存框。
//  2) 保存对话框关闭后立即释放焦点，保存页不再残留。
//  3) 后台下载可通过托盘菜单「下载任务」子菜单、文件菜单「显示下载窗口」找回。
//  4) 取消下载仍走 pause -> 1.5s -> cancel 安全断开流程，不向 NAS 发 DELETE/PUT。
const activeDownloads = new Map(); // dlId -> { win, item, filename, savePath, state }
const finishedDownloads = []; // { filename, savePath, completedAt }，最多保留 10 条
const downloadWindows = new Map(); // dlId -> { win, item }（v1.12.1：补齐声明，否则 ReferenceError 导致进度窗不显示/菜单无任务）
let downloadSeq = 0;

// 全局去重：key = 文件名 + 文件总大小（同文件名 + 同大小视为同一文件，20 秒窗口）
const recentDownloadKeys = new Map(); // key -> timestamp
function buildDownloadKey(item) {
  try {
    const fname = (item.getFilename() || '').toLowerCase();
    const total = item.getTotalBytes() || 0;
    // URL 去掉 query / hash 后取 path 末段做辅助
    let pathSeg = '';
    try {
      const u = new URL(item.getURL() || '');
      pathSeg = u.pathname.split('/').pop() || '';
    } catch (_) {}
    return `${fname}::${total}::${pathSeg.toLowerCase()}`;
  } catch (_) {
    return `${Date.now()}_${Math.random()}`;
  }
}
function isDuplicateDownload(item) {
  const key = buildDownloadKey(item);
  const now = Date.now();
  const last = recentDownloadKeys.get(key) || 0;
  recentDownloadKeys.set(key, now);
  // 清理 20 秒前的记录
  if (recentDownloadKeys.size > 64) {
    for (const [k, t] of recentDownloadKeys) if (now - t > 20000) recentDownloadKeys.delete(k);
  }
  return now - last < 3000; // 3 秒内同 key 视为重复
}

function installDownloadTracker(ses) {
  if (!ses || ses.__fnosDlInstalled) return;
  ses.__fnosDlInstalled = true;

  ses.on('will-download', (event, item) => {
    // 1) 全局去重（跨所有 partition 生效）
    if (isDuplicateDownload(item)) {
      try { item.cancel(); } catch (_) {}
      return;
    }

    // 2) 关键修复：必须【同步】调用 setSavePath，否则 Electron/Chromium 会在
    //    will-download 回调返回后弹出它【自带】的保存对话框，叠加我们自定义的，
    //    就表现为"跳 2 个保存界面"。我们先指到一个唯一的 .part 临时文件占位，
    //    彻底抑制自带对话框；用户在我们自己的保存框里选定路径后，下载完成再把
    //    .part 重命名（移动）到目标路径。临时文件始终在系统 temp 目录，不接触 NAS。
    const tmpName = `fnos-dl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.part`;
    const tmpPath = path.join(app.getPath('temp'), tmpName);
    try { item.setSavePath(tmpPath); } catch (_) {}

    // 3) 同步暂停，防止对话框还没弹出就已经开始写盘
    try { item.pause(); } catch (_) {}

    // 4) 异步弹我们自己的保存对话框
    setImmediate(() => handleUserSaveDialog(item, tmpPath));
  });
}

async function handleUserSaveDialog(item, tmpPath) {
  const fname = item.getFilename() || '';
  const defaultPath = app.getPath('downloads');
  const saveDialogParent = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]);

  let finalPath = '';
  try {
    const r = await dialog.showSaveDialog(saveDialogParent || undefined, {
      title: '保存文件',
      defaultPath: path.join(defaultPath, fname),
      buttonLabel: '保存',
      filters: [{ name: '所有文件', extensions: ['*'] }],
      properties: [],
    });
    // 对话框关闭后立即把焦点还给父窗口，避免悬浮窗抢走焦点造成"保存页残留"
    if (saveDialogParent && !saveDialogParent.isDestroyed()) {
      try { saveDialogParent.focus(); } catch (_) {}
    }
    if (r.canceled || !r.filePath) {
      try { item.cancel(); } catch (_) {}
      return;
    }
    finalPath = r.filePath;
  } catch (e) {
    console.error('save dialog failed', e);
    try { item.cancel(); } catch (_) {}
    return;
  }

  // 用户点了保存 → 立刻显示进度窗口（在 resume 之前），再开始下载到 tmp；
  // 下载完成后 onDone 里把 tmp rename 到 finalPath。
  try {
    showDownloadProgress(item, finalPath, tmpPath);
  } catch (e) {
    // 进度窗口创建失败也不能让下载挂起：直接恢复下载并记录日志
    console.error('showDownloadProgress failed', e);
  }
  try { item.resume(); } catch (_) {}
}

function showDownloadProgress(item, finalPath, tmpPath) {
  const totalBytes = item.getTotalBytes();
  const fname = item.getFilename();
  const dlId = ++downloadSeq;
  const CH_CANCEL = `download:cancel:${dlId}`;
  const CH_OPEN = `download:open:${dlId}`;
  const CH_CLOSE = `download:close:${dlId}`;

  const win = new BrowserWindow({
    width: 560, height: 210,
    minWidth: 480,
    minHeight: 200,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: ICON_PATH,
    backgroundColor: '#00000000',
    parent: undefined, // 不绑定父窗口，避免主窗最小化时下载窗也被隐藏
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
  activeDownloads.set(dlId, {
    win, item, filename: fname,
    savePath: finalPath || tmpPath || '',  // UI 显示用户选定的最终路径
    tmpPath: tmpPath || '',
    finalPath: finalPath || '',
    state: 'progressing', pct: 0,
  });
  downloadWindows.set(dlId, { win, item });
  // 立即刷新菜单，让"下载任务"子菜单立刻出现该任务（v1.12.1：修复菜单为空）
  try { rebuildTrayMenu(); buildMenu(); } catch (_) {}

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch (_) {}
    }
  };
  const fmtMB = (b) => b > 0 ? `${(b / 1024 / 1024).toFixed(2)} MB` : '—';

  // 把下载到 .part 的临时文件移动（重命名）到用户选定的最终位置。
  // 使用 move+exdev：同盘走 rename，跨盘自动回退到 copy+unlink。
  const finalizeDownload = () => {
    if (!tmpPath || !finalPath) return;
    try {
      if (fs.existsSync(tmpPath)) {
        // 若目标已存在，先删除（用户在保存框已确认过覆盖）
        try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (_) {}
        fs.renameSync(tmpPath, finalPath);
      }
    } catch (e) {
      // EXDEV 跨设备：回退到 copyFile + unlink
      try {
        fs.copyFileSync(tmpPath, finalPath);
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      } catch (e2) {
        console.error('finalize download failed', e2);
      }
    }
  };

  const cleanupTmp = () => {
    if (tmpPath) { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {} }
  };

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
    const info = activeDownloads.get(dlId);
    if (info) {
      if (info.state === 'completed' && info.savePath) {
        finishedDownloads.unshift({
          filename: info.filename,
          savePath: info.savePath,
          completedAt: Date.now(),
        });
        if (finishedDownloads.length > 10) finishedDownloads.length = 10;
      }
      activeDownloads.delete(dlId);
    }
    try { rebuildTrayMenu(); buildMenu(); } catch (_) {}
  };

  win.loadFile(path.join(__dirname, 'download.html')).catch(() => {});
  win.once('ready-to-show', () => {
    send('download:start', {
      filename: fname,
      savePath: finalPath || tmpPath || '',
      totalBytes,
      totalText: fmtMB(totalBytes),
      canResume: item.canResume(),
    });
    if (!win.isDestroyed()) {
      // 用 show() 而非 showInactive()，确保进度条窗口一定可见（修复"进度条不见了"）
      try { win.show(); win.focus(); } catch (_) { try { win.showInactive(); } catch (_) {} }
    }
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
      const info = activeDownloads.get(dlId);
      if (info) { info.pct = pct; info.savePath = item.getSavePath() || info.savePath; }

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
    const info = activeDownloads.get(dlId);
    if (info) {
      info.state = state;
      // 完成后把 .part 移动到最终路径，并把注册表中的 savePath 改成最终路径
      if (state === 'completed') {
        finalizeDownload();
        if (finalPath) info.savePath = finalPath;
      } else {
        // 取消 / 中断：清理 .part 临时文件
        cleanupTmp();
      }
    } else {
      // info 已被清理时也兜底删除临时文件
      if (state !== 'completed') cleanupTmp();
    }
    send('download:done', {
      state,
      savePath: state === 'completed' ? (finalPath || tmpPath) : tmpPath,
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
    try { rebuildTrayMenu(); buildMenu(); } catch (_) {}
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
    // 完成后用最终路径；未完成时 item.getSavePath() 是 .part 临时路径，定位其所在目录即可
    try { shell.showItemInFolder(finalPath || item.getSavePath()); } catch (_) {}
  });
  // 用户点 X 关闭或"后台运行"：仅隐藏进度窗口，不取消下载。托盘/菜单可随时找回。
  ipcMain.handle(CH_CLOSE, () => {
    try { if (win && !win.isDestroyed()) win.hide(); } catch (_) {}
    try { rebuildTrayMenu(); buildMenu(); } catch (_) {}
  });
  win.on('close', (e) => {
    // 下载未完成时，阻止窗口真正关闭，改为隐藏
    if (!item.isDone() && !closed) {
      e.preventDefault();
      try { win.hide(); } catch (_) {}
      try { rebuildTrayMenu(); buildMenu(); } catch (_) {}
    }
  });
}

// "下载任务" 子菜单内容
function buildDownloadsMenu() {
  const items = [];
  if (activeDownloads.size > 0) {
    for (const [dlId, info] of activeDownloads) {
      let label = info.filename || '下载任务';
      if (label.length > 34) label = label.slice(0, 34) + '…';
      const pct = typeof info.pct === 'number' ? `${Math.round(info.pct)}%` : '';
      items.push({ label: pct ? `${label}  ${pct}` : label, click: () => showDownloadWindow(dlId) });
    }
    items.push({ type: 'separator' });
    items.push({ label: '显示全部下载窗口', click: () => showAllDownloadWindows() });
  } else {
    items.push({ label: '（暂无正在进行的下载）', enabled: false });
  }
  if (finishedDownloads.length > 0) {
    items.push({ type: 'separator' });
    items.push({ label: '最近完成', enabled: false });
    finishedDownloads.slice(0, 8).forEach((f, idx) => {
      let label = f.filename || '已完成下载';
      if (label.length > 34) label = label.slice(0, 34) + '…';
      items.push({ label, click: () => openFinishedDownload(idx) });
    });
  }
  return items;
}

// 显示 / 聚焦一个正在后台运行的下载窗口
function showDownloadWindow(dlId) {
  const info = activeDownloads.get(dlId);
  if (info && info.win && !info.win.isDestroyed()) {
    if (info.win.isMinimized()) info.win.restore();
    info.win.showInactive();
    info.win.focus();
    return true;
  }
  return false;
}

// 显示所有进行中的下载窗口
function showAllDownloadWindows() {
  for (const dlId of activeDownloads.keys()) {
    showDownloadWindow(dlId);
  }
}

// 从托盘"最近完成"子菜单打开文件所在文件夹
function openFinishedDownload(dlIdOrIdx) {
  const idx = Number(dlIdOrIdx);
  const item = Number.isFinite(idx) ? finishedDownloads[idx] : finishedDownloads.find((f) => f.savePath === dlIdOrIdx);
  if (item && item.savePath) {
    try { shell.showItemInFolder(item.savePath); } catch (_) {}
  }
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
    // v1.12.1：每次主框架导航后立即把 Cookie / localStorage 落盘，
    // 确保登录态不会因为强杀进程而丢失（Electron 默认有延迟写盘）。
    try {
      const ses = win.webContents.session;
      if (ses && typeof ses.cookies.flushStorageData === 'function') {
        ses.cookies.flushStorageData().catch(() => {});
      }
    } catch (_) {}
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

  // 后台下载（点 X 隐藏后的下载任务）：使用全局 activeDownloads 注册表
  if (activeDownloads.size > 0) {
    items.push({ type: 'separator' });
    const submenu = [];
    for (const [dlId, info] of activeDownloads) {
      let label = info.filename || '下载任务';
      if (label && label.length > 30) label = label.slice(0, 30) + '…';
      const pct = typeof info.pct === 'number' ? `${Math.round(info.pct)}%` : '';
      if (pct) label = `${label}  ${pct}`;
      submenu.push({ label, click: () => showDownloadWindow(dlId) });
    }
    submenu.push({ type: 'separator' });
    submenu.push({ label: '显示全部下载窗口', click: () => showAllDownloadWindows() });
    items.push({ label: `正在下载（${activeDownloads.size}）`, submenu });
  }

  // 最近完成的下载（最多 5 条），点击打开所在文件夹
  if (finishedDownloads.length > 0) {
    if (activeDownloads.size === 0) items.push({ type: 'separator' });
    const recent = finishedDownloads.slice(0, 5);
    const submenu = recent.map((f, idx) => {
      let label = f.filename || '已完成下载';
      if (label.length > 30) label = label.slice(0, 30) + '…';
      return { label, click: () => openFinishedDownload(idx) };
    });
    items.push({ label: '最近完成的下载', submenu });
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
  // v1.12.1：立即把历史写入磁盘，避免 30s 定时 flush 前进程被强杀导致历史不记录
  try { flushPartition(targetPartition); } catch (_) {}

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
    // 打包后：app.asar 内的 bin/mpv/mpv.exe 通过 asarUnpack 解包到 app.asar.unpacked/bin/mpv/mpv.exe
    // （可执行文件无法直接从 asar 内 spawn，必须走 unpacked 路径）
    const prodPath = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'bin', 'mpv', 'mpv.exe');
    if (fs.existsSync(prodPath)) return prodPath;
    // 兼容历史 / extraResources 布局
    const prodPath2 = path.join(process.resourcesPath || '', 'bin', 'mpv', 'mpv.exe');
    if (fs.existsSync(prodPath2)) return prodPath2;
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

// 打开系统终端，工作目录定位到内置 MPV 所在目录，方便直接运行 mpv.exe <视频地址>。
// 实现要点：把命令写进一个临时 .bat 文件再用 start 执行，彻底绕开 spawn 参数重组
// 与 cmd start "标题" 引号/中文被二次解析的问题（否则会报 "Windows 找不到文件 '终端'"）。
function openSystemTerminal() {
  try {
    let cwd = '';
    try {
      const mpv = findExternalPlayer();
      if (mpv) cwd = path.dirname(mpv);
    } catch (_) {}
    if (!cwd || !fs.existsSync(cwd)) {
      try { cwd = app.isPackaged ? path.dirname(process.execPath) : __dirname; } catch (_) {}
    }
    if (!cwd || !fs.existsSync(cwd)) cwd = app.getPath('home') || process.env.SystemRoot || 'C:\\';

    if (process.platform !== 'win32') {
      // 非 Windows 兜底（当前项目仅面向 Windows）
      const term = process.env.TERM_PROGRAM || 'xterm';
      cp.spawn(term, [], { cwd, detached: true, stdio: 'ignore' }).unref();
      return;
    }

    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const ps = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const comspec = process.env.ComSpec || path.join(sysRoot, 'System32', 'cmd.exe');
    const usePs = fs.existsSync(ps);

    // 生成临时批处理：chcp 65001 切 UTF-8，cd /d 切目录，start 开新控制台窗口并保持。
    // 标题用纯 ASCII "FNOS Terminal"，避免中文标题在某些代码页下被解析成程序名。
    const batPath = path.join(app.getPath('temp'), `fnos-term-${process.pid}-${Date.now()}.bat`);
    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      `cd /d "${cwd}"`,
    ];
    if (usePs) {
      lines.push(`start "FNOS Terminal" "${ps}" -NoExit -Command "$Host.UI.RawUI.WindowTitle='FNOS Terminal'"`);
    } else {
      lines.push(`start "FNOS Terminal" "${comspec}" /k title FNOS Terminal`);
    }
    fs.writeFileSync(batPath, lines.join('\r\n'), { encoding: 'utf8' });

    // detached 启动该 bat；bat 执行完后自删（用 start "" /b 后台删除，避免占用）
    const child = cp.spawn(comspec, ['/c', batPath], {
      detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.on('error', () => {});
    child.unref();
    // 延迟删除临时 bat（等它执行完）
    setTimeout(() => { try { if (fs.existsSync(batPath)) fs.unlinkSync(batPath); } catch (_) {} }, 5000);
  } catch (e) {
    console.error('open system terminal failed', e);
    try {
      glassErrorBox(mainWindow, '打开系统终端失败：' + (e.message || e));
    } catch (_) {}
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
      label: '下载',
      submenu: buildDownloadsMenu(),
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
        ...(IS_DEV ? [{ type: 'separator' }, { role: 'toggleDevTools', label: '开发者工具' }] : []),
      ],
    },
    {
      label: '工具',
      submenu: [
        { label: '用 MPV 打开当前视频（硬解）',
          click: withWebContents((wc, win) => { openInMpv(wc, win); }) },
        { type: 'separator' },
        { label: '系统终端', accelerator: 'Ctrl+`',
          click: () => openSystemTerminal() },
        { label: 'MPV 安装目录',
          click: () => {
            const mpv = findExternalPlayer();
            if (mpv) {
              try { shell.showItemInFolder(mpv); } catch (_) {}
            } else {
              glassErrorBox(mainWindow, '未找到内置 MPV 播放器（bin/mpv/mpv.exe）。');
            }
          } },
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
  // v1.12.1：诊断日志——记录实际使用的 userData 目录和设置文件路径，
  // 便于排查"历史记录丢失"（常见原因是旧实例仍在托盘运行占用单实例锁，
  // 新解压的 exe 根本没启动，或误判了数据目录）。
  try {
    const diag = [
      `[FNOS] userData = ${app.getPath('userData')}`,
      `[FNOS] settings = ${SETTINGS_FILE}`,
      `[FNOS] history  = ${HISTORY_FILE}`,
      `[FNOS] exe      = ${process.execPath}`,
      `[FNOS] version  = ${APP_VERSION}`,
      `[FNOS] time     = ${new Date().toISOString()}`,
      '',
    ].join('\n');
    fs.appendFileSync(path.join(app.getPath('userData'), 'fnos-diag.log'), diag);
  } catch (_) {}
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
