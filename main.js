/**
 * FNOS 桌面客户端 - 主进程 (v2.0.0)
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
  globalShortcut, net, powerMonitor, webContents, clipboard,
} = require('electron');
const path = require('path');
const url = require('url');
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

// v2.2.3：全局禁用硬件加速（必须在 app ready 前调用）。
// 此前 v1.76.0 把 disableHardwareAcceleration 写在 BrowserWindow webPreferences 里——
// 该选项在 Electron 中无效（Electron 仅支持 app.disableHardwareAcceleration() 全局调用），
// 导致应用窗口创建时仍走 GPU 合成，Windows 上部分 Docker 应用（影视/音乐/34500 XTE 等）
// 触发 GPU 进程崩溃（render-process-gone crashed exitCode=0x80000003），
// 并连锁拖垮主窗口渲染进程（日志 00:37:56/00:38:17/00:38:18 主窗口三次崩溃）→ 黑屏/标题栏按钮失效。
// 全局软件渲染：视频播放走 MPV 外部播放器不受影响；网页内视频降为软解，NAS 管理界面无感知。
try { app.disableHardwareAcceleration(); } catch (_) {}

// v2.2.4：崩溃链修复增强——仅 app.disableHardwareAcceleration() 未能阻止
// 用户环境崩溃链（v2.2.3 日志：34500/music 创建即崩 0x80000003、主窗口连崩 4 次）。
// 追加 --disable-gpu（完全禁用 GPU 进程，不再创建 GPU 子进程），从根源消除
// "GPU 进程崩溃 → 渲染进程连锁崩溃"；视频硬解由 MPV 外部播放器承担，不受影响。
// 若未来需要恢复 GPU 合成，可改由设置项控制（此处先强制关闭以恢复稳定性）。
try {
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer');
  }
} catch (_) {}

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
const APP_VERSION = '2.4.11';
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
// v2.3.1：移除与全局 disable-gpu 冲突的 GPU 开关——
// enable-gpu-rasterization / enable-zero-copy / ignore-gpu-blocklist 与上方
// v2.2.4 的 disable-gpu + disable-software-rasterizer 直接矛盾：GPU 进程被禁
// 却仍尝试启用 GPU raster/光栅化，导致影视(/v)、音乐(/music)等媒体页面渲染
// 进程创建即崩（render-process-gone crashed 0x80000003，bornMs<100ms）。
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// v2.3.1：enable-features 移除 GPU/媒体硬解特性——D3D11/Mojo/Vaapi/PlatformHEVC/
// MediaFoundation 等硬解开关在全局 disable-gpu 下仍可能强制初始化 GPU 媒体栈，
// 是 /music、/v 媒体页面渲染进程创建即崩的另一诱因。视频播放走 MPV 外部播放器
// 不受影响；网页内视频退回软解更稳定。
app.commandLine.appendSwitch('enable-features', [
  'RawDraw',
  'ScrollPredictorSmoothness',
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
            contextIsolation: true, webviewTag: true, nodeIntegration: false, sandbox: false,
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
let lastAbortLogTs = 0; // v1.68.0：ERR_ABORTED 媒体日志节流时间戳（正常中止不刷屏）
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

// ---------------------- 单实例锁 + 进程异常检测（v2.3.5） ----------------------
// v2.1.8：恢复单实例锁。双击桌面快捷方式（--app）时第二次启动会触发 second-instance，
// 应用地址转交给已运行实例打开，避免每次点快捷方式都新起一个主程序（出现一大一小两个窗口）。
// v2.3.5（需求 2.6.1）：获取锁失败 = 已有飞牛实例在运行。
//   正常：主进程 second-instance 秒级处理参数，本实例静默退出；
//   异常：主进程卡死无响应（second-instance 不触发），本实例 2.6s 后弹窗提示重启飞牛。
const __HANDSHAKE_FILE = () => path.join(app.getPath('userData'), 'shortcut-handshake.json');

// 新实例侧（v2.3.6）：同步等待主进程标记 done（证明其响应）；超时则提示重启飞牛。
// v2.3.5 异步 setInterval 握手存在两处缺陷（fnos-diag 日志实锤，3 次点击全部命中）：
//   1) 竞态：v2.3.5 在申请单实例锁失败后才写握手文件，主进程 second-instance 事件先到、
//      __markHandshakeDone 读文件扑空 -> 新实例 2.6s 超时误弹"是否重启飞牛"；
//   2) 不退出：握手异步等待时主流程继续完整初始化（fpk.heartbeat/mpv.helper/创建窗口全跑），
//      同一应用出现两个窗口（hot_start winId:4 与新实例 pending_app winId:2）。
//   修复：握手文件在 requestSingleInstanceLock() 之前写好（见下文单实例锁区）+ 本函数同步
//   阻塞直至 app.exit()，main.js 剩余顶层代码不会再执行。
function __sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const t = Date.now();
    while (Date.now() - t < ms) {}
  }
}
// v2.3.6: token 由调用方在写握手文件时生成（先写文件后申请锁，消除竞态）
function __secondInstanceHandshakeSync(token) {
  const argv = (process.argv || []).slice(1);
  try { dlog && dlog('warn', 'shortcut.handshake.wait', { token, argv: argv.slice(0, 6) }); } catch (_) {}
  const deadline = Date.now() + 2600;
  let __done = false, __pid = 0;
  while (Date.now() < deadline) {
    __sleepSync(150);
    try {
      const obj = JSON.parse(fs.readFileSync(__HANDSHAKE_FILE(), 'utf-8'));
      // v2.3.6: 不校验 token——先写文件后申请锁已消除竞态，pending===false 即可退出
      if (obj && obj.pending === false) { __done = true; __pid = obj.pid || 0; break; }
    } catch (_) {}
  }
  if (__done) {
    try { dlog && dlog('info', 'shortcut.handshake.done', { pid: __pid }); } catch (_) {}
    try { fs.unlinkSync(__HANDSHAKE_FILE()); } catch (_) {}
    app.exit(0);
    return;
  }
  try { dlog && dlog('warn', 'shortcut.handshake.timeout', { token }); } catch (_) {}
  // 需求 2.6.1：主进程疑似卡死 -> 弹窗「飞牛客户端进程异常，无法唤起应用，是否重启飞牛？」。
  // dialog.showMessageBoxSync 需 app ready，此处用 PowerShell 系统弹窗保证 ready 前也可用。
  let __rc = 1;
  try {
    const cp = require('child_process');
    const psPath = path.join(app.getPath('userData'), 'handshake-dlg.ps1');
    const psBody = [
      'Add-Type -AssemblyName System.Windows.Forms',
      "$r = [System.Windows.Forms.MessageBox]::Show('飞牛客户端进程异常，无法唤起应用，是否重启飞牛？重启后请再次点击桌面快捷方式。', '飞牛客户端', 'YesNo', 'Warning')",
      "if ($r -eq 'Yes') { exit 0 } else { exit 1 }",
    ].join('\r\n');
    fs.writeFileSync(psPath, psBody, 'utf-8');
    try { cp.execSync('powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' + psPath + '"', { stdio: 'ignore' }); __rc = 0; } catch (_) { __rc = 1; }
    try { fs.unlinkSync(psPath); } catch (_) {}
  } catch (_) {}
  try { dlog && dlog('info', 'shortcut.handshake.restart', { rc: __rc }); } catch (_) {}
  if (__rc === 0) {
    try {
      const o = JSON.parse(fs.readFileSync(__HANDSHAKE_FILE(), 'utf-8'));
      const pid = o && o.pid;
      if (pid && pid !== process.pid) {
        try { require('child_process').execSync('taskkill /F /PID ' + pid + ' /T', { stdio: 'ignore' }); } catch (_) {}
      }
    } catch (_) {}
    try { fs.unlinkSync(__HANDSHAKE_FILE()); } catch (_) {}
    try {
      const cp2 = require('child_process');
      cp2.spawn(process.execPath, argv, { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
  }
  app.exit(0);
}

// 主进程侧：second-instance 收到启动参数后立即标记 done（写 pid），告知新实例本进程已响应。
// v2.3.6: 文件缺失也写 done 文件（防御时序异常/历史残留），新实例只要看到 pending===false 即退出。
function __markHandshakeDone() {
  try {
    const hf = __HANDSHAKE_FILE();
    let obj = {};
    try {
      if (fs.existsSync(hf)) obj = JSON.parse(fs.readFileSync(hf, 'utf-8')) || {};
      else { try { dlog && dlog('warn', 'shortcut.handshake.done.no-file'); } catch (_) {} }
    } catch (_) {}
    obj.pending = false;
    obj.pid = process.pid;
    obj.done_ts = Date.now();
    fs.writeFileSync(hf, JSON.stringify(obj), 'utf-8');
  } catch (_) {}
}

let __gotSingleLock = false;
// v2.4.0（需求 2.3 强制编码顺序）：单实例锁判断在代码最开头第一时间执行；second-instance
// 监听紧跟锁判断注册（在 app.ready/whenReady 注册之前）。handler __handleSecondInstance
// 为文件后部的函数声明，函数提升（hoisting）保证此处引用有效。
app.on('second-instance', __handleSecondInstance);
try { require('./logger.js').earlyLog('info', 'startup', '单实例锁判断开始', { params: { argv: (process.argv || []).slice(1).map((x) => String(x).slice(0, 80)) } }); } catch (_) {}
// v2.3.6（需求 2.6.1 竞态修复）：先写握手文件再申请锁——主进程 second-instance 事件
// 一定在 requestSingleInstanceLock() 之后到达，此时文件必已存在，__markHandshakeDone 不再扑空。
const __hsToken = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
let __hsWritten = false;
try {
  fs.writeFileSync(__HANDSHAKE_FILE(), JSON.stringify({ token: __hsToken, argv: (process.argv || []).slice(1), pending: true, ts: Date.now() }), 'utf-8');
  __hsWritten = true;
} catch (_) {}
if (app.requestSingleInstanceLock()) {
  __gotSingleLock = true;
  if (__hsWritten) { try { fs.unlinkSync(__HANDSHAKE_FILE()); } catch (_) {} }
  // 场景 B：锁成功 → 初始化 + 窗口加载完成 win.hide() + 托盘常驻；带 --launch-app 则经
  // open-fpk-app IPC 打开对应应用（见 launchSubAppFromArgs / __handleSecondInstance）
  try { require('./logger.js').earlyLog('info', 'startup', '单实例锁获取成功（首个实例）', { params: { token: __hsToken } }); } catch (_) {}
} else {
  // 场景 A：锁失败 → 已有实例运行。解析 --launch-app={appId} 经 second-instance 传给主进程，
  // 主进程在飞牛框架内打开对应 FPK 应用并经 open-fpk-app IPC 通知渲染进程；
  // 新进程 __secondInstanceHandshakeSync 同步阻塞后 app.exit(0)——不建窗、不加载页面。
  try { require('./logger.js').earlyLog('info', 'startup', '单实例锁获取失败（已有实例运行）→ second-instance 握手后退出', { params: { token: __hsToken } }); } catch (_) {}
  __secondInstanceHandshakeSync(__hsToken); // 同步等待握手，内部 app.exit()，主流程不会继续
}


// ===================== v2.0.0 子应用系统 =====================
// 2.1 apps-manifest.json 管理
const MANIFEST_PATH = path.join(app.getPath('userData'), 'apps-manifest.json');
const ASSETS_DIR = path.join(app.getPath('userData'), 'assets');

// ===================== v2.0.0 全局日志系统 =====================
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_RETENTION_DAYS = 30;
const SENSITIVE_KEYS = ['password', 'passwd', 'pwd', 'secret', 'token', 'sessionId', 'session_id', 'auth'];

function sanitizeForLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  try {
    const clone = Array.isArray(obj) ? [...obj] : { ...obj };
    for (const key of Object.keys(clone)) {
      if (SENSITIVE_KEYS.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
        clone[key] = '***REDACTED***';
      } else if (typeof clone[key] === 'object' && clone[key] !== null) {
        clone[key] = sanitizeForLog(clone[key]);
      }
    }
    return clone;
  } catch (_) {
    return obj;
  }
}

function fnosLog(level, module, msg, extra) {
  // v2.4.0（需求第一部分-3）：委托统一日志工具 logger.js（交付物 logger.ts 的 JS 映射，
  // 主进程/渲染进程共用）。行格式补齐进程类型字段 [main|renderer]；Error 或带 stack 的对象
  // 展开为错误堆栈，其余对象作为 params 落盘——关键节点必须带参数/返回值/堆栈，
  // 禁止只打一句话不带参数和堆栈。logger.js 自带敏感字段脱敏（password/token 等）。
  try {
    const Logger = require('./logger.js');
    let errObj = null;
    if (extra instanceof Error) {
      errObj = extra;
    } else if (extra && typeof extra === 'object' && extra.stack) {
      errObj = { message: String(extra.err || extra.message || msg), stack: String(extra.stack) };
    }
    Logger.log(level, module, msg, {
      params: (extra && extra !== errObj) ? extra : undefined,
      err: errObj,
    }, __RUN_MODE, 'main');
  } catch (_) {}
}

// 日志清理：删除超过保留天数的旧日志文件
function cleanupOldLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
    for (const f of files) {
      if (!f.startsWith('fnos-') || !f.endsWith('.log')) continue;
      const fp = path.join(LOG_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          fnosLog('info', 'log', '清理过期日志', { file: f });
        }
      } catch (_) {}
    }
  } catch (e) {
    fnosLog('error', 'log', '清理日志失败', { err: e.message });
  }
}

// 启动时清理旧日志
try { cleanupOldLogs(); } catch (_) {}

// 日志查看 IPC
ipcMain.handle('log:list-files', async () => {
  try {
    if (!fs.existsSync(LOG_DIR)) return { success: true, data: [] };
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('fnos-') && f.endsWith('.log'))
      .sort()
      .reverse()
      .map(f => {
        const fp = path.join(LOG_DIR, f);
        try {
          const stat = fs.statSync(fp);
          return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
        } catch (_) {
          return { name: f, size: 0, mtime: '' };
        }
      });
    return { success: true, data: files };
  } catch (e) {
    fnosLog('error', 'ipc', 'log:list-files error', { err: e.message });
    return { success: false, msg: e.message, data: [] };
  }
});

ipcMain.handle('log:read', async (_e, { fileName, lines }) => {
  try {
    if (!fileName || !/^[\w-]+\.log$/.test(fileName)) {
      return { success: false, msg: '无效文件名' };
    }
    const fp = path.join(LOG_DIR, fileName);
    if (!fs.existsSync(fp)) return { success: false, msg: '文件未找到' };
    const content = fs.readFileSync(fp, 'utf-8');
    const allLines = content.split('\n');
    const maxLines = Math.min(lines || 200, 2000);
    const result = allLines.slice(-maxLines).join('\n');
    return { success: true, data: result, totalLines: allLines.length };
  } catch (e) {
    fnosLog('error', 'ipc', 'log:read error', { err: e.message });
    return { success: false, msg: e.message };
  }
});

ipcMain.handle('log:get-status', async () => {
  try {
    if (!fs.existsSync(LOG_DIR)) return { success: true, data: { dir: LOG_DIR, fileCount: 0, totalSize: 0 } };
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'));
    let totalSize = 0;
    for (const f of files) {
      try { totalSize += fs.statSync(path.join(LOG_DIR, f)).size; } catch (_) {}
    }
    return { success: true, data: { dir: LOG_DIR, fileCount: files.length, totalSize, retentionDays: LOG_RETENTION_DAYS } };
  } catch (e) {
    return { success: false, msg: e.message };
  }
});

function readManifest() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return { apps: [] };
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.apps)) {
      fnosLog('warn', 'manifest', 'manifest格式异常，重置为空');
      return { apps: [] };
    }
    return data;
  } catch (e) {
    fnosLog('error', 'manifest', '读取manifest失败', { err: e.message, stack: e.stack });
    return { apps: [] };
  }
}

function writeManifest(data) {
  try {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2), 'utf-8');
    fnosLog('info', 'manifest', 'manifest写入成功');
    return { success: true, msg: '' };
  } catch (e) {
    fnosLog('error', 'manifest', '写入manifest失败', { err: e.message, stack: e.stack });
    return { success: false, msg: e.message };
  }
}

// 确保 assets 目录存在
try { if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true }); } catch (_) {}

// 2.2 命令行参数解析
function parseAppArgs() {
  const args = process.argv.slice(1);
  const result = { appId: null, nas: null };
  for (const arg of args) {
    const m1 = arg.match(/^--app=(.+)$/);
    if (m1) result.appId = m1[1];
    // v2.3.3: --launch-app={应用唯一ID}（appname）
    const m0 = arg.match(/^--launch-app=(.+)$/);
    if (m0) result.appId = m0[1];
    const m2 = arg.match(/^--nas=(.+)$/);
    if (m2) result.nas = m2[1];
  }
  fnosLog('info', 'args', '命令行参数解析', result);
  return result;
}
const launchArgs = parseAppArgs();
// v2.0.7：运行模式标记——日志中区分主程序/独立子应用
const __RUN_MODE = launchArgs.appId ? 'subapp:' + launchArgs.appId : 'main';

// v2.1.17: PreAuth 缓存 - 同一 origin 认证成功后 5 分钟内不再重复
const __preAuthCache = new Map(); // key: origin, value: { ts: number, navSteps: number }
const PREAUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ---------------------- 设置持久化 ----------------------
function defaultSettings() {
  return {
    server: '',
    origin: '',
    lastConnectHref: '',
    history: [],
    // 主页扫描到的应用列表 [{name,url,icon}]，用于应用清单管理
    apps: [],
    currentPartition: 'persist:connect',
    closeAction: '', // 'tray' | 'exit'
    // v2.1.11：通过桌面快捷方式打开应用后，主程序后台化方式（用户可选项）
    // 'tray'（默认，隐藏到托盘）| 'minimize'（最小化到任务栏）
    shortcutHideMode: 'tray',
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
    // v2.0.0：多账号管理
    accounts: [],
    // 当前激活的账号 origin（用于切换后恢复）
    activeAccountOrigin: '',
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
    // v2.1.17：FPK 图标管理器 API 配置
    fpkApi: {
      enabled: false,          // 是否启用 FPK 图标 API
      host: '',                // FPK 服务地址（如 192.168.31.101）
      port: 18080,             // FPK 服务端口
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

// ===================== v2.0.0 外网网络稳定性优化 =====================
// 网络健康监控系统：区分「瞬时抖动」和「真正断开」，抑制抖动期间的"已断开"弹窗，
// 内部自动重试；只有重试多次仍然失败才视为真实断连并通知用户。

const NetworkHealth = {
  // 状态
  isOnline: true,
  isStable: true,         // 当前是否"稳定"（非抖动状态）
  consecutiveFailures: 0,  // 连续失败次数
  lastSuccessTime: Date.now(),
  lastFailureTime: 0,
  jitterWindowMs: 8000,   // 抖动判定窗口：8秒内的失败视为抖动
  maxJitterFailures: 3,   // 窗口内允许的最大失败次数（超过则视为真断连）
  retryTimers: [],        // 活跃的重试定时器
  suppressedPopups: 0,    // 已抑制的弹窗计数（诊断用）
  listeners: [],          // 状态变化监听器

  // 记录一次网络探测/请求成功
  recordSuccess(context) {
    this.consecutiveFailures = 0;
    this.lastSuccessTime = Date.now();
    this.isOnline = true;
    this.isStable = true;
    fnosLog('info', 'network', `连接正常 [${context || 'general'}]`);
    this._notify('online');
  },

  // 记录一次网络探测/请求失败
  recordFailure(context, error) {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    const timeSinceLastSuccess = Date.now() - this.lastSuccessTime;
    
    // 判断是否为瞬时抖动：上次成功在抖动窗口内，且失败次数未超阈值
    const isJitter = this.consecutiveFailures <= this.maxJitterFailures && timeSinceLastSuccess < 60000;
    
    if (isJitter) {
      this.isStable = false;
      fnosLog('warn', 'network', `网络抖动 [${context || 'general'}] 连续失败 ${this.consecutiveFailures}/${this.maxJitterFailures}`, { error });
      this._notify('jitter');
    } else {
      this.isOnline = false;
      this.isStable = false;
      fnosLog('error', 'network', `网络断开 [${context || 'general'}] 连续失败 ${this.consecutiveFailures}`, { error });
      this._notify('offline');
    }
    return isJitter; // 返回 true 表示是抖动，调用方可抑制弹窗
  },

  // 判断当前是否应抑制"已断开"弹窗（抖动期间抑制）
  shouldSuppressPopup() {
    if (!this.isOnline) {
      // 真断连时也不频繁弹窗——同一断连周期只弹一次
      if (this.suppressedPopups > 0) return true;
    }
    return !this.isOnline || !this.isStable;
  },

  // 标记已弹窗（用于去重）
  markPopupShown() {
    this.suppressedPopups = 0;
  },

  // 注册状态变化监听
  onStatusChange(listener) {
    this.listeners.push(listener);
  },

  _notify(status) {
    for (const fn of this.listeners) {
      try { fn(status, { online: this.isOnline, stable: this.isStable, failures: this.consecutiveFailures }); } catch (_) {}
    }
  },

  // 创建带重试的网络请求包装器（指数退避）
  createRetryableRequest(fn, opts = {}) {
    const maxRetries = opts.maxRetries || 3;
    const baseDelay = opts.baseDelay || 1000;
    const maxDelay = opts.maxDelay || 15000;
    const context = opts.context || 'request';
    let attempt = 0;

    const doRetry = () => {
      if (attempt >= maxRetries) {
        fnosLog('error', 'network', `${context} 重试耗尽 (${maxRetries}次)`);
        NetworkHealth.recordFailure(context, 'max retries exceeded');
        return Promise.reject(new Error('Network request failed after retries'));
      }
      attempt++;
      const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500);
      fnosLog('info', 'network', `${context} 第${attempt}次重试，${Math.round(delay)}ms后执行`);
      return new Promise(resolve => {
        const timer = setTimeout(resolve, delay);
        NetworkHealth.retryTimers.push(timer);
      }).then(() => fn()).then(result => {
        NetworkHealth.recordSuccess(context);
        return result;
      }).catch(err => {
        const isJitter = NetworkHealth.recordFailure(context, err?.message);
        if (!isJitter || attempt >= maxRetries) throw err;
        return doRetry();
      });
    };

    return fn().then(result => {
      NetworkHealth.recordSuccess(context);
      return result;
    }).catch(err => {
      const isJitter = NetworkHealth.recordFailure(context, err?.message);
      if (!isJitter) throw err;
      return doRetry();
    });
  },

  // 获取状态摘要（诊断用）
  getStatus() {
    return {
      isOnline: this.isOnline,
      isStable: this.isStable,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessTime: new Date(this.lastSuccessTime).toISOString(),
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
      suppressedPopups: this.suppressedPopups,
    };
  }
};

// 增强型网络健康探测：定时向 NAS 发轻量请求，检测真实连通性
let networkProbeTimer = null;
function startNetworkProbe() {
  if (networkProbeTimer) clearInterval(networkProbeTimer);
  networkProbeTimer = setInterval(() => {
    try {
      const origin = currentOrigin;
      if (!origin || !/^https?:\/\//i.test(origin)) return;
      const u = new URL(origin);
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const ses = (currentPartition && currentPartition.startsWith('persist:'))
        ? session.fromPartition(currentPartition)
        : session.defaultSession;
      if (!ses || !ses.cookies) return;
      ses.cookies.get({ url: origin }).then((ck) => {
        const cookieHeader = (ck || []).map((c) => `${c.name}=${c.value}`).join('; ');
        const req = lib.request(origin + '/v/', {
          method: 'GET', timeout: 8000,
          headers: { 'User-Agent': getNasUA(), 'Cookie': cookieHeader, 'Accept': '*/*', 'Connection': 'keep-alive' },
        }, (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 500) {
              NetworkHealth.recordSuccess('probe');
            } else {
              NetworkHealth.recordFailure('probe', `HTTP ${res.statusCode}`);
            }
          });
        });
        req.on('error', (e) => { NetworkHealth.recordFailure('probe', e.message); });
        req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
        req.end();
      }).catch(() => {});
    } catch (_) {}
  }, 30000); // 每30秒探测一次
  if (networkProbeTimer.unref) networkProbeTimer.unref();
}

// IPC: 获取网络健康状态（供前端使用）
ipcMain.handle('network:get-status', async () => {
  return NetworkHealth.getStatus();
});

// ===================== v2.0.0 文件下载断点续传 =====================
const DOWNLOADS_FILE = path.join(app.getPath('userData'), 'downloads.json');

// 下载任务状态
const DOWNLOAD_STATUS = {
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

// 下载任务管理器
const DownloadManager = {
  tasks: new Map(), // taskId -> task info
  activeDownloads: new Map(), // taskId -> { abortController, writer }
  
  // 加载持久化的下载任务
  loadTasks() {
    try {
      if (!fs.existsSync(DOWNLOADS_FILE)) return new Map();
      const raw = fs.readFileSync(DOWNLOADS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return new Map();
      const map = new Map();
      for (const task of data) {
        if (task && task.id) {
          // 恢复未完成的下载任务状态为 paused
          if (task.status === DOWNLOAD_STATUS.DOWNLOADING) {
            task.status = DOWNLOAD_STATUS.PAUSED;
          }
          map.set(task.id, task);
        }
      }
      fnosLog('info', 'download', `加载 ${map.size} 个下载任务`);
      return map;
    } catch (e) {
      fnosLog('error', 'download', '加载下载任务失败', { err: e.message, stack: e.stack });
      return new Map();
    }
  },
  
  // 保存下载任务到文件
  saveTasks() {
    try {
      const tasks = Array.from(this.tasks.values());
      fs.writeFileSync(DOWNLOADS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
    } catch (e) {
      fnosLog('error', 'download', '保存下载任务失败', { err: e.message, stack: e.stack });
    }
  },
  
  // 创建下载任务
  createTask(url, savePath, fileName) {
    const taskId = 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const task = {
      id: taskId,
      url,
      savePath,
      fileName,
      totalBytes: 0,
      downloadedBytes: 0,
      status: DOWNLOAD_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    };
    this.tasks.set(taskId, task);
    this.saveTasks();
    fnosLog('info', 'download', '创建下载任务', { taskId, url, savePath });
    return task;
  },
  
  // 开始/恢复下载
  async startDownload(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, msg: '任务未找到' };
    
    // 如果已有活跃的下载，先停止
    if (this.activeDownloads.has(taskId)) {
      this.pauseDownload(taskId);
    }
    
    task.status = DOWNLOAD_STATUS.DOWNLOADING;
    task.error = null;
    task.updatedAt = new Date().toISOString();
    this.saveTasks();
    
    try {
      await this._doDownload(task);
    } catch (e) {
      task.status = DOWNLOAD_STATUS.FAILED;
      task.error = e.message;
      task.updatedAt = new Date().toISOString();
      this.saveTasks();
      fnosLog('error', 'download', '下载失败', { taskId, error: e.message });
      this._broadcastProgress(task);
    }
    
    return { success: task.status !== DOWNLOAD_STATUS.FAILED, msg: task.error || '' };
  },
  
  // 实际下载逻辑（支持断点续传）
  async _doDownload(task) {
    const { url, savePath, downloadedBytes } = task;
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    
    // 获取当前 partition 的 cookies
    const ses = (currentPartition && currentPartition.startsWith('persist:'))
      ? session.fromPartition(currentPartition)
      : session.defaultSession;
    const cookies = ses ? await ses.cookies.get({ url: url }) : [];
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    const headers = {
      'User-Agent': getNasUA(),
      'Cookie': cookieHeader,
      'Accept': '*/*',
      'Connection': 'keep-alive',
    };
    
    // 断点续传：如果已有部分下载，添加 Range 头
    if (downloadedBytes > 0) {
      headers['Range'] = `bytes=${downloadedBytes}-`;
      fnosLog('info', 'download', '断点续传', { taskId: task.id, fromByte: downloadedBytes });
    }
    
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method: 'GET', headers, timeout: 30000 }, (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          task.url = new URL(res.headers.location, url).href;
          this._doDownload(task).then(resolve).catch(reject);
          return;
        }
        
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        
        // 获取文件总大小
        const contentLength = parseInt(res.headers['content-length'] || '0', 10);
        if (res.statusCode === 200) {
          // 全新下载
          task.totalBytes = contentLength;
          task.downloadedBytes = 0;
        } else if (res.statusCode === 206) {
          // 断点续传，总大小 = 已下载 + 本次内容长度
          task.totalBytes = downloadedBytes + contentLength;
        }
        
        // 确保保存目录存在
        const dir = path.dirname(savePath);
        if (!fs.existsSync(dir)) {
          try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        }
        
        // 打开文件（断点续传时追加模式）
        const flags = downloadedBytes > 0 ? 'a' : 'w';
        const writer = fs.createWriteStream(savePath, { flags });
        
        const abortController = { aborted: false };
        this.activeDownloads.set(task.id, { abortController, writer });
        
        let lastProgressTime = 0;
        const PROGRESS_INTERVAL = 500; // 每500ms更新一次进度
        
        res.on('data', (chunk) => {
          if (abortController.aborted) {
            res.destroy();
            return;
          }
          
          writer.write(chunk);
          task.downloadedBytes += chunk.length;
          
          // 节流进度广播
          const now = Date.now();
          if (now - lastProgressTime > PROGRESS_INTERVAL) {
            lastProgressTime = now;
            task.updatedAt = new Date().toISOString();
            this.saveTasks();
            this._broadcastProgress(task);
          }
        });
        
        res.on('end', () => {
          writer.end();
          this.activeDownloads.delete(task.id);
          
          if (abortController.aborted) {
            task.status = DOWNLOAD_STATUS.PAUSED;
            fnosLog('info', 'download', '下载暂停', { taskId: task.id });
          } else {
            task.status = DOWNLOAD_STATUS.COMPLETED;
            fnosLog('info', 'download', '下载完成', { taskId: task.id, totalBytes: task.totalBytes });
          }
          
          task.updatedAt = new Date().toISOString();
          this.saveTasks();
          this._broadcastProgress(task);
          resolve();
        });
        
        res.on('error', (err) => {
          writer.end();
          this.activeDownloads.delete(task.id);
          reject(err);
        });
      });
      
      req.on('timeout', () => {
        try { req.destroy(); } catch (_) {}
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (err) => {
        this.activeDownloads.delete(task.id);
        reject(err);
      });
      
      req.end();
      
      // 保存 abort 控制器
      const existing = this.activeDownloads.get(task.id);
      if (existing) {
        existing.abort = () => {
          existing.abortController.aborted = true;
          try { req.destroy(); } catch (_) {}
        };
      }
    });
  },
  
  // 暂停下载
  pauseDownload(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, msg: '任务未找到' };
    
    const active = this.activeDownloads.get(taskId);
    if (active) {
      if (active.abort) active.abort();
      if (active.writer) {
        try { active.writer.end(); } catch (_) {}
      }
      this.activeDownloads.delete(taskId);
    }
    
    task.status = DOWNLOAD_STATUS.PAUSED;
    task.updatedAt = new Date().toISOString();
    this.saveTasks();
    this._broadcastProgress(task);
    fnosLog('info', 'download', '暂停下载', { taskId, downloadedBytes: task.downloadedBytes });
    
    return { success: true, msg: '已暂停' };
  },
  
  // 取消下载
  cancelDownload(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, msg: '任务未找到' };
    
    // 先暂停
    this.pauseDownload(taskId);
    
    // 删除文件
    try {
      if (fs.existsSync(task.savePath)) {
        fs.unlinkSync(task.savePath);
      }
    } catch (e) {
      fnosLog('warn', 'download', '删除文件失败', { path: task.savePath, err: e.message });
    }
    
    // 移除任务
    this.tasks.delete(taskId);
    this.saveTasks();
    fnosLog('info', 'download', '取消下载', { taskId });
    
    return { success: true, msg: '已取消' };
  },
  
  // 广播下载进度到所有窗口
  _broadcastProgress(task) {
    const progress = {
      id: task.id,
      fileName: task.fileName,
      status: task.status,
      totalBytes: task.totalBytes,
      downloadedBytes: task.downloadedBytes,
      progress: task.totalBytes > 0 ? Math.round((task.downloadedBytes / task.totalBytes) * 100) : 0,
      error: task.error,
    };
    
    // 广播到所有窗口
    const allWins = BrowserWindow.getAllWindows();
    for (const win of allWins) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send('download:progress', progress);
        }
      } catch (_) {}
    }
  },
  
  // 获取所有下载任务
  getAllTasks() {
    return Array.from(this.tasks.values()).sort((a, b) => 
      new Date(b.updatedAt) - new Date(a.updatedAt)
    );
  },
};

// 初始化下载管理器
DownloadManager.tasks = DownloadManager.loadTasks();

// 下载相关 IPC 接口
ipcMain.handle('download:start', async (_e, { url, savePath, fileName }) => {
  try {
    fnosLog('info', 'ipc', 'download:start', { url, savePath, fileName });
    const task = DownloadManager.createTask(url, savePath, fileName);
    // 异步开始下载，不阻塞 IPC 返回
    setImmediate(() => DownloadManager.startDownload(task.id));
    return { success: true, msg: '开始下载', data: task };
  } catch (e) {
    fnosLog('error', 'ipc', 'download:start error', { err: e.message, stack: e.stack });
    return { success: false, msg: e.message, data: null };
  }
});

ipcMain.handle('download:pause', async (_e, { taskId }) => {
  try {
    fnosLog('info', 'ipc', 'download:pause', { taskId });
    return DownloadManager.pauseDownload(taskId);
  } catch (e) {
    fnosLog('error', 'ipc', 'download:pause error', { err: e.message });
    return { success: false, msg: e.message };
  }
});

ipcMain.handle('download:resume', async (_e, { taskId }) => {
  try {
    fnosLog('info', 'ipc', 'download:resume', { taskId });
    const task = DownloadManager.tasks.get(taskId);
    if (!task) return { success: false, msg: '任务未找到' };
    setImmediate(() => DownloadManager.startDownload(taskId));
    return { success: true, msg: '继续下载' };
  } catch (e) {
    fnosLog('error', 'ipc', 'download:resume error', { err: e.message });
    return { success: false, msg: e.message };
  }
});

ipcMain.handle('download:cancel', async (_e, { taskId }) => {
  try {
    fnosLog('info', 'ipc', 'download:cancel', { taskId });
    return DownloadManager.cancelDownload(taskId);
  } catch (e) {
    fnosLog('error', 'ipc', 'download:cancel error', { err: e.message });
    return { success: false, msg: e.message };
  }
});

ipcMain.handle('download:list', async () => {
  try {
    const tasks = DownloadManager.getAllTasks();
    return { success: true, msg: '', data: tasks };
  } catch (e) {
    fnosLog('error', 'ipc', 'download:list error', { err: e.message });
    return { success: false, msg: e.message, data: [] };
  }
});

ipcMain.handle('download:get-default-path', async () => {
  // 默认下载到 exe 同级 downloads 目录
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const downloadDir = path.join(exeDir, 'downloads');
  try {
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
  } catch (_) {}
  return downloadDir;
});

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
  // v1.70.0：清理历史 urlRewrites 中的不可见/异常字符（旧版本输入框 HTML 转义
  // 不完整，可能把带乱码的地址存进设置，导致重写目标无效、应用外网打不开）。
  // 只保留可打印 ASCII，并剔除空规则。
  if (Array.isArray(cachedSettings.urlRewrites)) {
    cachedSettings.urlRewrites = cachedSettings.urlRewrites
      .filter((r) => r && typeof r.match === 'string' && typeof r.replace === 'string')
      .map((r) => ({
        match: r.match.replace(/[^\x20-\x7E]/g, '').trim(),
        replace: r.replace.replace(/[^\x20-\x7E]/g, '').trim(),
      }))
      .filter((r) => r.match && r.replace);
  }
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
  // v2.1.11：快捷方式后台化方式只允许 tray / minimize
  cachedSettings.shortcutHideMode = cachedSettings.shortcutHideMode === 'minimize' ? 'minimize' : 'tray';
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

// preload（飞牛 webview / 渲染进程）上报的解析/自动接管/统一日志，汇入诊断日志与 fnos 日志文件
// v2.4.0（需求第一部分-3）：渲染进程日志经既有 fnos:media-log IPC 汇入主进程日志文件
// （不新增 IPC 事件，遵守需求前置约定 2），保留 level / msg / params / ret / err.stack 字段。
ipcMain.on('fnos:media-log', (e, data) => {
  try {
    const wcId = e && e.sender ? e.sender.id : -1;
    const lvl = (data && ['info', 'warn', 'error'].indexOf(String(data.level)) !== -1) ? String(data.level) : 'info';
    const stage = String((data && data.stage) || 'unknown');
    dlog(lvl, 'mpv.preload.' + stage, {
      wcId,
      ...(data && typeof data === 'object' ? (() => { const { stage, ...rest } = data; return rest; })() : {})
    });
    // v2.4.0：渲染进程统一日志（preload 内 logger.js forRenderer）→ 写入 fnos-{date}.log
    try {
      if (data && (data.msg !== undefined || data.err !== undefined)) {
        require('./logger.js').log(lvl, 'renderer.' + stage, String(data.msg || stage), {
          params: Object.assign({ wcId }, data.params !== undefined ? { in: data.params } : {}, data.ret !== undefined ? { ret: data.ret } : {}),
          err: data.err ? { message: String(data.err.message || '').slice(0, 300), stack: String(data.err.stack || '').slice(0, 1200) } : undefined,
        }, String(data.runMode || 'renderer'), 'renderer');
      }
    } catch (_) {}
  } catch (_) {}
});

// v1.48.0：无边框自定义标题栏的窗口控制（与参考客户端 fntv 一致）
// v1.69.0：修复"标题栏按钮有时不起作用"。主窗口实际显示的是 webview（guest）
// 内注入的标题栏，按钮 IPC 的 sender 是 guest webContents，BrowserWindow.fromWebContents
// 对 guest 返回 null 导致窗口控制静默失效（设置/直播等独立窗口正常，故表现为"有时候"）。
// 统一通过 sender.hostWebContents 解析宿主窗口。
function hostWindowFromSender(sender) {
  try {
    const wc = (sender && sender.hostWebContents) || sender || null;
    if (!wc) return null;
    return BrowserWindow.fromWebContents(wc);
  } catch (_) { return null; }
}
ipcMain.on('window-minimize', (e) => {
  try { const w = hostWindowFromSender(e && e.sender); if (w && !w.isDestroyed()) w.minimize(); } catch (_) {}
});
ipcMain.on('window-maximize', (e) => {
  try {
    const w = hostWindowFromSender(e && e.sender);
    if (!w || w.isDestroyed()) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  } catch (_) {}
});
ipcMain.on('window-close', (e) => {
  try { const w = hostWindowFromSender(e && e.sender); if (w && !w.isDestroyed()) w.close(); } catch (_) {}
});
// v1.62.0：无边框标题栏原生拖拽兜底（-webkit-app-region:drag 在置顶嵌入 mpv 存在时
// 可能被系统拖拽消息环影响而失灵）。renderer 在顶部热区 mousedown(左键) 时调用 startDrag。
ipcMain.on('window-drag', (e) => {
  try { const w = hostWindowFromSender(e && e.sender); if (w && !w.isDestroyed()) w.startDrag(); } catch (_) {}
});
// v1.48.0：无边框标题栏的「☰ 菜单」按钮——弹出与原系统菜单栏完全一致的应用菜单
// （文件/下载/编辑/视图/工具/设置/帮助），内容与逻辑复用 buildMenuTemplate，零改动。
ipcMain.on('app-popup-menu', (e) => {
  try {
    const w = hostWindowFromSender(e && e.sender) || BrowserWindow.getFocusedWindow() || null;
    const menu = Menu.buildFromTemplate(buildMenuTemplate());
    menu.popup({ window: w || undefined });
  } catch (err) {
    dlog && dlog('warn', 'app.menu.popup', { err: String(err && err.message || err) });
  }
});
ipcMain.on('window-is-maximized', (e) => {
  try {
    const w = hostWindowFromSender(e && e.sender);
    if (w && !w.isDestroyed()) e.sender.send('window-maximized-state', { maximized: w.isMaximized() });
  } catch (_) {}
});


// v1.10.0：URL 重写（外网访问端口/域名映射）
// 设置页（settings.js）保存的是 urlRewrites: [{match, replace}]：
//   match 支持四种写法：
//     1) 完整 URL 前缀：  http://192.168.1.10:3000
//     2) host:port / host：192.168.1.10:3000 或 192.168.1.10
//     3) 纯端口：         3000
//     4) 路径前缀：       /movie/
//   replace 是外网完整地址：http://121.40.186.165:10301 或 https://nas.example.com:5667/base
// v1.69.0：修复"设置后不生效"——此前 rewriteUrl 读的是 urlMappings（from/to），
//   但设置页保存的是 urlRewrites（match/replace），字段不一致导致规则从未应用。
//   现在以 urlRewrites 为准，并兼容旧版 urlMappings。
function joinRewriteBase(base, rest) {
  const b = String(base || '').replace(/\/+$/, '');
  const r = String(rest || '');
  if (!r) return b + '/';
  return b + (r.startsWith('/') ? r : '/' + r);
}
function rewriteUrl(url) {
  if (!url) return url;
  const s = loadSettings();
  // 新格式（设置页实际保存的结构）
  const rewrites = Array.isArray(s.urlRewrites) ? s.urlRewrites : [];
  // 旧格式兼容（v1.10 遗留字段，仅做兜底迁移）
  const oldMappings = Array.isArray(s.urlMappings) ? s.urlMappings : [];
  if (!rewrites.length && !oldMappings.length) return url;
  try {
    let rewritten = String(url);
    const items = rewrites
      .map((r) => ({ m: r && r.match, t: r && r.replace }))
      .concat(oldMappings.map((m) => ({ m: m && m.from, t: m && m.to })));
    for (const it of items) {
      if (!it || typeof it.m !== 'string' || typeof it.t !== 'string') continue;
      const match = it.m.trim();
      const replace = it.t.trim();
      if (!match || !replace) continue;
      let u;
      try { u = new URL(rewritten); } catch (_) { continue; }
      // 1) 完整 URL 前缀（含协议）
      if (rewritten.startsWith(match)) {
        return joinRewriteBase(replace, rewritten.slice(match.length));
      }
      // 2) host 或 host:port（不含协议，域名大小写不敏感）
      if (/^[a-zA-Z0-9.\-]+(?::\d+)?$/.test(match)) {
        if (match.includes(':')) {
          if (u.host.toLowerCase() === match.toLowerCase()) {
            return joinRewriteBase(replace, rewritten.slice(u.origin.length));
          }
        } else if (u.hostname.toLowerCase() === match.toLowerCase()) {
          return joinRewriteBase(replace, rewritten.slice(u.origin.length));
        }
      }
      // 3) 纯端口
      if (/^\d+$/.test(match) && u.port === match) {
        return joinRewriteBase(replace, rewritten.slice(u.origin.length));
      }
      // 4) 路径前缀（以 / 开头）
      if (match.startsWith('/') && u.pathname.startsWith(match)) {
        const prefix = u.origin + match.replace(/\/+$/, '');
        return joinRewriteBase(replace, rewritten.slice(prefix.length));
      }
      // 5) 端口映射：URL 主机已是 replace 的主机、但端口仍是 match 的端口。
      //    v1.70.0：飞牛主页点击 Docker 应用时生成的地址常为"外网IP+内网端口"
      //    （如 http://121.40.186.165:3000/），与用户配置的内网规则（如
      //    192.168.31.101:3000 → http://121.40.186.165:10305）主机不一致，
      //    前 4 种匹配都命中不了。此时若 URL 的主机 == 规则外网地址的主机、
      //    URL 的端口 == 规则内网地址的端口，则把整个 origin 替换为外网地址。
      try {
        let mPort = '';
        let mHost = '';
        if (/^\d+$/.test(match)) {
          mPort = match;
        } else {
          const mUrl = /^https?:\/\//i.test(match) ? new URL(match) : new URL('http://' + match);
          mPort = mUrl.port;
          mHost = mUrl.hostname;
        }
        const rUrl = new URL(replace);
        if (mPort && mHost &&
            u.hostname.toLowerCase() === rUrl.hostname.toLowerCase() &&
            u.port === mPort) {
          return joinRewriteBase(replace, rewritten.slice(u.origin.length));
        }
      } catch (_) {}
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
    // v2.2.2：origin 语义修正——origin 应为真实 origin（scheme+host，不含路径），
    // 含路径的 fnid 地址单独存于 href/baseHref，避免 currentOrigin 被污染导致
    // preauth external-app 误判、IPTV nasOrigin 拼接错误（FNID 登录异常根因之一）。
    return { origin: 'https://fnos.net', href, baseHref: href, isFnId: true, fnId };
  }
  if (/^[A-Za-z0-9_-]+$/.test(raw) && !/^\d+$/.test(raw)) {
    const fnId = raw.replace(/^fn[-_]/i, '');
    const href = `https://fnos.net/${encodeURIComponent(fnId)}`;
    return { origin: 'https://fnos.net', href, baseHref: href, isFnId: true, fnId };
  }
  let u;
  try { u = new URL(`http://${raw}`); } catch (_) { throw new Error('服务器地址格式不正确'); }
  if (!u.port) u.port = '5666';
  return { origin: u.origin, href: u.toString(), isFnId: false };
}

// v1.16.3：全应用共享同一个持久化 partition，主窗口/飞牛 webview/设置/直播窗口
// 共用同一份 cookie、localStorage，实现一次登录全模块互通、重启自动恢复登录态。
const SHARED_PARTITION = 'persist:fnos-shared';

function partitionForServer(parsed) {
  // v2.0.0：多账号支持——每个 NAS 服务器地址使用独立 partition，
  // 确保多个 NAS 账号的登录态互不干扰、可同时保持在线。
  // v2.2.2：FNID（isFnId）用 baseHref/href（含 fnid 路径）生成 hash，保持不同 fnid
  // 账号间隔离，同时避免 origin 语义修正后所有 fnid 塌缩到同一 partition。
  if (parsed && (parsed.origin || parsed.href)) {
    const key = (parsed.isFnId && (parsed.baseHref || parsed.href)) ? (parsed.baseHref || parsed.href) : (parsed.origin || parsed.href);
    const hash = String(key).replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').slice(0, 24);
    return 'persist:nas-' + hash;
  }
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
  // v1.72.0：去重键改用 href/origin。此前用 partition，而 v1.16.3 起所有
  // 服务器共用同一 partition，导致不同地址互相覆盖，历史永远只保留 1 条。
  const key = parsed.href || parsed.origin;
  const idx = list.findIndex((h) => (h.href || h.origin) === key);
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

function removeHistoryByKey(href) {
  const s = loadSettings();
  // v1.72.0：按 href/origin 删除（原按 partition，因所有服务器共用同一 partition 会误删）
  const list = (s.history || []).filter((h) => (h.href || h.origin) !== href);
  const patch = { history: list };
  if ((s.lastConnectHref || s.origin) === href) {
    patch.server = ''; patch.origin = ''; patch.lastConnectHref = '';
    patch.currentPartition = 'persist:connect';
  }
  saveSettings(patch);
  // v1.12.1：同步更新独立历史文件
  try {
    const hs = readHistoryStore();
    const hsList = (Array.isArray(hs.history) ? hs.history : []).filter((h) => (h.href || h.origin) !== href);
    const hsPatch = { ...hs, history: hsList };
    if ((hs.lastConnectHref || hs.origin) === href) {
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
// v1.65.0（Electron 44）：扩展加载迁移到 session.extensions.loadExtension，旧 API 已废弃
function loadExtensionCompat(ses, extPath, opts) {
  if (ses && ses.extensions && typeof ses.extensions.loadExtension === 'function') {
    return ses.extensions.loadExtension(extPath, opts);
  }
  if (ses && typeof ses.loadExtension === 'function') {
    return ses.loadExtension(extPath, opts);
  }
  return Promise.reject(new Error('loadExtension unavailable'));
}
async function loadExtensionIntoSession(ses, allowFileAccess) {
  if (!ses) return;
  const hasLoader = (ses.extensions && typeof ses.extensions.loadExtension === 'function') ||
    typeof ses.loadExtension === 'function';
  if (!hasLoader) return;
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
      const ext = await loadExtensionCompat(ses, extPath, { allowFileAccess: !!allowFileAccess });
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
      // v1.68.0：ERR_ABORTED 通常是播放器主动中止（quitPlay/切换频道/滚动页面取消
      // 分片请求），网络层面并非故障，日志里却会刷几百条。这里只保留其中包含
      // "ERR_ABORTED" 之外的真正网络错误；ERR_ABORTED 仅限流记录（每 30s 至多 1 条）。
      const err = details.error || '';
      const now = Date.now();
      if (/ERR_ABORTED/.test(err)) {
        if (now - lastAbortLogTs < 30000) return;
        lastAbortLogTs = now;
      }
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
      contextIsolation: true, webviewTag: true,
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
        contextIsolation: true, webviewTag: true,
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
      contextIsolation: true, webviewTag: true,
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

// v1.50.0：一键隐藏/锁定时，MPV 是独立的原生窗口（不是 Electron BrowserWindow），
// BrowserWindow.hide() 管不到它，必须单独控制。
//   - visibility 属性在 d3d11 VO 返回 -3（空操作），v1.49 起改用 window-minimized 隐藏窗口；
//   - v1.50 新增：隐藏时同步暂停 + 静音（电影/音乐/直播全部），呼出时恢复原播放/静音状态；
//   - 任务栏一并隐藏：Electron 窗口 hide() 后本就不在任务栏；mpv 独立窗最小化后仍可能在
//     任务栏，用 --force-window 之外的 skipTaskbar 属性尽量隐藏（不支持时最小化已足够离开画面）。
function setAllMpvVisibility(visible) {
  try {
    if (!mpvSurfaces || mpvSurfaces.size === 0) return;
    for (const surf of mpvSurfaces.values()) {
      try {
        if (!surf || !surf.player || (surf.isAlive && !surf.isAlive())) continue;
        if (visible) {
          if (typeof surf.player.setSuspended === 'function') surf.player.setSuspended(false);
          if (typeof surf.player.showWindow === 'function') surf.player.showWindow();
          if (typeof surf.onHostShown === 'function') surf.onHostShown();
        } else {
          if (typeof surf.player.setSuspended === 'function') surf.player.setSuspended(true);
          if (typeof surf.player.hideWindow === 'function') surf.player.hideWindow();
        }
      } catch (_) {}
    }
    try { dlog('info', 'mpv.visibility', { visible: !!visible, count: mpvSurfaces.size }); } catch (_) {}
  } catch (_) {}
}

function hideAllAppWindows() {
  try {
    // v1.50.0：记录隐藏前可见的窗口，呼出/解锁时一并恢复（修复"只有飞牛主页面恢复、
    // 已打开的客户端内应用不恢复"）。
    global.__hiddenVisibleWins = [];
    BrowserWindow.getAllWindows().forEach((w) => {
      try {
        if (w === lockWindow) return; // 不隐藏锁屏窗
        if (w.isDestroyed()) return;
        if (w.isVisible() && !w.isMinimized()) global.__hiddenVisibleWins.push(w.id);
        w.hide();
      } catch (_) {}
    });
    try { dlog('info', 'app.hide', { hiddenIds: global.__hiddenVisibleWins }); } catch (_) {}
  } catch (_) {}
  // 一键隐藏/锁定：连同所有 MPV 播放窗口（嵌入层 + 独立窗口 + 直播）一起隐藏 + 暂停 + 静音
  setAllMpvVisibility(false);
}

function showAllAppWindows() {
  try {
    const ids = global.__hiddenVisibleWins || [];
    if (ids.length) {
      // 恢复隐藏前可见的所有窗口（含客户端内应用 FPK/直播/音乐等）
      ids.forEach((id) => {
        try {
          const w = BrowserWindow.fromId(id);
          if (w && !w.isDestroyed()) w.show();
        } catch (_) {}
      });
      global.__hiddenVisibleWins = [];
    } else {
      // 兜底：没有记录时至少恢复主窗口/主页
      const home = appWindows.find((e) => e.isHome && e.win && !e.win.isDestroyed());
      if (home) home.win.show();
      else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    }
    // 焦点落到主窗口/主页
    const home = appWindows.find((e) => e.isHome && e.win && !e.win.isDestroyed());
    if (home && home.win) home.win.focus();
    else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
    try { dlog('info', 'app.show', { restoredIds: ids }); } catch (_) {}
  } catch (_) {}
  // 呼出/解锁：恢复所有 MPV 播放窗口可见 + 恢复播放/声音
  setAllMpvVisibility(true);
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

// ---------------------- 登录态心跳（v1.65.1） ----------------------
// 对当前 NAS 发轻量请求保持会话 Cookie / 服务端 session 不过期。
// 不弹窗、不打扰；失败静默，由真正业务请求自然触发重新登录。
// FRP / 内网穿透场景：隧道空闲超时易被服务端回收，导致前端 WebSocket 断开提示“已断开”。
// 因此心跳刻意保持高频（90s）+ keep-alive，并支持网络恢复时立即补跳。
let authHeartbeatTimer = null;
// v2.2.4: FPK 连接心跳定时器（向 fntb 上报客户端活跃，避免"未连接"误报）
let fpkHeartbeatTimer = null;
let authHeartbeatBusy = false;
function authHeartbeatOnce() {
  try {
    if (isLocked || isCompletelyHidden) return;
    if (authHeartbeatBusy) return;
    authHeartbeatBusy = true;
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
      // 选一个真实的登录态接口用于续期：优先 app 主页兜底根路径；
      // 对飞牛 fnOS 使用首页（返回 200）即可刷新 LAST_ACTIVITY，维持隧道活跃。
      const u2 = new URL(origin);
      const paths = ['/', '/v/'];
      const target = origin + paths[0];
      const cookieHeader = (ck || []).map((c) => `${c.name}=${c.value}`).join('; ');
      const req = lib.request(target, {
        method: 'GET', timeout: 15000,
        headers: {
          'User-Agent': getNasUA(), 'Cookie': cookieHeader,
          'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9',
          'Connection': 'keep-alive',
        },
      }, (res) => {
        // 读一点响应体，避免部分 FRP 实现因未读完而半关闭连接
        res.on('data', () => {});
        res.on('end', () => {
          try { authHeartbeatBusy = false; } catch (_) {}
          // v2.0.0：记录心跳成功到网络健康监控
          try {
            if (res.statusCode >= 200 && res.statusCode < 500) {
              NetworkHealth.recordSuccess('heartbeat');
            } else {
              NetworkHealth.recordFailure('heartbeat', `HTTP ${res.statusCode}`);
            }
          } catch (_) {}
        });
      });
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
      req.on('error', (err) => {
        // v2.0.0：记录心跳失败到网络健康监控
        try { NetworkHealth.recordFailure('heartbeat', err?.message || 'error'); } catch (_) {}
      });
      req.on('close', () => { try { authHeartbeatBusy = false; } catch (_) {} });
      req.end();
    }).catch(() => { try { authHeartbeatBusy = false; } catch (_) {} });
    // 页面保活：向当前飞牛 webview/webContents 注入 fetch，
    // 保持前端微服务/WebSocket 所用连接自身活跃（主进程心跳覆盖不到该连接）。
    try { pageKeepAlive(); } catch (_) {}
  } catch (_) { try { authHeartbeatBusy = false; } catch (_) {} }
}

// 仅对加载了飞牛 NAS 页面的 webContents 注入一次轻量 fetch，使其连接持续活跃，避免 FRP 空闲回收
function pageKeepAlive() {
  try {
    let wc = null;
    if (typeof webContents !== 'undefined' && webContents && webContents.getAllWebContents) {
      const all = webContents.getAllWebContents();
      if (!all || !all.length) return;
      for (let i = all.length - 1; i >= 0; i--) {
        const c = all[i];
        try {
          const u = c.getURL() || '';
          if (/^(https?:\/\/|\/)/i.test(u)) { wc = c; break; }
        } catch (_) {}
      }
    }
    if (!wc) return;
    // 一次性注入「页面内持久保活」：每 25 秒向同源发一次带随机参数的轻量请求，
    // 让飞牛前端自身的连接在 FRP 隧道内持续产生真实流量，避免 WS/空闲被服务端回收。
    // 用 window.__fnKeptAlive 作幂等标记，导航后重新注入。
    const script = `(function(){ if (window.__fnKeptAlive) return; window.__fnKeptAlive = true; var iv = setInterval(function(){ try { var u = location.origin + '/v/?_ka=' + Date.now(); fetch(u, {method:'GET', credentials:'include', cache:'no-store', mode:'cors'}).catch(function(){}); } catch (e) {} }, 25000); if (iv && iv.unref) iv.unref(); })();`;
    try { wc.executeJavaScript(script, true).catch(function(){}); } catch (e) { try { wc.executeJavaScript(script); } catch (_) {} }
  } catch (_) {}
}
function startAuthHeartbeat() {
  try { if (authHeartbeatTimer) clearInterval(authHeartbeatTimer); } catch (_) {}
  authHeartbeatTimer = setInterval(authHeartbeatOnce, 45 * 1000); // 45 秒，FRP 保活
  if (authHeartbeatTimer.unref) authHeartbeatTimer.unref();
}
function bumpAuthHeartbeat() {
  try { authHeartbeatOnce(); } catch (_) {}
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
        // 网络恢复/切换瞬间速续 FRP 心跳，避免隧道长期空闲被回收
        try { bumpAuthHeartbeat(); } catch (_) {}
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
    frame: false, // v1.54：无边框，settings-preload 内注入与主窗口同款标题栏
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      preload: SETTINGS_PRELOAD,
      contextIsolation: true, webviewTag: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      partition: currentPartition, // v2.1.12：与主窗口一致（登录 cookie 所在分区），设置页 http 图标请求不 401
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
    // v1.72.0：应用窗口任务栏直接显示应用名（去掉 "FNOS · " 前缀），
    // 与需求「任务栏显示启动应用的名称」一致；主窗口标题仍由 safeSetTitle 控制。
    if (!entry.isHome && title && title.trim()) win.setTitle(title);
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
    // v1.67.0：任意应用/宿主窗口聚焦或失焦时统一刷新 MPV 层级——
    // 切到普通应用窗（如文件管理）时，即使宿主窗 blur 防抖未到，也能立即降 MPV 盖窗；
    // 切回视频宿主窗时恢复置顶。函数体内自带 live-mpv 判断与 500ms 失焦防抖，低频安全。
    try { win.on('focus', () => { try { refreshMpvLayer(); } catch (_) {} }); } catch (_) {}
    try { win.on('blur', () => { try { refreshMpvLayer(); } catch (_) {} }); } catch (_) {}
    try { win.on('restore', () => { try { refreshMpvLayer(); } catch (_) {} }); } catch (_) {}
  } catch (_) {}
  win.webContents.on('did-navigate', (_e, url) => {
    entry.url = url;
    // v2.1.15：增强日志——记录 app 窗口的导航事件
    try {
      const __isAppview = /\/appview(\?|$)/i.test(url);
      dlog && dlog('info', 'appwin.did-navigate', { app: __appLabel, winId: win.id, url: String(url).slice(0, 160), appview: __isAppview, totalMs: Date.now() - __t0 });
    } catch (_) {}
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
    // v2.1.15：增强日志——记录 appview SPA 内部路由跳转
    try {
      const __isAppview = /\/appview(\?|$)/i.test(url);
      if (__isAppview) {
        dlog && dlog('info', 'appwin.spa-navigate', { app: __appLabel, winId: win.id, url: String(url).slice(0, 160), totalMs: Date.now() - __t0 });
      }
    } catch (_) {}
  });

  // 渲染进程崩溃：自动重载入口
  win.webContents.on('render-process-gone', (_e, details) => {
    try {
      const reason = details && details.reason;
      dlog && dlog('error', 'appwin.render-gone.register', {
        winId: win.id,
        isHome: !!entry.isHome,
        reason,
        exitCode: details && details.exitCode,
        url: String(entry.url || '').slice(0, 140),
      });
    } catch (_) {}
    if (entry.isHome) {
      // v2.2.3：主窗口崩溃恢复强化——此前裸 loadURL 无日志/无延迟/无次数限制/无 UA，
      // 崩溃后立即重载大概率再次失败（渲染进程尚未完全重建），表现为黑屏无法自愈。
      // 现在：延迟 1200ms 重载（带 NAS UA）、最多 2 次、不可见时补 show、最后兜底连接页。
      // v2.2.4：恢复次数 2→5 次 + 指数退避（1200/2000/3200/4800/6800ms），
      // 并记录崩溃间隔，避免"连锁崩溃"（一个窗口崩 → GPU/渲染资源异常 → 主窗口连环崩）直接放弃。
      try {
        const tries = (win.__mainCrashTries || 0) + 1;
        win.__mainCrashTries = tries;
        // 连续崩溃计数（全局，30 秒内计数，用于连锁崩溃判断）
        const now = Date.now();
        if (!global.__crashSeriesStart) global.__crashSeriesStart = now;
        if (now - global.__crashSeriesStart > 30000) { global.__crashSeriesStart = now; global.__crashSeriesCount = 0; }
        global.__crashSeriesCount = (global.__crashSeriesCount || 0) + 1;
        dlog && dlog('warn', 'main.render-gone.recover', {
          try: tries, reason, winId: win.id,
          seriesCount: global.__crashSeriesCount,
          seriesSpanMs: now - global.__crashSeriesStart,
          openWindows: (() => { try { return BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).length; } catch (_) { return -1; } })(),
        });
        if (tries > 5) {
          dlog && dlog('error', 'main.render-gone.giveup', { try: tries, winId: win.id, reason, seriesCount: global.__crashSeriesCount });
          try { if (!win.isDestroyed()) showConnectPage(); } catch (_) {}
          return;
        }
        // 指数退避：1200, 2000, 3200, 4800, 6800ms
        const delays = [1200, 2000, 3200, 4800, 6800];
        const delayMs = delays[Math.min(tries - 1, delays.length - 1)] || 1200;
        setTimeout(() => {
          try {
            if (!win || win.isDestroyed()) return;
            if (!win.isVisible()) { try { win.show(); } catch (_) {} }
            const target = lastConnectHref || win.webContents.getURL();
            if (target && /^https?:/i.test(target)) {
              dlog && dlog('info', 'main.render-gone.reload', { try: tries, url: String(target).slice(0, 140), winId: win.id, delayMs });
              win.loadURL(target, { userAgent: getNasUA() }).catch(() => { try { if (!win.isDestroyed()) showConnectPage(); } catch (_) {} });
            } else {
              showConnectPage();
            }
          } catch (_) {}
        }, delayMs);
      } catch (_) {}
      return;
    }
    // 应用窗口崩溃恢复由 createAppWindow 内 appwin.render-gone（L4121）处理，
    // 这里仅记录，避免与上面 isHome 分支重复逻辑。
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
      // OAuth 弹窗常先打开 about:blank 再由脚本跳转，需放行且保留 opener；
      // FNDESK 内置应用（NPC 等）也常以 about:blank 开窗再跳转。
      // v1.51.0：统一无边框 + 注入同款标题栏，避免出现系统原生标题栏。
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1024, height: 720,
          minWidth: 640, minHeight: 480,
          backgroundColor: '#0b0d12',
          autoHideMenuBar: true,
          frame: false, // v1.53：仅 frame:false，禁用 overlay（否则 Windows 重绘系统按钮）
          icon: ICON_PATH,
          title: APP_NAME,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            // window.open 弹窗继承调用方 session，不能显式设 partition（会抛 top-level only）
            contextIsolation: true, webviewTag: true,
            nodeIntegration: false,
            sandbox: false, // v1.56：preload 需 require 本地 titlebar-inject
            webSecurity: true,
            allowRunningInsecureContent: true,
            backgroundThrottling: false,
            enableBlinkFeatures: 'CSSBackdropFilter',
            spellcheck: false,
            v8CacheOptions: 'bypassHeatCheckAndEagerCompile',
          },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) {
      // v2.2.3：FNID 生态域识别——*.fnos.net / fnos.net 链接在主窗口内导航，
      // 避免 FNID 检测页点击访问地址后被当外部应用反复建窗 + 302 循环。
      try {
        const _u = new URL(url);
        const _h = String(_u.hostname || '').toLowerCase();
        if (_h === 'fnos.net' || _h.endsWith('.fnos.net')) {
          setImmediate(() => {
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                dlog && dlog('info', 'appwin.open.fnos-domain-in-main', { url: url.slice(0, 140), from: 'appwin' });
                mainWindow.webContents.loadURL(url);
              }
            } catch (_) {}
          });
          return { action: 'deny' };
        }
      } catch (_) {}
      // v2.4.9（用户反馈 8 两种窗口模式自动适配）：preload 内嵌窗监测发出的 window.open
      // （features 带 fnos-embed-style 标记）→ 以内嵌窗形态开宿主应用窗（↻↗ 内嵌窗样式
      // 标题栏）；前端自发 window.open（无标记，如飞牛音乐）→ 正常跳出窗。
      const __embedStyle = /fnos-embed-style/.test(String(features || ''));
      setImmediate(() => createAppWindow(url, { partition: entry.partition, embedStyle: __embedStyle }));
      return { action: 'deny' };
    }
    if (/^(mailto|tel|sms):/i.test(url)) {
      setImmediate(() => shell.openExternal(url).catch(() => {}));
      return { action: 'deny' };
    }
    // v1.55：其余链接（含未识别协议）一律拒绝系统默认开窗，杜绝带系统原生标题栏的窗口
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
    win.webContents.on('console-message', (evt) => {
      // v1.65.0（Electron 44）：签名改为单个 event 对象 { level, message, lineNumber, sourceId }
      let level, message, line, sourceId;
      if (evt && typeof evt === 'object' && 'message' in evt) {
        ({ level, message, lineNumber: line, sourceId } = evt);
      } else {
        // 兼容旧版 Electron（多参数形式，理论不会走到，因本版本已锁定 44）
        level = 2; message = String(evt); line = 0; sourceId = '';
      }
      if (!message) return;
      // 只记录与媒体/解码/网络相关的告警和错误，避免刷屏
      if (level < 2) return; // 0=verbose 1=info 2=warning 3=error
      // v1.68.0：过滤远程网页自身的高频噪音（与客户端无关，每次进页面都会刷几十条），
      // 避免 fnos-web.log 被无效日志占满、掩盖真正需要排查的媒体错误。
      if (/mediaCapabilities/i.test(message) && /\[object Object\]/.test(message)) return;
      if (/Sync media data failed/i.test(message)) return;
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

// v1.71.0：应用窗口统一 UI 注入（侧边栏毛玻璃 + 深色滚动条），与主窗口 shell.js 注入保持一致，
// 避免部分 Docker 应用（如 XTE-IPTV）仍显示白色原生滚动条/原生侧边栏。
const APP_UI_INJECT_CSS = [
  // v2.0.0：全局 iOS27 液态玻璃效果注入
  'html,body{overscroll-behavior:none;}',
  '::-webkit-scrollbar{width:10px;height:10px;}',
  '::-webkit-scrollbar-track{background:transparent;}',
  '::-webkit-scrollbar-thumb{background:rgba(120,130,150,.45);border-radius:6px;}',
  '::-webkit-scrollbar-thumb:hover{background:rgba(140,150,170,.65);}',
  // 侧边栏液态玻璃效果
  'aside, .sidebar, .side-bar, .side-nav, .left-nav, .left-sidebar, .layout-sidebar,',
  '.el-aside, .aside-container, .menu-container, .drawer, .side-panel,',
  '[class*="sidebar"], [class*="side-bar"], [class*="side-nav"], [class*="left-nav"],',
  '[class*="left-sidebar"], [class*="aside"] {',
  '  background: rgba(18, 22, 32, 0.42) !important;',
  '  backdrop-filter: blur(18px) saturate(1.35) !important;',
  '  -webkit-backdrop-filter: blur(18px) saturate(1.35) !important;',
  '  border-right: 1px solid rgba(255,255,255,0.08) !important;',
  '  box-shadow: none !important;',
  '}',
  // v2.0.0：弹窗/对话框液态玻璃
  '[role="dialog"], .modal, .dialog, .el-dialog, .ant-modal, .popup, .overlay-panel {',
  '  background: rgba(20, 22, 35, 0.72) !important;',
  '  backdrop-filter: blur(28px) saturate(1.8) !important;',
  '  -webkit-backdrop-filter: blur(28px) saturate(1.8) !important;',
  '  border: 1px solid rgba(255,255,255,0.1) !important;',
  '  border-radius: 18px !important;',
  '  box-shadow: 0 24px 64px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.15) !important;',
  '}',
  // v2.0.0：卡片/面板液态玻璃
  '.card, .panel, .el-card, .ant-card, [class*="card"], [class*="panel"] {',
  '  background: rgba(255,255,255,0.05) !important;',
  '  backdrop-filter: blur(16px) saturate(1.4) !important;',
  '  -webkit-backdrop-filter: blur(16px) saturate(1.4) !important;',
  '  border: 1px solid rgba(255,255,255,0.08) !important;',
  '  border-radius: 14px !important;',
  '  box-shadow: 0 8px 32px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.08) !important;',
  '}',
  // v2.0.0：按钮液态玻璃（排除自定义标题栏按钮，避免裁剪SVG图标）
  'button:not(#fnos-tb-min):not(#fnos-tb-max):not(#fnos-tb-close):not(#fnos-tb-menu), .btn, .el-button, .ant-btn, [role="button"] {',
  '  border-radius: 20px !important;',
  '  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;',
  '}',
  'button:not(#fnos-tb-min):not(#fnos-tb-max):not(#fnos-tb-close):not(#fnos-tb-menu):hover, .btn:hover, .el-button:hover, .ant-btn:hover, [role="button"]:hover {',
  '  transform: translateY(-1px) !important;',
  '  box-shadow: 0 6px 20px rgba(0,0,0,0.25) !important;',
  '}',
  // v2.0.3：标题栏按钮SVG图标保护
  '#fnos-tb-min svg, #fnos-tb-max svg, #fnos-tb-close svg, #fnos-tb-menu svg {',
  '  display: block !important; pointer-events: none !important;',
  '}',
  '#fnos-tb-close svg path { stroke: #fff !important; }',
  // v2.0.0：输入框液态玻璃
  'input, textarea, .el-input__inner, .ant-input {',
  '  background: rgba(255,255,255,0.06) !important;',
  '  border: 1px solid rgba(255,255,255,0.1) !important;',
  '  border-radius: 10px !important;',
  '  transition: all 0.2s ease !important;',
  '}',
  'input:focus, textarea:focus, .el-input__inner:focus, .ant-input:focus {',
  '  background: rgba(255,255,255,0.1) !important;',
  '  border-color: rgba(99,102,241,0.5) !important;',
  '  box-shadow: 0 0 0 3px rgba(99,102,241,0.15) !important;',
  '}',
].join('\n');


// v2.4.7（用户定案，2026-09-23）：程序内启动 = 渲染进程后台模拟点击飞牛桌面应用图标
// （≡真实点击，参数/解析/登录链路全等价——appview?anchor 直开不等价：Lucky 实测
// "应用 lucky 不存在或未安装"）。飞牛应用两种窗口模式（A 独立跳出窗 window.open →
// createAppWindow；B 桌面内嵌窗 iframe 容器）由飞牛前端自决，呈现统一为"从主程序跳出的
// 窗口"（preload 监测内嵌 iframe 转 window.open）。主进程只走 open-fpk-app IPC 唤起渲染
// 进程点击；快捷方式流程主界面永不 show（主程序藏托盘、跳出窗显示在桌面）。
// 复用式直开方案（v2.4.5/2.4.6）被用户否定："跟你说的秒开完全是两码事"——等价点击优先。

function createAppWindow(url, opts = {}) {
  const __cw_t0 = Date.now();
  // v2.2.4：崩溃风暴抑制——若最近 30 秒内渲染进程崩溃 >=4 次（应用窗口连崩），
  // 新窗口创建延迟 2.5s，等 GPU/渲染资源稳定再建，避免"创建即崩→连锁崩"。
  // 日志证据：02:47:39/02:49:48 34500 创建即崩、主窗口 02:47:07-10 连崩 4 次。
  try {
    const now = Date.now();
    if (global.__appCrashSeriesStart && (now - global.__appCrashSeriesStart < 30000) && (global.__appCrashSeriesCount || 0) >= 4) {
      const __stormWait = 2500;
      dlog && dlog('warn', 'appwin.create.crash-storm-delay', {
        url: String(url).slice(0, 120),
        seriesCount: global.__appCrashSeriesCount,
        waitMs: __stormWait,
      });
      setTimeout(() => {
        try { createAppWindowInner(url, opts, __cw_t0); } catch (_) {}
      }, __stormWait);
      return null;
    }
    // v2.4.7：透传窗口引用（备用；原 v2.4.5/2.4.6 复用窗方案已拄除，现主链路为渲染进程模拟点击）
    return createAppWindowInner(url, opts, __cw_t0);
  } catch (_) { try { return createAppWindowInner(url, opts, __cw_t0); } catch (_) {} }
}

function createAppWindowInner(url, opts = {}, __cw_t0 = Date.now()) {
  // v2.0.5：修复——子应用窗口必须与主窗口使用同一 partition，否则 cookie/session 不共享，
  // 导致子应用打开后被重定向到登录页。不再将 persist:nas-* 替换为 SHARED_PARTITION。
  let partition = opts.partition || currentPartition;
  applyUA(partition);

  // v2.1.15：增强日志——记录 createAppWindow 入口
  const __isAppview = typeof url === 'string' && /\/appview(\?|$)/i.test(url);
  try {
    dlog && dlog('info', 'appwin.create.entry', {
      url: String(url).slice(0, 160),
      appview: __isAppview,
      partition: String(partition || '').slice(0, 40),
      opts: { title: opts.title || '', name: opts.name || '', appId: opts.appId || '' },
    });
  } catch (_) {}

  // v1.70.0：应用窗口打开前主动应用 URL 重写（外网端口/域名映射）。
  // 飞牛主页点击 Docker 应用时生成的地址常为"外网IP+内网端口"（如
  // http://121.40.186.165:3000/），与用户配置的内网规则（如
  // 192.168.31.101:3000 → http://121.40.186.165:10305）不完全一致，
  // 直接 loadURL 会导致重写不命中、外网端口打不开。这里统一先过一遍
  // rewriteUrl（含端口映射场景），并记录重写前后地址，便于日志排查。
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    try {
      const mapped = rewriteUrl(url);
      if (mapped && mapped !== url) {
        dlog && dlog('info', 'appwin.rewrite', {
          from: String(url).slice(0, 120),
          to: String(mapped).slice(0, 120),
        });
        url = mapped;
      }
    } catch (_) {}
  }

  // v1.66.0：应用窗口打开前预预热（DNS 预解析 + 预连接），显著缩短应用首屏加载——
  // 用户点开应用时 DNS/TLS 建连已在后台完成，避免首次访问"转圈"。
  // v2.1.15：appview URL 与主窗口同 origin，DNS/连接已建立，跳过预连接减少开销
  try {
    if (typeof url === 'string' && /^https?:\/\//i.test(url) && !/\/appview(\?|$)/i.test(url)) {
      const warmSession = (partition && partition !== 'default') ? session.fromPartition(partition) : session.defaultSession;
      const __preconnT0 = Date.now();
      try { warmSession.dns.resolveHost(new URL(url).hostname, () => {}); } catch (_) {}
      setTimeout(() => { try { warmSession.net?.preconnect?.(new URL(url).origin); } catch (_) {} }, 0);
      setTimeout(() => { try { warmSession.net?.preconnect?.(new URL(url).origin); } catch (_) {} }, 400);
      try { dlog && dlog('info', 'appwin.preconnect', { origin: new URL(url).origin, elapsedMs: Date.now() - __preconnT0 }); } catch (_) {}
    } else if (typeof url === 'string' && /\/appview(\?|$)/i.test(url)) {
      try { dlog && dlog('info', 'appwin.preconnect.skip', { reason: 'appview same-origin', url: String(url).slice(0, 120) }); } catch (_) {}
    }
  } catch (_) {}

  const win = new BrowserWindow({
    width: opts.width || 1280,
    height: opts.height || 820,
    minWidth: 900,
    minHeight: 600,
    title: opts.title || APP_NAME,
    backgroundColor: cachedSettings.themeColor || '#0b0d12',
    show: false,
    autoHideMenuBar: true,
    // v1.53.0：Windows 上 frame:false 即彻底无边框；【切勿】再加 titleBarStyle:'hidden' +
    //   titleBarOverlay——overlay 在 Windows 会重新绘制系统原生窗口按钮(右上角 - □ ✕)，
    //   自定义标题栏盖不住，表现为"标题栏不统一/仍是系统按钮"。
    frame: false,
    // v2.0.6：优先使用 manifest 中存储的应用图标，避免初始显示主图标
    icon: (() => {
      try {
        const manifest = readManifest();
        if (manifest && Array.isArray(manifest.apps)) {
          const urlObj = typeof url === 'string' ? new URL(url) : null;
          const matched = manifest.apps.find(a => {
            if (!a.nasAddress || !urlObj) return false;
            try {
              const aUrl = new URL(a.nasAddress);
              return aUrl.origin === urlObj.origin;
            } catch { return false; }
          });
          if (matched && matched.iconPath && fs.existsSync(matched.iconPath)) {
            return matched.iconPath;
          }
        }
      } catch (_) {}
      return ICON_PATH;
    })(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, webviewTag: true,
      nodeIntegration: false,
      sandbox: false, // v1.56：preload 需 require 本地 titlebar-inject，必须关闭沙箱
      webSecurity: true,
      allowRunningInsecureContent: true,
      spellcheck: false,
      backgroundThrottling: false,
      partition,
      // v2.4.9（反馈 8 两种窗口模式自动适配）：内嵌窗形态宿主窗标记——titlebar-inject 据此
      // 渲染 fnOS 内嵌窗样式标题栏（logo+标题+↻↗—□✕），区别于普通跳出窗的 ☰+系统钮样式。
      additionalArguments: opts.embedStyle ? ['--fnos-embed-style'] : [],
      enableBlinkFeatures: 'CSSBackdropFilter',
      v8CacheOptions: 'bypassHeatCheckAndEagerCompile',
      // v1.76.0：应用窗口禁用硬件加速（软件渲染）。修复部分 Docker 应用
      // （影视/音乐等）在 Windows 上触发 GPU 进程崩溃，导致窗口创建即崩、
      // 后续所有应用窗口连锁打不开（render-process-gone crashed 0x80000003）。
      // 主窗口/主页仍保留硬件加速；视频播放走 MPV 外部播放器不受影响。
      disableHardwareAcceleration: true,
    },
  });

  // v1.48.0：无边框窗口，无系统菜单栏；菜单功能改由自定义标题栏「☰ 菜单」按钮弹出。
  try { win.setMenuBarVisibility(false); } catch (_) {}

  // v2.0.0：为每个子应用窗口设置独立 AppUserModelId，避免 Windows 任务栏图标合并/空白
  try {
    const appId = opts.appId || (() => {
      try {
        const u = new URL(url);
        return (u.hostname + u.pathname).replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
      } catch { return 'unknown'; }
    })();
    win.setAppUserModelId(`com.fnos.client.app.${appId}`);
  } catch (_) {}

  // v2.2.4：记录窗口创建时间，供 render-process-gone 判断"创建即崩"（load.start 后 ~50ms 崩）
  try { win.__appCreatedAt = Date.now(); } catch (_) {}

  // v2.2.5：撤销 v2.2.4 的 XTE 跳过标题栏注入——
  // 实测 XTE 并无自带标题栏，跳过注入后整个窗口没有标题栏（用户反馈"标题栏不见了"），
  // 因此 XTE 与普通应用一样注入自定义标题栏。保留 __skipTitlebar 标志位机制供未来使用，
  // 但默认不再为 XTE 设置跳过。若未来某应用确有自带标题栏，可在下方按 URL 特征显式设置。

  const isHome = !!opts.isHome;
  registerWindow(win, {
    url, title: opts.title || APP_NAME, isMain: isHome, isHome, partition,
  });

  // v1.48.0：应用窗口完整启动/加载/运行链路日志（便于分析 FNDESK 等大型应用卡顿）
  const __appLabel = (opts.title || APP_NAME);
  // v2.1.19: 从 URL 反推 FPK 应用名（如 /music → trim.music），延迟到图标应用时解析，
  // 避免 FPK 应用列表尚未加载时 appname 被固定为空导致图标查询失败
  // v2.2.5: 增强——anchor 截断兜底：FPK 列表已加载时，对未命中的候选名做
  // 前缀/去点归一化模糊匹配（如 trim.resource-mana → trim.resource-manager、
  // trim.backup-and-sy → trim.backup-and-sync），确保任务栏/快捷方式图标命中 FPK 高清图标。
  const __resolveAppName = () => {
    try {
      // v2.3.0: appname 语义修正——appId/name 才可能是飞牛 appname，
      // title 是窗口显示名（如"系统设置"），用它兜底会得到显示名导致图标 404
      let candidate = '';
      if (opts.appId) {
        candidate = /^https?:/i.test(opts.appId) ? (fpkAppNameFromUrl(opts.appId) || '') : String(opts.appId);
      } else if (opts.name) {
        candidate = String(opts.name);
      } else {
        candidate = fpkAppNameFromUrl(url) || '';
      }
      if (!candidate) return '';
      // FPK 列表模糊匹配：精确 > 前缀（截断 anchor）> 去点归一化
      try {
        if (__fpkApps.length) {
          const cLower = String(candidate).toLowerCase();
          for (const a of __fpkApps) {
            const n = String((a && a.name) || '');
            if (n && n.toLowerCase() === cLower) return n;
          }
          // 前缀匹配（anchor 被截断：trim.resource-mana 缺 "ger"）
          for (const a of __fpkApps) {
            const n = String((a && a.name) || '');
            if (n && cLower.length >= 4 && n.toLowerCase().startsWith(cLower)) {
              dlog && dlog('info', 'appwin.resolve-name.prefix', { app: __appLabel, candidate, matched: n });
              return n;
            }
          }
          // 反向前缀（FPK name 是候选名的前缀）
          for (const a of __fpkApps) {
            const n = String((a && a.name) || '');
            if (n && n.toLowerCase().length >= 4 && cLower.startsWith(n.toLowerCase())) {
              dlog && dlog('info', 'appwin.resolve-name.reverse-prefix', { app: __appLabel, candidate, matched: n });
              return n;
            }
          }
          // 去点归一化（trim.file-manager.trash ↔ trim.filemanager.trash）
          const cNorm = cLower.replace(/[-_.]/g, '');
          for (const a of __fpkApps) {
            const n = String((a && a.name) || '');
            if (n && n.toLowerCase().replace(/[-_.]/g, '') === cNorm) {
              dlog && dlog('info', 'appwin.resolve-name.norm', { app: __appLabel, candidate, matched: n });
              return n;
            }
          }
        }
      } catch (_) {}
      return candidate;
    } catch (_) { return ''; }
  };
  const __appName = __resolveAppName();
  const __t0 = Date.now();
  dlog && dlog('info', 'appwin.create', { app: __appLabel, winId: win.id, url: String(url || '').slice(0, 120) });
  try {
    win.webContents.on('did-start-loading', () => {
      try {
        const __prevNavStart = win.__appNavStart || 0;
        win.__appNavStart = Date.now();
        const __curUrl = String(win.webContents.getURL()).slice(0, 160);
        const __isAppview = /\/appview(\?|$)/i.test(__curUrl);
        // v2.1.15：appview SPA 内部路由（anchor 解析后的 hash/pushState 导航）会触发
        // did-start-loading，但不需要等待 did-finish-load。检测到二次导航时不重置 pending 状态，
        // 避免 dom-ready 已标记完成后又被覆盖为 true 导致 30s 超时误报。
        const __isSpaReNav = __isAppview && __prevNavStart > 0 && (Date.now() - __prevNavStart) < 5000;
        if (!__isSpaReNav) {
          win.__appResPending = true;
        }
        dlog && dlog('info', 'appwin.load.start', { app: __appLabel, winId: win.id, url: __curUrl, appview: __isAppview, spaReNav: __isSpaReNav, pending: win.__appResPending });
      } catch (_) {}
    });
    win.webContents.on('dom-ready', () => {
      const __navMs = Date.now() - (win.__appNavStart || __t0);
      const __curUrl = (() => { try { return String(win.webContents.getURL()).slice(0, 160); } catch (_) { return ''; } })();
      const __isAppview = /\/appview(\?|$)/i.test(__curUrl);
      try { dlog && dlog('info', 'appwin.dom-ready', { app: __appLabel, winId: win.id, ms: __navMs, totalMs: Date.now() - __t0, appview: __isAppview, url: __curUrl }); } catch (_) {}
      // v2.1.15：appview 是 SPA，内部路由会触发 did-start-loading 但不会再触发 did-finish-load
      // 在 dom-ready 时标记加载完成，避免 30s 超时误报
      if (__isAppview && win.__appResPending !== false) {
        try { win.__appResPending = false; dlog && dlog('info', 'appwin.appview.dom-ready.done', { app: __appLabel, winId: win.id, ms: __navMs }); } catch (_) {}
      }
      // v2.0.0：修复子应用窗口输入框无法输入——延迟强制 webContents 聚焦，避免窗口焦点被抢占
      try { setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.focus(); }, 150); } catch (_) {}
      // v2.0.5：CSS 注入范围限定——只对客户端自身页面（file:// 协议的 login.html/lock.html/settings.html）
    // 注入 APP_UI_INJECT_CSS，不对 NAS 应用页面（http/https）注入，避免破坏 NAS 应用的原始 UI。
    try {
        if (win.webContents && !win.webContents.isDestroyed()) {
          const pageUrl = win.webContents.getURL();
          if (pageUrl && pageUrl.startsWith('file://')) {
            win.webContents.insertCSS(APP_UI_INJECT_CSS).catch(() => {});
          }
        }
      } catch (_) {}
    });
    win.webContents.on('did-finish-load', () => {
      try {
        win.__appResPending = false;
        dlog && dlog('info', 'appwin.load.done', { app: __appLabel, winId: win.id, totalMs: Date.now() - __t0, ms: Date.now() - (win.__appNavStart || __t0) });
      } catch (_) {}
      // v2.0.7：注入 CSS 隐藏 NAS 页面的「连接已断开」弹窗（外网抖动时避免打扰用户）
      try {
        win.webContents.insertCSS(`
.f-error, .connection-error, .network-error, .offline-notice, .disconnect-notice,
[class*="offline"], [class*="disconnect"], [class*="connection-lost"], [class*="network-error"],
.toast-error, .el-message--error, .ant-message-error { display: none !important; visibility: hidden !important; }
`).catch(() => {});
      } catch (_) {}

      // v2.0.6：增强版任务栏图标提取
      //   1) 收集页面所有 favicon 候选（icon/apple-touch-icon/shortcut icon），排除 SVG
      //   2) data URL 区分 SVG/PNG：SVG 跳过，PNG 直接使用
      //   3) HTTP 图标先检查 Content-Type，SVG 跳过尝试下一个候选
      //   4) 三阶段重试：立即 + 1.5s + 4s（覆盖 SPA 动态注入 favicon 的场景）
      //   5) 移除 __appIconSet 守卫，允许 favicon 覆盖扫描结果（页面 favicon 更准确）
      const __allIconCandidates = () => {
        return win.webContents.executeJavaScript(`(function(){
          try {
            var candidates = [];
            var seen = {};
            var addCandidate = function(href, isSvg) {
              if (!href || seen[href]) return;
              seen[href] = true;
              candidates.push({ href: href, isSvg: !!isSvg });
            };
            var allLinks = document.querySelectorAll('link[rel]');
            for (var i = 0; i < allLinks.length; i++) {
              var lnk = allLinks[i];
              var rel = (lnk.getAttribute('rel') || '').toLowerCase();
              if (rel.indexOf('icon') === -1) continue;
              var href = lnk.href || lnk.getAttribute('href') || '';
              var type = (lnk.getAttribute('type') || '').toLowerCase();
              var isSvg = type === 'image/svg+xml' || type === 'image/svg' || /\.svg($|[?#])/i.test(href);
              if (href) addCandidate(href, isSvg);
            }
            if (!candidates.length) {
              try { addCandidate(location.origin + '/favicon.ico', false); } catch(_) {}
            }
            // v2.0.7：同时收集 SVG 候选作为备用
            if (!candidates.some(function(c){ return !c.isSvg; })) {
              for (var j = 0; j < allLinks.length; j++) {
                var lnk2 = allLinks[j];
                var rel2 = (lnk2.getAttribute('rel') || '').toLowerCase();
                if (rel2.indexOf('icon') === -1) continue;
                var href2 = lnk2.href || lnk2.getAttribute('href') || '';
                if (href2 && !seen[href2]) { seen[href2] = true; candidates.push({ href: href2, isSvg: true }); }
              }
            }
            return candidates;
          } catch (e) { return []; }
        })()`, true);
      };

      const __trySetIconFromBuffer = (buf, url) => {
        try {
          if (win.isDestroyed()) return false;
          const img = nativeImage.createFromBuffer(Buffer.from(buf));
          if (!img.isEmpty()) {
            win.setIcon(img);
            dlog && dlog('info', 'appwin.favicon.set', { app: __appLabel, winId: win.id, url: String(url || '').slice(0, 120) });
            return true;
          }
        } catch (_) {}
        return false;
      };

      const __applyAppIcon = () => {
        try {
          if (win.isDestroyed() || !win.webContents) return;
          // v2.1.18: FPK 图标优先（应用专属图标），失败再走 favicon 候选
          (async () => {
            let __fpkInList = false;
            try {
              await refreshFpkApps(false);
              const __fpkName = __resolveAppName();
              // v2.3.0: appname 解析为空时跳过 FPK 图标请求，
              // 不再用窗口名（FNOS）兜底导致 /api/icons/FNOS/256 必然 404
              if (__fpkName) {
                // v2.2.6: 任务栏图标以 FPK 图标管理器为准（用户要求"只能调用 FPK 对应应用图标"）。
                // 判断该应用是否在 FPK 列表（区分"FPK 有它但请求失败"与"FPK 根本没有它"）。
                __fpkInList = (__fpkApps || []).some((a) => a && a.name && String(a.name).toLowerCase() === String(__fpkName).toLowerCase());
                if (!__fpkInList) {
                  // v2.3.0: 应用不在 FPK 列表 -> 任务栏保持默认图标，不 fallback 页面 favicon
                  dlog && dlog('info', 'appwin.icon.fpk-skip', { app: __appLabel, winId: win.id, url: String(url || '').slice(0, 120), reason: 'not-in-list', name: __fpkName });
                  return;
                }
                // v2.3.2: 移除系统应用直连 NAS 官方 webui 图标分支（原 v2.3.0 逻辑）。
                // 用户明确要求"任务栏图标只能调用 FPK 图标管理器的对应应用图标"。
                // fntb v2.18.2 探测 NAS webui 成功后 /api/icons/{app}/256 对系统应用
                // 自动 302 官方图标，fetchFpkIcon 跟随重定向拿到官方图标，来源始终是 FPK。
                let fpkBuf = await fetchFpkIcon(__fpkName, 256);
                if (fpkBuf && !win.isDestroyed()) {
                  const img = nativeImage.createFromBuffer(fpkBuf);
                  if (!img.isEmpty()) {
                    win.setIcon(img);
                    win.__appFpkIcon = true;
                    dlog && dlog('info', 'appwin.icon.fpk', { app: __appLabel, name: __fpkName, winId: win.id, inList: __fpkInList });
                    return;
                  }
                }
                // v2.2.5: FPK 图标获取失败日志（便于排查任务栏图标缺失）
                dlog && dlog('warn', 'appwin.icon.fpk-empty', { app: __appLabel, name: __fpkName, winId: win.id, bufLen: fpkBuf ? fpkBuf.length : 0, inList: __fpkInList });
                // v2.3.6（用户要求"任务栏图标只能调用 FPK 图标管理器的对应应用图标"）：
                // FPK 图标获取失败时彻底禁用页面 favicon 降级（favicon 是 fnOS 默认图标，
                // 会覆盖 FPK 语义）；保持缓存图标/默认图标，由 1.5s/4s 重试再取 FPK 图标。
                dlog && dlog('warn', 'appwin.icon.fpk-miss', { app: __appLabel, name: __fpkName, winId: win.id, inList: __fpkInList });
                return;
              } else {
                dlog && dlog('info', 'appwin.icon.fpk-skip', { app: __appLabel, winId: win.id, url: String(url || '').slice(0, 120), reason: 'no-fpk-name' });
                // v2.3.0: 解析不到 FPK 应用名 -> 保持默认图标，不 fallback 页面 favicon
                return;
              }
            } catch (_) {
              // v2.3.0: FPK 子系统异常（列表加载失败等）-> 保持默认图标，不 fallback 页面 favicon
              dlog && dlog('warn', 'appwin.icon.fpk-skip', { app: __appLabel, winId: win.id, url: String(url || '').slice(0, 120), reason: 'fpk-error' });
              return;
            }
            // v2.2.6: 已设置 FPK 图标后不再用 favicon 覆盖（任务栏图标以 FPK 为准）
            if (win.__appFpkIcon === true) return;
          __allIconCandidates().then((candidates) => {
            try {
              if (!Array.isArray(candidates) || !candidates.length || win.isDestroyed()) return;
              const ses = win.webContents ? win.webContents.session : null;
              const tryNext = (idx) => {
                if (win.isDestroyed()) return;
                if (idx >= candidates.length) {
                  // v2.1.17: 所有 favicon 候选失败，尝试 FPK API 图标作为兜底
                  (async () => {
                    try {
                      const __fpkName = __resolveAppName();
                      if (__fpkName) {
                        const fpkBuf = await fetchFpkIcon(__fpkName, 256);
                        if (fpkBuf && !win.isDestroyed()) {
                          const img = nativeImage.createFromBuffer(fpkBuf);
                          if (!img.isEmpty()) {
                            win.setIcon(img);
                            dlog && dlog('info', 'appwin.favicon.fpk', { app: __appLabel, winId: win.id });
                          }
                        }
                      }
                    } catch (_) {}
                  })();
                  return;
                }
                const c = candidates[idx];
                const iconRef = typeof c === 'string' ? c : c.href;
                const isSvg = typeof c === 'object' && c.isSvg;
                if (/^data:image\//i.test(iconRef)) {
                  if (/^data:image\/svg/i.test(iconRef) || isSvg) {
                    // SVG data URL，通过隐藏窗口转 PNG
                    ipcRenderer.invoke('app:convert-svg-icon', { svgDataUrl: iconRef, appId: __appLabel.replace(/[^a-zA-Z0-9_-]/g, '_'), size: 128 }).then((result) => {
                      if (result && result.success && result.data && result.data.iconPath && fs.existsSync(result.data.iconPath)) {
                        try {
                          const img = nativeImage.createFromPath(result.data.iconPath);
                          if (!img.isEmpty()) { win.setIcon(img); dlog && dlog('info', 'appwin.favicon.set', { app: __appLabel, winId: win.id, svg: 1 }); return; }
                        } catch (_) {}
                      }
                      tryNext(idx + 1);
                    }).catch(() => tryNext(idx + 1));
                  } else {
                    try {
                      const img = nativeImage.createFromDataURL(iconRef);
                      if (!img.isEmpty()) {
                        win.setIcon(img);
                        dlog && dlog('info', 'appwin.favicon.set', { app: __appLabel, winId: win.id, data: 1 });
                        return;
                      }
                    } catch (_) {}
                    tryNext(idx + 1);
                  }
                  return;
                }
                if (!/^https?:/i.test(iconRef) || !ses) { tryNext(idx + 1); return; }
                ses.fetch(iconRef, { credentials: 'include' }).then((res) => {
                  if (!res.ok) throw new Error('bad status ' + res.status);
                  const ct = (res.headers.get('content-type') || '').toLowerCase();
                  if (ct.includes('svg') || isSvg) {
                    return res.text().then((svgText) => {
                      return __svgToPng(svgText, 128).then((pngBuf) => {
                        if (pngBuf) {
                          const iconPath = path.join(ASSETS_DIR, (__appLabel || 'app').replace(/[^a-zA-Z0-9_-]/g, '_') + '.png');
                          try { fs.writeFileSync(iconPath, Buffer.from(pngBuf)); } catch (_) {}
                          const img = nativeImage.createFromBuffer(Buffer.from(pngBuf));
                          if (!img.isEmpty()) { win.setIcon(img); dlog && dlog('info', 'appwin.favicon.set', { app: __appLabel, winId: win.id, svg: 1 }); return; }
                        }
                        tryNext(idx + 1);
                      });
                    });
                  }
                  return res.arrayBuffer();
                }).then((buf) => {
                  if (!buf) return;
                  if (!__trySetIconFromBuffer(buf, iconRef)) {
                    tryNext(idx + 1);
                  }
                }).catch(() => { tryNext(idx + 1); });
              };
              tryNext(0);
            } catch (_) {}
          }).catch(() => {});
          })();
        } catch (_) {}
      };
      __applyAppIcon();
      setTimeout(() => { try { __applyAppIcon(); } catch (_) {} }, 1500);
      setTimeout(() => { try { __applyAppIcon(); } catch (_) {} }, 4000);
    });
    win.webContents.on('unresponsive', () => {
      try { dlog && dlog('warn', 'appwin.unresponsive', { app: __appLabel, winId: win.id, ms: Date.now() - __t0 }); } catch (_) {}
    });
    win.webContents.on('responsive', () => {
      try { dlog && dlog('info', 'appwin.responsive', { app: __appLabel, winId: win.id }); } catch (_) {}
    });
    win.webContents.on('render-process-gone', (_e, detail) => {
      try {
        const reason = detail && detail.reason;
        const exitCode = detail && detail.exitCode;
        // v2.2.3：补充 exitCode 与"创建后多久崩"（判断是否创建即崩）。
        // 日志 34500 XTE/music 窗口 load.start 后 ~50ms 即崩 exitCode=0x80000003，
        // 属 GPU 进程崩溃连锁（v1.76.0 webPreferences.disableHardwareAcceleration 无效，
        // 已改全局 app.disableHardwareAcceleration，见文件头 v2.2.3 注释）。
        const __bornMs = Date.now() - (win.__appCreatedAt || win.__t0 || Date.now());
        dlog && dlog('error', 'appwin.render-gone', { app: __appLabel, winId: win.id, reason, exitCode, bornMs: __bornMs });
        // v1.76.0：渲染进程崩溃自动恢复（最多 2 次），避免应用窗口直接消失
        // v2.2.4：恢复次数 2→5 次 + 指数退避（800/1400/2200/3200/4400ms）；
        // "创建即崩"（bornMs<1000）先等待更长延迟（渲染/GPU 资源可能仍异常），
        // 并抑制短时间连续崩溃的窗口叠加创建（30s 内 >=5 次崩溃时不再立即恢复）。
        if (reason === 'crashed' && win && !win.isDestroyed()) {
          const tries = (win.__appCrashTries || 0) + 1;
          win.__appCrashTries = tries;
          // 全局连续崩溃计数
          const now = Date.now();
          if (!global.__appCrashSeriesStart) global.__appCrashSeriesStart = now;
          if (now - global.__appCrashSeriesStart > 30000) { global.__appCrashSeriesStart = now; global.__appCrashSeriesCount = 0; }
          global.__appCrashSeriesCount = (global.__appCrashSeriesCount || 0) + 1;
          const crashStorm = global.__appCrashSeriesCount >= 5;
          if (tries <= 5 && !crashStorm) {
            const delays = [800, 1400, 2200, 3200, 4400];
            let delayMs = delays[Math.min(tries - 1, delays.length - 1)] || 800;
            // 创建即崩：额外 +1000ms 等待 GPU/渲染资源稳定
            if (__bornMs < 1000) delayMs += 1000;
            dlog && dlog('info', 'appwin.render-restart', { app: __appLabel, winId: win.id, try: tries, exitCode, bornMs: __bornMs, delayMs, seriesCount: global.__appCrashSeriesCount });
            setTimeout(() => {
              try {
                if (win.isDestroyed()) return;
                const cur = win.webContents.getURL();
                if (cur && /^https?:/i.test(cur)) win.loadURL(cur, { userAgent: getNasUA() }).catch(() => {});
                else win.reloadIgnoringCache();
              } catch (_) {}
            }, delayMs);
          } else {
            // v2.2.3：恢复耗尽或崩溃风暴——记录最终放弃，避免窗口黑屏悬挂无日志
            dlog && dlog('error', 'appwin.render-gone.giveup', { app: __appLabel, winId: win.id, try: tries, reason, exitCode, crashStorm });
          }
        }
      } catch (_) {}
    });
    // v1.70.0：应用运行日志增强——
    //   1) console error 节流采样（每窗口每 10s 至多 1 条），便于捕获 Docker 应用内 JS 报错；
    //   2) 主框架加载超时（30s 未完成）告警，用于定位"应用转圈/打不开"；
    //   3) did-fail-load 重试耗尽后的最终失败记录。
    try {
      win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        try {
          if (level >= 3) {
            const now = Date.now();
            if (!win.__appConsoleErrTs || now - win.__appConsoleErrTs > 10000) {
              win.__appConsoleErrTs = now;
              dlog && dlog('error', 'appwin.console-error', {
                app: __appLabel, winId: win.id,
                msg: String(message || '').slice(0, 160),
                line, src: String(sourceId || '').slice(0, 80),
              });
            }
          }
        } catch (_) {}
      });
    } catch (_) {}
    try {
      setTimeout(() => {
        try {
          if (win.isDestroyed()) return;
          if (win.__appResPending !== false) {
            dlog && dlog('warn', 'appwin.load.timeout', {
              app: __appLabel, winId: win.id, ms: 30000,
              url: String(win.webContents.getURL()).slice(0, 120),
            });
          }
        } catch (_) {}
      }, 30000);
      win.__appResPending = true;
    } catch (_) {}
    win.once('ready-to-show', () => {
      try { dlog && dlog('info', 'appwin.ready-show', { app: __appLabel, winId: win.id, totalMs: Date.now() - __t0 }); } catch (_) {}
    });
  } catch (_) {}

  // v1.74.0：应用窗口打开时，URL 匹配已扫描应用 → 立即设置初始标题（不依赖页面 favicon）。
  // v2.4.0（需求第一部分-1）：禁止本地缓存 FPK/NAS 图标资源——移除 app-icons/{hash}.png
  // 磁盘缓存读取（appwin.icon-cache 路径）；任务栏窗口图标一律由下方 FPK 实时拉取链路
  // （refreshFpkApps → fetchFpkIcon → win.setIcon）设置，修改图标后无需重启即生效。
  try {
    const __s = loadSettings();
    const __apps = Array.isArray(__s.apps) ? __s.apps : [];
    if (__apps.length && typeof url === 'string' && /^https?:/i.test(url)) {
      const norm = String(url).split('?')[0].split('#')[0];
      const hit = __apps.find((a) => a && a.url && (
        String(a.url).split('?')[0] === norm ||
        String(a.url).split('?')[0].startsWith(norm) ||
        norm.startsWith(String(a.url).split('?')[0])
      ));
      if (hit) {
        try { if (hit.name && !opts.title) win.setTitle(String(hit.name).slice(0, 40)); } catch (_) {}
        win.__appMeta = hit;
        try { dlog && dlog('info', 'appwin.icon', { app: String(hit.name).slice(0, 40), winId: win.id, cacheUsed: false }); } catch (_) {}
      }
    }
    // v2.2.5：异步立即尝试 FPK 高清图标（不等 did-finish-load），确保任务栏尽快用 FPK 图标
    try {
      (async () => {
        try {
          await refreshFpkApps(false);
          const __f2 = __resolveAppName();
          if (__f2) {
            const __b2 = await fetchFpkIcon(__f2, 256);
            if (__b2 && __b2.length > 100 && win && !win.isDestroyed()) {
              const __img2 = nativeImage.createFromBuffer(__b2);
              if (!__img2.isEmpty()) {
                win.setIcon(__img2);
                win.__appIconSet = true;
                win.__appFpkIcon = true;
                dlog && dlog('info', 'appwin.icon.fpk-early', { app: __appLabel, name: __f2, winId: win.id, size: __b2.length });
              }
            }
          }
        } catch (_) {}
      })();
    } catch (_) {}
  } catch (_) {}

  if (url) {
    if (/^https?:/i.test(url)) {
      // v2.1.15：增强日志——记录 loadURL 时机
      try {
        dlog && dlog('info', 'appwin.loadURL', {
          app: __appLabel,
          url: String(url).slice(0, 160),
          elapsedMs: Date.now() - __cw_t0,
        });
      } catch (_) {}

      // v2.1.16：非 appview 应用预认证优化——
      // 非 appview 应用（如影视、音乐等）首次打开需要 OAuth 认证链（/v → /v/login → /signin → /v/oauth/result → /v），
      // 整个过程约 15 秒。如果在可见窗口中执行，用户会看到多次重定向页面，体验很差。
      // 优化方案：在隐藏窗口中先完成 OAuth（cookies 存入共享 partition），
      // 然后在可见窗口中加载 URL（此时已有认证 cookies，直接显示最终页面，约 1-2 秒）。
      // v2.1.17：外部应用（非 fnOS 主站 URL）跳过 PreAuth——
      // 外部应用不走 fnOS OAuth 流程，PreAuth 必然超时浪费 8 秒。
      // 判断方式：URL origin 与 NAS 主站 origin 不同即为外部应用。
      let __isExternalApp = false;
      try {
        const __urlOrigin = new URL(url).origin;
        const __nasOrigin = currentOrigin || (function() { try { return loadSettings().origin || ''; } catch(_) { return ''; } })();
        // v2.2.3：FNID 生态域排除——*.fnos.net（FN Connect 隧道域，如 dashuaibi888.fnos.net）
        // 与 fnos.net 检测页同属飞牛生态，不应按 origin 不同判为 external-app（否则走
        // createAppWindow 独立窗口 + 302 回检测页形成循环，FNID 登录后无法进入主页）。
        const __urlHost = String(__urlOrigin || '').toLowerCase();
        const __isFnosDomain = __urlHost === 'https://fnos.net' || __urlHost.endsWith('.fnos.net');
        if (__nasOrigin && __urlOrigin !== __nasOrigin && !__isFnosDomain) {
          __isExternalApp = true;
          try { dlog && dlog('info', 'appwin.preauth.skip', { app: __appLabel, reason: 'external-app', urlOrigin: __urlOrigin, nasOrigin: __nasOrigin }); } catch (_) {}
        }
      } catch (_) {}
      // v2.2.2：主窗口已登录（当前 URL 已是主页而非 /login）时跳过 PreAuth——
      // 认证 cookie 已在共享 partition 中，直接 load 应用 URL 即可进入，
      // 无需再跑一遍 OAuth（否则已登录用户打开影视/音乐等非 appview 应用仍会
      // 白等 3 秒 force-login + 8 秒超时，表现为快捷方式/应用打开非常慢）。
      let __alreadyLoggedIn = false;
      try {
        const __mainUrl = (mainWindow && !mainWindow.isDestroyed()) ? (mainWindow.webContents.getURL() || '') : '';
        const __mp = String(__mainUrl).toLowerCase();
        __alreadyLoggedIn = /^https?:/i.test(__mp) && __mp.indexOf('/login') !== 0 && !/\/login([\/?#]|$)/.test(__mp);
        if (__alreadyLoggedIn) {
          dlog && dlog('info', 'appwin.preauth.skip', { app: __appLabel, reason: 'already-logged-in', mainUrl: String(__mainUrl).slice(0, 100) });
        }
      } catch (_) {}

      let __shouldPreAuth = !__isAppview && !__isExternalApp && !__alreadyLoggedIn && typeof url === 'string';
      // v2.1.17: 检查 PreAuth 缓存
      try {
        if (__shouldPreAuth) {
          const __cachedOrigin = new URL(url).origin;
          const __cached = __preAuthCache.get(__cachedOrigin);
          if (__cached && (Date.now() - __cached.ts < PREAUTH_CACHE_TTL)) {
            __shouldPreAuth = false;
            dlog && dlog('info', 'appwin.preauth.cache-hit', {
              app: __appLabel,
              origin: __cachedOrigin,
              cachedAt: new Date(__cached.ts).toISOString(),
              navSteps: __cached.navSteps,
            });
          }
        }
      } catch (_) {}
      if (__shouldPreAuth) {
        try {
          const __preAuthT0 = Date.now();
          dlog && dlog('info', 'appwin.preauth.start', { app: __appLabel, url: String(url).slice(0, 120) });

          // 创建隐藏预认证窗口（共享同一 partition，cookies 互通）
          const __preAuthWin = new BrowserWindow({
            show: false,
            width: 800,
            height: 600,
            webPreferences: {
              preload: path.join(__dirname, 'preload.js'),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
              webSecurity: true,
              allowRunningInsecureContent: true,
              spellcheck: false,
              backgroundThrottling: false,
              partition,
            },
          });

          let __preAuthDone = false;
          let __preAuthNavCount = 0;
          let __lastPreAuthUrl = '';

          // 监听隐藏窗口的导航，跟踪 OAuth 流程进度
          __preAuthWin.webContents.on('did-navigate', (_e, navUrl) => {
            __preAuthNavCount++;
            __lastPreAuthUrl = String(navUrl);
            try {
              dlog && dlog('info', 'appwin.preauth.navigate', {
                app: __appLabel,
                step: __preAuthNavCount,
                url: __lastPreAuthUrl.slice(0, 120),
                elapsedMs: Date.now() - __preAuthT0,
              });
            } catch (_) {}
          });

          // 检测 OAuth 完成：URL 回到原始应用路径（不再重定向到 login/oauth/signin）
          __preAuthWin.webContents.on('did-finish-load', () => {
            try {
              const curUrl = __preAuthWin.webContents.getURL();
              const urlObj = new URL(url);
              const curObj = new URL(curUrl);
              // 检查条件：
              // 1. 同源
              // 2. pathname 匹配目标应用路径（精确匹配或在目标路径下）
              // 3. URL 不包含 OAuth 相关路径段
              const isOAuthDone = curObj.origin === urlObj.origin &&
                (curObj.pathname === urlObj.pathname || curObj.pathname.startsWith(urlObj.pathname.replace(/\/$/, '') + '/')) &&
                !curObj.pathname.includes('/login') &&
                !curObj.pathname.includes('/oauth') &&
                !curObj.pathname.includes('/signin') &&
                __preAuthNavCount >= 2; // 至少经历了 2 次导航（初始 + 至少一次重定向）

              if (isOAuthDone && !__preAuthDone) {
                __preAuthDone = true;
                dlog && dlog('info', 'appwin.preauth.done', {
                  app: __appLabel,
                  finalUrl: String(curUrl).slice(0, 120),
                  elapsedMs: Date.now() - __preAuthT0,
                  navSteps: __preAuthNavCount,
                });
                // v2.1.17: 写入 PreAuth 缓存
                try {
                  const __cacheOrigin = new URL(url).origin;
                  __preAuthCache.set(__cacheOrigin, { ts: Date.now(), navSteps: __preAuthNavCount });
                } catch (_) {}
                // OAuth 完成，刷新 cookie 存储后加载真实 URL
                clearTimeout(__preAuthFallbackTimer);
                const __sess = (partition && partition !== 'default') ? session.fromPartition(partition) : session.defaultSession;
                try { __sess.cookies.flushStore(() => {}); } catch (_) {}
                // 短暂延迟确保 cookies 完全写入
                setTimeout(() => __loadRealUrl(), 500);
              }
            } catch (_) {}
          });

          // 超时保护：最多等待 8 秒（v2.1.17: 从 20s 优化到 8s）
          const __preAuthTimeout = setTimeout(() => {
            clearTimeout(__preAuthFallbackTimer);
            if (!__preAuthDone) {
              __preAuthDone = true;
              dlog && dlog('warn', 'appwin.preauth.timeout', {
                app: __appLabel,
                timeoutMs: 8000,
                elapsedMs: Date.now() - __preAuthT0,
                navSteps: __preAuthNavCount,
                lastUrl: __lastPreAuthUrl.slice(0, 120),
              });
              __loadRealUrl();
            }
          }, 8000);

          // v2.1.17: 如果 3 秒内 SPA 没有重定向到登录页，强制导航到 /login
          const __preAuthFallbackTimer = setTimeout(() => {
            try {
              if (!__preAuthDone && __preAuthNavCount <= 1) {
                const __curUrl = __preAuthWin.webContents.getURL();
                const __curObj = new URL(__curUrl);
                // 如果还在应用路径下（没进入 OAuth 流程），强制跳转 /login
                if (!__curUrl.includes('/login') && !__curUrl.includes('/signin') && !__curUrl.includes('/oauth')) {
                  const __loginUrl = __curObj.origin + '/login';
                  dlog && dlog('info', 'appwin.preauth.force-login', {
                    app: __appLabel,
                    from: __curUrl.slice(0, 120),
                    to: __loginUrl,
                    elapsedMs: Date.now() - __preAuthT0,
                  });
                  __preAuthWin.loadURL(__loginUrl, { userAgent: getNasUA() }).catch(() => {});
                }
              }
            } catch (_) {}
          }, 3000);

          function __loadRealUrl() {
            clearTimeout(__preAuthTimeout);
            clearTimeout(__preAuthFallbackTimer);
            try {
              dlog && dlog('info', 'appwin.preauth.loadReal', {
                app: __appLabel,
                totalElapsedMs: Date.now() - __preAuthT0,
                totalFromEntryMs: Date.now() - __cw_t0,
              });
            } catch (_) {}
            win.loadURL(url, { userAgent: getNasUA() }).catch(() => {});
            // 延迟关闭隐藏窗口，确保 cookies 已完全写入（v2.1.17: 从 3s 优化到 1s）
            setTimeout(() => {
              try { if (!__preAuthWin.isDestroyed()) __preAuthWin.destroy(); } catch (_) {}
            }, 1000);
          }

          // 在可见窗口先显示加载提示页
          const __loadingHtml = `data:text/html;charset=utf-8,<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:%230b0d12;color:%23fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
.wrap{text-align:center}
.spinner{width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top-color:%234f8cff;border-radius:50%25;animation:spin 0.8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.text{font-size:14px;color:rgba(255,255,255,0.6);letter-spacing:0.5px}
</style></head><body>
<div class="wrap"><div class="spinner"></div><div class="text">正在连接应用…</div></div>
</body></html>`;
          win.loadURL(__loadingHtml).catch(() => {});

          // 在隐藏窗口开始 OAuth 流程
          __preAuthWin.loadURL(url, { userAgent: getNasUA() }).catch(() => {});

        } catch (err) {
          try { dlog && dlog('error', 'appwin.preauth.error', { app: __appLabel, error: String(err).slice(0, 200) }); } catch (_) {}
          // 预认证出错，直接加载真实 URL（回退到原有行为）
          win.loadURL(url, { userAgent: getNasUA() }).catch(() => {});
        }
      } else {
        // appview 应用或本地 URL，直接加载（无需预认证）
        win.loadURL(url, { userAgent: getNasUA() }).catch(() => {});
      }
    } else {
      win.loadFile(url).catch(() => {});
    }
  }

  // v1.29.2：起播/加载健壮性——
  // 1) 黑/白屏优化：ready-to-show 后再展示窗口（首帧已绘制），避免"登录后黑屏"；
  //    兜底展示从 300ms 放宽到 6s（NAS 首次响应/隧道握手较慢时也不至于先弹一个黑窗）。
  // 2) did-fail-load 自动重试：仅对主框架网络错误（-3 中止/-137 命名解析等）重试，避免偶发
  //    隧道/内网抖动导致应用区停在错误页/黑屏；子资源失败不重试，且 404/鉴权跳转不触发。
  //    v2.0.0：集成 NetworkHealth 抖动判定，瞬时失败仅日志不弹窗，重试使用指数退避。
  let _loadFailTries = 0;
  try {
    win.webContents.on('did-fail-load', (_e, errorCode, errorDesc, failUrl, isMainFrame) => {
      try {
        if (!isMainFrame) return;
        // -3 = ABORTED（我们自己 setWindowOpenHandler 取消/导航中被替换），不当错误
        if (errorCode === -3 || errorCode === 0) return;
        if (failUrl && /^file:/.test(failUrl)) return; // 本地页面失败交给各自逻辑
        // v2.0.0：记录到网络健康监控
        const isJitter = NetworkHealth.recordFailure(`appwin:${__appLabel}`, `${errorCode} ${errorDesc}`);
        if (_loadFailTries >= 4) {
          // v1.70.0：重试耗尽，记录最终失败（含错误码），便于排查外网地址/端口映射问题
          dlog && dlog('error', 'appwin.fail-load.final', {
            app: __appLabel, winId: win.id, errorCode, errorDesc,
            url: String(failUrl || '').slice(0, 120),
          });
          return;
        }
        _loadFailTries++;
        // v2.0.0：指数退避 + 抖动（1s/2s/4s/8s + 随机500ms）
        const retryDelay = Math.min(8000, 1000 * Math.pow(2, _loadFailTries - 1) + Math.random() * 500);
        dlog && dlog('warn', 'appwin.fail-load.retry', { errorCode, errorDesc, try: _loadFailTries, delay: Math.round(retryDelay), isJitter, url: String(failUrl).slice(0, 90) });
        setTimeout(() => {
          try {
            if (win.isDestroyed()) return;
            const cur = win.webContents.getURL();
            const target = (cur && /^https?:/.test(cur)) ? cur : url;
            if (/^https?:/i.test(target)) win.loadURL(target, { userAgent: getNasUA() }).catch(() => {});
          } catch (_) {}
        }, retryDelay);
      } catch (_) {}
    });
  } catch (_) {}

  win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch (_) {} });
  // 兜底：极端情况下 ready-to-show 未触发（如隧道握手卡住），6s 后也展示窗口，避免"看不见窗口"
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 6000);

  return win;
}

// ---------------------- 主窗口关闭逻辑 ----------------------
function handleMainClose(win) {
  // v2.3.3：按产品需求，点击窗口关闭 = 隐藏到托盘（不弹窗、不退出），
  // 程序继续驻留托盘；只有托盘菜单「退出」或 app.isQuitting 才真正退出。
  if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.hide(); } catch (_) {} }
  ensureTray();
}

// v2.1.10：隐藏主窗口到托盘（不销毁窗口、不销毁托盘）。
// 区别于 handleMainClose（弹窗让用户选）与 hideCompletely（连托盘一起销毁）。
// 快捷方式打开应用后调用：按用户设置（shortcutHideMode）把主程序面板退到后台——
//   'tray'（默认）：隐藏到系统托盘，点击托盘图标可恢复；
//   'minimize'：最小化到任务栏，点击任务栏图标可恢复。
function hideMainToBackground() {
  const mode = loadSettings().shortcutHideMode === 'minimize' ? 'minimize' : 'tray';
  // v2.4.0（需求第一部分-3）：窗口显隐日志
  try { require('./logger.js').log('info', 'window', 'main.hide_to_background', { params: { mode } }, __RUN_MODE); } catch (_) {}
  if (mode === 'minimize') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        // 窗口可见才最小化；已隐藏（如冷启动后台加载）则保持隐藏即可
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.minimize();
      } catch (_) { try { mainWindow.hide(); } catch (_) {} }
    }
    ensureTray();
    return;
  }
  // 默认：隐藏到托盘（不销毁窗口、不销毁托盘）——需求 2.8：禁止 destroy 主窗口实例，只能 hide
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.hide(); } catch (_) {}
  }
  ensureTray();
}
// v2.1.10 旧名保留：仅隐藏到托盘（供其他内部调用）
function hideMainToTray() { hideMainToBackground(); }

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
  // v2.4.0（需求第一部分-3）：托盘创建日志（关键节点，含图标状态参数）
  try { require('./logger.js').log('info', 'tray', 'tray created', { params: { iconEmpty: iconImage.isEmpty() } }, __RUN_MODE); } catch (_) {}
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
      // v2.1.11：minimize 模式下主窗口最小化到任务栏，点托盘也要能恢复
      if (mainWindow.isMinimized()) { try { mainWindow.restore(); } catch (_) {} }
      if (mainWindow.isVisible()) mainWindow.focus();
      else {
        mainWindow.show();
        // v2.1.13：修复从托盘恢复时黑屏——窗口 hide 后 Chromium 可能清除渲染缓存，
        // show 后调用 invalidate 强制重绘；同时暂停后台节流确保渲染正常。
        try { mainWindow.webContents.setBackgroundThrottling(false); } catch (_) {}
        try { mainWindow.webContents.invalidate(); } catch (_) {}
        try { mainWindow.webContents.setBackgroundThrottling(true); } catch (_) {}
      }
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
      if (!mainWindow.isVisible()) {
        try { mainWindow.show(); } catch (_) {}
        // v2.1.13：修复从托盘恢复时黑屏
        try { mainWindow.webContents.invalidate(); } catch (_) {}
      }
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
  // v2.4.0（需求 2.3 / 2.8）：托盘菜单固定 2 项——【显示主界面】【退出程序】，不增加多余菜单项。
  // 原多级菜单（已打开的程序/下载/账号切换/锁定/设置）按需求"约束固定，不允许改动业务逻辑"收敛，
  // 功能入口统一收进主界面；锁定/完全隐藏状态的恢复逻辑合并进【显示主界面】（行为不变）。
  if (!tray) return;
  const items = [];
  items.push({
    label: '显示主界面',
    click: () => {
      try {
        if (isCompletelyHidden) { restoreFromCompletelyHidden(); return; }
        if (isLocked) {
          if (!lockWindow || lockWindow.isDestroyed()) createLockWindow('unlock');
          else { try { lockWindow.showInactive(); lockWindow.focus(); } catch (_) {} }
          return;
        }
        const home = appWindows.find((e) => e.isHome && e.win && !e.win.isDestroyed());
        if (home) {
          if (home.win.isMinimized()) { try { home.win.restore(); } catch (_) {} }
          if (!home.win.isVisible()) { try { home.win.show(); } catch (_) {} }
          try { home.win.focus(); home.win.moveTop(); } catch (_) {}
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) { try { mainWindow.restore(); } catch (_) {} }
          if (!mainWindow.isVisible()) { try { mainWindow.show(); } catch (_) {} }
          try { mainWindow.focus(); mainWindow.moveTop(); } catch (_) {}
        } else if (lastConnectHref) {
          connectTo(loadSettings().server || '');
        } else {
          showConnectPage();
        }
        require('./logger.js').log('info', 'tray', 'menu.show-main', {}, __RUN_MODE);
      } catch (e) {
        try { require('./logger.js').log('error', 'tray', 'menu.show-main error', { err: e }, __RUN_MODE); } catch (_) {}
      }
    },
  });
  items.push({
    label: '退出程序',
    click: () => {
      try { require('./logger.js').log('info', 'tray', 'menu.quit', {}, __RUN_MODE); } catch (_) {}
      app.isQuitting = true;
      app.quit();
    },
  });
  try { tray.setContextMenu(Menu.buildFromTemplate(items)); } catch (_) {}
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

  // v2.2.2：快捷方式冷启动且已恢复 NAS 地址时，主窗口全程保持后台（不 show），
  // 避免 createMainWindow 内部 show 与 app.whenReady 里的 hide 竞态，导致恢复黑屏/标题栏按钮失效。
  // 未登录（无 loadTarget，load 本地连接页/登录页）时仍需显示，由 did-navigate 到 https /login 兜底显示。
  const __shortcutKeepHidden = !!__pendingFromShortcut && !!(loadTarget && loadTarget.href);

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
    // v1.48.0：无边框窗口 + 注入自定义标题栏（与参考客户端 fntv 一致）。
    // 标题栏 DOM 由 preload.js 注入（可拖拽 + 最小化/最大化/关闭按钮），系统菜单栏随之移除，
    // 原"隐藏菜单栏"设置项不再需要（始终无系统菜单栏）。
    frame: false,
    autoHideMenuBar: true,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, webviewTag: true,
      nodeIntegration: false,
      sandbox: false, // v1.56：preload 需 require 本地 titlebar-inject，必须关闭沙箱
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

  // v2.4.1（用户真机反馈，覆盖 v2.4.0 恒 hide）：点击启动飞牛主程时不隐藏主窗口——
  // 只有点击应用快捷方式（--launch-app/--app/--open-app）时才隐藏；开机自启（--autostart）
  // 同样隐藏、只驻留托盘（需求 2.2：开机命令不带应用 ID，不自动打开任何应用）。
  mainWindow.once('ready-to-show', () => {
    try {
      const quiet = __isQuietStart();
      if (quiet) {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      } else {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
      }
      require('./logger.js').log('info', 'window', 'main.ready-to-show', { params: { action: quiet ? 'hide' : 'show', isLocked: !!isLocked, keepHidden: !!__shortcutKeepHidden, quiet } }, __RUN_MODE);
    } catch (_) {}
  });
  // v2.4.1：10s 显示兜底（仅普通启动场景）——防 ready-to-show 未触发黑屏；
  // 快捷方式/开机自启静默启动不兜底。
  setTimeout(() => {
    try {
      if (!__isQuietStart() && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !isLocked) mainWindow.show();
    } catch (_) {}
  }, 10000);

  // v1.29.2：主窗口主框架加载失败（隧道/内网抖动、-137 解析失败、连接重置等）自动重试，
  // 避免"登录后黑屏/错误页"。-3(中止，导航被替换)与本地连接页不重试；最多 4 次、退避。
  let _mainFailTries = 0;
  try {
    mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, failUrl, isMainFrame) => {
      try {
        if (!isMainFrame || errorCode === -3 || errorCode === 0) return;
        // v2.1.6：file:// 页面（login.html）加载失败也重试一次（便携版解压后文件可能暂时被锁定）
        if (failUrl && /^file:/.test(failUrl)) {
          if (_mainFailTries >= 1) return;
          _mainFailTries++;
          dlog && dlog('warn', 'main.fail-load.file-retry', { errorCode, errorDesc, try: _mainFailTries, url: String(failUrl).slice(0, 90) });
          setTimeout(() => {
            try {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              mainWindow.loadFile(LOGIN_PAGE).catch(() => {});
            } catch (_) {}
          }, 2000);
          return;
        }
        // v2.0.0：记录到网络健康监控
        const isJitter = NetworkHealth.recordFailure('mainwindow', `${errorCode} ${errorDesc}`);
        if (_mainFailTries >= 4) return;
        _mainFailTries++;
        // v2.0.0：指数退避 + 抖动
        const retryDelay = Math.min(8000, 1000 * Math.pow(2, _mainFailTries - 1) + Math.random() * 500);
        dlog && dlog('warn', 'main.fail-load.retry', { errorCode, errorDesc, try: _mainFailTries, delay: Math.round(retryDelay), isJitter, url: String(failUrl).slice(0, 90) });
        setTimeout(() => {
          try {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            const target = lastConnectHref || mainWindow.webContents.getURL();
            if (target && /^https?:/i.test(target)) mainWindow.loadURL(target, { userAgent: getNasUA() }).catch(() => {});
          } catch (_) {}
        }, retryDelay);
      } catch (_) {}
    });
  } catch (_) {}

  // 菜单栏自动隐藏开关
  const mainAutoHide = !!loadSettings().autoHideMenuBar;
  mainWindow.setAutoHideMenuBar(mainAutoHide);
  mainWindow.setMenuBarVisibility(!mainAutoHide);

  // v2.2.3：主窗口重建时重置崩溃恢复计数（registerWindow 内 isHome 恢复最多 2 次）
  try { mainWindow.__mainCrashTries = 0; } catch (_) {}

  registerWindow(mainWindow, {
    url: (loadTarget && loadTarget.href) || LOGIN_PAGE,
    title: APP_NAME,
    isMain: true,
    isHome: true,
    partition: currentPartition,
  });

  // v1.76.0：主页加载/导航时启动应用扫描 + 处理待打开应用（快捷方式 --open-app）。
  // 主页未登录(/login)时扫描自动跳过；用户登录跳回主页后立即扫描并打开 pending 应用。
  // v2.1.11：新增 did-finish-load 触发——只有页面完全加载（cookie/session 就绪）后才
  // 打开 pending 应用，避免冷启动时应用窗口过早请求拿到 401 跳登录页。
  try {
    mainWindow.webContents.on('dom-ready', () => {
      try { consumePendingOpenApp(); startHomeScan(); applyHomeFpkIcons(); } catch (_) {}
    });
    mainWindow.webContents.on('did-navigate', () => {
      try { consumePendingOpenApp(); startHomeScan(); tryOpenPendingApp(); applyHomeFpkIcons(); } catch (_) {}
    });
    mainWindow.webContents.on('did-navigate-in-page', () => {
      try { consumePendingOpenApp(); tryOpenPendingApp(); } catch (_) {}
    });
    mainWindow.webContents.on('did-finish-load', () => {
      try { consumePendingOpenApp(); tryOpenPendingApp(); } catch (_) {}
      // v2.2.5：FNID 检测页自动跳转（修复 v2.2.4 跳备案页问题）——
      // https://fnos.net/{fnid} 是 SPA：页面加载时只显示"正在连接..."，真实访问地址
      // 是通过 POST /api/v1/fn/con 异步获取后渲染的 a[href]。did-finish-load 时抓取
      // 只会得到 footer 备案链接（beian.miit.gov.cn / beian.gov.cn / conac.cn）。
      // 方案：轮询等待渲染完成 + 过滤备案/政务链接 + 按权重挑选真实 NAS 地址。
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const __cur = mainWindow.webContents.getURL() || '';
        // 仅处理 fnos.net/{fnid} 检测页
        const __fnidMatch = /^https:\/\/fnos\.net\/([A-Za-z0-9_-]+)\/?$/i.exec(__cur);
        if (!__fnidMatch) return;
        if (global.__fnidAutoNavDone === __cur) return; // 每个检测页 URL 只自动跳转一次
        global.__fnidAutoNavDone = __cur;
        const __fnid = __fnidMatch[1];
        dlog && dlog('info', 'fnid.detect-page', { url: __cur.slice(0, 120), fnid: __fnid });

        // 备案/政务链接黑名单：检测页 footer 固定出现的链接，绝不是 NAS 访问地址
        const __isBadLink = (u) => {
          try {
            const hn = new URL(u).hostname || '';
            return /(^|\.)beian\.miit\.gov\.cn$/i.test(hn) ||
                   /(^|\.)beian\.gov\.cn$/i.test(hn) ||
                   /(^|\.)conac\.cn$/i.test(hn) ||
                   /(^|\.)gov\.cn$/i.test(hn) ||
                   /(^|\.)12377\.cn$/i.test(hn) ||
                   /(^|\.)12321\.cn$/i.test(hn) ||
                   /(^|\.)12318\.cn$/i.test(hn) ||
                   /(^|\.)12315\.cn$/i.test(hn);
          } catch (_) { return true; }
        };
        const __extract = () => {
          return mainWindow.webContents.executeJavaScript(`(function(){
            try {
              var links = [];
              var all = document.querySelectorAll('a[href]');
              for (var i = 0; i < all.length; i++) {
                var h = all[i].getAttribute('href') || '';
                if (/^https?:/i.test(h)) links.push(h);
              }
              var seen = {}, out = [];
              for (var j = 0; j < links.length; j++) {
                if (!seen[links[j]]) { seen[links[j]] = 1; out.push(links[j]); }
              }
              return JSON.stringify(out.slice(0, 20));
            } catch (e) { return ''; }
          })()`, true);
        };
        // 按权重挑选：本 FNID 隧道域 > *.fnos.net > 公网 IP > 其他 http(s)；https 加分
        const __pickBest = (arr) => {
          let pick = '';
          let bestScore = -1;
          for (const u of arr) {
            try {
              if (__isBadLink(u)) continue;
              const h = new URL(u).hostname || '';
              let score = 0;
              if (h === `${__fnid}.fnos.net`) score += 130;
              else if (h === 'fnos.net' || h.endsWith('.fnos.net')) score += 100;
              else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) score += 50; // 公网 IPv4
              if (/^https:/i.test(u)) score += 10;
              if (score > bestScore) { bestScore = score; pick = u; }
            } catch (_) {}
          }
          return pick;
        };
        // 轮询：每 700ms 一次，最多 12 次（约 8.4s），覆盖 SPA 异步渲染
        let __attempts = 0;
        const __timer = setInterval(() => {
          try {
            if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(__timer); return; }
            __attempts++;
            __extract().then((json) => {
              try {
                let arr = [];
                try { arr = JSON.parse(json || '[]'); } catch (_) {}
                const valid = arr.filter((u) => /^https?:/i.test(u) && !__isBadLink(u));
                const pick = __pickBest(valid);
                if (pick && mainWindow && !mainWindow.isDestroyed()) {
                  clearInterval(__timer);
                  dlog && dlog('info', 'fnid.auto-navigate', { from: __cur.slice(0, 120), to: pick.slice(0, 140), candidates: valid.length, total: arr.length, attempts: __attempts });
                  mainWindow.loadURL(pick, { userAgent: getNasUA() }).catch(() => {});
                } else if (__attempts >= 12) {
                  clearInterval(__timer);
                  dlog && dlog('warn', 'fnid.auto-navigate.no-candidate', { attempts: __attempts, json: String(json || '').slice(0, 300) });
                } else {
                  dlog && dlog('info', 'fnid.poll-waiting', { attempts: __attempts, candidates: valid.length, total: arr.length, json: String(json || '').slice(0, 200) });
                }
              } catch (_) {}
            }).catch(() => {
              if (__attempts >= 12) clearInterval(__timer);
            });
          } catch (_) { clearInterval(__timer); }
        }, 700);
        // 总超时兜底
        setTimeout(() => { clearInterval(__timer); }, 12000);
      } catch (_) {}
    });
  } catch (_) {}

  if (loadTarget && loadTarget.href) {
    currentOrigin = loadTarget.origin || '';
    lastConnectHref = loadTarget.href;
    safeSetTitle(APP_NAME);
    mainWindow.loadURL(loadTarget.href, { userAgent: getNasUA() }).catch(() => showConnectPage());
  } else {
    showConnectPage();
  }

  buildMenu();
  if (!isLocked && !__shortcutKeepHidden) {
    mainWindow.show();
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !isLocked && !__shortcutKeepHidden) mainWindow.show();
    }, 200);
  } else if (isLocked) {
    // 启动锁定状态：主窗口后台加载，但不显示
    try { mainWindow.hide(); } catch (_) {}
  }
  // else: 快捷方式冷启动 + 已登录 → 保持后台（应用打开后由 tryOpenPendingApp 决定是否隐藏到托盘）
}

function showConnectPage() {
  if (currentPartition !== 'persist:connect') {
    saveSettings({ currentPartition: 'persist:connect' });
    createMainWindow('persist:connect', null);
    return;
  }
  // v2.1.6：回到连接页时停止扫描，避免在 login.html 上无意义扫描
  try { stopHomeScan(); } catch (_) {}
  currentOrigin = '';
  lastConnectHref = '';
  safeSetTitle(`${APP_NAME} · 连接服务器`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    // v2.1.6：ERR_FAILED(-2) 重试——便携版首次解压时文件可能暂时被锁定，
    // 优先用 loadFile，失败后回退到 loadURL(file://) 再试一次
    let triedUrl = false;
    mainWindow.loadFile(LOGIN_PAGE).catch((e) => {
      try {
        dlog && dlog('warn', 'login.loadFile.fail', { err: String(e && e.message || e), code: e && e.code });
      } catch (_) {}
      if (triedUrl) {
        // 两种方式都失败，显示错误对话框
        glassErrorBox('加载失败', `无法打开连接页：${e.message}`);
        return;
      }
      triedUrl = true;
      // 回退：用 loadURL + file:// 协议加载（绕过 loadFile 的 asar 路径解析）
      try {
        const fileUrl = url.pathToFileURL(LOGIN_PAGE).href;
        dlog && dlog('info', 'login.loadFile.retryWithURL', { url: fileUrl.slice(0, 80) });
        mainWindow.loadURL(fileUrl).catch((e2) => {
          try { dlog && dlog('warn', 'login.loadURL.fail', { err: String(e2 && e2.message || e2) }); } catch (_) {}
          glassErrorBox('加载失败', `无法打开连接页：${e2.message}`);
        });
      } catch (e3) {
        glassErrorBox('加载失败', `无法打开连接页：${e3.message}`);
      }
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

// v1.72.0：--open-app 命令行参数（桌面快捷方式启动单个应用）
let pendingOpenAppUrl = '';
function parseOpenAppArg() {
  try {
    const argv = process.argv || [];
    for (let i = 0; i < argv.length; i++) {
      const a = String(argv[i] || '');
      // v2.1.5: Support --app= parameter (used by create-desktop-shortcut)
      if (a === '--app' && argv[i + 1]) { pendingOpenAppUrl = decodeURIComponent(String(argv[i + 1])); return; }
      if (a.startsWith('--app=')) { pendingOpenAppUrl = decodeURIComponent(a.slice('--app='.length)); return; }
      // Legacy --open-app support
      if (a === '--open-app' && argv[i + 1]) { pendingOpenAppUrl = String(argv[i + 1]); return; }
      if (a.startsWith('--open-app=')) { pendingOpenAppUrl = a.slice('--open-app='.length); return; }
    }
  } catch (_) {}
}
function takePendingOpenApp() {
  const u = pendingOpenAppUrl;
  pendingOpenAppUrl = '';
  return u;
}

// v1.76.0：待打开应用（快捷方式 --open-app）。不立即强开，等主页登录就绪再打开：
// 未登录时应用窗口打开是登录页（无意义），用户登录完成后自动打开对应应用。
let __pendingAppUrl = '';
let __pendingAppStart = 0;
let __pendingFromShortcut = false; // v2.1.10：快捷方式触发的应用，打开后隐藏主窗口到托盘
function queuePendingApp(u) {
  __pendingAppUrl = String(u || '');
  __pendingAppStart = Date.now();
}
// v1.78.0：消费 --open-app（桌面快捷方式冷启动）。旧版只在 doConnectTo（手动连接服务器）
// 时取用，冷启动走 createMainWindow 直接 loadURL，pending 应用永远不会被打开——
// 这就是"快捷方式点了没反应"的根因。这里在主页加载/导航时统一取用一次。
function consumePendingOpenApp() {
  try {
    const u = takePendingOpenApp();
    if (!u) return;
    queuePendingApp(u);
    tryOpenPendingApp();
    // v2.1.15：轮询间隔从 1500ms 降到 300ms，冷启动快捷方式能更快检测到登录就绪
    const pt = setInterval(() => {
      try {
        tryOpenPendingApp();
        if (!__pendingAppUrl) clearInterval(pt);
      } catch (_) {}
    }, 300);
  } catch (_) {}
}

function tryOpenPendingApp() {
  try {
    if (!__pendingAppUrl) return;
    const u = __pendingAppUrl;
    let ready = false;
    let readyReason = 'not_ready';
    try {
      // v2.1.11：必须等主窗口页面加载完成（did-finish-load 后 isLoading=false）才算就绪。
      // 之前只看 URL 非 /login 就打开：冷启动时主窗口刚导航到主页（页面仍在加载、
      // Electron session / cookie 尚未就绪），应用窗口立即请求会拿到 401 → 跳登录页
      // （日志证据：fnos-diag 06:48:44 appwin.create 早于主窗口 preload.boot，随后 401）。
      const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
      if (!wc) { readyReason = 'no_main_window'; }
      else {
        const cur = wc.getURL() || '';
        const p = String(cur || '').toLowerCase();
        // v2.2.3：放宽就绪条件——只要求主窗口已导航到 https 主页（非 /login）。
        // 旧逻辑还要求 isLoading=false，但主页完整加载（JS/图片）可能 5-15s，
        // 此时 session cookie 早已就绪（did-navigate 到主页本身就证明登录态有效），
        // 导致快捷方式冷启动白白多等数秒（用户反馈"快捷方式打开应用非常慢"）。
        if (/^https?:/i.test(p) && p.indexOf('/login') !== 0 && !/\/login([\/?#]|$)/.test(p)) {
          ready = true;
          readyReason = 'logged_in';
        } else {
          readyReason = wc.isLoading() ? 'main_window_loading' : 'on_login_page_or_not_http';
        }
      }
    } catch (e) { readyReason = 'check_error: ' + (e.message || e); }
    const elapsed = Date.now() - __pendingAppStart;
    // v2.1.15：增强日志——记录每次轮询的状态
    try { dlog && dlog('info', 'pending_app.poll', { url: String(u).slice(0, 120), ready, reason: readyReason, elapsedMs: elapsed }); } catch (_) {}
    if (!ready && elapsed < 30000) return; // 未就绪且未超时 → 等主窗口加载完成/登录
    __pendingAppUrl = '';
    if (u) {
      try { require('./logger.js').log('info', 'app', 'pending_app.opening', { params: { url: String(u).slice(0, 160), elapsedMs: elapsed, fromShortcut: __pendingFromShortcut, appId: String(__pendingAppId || '').slice(0, 120) } }, __RUN_MODE); } catch (_) {}
      // v2.4.0（需求 2.5-1）：Main → Renderer open-fpk-app（携带 appId）——
      // v2.4.7（用户定案）：程序内启动 = 渲染进程后台模拟点击桌面图标（跳出窗呈现）
      // （≡主页点击图标效果）。场景 2（主程序未运行被拉起）：主界面隐藏只驻留托盘，
      // 应用窗直接呈现应用——不 show 主界面（用户模型："启动完成后隐藏主界面，只驻留托盘"）。
      __notifyOpenFpkApp(__pendingAppId, true, u);
      if (__pendingFromShortcut) {
        __pendingFromShortcut = false;
        __pendingAppId = '';
      }
    }
  } catch (_) {}
}

function doConnectTo(serverInput) {
  const parsed = normalizeServer(serverInput);
  const targetPartition = partitionForServer(parsed);
  upsertHistory(serverInput, parsed);
  // v2.0.0：同步记录到多账号列表
  upsertAccount(serverInput, parsed);
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
  // v2.2.7: 连接后主动探测 FPK 服务（18080），成功后自动启用并刷新应用列表/主页图标
  setImmediate(() => {
    try {
      const _base = getFpkBaseUrl();
      if (_base) {
        refreshFpkApps(true).then(() => {
          try { applyHomeFpkIcons(); } catch (_) {}
        });
      }
    } catch (_) {}
  });
  setImmediate(() => { try { warmupXteBase(); } catch (_) {} });
  // v1.67.0：登录成功后尽快注入页面级 WS/长连接保活，避免 FRP 空闲超时被回收导致"已断开"
  setTimeout(() => { try { bumpAuthHeartbeat(); } catch (_) {} }, 3000);
  // v2.0.0：启动网络健康探测（每30s检测NAS连通性，区分抖动/真断连）
  setImmediate(() => { try { startNetworkProbe(); } catch (_) {} });
  if (mainWindow && !mainWindow.isDestroyed()) {
    const onFail = (e) => {
      glassErrorBox(
        '连接失败',
        `无法连接到 ${parsed.origin}\n\n${e.message}\n\n请检查：\n• 电脑是否与 NAS 在同一网络\n• 地址与端口是否正确\n• FN ID 是否正确、FN Connect 是否已开启`,
      );
      showConnectPage();
    };
    mainWindow.loadURL(parsed.href, { userAgent: getNasUA() }).catch(onFail);
    // v1.76.0：桌面快捷方式启动 --open-app 时，等待主页登录就绪后自动打开对应应用。
    // 旧版固定 1200ms 强开：未登录时应用窗口打开的是登录页（打不开）。
    // 现在：主页已登录（URL 非 /login）→ 立即打开；停在 /login → 等用户登录后
    // （did-navigate 离开 login）再打开；25s 超时兜底强开（部分应用独立认证）。
    const openUrl = takePendingOpenApp();
    if (openUrl) {
      queuePendingApp(openUrl);
      tryOpenPendingApp();
      const pt = setInterval(() => {
        try {
          tryOpenPendingApp();
          if (!__pendingAppUrl) clearInterval(pt);
        } catch (_) {}
      }, 1500);
    }
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

// v1.71.0：复制当前窗口链接地址（主窗口取 webview guest 当前 URL，应用窗口取自身 URL）
// v2.2.2-fix：玻璃外壳已移除（v1.18+），主窗口直接承载页面、不再有 webview guest，
// 旧逻辑 pickMenuGuest() 恒为 null 导致"复制当前窗口连接"失效（日志 menu.copy-link no-url）。
// 修复：统一优先取 win.webContents 当前 URL（主窗口/应用窗口均适用），guest 仅作历史兜底。
function copyCurrentWindowLink() {
  try {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win || win.isDestroyed()) return;
    let url = '';
    const selfUrl = win.webContents.getURL();
    if (selfUrl && /^https?:/i.test(selfUrl)) {
      url = selfUrl;
    } else {
      const guest = pickMenuGuest();
      if (guest && !guest.isDestroyed()) {
        const u = guest.getURL();
        if (u && /^https?:/i.test(u)) url = u;
      }
    }
    if (!url) { dlog && dlog('warn', 'menu.copy-link', { err: 'no-url', winId: win.id }); return; }
    clipboard.writeText(url);
    dlog && dlog('info', 'menu.copy-link', { url: String(url).slice(0, 120), winId: win.id });
  } catch (e) { dlog && dlog('warn', 'menu.copy-link', { err: String(e && e.message || e) }); }
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
        // v2.0.1：已移除"切换服务器"菜单项，多账号切换已足够
        { label: '返回 FNOS 主页', accelerator: 'Alt+H', click: goHomeWithPrompt },
        // v2.0.0：多账号快速切换
        (() => {
          const accts = getAccounts();
          if (accts.length === 0) return { label: '切换账号', submenu: [{ label: '（暂无已登录账号）', enabled: false }] };
          return {
            label: '切换账号',
            submenu: [
              ...accts.map(a => ({
                label: (a.isActive ? '● ' : '  ') + (a.label || a.origin),
                click: () => { if (!a.isActive) switchAccount(a.origin); },
              })),
              { type: 'separator' },
              { label: '登录其它账号…', click: () => showConnectPage() },
            ],
          };
        })(),
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
        { type: 'separator' },
        {
          label: '🔗 复制当前窗口链接地址',
          accelerator: 'Ctrl+Shift+C',
          click: () => copyCurrentWindowLink(),
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
            autoHideMenuBar: true,
            frame: false, // v1.54：无边框，preload 注入与主窗口同款标题栏
            backgroundColor: '#0b0d12',
            icon: ICON_PATH,
            parent: mainWindow || undefined,
            modal: false,
            webPreferences: {
              contextIsolation: true, webviewTag: true, nodeIntegration: false,
              sandbox: false, // v1.56：preload 需 require 本地 titlebar-inject
              preload: path.join(__dirname, 'preload.js'),
              backgroundThrottling: false,
            },
          });
          helpWin.setMenuBarVisibility(false);
          helpWin.loadFile(HELP_PAGE).catch(() => {});
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
  const href = payload && payload.href;
  if (!href || typeof href !== 'string') return { ok: false };
  return { ok: true, history: removeHistoryByKey(href) };
});

// v1.72.0：主页扫描到的应用列表上报（创建桌面快捷方式的数据源）。
// v1.76.0：抽成独立函数 processScannedApps——主进程直接扫描主页时也复用，
// IPC（shell 页面上报）仅作兼容保留。
async function processScannedApps(apps) {
  try {
    if (!Array.isArray(apps) || !apps.length) return;
    const s = loadSettings();
    const cur = Array.isArray(s.apps) ? s.apps : [];
    const curUrls = new Set(cur.map((a) => a.url).filter(Boolean));
    const byUrl = new Map(cur.map((a) => [a.url, a]));
    const fresh = [];
    for (const a of apps) {
      if (!a || !a.url || !a.name) continue;
      // v2.2.5：过滤备案/政务垃圾链接（FNID 跳错页时主页扫描曾写入 beian.miit.gov.cn 等）
      if (isBadNavLink(a.url)) {
        fnosLog('warn', 'appcenter.scan', { msg: 'skip bad nav link', url: String(a.url).slice(0, 100) });
        continue;
      }
      byUrl.set(a.url, {
        name: String(a.name).slice(0, 40),
        url: String(a.url),
        icon: String(a.icon || ''),
        // v1.74.0：保存 appName（飞牛应用内部名，用于构造 appview anchor 打开地址）
        appName: String(a.appName || a.appId || ''),
        // v2.1.5：保存 appId（用于快捷方式启动和 manifest 匹配）
        appId: String(a.appId || a.url),
        // v2.1.5：保存应用类型
        type: String(a.type || 'unknown'),
        addedAt: Date.now(),
      });
      // v1.73.0：识别「新增」应用（之前没扫到过）→ 触发桌面快捷方式自动创建
      if (!curUrls.has(a.url)) fresh.push(byUrl.get(a.url));
    }
    const merged = Array.from(byUrl.values());
    saveSettings({ apps: merged.slice(0, 50) });
    try { cachedSettings.apps = merged.slice(0, 50); } catch (_) {}
    // v2.1.4: sync to apps-manifest.json with synchronous icon caching
    // Icons are downloaded BEFORE writing manifest so shortcuts always get correct iconPath
    try {
      const existing = readManifest();
      const existingByUrl = new Map(existing.apps.map(a => [a.url, a]));
      if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

      // Collect all icon download tasks
      const iconTasks = [];
      for (const a of merged) {
        let origin = '';
        try { origin = new URL(a.url).origin; } catch (_) {}
        const prev = existingByUrl.get(a.url) || {};
        let iconPath = prev.iconPath || '';
        let iconData = a.icon || '';
        // v2.1.9：旧版用错误的 serviceicon 占位符路径（icon-{0}.png）作为图标 URL，
        // 导致 manifest 里 iconPath/iconData 陈旧错误。这里在图标 URL 变化时强制重新下载，
        // 修复「快捷方式图标不是对应应用图标」。
        // v2.4.0（需求第一部分-1）：禁止本地缓存 FPK/NAS 图标资源——图标 URL 存在即每次
        // 实时重新下载并覆盖本地副本（.lnk 图标机制必须引用本地 .ico/.png 文件，
        // 该文件仅作 lnk 图标载体，每次同步刷新，不作为图标加载链路的读取缓存）。
        if (iconData && /^https?:/i.test(iconData)) {
          const ext = iconData.split('?')[0].split('.').pop().toLowerCase();
          const validExt = ['png','jpg','jpeg','gif','svg','webp','ico'].includes(ext) ? ext : 'png';
          const safeName = Buffer.from(a.url).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
          const iconFile = path.join(ASSETS_DIR, safeName + '.' + validExt);
          // v2.1.4: await icon download before writing manifest
          const fetchUrl = /^https?:/i.test(iconData) ? iconData : origin + iconData;
          iconTasks.push({ iconFile, fetchUrl, appName: a.name, url: a.url, origin });
        }
        existingByUrl.set(a.url, {
          appId: a.appId || a.url,
          appName: a.name || a.appName || '',
          nasAddress: origin,
          url: a.url,
          iconData: iconData,
          iconPath: iconPath
        });
      }

      // Download all icons concurrently and wait for completion
      if (iconTasks.length > 0) {
        // v2.1.12：图标下载必须复用主窗口 session（登录后 cookie 所在）。
        // 旧版用 session.fromPartition(currentPartition)——多账号模式下 currentPartition
        // 可能与实际登录 session 不一致，导致 /app-center-static/icon/ 等需鉴权路径 401，
        // 图标下载失败 → manifest iconPath 为空 → 设置面板"应用快捷方式"大部分图标不显示。
        const iconSes = (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed())
          ? mainWindow.webContents.session
          : null;
        await Promise.all(iconTasks.map(async (task) => {
          try {
            if (!iconSes) return;
            const resp = await iconSes.fetch(task.fetchUrl, { credentials: 'include' });
            if (resp.ok) {
              const ab = await resp.arrayBuffer();
              const buf = Buffer.from(ab);
              if (buf.length > 100) {
                fs.writeFileSync(task.iconFile, buf);
                // Update manifest entry with the downloaded icon path
                const entry = existingByUrl.get(task.url);
                if (entry) entry.iconPath = task.iconFile;
                fnosLog('info', 'icon.download', 'icon downloaded', { app: task.appName, ok: true, size: buf.length });
              }
            } else {
              fnosLog('warn', 'icon.download', 'icon download bad status', { app: task.appName, status: resp.status, url: String(task.fetchUrl).slice(0, 120) });
            }
          } catch (e) { fnosLog('warn', 'icon.download', 'icon download error', { app: task.appName, err: e.message }); }
        }));
      }

      writeManifest({ apps: Array.from(existingByUrl.values()) });
    } catch (_) {}
    // v1.75.0：日志带上具体应用名，便于排障
    dlog && dlog('info', 'apps.scanned', { count: merged.length, fresh: fresh.length, apps: merged.map((a) => a.name + '|' + a.url).slice(0, 12) });
    // v1.78.0：不再自动创建桌面快捷方式（用户按需手动创建，避免桌面被自动铺满）
  } catch (_) {}
}

// v2.1.8：REST 拉取「应用中心已安装应用」完整列表（含第三方应用）。
// 旧方案只扫主页 DOM（系统应用）+ WS appStoreList（商店列表，非已安装），
// 拿不到用户在应用中心实际安装的第三方应用。这里直接请求飞牛 app-center 接口
// GET /app-center/v1/app/installed，复用主窗口登录 cookie，拿到正确图标与启动地址。
function buildAppCenterUrl(origin, svc) {
  try {
    if (!svc) return '';
    // 后端返回的完整外部访问地址优先（如 http://公网IP:10303/，第三方应用反代端口）
    if (svc.fullUrl && /^https?:/i.test(svc.fullUrl)) return svc.fullUrl;
    const urls = svc.urls || {};
    const o = new URL(origin);
    const protocol = (urls.protocol || o.protocol).replace(/:+$/, '');
    const host = urls.host || o.hostname;
    const port = urls.port || o.port;
    const path = urls.path || '/';
    return protocol + '://' + host + ':' + port + path;
  } catch (_) { return ''; }
}

async function scanAppCenterViaRest() {
  try {
    const s = loadSettings();
    const origin = s.origin || '';
    if (!origin || !/^https?:/i.test(origin)) return;
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
    const ses = mainWindow.webContents.session;
    const url = origin.replace(/\/+$/, '') + '/app-center/v1/app/installed?language=zh-CN';
    const resp = await ses.fetch(url, { credentials: 'include' });
    if (!resp.ok) {
      // v2.2.0: 失败详情（URL、状态、响应片段），排查 appcenter 接口地址/鉴权问题
      let bodySnippet = '';
      try { bodySnippet = String(await resp.text()).slice(0, 200); } catch (_) {}
      fnosLog('warn', 'appcenter.rest', 'app-center fetch failed', { status: resp.status, url, bodySnippet });
      return;
    }
    const json = await resp.json().catch(() => ({}));
    const list = (json && json.data && json.data.list) || [];
    fnosLog('info', 'appcenter.rest', 'installed apps fetched', {
      total: (json && json.data && json.data.total) || 0,
      listLen: list.length,
      sample: list.slice(0, 5).map((a) => String(a.appName || a.name || '').slice(0, 40)),
    });
    const apps = [];
    for (const a of list) {
      const appName = a.appName || '';
      const name = a.name || appName;
      if (!appName || !name) continue;
      const appUrl = buildAppCenterUrl(origin, a.appServiceInfo);
      if (!appUrl) continue; // 无独立启动地址的应用（依赖/运行时如 python312、nodejs）跳过
      const icon = a.icon
        ? (/^https?:/i.test(a.icon) ? a.icon : origin.replace(/\/+$/, '') + (a.icon[0] === '/' ? '' : '/') + a.icon)
        : '';
      apps.push({
        name: String(name).slice(0, 40),
        appId: appName,
        url: appUrl,
        icon: icon,
        appName: appName,
        type: 'appCenter',
      });
    }
    if (apps.length) processScannedApps(apps);
    else fnosLog('warn', 'appcenter.rest', 'empty app list', {});
  } catch (e) {
    fnosLog('warn', 'appcenter.rest', 'scan failed', { err: e.message });
  }
}

ipcMain.on('shell:report-apps', (_e, apps) => {
  try { processScannedApps(apps); } catch (_) {}
});

// v1.76.0：主窗口（NAS 主页）应用扫描——旧版扫描代码写在 shell.js 里，
// 但主窗口从未加载 shell.html（直接 loadURL NAS 主页），导致扫描从未执行、
// apps 永远为空、快捷方式无法创建。这里把扫描逻辑直接注入主窗口执行：
//   1) dom-ready / did-navigate / 每 10s 循环扫描（登录页跳过）
//   2) 仅结果变化时上报（应用增/减自动同步）
let __homeScanTimer = null;
let __lastHomeAppsSig = '';
// v1.77.0：String.raw 保持正则转义原样（普通模板字符串会把 \\/ 解析成 /、\\s 解析成 s，
// 导致生成的扫描 JS 语法错误、executeJavaScript 每次报 Script failed to execute）
const __HOME_SCAN_JS = String.raw`(function(){
  try {
    // 登录页没有应用卡片，直接跳过（SPA 登录态未就绪时也是空）
    var pp = (location.pathname || '').toLowerCase();
    if (pp.indexOf('/login') === 0 || pp === 'login') return null;
    var origin = location.origin;
    var res = [];
    var seen = {};
    var clean = function(s){ return String(s||'').replace(/\s+/g,' ').trim(); };
    var toAbs = function(u){
      if (!u) return '';
      try { return new URL(u, origin).href; } catch(e){ return ''; }
    };
    var appNameFromUrl = function(u){
      if (!u) return '';
      var m = /\/(?:icons|icon)\/([^\/?#]+?)(?:\/|\.[a-z0-9]+$|$)/i.exec(u);
      if (m) { try { return decodeURIComponent(m[1]); } catch(e){ return m[1]; } }
      return '';
    };
    var pushApp = function(name, url, icon, appName){
      if (!name) return;
      if (name.length > 40) name = name.slice(0, 40);
      var abs = toAbs(url);
      var finalUrl = /^https?:/i.test(abs) ? abs : '';
      if (!finalUrl && appName) {
        // v2.1.14：anchor 只传应用名，不加 https:// 前缀
        // appview 的 openAppFromAnchor 会自动加 https:// 再解析 hostname
        finalUrl = origin + '/appview?anchor=' + encodeURIComponent(appName);
      }
      if (!finalUrl) return;
      if (seen[finalUrl]) return;
      seen[finalUrl] = 1;
      res.push({ name: name, url: finalUrl, icon: icon || '', appName: appName || '' });
    };
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var img = a.querySelector('img');
      var icon = img ? toAbs(img.getAttribute('data-src') || img.currentSrc || img.src || '') : '';
      var nm = clean(a.innerText || a.title || (img && img.alt) || '');
      if (!nm && img) nm = clean(img.alt || '');
      pushApp(nm, a.href, icon, appNameFromUrl(icon));
    }
    var imgs = document.querySelectorAll('img');
    var done = {};
    for (var q = 0; q < imgs.length; q++) {
      var im = imgs[q];
      var icon2 = toAbs(im.getAttribute('data-src') || im.currentSrc || im.src || '');
      var nm2 = clean(im.alt || '');
      var href2 = '';
      var cur = im;
      for (var d = 0; d < 8 && cur; d++) {
        var pe = cur.parentElement;
        if (!pe) break;
        if (!href2 && pe.tagName === 'A') href2 = pe.href || '';
        var t = clean(pe.innerText || '');
        if (t && t.length <= 40 && !/\s/.test(t)) nm2 = t;
        cur = pe;
      }
      if (!nm2 || nm2.length > 40) continue;
      var k2 = href2 || icon2;
      if (done[k2]) continue;
      done[k2] = 1;
      pushApp(nm2, href2, icon2, appNameFromUrl(icon2));
    }
    return res;
  } catch (e) { return null; }
})()`;
function scanHomeApps(force) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    // v2.1.6：只在 http/https 页面扫描（NAS 主页），跳过 file:// 等本地页面（login.html 等）
    const curUrl = wc.getURL() || '';
    if (!/^https?:/i.test(curUrl)) return;
    wc.executeJavaScript(__HOME_SCAN_JS, true).then((apps) => {
      try {
        const found = Array.isArray(apps) ? apps.length : -1;
        // v1.76.0：记录每次扫描执行结果（即使空），便于区分"扫描没跑"与"扫到0个"
        dlog && dlog('info', 'apps.scan.exec', { found, url: String(wc.getURL()).slice(0, 100) });
        if (!Array.isArray(apps)) return;
        const sig = JSON.stringify(apps);
        if (!force && sig === __lastHomeAppsSig) return;
        __lastHomeAppsSig = sig;
        processScannedApps(apps);
        if (Array.isArray(apps) && apps.length) {
          setTimeout(() => { try { scanAppCenterApps(); } catch (_) {} }, 2000);
        }
      } catch (_) {}
    }).catch((e) => {
      try { dlog && dlog('warn', 'apps.scan.err', { err: String(e && e.message || e).slice(0, 120) }); } catch (_) {}
    });
  } catch (_) {}
}
function startHomeScan() {
  try {
    if (__homeScanTimer) { clearInterval(__homeScanTimer); __homeScanTimer = null; }
    // v2.1.6：如果当前不在 NAS 页面（非 http/https），不启动扫描定时器
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      const u = mainWindow.webContents.getURL() || '';
      if (!/^https?:/i.test(u)) return;
    }
    scanHomeApps(true);
    // v2.1.17：扫描间隔从 60s 优化到 300s（5分钟），应用列表变化不频繁，减少资源浪费
    __homeScanTimer = setInterval(() => { try { scanHomeApps(false); } catch (_) {} }, 300000);
  } catch (_) {}
}
function stopHomeScan() {
  if (__homeScanTimer) { clearInterval(__homeScanTimer); __homeScanTimer = null; }
}

// ---- v2.2.6: 主页图标覆盖 ----
// 飞牛 NAS 主页（webview 内 fnOS Web）系统应用图标走 /static/app/icons/{app}/icon.png
// （fnOS 系统内置静态资源，nginx 服务，与 /var/apps 无关），fntb 写回 /var/apps 无法
// 覆盖 → 修改图标后主页强制刷新也不变。这里在主页注入 JS：把有自定义图标
// （FPK 列表 has_custom_icon=true）的应用卡片图标替换为 FPK API 图标 URL
// （/api/icons/{app}/256?t=...&v=... 带 cache-busting），修改图标后主页即可生效。
async function applyHomeFpkIcons() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    const curUrl = wc.getURL() || '';
    if (!/^https?:/i.test(curUrl)) return;
    const base = getFpkBaseUrl();
    if (!base) {
      dlog && dlog('info', 'home.fpk-icon', { msg: 'FPK not enabled, skip' });
      return;
    }
    const apps = await refreshFpkApps(false);
    if (!Array.isArray(apps)) return;
    const custom = (apps || []).filter((a) => a && a.has_custom_icon).map((a) => a.name);
    if (!custom.length) {
      dlog && dlog('info', 'home.fpk-icon', { msg: 'no custom icons, skip' });
      return;
    }
    dlog && dlog('info', 'home.fpk-icon', { msg: 'inject', count: custom.length, base });
    const js = String.raw`(function(){
      try {
        window.__fnosHomeFpkIcon = (window.__fnosHomeFpkIcon || 0) + 1;
        var myGen = window.__fnosHomeFpkIcon;
        var custom = ${JSON.stringify(custom)};
        var base = ${JSON.stringify(base)};
        // v2.4.0（需求第一部分-1）：图标版本表 app -> ver。旧版 bug 根因：ns URL 含 t=Date.now()
        // 每次 apply 都不同 -> getAttribute('src') !== ns 恒真 -> setAttribute -> MutationObserver(src)
        // 再触发 apply -> 无限改写循环；且 NAS 前端重渲染把 src 改回旧值 =「短暂生效后自动变回旧图标」。
        // 修复：URL 版本化（nonce 页面级 + ver 列表级），同版本内 URL 稳定 -> apply 幂等（防死循环）；
        // NAS 前端改回旧 src 时 apply 立即改回当前版本 URL（防覆盖回退）；refreshCustom 列表刷新时
        // ver 递增 -> URL 变化强制绕开浏览器 HTTP 缓存取最新图（修改图标后主页刷新即生效，5s 内自动同步）。
        var iconVer = {};
        var verSeq = 0;
        var nonce = String(Date.now());
        function nsUrl(app){
          return base + '/api/icons/' + encodeURIComponent(app) + '/256?v=' + nonce + '-' + (iconVer[app] || 0);
        }
        function apply(){
          try {
            var imgs = document.querySelectorAll('img');
            for (var i = 0; i < imgs.length; i++) {
              var im = imgs[i];
              var src = im.currentSrc || im.src || '';
              if (!src) continue;
              var m = /\/(?:static\/app\/icons|app-center-static\/icon|app-center-static\/serviceicon)\/([^\/?#]+?)(?:\/|\.)/i.exec(src);
              if (!m) continue;
              var app;
              try { app = decodeURIComponent(m[1]); } catch(e){ app = m[1]; }
              if (!app || custom.indexOf(app) === -1) continue;
              var ns = nsUrl(app);
              // 仅当当前 src 不等于本应用「当前版本」的 FPK 图标 URL 时才改写（防覆盖 + 防循环）
              if (im.getAttribute('src') !== ns) { im.setAttribute('src', ns); }
            }
          } catch(e){}
        }
        // 周期刷新 custom 列表并升级图标版本号（fntb 修改图标后 5s 内主页自动同步，无需重启/刷新）
        function refreshCustom(){
          try {
            if (myGen !== window.__fnosHomeFpkIcon) return;
            fetch(base + '/api/client/apps?status=custom', { headers: { 'X-FNOS-Client': 'desktop', 'Cache-Control': 'no-cache' } })
              .then(function(r){ return r.ok ? r.json() : null; })
              .then(function(j){
                if (myGen !== window.__fnosHomeFpkIcon) return;
                var arr = (j && (j.list || j.apps)) || [];
                var next = [];
                for (var i = 0; i < arr.length; i++) { if (arr[i] && arr[i].name) next.push(arr[i].name); }
                custom = next;
                verSeq++;
                for (var k = 0; k < next.length; k++) { iconVer[next[k]] = verSeq; }
                apply();
              }).catch(function(){});
          } catch(e){}
        }
        verSeq = 1;
        for (var q = 0; q < custom.length; q++) { iconVer[custom[q]] = 1; }
        apply();
        setInterval(refreshCustom, 5000);
        try {
          var mo = new MutationObserver(apply);
          mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        } catch(e){}
      } catch(e){}
    })()`;
    wc.executeJavaScript(js, true).then(() => {
      dlog && dlog('info', 'home.fpk-icon', { msg: 'injected ok', count: custom.length });
    }).catch((e) => {
      dlog && dlog('warn', 'home.fpk-icon', { err: String(e && e.message || e).slice(0, 120) });
    });
  } catch (_) {}
}

// v1.79.0：主页只显示部分应用（系统应用），Docker 等第三方应用在「应用中心」页。
// 登录后用一个隐藏窗口加载应用中心页，扫描全部应用卡片，补全应用列表（去重合并）。
// v2.1.3: 修复 /appstore 404 + center 变量作用域 bug + 多策略应用发现（WebSocket拦截 + DOM扫描 + React状态提取）
// ── v2.1.4: WebSocket API 直连扫描 ──────────────────────────────────
// 通过隐藏窗口内直接创建 WebSocket 连接 FNOS API，获取完整应用列表
// 不再依赖 DOM 扫描 + WebSocket 拦截（旧方案无法捕获已建立的连接）
const __WS_SCANNER_JS = String.raw`
(function() {
  try {
    if (window.__fnosWsScanner) return;
    window.__fnosWsScanner = true;
    var origin = location.origin;
    var wsProto = origin.indexOf('https') === 0 ? 'wss:' : 'ws:';
    var wsUrl = wsProto + '//' + location.host + '/websocket?type=main';

    // v2.1.5: UUID fallback for non-secure contexts (HTTP)
    function genUUID() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        try { return crypto.randomUUID(); } catch(e) {}
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    function b64url(b64) { return b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
    function ab2b64(buf) {
      var bytes = new Uint8Array(buf), bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    function str2ab(s) { return new TextEncoder().encode(s).buffer; }

    async function signRequest(reqId, req, data, secretB64) {
      var ts = Date.now();
      var body = { reqid: reqId, req: req, data: data || {} };
      var bodyJson = JSON.stringify(body);
      var signStr = reqId + req + ts;
      var keyBytes = Uint8Array.from(atob(secretB64), function(c){ return c.charCodeAt(0); });
      var key = await crypto.subtle.importKey('raw', keyBytes.buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      var sigBuf = await crypto.subtle.sign('HMAC', key, str2ab(signStr));
      var sigB64 = b64url(ab2b64(sigBuf));
      return sigB64 + bodyJson;
    }

    function createWS() {
      return new Promise(function(resolve, reject) {
        var ws = new WebSocket(wsUrl);
        var timer = setTimeout(function() { reject(new Error('WS connect timeout')); }, 10000);
        ws.onopen = function() { clearTimeout(timer); resolve(ws); };
        ws.onerror = function() { clearTimeout(timer); reject(new Error('WS connect error')); };
      });
    }

    function sendAndWait(ws, payload, reqid) {
      return new Promise(function(resolve, reject) {
        var timer = setTimeout(function() { reject(new Error('Request timeout')); }, 15000);
        var handler = function(event) {
          try {
            var raw = typeof event.data === 'string' ? event.data : '';
            var idx = raw.indexOf('{');
            if (idx < 0) return;
            var resp = JSON.parse(raw.substring(idx));
            if (resp.reqid === reqid) { clearTimeout(timer); ws.removeEventListener('message', handler); resolve(resp); }
          } catch(e) {}
        };
        ws.addEventListener('message', handler);
        ws.send(payload);
      });
    }

    async function main() {
      window.__fnosWsScanStatus = 'connecting';
      var ws;
      try { ws = await createWS(); } catch(e) {
        window.__fnosWsScanError = e.message;
        window.__fnosWsScanStatus = 'error';
        try { window.postMessage({ type: 'fnos-ws-scan-result', data: [], error: e.message }, '*'); } catch(e2) {}
        return;
      }
      window.__fnosWsScanStatus = 'connected';

      var token = '', secret = '';
      try {
        var stored = localStorage.getItem('token');
        if (stored) {
          var t = typeof stored === 'string' ? JSON.parse(stored) : stored;
          token = t.token || t.access_token || t.accessToken || '';
          secret = t.secret || t.signSecret || '';
        }
      } catch(e) {}

      if (!token || !secret) {
        try {
          var keys = Object.keys(localStorage);
          for (var ki = 0; ki < keys.length; ki++) {
            var val = localStorage.getItem(keys[ki]);
            try {
              var parsed = JSON.parse(val);
              if (parsed && (parsed.token || parsed.access_token)) {
                token = parsed.token || parsed.access_token || '';
                secret = parsed.secret || parsed.signSecret || '';
                break;
              }
            } catch(e2) {}
          }
        } catch(e) {}
      }

      if (!token || !secret) {
        window.__fnosWsScanError = 'Not logged in - no token/secret found';
        window.__fnosWsScanStatus = 'error';
        try { window.postMessage({ type: 'fnos-ws-scan-result', data: [], error: 'not_logged_in' }, '*'); } catch(e2) {}
        try { ws.close(); } catch(e2) {}
        return;
      }

      var allApps = [];

      // Fetch entry list
      try {
        var reqId1 = genUUID();
        var payload1 = await signRequest(reqId1, 'appcgi.sac.entry.v1.getEntryList', {}, secret);
        var resp1 = await sendAndWait(ws, payload1, reqId1);
        if (resp1 && resp1.errno === 0 && resp1.data && resp1.data.list) {
          var entries = Array.isArray(resp1.data.list) ? resp1.data.list : [];
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var appName = e.appName || e.name || '';
            if (!appName) continue;
            var isSystem = (e.type === 'builtIn' || e.appType === 'builtIn' || e.category === 'system');
            var iconPath = e.icon || '';
            var iconUrl = '';
            if (iconPath) {
              if (iconPath.indexOf('http') === 0) iconUrl = iconPath;
              else if (iconPath.indexOf('/') === 0) iconUrl = origin + iconPath;
              else iconUrl = origin + '/' + iconPath;
            }
            if (!iconUrl) {
              iconUrl = isSystem
                ? origin + '/static/app/icons/' + appName + '/icon.png'
                : origin + '/app-center-static/serviceicon/' + appName + '/ui/images/icon_0.png';
            }
            var appUrl = '';
            if (e.fullUrl) { appUrl = e.fullUrl; }
            else if (e.uri && e.uri.host) {
              appUrl = (e.uri.protocol || 'http') + '://' + e.uri.host + (e.uri.port ? ':' + e.uri.port : '') + (e.uri.path || '/');
            }
            if (!appUrl) {
              appUrl = isSystem ? (origin + '/appview?anchor=' + encodeURIComponent(appName)) : appName;
            }
            allApps.push({
              name: e.title || appName,
              appId: appName,
              url: appUrl,
              icon: iconUrl,
              type: isSystem ? 'builtIn' : 'appCenter'
            });
          }
        }
      } catch(e) {}

      // Also fetch appStoreList for additional installed apps
      try {
        var reqId2 = genUUID();
        var payload2 = await signRequest(reqId2, 'appcgi.sac.entry.v1.appStoreList', {}, secret);
        var resp2 = await sendAndWait(ws, payload2, reqId2);
        if (resp2 && resp2.errno === 0 && resp2.data && Array.isArray(resp2.data)) {
          var existIds = {};
          allApps.forEach(function(a) { existIds[a.appId] = true; });
          resp2.data.forEach(function(item) {
            var an = item.appName || '';
            if (!an || existIds[an]) return;
            var iconP = item.icon || '';
            var iconU = '';
            if (iconP) {
              if (iconP.indexOf('http') === 0) iconU = iconP;
              else if (iconP.indexOf('/') === 0) iconU = origin + iconP;
              else iconU = origin + '/' + iconP;
            }
            if (!iconU) iconU = origin + '/app-center-static/serviceicon/' + an + '/ui/images/icon_0.png';
            var au = '';
            if (item.fullUrl) au = item.fullUrl;
            else if (item.uri && item.uri.host) au = (item.uri.protocol || 'http') + '://' + item.uri.host + (item.uri.port ? ':' + item.uri.port : '') + (item.uri.path || '/');
            if (!au) au = an;
            allApps.push({ name: item.title || an, appId: an, url: au, icon: iconU, type: 'appCenter' });
            existIds[an] = true;
          });
        }
      } catch(e) {}

      window.__fnosWsScanApps = allApps;
      window.__fnosWsScanStatus = 'done';
      // v2.1.5: Post result to main process via postMessage
      try { window.postMessage({ type: 'fnos-ws-scan-result', data: allApps }, '*'); } catch(e) {}
      try { ws.close(); } catch(e) {}
    }
    main().catch(function(e) {
      window.__fnosWsScanError = e.message || String(e);
      window.__fnosWsScanStatus = 'error';
      try { window.postMessage({ type: 'fnos-ws-scan-result', data: [], error: e.message }, '*'); } catch(e2) {}
    });
  } catch(e) {
    window.__fnosWsScanError = e.message || String(e);
    window.__fnosWsScanStatus = 'error';
    try { window.postMessage({ type: 'fnos-ws-scan-result', data: [], error: e.message }, '*'); } catch(e2) {}
  }
})()
`;


// v2.1.5: PNG to ICO converter for Windows shortcuts
// v2.2.4: 多尺寸 ICO（16/24/32/48/64/128/256）——此前单尺寸 256 在 Windows 缩放
// 后毛刺/方角/质量差；多尺寸让资源管理器按目标尺寸取最近源，小尺寸也清晰。
function pngToIco(pngBuffer) {
  try {
    const src = nativeImage.createFromBuffer(Buffer.from(pngBuffer));
    if (src.isEmpty()) throw new Error('empty source image');
    // 统一源尺寸：先缩放到 256（高清源），再向下取各档
    let base = src;
    const sw = src.getSize().width || 256;
    const sh = src.getSize().height || 256;
    const maxDim = Math.max(sw, sh);
    if (maxDim !== 256) {
      const scale = 256 / maxDim;
      base = src.resize({ width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)), quality: 'best' });
    }
    const sizes = [256, 128, 64, 48, 32, 24, 16];
    const entries = [];
    for (const s of sizes) {
      try {
        const img = (s === 256) ? base : base.resize({ width: s, height: s, quality: 'best' });
        const png = img.toPNG();
        if (png && png.length > 8) entries.push({ size: s, data: Buffer.from(png) });
      } catch (_) {}
    }
    if (!entries.length) { entries.push({ size: 256, data: Buffer.from(pngBuffer) }); }
    // ICO header: reserved=0, type=1(icon), count=N
    const headerSize = 6 + entries.length * 16;
    const total = headerSize + entries.reduce((s, e) => s + e.data.length, 0);
    const ico = Buffer.alloc(total);
    let offset = 0;
    ico.writeUInt16LE(0, offset); offset += 2;  // reserved
    ico.writeUInt16LE(1, offset); offset += 2;  // type = 1 (icon)
    ico.writeUInt16LE(entries.length, offset); offset += 2;  // count
    let dataOffset = headerSize;
    for (const e of entries) {
      ico.writeUInt8(e.size >= 256 ? 0 : e.size, offset); offset += 1;  // width (0 = 256)
      ico.writeUInt8(e.size >= 256 ? 0 : e.size, offset); offset += 1;  // height
      ico.writeUInt8(0, offset); offset += 1;  // color palette
      ico.writeUInt8(0, offset); offset += 1;  // reserved
      ico.writeUInt16LE(1, offset); offset += 2;  // color planes
      ico.writeUInt16LE(32, offset); offset += 2; // bits per pixel
      ico.writeUInt32LE(e.data.length, offset); offset += 4;  // image data size
      ico.writeUInt32LE(dataOffset, offset); offset += 4;     // image data offset
      dataOffset += e.data.length;
    }
    for (const e of entries) {
      e.data.copy(ico, offset);
      offset += e.data.length;
    }
    return ico;
  } catch (e) {
    // 兜底：退回原单尺寸逻辑
    const headerSize = 6 + 16;
    const ico = Buffer.alloc(headerSize + pngBuffer.length);
    let offset = 0;
    ico.writeUInt16LE(0, offset); offset += 2;
    ico.writeUInt16LE(1, offset); offset += 2;
    ico.writeUInt16LE(1, offset); offset += 2;
    const w = pngBuffer.readUInt32BE(16);
    const h = pngBuffer.readUInt32BE(20);
    ico.writeUInt8(w >= 256 ? 0 : w, offset); offset += 1;
    ico.writeUInt8(h >= 256 ? 0 : h, offset); offset += 1;
    ico.writeUInt8(0, offset); offset += 1;
    ico.writeUInt8(0, offset); offset += 1;
    ico.writeUInt16LE(1, offset); offset += 2;
    ico.writeUInt16LE(32, offset); offset += 2;
    ico.writeUInt32LE(pngBuffer.length, offset); offset += 4;
    ico.writeUInt32LE(headerSize, offset); offset += 4;
    pngBuffer.copy(ico, offset);
    return ico;
  }
}

// ---- v2.1.17: FPK 图标管理器 API ----
// v2.2.7: FPK 自动探测缓存（避免每次同步调用都发探测请求）
let __fpkAutoProbe = null; // { base, at }
let __fpkProbeInFlight = null;

function getFpkBaseUrl() {
  const s = loadSettings();
  if (s.fpkApi?.enabled && s.fpkApi?.host) {
    const base = `http://${s.fpkApi.host}:${s.fpkApi.port || 18080}`;
    console.log('[FPK] config check: OK', JSON.stringify({ baseUrl: base }));
    return base;
  }
  // v2.2.7: 未手动配置 FPK 时自动探测（同一 NAS 的 18080 端口，FNOS 主页同主机）
  try {
    const origin = s.origin || '';
    let host = '';
    try { host = new URL(origin).hostname; } catch (_) {}
    if (!host) {
      console.log('[FPK] config check: no origin host', JSON.stringify({ origin }));
      return null;
    }
    if (__fpkAutoProbe && __fpkAutoProbe.base && (Date.now() - __fpkAutoProbe.at < 60000)) {
      return __fpkAutoProbe.base;
    }
    const base = `http://${host}:18080`;
    console.log('[FPK] config check: auto-probe', JSON.stringify({ origin, base }));
    // 异步探测并缓存；同步场景先乐观返回 base，探测失败由 refreshFpkApps 兜底置空
    if (!__fpkProbeInFlight) {
      __fpkProbeInFlight = (async () => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 4000);
          const resp = await fetch(`${base}/api/health`, { signal: ctrl.signal, headers: { 'X-FNOS-Client': 'desktop' } });
          clearTimeout(timer);
          if (resp.ok) {
            __fpkAutoProbe = { base, at: Date.now() };
            // 自动写回设置，后续 getFpkBaseUrl 直接命中手动配置分支
            saveSettings({ fpkApi: { enabled: true, host, port: 18080 } });
            console.log('[FPK] auto-probe success', JSON.stringify({ base }));
            return base;
          }
        } catch (_) {}
        console.log('[FPK] auto-probe failed', JSON.stringify({ base }));
        return null;
      })().finally(() => { __fpkProbeInFlight = null; });
    }
    return base;
  } catch (_) { return null; }
}
// v2.3.0: 通用 URL 抓取为 Buffer（Electron 主进程 fetch 无 CORS 限制，跟随 302 重定向）
async function __fetchBuf(url, opts) {
  try {
    const res = await fetch(url, Object.assign({ headers: { 'X-FNOS-Client': 'desktop' } }, opts || {}));
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (_) { return null; }
}

async function fetchFpkIcon(appname, size = 256) {
  const base = getFpkBaseUrl();
  if (!base) {
    console.log('[FPK] icon fetch skipped: FPK API not enabled');
    return null;
  }
  // v2.2.4：加 cache-busting（t=时间戳 + v=应用版本）——fntb 此前返回 max-age=3600
  // 缓存头导致修改图标后客户端/浏览器仍命中旧缓存，强制刷新也不变。
  // 服务端对带 t/v 参数的请求返回 no-cache，保证最新图标；列表 5 分钟 TTL 不受影响。
  // v2.3.4: 追加 nas_host 参数 + X-Forwarded-Host 头，让 fntb 在反代/容器场景下构造客户端可达的 302 目标（避免 127.0.0.1 回环）。
  const t = Date.now();
  const v = Math.floor(t / 60000); // 每分钟一档，缩短 URL 长度且足够新鲜
  let nasHost = "";
  try {
    const _s = loadSettings();
    nasHost = (_s.fpkApi && _s.fpkApi.host) || "";
    if (!nasHost && _s.origin) { try { nasHost = new URL(_s.origin).hostname; } catch (_) {} }
  } catch (_) {}
  let url = `${base}/api/icons/${encodeURIComponent(appname)}/${size}?t=${t}&v=${v}`;
  if (nasHost) url += `&nas_host=${encodeURIComponent(nasHost)}`;
  const headers = { "X-FNOS-Client": "desktop", "Cache-Control": "no-cache" };
  if (nasHost) headers["X-Forwarded-Host"] = `${nasHost}:18080`;
  console.log("[FPK] icon fetch start", JSON.stringify({ appname, size, url, nasHost }));
  try {
    const res = await fetch(url, { headers });
    console.log("[FPK] icon fetch response", JSON.stringify({ appname, status: res.status, ok: res.ok }));
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    console.log("[FPK] icon fetch success", JSON.stringify({ appname, bytes: buf.length }));
    // v2.1.19: 空 body 视为无图标，避免上层把空 buffer 当成功继续转 ICO
    if (!buf.length) return null;
    return buf;
  } catch (err) {
    console.log("[FPK] icon fetch error", JSON.stringify({ appname, error: err.message }));
    return null;
  }
}
async function fetchFpkAppList(nasHost) {
  const base = getFpkBaseUrl();
  if (!base) {
    console.log('[FPK] appList fetch skipped: FPK API not enabled');
    return null;
  }
  try {
    const url = nasHost ? `${base}/api/client/apps?nas_host=${encodeURIComponent(nasHost)}` : `${base}/api/client/apps`;
    console.log('[FPK] appList fetch start', JSON.stringify({ nasHost, url }));
    const res = await fetch(url, { headers: { 'X-FNOS-Client': 'desktop' } });
    console.log('[FPK] appList fetch response', JSON.stringify({ status: res.status, ok: res.ok }));
    if (!res.ok) return null;
    const data = await res.json();
    const count = (data?.list || []).length;
    console.log('[FPK] appList fetch success', JSON.stringify({ appCount: count }));
    return data?.list || [];
  } catch (err) {
    console.log('[FPK] appList fetch error', JSON.stringify({ error: err.message }));
    return null;
  }
}

// ---- v2.1.18: FPK 应用列表缓存 + URL→应用名映射 ----
let __fpkApps = [];
let __fpkAppsAt = 0;
const FPK_APPS_TTL = 5 * 60 * 1000; // 5分钟缓存

// 刷新 FPK 应用列表（懒加载，带 TTL 缓存）
async function refreshFpkApps(force) {
  try {
    const now = Date.now();
    if (!force && __fpkApps.length && (now - __fpkAppsAt < FPK_APPS_TTL)) return __fpkApps;
    let nasHost = '';
    try {
      const s = loadSettings();
      nasHost = s.fpkApi?.host || '';
      if (!nasHost) { try { nasHost = s.origin ? new URL(s.origin).hostname : ''; } catch (_) {} }
    } catch (_) {}
    const list = await fetchFpkAppList(nasHost);
    if (Array.isArray(list) && list.length) {
      __fpkApps = list;
      __fpkAppsAt = now;
      dlog && dlog('info', 'fpk.applist', { count: list.length, host: nasHost });
    }
    return __fpkApps;
  } catch (_) { return __fpkApps; }
}

// 从应用 URL 反推 FPK 应用名（name），用于图标查询
// v2.2.4：
//   1) 增加 app- 前缀归一化（'/app-baidu-netdisk' ↔ FPK 列表 'baidu.netdisk'）；
//   2) 单字符路径（如 '/p'）不再作为有效 appname（此前误判导致 /api/icons/p/256 404）；
//   3) 路径首段与 name 做模糊匹配（首段去掉 app-/尾缀后比对 name 前缀/包含）。
function fpkAppNameFromUrl(url) {
  try {
    if (!url) {
      console.log('[FPK] name resolve skipped', JSON.stringify({ url: '', fpkCount: __fpkApps.length }));
      return '';
    }
    const u = new URL(url);
    const pathLower = (u.pathname || '').replace(/\/+$/, '');
    let anchor = '';
    try { anchor = decodeURIComponent(u.searchParams.get('anchor') || ''); } catch (_) {}
    const seg = (u.pathname || '').split('/').filter(Boolean).pop() || '';
    // 候选名生成：anchor 优先，其次路径末段；单字符视为无效
    const mkCandidate = () => {
      const raw = anchor || seg || '';
      if (raw.length < 2) return '';
      return raw;
    };
    // v2.3.0: 列表未加载时也从 URL 直接提取 appname（anchor 优先，其次路径末段），
    // 避免 FPK 列表加载失败导致 appname 恒为空、图标查询退化为窗口名造成 404
    if (!__fpkApps.length) {
      const guess = mkCandidate();
      console.log('[FPK] name resolve (no list)', JSON.stringify({ url: String(url).slice(0, 100), anchor, seg, guess }));
      return guess;
    }
    let bestMatch = '';
    let bestScore = 0;
    // path 首段（如 'app-baidu-netdisk'、'baidu.netdisk'、'music'）
    const firstSeg = (pathLower || '').split('/').filter(Boolean)[0] || '';
    const firstSegNorm = String(firstSeg).replace(/^app[-_.]/i, '').replace(/^trim[-_.]/i, '').toLowerCase();
    for (const a of __fpkApps) {
      const aName = a.name || '';
      if (!aName) continue;
      const aPath = (a.path || '/').replace(/\/+$/, '');
      const aUrl = a.url || '';
      const aNameLower = String(aName).toLowerCase();
      let score = 0;
      // v2.2.7: 端口匹配。外部端口窗口（如 :34600/:8085/:5666）URL 解析不出 appname，
      // 用 FPK 列表的 port 字段反查，修复 no-fpk-name 导致任务栏图标缺失/回退默认图标。
      if (score === 0 && u.port && a.port) {
        const aPorts = Array.isArray(a.port) ? a.port : [a.port];
        if (aPorts.some((pt) => String(pt) === String(u.port))) {
          score = 88;
        }
      }
      if (anchor && (anchor === aName || anchor === (a.applaunchname || aName))) {
        score = 100;
      } else if (aUrl && aUrl === url) {
        score = 90;
      } else if (aPath && aPath !== '/' && pathLower && (pathLower === aPath || pathLower.startsWith(aPath + '/'))) {
        score = 80;
      } else if (aPath && aPath !== '/' && pathLower === aPath) {
        score = 70;
      }
      // v2.2.4：首段归一化比对——覆盖 app-baidu-netdisk → baidu.netdisk 场景
      if (score === 0 && firstSegNorm && firstSegNorm.length >= 2) {
        const aNorm = aNameLower.replace(/^app[-_.]/i, '').replace(/^trim[-_.]/i, '').replace(/[-_.]/g, '');
        const fNorm = firstSegNorm.replace(/[-_.]/g, '');
        if (aNorm === fNorm) score = 85;
        else if (aNorm && fNorm && (aNorm.startsWith(fNorm) || fNorm.startsWith(aNorm)) && Math.min(aNorm.length, fNorm.length) >= 4) score = 65;
      }
      if (score > bestScore) { bestScore = score; bestMatch = aName; }
    }
    // v2.2.0: 匹配过程日志
    console.log('[FPK] name resolve result', JSON.stringify({
      url: String(url).slice(0, 100), anchor, pathLower, firstSeg, firstSegNorm,
      match: bestMatch || '', score: bestScore,
      candidates: __fpkApps.map((a) => `${a.name}|${a.path || ''}|${a.url || ''}`).slice(0, 30),
    }));
    if (bestMatch) return bestMatch;
    return mkCandidate();
  } catch (_) { return ''; }
}

let __appCenterScanAt = 0;
let __appCenterScanWin = null;
let __appCenterScanResult = null; // v2.1.5: store scan results from postMessage

function scanAppCenterApps() {
  try {
    const s = loadSettings();
    const origin = s.origin || '';
    if (!origin || !/^https?:/i.test(origin)) {
      fnosLog('warn', 'appcenter.scan', { err: 'no origin' });
      return;
    }
    const now = Date.now();
    if (now - __appCenterScanAt < 60000) return;
    __appCenterScanAt = now;
    fnosLog('info', 'appcenter.scan', { msg: 'starting WebSocket scanner in main window', origin });

    // v2.1.5: Use mainWindow instead of hidden window to ensure same auth context
    if (!mainWindow || mainWindow.isDestroyed()) {
      fnosLog('warn', 'appcenter.scan', { err: 'no mainWindow available' });
      return;
    }

    try {
      mainWindow.webContents.executeJavaScript(__WS_SCANNER_JS, true);
      fnosLog('info', 'appcenter.scan', { msg: 'WS scanner injected into main window' });
    } catch (e) {
      fnosLog('error', 'appcenter.scan', { err: 'inject: ' + e.message });
      return;
    }

    // v2.1.8：同时用 REST 拉取应用中心已安装应用（第三方应用，WS getEntryList 拿不到）
    scanAppCenterViaRest();

    // Poll for scan results via executeJavaScript
    let pollCount = 0;
    const maxPolls = 30; // 30 * 1.5s = 45s timeout
    const pollInterval = setInterval(() => {
      pollCount++;
      if (pollCount >= maxPolls) {
        clearInterval(pollInterval);
        fnosLog('warn', 'appcenter.scan', { err: 'scan timeout after 45s' });
        return;
      }
      try {
        mainWindow.webContents.executeJavaScript(
          'JSON.stringify({s:window.__fnosWsScanStatus||"",a:window.__fnosWsScanApps||[],e:window.__fnosWsScanError||""})',
          true
        ).then((result) => {
          try {
            const r = JSON.parse(result);
            if (r.s === 'done' || r.s === 'error') {
              clearInterval(pollInterval);
              if (r.e) {
                fnosLog('warn', 'appcenter.scan', { error: r.e });
              }
              if (Array.isArray(r.a) && r.a.length) {
                fnosLog('info', 'appcenter.scan', {
                  count: r.a.length,
                  apps: r.a.map(a => a.name + '|' + (a.type || '') + '|' + (a.url || '').slice(0, 60)).slice(0, 20)
                });
                processScannedApps(r.a);
              } else if (r.s === 'done') {
                fnosLog('warn', 'appcenter.scan', { err: 'scan completed but no apps found' });
              }
            } else if (r.s === 'connecting' || r.s === 'connected') {
              fnosLog('info', 'appcenter.scan', { status: r.s, poll: pollCount });
            }
          } catch (e) {
            fnosLog('error', 'appcenter.scan', { err: 'parse result: ' + e.message });
          }
        }).catch((e) => {
          fnosLog('error', 'appcenter.scan', { err: 'poll: ' + e.message });
        });
      } catch (e) {
        clearInterval(pollInterval);
        fnosLog('error', 'appcenter.scan', { err: 'poll outer: ' + e.message });
      }
    }, 1500);
  } catch (e) {
    fnosLog('error', 'appcenter.scan', { err: e.message, stack: e.stack });
  }
}


function getAccounts() {
  const s = loadSettings();
  return Array.isArray(s.accounts) ? s.accounts : [];
}

function saveAccounts(accounts) {
  try {
    saveSettings({ accounts });
    fnosLog('info', 'account', '账号列表已更新', { count: accounts.length });
    return { success: true, msg: '' };
  } catch (e) {
    fnosLog('error', 'account', '保存账号列表失败', { err: e.message, stack: e.stack });
    return { success: false, msg: e.message };
  }
}

// 登录成功后调用：将当前连接信息加入账号列表
function upsertAccount(serverInput, parsed) {
  try {
    const accounts = getAccounts();
    const key = parsed.origin || parsed.href;
    const partition = partitionForServer(parsed);
    const idx = accounts.findIndex(a => a.origin === key);
    
    const entry = {
      id: 'acct_' + crypto.createHash('md5').update(key).digest('hex').slice(0, 12),
      label: parsed.isFnId ? `FN ID: ${parsed.fnId}` : serverInput.trim(),
      origin: parsed.origin,
      href: parsed.href,
      partition,
      lastConnectedAt: Date.now(),
      isActive: true,
    };
    
    // 将所有账号设为非活跃，当前账号设为活跃
    accounts.forEach(a => a.isActive = false);
    
    if (idx >= 0) {
      accounts[idx] = { ...accounts[idx], ...entry };
    } else {
      accounts.push(entry);
    }
    
    saveAccounts(accounts);
    saveSettings({ activeAccountOrigin: key });
    fnosLog('info', 'account', '账号已记录', { origin: key, label: entry.label });
  } catch (e) {
    fnosLog('error', 'account', 'upsertAccount失败', { err: e.message });
  }
}

// 切换账号：切换到指定 origin 的账号
function switchAccount(targetOrigin) {
  try {
    const accounts = getAccounts();
    const target = accounts.find(a => a.origin === targetOrigin);
    if (!target) {
      fnosLog('warn', 'account', '切换账号失败：未找到目标账号', { targetOrigin });
      return { success: false, msg: '未找到该账号' };
    }
    
    // 更新活跃状态
    accounts.forEach(a => a.isActive = (a.origin === targetOrigin));
    saveAccounts(accounts);
    saveSettings({ activeAccountOrigin: targetOrigin, currentPartition: target.partition });
    
    fnosLog('info', 'account', '切换账号', { origin: targetOrigin, label: target.label, href: (target.href || '').slice(0, 120), partition: target.partition });

    // v2.3.2: 重置 FNID 检测页自动跳转防重标记——否则切回同一 FNID 账号时
    // __fnidAutoNavDone 仍等于该检测页 URL，did-finish-load 的 detect-page 直接
    // return，卡在 fnos.net 无法跳转到 NAS（用户反馈"切换账号后无法跳转"的根因）。
    if (target.origin === 'https://fnos.net' || /^https:\/\/fnos\.net\//i.test(String(target.href || ''))) {
      global.__fnidAutoNavDone = '';
      fnosLog('info', 'account', 'FNID 切换：已重置 auto-nav 防重标记', { origin: target.origin });
    }

    // 重建主窗口使用目标 partition
    currentPartition = target.partition;
    currentOrigin = target.origin;
    lastConnectHref = target.href;
    createMainWindow(target.partition, { origin: target.origin, href: target.href });
    
    return { success: true, msg: '切换成功' };
  } catch (e) {
    fnosLog('error', 'account', 'switchAccount失败', { err: e.message, stack: e.stack });
    return { success: false, msg: e.message };
  }
}

// 移除账号
function removeAccount(accountId) {
  try {
    const accounts = getAccounts();
    const target = accounts.find(a => a.id === accountId);
    if (!target) {
      return { success: false, msg: '未找到该账号' };
    }
    
    const wasActive = target.isActive;
    const filtered = accounts.filter(a => a.id !== accountId);
    saveAccounts(filtered);
    
    // 清除该 partition 的 session 数据
    try {
      const ses = session.fromPartition(target.partition);
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
    } catch (_) {}
    
    fnosLog('info', 'account', '账号已移除', { accountId, origin: target.origin });
    
    // 如果移除的是当前活跃账号，跳转到连接页
    if (wasActive) {
      saveSettings({ activeAccountOrigin: '', currentPartition: 'persist:connect' });
      showConnectPage();
    }
    
    return { success: true, msg: '移除成功' };
  } catch (e) {
    fnosLog('error', 'account', 'removeAccount失败', { err: e.message, stack: e.stack });
    return { success: false, msg: e.message };
  }
}

// 多账号 IPC
ipcMain.handle('account:list', async () => {
  try {
    const accounts = getAccounts();
    fnosLog('info', 'ipc', 'account:list', { count: accounts.length });
    return { success: true, msg: '', data: accounts };
  } catch (e) {
    fnosLog('error', 'ipc', 'account:list error', { err: e.message });
    return { success: false, msg: e.message, data: [] };
  }
});

ipcMain.handle('account:switch', async (_e, { origin }) => {
  try {
    fnosLog('info', 'ipc', 'account:switch', { origin });
    return switchAccount(origin);
  } catch (e) {
    fnosLog('error', 'ipc', 'account:switch error', { err: e.message });
    return { success: false, msg: e.message };
  }
});

ipcMain.handle('account:remove', async (_e, { accountId }) => {
  try {
    fnosLog('info', 'ipc', 'account:remove', { accountId });
    return removeAccount(accountId);
  } catch (e) {
    fnosLog('error', 'ipc', 'account:remove error', { err: e.message });
    return { success: false, msg: e.message };
  }
});

ipcMain.handle('account:get-active', async () => {
  try {
    const accounts = getAccounts();
    const active = accounts.find(a => a.isActive) || null;
    return { success: true, msg: '', data: active };
  } catch (e) {
    return { success: false, msg: e.message, data: null };
  }
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
    // v1.52.0：自定义标题栏自动隐藏（鼠标移到窗口顶部显示）。false = 标题栏常驻显示（默认）
    titleBarAutoHide: s.titleBarAutoHide === undefined ? false : !!s.titleBarAutoHide,
    // v1.58：标题栏材质/不透明度/磨砂程度/颜色（标题栏颜色独立于界面主题色）
    titleBarMaterial: s.titleBarMaterial === 'frosted' ? 'frosted' : 'transparent',
    titleBarOpacity: clampInt(s.titleBarOpacity, 0, 100, 0),
    titleBarBlur: clampInt(s.titleBarBlur, 0, 40, 12),
    titleBarColor: String(s.titleBarColor || '#3B82F6'),
    themeColor: String(s.themeColor || '#4F6EF7'),
    // v1.16.1：无操作自动锁定（分钟），0 = 关闭；仅在已设置启动密码时生效
    autoLockMinutes: clampInt(s.autoLockMinutes, 0, 240, 0),
    // v2.1.11：快捷方式打开应用后主程序后台化方式
    shortcutHideMode: s.shortcutHideMode === 'minimize' ? 'minimize' : 'tray',
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
    // v2.1.17：FPK 图标管理器 API 配置
    fpkApi: {
      enabled: !!s.fpkApi?.enabled,
      host: s.fpkApi?.host || '',
      port: s.fpkApi?.port || 18080,
    },
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

// v2.1.11：通过桌面快捷方式打开应用后，主程序后台化方式（'tray' 隐藏到托盘 | 'minimize' 最小化到任务栏）
ipcMain.handle('settings:set-shortcut-hide-mode', async (_e, mode) => {
  try {
    const next = String(mode || '') === 'minimize' ? 'minimize' : 'tray';
    saveSettings({ shortcutHideMode: next });
    cachedSettings.shortcutHideMode = next;
    return { ok: true, mode: next };
  } catch (err) {
    return { ok: false, error: err?.message || '保存失败' };
  }
});

// v2.1.17：FPK 图标管理器 API 配置
ipcMain.handle('settings:set-fpk-api', (_e, patch) => {
  const s = loadSettings();
  s.fpkApi = { ...(s.fpkApi || {}), ...(patch || {}) };
  saveSettings(s);
  return { ok: true, fpkApi: s.fpkApi };
});
ipcMain.handle('settings:test-fpk-api', async (_e) => {
  const s = loadSettings();
  if (!s.fpkApi?.host) return { ok: false, error: '未配置 FPK 服务地址' };
  const baseUrl = `http://${s.fpkApi.host}:${s.fpkApi.port || 18080}`;
  try {
    // v2.2.4：连接检测修复——客户端测试连接时也带 X-FNOS-Client 头请求 /api/client/status，
    // 让 FPK 图标管理器的"PC客户端连接"状态能识别到本客户端（此前 /api/health 无客户端标识，
    // fntb 只认 300s 窗口内的 X-FNOS-Client 请求，导致客户端显示已连接、图标管理器显示未连接）。
    const res = await fetch(`${baseUrl}/api/client/status`, { headers: { 'X-FNOS-Client': 'desktop' } });
    const data = await res.json();
    if (data?.status === 'running') return { ok: true, version: data.version };
    return { ok: false, error: '服务响应异常' };
  } catch (err) {
    return { ok: false, error: err.message || '连接失败' };
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
    // v1.54/v1.58：标题栏自动隐藏（默认 false=常驻）+ 材质/不透明度/磨砂/颜色
    const tbAutoHide = opts && typeof opts.titleBarAutoHide === 'boolean' ? opts.titleBarAutoHide : (cachedSettings.titleBarAutoHide === true);
    const tbMaterial = opts?.titleBarMaterial === 'frosted' ? 'frosted' : (cachedSettings.titleBarMaterial === 'frosted' ? 'frosted' : 'transparent');
    const tbOpacity = opts && opts.titleBarOpacity != null && Number.isFinite(Number(opts.titleBarOpacity))
      ? clampInt(opts.titleBarOpacity, 0, 100, 0)
      : clampInt(cachedSettings.titleBarOpacity, 0, 100, 0);
    const tbBlur = opts && opts.titleBarBlur != null && Number.isFinite(Number(opts.titleBarBlur))
      ? clampInt(opts.titleBarBlur, 0, 40, 12)
      : clampInt(cachedSettings.titleBarBlur, 0, 40, 12);
    const tbColor = opts?.titleBarColor ? String(opts.titleBarColor) : String(cachedSettings.titleBarColor || '#3B82F6');
    const accent = String(opts?.themeColor || cachedSettings.themeColor || '#4F6EF7');
    saveSettings({
      autoHideMenuBar: autoHide,
      titleBarAutoHide: tbAutoHide,
      titleBarMaterial: tbMaterial,
      titleBarOpacity: tbOpacity,
      titleBarBlur: tbBlur,
      titleBarColor: tbColor,
      themeColor: accent,
    });
    cachedSettings.autoHideMenuBar = autoHide;
    cachedSettings.titleBarAutoHide = tbAutoHide;
    cachedSettings.titleBarMaterial = tbMaterial;
    cachedSettings.titleBarOpacity = tbOpacity;
    cachedSettings.titleBarBlur = tbBlur;
    cachedSettings.titleBarColor = tbColor;
    cachedSettings.themeColor = accent;
    // v1.58：广播【完整标题栏样式对象】（autoHide+material+opacity+blur+color）
    // 注意：必须是对象；历史上发裸布尔值会被 titlebar-inject 的对象守卫丢弃导致开关不生效
    const tbPayload = { autoHide: tbAutoHide, material: tbMaterial, opacity: tbOpacity, blur: tbBlur, color: tbColor };
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.setAutoHideMenuBar(autoHide);
        w.setMenuBarVisibility(!autoHide);
        try { w.webContents.send('settings:titlebar-changed', tbPayload); } catch (_) {}
      } catch (_) {}
    }
    // 同步到所有渲染进程（含 webview guest：飞牛桌面/FNDESK 内的应用窗）
    try {
      for (const wc of require('electron').webContents.getAllWebContents()) {
        try { if (wc && !wc.isDestroyed()) wc.send('settings:titlebar-changed', tbPayload); } catch (_) {}
      }
    } catch (_) {}
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

// v1.52.0：preload 注入自定义标题栏时同步读取标题栏自动隐藏设置
ipcMain.on('settings:get-titlebar', (e) => {
  try {
    const s = loadSettings();
    // v1.54/v1.58：默认【不】自动隐藏（常驻标题栏）；返回完整材质/颜色样式
    e.returnValue = {
      autoHide: s.titleBarAutoHide === undefined ? false : !!s.titleBarAutoHide,
      material: s.titleBarMaterial === 'frosted' ? 'frosted' : 'transparent',
      opacity: clampInt(s.titleBarOpacity, 0, 100, 0),
      blur: clampInt(s.titleBarBlur, 0, 40, 12),
      color: String(s.titleBarColor || '#3B82F6'),
    };
  } catch (_) {
    e.returnValue = { autoHide: false, material: 'transparent', opacity: 0, blur: 12, color: '#3B82F6' };
  }
});

ipcMain.on('settings:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.close();
});

// v2.2.5：查询当前窗口是否应跳过自定义标题栏注入。
// v2.2.4 曾对 XTE 设置 __skipTitlebar=true 导致标题栏完全消失，已在窗口创建处撤销；
// 现在所有窗口均返回 skip=false（始终注入自定义标题栏）。该 IPC 保留供未来按需跳过。
ipcMain.on('titlebar:should-inject', (e) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    const skip = !!(win && win.__skipTitlebar);
    e.returnValue = { skip, reason: skip ? 'app-has-own-titlebar' : '' };
  } catch (_) { e.returnValue = { skip: false, reason: '' }; }
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

// v2.2.5：判断是否为备案/政务垃圾链接（FNID 检测页 footer 固定出现；主页扫描可能误收录）
function isBadNavLink(input) {
  try {
    if (!input) return false;
    let hn = '';
    try { hn = new URL(input).hostname || ''; } catch (_) {
      // 非完整 URL（如 anchor=xxx）视为正常应用名，不是垃圾链接
      return false;
    }
    if (!hn) return false;
    return /(^|\.)beian\.miit\.gov\.cn$/i.test(hn) ||
           /(^|\.)beian\.gov\.cn$/i.test(hn) ||
           /(^|\.)conac\.cn$/i.test(hn) ||
           /(^|\.)gov\.cn$/i.test(hn) ||
           /(^|\.)12377\.cn$/i.test(hn) ||
           /(^|\.)12321\.cn$/i.test(hn) ||
           /(^|\.)12318\.cn$/i.test(hn) ||
           /(^|\.)12315\.cn$/i.test(hn) ||
           /(^|\.)miit\.gov\.cn$/i.test(hn);
  } catch (_) { return false; }
}

// v2.2.5：从 manifest 应用中过滤备案垃圾（FNID 跳错页后主页扫描可能写入）
function filterBadNavApps(apps) {
  if (!Array.isArray(apps)) return [];
  return apps.filter((a) => {
    try {
      const u = String(a.url || a.appId || '');
      return !isBadNavLink(u);
    } catch (_) { return true; }
  });
}

// v2.1.5: IPC handler for getting installed apps from manifest
// v2.2.5: 重写——以 FPK 图标管理器 client_apps 列表为唯一数据源（用户强调要求）：
//   * 列表 = FPK /api/client/apps（含系统应用+第三方应用+完整名字+高清图标）
//   * 名字 = FPK title（显示名，如"系统设置"），不再依赖被污染的 manifest
//   * 图标 = FPK icon_256 下载缓存（settings 页直接可用 file:// 显示）
//   * manifest 仅 FPK 不可用时兜底（过滤备案垃圾、补齐名字）
ipcMain.handle('get-installed-apps', async () => {
  try {
    const iconSes = (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed())
      ? mainWindow.webContents.session
      : null;
    const nasHost = (() => {
      try {
        const s = loadSettings();
        if (s.fpkApi?.host) return s.fpkApi.host;
        if (s.origin) { try { return new URL(s.origin).hostname; } catch (_) {} }
      } catch (_) {}
      return '';
    })();
    fnosLog('info', 'ipc', 'get-installed-apps', { source: 'fpk-primary', nasHost });

    // ── 1) FPK 列表优先（唯一数据源） ──
    const __fpkList = await refreshFpkApps(true);
    if (Array.isArray(__fpkList) && __fpkList.length) {
      const out = [];
      if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
      for (const f of __fpkList) {
        try {
          const fpkName = String((f && f.name) || '').trim();
          if (!fpkName) continue;
          const title = String((f && f.title) || fpkName).trim() || fpkName;
          // 下载 FPK 高清图标（256）到本地，settings 页 file:// 直接显示
          let iconPath = '';
          try {
            const __buf = await fetchFpkIcon(fpkName, 256);
            if (__buf && __buf.length > 100) {
              const __safe = 'fpklist_' + Buffer.from(fpkName).toString('base64url').slice(0, 40);
              iconPath = path.join(ASSETS_DIR, __safe + '.png');
              fs.writeFileSync(iconPath, __buf);
            }
          } catch (e) { fnosLog('warn', 'icon.fpk-list', { app: fpkName, err: e.message }); }
          out.push({
            appId: fpkName,                    // 快捷方式/启动锚点用飞牛 appname
            appName: title,                    // 设置页显示名
            name: title,
            title,
            nasAddress: nasHost,
            url: String((f && f.url) || ''),   // 完整 URL（打开用）
            port: String((f && f.port) || ''),
            path: String((f && f.path) || '/'),
            protocol: String((f && f.protocol) || 'http'),
            iconPath,
            iconData: String((f && (f.icon_256 || f.icon)) || ''),
            hasCustomIcon: !!(f && f.has_custom_icon),
            system: !!(f && f.system),
            fpkName,
            source: 'fpk',
          });
        } catch (_) {}
      }
      fnosLog('info', 'ipc', 'get-installed-apps.done', { count: out.length, source: 'fpk', names: out.map((a) => a.title).slice(0, 40) });
      try {
        fnosLog('info', 'ipc', 'get-installed-apps.detail', {
          apps: out.map((a) => ({
            appId: String(a.appId || '').slice(0, 60),
            name: String(a.name || '').slice(0, 40),
            hasIcon: !!(a.iconPath && fs.existsSync(a.iconPath)),
            iconUrl: String(a.iconData || '').slice(0, 80),
          })).slice(0, 50),
        });
      } catch (_) {}
      return { success: true, msg: '', data: out };
    }

    // ── 2) FPK 不可用 → manifest 兜底（过滤备案垃圾 + 名字补齐） ──
    fnosLog('warn', 'ipc', 'get-installed-apps', { msg: 'FPK list empty, fallback to manifest', fpkCount: (__fpkList || []).length });
    const manifest = readManifest();
    let apps = (manifest && Array.isArray(manifest.apps)) ? filterBadNavApps(manifest.apps) : [];
    // v2.1.12：图标补齐——复用主窗口 session 现场补齐缺失图标
    if (iconSes && apps.length) {
      let changed = false;
      try {
        if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
        for (const a of apps) {
          const iconUrl = a && (a.iconData || a.icon || '');
          if (!iconUrl || !/^https?:/i.test(iconUrl)) continue;
          const hasValidPath = a.iconPath && fs.existsSync(a.iconPath) && fs.statSync(a.iconPath).size > 100;
          if (hasValidPath) continue;
          const ext = iconUrl.split('?')[0].split('.').pop().toLowerCase();
          const validExt = ['png','jpg','jpeg','gif','svg','webp','ico'].includes(ext) ? ext : 'png';
          const safeName = Buffer.from(a.url || iconUrl).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
          const iconFile = path.join(ASSETS_DIR, safeName + '.' + validExt);
          if (fs.existsSync(iconFile) && fs.statSync(iconFile).size > 100) { a.iconPath = iconFile; changed = true; continue; }
          try {
            const resp = await iconSes.fetch(iconUrl, { credentials: 'include' });
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              if (buf.length > 100) {
                fs.writeFileSync(iconFile, buf);
                a.iconPath = iconFile;
                changed = true;
                fnosLog('info', 'icon.fill', 'icon filled', { app: a.appName || a.name, size: buf.length });
              }
            } else {
              fnosLog('warn', 'icon.fill', 'icon fill bad status', { app: a.appName || a.name, status: resp.status, url: String(iconUrl).slice(0, 120) });
            }
          } catch (e) { fnosLog('warn', 'icon.fill', 'icon fill error', { app: a.appName || a.name, err: e.message }); }
        }
      } catch (_) {}
      if (changed) { try { writeManifest({ apps }); } catch (_) {} }
    }
    // 名字补齐：name 为空时用 appId 反推显示名（trim.setting → 系统设置等）
    try {
      const __knownNames = {
        'trim.setting': '系统设置', 'trim.app-center': '应用中心', 'trim.docker': 'Docker',
        'trim.backup-and-sync': '备份', 'trim.log-center': '日志中心',
        'trim.file-manager.trash': '回收站', 'trim.resource-manager': '资源管理',
      };
      for (const a of apps) {
        if (!a.name && a.appId) a.name = __knownNames[a.appId] || a.appId;
        if (!a.appName) a.appName = a.name || a.appId || '';
        if (!a.title) a.title = a.name || a.appId || '';
        if (!a.nasAddress) a.nasAddress = nasHost;
      }
    } catch (_) {}
    fnosLog('info', 'ipc', 'get-installed-apps', { count: apps.length, source: 'manifest' });
    try {
      fnosLog('info', 'ipc', 'get-installed-apps.detail', {
        apps: apps.map((a) => ({
          appId: String(a.appId || '').slice(0, 60),
          name: String(a.name || '').slice(0, 40),
          hasIcon: !!(a.iconPath && fs.existsSync(a.iconPath)),
          iconUrl: String(a.icon || a.iconData || '').slice(0, 80),
        })).slice(0, 50),
      });
    } catch (_) {}
    return { success: true, msg: '', data: apps };
  } catch (e) {
    fnosLog('error', 'ipc', 'get-installed-apps error', { err: e.message });
    return { success: false, msg: e.message, data: [] };
  }
});

// v2.1.5: IPC handler for creating desktop shortcuts with proper icon handling
ipcMain.handle('create-desktop-shortcut', async (_e, payload) => {
  try {
    const { appId, appName, iconPath, nasAddress } = payload || {};
    // v2.4.0（需求第一部分-3）：IPC 收日志（含入参，敏感字段由 logger.js 脱敏）
    try { fnosLog('info', 'ipc', 'create-desktop-shortcut recv', { appId, appName, iconPath: String(iconPath || '').slice(0, 160), nasAddress }); } catch (_) {}
    if (!appId || !appName) return { success: false, msg: '缺少 appId 或 appName', data: null };
    // v2.3.2: 归一化 nasAddress——设置页传入的可能无协议头（如 192.168.31.101），
    // 拼 appview URL 必须带 http://，否则 Electron loadURL 当文件路径 -> chrome-error
    let __nasBase = String(nasAddress || '').trim().replace(/\/+$/, '');
    if (__nasBase && !/^https?:/i.test(__nasBase)) __nasBase = 'http://' + __nasBase;
    // v2.3.6: nasAddress 可能丢端口（旧设置页传裸 host），按 settings.origin 补正端口，
    // 否则快捷方式参数 --nas=host 启动后 appview 打到 80 端口（行为怪异/误判 external-app）
    try {
      const __stP = loadSettings();
      const __origP = String((__stP && __stP.origin) || '').trim();
      if (__origP && __nasBase) {
        const __oP = new URL(/^https?:/i.test(__origP) ? __origP : 'http://' + __origP);
        const __bP = new URL(__nasBase);
        if (__oP.hostname === __bP.hostname && __oP.port) {
          __nasBase = __oP.protocol + '//' + __oP.host;
          try { fnosLog('info', 'shortcut', 'shortcut.url.port-fixed', { from: String(nasAddress), to: __nasBase }); } catch (_) {}
        }
      }
    } catch (_) {}

    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    // v2.2.5：优先从 FPK 列表解析 launchUrl（设置页应用列表现以 FPK 为唯一数据源，
    // manifest 可能没有该 entry）。FPK 返回的 url 即真实打开地址（含端口/路径）。
    let launchUrl = appId;
    try {
      const __fpkL = await refreshFpkApps(false);
      if (Array.isArray(__fpkL) && __fpkL.length) {
        // v2.2.7: appId 可能是 URL（外部端口/应用页）或应用名，统一先按 name/url 双匹配，
        // 再回退到 fpkAppNameFromUrl 按端口/path 反查，确保快捷方式拿到的 launchUrl 指向真实应用。
        let __entry = null;
        if (appId && /^https?:/i.test(appId)) {
          const __nm = fpkAppNameFromUrl(appId);
          __entry = __fpkL.find((f) => f && f.name === __nm) || null;
        } else {
          __entry = __fpkL.find((f) => f && (f.name === appId || f.url === appId)) || null;
        }
        if (__entry && __entry.url && /^https?:/i.test(__entry.url)) {
          launchUrl = __entry.url;
          fnosLog('info', 'shortcut.url', 'FPK url resolved', { appId, name: __entry.name, url: launchUrl.slice(0, 140) });
          // v2.3.1: FPK client_apps 对系统应用（port 空、path=/）构造的 url 是 NAS
          // 根地址（http://nas/），直接当 launchUrl 会让系统应用快捷方式指向根地址
          // 而非真实应用入口。根地址型 url 做二次解析：manifest 真实 URL → 系统应用
          // 构造 /appview?anchor=name → fntb 自身用 FPK 服务地址（host:18080）。
          try {
            const __isRootUrl = (function (u) {
              try {
                const __pu = new URL(u);
                const __pp = String(__pu.pathname || '').replace(/\/+$/, '');
                return (__pp === '' || __pp === '/') && !__pu.port;
              } catch (_) { return false; }
            })(launchUrl);
            if (__isRootUrl) {
              let __fixedUrl = '';
              // 1) manifest 真实 URL（apps.scan 扫描得到 appview?anchor 或端口路径）
              try {
                const __mf2 = readManifest();
                const __me2 = (__mf2 && Array.isArray(__mf2.apps)) ? __mf2.apps.find((a) => a && (a.appId === __entry.name || a.name === __entry.name || a.url === launchUrl)) : null;
                if (__me2 && __me2.url && /^https?:/i.test(__me2.url) && !(function (u) {
                  try { const __p2 = new URL(u); const __pp2 = String(__p2.pathname || '').replace(/\/+$/, ''); return (__pp2 === '' || __pp2 === '/') && !__p2.port; } catch (_) { return true; }
                })(__me2.url)) {
                  __fixedUrl = __me2.url;
                }
              } catch (_) {}
              // 2) 系统应用（非 fntb 自身）：构造 appview 入口
              if (!__fixedUrl && (__entry.system || /^trim\./i.test(String(__entry.name || ''))) && !/^com\.fntb\.iconmgr$/i.test(String(__entry.name || ''))) {
                try {
                  const __base2 = __nasBase;
                  if (__base2) __fixedUrl = __base2 + '/appview?anchor=' + encodeURIComponent(__entry.name);
                } catch (_) {}
              }
              // 3) fntb 自身（com.fntb.iconmgr）：用 FPK 服务地址（host:18080）
              if (!__fixedUrl && /^com\.fntb\.iconmgr$/i.test(String(__entry.name || ''))) {
                try {
                  const __s3 = loadSettings();
                  const __h3 = (__s3 && __s3.fpkApi && __s3.fpkApi.host) ? 'http://' + __s3.fpkApi.host + ':' + (__s3.fpkApi.port || 18080) + '/' : '';
                  if (__h3) __fixedUrl = __h3;
                } catch (_) {}
              }
              if (__fixedUrl) {
                launchUrl = __fixedUrl;
                fnosLog('info', 'shortcut.url', 'root url re-resolved', { appId, name: __entry.name, from: String(__entry.url).slice(0, 100), to: launchUrl.slice(0, 140) });
              } else {
                fnosLog('warn', 'shortcut.url', 'root url cannot re-resolve', { appId, name: __entry.name, url: String(launchUrl).slice(0, 100) });
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    if (!launchUrl || launchUrl === appId) {
    try {
      const manifest = readManifest();
      const entry = manifest.apps.find(a => a.appId === appId || a.url === appId || a.name === appName);
      if (entry && entry.url) {
        if (/^https?:\/\//i.test(entry.url)) {
          launchUrl = entry.url;
          // v2.1.14：修复旧 manifest 中 url 含 anchor=https:// 的情况
          // appview 的 openAppFromAnchor 会在 anchor 前再加 https://，
          // 所以 anchor 值只能是应用名（如 trim.file-manager），不能含协议前缀
          if (entry.url.includes('/appview?anchor=') && entry.url.includes('https%3A%2F%2F')) {
            const anchorName = (entry.appId || '').replace(/^https?:\/\//i, '');
            if (anchorName) {
              launchUrl = __nasBase + '/appview?anchor=' + encodeURIComponent(anchorName);
            }
          }
        } else {
          launchUrl = entry.url;
        }
      } else {
        // v2.1.14：appId 可能含旧格式 https:// 前缀，去掉后作为 anchor
        const anchorName = (appId || '').replace(/^https?:\/\//i, '');
        if (anchorName) {
          launchUrl = __nasBase + '/appview?anchor=' + encodeURIComponent(anchorName);
        }
      }
    } catch (_) {}
    }

    // v2.4.0（需求 2.1 + 第一部分-1）：快捷方式图标强制优先从 FPK 图标管理器对应应用 ID
    // 实时拉取（每次创建快捷方式都重新获取，禁止本地缓存命中旧图）；FPK 无图标/拉取失败
    // 才回退 renderer 传入 iconPath / manifest 图标（PNG → ICO 转换供 .lnk 引用）。
    let icoPath = '';
    let resolvedIconPath = '';
    let fpkAppName = '';
    try { fpkAppName = appId && /^https?:/i.test(appId) ? fpkAppNameFromUrl(appId) : String(appId || ''); } catch (_) {}
    console.log('[FPK] shortcut icon: checking for FPK icon', JSON.stringify({ appId, appName, fpkAppName }));
    try { await refreshFpkApps(true); } catch (_) {}
    if (fpkAppName) {
      const fpkBuf = await fetchFpkIcon(fpkAppName, 256);
      if (fpkBuf && fpkBuf.length > 0) {
        try {
          const safeName = Buffer.from(String(appId)).toString('base64url').slice(0, 32);
          const fpkIconPath = path.join(ASSETS_DIR, `fpk_${safeName}.ico`);
          const icoBuf = pngToIco(fpkBuf);
          fs.writeFileSync(fpkIconPath, icoBuf);
          icoPath = fpkIconPath;
          fnosLog('info', 'icon.fpk', `FPK icon saved for ${appId}`, { appId, fpkAppName, icoPath, size: icoBuf.length });
          console.log('[FPK] shortcut icon: FPK icon saved', JSON.stringify({ appId, icoPath, size: icoBuf.length }));
        } catch (e) {
          fnosLog('warn', 'icon.fpk', 'FPK icon error', { err: e.message, stack: e.stack, appId, fpkAppName });
          console.log('[FPK] shortcut icon: FPK icon convert failed', JSON.stringify({ appId, error: e.message }));
        }
      } else {
        fnosLog('warn', 'icon.fpk', 'FPK icon not found', { appId, fpkAppName });
        console.log('[FPK] shortcut icon: no FPK icon found', JSON.stringify({ appId }));
      }
    }

    // v2.4.0：FPK 无图标时回退——renderer 传入 iconPath → manifest 图标
    if (!icoPath) {
      resolvedIconPath = iconPath || '';

      // If iconPath is empty, try to find it from manifest
      if (!resolvedIconPath) {
        try {
          const manifest = readManifest();
          const entry = manifest.apps.find(a => a.appId === appId || a.url === appId || a.name === appName);
          if (entry && entry.iconPath) resolvedIconPath = entry.iconPath;
        } catch (_) {}
      }

      // Convert PNG/JPG to ICO if needed
      if (resolvedIconPath && fs.existsSync(resolvedIconPath)) {
        try {
          const ext = path.extname(resolvedIconPath).toLowerCase();
          if (ext === '.ico') {
            icoPath = resolvedIconPath;
          } else {
            // Read the image file and convert to ICO
            const imgBuf = fs.readFileSync(resolvedIconPath);
            // Verify it's a valid PNG (starts with PNG signature)
            if (imgBuf.length > 8 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50) {
              const icoBuf = pngToIco(imgBuf);
              icoPath = resolvedIconPath.replace(/\.[^.]+$/, '.ico');
              fs.writeFileSync(icoPath, icoBuf);
              fnosLog('info', 'icon.convert', `PNG → ICO: ${path.basename(resolvedIconPath)}`, { from: resolvedIconPath, to: icoPath, size: icoBuf.length });
            } else {
              // Not a PNG, use as-is (Windows might still display it)
              icoPath = resolvedIconPath;
            }
          }
        } catch (e) {
          fnosLog('warn', 'icon.convert', 'icon convert error', { err: e.message, stack: e.stack, iconPath: resolvedIconPath });
          icoPath = resolvedIconPath;
        }
      }
    }

    // v2.4.0（需求 2.1）：快捷方式启动参数统一为 --launch-app={应用唯一 ID}（不再区分
    // 系统/第三方应用）。冷启动解析链 __resolveLaunchUrl：FPK 内存缓存 → manifest →
    // appview?anchor 兜底（v2.3.3 旧 --app=URL 快捷方式参数仍向后兼容解析）。
    let __launchName = '';
    try { __launchName = appId && /^https?:/i.test(appId) ? fpkAppNameFromUrl(appId) : String(appId || ''); } catch (_) {}
    if (!__launchName) __launchName = String(appId || '');
    const args = `--launch-app=${encodeURIComponent(__launchName)} --nas=${encodeURIComponent(__nasBase || nasAddress || '')}`;
    // v2.2.6：桌面路径用 app.getPath('desktop')——os.homedir()/Desktop 在 OneDrive
    // 桌面重定向、非英文系统或权限受限时桌面目录可能缺失/不可写，导致快捷方式创建失败。
    let desktop = '';
    try { desktop = app.getPath('desktop'); } catch (_) {}
    if (!desktop || !fs.existsSync(desktop)) desktop = path.join(os.homedir(), 'Desktop');
    if (desktop && !fs.existsSync(desktop)) { try { fs.mkdirSync(desktop, { recursive: true }); } catch (_) {} }
    // v2.4.0（需求 2.1/2.6-3）：桌面路径无法定位/创建失败 → 明确返回"桌面路径不存在"错误提示
    if (!desktop || !fs.existsSync(desktop)) {
      fnosLog('error', 'shortcut.path', 'desktop path unavailable', { desktopTried: String(desktop || ''), err: 'desktop path not found' });
      return { success: false, msg: '桌面路径不存在：请检查系统桌面目录配置', data: null };
    }
    // v2.2.6：appName 可能含 / : * ? " < > | 等 Windows 非法文件名字符，清洗后用于 lnk 文件名
    const lnkBaseName = String(appName || '应用').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '应用';
    const lnkPath = path.join(desktop, `${lnkBaseName}.lnk`);
    fnosLog('info', 'shortcut.path', 'shortcut creating', { desktop, lnkPath, appName, appId });

    // v2.4.8（用户反馈 7 秒开定案）：快捷方式目标改为 wscript 触发器脚本（毫秒级启动、无
    // 黑窗）——热路径直发 loopback HTTP 给常驻主程序走"模拟点击图标"链路（绕过 portable
    // 解压），主程序未运行时触发器脚本回落冷启动 exe（second-instance 兜底）。旧版 .lnk
    // （直指 exe）仍兼容走原链路。
    const __vbsPath = __ensureLauncherVbs();
    const __wscript = path.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'wscript.exe');
    const __lnkArgs = `//B //Nologo "${__vbsPath}" "${__launchName}" "${exePath}" "${__nasBase || nasAddress || ''}"`;
    fnosLog('info', 'shortcut.path', 'shortcut.lnk-wscript', { vbsPath: __vbsPath, appId, launchName: __launchName });
    const iconPs = icoPath ? `$sc.IconLocation = '${icoPath.replace(/'/g, "''")}'` : '';
    const ps = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}')
$sc.TargetPath = '${__wscript.replace(/'/g, "''")}'
$sc.Arguments = '${__lnkArgs.replace(/'/g, "''")}'
$sc.WorkingDirectory = '${path.dirname(exePath).replace(/'/g, "''")}'
$sc.Description = 'FNOS 应用: ${appName}'
${iconPs}
$sc.Save()
`;

    const result = cp.spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf-8', timeout: 15000, windowsHide: true });

    if (result.status === 0) {
      fnosLog('info', 'ipc', '快捷方式创建成功', { lnkPath, icoPath, launchUrl, appId, appName });
      // 需求 2.1 结果反馈弹窗：成功提示"桌面快捷方式已生成"
      return { success: true, msg: '桌面快捷方式已生成', data: { path: lnkPath } };
    } else {
      const __errText = String((result && (result.stderr || result.error)) || '');
      fnosLog('error', 'ipc', '快捷方式创建失败', { lnkPath, appId, appName, stderr: __errText.slice(0, 500) });
      // 需求 2.1/2.6-3：失败区分错误原因（权限不足 → 对应提示，渲染进程据此弹窗）
      let __msg = __errText.slice(0, 300) || '创建失败';
      if (/拒绝访问|access\s*is\s*denied|0x80070005|EPERM|EACCES|unauthorized/i.test(__errText)) {
        __msg = '权限不足：无法写入桌面快捷方式，请以管理员权限重试';
      }
      return { success: false, msg: __msg, data: null };
    }
  } catch (e) {
    fnosLog('error', 'ipc', 'create-desktop-shortcut error', { err: e.message, stack: e.stack, appId: String((payload && payload.appId) || '').slice(0, 120) });
    // 需求 2.1/2.6-3：权限不足 / 桌面路径不存在 分类返回（渲染进程据此弹窗）
    const code = String((e && e.code) || '');
    let msg = String(e.message || e).slice(0, 300);
    if (code === 'EACCES' || code === 'EPERM' || /拒绝访问|access\s*is\s*denied/i.test(msg)) {
      msg = '权限不足：无法创建桌面快捷方式';
    } else if (code === 'ENOENT' && /desktop/i.test(String((e && e.path) || msg))) {
      msg = '桌面路径不存在：请检查系统桌面目录配置';
    }
    return { success: false, msg, data: null };
  }
});

// ---------------------- v2.4.8 秒开触发通道（loopback HTTP + wscript 触发器） ------------------
// 用户反馈 7 定案（2026-09-23）：快捷方式直启 portable exe 需完整自解压 app.asar 到随机
// Temp 目录（diag 日志实证），第二实例冷启动成为"比主程序内点击慢 20 多倍"的真正来源；
// 程序内链路实测仅 15ms（锁判断 -> icon-clicked -> appwin.create 全程）。
// 全网调研结论（Electron 官方 performance 文档 / Postman、Inkdrop 启动优化实践 / VS Code
// 单实例实现）：V8 snapshot、require 延迟、代码打包等框架级优化只能省数百 ms，无法消除
// portable 解压固有成本；主流桌面软件（微信/QQ）标准做法 = 轻量触发器 + 本地通道直通
// 常驻主程序。方案：主进程 loopback HTTP 服务（仅 127.0.0.1，随机端口 + 每次启动随机
// token 鉴权）；快捷方式 .lnk 指向 wscript.exe（毫秒级启动、无黑窗）执行触发器脚本 ->
// POST 触发信号 -> 本块 -> __notifyOpenFpkApp -> 渲染进程模拟点击图标（真实点击等价
// 链路不变）。兜底：端点文件缺失 / 发送失败（主程序未运行）-> 触发器脚本回落冷启动
// exe --launch-app=（原 second-instance 链路完整保留，旧版 .lnk 亦兼容）。
const __LAUNCH_ENDPOINT_FILE = () => path.join(app.getPath('userData'), 'fnos-launch-endpoint.txt');
let __launchHttpServer = null;
let __launchPort = 0;
let __launchToken = '';
// 写出触发器脚本（ASCII-only VBScript 避免 ANSI/UTF-8 编码歧义；入参：appId, exePath, nasBase）
function __ensureLauncherVbs() {
  try {
    const vbsPath = path.join(app.getPath('userData'), 'fnos-launcher.vbs');
    const vbs = [
      "' FNOS fast launcher v2.4.8 (generated, do not edit)",
      "Dim appId, exePath, nasBase, fso, base, ep, port, token, http, url, body, ok, sh, cmd, tf",
      "If WScript.Arguments.Count < 1 Then WScript.Quit 1",
      "appId = WScript.Arguments(0)",
      "exePath = \"\": nasBase = \"\"",
      "If WScript.Arguments.Count > 1 Then exePath = WScript.Arguments(1)",
      "If WScript.Arguments.Count > 2 Then nasBase = WScript.Arguments(2)",
      "ok = False",
      "Set fso = CreateObject(\"Scripting.FileSystemObject\")",
      "base = fso.GetParentFolderName(WScript.ScriptFullName)",
      "ep = base & \"\\fnos-launch-endpoint.txt\"",
      "If fso.FileExists(ep) Then",
      "  On Error Resume Next",
      "  Set tf = fso.OpenTextFile(ep, 1)",
      "  If Err.Number = 0 Then",
      "    port = Trim(tf.ReadLine): token = Trim(tf.ReadLine): tf.Close",
      "    Set http = CreateObject(\"MSXML2.ServerXMLHTTP\")",
      "    If Err.Number = 0 Then",
      "      http.setTimeouts 300, 300, 1000, 1000",
      "      url = \"http://127.0.0.1:\" & port & \"/launch\"",
      "      body = \"app=\" & appId & \"&token=\" & token",
      "      http.open \"POST\", url, False",
      "      http.setRequestHeader \"Content-Type\", \"application/x-www-form-urlencoded\"",
      "      http.send body",
      "      If Err.Number = 0 Then If http.status = 200 Then ok = True",
      "    End If",
      "  End If",
      "  On Error GoTo 0",
      "End If",
      "If ok Then WScript.Quit 0",
      "If exePath = \"\" Then WScript.Quit 1",
      "Set sh = CreateObject(\"WScript.Shell\")",
      "cmd = \"\"\"\" & exePath & \"\"\" --launch-app=\" & appId",
      "If nasBase <> \"\" Then cmd = cmd & \" --nas=\" & nasBase",
      "sh.Run cmd, 1, False",
      "WScript.Quit 0",
      ""
    ].join('\r\n');
    fs.writeFileSync(vbsPath, vbs, 'ascii');
    return vbsPath;
  } catch (_) { return ''; }
}
function __startLaunchServer() {
  try {
    const __http = require('http');
    __launchHttpServer = __http.createServer((req, res) => {
      if (req.method !== 'POST' || String(req.url || '').split('?')[0] !== '/launch') { try { res.writeHead(404); res.end(); } catch (_) {} return; }
      let body = '';
      req.on('data', (c) => { body += String(c); if (body.length > 2048) { try { req.destroy(); } catch (_) {} } });
      req.on('end', () => {
        try {
          const q = new URLSearchParams(body);
          const token = String(q.get('token') || '');
          const appId = String(q.get('app') || '').slice(0, 200);
          if (!__launchToken || token !== __launchToken) {
            try { require('./logger.js').log('warn', 'launch', 'launch.http auth-fail', { params: { appId: appId.slice(0, 80) } }, __RUN_MODE); } catch (_) {}
            try { res.writeHead(403); res.end(); } catch (_) {}
            return;
          }
          let nas = '';
          try { const __st = loadSettings(); nas = String((__st && __st.origin) || ''); } catch (_) {}
          const u = __resolveLaunchUrl(appId, nas);
          if (u && /^https?:/i.test(u)) {
            __notifyOpenFpkApp(appId, true, u);
            try { require('./logger.js').log('info', 'launch', 'launch.http trigger', { params: { appId: appId.slice(0, 120), url: String(u).slice(0, 160) } }, __RUN_MODE); } catch (_) {}
            try { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); } catch (_) {}
          } else {
            __notifyOpenFpkApp(appId, false);
            try { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('resolve-fail'); } catch (_) {}
          }
        } catch (e) {
          try { res.writeHead(500); res.end(); } catch (_) {}
        }
      });
    });
    __launchHttpServer.on('error', () => {});
    __launchHttpServer.listen(0, '127.0.0.1', () => {
      try {
        __launchPort = __launchHttpServer.address().port;
        __launchToken = require('crypto').randomBytes(24).toString('hex');
        fs.writeFileSync(__LAUNCH_ENDPOINT_FILE(), [String(__launchPort), String(__launchToken), String(process.execPath), String((loadSettings() && loadSettings().origin) || '')].join('\r\n'), 'utf-8');
        require('./logger.js').log('info', 'launch', 'launch.http listen', { params: { port: __launchPort } }, __RUN_MODE);
      } catch (_) {}
    });
  } catch (_) {}
}
if (__gotSingleLock) { try { app.whenReady().then(() => { setTimeout(__startLaunchServer, 0); }); } catch (_) {} }


// v2.1.5: IPC handler for uninstalling a NAS app (remove from manifest + delete shortcut + delete icon)
ipcMain.handle('uninstall-nas-app', async (_e, payload) => {
  try {
    const { appId } = payload || {};
    if (!appId) return { success: false, msg: '缺少 appId' };

    const manifest = readManifest();
    const appIndex = manifest.apps.findIndex(a => a.appId === appId || a.url === appId);
    if (appIndex === -1) {
      return { success: false, msg: '未找到该应用' };
    }

    const appInfo = manifest.apps[appIndex];
    const appName = appInfo.appName || appInfo.name || appId;

    // Remove from manifest
    manifest.apps.splice(appIndex, 1);
    writeManifest(manifest);

    // Also remove from settings.apps
    try {
      const s = loadSettings();
      if (Array.isArray(s.apps)) {
        s.apps = s.apps.filter(a => a.appId !== appId && a.url !== appId);
        saveSettings(s);
        try { cachedSettings.apps = s.apps; } catch (_) {}
      }
    } catch (_) {}

    // Delete desktop shortcut
    try {
      // v2.2.6：与创建路径一致——app.getPath('desktop') 优先（OneDrive 重定向兼容）
      let desktop = '';
      try { desktop = app.getPath('desktop'); } catch (_) {}
      if (!desktop || !fs.existsSync(desktop)) desktop = path.join(os.homedir(), 'Desktop');
      const lnkName = String(appName || '应用').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '应用';
      const lnkPath = path.join(desktop, lnkName + '.lnk');
      if (fs.existsSync(lnkPath)) {
        fs.unlinkSync(lnkPath);
        fnosLog('info', 'uninstall', '已删除桌面快捷方式', { lnkPath });
      }
    } catch (_) {}

    // Delete icon file
    try {
      if (appInfo.iconPath && fs.existsSync(appInfo.iconPath)) {
        fs.unlinkSync(appInfo.iconPath);
        // Also try to delete .ico version
        const icoPath = appInfo.iconPath.replace(/\.[^.]+$/, '.ico');
        if (icoPath !== appInfo.iconPath && fs.existsSync(icoPath)) {
          fs.unlinkSync(icoPath);
        }
      }
    } catch (_) {}

    fnosLog('info', 'uninstall', '应用已卸载', { appId, appName });
    return { success: true, msg: '已卸载' };
  } catch (e) {
    fnosLog('error', 'uninstall', '卸载失败', { err: e.message });
    return { success: false, msg: e.message };
  }
});


// (2) install-nas-app
ipcMain.handle('install-nas-app', async (_e, payload) => {
  try {
    fnosLog('info', 'ipc', 'install-nas-app called', payload);
    const { appId, appName, iconData, iconExt, nasAddress } = payload || {};
    if (!appId || !appName) return { success: false, msg: '缺少 appId 或 appName', data: null };

    const data = readManifest();
    // 检查是否已存在
    const existIdx = data.apps.findIndex(a => a.appId === appId);

    // 保存图标
    let iconPath = '';
    if (iconData) {
      const ext = iconExt || 'png';
      iconPath = path.join(ASSETS_DIR, `${appId}.${ext}`);
      const buf = Buffer.from(iconData, 'base64');
      fs.writeFileSync(iconPath, buf);
      fnosLog('info', 'ipc', '图标保存成功', { iconPath });
    }

    const appEntry = {
      appId,
      appName,
      iconPath,
      nasAddress: nasAddress || '',
      installedAt: new Date().toISOString(),
    };

    if (existIdx >= 0) {
      data.apps[existIdx] = { ...data.apps[existIdx], ...appEntry };
    } else {
      data.apps.push(appEntry);
    }

    const res = writeManifest(data);
    // v2.0.7：如果图标是 SVG 格式或为空，尝试从 NAS 获取 favicon 并转换为 PNG
    if ((!iconPath || iconPath.endsWith('.svg')) && nasAddress) {
      try {
        const favUrl = nasAddress.replace(/\/$/, '') + '/favicon.ico';
        const ses = session.defaultSession;
        const resp = await ses.fetch(favUrl, { credentials: 'include' });
        if (resp.ok) {
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          const buf = Buffer.from(await resp.arrayBuffer());
          if (ct.includes('svg') || buf.slice(0, 5).toString().includes('svg') || buf.slice(0, 4).toString() === '<svg' || buf.slice(0, 100).toString().includes('<svg')) {
            // SVG favicon，通过隐藏窗口转换为 PNG
            const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buf.toString('utf-8'));
            const convertResult = await (async () => {
              const pngBuf = await __svgToPng(buf.toString('utf-8'), 128);
              if (!pngBuf) return null;
              const savePath = path.join(ASSETS_DIR, appId + '.png');
              fs.writeFileSync(savePath, Buffer.from(pngBuf));
              return { iconPath: savePath };
            })();
            if (convertResult && convertResult.iconPath) {
              appEntry.iconPath = convertResult.iconPath;
              if (existIdx >= 0) data.apps[existIdx] = { ...data.apps[existIdx], ...appEntry };
              writeManifest(data);
              fnosLog('info', 'ipc', 'install时SVG图标已转换', { appId, iconPath: convertResult.iconPath });
            }
          } else if (!ct.includes('svg') && !buf.slice(0, 100).toString().includes('<svg')) {
            // 非 SVG，直接保存为 PNG/ICO
            const ext = ct.includes('png') ? 'png' : (ct.includes('x-icon') || ct.includes('vnd.microsoft.icon') ? 'ico' : 'png');
            const savePath = path.join(ASSETS_DIR, appId + '.' + ext);
            fs.writeFileSync(savePath, buf);
            appEntry.iconPath = savePath;
            if (existIdx >= 0) data.apps[existIdx] = { ...data.apps[existIdx], ...appEntry };
            writeManifest(data);
            fnosLog('info', 'ipc', 'install时favicon已缓存', { appId, iconPath: savePath });
          }
        }
      } catch (e) {
        fnosLog('warn', 'ipc', 'install时获取favicon失败', { appId, err: e.message });
      }
    }
    return { success: res.success, msg: res.msg || '安装成功', data: appEntry };
  } catch (e) {
    fnosLog('error', 'ipc', 'install-nas-app error', { err: e.message, stack: e.stack });
    return { success: false, msg: e.message, data: null };
  }
});

// v2.0.7：SVG 转 PNG——创建隐藏窗口渲染 SVG 并截图为 PNG buffer
async function __svgToPng(svgText, size) {
  size = size || 128;
  let hiddenWin;
  try {
    hiddenWin = new BrowserWindow({
      show: false, width: size + 20, height: size + 20,
      webPreferences: { offscreen: true, sandbox: true },
    });
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
    const html = '<!DOCTYPE html><html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;width:' + size + 'px;height:' + size + 'px;">' +
      '<img src="' + dataUrl + '" width="' + size + '" height="' + size + '" style="max-width:100%;max-height:100%;" />' +
      '</body></html>';
    await hiddenWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 600));
    const img = await hiddenWin.webContents.capturePage();
    try { hiddenWin.close(); } catch (_) {}
    return img.toPNG();
  } catch (e) {
    try { if (hiddenWin && !hiddenWin.isDestroyed()) hiddenWin.close(); } catch (_) {}
    fnosLog('error', 'icon', 'SVG转PNG失败', { err: e.message });
    return null;
  }
}
ipcMain.handle('app:convert-svg-icon', async (_e, payload) => {
  try {
    const { svgDataUrl, appId, size } = payload || {};
    if (!svgDataUrl || !appId) return { success: false, msg: '缺少参数' };
    // 解码 SVG 内容
    let svgText;
    try {
      svgText = decodeURIComponent(svgDataUrl.replace(/^data:image\/svg\+xml;?(?:charset=utf-8)?,/, ''));
    } catch (_) {
      return { success: false, msg: 'SVG解码失败' };
    }
    // 转换为 PNG
    const pngBuf = await __svgToPng(svgText, size || 128);
    if (!pngBuf) return { success: false, msg: '转换失败' };
    // 保存到 assets 目录
    const iconPath = path.join(ASSETS_DIR, appId + '.png');
    try {
      if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
      fs.writeFileSync(iconPath, Buffer.from(pngBuf));
      fnosLog('info', 'icon', 'SVG图标已转换并保存', { appId, iconPath });
    } catch (e) {
      fnosLog('error', 'icon', '保存转换后图标失败', { err: e.message });
      return { success: false, msg: '保存失败: ' + e.message };
    }
    return { success: true, msg: '转换成功', data: { iconPath } };
  } catch (e) {
    fnosLog('error', 'icon', 'convert-svg-icon error', { err: e.message, stack: e.stack });
    return { success: false, msg: e.message };
  }
});

// 2.2 命令行启动：携带 --app 参数时，标记待打开应用 + 正常启动主程序（隐藏到托盘），
// 登录后由 tryOpenPendingApp 复用主程序内 createAppWindow 打开（依赖主程序登录态）。
// v2.3.3: 统一把快捷方式/启动参数里的“应用唯一ID”或 URL 解析为完整打开地址。
// raw 可能是：完整 URL（旧 --app= 格式）、appname（新 --launch-app= 格式，如 trim.music）。
// 依赖 FPK 提供端口/路径的第三方应用（非 trim.*）不在同步解析范围，由调用方回退 --app=URL。
// v2.4.0（需求 2.5/2.6）：open-fpk-app —— Main → Renderer 通知，携带参数 appId。
// found:true  = 目标 FPK 应用已解析成功，渲染进程在主窗口内同窗导航到应用页面——
//               程序内启动（需求 2.5-1"渲染进程路由跳转加载应用"，v2.4.2 按用户反馈落实，
//               不再由主进程新建独立应用窗口）。
// found:false = appId 对应 FPK 应用已删除/无法定位（需求 2.6-2、边界用例 7），
//               渲染进程弹窗提示"找不到该应用，请重新创建快捷方式。"
let __pendingAppId = ''; // 原始应用唯一 ID（--launch-app 值），open-fpk-app 携带字段 appId
function __notifyOpenFpkApp(appId, found, url) {
  try {
    const payload = {
      appId: String(appId || (url ? (fpkAppNameFromUrl(url) || '') : '') || '').slice(0, 200),
      found: !!found,
      url: String(url || '').slice(0, 300),
      ts: Date.now(),
    };
    const __send = () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('open-fpk-app', payload);
          return true;
        }
      } catch (_) {}
      return false;
    };
    try { require('./logger.js').log('info', 'ipc', 'open-fpk-app send', { params: payload }, __RUN_MODE); } catch (_) {}
    if (__send()) return;
    // 主窗口尚未就绪（冷启动）：最多重试 20 次 × 500ms（preload 监听器随窗口创建即注册）
    let __tries = 0;
    const __timer = setInterval(() => {
      __tries++;
      if (__send() || __tries >= 20) clearInterval(__timer);
    }, 500);
  } catch (_) {}
}
// 同步查询 FPK 应用列表内存缓存（refreshFpkApps.__cache，5 分钟 TTL）：
// __resolveLaunchUrl / second-instance 是同步链路不能 await，只读内存缓存兜底；
// 缓存未就绪（冷启动）返回 null，回退 manifest → appview?anchor 解析。
function __fpkLookupSync(name) {
  try {
    if (!name) return null;
    const cache = refreshFpkApps.__cache;
    if (!Array.isArray(cache) || !cache.length) return null;
    return cache.find((f) => f && String(f.name || f.appname || '') === String(name)) || null;
  } catch (_) { return null; }
}
function __resolveLaunchUrl(raw, nasAddr) {
  let appName = '';
  try { appName = decodeURIComponent(String(raw || '')); } catch (_) { appName = String(raw || ''); }
  if (!appName) return '';
  // 1) 已是完整 URL（旧快捷方式 --app=http://...），直接用
  // 1) 已是完整 URL（旧快捷方式 --app=http://...）；v2.3.6: 丢端口时按 settings.origin 补正
  if (/^https?:\/\//i.test(appName)) {
    try {
      const __stR = loadSettings();
      const __origR = String((__stR && __stR.origin) || '').trim();
      if (__origR) {
        const __oR = new URL(/^https?:/i.test(__origR) ? __origR : 'http://' + __origR);
        const __bR = new URL(appName);
        if (__oR.hostname === __bR.hostname && !__bR.port && __oR.port) {
          appName = __oR.protocol + '//' + __oR.host + (__bR.pathname || '/') + (__bR.search || '') + (__bR.hash || '');
          try { dlog && dlog('info', 'shortcut.url.port-fixed', { to: appName.slice(0, 140) }); } catch (_) {}
        }
      }
    } catch (_) {}
    return appName;
  }
  // 2) v2.4.0（需求 2.1）：快捷方式统一传 --launch-app={应用唯一 ID} 后，FPK 第三方应用的
  //    真实打开地址（端口/路径）以 FPK 图标管理器 url 字段为准——先同步查 FPK 内存缓存
  //    （refreshFpkApps.__cache，5 分钟 TTL）。缓存未就绪（冷启动）回退下方 manifest / appview。
  try {
    const fe = __fpkLookupSync(appName);
    if (fe && fe.url && /^https?:\/\//i.test(fe.url)) {
      try { dlog && dlog('info', 'shortcut.url.fpk-cache', { name: String(appName).slice(0, 80), url: String(fe.url).slice(0, 140) }); } catch (_) {}
      return fe.url;
    }
  } catch (_) {}
  // 3) appId/appname 命中 manifest entry
  try {
    const mf = readManifest();
    const entry = mf && Array.isArray(mf.apps) ? mf.apps.find(a => a && (a.appId === appName || a.name === appName || a.url === appName)) : null;
    if (entry && entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  } catch (_) {}
  // 4) appname → appview?anchor（飞牛系统应用统一入口，服务端/客户端会补端口归一化）
  let base = String(nasAddr || '').trim().replace(/\/+$/, '');
  if (base) {
    if (!/^https?:/i.test(base)) base = 'http://' + base;
    // v2.3.6: 旧快捷方式 --nas=host 丢端口（创建时 nasAddress 未带端口），appview 会打到
    // 80 端口被 preauth 误判 external-app。按 settings 里连接过的完整 origin（含端口）补正。
    try {
      const st = loadSettings();
      const orig = String((st && st.origin) || '').trim();
      if (orig) {
        const o = new URL(/^https?:/i.test(orig) ? orig : 'http://' + orig);
        const b = new URL(base);
        if (o.hostname === b.hostname && !b.port && o.port) {
          base = o.protocol + '//' + o.host;
          try { dlog && dlog('info', 'shortcut.url.port-fixed', { from: String(nasAddr), to: base }); } catch (_) {}
        }
      }
    } catch (_) {}
    return base + '/appview?anchor=' + encodeURIComponent(appName);
  }
  return appName;
}

function launchSubAppFromArgs() {
  if (!launchArgs.appId) return false;
  // v2.1.15：增强日志——记录快捷方式冷启动的完整参数
  fnosLog('info', 'launch', '检测到快捷方式启动参数，转主程序内打开', { ...launchArgs, t0: new Date().toISOString() });

  const nasAddr = launchArgs.nas ? decodeURIComponent(launchArgs.nas) : '';
  const url = nasAddr || '';
  // v2.3.3: 统一用 __resolveLaunchUrl 解析启动目标（支持 --launch-app=appname / --app=URL）
  const appUrl = __resolveLaunchUrl(launchArgs.appId, url);
  fnosLog('info', 'launch', 'resolved app URL', { original: launchArgs.appId, resolved: appUrl, isAppview: /\/appview(\?|$)/i.test(appUrl) });
  if (!url && !/^https?:\/\//i.test(appUrl)) {
    fnosLog('warn', 'launch', '缺少 nas 地址参数且无法解析启动地址，转普通主程序启动');
    return false;
  }

  // v2.1.10：不再创建独立子窗口（旧 doLaunch 冷启动模式已废弃）。
  // 快捷方式冷启动改为：标记待打开应用 + 正常启动主程序，登录后由
  // consumePendingOpenApp / tryOpenPendingApp 触发 open-fpk-app，渲染进程在主窗口内
  // 同窗打开应用（程序内启动，v2.4.2 用户反馈），不新建独立应用窗口、登录态共享免二次登录。
  if (appUrl) {
    queuePendingApp(appUrl);
    // v2.1.15：增强日志——记录 pending app 已入队
    fnosLog('info', 'launch', 'pending app queued', { appUrl: String(appUrl).slice(0, 160), nasAddr: String(url).slice(0, 80) });
  }
  __pendingFromShortcut = true;
  return true;
}

ipcMain.handle('shell:popup-menu', (_e, payload) => {
  try {
    if (!payload || !payload.id) return;
    // 用当前 buildMenu() 生成的应用菜单，取对应顶级菜单，在坐标处弹出
    const appMenu = Menu.getApplicationMenu() || Menu.buildFromTemplate(buildMenuTemplate());
    const map = { file: '文件', downloads: '下载', view: '视图', tools: '工具', settings: '设置', help: '帮助' };
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

// v2.0.0：设置 - 开机自启动（Windows 注册表）
// 注册表路径：HKCU\Software\Microsoft\Windows\CurrentVersion\Run
// 键名：FNOS，键值：exe 完整路径
// 支持便携版：用 PORTABLE_EXECUTABLE_FILE 稳定路径，避免解压临时目录变化导致自启失效
ipcMain.handle('settings:get-autostart', async () => {
  try {
    if (process.platform !== 'win32') return { success: false, msg: '仅 Windows 支持', data: false };
    return new Promise((resolve) => {
      cp.exec('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v FNOS', { timeout: 10000, windowsHide: true }, (err, stdout) => {
        const exists = !err && /FNOS\s+REG_SZ/i.test(stdout);
        resolve({ success: true, msg: '', data: exists });
      });
    });
  } catch (e) {
    return { success: false, msg: String(e.message || e).slice(0, 200), data: false };
  }
});

// v2.4.0（需求 2.2/2.5-3）：开机自启统一走注册表工具函数 __setAutoLaunchRegistry
// （交付物 src/main/utils/autoLaunch.ts 的 JS 映射，见开发说明文档）。
// 注册表 HKCU\...\Run 键值固定为 exe 完整路径——开机启动命令不带任何应用 ID（需求 2.2 禁止项）。
// 不使用打包工具自带开机启动能力（app.setLoginItemSettings 等，需求 2.8 禁止项）。
// 开关状态持久化：需求要求 electron-store，本项目以既有 settings JSON（saveSettings）持久化
// autoLaunch 字段实现同等效果（前置约定 1：兼容现有项目结构，不引入新依赖），映射见开发说明文档。
// 开机启动后行为由需求 2.3 场景 B 保证：窗口加载完成即 win.hide()，只驻留托盘、不弹主页、
// 不自动打开任何应用（开机命令本身不带应用 ID）。
// v2.4.1（用户真机反馈）：启动类型判定——桌面快捷方式（--launch-app/--app/--open-app）
// 或开机自启（--autostart）→ 静默启动（隐藏主窗口、只驻留托盘）；用户主动点击主程序
// （无任何上述参数）→ 显示主窗口。函数声明提升，供 ready-to-show / 10s 兜底调用。
function __isQuietStart() {
  try {
    for (const a of (process.argv || [])) {
      const s = String(a || '');
      if (s.indexOf('--launch-app') === 0 || s.indexOf('--app=') === 0 || s === '--app' ||
          s.indexOf('--open-app') === 0 || s.indexOf('--autostart') === 0) return true;
    }
    if (typeof __pendingAppUrl !== 'undefined' && __pendingAppUrl) return true;
    if (typeof __shortcutKeepHidden !== 'undefined' && __shortcutKeepHidden) return true;
  } catch (_) {}
  return false;
}


function __setAutoLaunchRegistry(enable) {
  return new Promise((resolve) => {
    try {
      if (process.platform !== 'win32') { resolve({ success: false, msg: '仅 Windows 支持' }); return; }
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      const safeExe = String(exe).replace(/"/g, '');
      if (!safeExe) { resolve({ success: false, msg: '可执行文件路径为空' }); return; }
      // v2.4.1（用户真机反馈）：Run 键值追加 --autostart 标记（不带应用 ID，合规需求 2.2）——
      // 开机自启启动时 __isQuietStart() 命中 --autostart → 隐藏主窗口只驻留托盘；
      // 与用户主动点击主程序（显示主窗口）区分。disable 分支不变。
      const cmd = enable
        ? 'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v FNOS /t REG_SZ /d "' + safeExe + ' --autostart" /f'
        : 'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v FNOS /f 2>nul';
      cp.exec(cmd, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || err).slice(0, 200);
          try { require('./logger.js').log('error', 'autolaunch', 'registry write failed', { params: { enable, cmd: cmd.slice(0, 160) }, err: { message: msg } }, __RUN_MODE); } catch (_) {}
          resolve({ success: false, msg: '注册表写入失败: ' + msg });
        } else {
          // 持久化开关状态（等价 electron-store 保存，见上方注释）
          try { saveSettings({ autoLaunch: !!enable }); } catch (_) {}
          try { require('./logger.js').log('info', 'autolaunch', 'registry write ok', { params: { enable, key: 'HKCU Run FNOS', exe: safeExe }, ret: { success: true } }, __RUN_MODE); } catch (_) {}
          resolve({ success: true, msg: enable ? '已开启开机自启' : '已关闭开机自启' });
        }
      });
    } catch (e) {
      try { require('./logger.js').log('error', 'autolaunch', 'registry write exception', { params: { enable }, err: e }, __RUN_MODE); } catch (_) {}
      resolve({ success: false, msg: String(e.message || e).slice(0, 200) });
    }
  });
}

ipcMain.handle('settings:set-autostart', async (_e, { enabled }) => {
  // 兼容保留旧 IPC 事件（内部与 set-auto-launch 共用注册表工具函数）
  return __setAutoLaunchRegistry(!!enabled);
});

// v2.4.0（需求 2.5-3）：Renderer → Main：set-auto-launch，参数 { enable: boolean }——
// 读写注册表开机自启（HKCU Run，开机命令不带应用 ID）。事件名按需求 IPC 定义固定，
// 仅允许 open-fpk-app / create-desktop-shortcut / set-auto-launch 三个事件，不新增定义外事件。
ipcMain.handle('set-auto-launch', async (_e, payload) => {
  const enable = !!(payload && payload.enable);
  try { require('./logger.js').log('info', 'autolaunch', 'set-auto-launch recv', { params: { enable } }, __RUN_MODE); } catch (_) {}
  return __setAutoLaunchRegistry(enable);
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
      // v1.50.0：统一无边框 + 自定义标题栏（与主窗口/应用窗口风格一致）
      frame: false,
      autoHideMenuBar: true,
      show: false,
      icon: ICON_PATH,
      webPreferences: {
        preload: LIVE_PRELOAD,
        partition: livePartition,
        contextIsolation: true, webviewTag: true,
        nodeIntegration: false,
        sandbox: false, // v1.56：live-preload 需 require 本地 titlebar-inject，必须关闭沙箱
        // v1.20.0：直播窗口内 hls.js 需跨域拉取 FPK 服务端 m3u8/ts，关闭同源策略避免黑屏
        webSecurity: false,
        allowRunningInsecureContent: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    liveWindow.setMenuBarVisibility(false);
    // v2.0.6：直播窗口独立 AppUserModelId，任务栏不与其他窗口合并
    try { liveWindow.setAppUserModelId('com.fnos.client.app.live'); } catch (_) {}
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
    // v2.0.6：直播窗口也提取页面图标作为任务栏图标
    liveWindow.webContents.on('did-finish-load', () => {
      try {
        const __liveApplyIcon = () => {
          try {
            if (!liveWindow || liveWindow.isDestroyed() || !liveWindow.webContents) return;
            liveWindow.webContents.executeJavaScript(`(function(){
              try {
                var candidates = [];
                var seen = {};
                var allLinks = document.querySelectorAll('link[rel]');
                for (var i = 0; i < allLinks.length; i++) {
                  var lnk = allLinks[i];
                  var rel = (lnk.getAttribute('rel') || '').toLowerCase();
                  if (rel.indexOf('icon') === -1) continue;
                  var href = lnk.href || lnk.getAttribute('href') || '';
                  var type = (lnk.getAttribute('type') || '').toLowerCase();
                  var isSvg = type === 'image/svg+xml' || type === 'image/svg' || /\.svg($|[?#])/i.test(href);
                  if (href && !seen[href]) { seen[href] = true; candidates.push({ href: href, isSvg: isSvg }); }
                }
                if (!candidates.length) { try { candidates.push({ href: location.origin + '/favicon.ico', isSvg: false }); } catch(_) {} }
                if (!candidates.some(function(c){ return !c.isSvg; })) {
                  for (var j = 0; j < allLinks.length; j++) {
                    var lnk2 = allLinks[j];
                    var rel2 = (lnk2.getAttribute('rel') || '').toLowerCase();
                    if (rel2.indexOf('icon') === -1) continue;
                    var href2 = lnk2.href || lnk2.getAttribute('href') || '';
                    if (href2 && !seen[href2]) { seen[href2] = true; candidates.push({ href: href2, isSvg: true }); }
                  }
                }
                return candidates;
              } catch (e) { return []; }
            })()`, true).then((candidates) => {
              try {
                if (!Array.isArray(candidates) || !candidates.length || !liveWindow || liveWindow.isDestroyed()) return;
                const ses = liveWindow.webContents ? liveWindow.webContents.session : null;
                const tryNext = (idx) => {
                  if (idx >= candidates.length || !liveWindow || liveWindow.isDestroyed()) return;
                  const c = candidates[idx];
                  const iconRef = typeof c === 'string' ? c : c.href;
                  const isSvg = typeof c === 'object' && c.isSvg;
                  if (/^data:image\//i.test(iconRef)) {
                    if (/^data:image\/svg/i.test(iconRef) || isSvg) {
                      try {
                        const svgText = decodeURIComponent(iconRef.replace(/^data:image\/svg\+xml;?(?:charset=utf-8)?,/, ''));
                        __svgToPng(svgText, 128).then(pngBuf => {
                          if (pngBuf) {
                            const img = nativeImage.createFromBuffer(Buffer.from(pngBuf));
                            if (!img.isEmpty()) { liveWindow.setIcon(img); return; }
                          }
                          tryNext(idx + 1);
                        });
                      } catch(_) { tryNext(idx + 1); }
                    } else {
                      try {
                        const img = nativeImage.createFromDataURL(iconRef);
                        if (!img.isEmpty()) { liveWindow.setIcon(img); return; }
                      } catch (_) {}
                      tryNext(idx + 1);
                    }
                    return;
                  }
                  if (!/^https?:/i.test(iconRef) || !ses) { tryNext(idx + 1); return; }
                  ses.fetch(iconRef, { credentials: 'include' }).then((res) => {
                    if (!res.ok) throw new Error('bad status');
                    const ct = (res.headers.get('content-type') || '').toLowerCase();
                    if (ct.includes('svg') || isSvg) {
                      return res.text().then(svgText => {
                        return __svgToPng(svgText, 128).then(pngBuf => {
                          if (pngBuf) {
                            const img = nativeImage.createFromBuffer(Buffer.from(pngBuf));
                            if (!img.isEmpty()) { liveWindow.setIcon(img); return; }
                          }
                          tryNext(idx + 1);
                        });
                      });
                    }
                    return res.arrayBuffer();
                  }).then((buf) => {
                    if (!buf) return;
                    const img = nativeImage.createFromBuffer(Buffer.from(buf));
                    if (!img.isEmpty()) { liveWindow.setIcon(img); }
                    else { tryNext(idx + 1); }
                  }).catch(() => { tryNext(idx + 1); });
                };
                tryNext(0);
              } catch (_) {}
            }).catch(() => {});
          } catch (_) {}
        };
        __liveApplyIcon();
        setTimeout(() => { try { __liveApplyIcon(); } catch (_) {} }, 2000);
      } catch (_) {}
    });
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
// 记录上一次 VOD 播放的片名，用于直播场景识别 renderer 残留的旧片名
let __lastVodTitle = '';
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
      surf = new MpvSurfaceMod.MpvSurface(null, null, {
        standalone: true,
        settings: st,
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

    try {
      await surf.play(url, headers, { isLive, title: finalTitle || '飞牛影视', hwDecode: st.hwDecode });
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

// v1.63：嵌入 mpv 存活时，置顶 mpv 会挡住宿主顶部标题栏区域的鼠标事件，渲染进程的
// mouseenter/mousemove 有时收不到，导致"自动隐藏标题栏后打开 mpv，鼠标推到顶部调不出来"。
// 主进程用全局光标位置兜底：光标进入【聚焦宿主】的顶部 34px 带内 -> 通知强制显示标题栏；
// 离开 -> 通知恢复（由标题栏模块按自动隐藏设置决定是否淡出）。不依赖渲染进程是否收到鼠标事件。
const TITLEBAR_STRIP = 34;
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
                    pt.y >= cb.y && pt.y <= cb.y + TITLEBAR_STRIP;
    if (inStrip) {
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
        contents.setWindowOpenHandler(({ url, frameName }) => {
          try {
            const u = String(url || '');
            // DevTools / chrome 内部页交给默认处理
            if (/^(devtools|chrome-extension:|chrome:)/i.test(u)) {
              return { action: 'allow' };
            }
            // 统一的无边框 + preload 开窗覆盖项（所有由网页 window.open 弹出的窗口都走这个，
            // 彻底杜绝 Electron 默认带系统原生标题栏的窗口）
            const frameLessOverride = () => ({
              frame: false,
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
              setImmediate(() => {
                try { createAppWindow(u, { partition: SHARED_PARTITION, title: APP_NAME }); } catch (_) {}
              });
              dlog('info', 'appwin.open.catchall', { url: u.slice(0, 120) });
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
function notifyGuestMpvClosed(guestWc) {
  try {
    const wc = guestWc;
    if (wc && !wc.isDestroyed() && typeof wc.send === 'function') {
      try { wc.send('mpv:embed-closed'); } catch (_) {}
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
// v2.4.0（需求 2.3/2.5）：second-instance 处理函数（注册点在文件最前单实例锁判断处，
// 严格满足"单实例锁判断第一时间执行 + second-instance 在 app.ready 注册之前"的强制编码顺序）。
// 场景 A：新进程解析 --launch-app={appId} 经 second-instance 传给已运行主进程，主进程在飞牛
// 框架内部打开对应 FPK 应用（独立应用窗口），并经 open-fpk-app IPC（携带 appId）通知渲染进程；
// 新进程 __secondInstanceHandshakeSync 同步阻塞后 app.exit(0)——不建窗、不加载页面。
// 核心铁律：全程禁止自动弹出飞牛主页——本函数不再在无应用参数时自动 show 主窗口，
// 只有托盘【显示主界面】才展示主页（需求 2.4-2 / 2.8）。
function __handleSecondInstance(_e, commandLine) {
  // v2.3.5：标记握手完成（写 pid），告知新实例主进程已响应，避免误报"进程异常"。
  try { __markHandshakeDone(); } catch (_) {}
  try {
    const argv = commandLine || [];
    let u = '';
    let rawAppId = '';
    let nasAddr = '';
    for (let i = 0; i < argv.length; i++) {
      const a = String(argv[i] || '');
      // v2.1.5: Support --app= parameter (used by create-desktop-shortcut)
      if (a === '--app' && argv[i + 1]) { u = decodeURIComponent(String(argv[i + 1])); break; }
      if (a.startsWith('--app=')) { u = decodeURIComponent(a.slice('--app='.length)); break; }
      // v2.3.3: --launch-app={应用唯一ID}（appname），值为 ID 不做 decode
      if (a === '--launch-app' && argv[i + 1]) { u = String(argv[i + 1]); break; }
      if (a.startsWith('--launch-app=')) { u = a.slice('--launch-app='.length); break; }
      // Legacy --open-app support
      if (a === '--open-app' && argv[i + 1]) { u = String(argv[i + 1]); break; }
      if (a.startsWith('--open-app=')) { u = a.slice('--open-app='.length); break; }
    }
    // Also extract --nas= parameter
    for (let i = 0; i < argv.length; i++) {
      const a = String(argv[i] || '');
      if (a.startsWith('--nas=')) { nasAddr = decodeURIComponent(a.slice('--nas='.length)); break; }
      if (a === '--nas' && argv[i + 1]) { nasAddr = decodeURIComponent(String(argv[i + 1])); break; }
    }
    rawAppId = u;
    // v2.4.0（需求第一部分-3）：second-instance 触发日志（含 argv / appId / nas 参数）
    try { require('./logger.js').log('info', 'ipc', 'second-instance 触发', { params: { argv: argv.slice(1).map((x) => String(x).slice(0, 80)), rawAppId: String(rawAppId).slice(0, 120), nasAddr: String(nasAddr).slice(0, 80) } }, __RUN_MODE); } catch (_) {}
    // v2.3.3: --launch-app 传的是 appname，统一解析成完整 URL 再打开
    if (u) { u = __resolveLaunchUrl(u, nasAddr); }
    // v2.3.3: 解析失败（无 nas 地址或应用 ID 无法定位）→ 提示用户重建快捷方式
    if (u && !/^https?:\/\//i.test(u)) {
      try { require('./logger.js').log('warn', 'ipc', 'second-instance resolve_fail', { params: { raw: String(rawAppId).slice(0, 120), nas: String(nasAddr).slice(0, 80) }, ret: { found: false } }, __RUN_MODE); } catch (_) {}
      // v2.4.0（需求 2.6-2 / 边界用例 7）：appId 对应 FPK 应用已删除/无法定位 →
      // open-fpk-app(found:false)，渲染进程弹窗"找不到该应用，请重新创建快捷方式。"
      // （主进程 dialog 仅在无渲染窗口时兜底，避免重复弹窗）
      __notifyOpenFpkApp(rawAppId, false);
      // v2.4.2：渲染 alert 需窗口可见才能被用户看到
      try { if (mainWindow && !mainWindow.isDestroyed() && !isLocked) { mainWindow.show(); mainWindow.focus(); } } catch (_) {}
      if (!mainWindow || mainWindow.isDestroyed()) {
        try { dialog.showMessageBox({ type: 'warning', title: 'FNOS', message: '找不到该应用，请重新创建快捷方式。', buttons: ['确定'] }); } catch (_) {}
      }
      u = '';
    }
    if (u && mainWindow && !mainWindow.isDestroyed()) {
      // v2.1.13：去掉 300ms setTimeout 延迟，改为立即执行——与主程序内
      // setWindowOpenHandler 打开应用（setImmediate → createAppWindow）速度一致。
      // 轮询间隔从 1500ms 降到 500ms，隐藏主窗口延迟从 300ms 降到 100ms。
      try {
        const wc = mainWindow.webContents;
        const cur = wc.getURL() || '';
        const p = String(cur).toLowerCase();
        // v2.2.3：放宽登录判断——仅要求主窗口已导航到 https 主页（非 /login）。
        // 旧逻辑要求 !isLoading()，但主页完整加载可能数秒，此时 cookie 已就绪，
        // 放宽后第二次双击快捷方式（主程序在托盘）能更快打开应用。
        const loggedIn = /^https?:/i.test(p) && p.indexOf('/login') !== 0 && !/\/login([\/?#]|$)/.test(p);
        // v2.1.15：增强日志——记录快捷方式热启动路径（v2.4.0：统一走 logger.js 带参数落盘）
        try { require('./logger.js').log('info', 'app', 'shortcut.hot_start', { params: { url: String(u).slice(0, 160), appId: String(rawAppId).slice(0, 120), loggedIn, isLoading: wc.isLoading(), pageUrl: p.slice(0, 100) } }, __RUN_MODE); } catch (_) {}
        if (loggedIn) {
          // v2.4.5（用户反馈模型：快捷方式=触发器，单实例 second-instance IPC 秒开）：
          // 程序内启动 = 渲染进程后台模拟点击桌面图标（≡真实点击），
          // 不新开主窗口、主界面不露面；已存在应用窗则同窗切应用 + 聚焦（毫秒级）。
          __notifyOpenFpkApp(rawAppId, true, u);
          try { require('./logger.js').log('info', 'app', 'shortcut.app_open_in_main', { params: { url: String(u).slice(0, 160), appId: String(rawAppId).slice(0, 120) } }, __RUN_MODE); } catch (_) {}
        } else {
          // v1.78.0：主程序已运行但未登录/加载中 → 等待登录后自动打开（打开后主程序进入后台）
          __pendingFromShortcut = true;
          __pendingAppId = rawAppId;
          queuePendingApp(u);
          tryOpenPendingApp();
          // v2.1.15：轮询间隔从 500ms 降到 300ms
          const pt = setInterval(() => {
            try { tryOpenPendingApp(); if (!__pendingAppUrl) clearInterval(pt); } catch (_) {}
          }, 300);
        }
      } catch (err) {
        try { require('./logger.js').log('error', 'app', 'shortcut.hot_start error', { err }, __RUN_MODE); } catch (_) {}
        try {
          // v2.4.7（用户反馈）：程序内启动——渲染进程后台模拟点击图标（跳出窗呈现）
          __notifyOpenFpkApp(rawAppId, true, u);
        } catch (_) {}
      }
      return;
    }
  } catch (_) {}
  // v2.4.1（用户真机反馈，覆盖 v2.4.0 无参 noop）：用户点击主程序启动（无应用参数的
  // second-instance）= 显式查看主界面意图 → 显示并聚焦主窗口；带应用参数的快捷方式
  // 唤起走上方分支（程序内启动应用：主窗口同窗打开应用页面，v2.4.2）。
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !isLocked) { mainWindow.show(); try { mainWindow.focus(); } catch (_) {} }
    require('./logger.js').log('info', 'window', 'second-instance.show', { params: { reason: 'user_launch_main', visible: true } }, __RUN_MODE);
  } catch (_) {}
}

// v2.0.0: 命令行参数启动时跳过主界面
const subAppLaunched = launchSubAppFromArgs();
app.whenReady().then(() => {
  // v2.3.5（需求 2.6.4）：托盘图标丢失自动重建。
  // Windows 下 Explorer 重启/托盘被系统回收时图标会消失：定时检查 + 系统恢复事件兜底重建。
  try {
    const __trayGuard = () => {
      try {
        if (!tray || typeof tray.isDestroyed !== 'function' || tray.isDestroyed()) {
          ensureTray();
          try { dlog && dlog('warn', 'tray.rebuilt.auto'); } catch (_) {}
        }
      } catch (_) { try { ensureTray(); } catch (_) {} }
    };
    setInterval(__trayGuard, 30000);
    if (powerMonitor && typeof powerMonitor.on === 'function') {
      powerMonitor.on('resume', () => setTimeout(__trayGuard, 3000));
    }
    setTimeout(__trayGuard, 5000); // Explorer 重启后托盘区域重建，启动 5s 兜底一次
  } catch (_) {}
  // v2.3.0: main process startup log (version / single-instance / argv)
  try {
    dlog('info', 'main.start', {
      version: APP_VERSION,
      gotSingleLock: __gotSingleLock,
      argv: (process.argv || []).slice(1).map((x) => String(x).slice(0, 80)).filter((x) => x && x.indexOf('--type=') !== 0),
      platform: process.platform,
      userData: app.getPath('userData'),
    });
  } catch (_) {}
  // v1.72.0：解析 --open-app 参数（桌面快捷方式启动单个应用）
  try { parseOpenAppArg(); } catch (_) {}
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
  // v1.65.0：Electron 30+ 默认 webviewTag=false，飞牛主界面以 <webview> 承载，
  // 已在每个 BrowserWindow 显式开启；这里再全局兜底，任何容器内附着 webview 时强制允许，
  // 避免升级新内核后页面白屏。保留既有 preload / partition / allowpopups 设置。
  app.on('web-contents-created', (_evt, contents) => {
    if (!contents.isDestroyed()) {
      contents.on('will-attach-webview', (e, webPreferences, params) => {
        webPreferences.webviewTag = true;
        webPreferences.contextIsolation = true;
        webPreferences.nodeIntegration = false;
        webPreferences.sandbox = false;
        webPreferences.spellcheck = false;
        if (SHARED_PARTITION && !params.partition) params.partition = SHARED_PARTITION;
      });
    }
  });
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
  // v2.1.13：从 settings 恢复上次的 partition（persist:nas-{hash}），确保 cookie/session
  // 与上次登录时一致。旧版硬编码 SHARED_PARTITION，而登录后 cookie 存在 persist:nas-{hash}
  // 中，下次启动用 SHARED_PARTITION → cookie 不在同一 partition → 每次都要重新登录。
  let initialPartition = (s.currentPartition && s.currentPartition.startsWith('persist:'))
    ? s.currentPartition : SHARED_PARTITION;
  let initialTarget = null;

  if (s.lastConnectHref && s.origin) {
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

  // v2.1.10：桌面快捷方式（--app）冷启动不再只开子窗口，改为统一走主程序启动：
  // 正常创建主窗口（未登录显示登录页、已登录自动重连），锁定状态走解锁流程。
  // 待打开应用已在 launchSubAppFromArgs 里 queuePendingApp，登录后由 did-navigate/
  // tryOpenPendingApp 自动打开并隐藏主窗口到托盘。
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
  // 快捷方式冷启动兜底：主窗口加载后若 pending 应用尚未被消费（无导航事件时），
  // 主动触发一次；登录后打开应用并隐藏主窗口。
  if (subAppLaunched) {
    // v2.1.11：快捷方式冷启动时主窗口先不显示——已登录用户不会看到主页闪烁；
    // 未登录（导航到 /login）时显示登录页提示登录；已登录则保持后台，
    // 应用打开后按用户设置（托盘/最小化）后台化。
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); } catch (_) {}
    try {
      mainWindow.webContents.on('did-navigate', () => {
        try {
          const cur = mainWindow.webContents.getURL() || '';
          const p = String(cur).toLowerCase();
          if (/^https?:/i.test(p) && (p.indexOf('/login') === 0 || /\/login([\/?#]|$)/.test(p))) {
            if (mainWindow && !mainWindow.isDestroyed() && !isLocked) { try { mainWindow.show(); } catch (_) {} }
          }
        } catch (_) {}
      });
    } catch (_) {}
    setTimeout(() => { try { tryOpenPendingApp(); } catch (_) {} }, 1500);
  }

  // v1.79.0：启动后自动修复桌面快捷方式 TargetPath（便携版解压路径变化导致失效）

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

  // v2.2.4：FPK 连接心跳——客户端启动后立即向 fntb 打一次带 X-FNOS-Client 头的请求，
  // 并在运行期间每 4 分钟静默上报一次，让 fntb 的"PC客户端连接"检测（1800s 窗口）
  // 始终能看到活跃客户端，不再出现"客户端显示已连接、图标管理器显示未连接"的误报。
  try {
    const fpkHeartbeat = async () => {
      try {
        const hs = loadSettings();
        if (!hs.fpkApi || !hs.fpkApi.enabled || !hs.fpkApi.host) return;
        const hbBase = `http://${hs.fpkApi.host}:${hs.fpkApi.port || 18080}`;
        await fetch(`${hbBase}/api/client/status`, { headers: { 'X-FNOS-Client': 'desktop' } }).catch(() => {});
      } catch (_) {}
    };
    setTimeout(() => { fpkHeartbeat(); }, 1500);
    fpkHeartbeatTimer = setInterval(() => { fpkHeartbeat(); }, 4 * 60 * 1000);
    if (fpkHeartbeatTimer.unref) fpkHeartbeatTimer.unref();
    dlog('info', 'fpk.heartbeat.started', { interval: '4m' });
  } catch (_) {}

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
    if (fpkHeartbeatTimer) clearInterval(fpkHeartbeatTimer);
    if (g_networkWatcher) clearInterval(g_networkWatcher);
    if (menuRebuildTimer) clearTimeout(menuRebuildTimer);
    if (g_persistTimer) clearInterval(g_persistTimer);
    // v2.1.6：清理主页扫描定时器，避免退出时访问已销毁窗口
    if (__homeScanTimer) clearInterval(__homeScanTimer);
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
