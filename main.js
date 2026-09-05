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
  globalShortcut, net, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const cp = require('child_process');

// v1.25.0：MPV 外部播放器（参考客户端 fntv 方案）——统一播放所有格式
// （MKV/MP4/HEVC 10bit/4K、HLS/FLV/RTSP）。MPV 自带 ffmpeg 全编解码，以独立窗口播放；
// 模块自身做全平台防御，非 Windows / 二进制缺失时不可用，内置直播不受影响（仍走 hls.js）。
let MpvPlayerMod = null;
try { MpvPlayerMod = require('./mpv-player.js'); } catch (e) { MpvPlayerMod = null; try { liveLog('error', 'mpv.module.load.fail', { err: String(e && e.message || e) }); } catch (_) {} }
let MpvSurfaceMod = null;
try { MpvSurfaceMod = require('./mpv-surface.js'); } catch (e) { MpvSurfaceMod = null; try { liveLog('error', 'mpv.surface.load.fail', { err: String(e && e.message || e) }); } catch (_) {} }
// 内置 MPV 的本地助手服务（在线字幕搜索/下载解压、本地字幕文件对话框、画中画），
// 仅监听 127.0.0.1，mpv 内中文右键菜单 lua 经 Windows 自带 curl.exe 调用。
let MpvHelperMod = null;
try { MpvHelperMod = require('./mpv-helper.js'); } catch (e) { MpvHelperMod = null; try { liveLog('error', 'mpv.helper.load.fail', { err: String(e && e.message || e) }); } catch (_) {} }

// v1.17.7：彻底移除本地代理模块（proxy.js/8340 端口/webRequest 拦截），
// 所有直播流（内置播放器 + 飞牛影视网页）直连 FPK 服务端，链路最短化。
// 相关历史 IPC（iptv:get-status/set-config/clear-cache/toggle-proxy）已全部删除。

// v1.18.1：彻底解决启动绿屏/花屏/黑屏问题。部分 Win11/Intel 核显/老 N 卡环境下，
// Chromium 的 GPU 合成会导致页面渲染为纯绿色，部分用户无法进入下一步。
// 统一关闭 GPU 合成相关特性（视频仍走硬件解码，性能影响极小），不再提供开关。
if (process.platform === 'win32') {
  try {
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('disable-gpu-rasterization');
    app.commandLine.appendSwitch('disable-zero-copy');
    app.commandLine.appendSwitch('disable-gpu-compositing-triggers');
    // 禁用 GPU 合成，强制 CPU 合成，从根源消除绿屏（仍保留视频硬件解码）
    app.commandLine.appendSwitch('disable-gpu-compositing');
    // v1.23.0：开启 Windows 平台 HEVC/H.265 硬解，修复 4K 直播/影视无法播放
    // PlatformHEVCDecoderSupport：启用系统 HEVC 解码器（需安装 HEVC 视频扩展）
    // D3D11VideoDecoder：D3D11 硬解；MojoVideoDecoder：新版视频解码管线
    // v1.23.0：开启 Windows 平台 HEVC/H.265 硬解。Chromium 同名 --enable-features 只保留最后一次
    // 值，因此这些项已并入下方唯一的 --enable-features 列表（v1.29.2），这里不再单独 append。
    // PlatformHEVCDecoderSupport：启用系统 HEVC 解码器（需安装 HEVC 视频扩展）
    // D3D11VideoDecoder：D3D11 硬解；MojoVideoDecoder：新版视频解码管线
    // 允许 MSE 承载 HEVC/FLAC 等扩展编码；关闭自动降级到纯软件解码（部分 4K HEVC 软解会卡死）
    app.commandLine.appendSwitch('enable-blink-features', 'MediaSourceInlinePainting,EncryptedMediaHardwareSecureCodecs');
    // v1.29.2：Chromium 对同名 --disable-features 只保留最后一次值，故不在此再 append；
    // UseChromeOSDirectVideoDecoder / HardwareMediaKeyHandling 已并入下方唯一的 --disable-features 列表。
    // 增大媒体缓存与网络缓冲，应对网络抖动
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
    app.commandLine.appendSwitch('disk-cache-size', String(200 * 1024 * 1024));
    app.commandLine.appendSwitch('media-cache-size', String(200 * 1024 * 1024));
    // 关闭后台定时器/渲染器节流，播放时不被系统挂起
    app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    // 高清屏 DPI
    app.commandLine.appendSwitch('high-dpi-support', '1');
  } catch (_) {}
}

// v1.16.2：全局兜底——未捕获异常 / 未处理 Promise 拒绝时只记录日志，绝不闪退
process.on('uncaughtException', (err) => {
  try {
    const msg = (err && err.stack) ? err.stack : String(err);
    console.error('[FNOS] uncaughtException:', msg);
    try {
      fs.appendFileSync(
        path.join(app.getPath('userData'), 'fnos-diag.log'),
        `[FNOS] uncaughtException: ${msg}\n`
      );
    } catch (_) {}
  } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try {
    const msg = (reason && reason.stack) ? reason.stack : String(reason);
    console.warn('[FNOS] unhandledRejection:', msg);
    try {
      fs.appendFileSync(
        path.join(app.getPath('userData'), 'fnos-diag.log'),
        `[FNOS] unhandledRejection: ${msg}\n`
      );
    } catch (_) {}
  } catch (_) {}
});

// 版本号（与 package.json 保持一致）
const APP_VERSION = '1.36.1';
// Windows 任务栏 / 通知分组所需的 AppUserModelID（必须与 package.json build.appId 一致）
// 未设置时 Windows 会把 Electron 应用归到默认 Electron AUMID，导致任务栏图标显示为 Electron 默认图标
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.fnos.client'); } catch (_) {}
}

// v1.16.4 / v1.17.1：便携版 userData 重定向
// 检测环境变量 PORTABLE_EXECUTABLE_DIR（electron-builder portable 启动时自动注入，
// 指向 FNOS.exe 所在目录）。若存在则把 userData 改到 exe 同级 data/ 下，
// 实现真正的便携隔离；安装版无此环境变量，继续使用系统 %AppData%\fnos-client。
// 必须在任何 app.getPath('userData') 调用之前执行（本文件 SETTINGS_FILE 在后面定义）。
(function setupPortableUserData() {
  try {
    const path = require('path');
    const fs = require('fs');
    const os = require('os');

    // 多种信号综合判定便携版：
    // 1) PORTABLE_EXECUTABLE_DIR（electron-builder portable 标准注入）
    // 2) 进程可执行文件位于 *.exe（Windows）且其同级目录存在 portable 标记
    // 3) 环境变量 FNOS_PORTABLE=1（用户手动强制便携模式）
    let exeDir = process.env.PORTABLE_EXECUTABLE_DIR || '';
    let detectedBy = 'PORTABLE_EXECUTABLE_DIR';

    if (!exeDir && process.env.FNOS_PORTABLE === '1') {
      // 用户显式标记为便携版
      exeDir = path.dirname(process.execPath);
      detectedBy = 'FNOS_PORTABLE=1';
    }

    if (!exeDir && process.platform === 'win32') {
      // 兜底：electron-builder portable 在某些启动方式下不注入 PORTABLE_EXECUTABLE_DIR
      // （例如直接双击解压后再运行），此时通过检测 exe 同级是否存在 `PORTABLE` 标记文件，
      // 或者 exe 路径位于用户常见的「下载/桌面/U盘」类可写目录，自动识别为便携版。
      try {
        const cand = path.dirname(process.execPath);
        if (cand && path.isAbsolute(cand)) {
          const marker = path.join(cand, 'PORTABLE');
          if (fs.existsSync(marker)) {
            exeDir = cand;
            detectedBy = 'PORTABLE marker';
          }
        }
      } catch (_) {}
    }

    if (!exeDir) return; // 安装版：保持默认系统目录

    // v1.17.1：用户明确要求数据目录名为 data（而非 userdata），与 7z 绿色版习惯一致
    const dataDir = path.join(exeDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });

    // 可写性校验（写测试文件，失败则弹框提示，不静默失效）
    const testFile = path.join(dataDir, '.write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);

    // 同时重定向所有可能写入用户数据的路径，确保完全便携
    app.setPath('userData', dataDir);
    app.setPath('sessionData', dataDir); // cookie/cache 也落便携目录
    try { app.setPath('appData', dataDir); } catch (_) {}
    // 部分 Electron 版本会单独使用 crashDumps 目录
    try { app.setPath('crashDumps', path.join(dataDir, 'crashDumps')); } catch (_) {}

    // v1.17.1：启动日志中增加便携版标识，方便用户确认重定向是否生效
    const logLine = `[FNOS] PORTABLE mode detected by=${detectedBy}, exeDir=${exeDir}, userData=${dataDir}, platform=${process.platform}, tmp=${os.tmpdir()}`;
    console.log(logLine);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(path.join(dataDir, 'fnos-portable.log'),
        `[${new Date().toISOString()}] ${logLine}\n`, { encoding: 'utf-8' });
    } catch (_) {}
  } catch (e) {
    try {
      const { dialog } = require('electron');
      dialog.showErrorBox(
        '便携版数据目录不可写',
        `无法在程序目录创建/写入 data 文件夹：\n${e && e.message || e}\n\n请把 FNOS.exe 解压到有写入权限的目录后重试（例如桌面、D 盘），不要放在 Program Files 等系统目录。`
      );
    } catch (_) {}
  }
})();

// ---------------------- 启动性能开关 ----------------------
// v1.10.5: 重要红线 —— 不影响 NAS 服务器内已安装/将来安装的应用启动与运行。
// 之前为了"性能优化"禁用了 MediaRouter / CastMediaRouteProvider / DialMediaRouteProvider /
// GlobalMediaControls / HardwareMediaKeyHandling 等服务，这些会影响飞牛影视的投屏、
// 媒体控制、硬件多媒体键等功能，v1.10.5 全部恢复，只保留与 NAS 业务无关、纯性能向的开关。
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// v1.29.2：放宽第三方 Cookie / SameSite 限制（合并进下方唯一的 --disable-features 列表，
// 见 SameSiteByDefaultCookies 等项）。FN ID 登录(FN Connect)跨 fnos.net/static2.fnnas.com 跨站
// 带凭据请求，Chromium108 默认较严格会导致登录 cookie 写不回 → "FN ID 无法登录"。
// 注意：Chromium 对同名 --disable-features 只保留最后一次的值，所有要禁用的特性
// 必须合并到这一个列表里，否则前面的设置会被覆盖（曾导致 Win11 绿屏修复失效）。
app.commandLine.appendSwitch('disable-features', [
  // v1.23.0：保留硬件媒体键关闭（原先单独 append 会被本列表覆盖，现并入此处）
  'HardwareMediaKeyHandling',
  'CalculateNativeWinOcclusion',    // 减少窗口遮挡检测开销（不影响业务）
  'DCRendererIsolation',            // 关闭 DirectComposition 后台层（Win11 登录页绿屏主要诱因）
  'Translate',                      // 不需要网页翻译
  'InterestFeedContentSuggestions', // 不需要内容推荐
  'UseChromeOSDirectVideoDecoder',  // Win 上走其他解码器
  'BackForwardCache',               // 关闭 BFC 避免飞牛多窗口状态错乱
  'LazyFrameLoading',               // 子窗口立即加载，避免后台 frame 冻结
  'PrivacySandboxSettings4',        // 隐私沙盒相关，与 NAS 无关
  'OptimizationHints',              // Chrome 优化提示，与 NAS 无关
  'MediaFeeds',                     // 媒体订阅 feed，NAS 不用
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
  'SitePerProcess',                 // 关闭站点隔离：降低多进程内存占用（仅访问受信任的 NAS）
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
  // v1.14 追加：飞牛不使用、常驻会占用内存/网络的组件
  'UserMediaScreenCapturer',        // 屏幕采集，飞牛不用
  'MachineLearningDeviceProvider',  // WebNN/ML 设备提供，飞牛不用
  'WebOORasterization',             // 由 GPU 光栅化覆盖，关闭 OOR 路径减少重复
  'MediaSessionWebRTC',             // WebRTC 通话，飞牛不用
  'IdleDetection',                  // 空闲检测 API，飞牛不用
  'PeriodicBackgroundSync',         // 周期性后台同步，飞牛不用
  'ComputePressure',                // 设备压力上报，飞牛不用
  // v1.29.2：放宽第三方 Cookie / SameSite（FN ID 登录 FN Connect 跨 fnos.net/static2.fnnas.com
  // 跨站带凭据请求，默认严格策略会导致登录 cookie 写不回 → "FN ID 无法登录"）
  'SameSiteByDefaultCookies',
  'CookiesWithoutSameSiteMustBeSecure',
  'SchemefulSameSite',
  'ThirdPartyCookieBlocking',
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
  // v1.29.2：HEVC/H.265 硬解（原在 win32 块里单独 append 会被本列表覆盖，现并入这里生效）
  'PlatformHEVCDecoderSupport',
  'D3D11VideoDecoder',
  'MojoVideoDecoder',
  'PlatformEncryptedVerification',
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
// v1.18.0：移除 disable-remote-fonts——它会阻止 Jellyfin 等 Docker 应用的图标字体加载，导致界面信息丢失
app.commandLine.appendSwitch('disable-logging');                    // 关闭 Chromium 日志写盘
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
// v1.14 性能追加（依据最新 Electron/Chromium 性能文档，均为飞牛业务无关的纯性能项）：
app.commandLine.appendSwitch('num-raster-threads', '4');          // 光栅化使用 4 线程，加快首屏绘制
app.commandLine.appendSwitch('force-color-profile', 'srgb');      // 跳过色彩管理转换开销

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

// 配置系统原生"关于"面板，确保版本号正确显示
try {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: `v${APP_VERSION}`,
    version: `v${APP_VERSION}`,
    credits: 'FNOS 桌面客户端',
    copyright: '© fnos.net',
  });
} catch (_) {}
const LOGIN_PAGE = path.join(__dirname, 'login.html');
const HELP_PAGE = path.join(__dirname, 'help.html');
const DIALOG_PAGE = path.join(__dirname, 'dialog.html');
const DIALOG_PRELOAD = path.join(__dirname, 'dialog-preload.js');
const LOCK_PAGE = path.join(__dirname, 'lock.html');
const LOCK_PRELOAD = path.join(__dirname, 'lock-preload.js');
const SETTINGS_PAGE = path.join(__dirname, 'settings.html');
const SETTINGS_PRELOAD = path.join(__dirname, 'settings-preload.js');
// v1.14 玻璃外壳（自绘标题栏/菜单栏）
const SHELL_PAGE = path.join(__dirname, 'shell.html');
const SHELL_PRELOAD = path.join(__dirname, 'shell-preload.js');
// v1.16：原生直播播放器（独立窗口，hls.js 直连本地代理，彻底绕开 webview 拦截黑盒）
const LIVE_PAGE = path.join(__dirname, 'live.html');
const LIVE_PRELOAD = path.join(__dirname, 'live-preload.js');
// v1.25.0：外部浏览器 hls.js 播放服务（48900）已移除——特殊编码（HEVC/4K/MKV）统一由内置 MPV 播放。
// v1.16.1：XTE.fpk 服务默认端口与端口候选（FNOS Web UI 在 5666，XTE 独立在 34500）
const XTE_DEFAULT_PORT = 34500;
// NAS 常见的 XTE 端口候选（用户可能在 FPK 配置里改过端口），探测时依次尝试
const XTE_PORT_CANDIDATES = [XTE_DEFAULT_PORT, 5666, 8340, 8080, 80, 5000];
// 已探测成功的 XTE 基地址缓存（进程级，避免每次拉列表都探测）
let g_cachedXteBase = '';
let g_cachedXteBaseAt = 0;
const XTE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟缓存
// 直播唤起去抖：webview 中 setWindowOpenHandler 和 will-navigate 可能同时触发
let g_lastLiveInvokeAt = 0;
let g_lastLiveInvokeUrl = '';
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
// v1.23.6：每个 webContents 最近一次主媒体地址（飞牛影视 SPA 内播放时追踪真实视频流）
const lastMediaByWc = new Map(); // webContentsId -> { url, at }
let menuRebuildTimer = null;
let g_persistTimer = null;

// v1.17.7：统一的窗口/页面对象存活校验，杜绝 "Object has been destroyed"
function isAlive(win) {
  return !!(win && typeof win.isDestroyed === 'function' && !win.isDestroyed()
    && win.webContents && !win.webContents.isDestroyed());
}
function safeSend(win, channel, ...args) {
  try { if (isAlive(win)) win.webContents.send(channel, ...args); } catch (_) {}
}
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
    // v1.10.2：主题色（仅影响标题栏叠加色，不动页面内配色）
    // 可选：'#1e1b2e'（默认深紫黑）、'#0f172a'（深蓝）、'#101828'（纯黑）、'#1f2937'（石墨）、'#312e81'（靛蓝）、'#831843'（酒红）
    themeColor: '#1e1b2e',
    // v1.16.1：无操作自动锁定（分钟），0 = 关闭；仅在已设置启动密码时生效
    autoLockMinutes: 0,
    // v1.17.7：本地代理模块已彻底移除。保留 iptv 段仅用于收藏/线路等用户数据，
    // 历史 proxy 相关字段（enabled/prefetch/maxCacheSegments/maxCacheMB/matchHosts/defaultPlayer）
    // 在 loadSettings 时会自动清理，不再生效。
    iptv: {
      iptvBaseUrl: '',       // 自定义直播列表基地址（如 http://nas:34500），留空用 currentOrigin
      iptvLine: 'inner',     // 订阅线路：inner / ipv6 / frp
      iptvFavorites: [],     // 收藏的频道名称（持久化）
      iptvEpgUrl: '',        // v1.23.0：EPG 节目单地址（XMLTV），留空则从 M3U 头 x-tvg-url 读取
      iptvCacheSeconds: 20,  // v1.23.0：直播分片内存缓存秒数（0-120），应对网络抖动
    },
    // v1.18.0：渲染异常兜底（Win11 绿屏）。true 时下次启动禁用硬件加速，默认关闭。
    disableGpu: false,
    // v1.26.6：MPV 默认 d3d11va 零拷贝硬解（N100/Intel 核显双路 4K 关键），gpu-context=d3d11
    mpv: {
      enabled: true,           // 网页无法播放时允许用 MPV 兜底弹出
      hwDecode: 'auto',        // auto/d3d11va -> d3d11va 零拷贝；dxva2 -> copy；no -> 软解
    },
  };
}

// 读取 MPV 设置（带默认值归一化）
function getMpvSettings() {
  try {
    const s = loadSettings();
    const v = (s.mpv && typeof s.mpv === 'object') ? s.mpv : {};
    // auto / auto-safe 统一归一为 d3d11va（Windows Intel 核显零拷贝，CPU 占用最低）
    let hw = ['auto', 'auto-safe', 'd3d11va', 'dxva2', 'no'].includes(v.hwDecode) ? v.hwDecode : 'auto';
    if (hw === 'auto-safe') hw = 'd3d11va';
    const cacheLevel = ['standard', 'smooth', 'unlimited'].includes(v.cacheLevel) ? v.cacheLevel : 'smooth';
    return { enabled: v.enabled !== false, hwDecode: hw, cacheLevel };
  } catch (_) {
    return { enabled: true, hwDecode: 'auto', cacheLevel: 'smooth' };
  }
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
  // v1.17.7：IPTV 仅保留收藏/线路/基地址，历史代理字段自动清理。
  const rawIptv = (raw.iptv && typeof raw.iptv === 'object') ? raw.iptv : {};
  cachedSettings.iptv = {
    iptvBaseUrl: typeof rawIptv.iptvBaseUrl === 'string' ? rawIptv.iptvBaseUrl : '',
    iptvLine: rawIptv.iptvLine === 'ipv6' || rawIptv.iptvLine === 'frp' ? rawIptv.iptvLine : 'inner',
    iptvFavorites: Array.isArray(rawIptv.iptvFavorites) ? rawIptv.iptvFavorites.filter((x) => typeof x === 'string') : [],
    // v1.23.0：EPG 地址与直播缓存秒数
    iptvEpgUrl: typeof rawIptv.iptvEpgUrl === 'string' ? rawIptv.iptvEpgUrl.trim() : '',
    iptvCacheSeconds: Math.max(0, Math.min(120, parseInt(rawIptv.iptvCacheSeconds, 10) || 20)),
  };
  // v1.18.0：历史代理与外部播放器字段不再生效；disableGpu 兜底。
  if (typeof cachedSettings.disableGpu !== 'boolean') cachedSettings.disableGpu = false;
  delete cachedSettings.externalPlayerPath;
  return cachedSettings;
}

// v1.17.7：本地 IPTV 代理已彻底移除。
// 历史上这里有 normalizeHostList / iptvMaybeRedirect / IPTV_ELIGIBLE_WC_IDS /
// onBeforeRequest 重定向 / debug 日志等一整套 8340 代理逻辑，现已全部删除。
// 飞牛影视 webview 内的直播请求一律直连 FPK 服务端，链路最短化。
// diagLog 仍保留，供 live 窗口等模块写诊断日志。
function diagLog(line) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'fnos-diag.log'),
      `[FNOS] ${new Date().toISOString()} ${line}\n`
    );
  } catch (_) {}
}

// 结构化诊断日志（MPV 嵌入链路等关键诊断写入 fnos-diag.log）
function dlog(level, event, extra) {
  try {
    let line = `[MPV] ${new Date().toISOString()} ${String(level || 'info').toUpperCase()} ${event}`;
    if (extra && typeof extra === 'object') {
      try { line += ' ' + JSON.stringify(extra); } catch (_) { line += ' ' + String(extra); }
    } else if (extra !== undefined && extra !== null) {
      line += ' ' + String(extra);
    }
    diagLog(line);
  } catch (_) {}
}

// preload（飞牛 webview）上报的解析/自动接管日志，统一汇入诊断日志
ipcMain.on('fnos:media-log', (e, data) => {
  try {
    const wcId = e && e.sender ? e.sender.id : -1;
    dlog('info', 'mpv.preload.' + String((data && data.stage) || 'unknown'), {
      wcId,
      ...(data && typeof data === 'object' ? (() => { const { stage, ...rest } = data; return rest; })() : {})
    });
  } catch (_) {}
});


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

// v1.16.3：全应用共享同一个持久化 partition，主窗口/飞牛 webview/设置/直播窗口
// 共用同一份 cookie、localStorage，实现一次登录全模块互通、重启自动恢复登录态。
const SHARED_PARTITION = 'persist:fnos-shared';

function partitionForServer(/* parsed */) {
  // 历史上按 host 分了独立 partition，导致登录态在主程序与 webview 之间不互通。
  // v1.16.3 起强制统一：所有服务器都走共享 partition。
  return SHARED_PARTITION;
}

// v1.16.3：首次启动时，把旧版按 host 分的 persist:nas-* 分区里的 cookie
// 迁移到共享分区，避免升级后用户需要重新登录。只迁移一次（以标记文件为准）。
let gCookieMigrated = false;
async function migrateLegacyCookiesOnce() {
  if (gCookieMigrated) return;
  gCookieMigrated = true;
  try {
    const flagFile = path.join(app.getPath('userData'), '.cookie-migrated-to-shared');
    if (fs.existsSync(flagFile)) return;

    const sharedSes = session.fromPartition(SHARED_PARTITION);
    const allSessions = typeof session.getAllSessions === 'function' ? session.getAllSessions() : [];
    let migrated = 0;
    for (const ses of allSessions) {
      // 只迁移旧版 persist:nas-* 分区的 cookie，connect / default 不动
      const part = ses && ses.getStoragePath && typeof ses.getStoragePath === 'function' ? null : null;
      // Electron 未直接暴露 partition 名，通过 storagePath 文件名判断含 'nas-' 即为旧分区
      // 兜底：用 ses.cookies.get({}) 取 cookie，比对 ses !== sharedSes 且 storage path 含 'nas-'
      let isOldNas = false;
      try {
        // Electron session 没有直接 getPartition()，通过 storagePath 名判断
        isOldNas = false; // 无法直接拿到 partition 名；下面通过 ses !== sharedSes 与 storage path 启发式判断
      } catch (_) {}
      if (ses === sharedSes) continue;
      // 通过 storagePath 启发式：旧 partition 对应 LevelDB 目录名里含 'nas-'
      let storagePath = '';
      try { storagePath = ses.getStoragePath ? ses.getStoragePath() : ''; } catch (_) { storagePath = ''; }
      if (!storagePath || !/[\\/]nas-[^\\/]+$/.test(storagePath)) continue;
      isOldNas = true;
      if (!isOldNas) continue;

      let cookies = [];
      try { cookies = await ses.cookies.get({}); } catch (_) { cookies = []; }
      for (const c of cookies) {
        try {
          const copy = {
            url: (c.secure ? 'https://' : 'http://') + (c.domain && c.domain.startsWith('.') ? c.domain.slice(1) : c.domain) + (c.path || '/'),
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            // 显式放宽 SameSite，兼容 NAS 登录 cookie 在 webview 内被拦截的问题
            sameSite: c.sameSite === 'strict' ? 'lax' : (c.sameSite === 'no_restriction' ? 'no_restriction' : 'lax'),
            expirationDate: c.expirationDate,
          };
          if (!copy.name || copy.value === undefined) continue;
          await sharedSes.cookies.set(copy);
          migrated++;
        } catch (_) { /* 单条 cookie 失败不影响其他 */ }
      }
    }
    if (migrated > 0) {
      console.log('[FNOS] migrated', migrated, 'cookies from legacy partitions to shared session');
    }
    try { fs.writeFileSync(flagFile, String(Date.now())); } catch (_) {}
  } catch (e) {
    console.error('[FNOS] cookie migration failed', e && e.message);
  }
}

// v1.16.3：初始化共享 session，统一配置 CORS、cookie、权限、webRequest 拦截。
// 只初始化一次，所有窗口都复用，避免重复注册拦截器导致死循环。
let gSharedSessionInited = false;
function initSharedSession() {
  if (gSharedSessionInited) return;
  gSharedSessionInited = true;
  try {
    const ses = session.fromPartition(SHARED_PARTITION);
    // 统一 UA
    try { ses.setUserAgent(getNasUA()); } catch (_) {}
    // 放宽权限请求，避免 NAS 子资源弹窗打断
    try {
      if (ses.setPermissionRequestHandler) {
        ses.setPermissionRequestHandler((_wc, _perm, cb) => { try { cb(true); } catch (_) {} });
      }
      if (ses.setPermissionCheckHandler) {
        ses.setPermissionCheckHandler(() => true);
      }
    } catch (_) {}
    // 单监听器统一处理 CORS / OPTIONS / 直播重定向，幂等注册
    // （这里只做 CORS 旁路；具体重定向由 webContents 层处理，避免 webRequest 与代理互相循环）
    try {
      ses.webRequest.onBeforeSendHeaders((details, cb) => {
        const h = details.requestHeaders || {};
        // 透传 Origin/Referer，NAS 子资源需要
        try {
          if (!h['Origin'] && details.referrer) h['Origin'] = details.referrer.replace(/\/$/, '');
        } catch (_) {}
        cb({ requestHeaders: h });
      });
      ses.webRequest.onHeadersReceived((details, cb) => {
        const h = details.responseHeaders || {};
        // 统一去掉可能阻断 HLS / 子资源的 CSP 与跨域限制
        delete h['content-security-policy'];
        delete h['Content-Security-Policy'];
        delete h['x-frame-options'];
        delete h['X-Frame-Options'];
        // 修正静态资源的 MIME 类型，避免 Docker 内 Jellyfin 等应用的
        // CSS/JS 被以 text/plain 返回而直接显示成代码文本。
        const u = (details.url || '').split('?')[0].toLowerCase();
        const ct = (h['content-type'] || h['Content-Type'] || []).join('').toLowerCase();
        const setCT = (v) => {
          Object.keys(h).forEach((k) => { if (k.toLowerCase() === 'content-type') delete h[k]; });
          h['content-type'] = [v];
        };
        if (u.endsWith('.css') && !ct.includes('css')) setCT('text/css; charset=utf-8');
        else if (u.endsWith('.js') && !ct.includes('javascript') && !ct.includes('ecmascript')) setCT('application/javascript; charset=utf-8');
        else if (u.endsWith('.mjs') && !ct.includes('javascript')) setCT('application/javascript; charset=utf-8');
        else if (u.endsWith('.json') && !ct.includes('json')) setCT('application/json; charset=utf-8');
        else if (u.endsWith('.svg') && !ct.includes('svg')) setCT('image/svg+xml');
        // 移除此处全局注入的 CORS：对所有响应设置 Allow-Origin:* + Allow-Credentials:true
        // 是非法组合，且会干扰 NAS/Jellyfin 业务接口；媒体跨域由 installCorsBypass 精准处理。
        cb({ responseHeaders: h });
      });
    } catch (e) {
      console.error('[FNOS] webRequest hook failed', e && e.message);
    }
    // 允许不安全内容（内网 https 自签场景）
    try { ses.setSSLConfig({ ignoreCertErrors: true }); } catch (_) {}
  } catch (e) {
    console.error('[FNOS] initSharedSession failed', e && e.message);
  }
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
  try { relaxCookiePolicy(session.fromPartition(partition)); } catch (_) {}
}

// v1.16.2：放宽 Cookie 策略，避免飞牛 NAS 设置的 SameSite=None/Strict Cookie 在
// 自定义 UA / 跨子域 / file:// 外壳场景下被 Chromium 静默丢弃，导致登录态反复失效。
//  - 打开第三方 Cookie（部分 Electron 版本默认关闭）
//  - 监听所有 cookie 变更，若 SameSite 不合法（no_restart/unspecified）则增量重写为 lax；
//    不做全量覆盖，避免反复改写触发 webview 安全机制崩溃。
function relaxCookiePolicy(ses) {
  if (!ses || ses.__fnosCookieRelaxed) return;
  ses.__fnosCookieRelaxed = true;
  try {
    if (typeof ses.setPermissionCheckHandler === 'function') {
      // 保留默认权限检查；这里不做改动，仅为后续 hook 留位
    }
  } catch (_) {}
  try {
    // Electron 22+: 允许第三方 Cookie（部分版本默认行为仍会拦截 SameSite=None 无 Secure 的）
    if (ses.cookies && typeof ses.cookies.setCookie === 'function' && ses.cookies.on) {
      const ensureValidSameSite = (cookie) => {
        try {
          if (!cookie) return;
          const name = cookie.name;
          const domain = cookie.domain;
          if (!name || !domain) return;
          const sameSite = String(cookie.sameSite || '').toLowerCase();
          // unspecified / no_restart 都重写为 lax，避免被浏览器丢弃
          if (sameSite === 'unspecified' || sameSite === 'no_restart' || sameSite === 'not_set' || !sameSite) {
            // 增量写回：只改 sameSite，其他字段保持原值
            const fixed = {
              url: (cookie.secure ? 'https://' : 'http://') + domain.replace(/^\./, '') + (cookie.path || '/'),
              name: cookie.name,
              value: cookie.value || '',
              domain: cookie.domain,
              path: cookie.path || '/',
              secure: !!cookie.secure,
              httpOnly: !!cookie.httpOnly,
              sameSite: 'lax',
              expirationDate: cookie.expirationDate,
            };
            if (!fixed.expirationDate || fixed.expirationDate <= 0) delete fixed.expirationDate;
            ses.cookies.setCookie(fixed).catch(() => {});
          }
        } catch (_) {}
      };
      // 节流：同一 cookie 短时间内不重复处理
      const recent = new Map();
      ses.cookies.on('changed', (_evt, cookie, cause, removed) => {
        try {
          if (removed || !cookie) return;
          const key = cookie.name + '@' + cookie.domain;
          const now = Date.now();
          if (recent.has(key) && now - recent.get(key) < 3000) return;
          recent.set(key, now);
          if (recent.size > 256) {
            for (const [k, t] of recent) if (now - t > 10000) recent.delete(k);
          }
          ensureValidSameSite(cookie);
        } catch (_) {}
      });
    }
  } catch (_) {}
  // 主动 flush 一次，确保持久化
  try { if (ses.cookies && typeof ses.cookies.flushStorageData === 'function') ses.cookies.flushStorageData().catch(() => {}); } catch (_) {}
}

// v1.15.0：统一的 onBeforeRequest 监听。Electron 每个 session 的 webRequest
// 同一事件只保留最后一个 listener，因此必须用"同一个稳定函数引用"注册。
// v1.17.7：IPTV 代理重定向已移除，这里只保留 CORS OPTIONS 放行 + URL 映射重写。
function onBeforeRequestHandler(details, callback) {
  try {
    const u = details.url || '';
    // 1) 媒体/直播流的 OPTIONS 预检直接放行；普通业务 API 的 OPTIONS 透传给 NAS
    if (details.method === 'OPTIONS') {
      if (/\.(m3u8|ts|flv|m4s|mpd|mp4|mkv|aac|flac|webm)(\?|$)/i.test(u)) {
        return callback({ redirectURL: 'data:text/plain;charset=utf-8,' });
      }
    }
    // 2) URL 重写（外网端口/域名映射）
    const mapped = rewriteUrl(u);
    if (mapped && mapped !== u) {
      return callback({ redirectURL: mapped });
    }
  } catch (e) {
    try { console.warn('[FNOS] onBeforeRequest error', e); } catch (_) {}
  }
  return callback({});
}

// ---------------------- 内置 Chrome 扩展（飞牛电视直播增强） ----------------------
// 将 extensions/ 目录下的解压扩展加载到应用的各个 session 中，
// content script 会自动注入到应用内打开的所有页面（飞牛影视/直播/Jellyfin 等）。
const loadedExtensions = new Set();
async function loadExtensionIntoSession(ses, allowFileAccess) {
  if (!ses || typeof ses.loadExtension !== 'function') return;
  const extDir = path.join(__dirname, 'extensions');
  let entries = [];
  try { entries = fs.readdirSync(extDir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extPath = path.join(extDir, entry.name);
    if (!fs.existsSync(path.join(extPath, 'manifest.json'))) continue;
    // 同一扩展在同一 session 只加载一次（以扩展目录名为 key）
    const tag = `${ses.storagePath || 'default'}::${entry.name}`;
    if (loadedExtensions.has(tag)) continue;
    try {
      const ext = await ses.loadExtension(extPath, { allowFileAccess: !!allowFileAccess });
      loadedExtensions.add(tag);
      console.log(`[FNOS] extension loaded: ${ext.name} v${ext.version} into ${ses.storagePath || 'default'}`);
    } catch (e) {
      console.error(`[FNOS] failed to load extension ${entry.name}:`, e && e.message ? e.message : e);
    }
  }
}
async function loadBundledExtensions() {
  // 扩展需要在 defaultSession 以及应用使用的共享分区都加载，确保 webview 内生效
  await loadExtensionIntoSession(session.defaultSession, true);
  try {
    if (SHARED_PARTITION) await loadExtensionIntoSession(session.fromPartition(SHARED_PARTITION), true);
  } catch (_) {}
  try {
    await loadExtensionIntoSession(session.fromPartition('persist:connect'), true);
  } catch (_) {}
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

      // v1.23.1：飞牛影视直链 /fnplay/*.mkv 等常返回 application/octet-stream，
      // 会导致 <video> 无法识别而触发下载。按扩展名强制修正为可播放的 content-type。
      const u = (details.url || '').split('?')[0].toLowerCase();
      if (u.endsWith('.mkv')) setHeader(headers, 'Content-Type', 'video/x-matroska');
      else if (u.endsWith('.mp4')) setHeader(headers, 'Content-Type', 'video/mp4');
      else if (u.endsWith('.webm')) setHeader(headers, 'Content-Type', 'video/webm');
      else if (u.endsWith('.mov')) setHeader(headers, 'Content-Type', 'video/quicktime');
      else if (u.endsWith('.ts') || u.endsWith('.m2ts')) setHeader(headers, 'Content-Type', 'video/mp2t');
      else if (u.endsWith('.m4s')) setHeader(headers, 'Content-Type', 'video/iso.segment');
      else if (u.endsWith('.aac')) setHeader(headers, 'Content-Type', 'audio/aac');
      else if (u.endsWith('.flac')) setHeader(headers, 'Content-Type', 'audio/flac');
    }
    callback({ responseHeaders: headers });
  });

  // 2) onBeforeSendHeaders：透传原始请求头；执行 URL 映射重写。
  //    v1.17.7：IPTV m3u8 本地代理重定向已移除，飞牛影视请求直连 FPK 服务端。
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      if (details.method === 'GET') {
        const u = details.url || '';
        const mapped = rewriteUrl(u);
        if (mapped && mapped !== u) {
          return callback({ redirectURL: mapped, requestHeaders: details.requestHeaders });
        }
      }
    } catch (e) {
      try { console.warn('[FNOS] onBeforeSendHeaders error', e); } catch (_) {}
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // 3) 统一的 onBeforeRequest：CORS OPTIONS 放行 + URL 重写（无请求头场景）。
  //    使用稳定函数引用 onBeforeRequestHandler，确保多次注册不互相覆盖。
  ses.webRequest.onBeforeRequest(onBeforeRequestHandler);

  // v1.23.1：记录媒体请求的完成/失败状态，便于排查飞牛影视/直播无法播放
  // （403/404、Range 不支持、被中断、DNS 失败等都会落到 fnos-web.log）
  // v1.23.6：同时追踪每个 webContents 最近一次"主媒体"地址，供菜单"在浏览器中打开"使用。
  //          飞牛影视是 SPA（页面 URL 始终是首页），真正的视频流在 /fnplay/ 或 .mp4/.mkv 等请求里。
  try {
    const isMediaUrl = (u) => /\.(m3u8|ts|m4s|mpd|mp4|mkv|m2ts|webm|mov|flv|aac|flac|wav|ogg)(\?|$)/i.test(u || '') || /\/fnplay\//i.test(u || '');
    // 可作为"打开目标"的主媒体：m3u8/mpd 列表，或 mp4/mkv/m2ts/webm/mov 等整段容器；
    // 排除 .ts/.m4s/.aac 等微小分片（它们不是用户要打开的对象）。
    const isMainMedia = (u) => /\.(m3u8|mpd|mp4|mkv|m2ts|webm|mov|flv)(\?|$)/i.test(u || '') || /\/fnplay\//i.test(u || '');
    ses.webRequest.onCompleted((details) => {
      if (!isMediaUrl(details.url)) return;
      if (isMainMedia(details.url) && details.webContentsId != null) {
        const rec = { url: details.url, at: Date.now() };
        lastMediaByWc.set(details.webContentsId, rec);
        // v1.25.0：webview 是 guest，其宿主外壳窗口也记录同一条，便于按宿主窗口/菜单查找。
        try {
          const guestWc = webContents.fromId(details.webContentsId);
          const host = guestWc && guestWc.hostWebContents;
          if (host) lastMediaByWc.set(host.id, rec);
        } catch (_) {}
      }
      if (details.statusCode && details.statusCode >= 400) {
        try {
          fs.appendFileSync(
            path.join(app.getPath('userData'), 'fnos-web.log'),
            `[${new Date().toISOString()}] MEDIA HTTP ${details.statusCode} ${details.method} ${details.url}\n`
          );
        } catch (_) {}
      }
    });
    ses.webRequest.onErrorOccurred((details) => {
      if (!isMediaUrl(details.url)) return;
      try {
        fs.appendFileSync(
          path.join(app.getPath('userData'), 'fnos-web.log'),
          `[${new Date().toISOString()}] MEDIA NETERR ${details.error} ${details.method} ${details.url}\n`
        );
      } catch (_) {}
    });
  } catch (_) {}
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
 *   options: { title, message, detail, buttons, defaultId, cancelId, width, height }
 *   返回: Promise<{ response }>
 *
 * message 为正文提示（自动换行完整显示）；detail 为技术细节（等宽、可滚动）。
 * 兼容历史调用：若只传 detail 且较短，则作为正文展示。
 */
function showGlassDialog(parent, options = {}) {
  return new Promise((resolve) => {
    const buttons = Array.isArray(options.buttons) && options.buttons.length > 0
      ? options.buttons : ['确定'];
    const defaultId = typeof options.defaultId === 'number' ? options.defaultId : 0;
    const cancelId = typeof options.cancelId === 'number' ? options.cancelId
      : (buttons.length > 1 ? buttons.length - 1 : 0);
    const width = options.width || 440;
    // 兼容：只提供 detail 时，短文本作为 message，长文本作为 detail
    let message = options.message || '';
    let detail = options.detail || '';
    if (!message && detail) {
      if (detail.length <= 200 && !/\n{2,}|at .+ \(|Error:|Exception:|\\[A-Z]/.test(detail)) {
        message = detail;
        detail = '';
      }
    }
    const isLong = (detail || '').length > 400;
    const initHeight = isLong ? 560 : (message ? 240 : 220);
    const payload = {
      title: options.title || APP_NAME,
      message,
      detail,
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
    win.__isGlassDialog = true; // 供 refreshMpvLayer 识别为应浮于 mpv 之上的子弹窗
    win.on('show', () => { try { refreshMpvLayer(); } catch (_) {} });
    win.on('closed', () => { try { refreshMpvLayer(); } catch (_) {} });

    let responded = false;
    const finish = (buttonIndex) => {
      if (responded || win.isDestroyed()) return;
      responded = true;
      const idx = typeof buttonIndex === 'number' ? buttonIndex : cancelId;
      try { win.hide(); } catch (_) {}
      try { refreshMpvLayer(); } catch (_) {}
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
  // v1.16.1：解锁后重置空闲计时基准，避免立刻又触发自动锁
  resetIdleAutoLock();
}

// ---------------------- 无操作自动锁定（v1.16.1） ----------------------
// 使用 Electron powerMonitor.getSystemIdleTime()（秒）检测系统级空闲
// （键鼠无操作），达到用户设定的分钟数后自动锁定。仅在已设置启动密码、
// 当前未锁定、且主窗口可见时触发（最小化到托盘/已隐藏/锁屏视频播放
// 全屏时不打扰）。设置为 0 关闭该功能。
let idleAutoLockTimer = null;
let idleAutoLockLastTriggered = 0; // 节流：避免连续触发

function isIdleAutoLockApplicable() {
  if (!hasAppPassword()) return false;
  if (isLocked) return false;
  if (isCompletelyHidden) return false;
  const s = loadSettings();
  const mins = clampInt(s.autoLockMinutes, 0, 240, 0);
  if (mins <= 0) return false;
  return true;
}

function checkIdleAutoLock() {
  try {
    if (!isIdleAutoLockApplicable()) return;
    const mins = clampInt(loadSettings().autoLockMinutes, 0, 240, 0);
    const idleSeconds = (powerMonitor && typeof powerMonitor.getSystemIdleTime === 'function')
      ? powerMonitor.getSystemIdleTime()
      : -1;
    if (idleSeconds < 0) return;
    // 任意窗口处于全屏（如播放视频）时不自动锁定
    const inFullscreen = BrowserWindow.getAllWindows().some((w) => {
      try { return !w.isDestroyed() && w.isFullScreen(); } catch (_) { return false; }
    });
    if (inFullscreen) return;
    if (idleSeconds >= mins * 60) {
      const now = Date.now();
      if (now - idleAutoLockLastTriggered < 5000) return; // 5s 节流
      idleAutoLockLastTriggered = now;
      try { console.log(`[FNOS] idle ${idleSeconds}s >= ${mins}min, auto-locking`); } catch (_) {}
      lockApp();
    }
  } catch (_) {}
}

function startIdleAutoLock() {
  try {
    if (idleAutoLockTimer) clearInterval(idleAutoLockTimer);
    idleAutoLockTimer = null;
    const s = loadSettings();
    const mins = clampInt(s.autoLockMinutes, 0, 240, 0);
    if (mins > 0 && hasAppPassword()) {
      // 每 15 秒检查一次（粒度足够，避免 CPU 占用）
      idleAutoLockTimer = setInterval(checkIdleAutoLock, 15000);
      // 不阻止进程退出
      if (idleAutoLockTimer.unref) idleAutoLockTimer.unref();
    }
  } catch (_) {}
}

function resetIdleAutoLock() {
  // 重置 lastTriggered；系统级 idle time 由 OS 维护，我们不需要手动重置；
  // 这里只确保节流窗口归零，解锁后用户再次空闲到阈值才会再次触发。
  idleAutoLockLastTriggered = 0;
}

// ---------------------- 登录态心跳（v1.16.1） ----------------------
// 对当前 NAS 发轻量请求保持会话 Cookie / 服务端 session 不过期。
// 不弹窗、不打扰；失败静默，由真正业务请求自然触发重新登录。
let authHeartbeatTimer = null;
function startAuthHeartbeat() {
  try { if (authHeartbeatTimer) clearInterval(authHeartbeatTimer); } catch (_) {}
  authHeartbeatTimer = setInterval(() => {
    try {
      if (isLocked || isCompletelyHidden) return;
      const origin = currentOrigin || (function () {
        try { return lastConnectHref ? new URL(lastConnectHref).origin : ''; } catch (_) { return ''; }
      })();
      if (!origin) return;
      if (!/^https?:\/\//i.test(origin)) return;
      const u = new URL(origin);
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      // 用当前 partition 的 Cookie 发请求
      const ses = (currentPartition && currentPartition.startsWith('persist:'))
        ? session.fromPartition(currentPartition)
        : session.defaultSession;
      const cookies = ses ? ses.cookies : null;
      if (!cookies) return;
      cookies.get({ url: origin }).then((ck) => {
        const cookieHeader = (ck || []).map((c) => `${c.name}=${c.value}`).join('; ');
        const req = lib.request(origin + '/', {
          method: 'GET', timeout: 8000,
          headers: { 'User-Agent': getNasUA(), 'Cookie': cookieHeader, 'Accept': '*/*' },
        }, (res) => { res.resume(); });
        req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
        req.on('error', () => {});
        req.end();
      }).catch(() => {});
    } catch (_) {}
  }, 5 * 60 * 1000); // 5 分钟
  if (authHeartbeatTimer.unref) authHeartbeatTimer.unref();
}

// ---------------------- 网络变化监听（v1.16.1） ----------------------
// 监听系统网络接口变化（IP/MAC 变更），失效线路探测缓存。
// 由直播窗口主动重新探测并按需自动切换。
let g_lastNetworkSig = '';
let g_networkWatcher = null;
function networkSignature() {
  try {
    const ifs = os.networkInterfaces();
    const parts = [];
    for (const name of Object.keys(ifs)) {
      for (const ni of (ifs[name] || [])) {
        if (ni.internal) continue;
        parts.push(name + '|' + ni.family + '|' + ni.address + '|' + (ni.mac || ''));
      }
    }
    return parts.sort().join(';');
  } catch (_) { return ''; }
}
function startNetworkWatcher() {
  if (g_networkWatcher) return;
  try { g_lastNetworkSig = networkSignature(); } catch (_) {}
  g_networkWatcher = setInterval(() => {
    try {
      const sig = networkSignature();
      if (sig && sig !== g_lastNetworkSig) {
        g_lastNetworkSig = sig;
        // 失效探测缓存
        g_lineProbeCache = null;
        // 通知直播窗口（如果开着）重新自动探测
        if (liveWindow && !liveWindow.isDestroyed()) {
          try { liveWindow.webContents.send('live:network-changed'); } catch (_) {}
        }
      }
    } catch (_) {}
  }, 10000); // 每 10s 检查一次网络接口
  if (g_networkWatcher.unref) g_networkWatcher.unref();
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

// 数值范围收敛工具：把任意输入转换为 [min,max] 区间内的整数
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try { settingsWindow.show(); settingsWindow.focus(); refreshMpvLayer(); } catch (_) {}
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
  settingsWindow.__isSettings = true; // 供 refreshMpvLayer 识别为应浮于 mpv 之上的子弹窗
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(SETTINGS_PAGE).catch(() => {});
  // 设置窗移动到前台/获焦/显示时立即让 mpv 降层（防止置顶 mpv 盖住设置页）
  settingsWindow.on('focus', () => { try { refreshMpvLayer(); } catch (_) {} });
  settingsWindow.once('ready-to-show', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show(); settingsWindow.focus();
      try { refreshMpvLayer(); } catch (_) {}
    }
  });
  // 设置页显示/隐藏/关闭/失焦时同步 mpv 层级：打开则 mpv 降层，关闭后恢复置顶
  settingsWindow.on('show', () => { try { refreshMpvLayer(); } catch (_) {} });
  settingsWindow.on('hide', () => { try { refreshMpvLayer(); } catch (_) {} });
  settingsWindow.on('minimize', () => { try { refreshMpvLayer(); } catch (_) {} });
  settingsWindow.on('restore', () => { try { refreshMpvLayer(); } catch (_) {} });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    // 关闭设置页后重新注册快捷键
    registerGlobalShortcuts();
    try { refreshMpvLayer(); } catch (_) {}
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
    message: String(message || ''),
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
  // v1.18 性能：窗口不在前台（最小化/隐藏/失焦）时降低渲染帧率到 15fps，
  // 回到前台/获得焦点恢复 60fps。开多个应用窗口时可显著降低 CPU/GPU 占用。
  // 仅影响 requestAnimationFrame，不暂停音频/下载/定时器/投屏，对 NAS 业务透明。
  try {
    // 关键：blur 会被"短暂焦点抢占"高频触发（如弹窗/菜单/网页 video 控件/输入法/MPV 原生窗抢焦）。
    // 若 blur 立刻降到 15fps、focus 立刻恢复 60fps，网页原生 <video> 播放时帧率会在 15↔60 之间
    // 反复横跳，肉眼即表现为"画面抖动"（MPV 走自己的渲染循环不受影响）。
    // 因此 blur 降帧加防抖：只有持续失焦超过 2s（真的切后台/切到别的 App）才降到 15fps；
    // focus 立即恢复 60fps 并取消待触发的降帧。minimize/hide 仍然立即降帧（确属不可见）。
    let blurThrottleTimer = null;
    const clearBlurTimer = () => {
      if (blurThrottleTimer) { try { clearTimeout(blurThrottleTimer); } catch (_) {} blurThrottleTimer = null; }
    };
    const doThrottle = () => { try { win.webContents.setFrameRate(15); } catch (_) {} };
    const throttle = doThrottle; // minimize/hide：立即降帧
    const throttleBlur = () => {
      clearBlurTimer();
      try {
        if (win.isMinimized() || !win.isVisible()) { doThrottle(); return; }
      } catch (_) {}
      blurThrottleTimer = setTimeout(() => {
        blurThrottleTimer = null;
        try { if (!win.isDestroyed() && !win.isFocused() && win.isVisible() && !win.isMinimized()) doThrottle(); } catch (_) {}
      }, 2000);
      if (blurThrottleTimer && blurThrottleTimer.unref) blurThrottleTimer.unref();
    };
    const unthrottle = () => { clearBlurTimer(); try { win.webContents.setFrameRate(60); } catch (_) {} };
    win.on('minimize', throttle);
    win.on('restore', unthrottle);
    win.on('hide', throttle);
    win.on('show', unthrottle);
    win.on('blur', throttleBlur);
    win.on('focus', unthrottle);
  } catch (_) {}
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

  // v1.23.0：捕获 webview/渲染端视频播放相关错误与控制台输出，写入 fnos-web.log 便于排查
  // （飞牛影视部分视频不能播放时，可据此定位是编码不支持、CORS、Range 还是网络错误）
  try {
    win.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
      if (!message) return;
      // 只记录与媒体/解码/网络相关的告警和错误，避免刷屏
      if (level < 2) return; // 0=verbose 1=info 2=warning 3=error
      if (!/(video|media|decode|codec|mediaerror|mediasource|buffer|range|cors|跨域|播放|解码|加载失败|net::|failed to load|cannot play)/i.test(message)) return;
      try {
        fs.appendFileSync(
          path.join(app.getPath('userData'), 'fnos-web.log'),
          `[${new Date().toISOString()}] [${level === 3 ? 'ERROR' : 'WARN'}] (${sourceId || ''}:${line}) ${message}\n`
        );
      } catch (_) {}
    });
    // 媒体播放被阻止/密钥系统等关键事件
    win.webContents.on('media-started-playing', () => {});
  } catch (_) {}

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
  // v1.16.3：NAS 相关窗口一律走共享 partition，与主窗口/飞牛 webview/直播窗口
  // 共享登录态；只有显式传入非 NAS 的外部 partition 才允许保留。
  let partition = opts.partition || currentPartition;
  if (!partition || partition === 'persist:connect' || /^persist:nas-/.test(partition)) {
    partition = SHARED_PARTITION;
  }
  applyUA(partition);

  const win = new BrowserWindow({
    width: opts.width || 1280,
    height: opts.height || 820,
    minWidth: 900,
    minHeight: 600,
    title: opts.title || APP_NAME,
    backgroundColor: cachedSettings.themeColor || '#0b0d12',
    show: false,
    autoHideMenuBar: false,
    frame: true,
    titleBarStyle: 'default',
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
      v8CacheOptions: 'bypassHeatCheckAndEagerCompile',
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

  // v1.29.2：起播/加载健壮性——
  // 1) 黑/白屏优化：ready-to-show 后再展示窗口（首帧已绘制），避免"登录后黑屏"；
  //    兜底展示从 300ms 放宽到 6s（NAS 首次响应/隧道握手较慢时也不至于先弹一个黑窗）。
  // 2) did-fail-load 自动重试：仅对主框架网络错误（-3 中止/-137 命名解析等）重试，避免偶发
  //    隧道/内网抖动导致应用区停在错误页/黑屏；子资源失败不重试，且 404/鉴权跳转不触发。
  let _loadFailTries = 0;
  try {
    win.webContents.on('did-fail-load', (_e, errorCode, errorDesc, failUrl, isMainFrame) => {
      try {
        if (!isMainFrame) return;
        // -3 = ABORTED（我们自己 setWindowOpenHandler 取消/导航中被替换），不当错误
        if (errorCode === -3 || errorCode === 0) return;
        if (failUrl && /^file:/.test(failUrl)) return; // 本地页面失败交给各自逻辑
        if (_loadFailTries >= 4) return;
        _loadFailTries++;
        dlog && dlog('warn', 'appwin.fail-load.retry', { errorCode, errorDesc, try: _loadFailTries, url: String(failUrl).slice(0, 90) });
        setTimeout(() => {
          try {
            if (win.isDestroyed()) return;
            const cur = win.webContents.getURL();
            const target = (cur && /^https?:/.test(cur)) ? cur : url;
            if (/^https?:/i.test(target)) win.loadURL(target, { userAgent: getNasUA() }).catch(() => {});
          } catch (_) {}
        }, Math.min(4000, 600 * _loadFailTries + 600));
      } catch (_) {}
    });
  } catch (_) {}

  win.once('ready-to-show', () => { try { win.show(); } catch (_) {} });
  // 兜底：极端情况下 ready-to-show 未触发（如隧道握手卡住），6s 后也展示窗口，避免"看不见窗口"
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 6000);

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
      if (mainWindow.isMinimized()) { try { mainWindow.restore(); } catch (_) {} }
      if (!mainWindow.isVisible()) { try { mainWindow.show(); } catch (_) {} }
      try { mainWindow.focus(); mainWindow.moveTop(); } catch (_) {}
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
    // 使用深色背景，避免页面首帧渲染前出现绿色/白色闪烁（Win11 部分显卡绿屏问题）
    backgroundColor: '#1a1a1a',
    show: false,
    paintWhenInitiallyHidden: true,
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
      // v1.20.0：页面加载性能优化
      v8CacheOptions: 'bypassHeatCheckAndEagerCompile',
    },
  });

  // 渲染就绪即显示，不等整页加载完成，显著提升启动观感速度
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !isLocked) mainWindow.show();
  });

  // v1.29.2：主窗口主框架加载失败（隧道/内网抖动、-137 解析失败、连接重置等）自动重试，
  // 避免"登录后黑屏/错误页"。-3(中止，导航被替换)与本地连接页不重试；最多 4 次、退避。
  let _mainFailTries = 0;
  try {
    mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, failUrl, isMainFrame) => {
      try {
        if (!isMainFrame || errorCode === -3 || errorCode === 0) return;
        if (failUrl && /^file:/.test(failUrl)) return;
        if (_mainFailTries >= 4) return;
        _mainFailTries++;
        dlog && dlog('warn', 'main.fail-load.retry', { errorCode, errorDesc, try: _mainFailTries, url: String(failUrl).slice(0, 90) });
        setTimeout(() => {
          try {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            const target = lastConnectHref || mainWindow.webContents.getURL();
            if (target && /^https?:/i.test(target)) mainWindow.loadURL(target, { userAgent: getNasUA() }).catch(() => {});
          } catch (_) {}
        }, Math.min(4000, 600 * _mainFailTries + 600));
      } catch (_) {}
    });
  } catch (_) {}

  // 菜单栏自动隐藏开关
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

// v1.16.1：connectTo 防抖——短时间内同一服务器重复调用只处理第一次，
// 避免"登录状态已改变"类事件连续触发多次重建窗口。
let connectToInFlight = false;
let connectToLastServer = '';
let connectToLastAt = 0;

function connectTo(serverInput) {
  const server = String(serverInput || '').trim();
  const now = Date.now();
  // 500ms 内同一服务器的重复调用直接忽略
  if (server && server === connectToLastServer && now - connectToLastAt < 500) {
    return;
  }
  // 同一时刻已经在处理连接，避免重入
  if (connectToInFlight) {
    return;
  }
  connectToInFlight = true;
  connectToLastServer = server;
  connectToLastAt = now;
  try {
    doConnectTo(server);
  } finally {
    setImmediate(() => { connectToInFlight = false; });
  }
}

function doConnectTo(serverInput) {
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
  // v1.16.1：连上 NAS 后预热 XTE 基地址缓存（异步，不阻塞）
  setImmediate(() => { try { warmupXteBase(); } catch (_) {} });
  if (mainWindow && !mainWindow.isDestroyed()) {
    const onFail = (e) => {
      glassErrorBox(
        '连接失败',
        `无法连接到 ${parsed.origin}\n\n${e.message}\n\n请检查：\n• 电脑是否与 NAS 在同一网络\n• 地址与端口是否正确\n• FN ID 是否正确、FN Connect 是否已开启`,
      );
      showConnectPage();
    };
    mainWindow.loadURL(parsed.href, { userAgent: getNasUA() }).catch(onFail);
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
      const wc = resolveActiveWebContents(win);
      if (!wc || wc.isDestroyed()) return;
      fn(wc, win);
    } catch (e) { console.error('menu action error', e); }
  };
}

// v1.18：玻璃外壳已移除，主窗口直接承载页面，活动 webContents 即主窗口自身。
function resolveActiveWebContents(win) {
  return win ? win.webContents : null;
}

function buildMenuTemplate() {
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
        { label: '📺 电视直播（原生播放器）', click: () => invokeLiveWindow() },
        { type: 'separator' },
        {
          label: '🎬 用 MPV 嵌入播放当前视频（兼容 HEVC/4K/MKV）',
          accelerator: 'Ctrl+Shift+P',
          click: () => {
            try {
              const focused = BrowserWindow.getFocusedWindow();
              const win = (focused && !focused.isDestroyed())
                ? focused
                : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
              if (!win) return;
              // 通知飞牛影视页面（<webview> guest）触发嵌入播放：preload 会解析直链并上报视频区坐标。
              // 关键：<webview> 不是 BrowserView，getBrowserViews() 拿不到；用 web-contents-created 缓存的 fnosGuestWc。
              const triggerEmbedInContents = (wc) => {
                try { wc && !wc.isDestroyed() && wc.executeJavaScript('window.dispatchEvent(new CustomEvent("fnos:mpv-embed"));', true); } catch (_) {}
              };
              try {
                const guest = pickMenuGuest();
                if (guest && !guest.isDestroyed()) {
                  triggerEmbedInContents(guest);
                  dlog('info', 'mpv.menu.embed', { target: 'webview-guest', guestId: guest.id });
                } else {
                  // 兜底：发到当前聚焦窗口页面（直播窗等非 webview 场景）
                  triggerEmbedInContents(win.webContents);
                  dlog('info', 'mpv.menu.embed', { target: 'main-window', win: win.id });
                }
              } catch (e) { dlog('warn', 'mpv.menu.embed', { err: String(e && e.message || e) }); }
            } catch (e) { /* ignore */ }
          },
        },
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
            title: `关于 ${APP_NAME}`,
            message: `${APP_NAME}  v${APP_VERSION}`,
            detail: 'FNOS 桌面客户端\n\n为 FNOS 提供更好的桌面使用体验。',
            buttons: ['确定'],
            width: 380,
          });
        }},
      ],
    },
  ];
  return template;
}

function buildMenu() {
  const template = buildMenuTemplate();
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------- IPC ----------------------
ipcMain.handle('auth:connect', async (_e, payload) => {
  try { connectTo((payload && payload.server) || ''); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message || '连接失败' }; }
});
ipcMain.handle('auth:load-history', async () => {
  const s = loadSettings();
  const c = s.iptv || {};
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
    // v1.25.0：MPV 外部播放器设置
    mpv: getMpvSettings(),
  };
});

// v1.25.0：保存 MPV 外部播放器设置（通道名保留 settings:set-vlc 以兼容旧设置页）
ipcMain.handle('settings:set-vlc', async (_e, patch) => {
  try {
    const cur = getMpvSettings();
    const next = {
      enabled: patch && typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      hwDecode: ['auto', 'd3d11va', 'dxva2', 'no'].includes(patch && patch.hwDecode) ? patch.hwDecode : cur.hwDecode,
      cacheLevel: ['standard', 'smooth', 'unlimited'].includes(patch && patch.cacheLevel) ? patch.cacheLevel : cur.cacheLevel,
    };
    saveSettings({ mpv: next });
    try { global.__mpvSettings = next; } catch (_) {}
    return { ok: true, mpv: next, vlc: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// v1.26.0：探测 MPV 运行状态（二进制是否就位）供设置页展示
ipcMain.handle('settings:vlc-runtime', async () => {
  try {
    const settings = getMpvSettings();
    let info = { available: false, reason: '', version: '', source: '', hwDecode: settings.hwDecode, cacheLevel: settings.cacheLevel, gpu: {}, settings, mpv: true };
    if (MpvPlayerMod && process.platform === 'win32') {
      const exe = MpvPlayerMod.getMpvExe();
      info.available = !!exe;
      info.source = exe || '';
      info.reason = exe ? '' : '未找到内置 mpv.exe';
    } else if (process.platform !== 'win32') {
      info.reason = 'MPV 外部播放器仅在 Windows 平台启用';
    }
    return info;
  } catch (e) {
    return { available: false, reason: e.message, settings: getMpvSettings() };
  }
});

// v1.34.0：保存 ZDY 增强服务设置（弹幕/字幕/片头片尾走 NAS FPK）
ipcMain.handle('settings:set-enhance', async (_e, patch) => {
  try {
    const settings = (typeof loadSettings === 'function' ? loadSettings() : (global.__appSettings || {})) || {};
    const cur = settings.enhance || { enabled: false, baseUrl: '', authCode: '' };
    const norm = (v) => String(v == null ? '' : v).trim().replace(/\/+$/, '');
    const lan = norm(patch && patch.lan != null ? patch.lan : cur.lan);
    const ddns = norm(patch && patch.ddns != null ? patch.ddns : cur.ddns);
    const frp = norm(patch && patch.frp != null ? patch.frp : cur.frp);
    // 兼容旧版单地址字段 baseUrl
    const legacyBase = norm(patch && patch.baseUrl != null ? patch.baseUrl : cur.baseUrl);
    const lanFinal = lan || legacyBase;
    const next = {
      enabled: !!(patch && patch.enabled),
      lan: lanFinal,
      ddns,
      frp,
      // baseUrl 保留指向内网，兼容老读取点
      baseUrl: lanFinal,
      authCode: String(patch && patch.authCode != null ? patch.authCode : cur.authCode || '').trim(),
    };
    saveSettings({ enhance: next });
    try { global.__enhanceSettings = next; } catch (_) {}
    return { ok: true, enhance: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 单通道 ping（Node 16 无全局 fetch，使用 http/https 模块）
function pingZdyChannel(baseUrl, token, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const u = baseUrl + '/ping';
    let parsed;
    try { parsed = new URL(u); } catch (_) { return done({ ok: false, error: '地址格式不正确' }); }
    const timer = setTimeout(() => done({ ok: false, error: '连接超时' }), timeoutMs || 6000);
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = lib.get(u, { headers, timeout: timeoutMs || 6000 }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        const body = Buffer.concat(ch).toString('utf8');
        let data = {};
        try { data = JSON.parse(body || '{}'); } catch (_) {}
        if (res.statusCode === 401 || data.unauthorized) return done({ ok: false, ms, error: '授权码错误' });
        if (res.statusCode !== 200) return done({ ok: false, ms, error: 'HTTP ' + res.statusCode });
        done({ ok: true, ms, version: data.version || '', authOk: true });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => { clearTimeout(timer); done({ ok: false, ms: Date.now() - started, error: err && err.message === 'timeout' ? '连接超时' : '无法访问' }); });
  });
}

// v1.36.0：读取 ZDY 增强服务设置（三通道 lan/ddns/frp + 授权码 + 开关）
ipcMain.handle('settings:get-enhance', async () => {
  try {
    const settings = (typeof loadSettings === 'function' ? loadSettings() : (global.__appSettings || {})) || {};
    const e = settings.enhance || global.__enhanceSettings || {};
    const norm = (v) => String(v == null ? '' : v).trim().replace(/\/+$/, '');
    // 兼容旧版单字段 baseUrl：迁移到 lan
    const lan = norm(e.lan) || norm(e.baseUrl);
    const enhance = {
      enabled: !!e.enabled,
      lan,
      ddns: norm(e.ddns),
      frp: norm(e.frp),
      baseUrl: lan,
      authCode: String(e.authCode || '').trim(),
    };
    try { global.__enhanceSettings = enhance; } catch (_) {}
    return { ok: true, enhance };
  } catch (err) {
    return { ok: false, error: err?.message || '读取增强服务设置失败', enhance: { enabled: false, lan: '', ddns: '', frp: '', baseUrl: '', authCode: '' } };
  }
});

// v1.34.0：测试 ZDY 增强服务连通性；v1.36.0：三通道（内网/IPv6 DDNS/FRP）逐通道诊断
ipcMain.handle('settings:enhance-ping', async (_e, cfg) => {
  try {
    const norm = (v) => String(v == null ? '' : v).trim().replace(/\/+$/, '');
    const token = norm(cfg && (cfg.authCode || cfg.token));
    const chans = [
      { name: '内网', url: norm(cfg && cfg.lan) || norm(cfg && cfg.baseUrl) },
      { name: 'IPv6 DDNS', url: norm(cfg && cfg.ddns) },
      { name: 'FRP', url: norm(cfg && cfg.frp) },
    ].filter((c) => c.url);
    if (!chans.length) return { ok: false, error: '请至少填写一条通道地址' };
    // 并行探测所有通道，按内网→DDNS→FRP 顺序返回；取首个可用为当前通道
    const settled = await Promise.all(chans.map(async (c) => {
      const r = await pingZdyChannel(c.url, token, 6000);
      return { name: c.name, url: c.url, ...r };
    }));
    const firstOk = settled.find((r) => r.ok);
    if (!firstOk) {
      return { ok: false, error: '全部通道不可达', results: settled };
    }
    return { ok: true, activeChannel: firstOk.name, version: firstOk.version, results: settled };
  } catch (e) {
    return { ok: false, error: e.message || '无法访问' };
  }
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
    themeColor: String(s.themeColor || '#4F6EF7'),
    // v1.16.1：无操作自动锁定（分钟），0 = 关闭；仅在已设置启动密码时生效
    autoLockMinutes: clampInt(s.autoLockMinutes, 0, 240, 0),
    // v1.17.7：FPK 会话面板默认地址（首个 NAS 的 34500 服务）
    fpkBaseUrl: resolveIptvBase() || '',
    // v1.17.7：直播源配置（非代理；代理已移除）
    iptv: {
      iptvBaseUrl: (s.iptv && s.iptv.iptvBaseUrl) || '',
      iptvLine: (s.iptv && s.iptv.iptvLine) || 'inner',
      iptvEpgUrl: (s.iptv && s.iptv.iptvEpgUrl) || '',
      iptvCacheSeconds: clampInt(s.iptv && s.iptv.iptvCacheSeconds, 0, 120, 30),
    },
    version: APP_VERSION,
  };
});

// v1.16.1：保存无操作自动锁定时长
ipcMain.handle('settings:set-auto-lock', async (_e, payload) => {
  try {
    const minutes = clampInt(payload && payload.minutes, 0, 240, 0);
    saveSettings({ autoLockMinutes: minutes });
    startIdleAutoLock();
    return { ok: true, autoLockMinutes: minutes };
  } catch (err) {
    return { ok: false, error: err?.message || '保存失败' };
  }
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
    const accent = String(opts?.themeColor || cachedSettings.themeColor || '#4F6EF7');
    const patch = { autoHideMenuBar: autoHide, themeColor: accent };
    saveSettings(patch);
    cachedSettings.autoHideMenuBar = autoHide;
    cachedSettings.themeColor = accent;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.setAutoHideMenuBar(autoHide);
        w.setMenuBarVisibility(!autoHide);
      } catch (_) {}
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('shell:theme', { themeColor: accent });
      }
    } catch (_) {}
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

// v1.14：重启应用（用于玻璃标题栏等需要重建窗口才能生效的设置）
ipcMain.handle('app:restart', async () => {
  try {
    app.isQuitting = true;
    // 先落盘会话，避免重启丢失登录态
    try { persistAllSessions(); } catch (_) {}
    app.relaunch();
    app.exit(0);
  } catch (e) {
    return { ok: false, error: e?.message || '重启失败' };
  }
  return { ok: true };
});

// ---------------- v1.14 玻璃外壳 IPC ----------------
ipcMain.handle('shell:minimize', () => {
  try { mainWindow && mainWindow.minimize(); } catch (_) {}
});
ipcMain.handle('shell:toggle-maximize', () => {
  try {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  } catch (_) {}
});
ipcMain.handle('shell:close', () => {
  try {
    if (!mainWindow) return;
    if (!app.isQuitting && !isSwitchingPartition) { handleMainClose(mainWindow); return; }
    mainWindow.close();
  } catch (_) {}
});
ipcMain.handle('shell:popup-menu', (_e, payload) => {
  try {
    if (!payload || !payload.id) return;
    // 用当前 buildMenu() 生成的应用菜单，取对应顶级菜单，在坐标处弹出
    const appMenu = Menu.getApplicationMenu() || Menu.buildFromTemplate(buildMenuTemplate());
    const map = { file: '文件', downloads: '下载', edit: '编辑', view: '视图', tools: '工具', settings: '设置', help: '帮助' };
    const label = map[payload.id];
    if (!label) return;
    for (const it of appMenu.items) {
      if (it.label === label && it.submenu) {
        const x = Number.isFinite(payload.x) ? payload.x : undefined;
        const y = Number.isFinite(payload.y) ? payload.y : undefined;
        it.submenu.popup({ window: mainWindow || undefined, x, y, positioningItem: 0 });
        return;
      }
    }
  } catch (e) { console.error('shell popup-menu error', e); }
});

ipcMain.handle('settings:set-accent-color', async (_e, color) => {
  try {
    const c = String(color || '#4F6EF7');
    saveSettings({ themeColor: c });
    cachedSettings.themeColor = c;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '保存失败' };
  }
});

// ---------------------- IPTV 本地代理控制 ----------------------

// 原生直播播放器窗口（单例）
let liveWindow = null;

// 判断 webview 内点击的链接是否为直播流（用于唤起原生播放器）
// v1.16.4：排除飞牛音乐 /music/api/v1/track/hls 与 Jellyfin /videos/ 路径，
// 避免在 webview 内点播音乐或 Jellyfin 视频时误唤起直播窗口。
function isIptvStreamUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (p.startsWith('/music/')) return false;
    if (p.startsWith('/videos/')) return false;
    if (p.startsWith('/emby/') || p.startsWith('/Items/'.toLowerCase())) return false;
    return p.endsWith('.m3u8') || p.includes('.m3u8') || p.startsWith('/play/') || p.includes('live/play');
  } catch (_) {
    return false;
  }
}
// 从 URL 猜测频道名（兜底）
function guessChannelName(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const name = seg.replace(/\.(m3u8|ts|flv)$/i, '');
    return name ? decodeURIComponent(name) : '电视直播';
  } catch (_) { return '电视直播'; }
}

function invokeLiveWindow(channel) {
  try {
    const url = channel && channel.url;
    const now = Date.now();
    const sig = url ? String(url) : '__menu__';
    // 去抖：setWindowOpenHandler 与 will-navigate 可能在同一次点击中先后触发，
    // 800ms 内同一 URL 只唤起一次（第二次仅聚焦已存在的直播窗口）
    if (sig === g_lastLiveInvokeUrl && now - g_lastLiveInvokeAt < 800) {
      if (liveWindow && !liveWindow.isDestroyed()) {
        try { liveWindow.show(); liveWindow.focus(); } catch (_) {}
      }
      return;
    }
    g_lastLiveInvokeAt = now;
    g_lastLiveInvokeUrl = sig;
    createLiveWindow(channel && channel.url ? channel : null);
  } catch (e) {
    console.warn('[FNOS] invokeLiveWindow error', e && e.message);
    try {
      dialog.showErrorBox('无法打开电视直播', (e && e.message) || String(e));
    } catch (_) {}
  }
}

function createLiveWindow(autoplayChannel) {
  try {
    if (liveWindow && !liveWindow.isDestroyed()) {
      try { liveWindow.show(); liveWindow.focus(); } catch (_) {}
      if (autoplayChannel && autoplayChannel.url) {
        try { liveWindow.webContents.send('live:play', autoplayChannel); } catch (_) {}
      }
      return liveWindow;
    }
    // v1.16.3：直播窗口固定使用全应用共享 partition，与主窗口/飞牛 webview 共享登录态
    const livePartition = SHARED_PARTITION;
    liveWindow = new BrowserWindow({
      width: 1280, height: 820, minWidth: 960, minHeight: 600,
      title: APP_NAME + ' · 电视直播',
      backgroundColor: '#0b0d12',
      autoHideMenuBar: true,
      show: false,
      icon: ICON_PATH,
      webPreferences: {
        preload: LIVE_PRELOAD,
        partition: livePartition,
        contextIsolation: true,
        nodeIntegration: false,
        // v1.20.0：直播窗口内 hls.js 需跨域拉取 FPK 服务端 m3u8/ts，关闭同源策略避免黑屏
        webSecurity: false,
        allowRunningInsecureContent: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    liveWindow.setMenuBarVisibility(false);
    // v1.16.1：直播窗口与主窗口共享同一会话 partition（Cookie / 登录态互通）
    try {
      const ses = liveWindow.webContents.session;
      if (ses && typeof ses.setUserAgent === 'function') ses.setUserAgent(getNasUA());
      if (ses) relaxCookiePolicy(ses);
      if (ses && typeof ses.cookies.flushStorageData === 'function') {
        try { ses.cookies.flushStorageData().catch(() => {}); } catch (_) {}
      }
    } catch (_) {}
    liveWindow.once('ready-to-show', () => {
      if (liveWindow && !liveWindow.isDestroyed()) {
        try { liveWindow.show(); } catch (_) {}
      }
    });
    const loadFail = (e, code, desc) => {
      console.warn('[FNOS] live window load fail', code, desc);
    };
    liveWindow.webContents.on('did-fail-load', loadFail);
    liveWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error('[FNOS] live render-process-gone', details);
      // v1.16.2：渲染器崩溃时 2 秒后自动重载，避免直接闪退 / 白屏
      const reason = details && details.reason;
      if (reason && reason !== 'clean-exit') {
        setTimeout(() => {
          try {
            if (liveWindow && !liveWindow.isDestroyed()) liveWindow.loadFile(LIVE_PAGE).catch(() => {});
          } catch (_) {}
        }, 2000);
      }
    });
    liveWindow.webContents.on('unresponsive', () => {
      try {
        fs.appendFileSync(
          path.join(app.getPath('userData'), 'fnos-diag.log'),
          '[FNOS] live window unresponsive, force reload in 3s\n'
        );
      } catch (_) {}
      setTimeout(() => {
        try { if (liveWindow && !liveWindow.isDestroyed()) liveWindow.webContents.forcefullyCrashRenderer(); } catch (_) {}
      }, 3000);
    });
    liveWindow.loadFile(LIVE_PAGE).catch((e) => console.error('live window load fail', e));
    liveWindow.on('closed', () => {
      liveWindow = null;
      // v1.17.7：本地代理已移除，无会话清理。
    });
    // 最小化时降频，恢复时回到 60fps
    liveWindow.on('minimize', () => { try { liveWindow.webContents.setFrameRate(15); } catch (_) {} });
    liveWindow.on('restore', () => { try { liveWindow.webContents.setFrameRate(60); } catch (_) {} });
    if (autoplayChannel && autoplayChannel.url) {
      liveWindow.webContents.once('did-finish-load', () => {
        try { liveWindow.webContents.send('live:play', autoplayChannel); } catch (_) {}
      });
    }
    return liveWindow;
  } catch (e) {
    console.error('[FNOS] createLiveWindow fatal', e);
    try { dialog.showErrorBox('电视直播窗口创建失败', (e && e.message) || String(e)); } catch (_) {}
    return null;
  }
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
//      不再 fallback 到 5666 / currentOrigin，不做端口猜测。
//   2. 未填写时才回退到自动探测：在当前 NAS host 上依次尝试 34500 等候选端口。
//   3. 所有直播列表请求、流地址拼接统一使用这里返回的 base。
async function resolveIptvBaseAsync() {
  const s = loadSettings();
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
  if (currentOrigin) nasOrigin = currentOrigin;
  else if (lastConnectHref) { try { nasOrigin = new URL(lastConnectHref).origin; } catch (_) {} }
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
  const s = loadSettings();
  const c = s.iptv || {};
  const userBase = normalizeIptvBase(c.iptvBaseUrl);
  if (userBase) return userBase;
  if (g_cachedXteBase) return g_cachedXteBase;
  if (currentOrigin) return currentOrigin.replace(/\/+$/, '');
  if (lastConnectHref) { try { return new URL(lastConnectHref).origin; } catch (_) {} }
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
  const s = loadSettings();
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
  const s = loadSettings();
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
  saveSettings({ iptv: { ...loadSettings().iptv, iptvLine: next } });
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
  const c = { ...loadSettings().iptv };
  const favs = new Set(Array.isArray(c.iptvFavorites) ? c.iptvFavorites : []);
  if (favs.has(name)) favs.delete(name); else favs.add(name);
  c.iptvFavorites = Array.from(favs);
  saveSettings({ iptv: c });
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
    const target = url || (loadSettings().iptv && loadSettings().iptv.iptvEpgUrl) || '';
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
      try { candidates.push(session.fromPartition('persist:connect')); } catch (_) {}
      try {
        const hst = loadSettings();
        (hst.history || []).forEach((h) => { if (h && h.partition) { try { candidates.push(session.fromPartition(h.partition)); } catch (_) {} } });
      } catch (_) {}
      Promise.all(candidates.map((ses) => ses.cookies.get({ url: u.origin }).then((l) => l || []).catch(() => [])))
        .then((results) => {
          for (const list of results) {
            if (list && list.length) { resolve(list.map((c) => `${c.name}=${c.value}`).join('; ')); return; }
          }
          resolve('');
        }).catch(() => resolve(''));
    } catch (_) { resolve(''); }
  });
}

// 用 MPV 播放媒体地址（自动注入飞牛登录 Cookie / Referer / UA）
async function playMediaWithMpv(mediaUrl, opts) {
  opts = opts || {};
  try {
    if (!MpvPlayerMod || !MpvSurfaceMod) return { ok: false, reason: 'MPV 模块未加载' };
    const st = getMpvSettings();
    if (!st.enabled) return { ok: false, reason: 'MPV 播放已在设置中关闭' };
    if (process.platform !== 'win32') return { ok: false, reason: 'MPV 外部播放器仅支持 Windows' };
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
      surf = new MpvSurfaceMod.MpvSurface(null, null, { standalone: true, settings: st });
      mpvSurfaces.set(STANDALONE_KEY, surf);
      surf.player.on('log', msg => dlog('info', 'mpv.player.log', { msg: String(msg).slice(0, 400) }));
      surf.player.on('end-file', reason => dlog('info', 'mpv.player.end', { reason: String(reason) }));
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

    try {
      await surf.play(url, headers, { isLive: !!opts.isLive, title: opts.title || '飞牛影视', hwDecode: st.hwDecode });
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

ipcMain.handle('mpv:play', async (_e, payload) => {
  const p = payload || {};
  if (!p.url) return { ok: false, reason: '缺少播放地址' };
  return playMediaWithMpv(p.url, { title: p.title, isLive: !!p.isLive, volume: p.volume });
});

// ---------- 应用内"视觉嵌入" MPV（mpv 原生无边框置顶窗口覆盖视频区，fntv 同款）----------
const mpvSurfaces = new Map(); // key(hostWinId) -> MpvSurface
try { global.__mpvSettings = getMpvSettings(); } catch (_) {}

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
      try { if (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused()) return true; } catch (_) {}
    }
    return false;
  } catch (_) { return false; }
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
function setAllMpvOntop(on) {
  try {
    for (const surf of mpvSurfaces.values()) {
      // 画中画小窗始终置顶（即便切到外部 App 也浮着），不降层。
      try { if (surf && surf.isPip && surf.isPip()) { surf.setOntop && surf.setOntop(true); continue; } } catch (_) {}
      try { surf && surf.setOntop && surf.setOntop(on); } catch (_) {}
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
function _applyMpvLayer(shouldSuppress, reason) {
  _clearMpvBlurLayerTimer();
  _mpvSuppressed = shouldSuppress;
  setAllMpvOntop(!shouldSuppress);
  _forEachBlockingWindow((w) => {
    try {
      if (shouldSuppress) {
        // 'screen-saver' 层级高于 mpv 普通 ontop(=floating)，确保设置窗在最上
        if (!w.isAlwaysOnTop()) w.setAlwaysOnTop(true, 'screen-saver');
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
          try { if (!w.isAlwaysOnTop()) w.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
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
      if (contents.getType() === 'webview') {
        rememberGuest(contents, contents.getURL ? contents.getURL() : '');
        dlog('info', 'mpv.guest.attached', { guestId: contents.id });
        contents.on('did-navigate', (_ev, url) => rememberGuest(contents, url));
        contents.on('did-navigate-in-page', (_ev, url) => rememberGuest(contents, url));
        contents.on('destroyed', () => { try { fnosGuests.delete(contents.id); } catch (_) {} });
      }
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
function notifyGuestMpvClosed(guestWc) {
  try {
    const wc = guestWc;
    if (wc && !wc.isDestroyed() && typeof wc.send === 'function') {
      try { wc.send('mpv:embed-closed'); } catch (_) {}
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
          if (fresh.token) headers['Authorization'] = String(fresh.token);
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
  if (process.platform !== 'win32' || !MpvSurfaceMod || !MpvPlayerMod) {
    dlog('warn', 'mpv.embed.skip', { reason: 'platform-or-module', platform: process.platform, hasSurface: !!MpvSurfaceMod, hasPlayer: !!MpvPlayerMod });
    return { ok: false, reason: 'MPV 仅支持 Windows 且模块已加载' };
  }
  const exePath = MpvPlayerMod.getMpvExe();
  if (!exePath) {
    // mpv.exe 缺失（如 CI 未下载内置内核/打包遗漏）：明确记录，避免静默无任何日志
    dlog('warn', 'mpv.embed.skip', { reason: 'mpv.exe-missing', resourcesPath: process.resourcesPath || '' });
    return { ok: false, reason: '未找到内置 mpv.exe（内置内核缺失，请重新下载完整安装包）' };
  }
  const st = getMpvSettings();
  try { global.__mpvSettings = st; } catch (_) {}
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
      settings: st,
      onNeedFreshUrl
    });
    mpvSurfaces.set(hostId, surf);
    surf.player.on('log', msg => dlog('info', 'mpv.player.log', { msg: String(msg).slice(0, 400) }));
    surf.player.on('surface-log', msg => dlog('info', 'mpv.player.log', { msg: String(msg).slice(0, 400) }));
    surf.player.on('end-file', reason => dlog('info', 'mpv.player.end', { reason: String(reason) }));
    // exit 第三参 userClosed：true=用户点 mpv 窗口 X（正常关闭），false=进程崩溃
    surf.player.on('exit', (code, _sig, userClosed) => {
      dlog('info', 'mpv.player.exit', { code, userClosed: !!userClosed });
      if (userClosed) {
        // 用户主动关闭 mpv：回收嵌入层、通知网页恢复 <video>，避免 mpv 被崩溃自愈重启。
        try {
          if (!surf.isAlive()) { surf.destroy && surf.destroy(); }
          if (mpvSurfaces.get(hostId) === surf) mpvSurfaces.delete(hostId);
          notifyGuestMpvClosed(guestWc);
        } catch (_) {}
      }
    });
    // 用户点 mpv 窗口 X（end-file reason=quit）：立即回收 + 通知网页
    surf.player.on('user-closed', () => {
      try {
        dlog('info', 'mpv.player.userclosed', { host: hostId });
        surf.destroy();
        if (mpvSurfaces.get(hostId) === surf) mpvSurfaces.delete(hostId);
        notifyGuestMpvClosed(guestWc);
      } catch (_) {}
    });
  } else {
    surf.setRect(dipRect, viewOffset);
  }

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
    if (payload.token) headers['Authorization'] = payload.token;
    // 飞牛影视网页内直播：/wp/m3u8 转码网关要求 Play-Link 头（hls.js/flv.js 原样携带），否则 401/403
    if (payload.playLink) headers['Play-Link'] = String(payload.playLink);
    if (origin) headers['Referer'] = origin.replace(/\/?$/, '/');
  }
  headers['User-Agent'] = getNasUA();

  try {
    await surf.play(url, headers, { isLive: !!payload.isLive || payload.scope === 'live', title: payload.title || '' });
    dlog('info', 'mpv.embed.ok', { host: hostId, hasCookie: !!headers['Cookie'], hasAuth: !!headers['Authorization'], isLive: !!payload.isLive || payload.scope === 'live' });
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
    return await embedMpvPlay(hostWin, p);
  } catch (err) { dlog('warn', 'mpv.embed.invoke.error', { err: String(err && err.message || err) }); return { ok: false, reason: err.message }; }
});

// guest 持续上报视频区坐标（窗口缩放/网页滚动时跟随）
ipcMain.on('mpv:embed-rect', (e, rect) => {
  try {
    const hostWin = hostWindowFromSender(e && e.sender) || mainWindow;
    const surf = mpvSurfaces.get(hostWin.id);
    if (surf && rect) {
      // 只更新视频区坐标（相对 webview 视口），viewOffset（webview 在外壳内的偏移）保持 embed 时的测量值
      surf.setRect(normalizeDipRect(rect), null);
    }
  } catch (_) {}
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
  if (!state) return { ok: false, error: '录制不存在' };
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
    require('child_process').exec((process.platform === 'win32' ? 'explorer.exe "' + dir + '"' : 'xdg-open "' + dir + '"'));
    return { ok: true, dir };
  } catch (e) { return { ok: false, error: e.message }; }
});

// v1.17.7：代理状态/配置 IPC 大幅精简——本地代理已移除，仅保留 iptvBaseUrl/
// iptvLine/iptvFavorites/debug（debug 仅用于诊断日志开关，不再驱动代理）。
ipcMain.handle('iptv:get-status', async () => {
  try {
    const s = loadSettings().iptv || {};
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
    const cur = loadSettings().iptv || {};
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
    saveSettings({ iptv: next });
    cachedSettings.iptv = next;
    return { ok: true, status: { listening: false, port: 0 } };
  } catch (err) {
    return { ok: false, error: err?.message || '保存失败' };
  }
});

// v1.17.7：缓存清空已无意义（无本地代理），保留 IPC 名称仅为兼容旧 renderer 调用。
ipcMain.handle('iptv:clear-cache', async () => ({ ok: true, status: { listening: false, port: 0, segments: 0, bytes: 0, sessions: 0 } }));

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) { try { mainWindow.restore(); } catch (_) {} }
    if (!mainWindow.isVisible()) { try { mainWindow.show(); } catch (_) {} }
    try { mainWindow.focus(); mainWindow.moveTop(); } catch (_) {}
  }
});

app.whenReady().then(() => {
  // 启动内置 MPV 的本地助手服务（在线字幕/本地字幕/画中画），仅 127.0.0.1。
  // 端口与令牌写入 global，mpv-player.js spawn mpv 时经环境变量注入给中文菜单 lua。
  try {
    if (MpvHelperMod && process.platform === 'win32') {
      MpvHelperMod.start().then((info) => {
        try {
          global.__mpvHelperPort = info && info.port;
          global.__mpvHelperToken = info && info.token;
          dlog('info', 'mpv.helper.start', { port: info && info.port });
        } catch (_) {}
      }).catch((e) => { dlog('warn', 'mpv.helper.start.fail', { err: String(e && e.message || e) }); });
    }
  } catch (e) { try { dlog('warn', 'mpv.helper.start.err', { err: String(e && e.message || e) }); } catch (_) {} }

  // v1.17.7：记录 GPU/渲染进程崩溃，便于 Win11 绿屏问题定位。
  // 这里不自动切换 disableGpu（Chromium 没有像素级检测 API），
  // 仅写日志 + 下次启动若连续崩溃可在设置中开启 GPU 兼容模式。
  try {
    app.on('gpu-process-crashed', (_e, killed) => {
      try {
        fs.appendFileSync(
          path.join(app.getPath('userData'), 'fnos-diag.log'),
          `[FNOS] gpu-process-crashed killed=${!!killed} at=${new Date().toISOString()}\n`
        );
      } catch (_) {}
    });
    app.on('render-process-gone', (_e, _wc, details) => {
      try {
        fs.appendFileSync(
          path.join(app.getPath('userData'), 'fnos-diag.log'),
          `[FNOS] render-process-gone reason=${details && details.reason} exitCode=${details && details.exitCode} at=${new Date().toISOString()}\n`
        );
      } catch (_) {}
    });
    app.on('child-process-gone', (_e, details) => {
      try {
        fs.appendFileSync(
          path.join(app.getPath('userData'), 'fnos-diag.log'),
          `[FNOS] child-process-gone type=${details && details.type} reason=${details && details.reason} at=${new Date().toISOString()}\n`
        );
      } catch (_) {}
    });
  } catch (_) {}

  // v1.25.0：硬件解码由 MPV 自行选择（--hwdec=auto），不再需要主进程探测 GPU。
  try { if (MpvPlayerMod && MpvPlayerMod.killAll) app.on('before-quit', () => { try { MpvPlayerMod.killAll(); } catch (_) {} }); } catch (_) {}

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
  // v1.16.3：初始化共享 session（CORS、cookie SameSite、权限、UA），全应用复用
  try { initSharedSession(); } catch (e) { console.error('[FNOS] initSharedSession error', e); }
  // v1.16.3：异步迁移旧版 persist:nas-* 分区的 cookie 到共享分区，不阻塞窗口启动
  setImmediate(() => { migrateLegacyCookiesOnce().catch((e) => console.error('[FNOS] cookie migrate error', e)); });
  // v1.15.0：兜底——defaultSession 也必须装上拦截器，防止 webview 因 partition
  // 未生效/异常回落到 default session 时 m3u8 拦截漏网；同时给所有历史 partition 预装。
  try { installCorsBypass(session.defaultSession); } catch (_) {}
  // v1.21.0：内置「飞牛电视直播增强」Chrome 扩展，注入应用内所有页面（含飞牛影视/直播/Jellyfin）
  loadBundledExtensions().catch((e) => console.error('[FNOS] load extension error', e));
  try {
    const hs = readHistoryStore();
    const list = Array.isArray(hs.history) ? hs.history : [];
    for (const h of list) { if (h && h.partition) applyUA(h.partition); }
  } catch (_) {}

  // v1.17.7：本地 IPTV 代理已移除，不再启动 8340 端口。
  const s = loadSettings();
  // v1.16.3：所有窗口强制走共享 partition，忽略旧版按 host 分的 currentPartition
  let initialPartition = SHARED_PARTITION;
  let initialTarget = null;

  if (s.lastConnectHref && s.origin) {
    initialTarget = { origin: s.origin, href: s.lastConnectHref };
    currentOrigin = s.origin;
    lastConnectHref = s.lastConnectHref;
    applyUA(SHARED_PARTITION);
    try {
      const targetSes = session.fromPartition(SHARED_PARTITION);
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

  // v1.16.1：启动无操作自动锁定检测
  try { startIdleAutoLock(); } catch (_) {}

  // v1.16.1：登录态心跳——每 5 分钟对当前 NAS 发一个轻量请求，
  // 保持 Cookie / 服务端会话存活；不弹窗、不打扰用户，失败时静默（下次
  // 业务请求自然会触发登录页，避免误报）。
  try { startAuthHeartbeat(); } catch (_) {}

  // v1.16.1：监听网络接口变化（内网↔外网切换），失效线路探测缓存
  try { startNetworkWatcher(); } catch (_) {}

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
  // v1.17.7：退出时强制关闭所有子窗口、清理定时器，避免残留进程/已销毁对象访问
  try {
    if (idleAutoLockTimer) clearInterval(idleAutoLockTimer);
    if (authHeartbeatTimer) clearInterval(authHeartbeatTimer);
    if (g_networkWatcher) clearInterval(g_networkWatcher);
    if (menuRebuildTimer) clearTimeout(menuRebuildTimer);
    if (g_persistTimer) clearInterval(g_persistTimer);
  } catch (_) {}
  try {
    BrowserWindow.getAllWindows().forEach((w) => {
      try { if (!w.isDestroyed()) w.removeAllListeners(); } catch (_) {}
    });
  } catch (_) {}
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  persistAllSessions();
});

g_persistTimer = setInterval(() => {
  if (mainWindow && !mainWindow.isDestroyed()) persistAllSessions();
}, 30000);
if (g_persistTimer.unref) g_persistTimer.unref();
app.on('window-all-closed', () => {
  // 有托盘时不退出；用户显式退出时才退出
  if (app.isQuitting) {
    if (process.platform !== 'darwin') app.quit();
  }
});
