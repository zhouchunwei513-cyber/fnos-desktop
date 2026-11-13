// 设置页 preload — 通过 contextBridge 暴露 fnosSettings API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnosSettings', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  clearCache: () => ipcRenderer.invoke('settings:clear-cache'),
  // v4.0.48：保持登录开关（全局一个，覆盖主程序/页内应用/独立应用窗）
  setKeepLogin: (on) => ipcRenderer.invoke('settings:set-keep-login', !!on),
  setPassword: (payload) =>
    ipcRenderer.invoke('settings:set-password', {
      oldPassword: String(payload?.oldPassword || ''),
      newPassword: String(payload?.newPassword || ''),
    }),
  setShortcuts: (payload) =>
    ipcRenderer.invoke('settings:set-shortcuts', {
      lockApp: String(payload?.lockApp || ''),
      hideAll: String(payload?.hideAll || ''),
    }),
  setAutoLock: (minutes) =>
    ipcRenderer.invoke('settings:set-auto-lock', { minutes: Number(minutes) || 0 }),
  setUrlRewrites: (list) =>
    ipcRenderer.invoke(
      'settings:set-url-rewrites',
      Array.isArray(list)
        ? list
            .filter((r) => r && typeof r.match === 'string' && typeof r.replace === 'string')
            .map((r) => ({ match: r.match.trim(), replace: r.replace.trim() }))
            .filter((r) => r.match && r.replace)
        : []
    ),
  setUIOptions: (opts) =>
    ipcRenderer.invoke('settings:set-ui-options', {
      autoHideMenuBar: !!opts?.autoHideMenuBar,
      themeColor: opts?.themeColor ? String(opts.themeColor) : undefined,
      // v1.58：标题栏自动隐藏 + 不透明度 + 标题栏颜色
      titleBarAutoHide: typeof opts?.titleBarAutoHide === 'boolean' ? opts.titleBarAutoHide : undefined,
      titleBarOpacity: opts?.titleBarOpacity != null ? Number(opts.titleBarOpacity) : undefined,
      titleBarColor: opts?.titleBarColor ? String(opts.titleBarColor) : undefined,
      // v2.19.0：标题栏材质 / 磨砂强度
      titleBarMaterial: opts?.titleBarMaterial ? String(opts.titleBarMaterial) : undefined,
      titleBarBlur: opts?.titleBarBlur != null ? Number(opts.titleBarBlur) : undefined,
      // v2.19.2：磨砂高光强度
      titleBarHighlight: opts?.titleBarHighlight != null ? Number(opts.titleBarHighlight) : undefined,
      // v3.0.78（用户方案）：磨砂 / 纯色两套视觉参数各自独立、互不共用
      titleBarFrostColor: opts?.titleBarFrostColor ? String(opts.titleBarFrostColor) : undefined,
      titleBarFrostAlpha: (opts?.titleBarFrostAlpha != null && Number.isFinite(Number(opts.titleBarFrostAlpha)))
        ? Number(opts.titleBarFrostAlpha) : undefined,
      titleBarSolidColor: opts?.titleBarSolidColor ? String(opts.titleBarSolidColor) : undefined,
      titleBarSolidAlpha: (opts?.titleBarSolidAlpha != null && Number.isFinite(Number(opts.titleBarSolidAlpha)))
        ? Number(opts.titleBarSolidAlpha) : undefined,
      titleBarDivider: typeof opts?.titleBarDivider === 'boolean' ? opts.titleBarDivider : undefined,
      // v3.0.19：标题栏皮肤（空字符串 = 默认无皮肤）
      activeSkin: opts?.activeSkin != null ? String(opts.activeSkin) : undefined,
      // v3.0.27：悬浮球隐藏开关 —— v3.0.23 引入该开关时本白名单漏加此字段，
      // 导致设置页勾选"隐藏"后主进程永远拿不到真值、回落 false（关不掉、也不落盘）。
      hideAccountBall: typeof opts?.hideAccountBall === 'boolean' ? opts.hideAccountBall : undefined,
      // v4.0.31（用户需求 2）：悬浮球外观。和 v3.0.70 四角、v3.0.23 悬浮球开关同款坑 ——
      // 白名单漏一个字段，设置页保存后静默回弹，所以六个字段必须逐个放行。
      ballAppearanceMode: (opts?.ballAppearanceMode === 'custom' || opts?.ballAppearanceMode === 'follow') ? opts.ballAppearanceMode : undefined,
      ballMaterial: (opts?.ballMaterial === 'frosted' || opts?.ballMaterial === 'solid') ? opts.ballMaterial : undefined,
      ballSolidColor: opts?.ballSolidColor ? String(opts.ballSolidColor) : undefined,
      ballSolidAlpha: (opts?.ballSolidAlpha != null && Number.isFinite(Number(opts.ballSolidAlpha))) ? Number(opts.ballSolidAlpha) : undefined,
      ballFrostColor: opts?.ballFrostColor ? String(opts.ballFrostColor) : undefined,
      ballFrostAlpha: (opts?.ballFrostAlpha != null && Number.isFinite(Number(opts.ballFrostAlpha))) ? Number(opts.ballFrostAlpha) : undefined,
      // v3.0.62：可选「透明界面」（设置 / 帮助 / 关于 页面半透明）
      uiTransparent: typeof opts?.uiTransparent === 'boolean' ? opts.uiTransparent : undefined,
      // v3.0.76：透明度百分比 0~100（0 = 深色实底，100 = 完全透明）。漏加会重演 v3.0.70 四角问题：
      // 设置页拖了滑块主进程收不到，保存后回弹。
      uiTransparentAlpha: (opts?.uiTransparentAlpha != null && Number.isFinite(Number(opts.uiTransparentAlpha)))
        ? Number(opts.uiTransparentAlpha) : undefined,
      // v3.0.71：标题栏四角 / 窗口四角（round 圆角 / square 直角）
      // v3.0.70 漏了这两个字段 —— 设置页选了直角，主进程永远收不到，保存后仍是圆角（用户实测「保存不了」）
      barCorner: ['round-small', 'round-large', 'half-small', 'half-large', 'square', 'round', 'half'].includes(opts?.barCorner) ? opts.barCorner : undefined,
      winCorner: ['round-small', 'round-large', 'half-small', 'half-large', 'square', 'round', 'half'].includes(opts?.winCorner) ? opts.winCorner : undefined,
    }),
  // v2.17.24：标题栏颜色实时预览（只广播，不落盘；保存仍走 setUIOptions）
  previewTitleBar: (opts) =>
    ipcRenderer.invoke('settings:preview-titlebar', {
      titleBarHighlight: typeof opts?.titleBarHighlight === 'number' ? opts.titleBarHighlight : undefined,
      titleBarOpacity: opts?.titleBarOpacity != null ? Number(opts.titleBarOpacity) : undefined,
      titleBarColor: opts?.titleBarColor ? String(opts.titleBarColor) : undefined,
      // v2.19.0：磨砂材质实时预览
      titleBarMaterial: opts?.titleBarMaterial ? String(opts.titleBarMaterial) : undefined,
      titleBarBlur: opts?.titleBarBlur != null ? Number(opts.titleBarBlur) : undefined,
      // v3.0.78（用户方案）：磨砂 / 纯色两套视觉参数各自独立、互不共用
      titleBarFrostColor: opts?.titleBarFrostColor ? String(opts.titleBarFrostColor) : undefined,
      titleBarFrostAlpha: (opts?.titleBarFrostAlpha != null && Number.isFinite(Number(opts.titleBarFrostAlpha)))
        ? Number(opts.titleBarFrostAlpha) : undefined,
      titleBarSolidColor: opts?.titleBarSolidColor ? String(opts.titleBarSolidColor) : undefined,
      titleBarSolidAlpha: (opts?.titleBarSolidAlpha != null && Number.isFinite(Number(opts.titleBarSolidAlpha)))
        ? Number(opts.titleBarSolidAlpha) : undefined,
      titleBarDivider: typeof opts?.titleBarDivider === 'boolean' ? opts.titleBarDivider : undefined,
      // v3.0.76：透明度实时预览（只广播、不落盘）
      uiTransparentAlpha: (opts?.uiTransparentAlpha != null && Number.isFinite(Number(opts.uiTransparentAlpha)))
        ? Number(opts.uiTransparentAlpha) : undefined,
      // v3.0.71：四角实时预览（只广播、不落盘）
      barCorner: ['round-small', 'round-large', 'half-small', 'half-large', 'square', 'round', 'half'].includes(opts?.barCorner) ? opts.barCorner : undefined,
      winCorner: ['round-small', 'round-large', 'half-small', 'half-large', 'square', 'round', 'half'].includes(opts?.winCorner) ? opts.winCorner : undefined,
      // v4.0.31（用户需求 2）：悬浮球外观实时预览
      ballAppearanceMode: (opts?.ballAppearanceMode === 'custom' || opts?.ballAppearanceMode === 'follow') ? opts.ballAppearanceMode : undefined,
      ballMaterial: (opts?.ballMaterial === 'frosted' || opts?.ballMaterial === 'solid') ? opts.ballMaterial : undefined,
      ballSolidColor: opts?.ballSolidColor ? String(opts.ballSolidColor) : undefined,
      ballSolidAlpha: (opts?.ballSolidAlpha != null && Number.isFinite(Number(opts.ballSolidAlpha))) ? Number(opts.ballSolidAlpha) : undefined,
      ballFrostColor: opts?.ballFrostColor ? String(opts.ballFrostColor) : undefined,
      ballFrostAlpha: (opts?.ballFrostAlpha != null && Number.isFinite(Number(opts.ballFrostAlpha))) ? Number(opts.ballFrostAlpha) : undefined,
    }),
  setAccentColor: (color) =>
    ipcRenderer.invoke('settings:set-accent-color', String(color || '#5865F2')),
  // 直播源基地址/线路配置（非代理；仅保留源配置）
  iptvSetConfig: (patch) => ipcRenderer.invoke('iptv:set-config', patch || {}),
  // v1.25.0：兼容性播放器（MPV）设置（通道名沿用 set-vlc/vlc-runtime）
  setVlc: (patch) => ipcRenderer.invoke('settings:set-vlc', patch || {}),
  vlcRuntime: () => ipcRenderer.invoke('settings:vlc-runtime'),
  // v2.21.0：选择自定义 MPV 内核（mpv.exe）
  pickMpvExe: () => ipcRenderer.invoke('settings:pick-mpv-exe'),
  // v2.22.0：清除本机播放进度记录
  clearProgress: () => ipcRenderer.invoke('settings:clear-progress'),
  // v2.0.0：开机自启动
  getAutoStart: () => ipcRenderer.invoke('settings:get-autostart'),
  setAutoStart: (enabled) => ipcRenderer.invoke('settings:set-autostart', { enabled: !!enabled }),
  // v2.4.0（需求 2.5-3）：Renderer → Main：set-auto-launch，参数 { enable: boolean }
  // —— 注册表写入开机自启（HKCU Run，开机命令不带应用 ID），事件名按需求 IPC 定义固定
  setAutoLaunch: (enable) => ipcRenderer.invoke('set-auto-launch', { enable: !!enable }),
  // v2.0.0：多账号管理
  listAccounts: () => ipcRenderer.invoke('account:list'),
  switchAccount: (origin) => ipcRenderer.invoke('account:switch', { origin }),
  removeAccount: (accountId) => ipcRenderer.invoke('account:remove', { accountId }),
  getActiveAccount: () => ipcRenderer.invoke('account:get-active'),
  backToConnect: () => ipcRenderer.invoke('auth:back-to-connect'),
  // v2.0.0：日志系统
  listLogFiles: () => ipcRenderer.invoke('log:list-files'),
  readLogFile: (params) => ipcRenderer.invoke('log:read', params),
  getLogStatus: () => ipcRenderer.invoke('log:get-status'),
  // v1.47.0：ZDY 增强服务（在线弹幕/字幕/片头片尾）及设置模块已整体下线移除。
  // v2.0.7：应用管理
  getInstalledApps: (opts) => ipcRenderer.invoke('get-installed-apps', opts || {}),
  createDesktopShortcut: (payload) => ipcRenderer.invoke('create-desktop-shortcut', payload),
  uninstallNasApp: (payload) => ipcRenderer.invoke('uninstall-nas-app', payload),
  convertSvgIcon: (payload) => ipcRenderer.invoke('app:convert-svg-icon', payload),
  // v2.1.11：快捷方式打开应用后主程序后台化方式（tray 隐藏到托盘 / minimize 最小化到任务栏）
  setShortcutHideMode: (mode) =>
    ipcRenderer.invoke('settings:set-shortcut-hide-mode', String(mode === 'minimize' ? 'minimize' : 'tray')),
  // v2.1.17：FPK 图标管理器 API 配置
  setFpkApi: (patch) => ipcRenderer.invoke('settings:set-fpk-api', patch || {}),
  testFpkApi: () => ipcRenderer.invoke('settings:test-fpk-api'),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  // v3.0.19：皮肤管理 —— 列出已安装皮肤 / 安装 .fskin.zip（选择皮肤走 setUIOptions activeSkin）
  listSkins: () => ipcRenderer.invoke('settings:list-skins'),
  installSkin: () => ipcRenderer.invoke('settings:install-skin'),
  exportSkin: (name) => ipcRenderer.invoke('settings:export-skin', { name: String(name || '') }),
  // v3.0.38：删除已安装皮肤
  deleteSkin: (name) => ipcRenderer.invoke('settings:delete-skin', { name: String(name || '') }),
  close: () => ipcRenderer.send('settings:close'),
});

// v2.15.3：全平台注入。macOS 用 titleBarStyle:hiddenInset（原生红绿灯内嵌），标题栏只画 ☰菜单+拖动、
// 不画 —□✕（交给原生红绿灯）；Windows 保持自绘 —□✕。
try { require('./titlebar-inject')({ ipcRenderer }); } catch (e) { console.error('titlebar inject failed', e); }
