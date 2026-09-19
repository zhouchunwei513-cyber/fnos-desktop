# FNOS 桌面客户端

## 项目概览
基于 Electron 的 Windows 桌面客户端，用于管理多台 NAS/飞牛影视服务、打开飞牛影视网页、内置直播播放器。当前版本 v1.27.1。

## 网页内直播/视频「用 MPV 打开」取流链路（preload.js，v1.26.9）
飞牛影视 SPA 在 `<webview>` guest 内运行，菜单点击 → window `fnos:mpv-embed` 事件 → `triggerEmbed` → `resolveDirectUrl()` 解析真实流 → IPC `mpv:embed` → main `embedMpvPlay()` 起 MPV。
- **直播页 `/v/live/<id>`**：先 `scanResourceEntries()` 用 **Performance Resource Timing** 扫本页已加载资源，捞出真实 `.m3u8/.flv` 清单（关键兜底：IPTV 直播 hls.js 可能在 Worker 发请求、清单 URL 可能无扩展名，fetch/XHR hook 抓不到）；命中返回 source `live-page-hook / live-resource-scan[-retry]`，失败 900ms 重试 + `live.diag` 诊断日志。
- 电影/剧集：URL query `media_guid` / hook mediaGuid / 路由 itemGuid → playinfo、streamlist → `/v/api/v1/media/range/<guid>`。
- **两类直播流区分**：网盘转码 `${origin}/wp/m3u8?originalUrl=…`（需 Play-Link 头 + Cookie/Auth/Referer，同源）；**IPTV 运营商直连源**（如中国移动 `…chinamobile.com/PLTV/…/*.hls.ts`，IPv6 直连；分片 `.hls.ts` 绝不能当整流，清单是同域 `.m3u8`）。`embedMpvPlay` 用 `sameOrigin` 判断：跨域直连源**不带** NAS Referer/Cookie/Authorization/Play-Link。
- `isManifestUrl()` 判清单（排除 .ts/.aac/.m4s 分片），`isPlayableStreamUrl()` 判可播直链；裸 `.ts` 已从可播白名单移除。

## MPV 窗口层级联动（main.js，v1.26.9）
MPV 是无边框置顶(`--ontop=yes`)独立原生窗。设置页/玻璃对话框/更新检查窗打标记 `__isSettings/__isGlassDialog/__isCheckWin`，在 focus/show/hide/minimize/restore/closed 调 `refreshMpvLayer()`：有阻挡窗 → `setAllMpvOntop(false)`（MPV ontop=no）**且**阻挡窗 `setAlwaysOnTop(true,'screen-saver')`（高于 MPV 普通置顶）；无则恢复。`MpvController.setOntop(on)` 经 IPC `set_property ontop yes/no`。

## 技术栈
- Electron 22.x（Chromium 108，兼容 Win7）/ Node.js
- 原生 HTML/CSS/JavaScript（无构建步骤）
- **兼容性播放器内核：MPV（v1.25.0 起，取代已移除的 libVLC 方案）**：内置 `mpv.exe`（自带 ffmpeg 全解码器，MKV/MP4/HEVC 10bit/4K、HLS/FLV/HTTP/RTSP 全支持），通过 `child_process.spawn` 启动独立播放窗口；Chromium 解不了的飞牛影视视频可一键用 MPV 打开（自动带飞牛登录 Cookie/UA/Referer）。参考实现：fntv-electron（node-mpv-2 外部进程 + 飞牛直链 `/v/api/v1/media/range/<guid>`）。
- hls.js（内置直播网页播放器，保持不变）
- electron-builder（Windows portable 打包）

## MPV 集成架构（v1.25.0）
- `mpv-player.js`：`MpvController` 单例。
  - 二进制发现：打包后 `process.resourcesPath/mpv/mpv.exe`（extraResources 分发），开发态 `__dirname/mpv/mpv.exe`。同目录 `d3dcompiler_43.dll` 为伴随依赖。
  - 用 `child_process.spawn` 启动，参数：`--force-window`、`--window-title`、`--hwdec=<auto|dxva2|d3d11va|no>`（硬解可在设置中切换）、`--http-header-fields`（注入 `Cookie`/`User-Agent`/`Referer`，逗号分隔、自动转义换行）、URL 作为最后参数。单例：新播放先 `stopMpv()` 杀旧进程。
  - 事件：`on(ev)` 订阅 `closed`（MPV 窗口关闭 / 进程退出）。
  - 全平台防御：非 Windows / 找不到 mpv.exe 时返回 `{ok:false,reason}`。
- 触发路径：
  - 飞牛影视 webview（`preload.js`）：监听 `<video>` 的 `error`（code 4 等）与 `stalled`，判定为浏览器原生（非 hls.js）无法解码时，页面内提示并经 `fnBridge.mediaFailed(url/currentSrc/title)` 上报主进程；主进程 `mpv:media-failed` 收集该 webContents 会话的飞牛 Cookie + UA/Referer 后启动 MPV。手动路径：菜单「工具 → 用 MPV 播放当前视频」(`mpv:play`)。
  - 直播页 `live.html`：工具栏「MPV 打开」按钮 → `fnosBridge.mpvPlay({url,title})` → IPC `live:mpv-play`。直播网页播放器本身仍为 hls.js（不变）。
  - 主进程 IPC：`mpv:play`、`mpv:media-failed`、`live:mpv-play`。设置通道名沿用 `settings:set-vlc` / `settings:vlc-runtime`（内部改读 `mpv.settings`，仅保留硬解字段）。
- 媒体追踪：`session.webRequest.onCompleted` 记录每个 webContents host 最近的真实媒体 URL（m3u8/mp4/mkv/mov/flv/ts 等），供 MSE/blob 源（hls.js 播放）失败时回退取真实地址。
- 打包：`mpv/`（mpv.exe 约 115MB + d3dcompiler_43.dll）经 `extraResources` 分发到 `resources/mpv/`，并用 `files` 排除 `mpv/**` 避免重复打进 asar；`compression=normal`（maximum 压缩大文件会导致 nsis 7z 归档失败）。
- **已移除**：libVLC/Koffi（vlc-core.js、vlc-surface.js、vlc-runtime/、koffi 依赖与 asarUnpack）；「用默认浏览器打开」菜单项及其外部 hls.js 播放服务器（48900 `__proxy`）。直播内置播放器等原有功能不变。

## 飞牛网页路由（v1.24.3 修正）
飞牛影视 SPA 为 history 模式、baseUrl=`/v`。实测：
- 媒体流接口 `/v/media/<guid>/main.m3u8` 返回 **application/json 或音视频流（数据 API）**，浏览器直接打开不进播放页；
- 影视详情/播放页是 `/v/movie/<guid>`（电影）、`/v/tv/<guid>`、`/v/tv/season/<guid>`、`/v/tv/episode/<guid>`、`/v/folder/<guid>`（text/html）。电影与媒体流共用同一 guid；
- 直播播放页 `/v/live/<hex>`，直播库入口 `/v/library/<hex>`。
`fnosMediaToWebPage()`：`/v/media/<guid>` → `/v/movie/<guid>`；`/v/live/<hex>` 保持；`/fnplay/<guid>` 第三方网关回退 `/v/movie/<guid>`。

## 常用命令
```bash
# 语法检查
node --check main.js
node --check mpv-player.js
node --check settings.js
node --check preload.js
node --check settings-preload.js
node --check live-preload.js

# 打包 portable（在 Linux 沙箱中可交叉生成 Windows 包）
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm run dist
```

产物：`dist/FNOS-1.24.3-portable.exe`（含内置 VLC 内核，约 95MB）。

## 核心文件
- `main.js`：主进程入口，窗口管理、IPC、直播源解析、会话拉取、生命周期清理。
- `preload.js`：主窗口 contextBridge API。
- `settings.html` / `settings.js` / `settings-preload.js`：设置页。
- `live.html` / `live-preload.js`：内置 HLS 直播播放器。
- `dialog.html` / `dialog.js` / `dialog.css`：自定义弹窗。
- `build/icons/`：应用图标资源。

## v1.18.0 关键架构
- 本地代理模块已移除：无 `proxy.js`，无 8340 监听，无 `webRequest.onBeforeRequest` 直播重定向。
- 播放链路：内置播放器直连 FPK 服务端；飞牛影视 webview 直连源站/FPK。
- `iptv:get-status` / `iptv:set-config` / `iptv:clear-cache` 仅保留为兼容壳：状态固定为未启用，配置只处理 `iptvBaseUrl`、`iptvLine`、`iptvFavorites`。
- GPU 兼容：设置页「GPU 兼容模式」开关读写 `settings.json.disableGpu`，启动时决定是否强制软件渲染；默认启用 GPU，但关闭已知绿屏诱因（gpu sandbox、gpu-rasterization、zero-copy、后台节流）。
- 外部播放器（MPV/PotPlayer/VLC）入口与探测代码已移除，内置 HLS 直播播放器统一处理播放。
- 实验性玻璃效果标题栏已移除，统一使用系统原生标题栏。
- FPK 会话面板：设置页通过 `fpk:get-sessions` IPC，由主进程请求 `${fpkBaseUrl}/api/sessions`。

## 注意事项
- 代码必须保持 Node/Electron 可直接运行，不要引入需要 Babel/TypeScript 编译的依赖。
- 所有窗口/webContents 操作前必须做 `isDestroyed()` 检查，优先使用 `isAlive(win)` / `safeSend(win, channel, ...args)`。
- 退出时清理 `idleAutoLockTimer`、`authHeartbeatTimer`、`g_networkWatcher`、`menuRebuildTimer`、`g_persistTimer`。
- 沙箱环境无法真实启动 Windows Electron 或实测 Win11 绿屏；最终兼容性需在 Windows 实机验证。
