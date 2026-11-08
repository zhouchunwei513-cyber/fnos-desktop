## v5.1.2

### macOS：只发 dmg（不发 zip）+ mpv 目录名兼容

- 打包目标去掉 zip，只保留 dmg（arm64 / x64）；CI 校验、artifact、Release 上传同步改为只认 dmg；
- `findMpvExe()` 兼容 CI 实际产出的目录名（`mpv/arm64/…`）与历史命名（`mpv/mac-arm64/…`）；
- 实测：mac 上点「🎬 MPV 打开」用内置 mpv 播放直播，日志显示 980x730 窗口、960x540 画面正常渲染。

## v5.1.1

### macOS：内置 mpv 运行时（CI 打包）

- 背景：macOS 27 属 Homebrew Tier 3，`brew install mpv` 无 bottle、源码依赖下载失败 → 本机装不了；
- 方案：CI 的 mac job（macOS 15 runner）`brew install mpv` 后，用 `build/mac-bundle-mpv.sh` 把它打成
  最小 `mpv.app`（启动脚本 + 真实二进制 + 递归收集的 dylib），经 `build.mac.extraResources`
  随包分发到 `Contents/Resources/mpv/<arch>/mpv.app`；
- 客户端 `findMpvExe()` 已按该路径探测（阶段一就写好了），探测不到再回退系统 mpv / 自定义路径；
- 跨架构 job（x64 跑在 arm64 runner）自动跳过打包，避免打进错误架构的二进制。

## [未发布] macOS 移植 · 阶段一（构建 + 启动 + 标题栏与红绿灯并存）

> 本轮不改 `package.json.version`（仍 5.0.16）、不部署、不推 GitHub；只做 Linux 环境可自检的部分。
> 详细的「已做 / 未做 / 风险」见 `/tmp/mac-gap.md`。

### 构建链路

- `package.json` 新增 `build.mac`：dmg + zip，`arm64` / `x64` 双架构，`category=public.app-category.utilities`，
  `icon=build/icons/icon.icns`，`artifactName=FNOS-${version}-mac-${arch}.${ext}`，
  `extendInfo.LSMinimumSystemVersion=11.0`；`hardenedRuntime=false`（本轮不签名/不公证）。
- 新增脚本 `dist:mac` / `build:mac`（各自带 `pre*` 钩子）与 `icons:mac`；**Windows 脚本一行未动**。
- 新增 `build/make-icns.sh`：用 macOS `sips` + `iconutil` 从 `icon.png`（1024）生成 10 档标准 iconset → `.icns`；
  已有且比源图新则跳过；非 macOS 环境明确报错退出（不产出坏图标）。`.gitignore` 忽略生成的 `.icns`。
- CI `.github/workflows/build.yml` 新增 `build-macos` job（`macos-14`、matrix arm64/x64）：语法自检 → 生成 icns →
  `electron-builder --mac` → 校验 dmg/zip 存在且 >40MB → 上传 artifact → 追加到同一个 tag Release（并发幂等）。
  `build-windows` job 未修改。

### 平台审计与降级（macOS 不崩、功能优雅降级）

- 新增平台常量 `IS_MAC` / `IS_WIN` / `__ROUNDED_CORNERS`；`roundedCorners` 在 mac 取 `true`（原生圆角），
  Windows 仍为 `false`（去 DWM 灰边）；菜单弹窗这种无边框浮层两平台都保持直角。
- 单实例握手超时提示：Windows 保持 PowerShell MessageBox；mac 改 `osascript display dialog`；
  结束卡死进程：Windows `taskkill /T`，mac `process.kill(SIGKILL)`。
- 注册表读取（`AppsUseLightTheme`、`ProxyOverride`）只在 `win32` 分支执行；mac 走 `nativeTheme`。
- `__wicToPng`（WIC/PresentationCore 图片解码）为 Windows 专有，非 win32 直接返回 `null`，调用方走既有兜底。
- `settings:vlc-runtime` / `mpv:status` 支持 darwin：mac 上探测系统 mpv（Homebrew / MacPorts / `/Applications/mpv.app`），
  找不到时给出「brew install mpv 或指定路径」的提示；`settings:pick-mpv-exe` 在 mac 不再按 `.exe` 过滤。
- 托盘图标在 mac 缩到 18px（菜单栏尺寸）；`download:get-default-path` 在 mac 用 `app.getPath('downloads')`。
- 卸载器（Windows `FNOS-Uninstaller.exe`）在 mac 不再尝试启动，改为「拖到废纸篓」指引，菜单文案同步。
- 菜单在 mac 补 App / 编辑 / 窗口三个标准菜单（否则 Cmd+C/V/A/Z 全失效），并把 `Ctrl+X`→`Cmd+X`、
  `F5`→`Cmd+R`、`Alt+Left/Right`→`Cmd+[/]`；「关于」并入 App 菜单。
- mac 侧新增一组与平台无关的 `app.commandLine` 开关（自动播放、媒体缓存、后台不节流）；
  Windows 的 HEVC / D3D11 / DPI 开关仍在 `win32` 块内，逻辑不变。

### 标题栏

- mac 左侧红绿灯安全区 `82px`/`86px` → **78px**（普通标题栏与内嵌窗标题栏一致）；
  皮肤、牛角、高度、图标配色均未改动；mac 仍不画自绘 `— □ ✕`（交给原生红绿灯）。

### MPV

- mac 不打包 mpv 二进制，改为探测：`/opt/homebrew/bin/mpv`、`/usr/local/bin/mpv`、`/opt/local/bin/mpv`、
  `/Applications/mpv.app/Contents/MacOS/mpv`、`~/Applications/…`、PATH 里的 `mpv`。
- 新增 `rescanMpv()`（清缓存重探，供「装完 mpv 不用重启客户端」）与平台化缺失文案 `mpvMissingReason()`。
- mac 上 `getMpvConfigArgs()` 返回空、`configMode` 默认 `own`：随包 `mpv-config` 里的中文菜单脚本依赖
  Windows `curl.exe` 与本地 helper，mac 上必然失败，故不加载，交给用户 `~/.config/mpv`。

## v5.0.15

### 直播：收紧缓存 + 去掉与 HLS 拉流冲突的重连选项（方案 A）

- 实测 v5.0.14：播放速度正常、硬解 d3d11va、0 丢帧，但 `duration=29.99`（把 3 段窗口当完整媒体），
  pos≈29 时 RESTART → 每 30 秒跳一次；
- 修法（直播专用）：`--demuxer-lavf-o=reconnect=1,reconnect_delay=2,reconnect_delay_max=15`
  （去掉 reconnect_streamed / reconnect_on_network_error），并加
  `--cache-secs=15 --demuxer-max-back=0 --hls-bitrate=max`，让 ffmpeg 持续拉取 playlist。

## v5.0.14

### 直播每 10 秒回到开头：移除 ffmpeg 的 reconnect_at_eof / live_start_index

- IPC 实测（家里机 mpv）：time-pos 9.28 → playback-restart → 0.60 → … → 9.12 → restart，周期≈10s；
  同期客户端 **没有任何 loadfile/end-file 日志** → 不是我们重载，是 ffmpeg 侧自我重开；
- 根因：`--demuxer-lavf-o` 里的 `reconnect_at_eof=1`（分片边界触发重开）与
  `live_start_index=-1`（每次重开都跳到最后一段）组合 → 每 10 秒从新分片头开始；
- 修法：直播只用 `reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay…`，
  点播保持原参数不变。

## v5.0.11

### 自定义内核（mpv-lazy）直播仍循环：禁用 watch-later

- 实测 mpv-lazy 的 `portable_config/mpv.conf` 含 `watch-later-options = start,vid,aid,sid`
  → 会把上次播放位置写入 watch-later，重连/下次播放时按 `start` 跳回 → 直播倒退重播；
- 修法：直播播放时追加 `--no-save-position-on-quit --no-resume-playback`。

## v5.0.10

### MPV 无法启动（exit 1）——移除内核不认识的参数

- 现象：点 MPV 播放，内置/自定义内核都起不来；日志 `mpv.player.exit {"code":1}`
- 根因：v5.0.3 加的 `--hls-live-edge`、`--demuxer-lavf-o-add` 在该 mpv 构建里是**未知选项**，
  mpv 解析失败即 exit 1（v5.0.9 的空跑版本已回退）；
- 本版：删除这两个参数；直播起点改为 `--demuxer-lavf-o=…,live_start_index=-1`
  （ffmpeg 侧选项，未知也不致命）。实测待用户点击播放验证。

## v5.0.9

### 回退致命参数：MPV 无法启动（exit 1）

- 现象：点 MPV 播放，内置/自定义内核都起不来；日志 `mpv.player.exit {"code":1}`
- 根因：v5.0.3 引入的 `--hls-live-edge` / `--demuxer-lavf-o-add` 在该 mpv 构建里是**未知选项**，
  mpv 解析失败即 exit 1；
- 修法：删除这两个参数，直播起点改为合进已有的 `--demuxer-lavf-o=…,live_start_index=-1`
  （ffmpeg 侧选项，未知也不致命）。

## v5.0.7

### 直播"十几秒重播"根因修复：isLive 没传给播放器

- 实测（宿舍机捕获 mpv 命令行）：有 `--loop-file=no`，但**没有** `--hls-live-edge` →
  说明 v5.0.3 的直播参数没生效，因为 `payload.isLive` 没传进 MpvSurface 的 settings；
- 根因：`main.js` 的 embed 分支只 `const st = getMpvSettings()`，payload.isLive 仅用于打日志；
- 修法：`st = Object.assign({}, getMpvSettings(), { isLive: payload.isLive || payload.scope === 'live' })`
  → mpv 按直播处理：加 `--hls-live-edge=1`、EOF 走直播重连而不是点播重载。

## v5.0.4

### 应用内点链接：改为客户端新窗口打开

- 用户要求：应用里点链接/点功能，一律在客户端以新窗口打开，不再跳系统浏览器；
- 修法：`setWindowOpenHandler` 里非 NAS 主机的 http(s) 地址由 `shell.openExternal` 改为
  `createAppWindow(url, { source: 'external' })`（失败才回退浏览器）；
- 日志 `nav.external.window`。

