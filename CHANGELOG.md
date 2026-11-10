## v5.2.0（macOS 桌面端收口：登录 / 快捷方式 / 播放 / 菜单 / 打包）

> 本轮把 macOS 端从「能跑」推到「可日常用」，覆盖登录、桌面快捷方式、MPV 播放、菜单外观、
> 圆角观感与构建打包六大块。全部结论都来自 Mac 真机实测（日志 / `/diag` 探针 / 像素扫描），
> 未做「应该好了」式修改。

### 修复
- **局域网 / FNID / Tailscale 登录**：根因是 App **未签名** → macOS「本地网络」TCC 无法记忆授权
  （`-109 ERR_ACCESS_DENIED`、`ERR_ADDRESS_UNREACHABLE`）。`deploy-mac.sh` 每次换 asar 后自动
  `codesign --force --deep --sign -`（adhoc），权限才能记住。三账号实测全部可登录。
- **桌面快捷方式图标白板**：`PlistBuddy` 的 `Set` **不接受类型关键字**，`Set :CFBundleIconFile string app`
  把 `string app` 整个写成值 → Finder 找不到图标；且 `Set` 对不存在的键静默失败导致
  `CFBundleIdentifier` 从未写入。改为 `pbSetOrAdd()`（先 Set 无关键字，失败再 Add 带类型）。
- **创建快捷方式偶发失败**：`osacompile -o` **不会覆盖已存在输出**，桌面残留同名 `.app` 必然失败，且
  `stdio:'ignore'` 吞掉了 stderr。改为先删目标（删不干净则输出到 `.tmp-<ts>` 再改名）+ 重试 1 次 +
  仍失败则**绕开 osacompile 手搭最小 bundle**；错误对话框直接显示真实 stderr。
- **影视「菜单 → 用 MPV 嵌入播放」起不来**（三层根因逐层剥开）：
  ① 菜单只把事件发给当前窗，`pickMenuGuest()` 返回 null → 改**广播**到全部 webContents；
  ② `executeJavaScript` 派发的是**主世界**事件，`contextIsolation` 下 preload（隔离世界）收不到
  → 补 `mpv:menu-embed` IPC 通道；
  ③ preload 里 `if (darwin && !payload.allowMac) return` 把菜单触发也拦了 → `reason==='menu'` 视为显式意图放行。
- **影视 MPV 起播慢 4.7 秒**：`spawn→IPC 就绪` 仅 203ms，但 mpv 收到 `loadfile` 已 4.949s ——
  「播放前几何自校准」每次额外 spawn 1~2 次去量窗口位置，真机量不到（`calib.nomeasure`）仍轮询 ~2.5s×2。
  改为测量不可用时跳过校准（偏移量改用实测常量）。**实测首帧 5.4s → 0.706s**。
- **菜单右侧一大块纯黑**：菜单窗被 v5.1.11~13「统一改不透明」误伤。只把**菜单窗**改回
  `transparent:true` + `#00000000`（其它 13 处窗口保持不透明，红绿灯/拖动白块不回退）。
  自证：面板外 `alpha>8` 像素 **0 个**、maxAlpha=1；对照组主窗 100% alpha=255。
- **安装皮肤包提示「缺少解压组件 adm-zip」**：`deploy-mac.sh` 的 `CACHE` 指向 `fnos-desktop/.deploy-cache`
  （空目录），真正缓存在 `DS1/.deploy-cache`；命中空目录后跳过 `npm i`（断网也装不上）→ asar 里没有
  `node_modules/adm-zip`。改为兜底复制 + **缺依赖直接报错退出**。打包文件数 70 → 88，asar 5.20MB → 5.35MB。

### 观感
- **标题栏 / 窗口圆角与 macOS 一致**：mac 上窗口外形不再用 `clip-path:inset(round)`（只能画圆弧，比例与
  macOS squircle 不同），交给系统 `roundedCorners`；标题栏加 `corner-shape: superellipse(2.2)`（毛玻璃
  面板同款），使 20px 的曲率比例与 macOS 应用窗口一致（Windows 同款，同一份注入代码）。
- **直播 MPV 覆盖窗贴合**：mac 版 mpv **没有** `window-move`/`window-resize`，运行期 `set_property geometry`
  只在启动瞬间生效。实测标定出 `y_实际 = y_请求 + 30px`（mpv 自带头部），所有下发几何统一在
  `MpvPlayer.setGeometry()` 减 30，spawn 与运行期同坐标系。

### 其它
- 设置页「创建快捷方式」列表：**保持飞牛服务端原始顺序**（用户要求），仅会话内锁定首次见到的顺序，
  避免图标补齐前后跳动；新增 `list-desktop-shortcuts` 扫桌面读 `CFBundleName`，命中即标「✓ 已创建」
  并禁用按钮（读磁盘真实状态，重开仍在）。
- 新增 `/diag` 本地诊断通道若干动作：`state` / `winctl` / `menu` / `menupix` / `mpv` / `shortcut` /
  `macinfo` / `dock` / `netprobe` / `connect` / `accounts`，Mac 端问题可一条命令取证。

### 实测矩阵
- 三账号（内网 `192.168.31.101:5666` / FNID `fnos.net/atp2025` / Tailscale `100.103.38.13:5666`）
  × 两种打开方式（程序内 `window.open` / 桌面快捷方式 `.app`）= **6/6 通过**，应用窗均成功加载
  `/app/trim-files/`。

## [未发布] macOS 标题栏汉堡菜单弹窗改回透明窗（去掉黑色背景板）

### 根因
- 菜单弹窗是独立 `BrowserWindow`（`menu-popup.html`），创建处写成
  `transparent: process.platform !== 'darwin'` + `backgroundColor: darwin ? '#14121b' : '#00000000'`。
  mac 上因此是**不透明窗**：页面只画了左边一块半透明面板（`panelW≈99`），窗口其余部分露出窗口底色
  `#14121b` → 用户看到一大块纯黑「背景板」。
- 这行是 v5.1.11~13 修「mac 红绿灯不可点 / 拖动白块」时把窗口统一改不透明**误伤**的：主窗/应用窗有红绿灯，
  必须不透明；菜单弹窗没有红绿灯、只是贴边浮层，本来不该跟着改。
- 上一版只把窗口尺寸收窄到 101×286 贴住面板，但窗口仍不透明 → 阴影/边缘区依旧是一圈黑。

### 改动（只动菜单弹窗，其它窗口一行未改）
- `main.js` `__createMenuPopupWindow()`：`transparent: true` + `backgroundColor: '#00000000'`
  （`frame:false` / `hasShadow:false` / `roundedCorners:false` 保持原样）。
- `main.js` `showCustomAppMenu()`：删掉 mac「等渲染层量准再 show + 500ms 兜底」分支 —— 那段是专门躲
  「不透明窗先闪一块黑底」的，黑底没了之后首次打开也直接 show。
- `menu-popup.js`：`PAD` 由 `__isMac ? 1 : 18` 改为两平台统一 `18`（阴影/描边余量，这 36px 现在是
  alpha=0 的透明像素，与 Windows 版一致）；mac 的「可见面板并集」动态扩/缩窗逻辑保持不变。
- 页面侧无需改动：`html`/`body` 本来就是 `background: transparent`，无 `backdrop-filter`，且 `menu-popup`
  用自己的 `menu-popup-preload.js`（不 `require('./titlebar-inject')`），标题栏/壳色注入不会进这个页面。
- `/diag`：`state` 与 `menu` 动作新增 `menuPopup.bg / transparent / hugDiffW|H / outerDiffW|H`，
  `menu` 另加 `alphaPixels`（把窗口自己的 `capturePage()` 按像素统计 alpha，PNG 落 `/tmp/fnos-menu-popup-capture.png`）。

### 自证（真机 macOS 27.2 / Electron 44.4.3 部署后实测）
- `/diag state`：`createdTransparent=true`、`createdBg='#00000000'`、`bounds=135×320`、`panelW=99`、`pad=18`
  → `hugDiffW/H=0`（窗口 = 面板 + 2×18 阴影余量）、`outerDiffW/H=36`（这 36px 全是透明像素）。
- `/diag menupix`（窗口自身合成面 alpha）：面板外 >60px 的远区 227,126 像素 **alpha=0 占 99.89%、
  alpha>8 的像素 0 个、maxAlpha=1**；面板外 0~18px 阴影环 maxAlpha=136、alpha=255 像素 0 个
  → 窗口表面在面板之外什么都没画。对照组（不透明主窗）772,364 像素 **100% alpha=255** → 方法有效。
  `verdict = transparent:no-window-background(control-ok)`。
- `/diag winsurfaces`：主窗 / 应用窗 `bg=#14121B`、`alphaFullPct=100`（仍不透明）；菜单窗
  `opaque=false`、`alphaFullPct=0.88`（只有文字/图形像素不透明）。
- CDP 截 menu-popup 页面（`tools/cdp-menu-alpha.mjs`）：html/body `backgroundColor=rgba(0,0,0,0)`、
  `backdropFilterUsers=[]`、`documentElement.className=''`（没有 titlebar-inject 注入）；
  截「视口外」475×660 的 PNG，视口外 270,300 像素 **alpha 全 0**，距面板 >60px 的 249,426 像素 **alpha 全 0**。
- 点击透明边距 (3,3) 能关掉菜单（`menuPopup.visible=false`），dismiss 逻辑未受影响。
- 说明：本机未授予 macOS 录屏权限，`desktopCapturer` 报 `Failed to get sources.`（frost 抓屏同样失败），
  所以窗口级证据改用「窗口自身合成面 alpha + 不透明窗对照组」。
- 遗留取舍：mac 的 `PAD` 由 1 改回 18 —— `hasShadow:false` 时阴影只能靠 CSS `box-shadow`，
  窗口不留余量就会被裁掉；这一点与 Windows 完全一致。若坚持「bounds−panelW ≤2px」，
  把 `menu-popup.js` 里的 `var PAD = 18` 改成 `1` 即可（代价：mac 上面板边缘没有阴影）。


## [未发布] macOS 直播 MPV 覆盖窗贴合播放区（嵌入覆盖，非独立窗口）

### 现象
- 直播页点「🎬 MPV 打开」后，mpv 窗口**上方露一条灰带、下方压住控制条**，整体比播放区低一段。
- 现场几何（用户实测 /diag）：直播主窗 bounds=cbounds=(252,118,1280,819)；
  mpv 收到 geometry=980x729+552+152（= 内容区 x=300,y=34 的播放区，尺寸本身正确）。

### 根因（按证据排序）
1. **mac 的 mpv --geometry 的 y 是左下原点**（cocoa/AppKit 语义），Electron getContentBounds 是左上原点。
   期望屏幕矩形 (552,152,980,729)；1080p 屏上左下原点换算后窗口落在 top=1080-152-729=199，
   **下移 47px** —— 顶部 47px 灰带 + 底部 47px 压住控制条，与用户观感逐像素吻合。
2. **启动时机**：页面布局尚未稳定就按当时的 rect 起 mpv；mac 运行期改不了窗口位置 → 错位永久化。
3. **rect 取错元素**：取的是 `#video`（object-fit:contain 的内联元素），不是「灰色播放区」`#videoArea`。
4. 34px 标题栏下压逻辑在 mac 上多余：titlebar-inject 已把 body 整体下移 34px，再压一次就是灰带。

### 修法（保持嵌入覆盖）
- `mpv-surface.js`：
  - 新增 `_macMpvGeometry()`：Electron 顶左坐标 → mpv/cocoa 左下原点（`y = 屏高 - (y+h)`）；
  - 首次起播前**自校准**（loadfile 之前，最多两次额外 spawn）：用 CGWindowList（不需要辅助功能/录屏权限）
    量 mpv 窗口真实矩形；默认左下原点不匹配就试左上原点，仍不匹配则用两次采样求斜率解出精确 geometry；
    结果持久化到 `userData/mpv-mac-geom.json`，后续启动一次命中；
  - 播放区矩形**显著变化**（>16px 或宽/高 >2%）时，带去抖（650ms 静默）**带新 --geometry 重启 mpv**
    （仅直播；点播不打断），重启后按原 URL/headers 重放；拖动/缩放期间合并为一次；
  - mac 上不再做 34px 标题栏下压，严格按上报的播放区矩形；
  - `first-frame` / 重启后各量一次真实窗口，落 `macdiag.mpv.geom.verify {want,spawn,got,delta}`。
- `live.html`：几何来源改为 `#videoArea`；连续两次读数（≥120ms）一致才起 mpv；跟随从 1s 无条件发
  改为 400ms「变化才发」+ 5s 心跳。
- `mpv-player.js`：运行期 AppleScript 通道按 pid 精确移窗、一次调用设位置+尺寸、按值去重、
  成败落日志（成功置 `_asOk`，此时 surface 不再重启；adhoc 重签导致授权失效时自动退回重启贴合）。
- `main.js`：`/diag mpv` 增加 `geomAtSpawn/spawnGeo/macMode/asOk/actualRect/lastVerify`，真机可直接核对差值。

### 验证
- 静态：`node --check main.js / mpv-surface.js / mpv-player.js` 通过。
- 真机：本轮执行环境无网络（`CODEX_SANDBOX_NETWORK_DISABLED=1`，socket() EPERM），无法 SSH 到 Mac 部署，
  未取得部署后的 want/got 数字；`/diag mpv` 已具备一次取齐所有数字的能力。

### 仍未解决
- macOS 是否真为左下原点，需真机 `macdiag.mpv.calib.sample` 三行采样确认（代码已自校准，不依赖先验）。
- 无辅助功能授权时，纯**移动**窗口（尺寸不变）仍只能靠 650ms 后重启 mpv 贴合，会有约 1s 重连黑场。

## v5.1.17（macOS 拖动窗口出现白块 · 根修）

### mac 上页面不再留 alpha=0 空洞：html/body 一律实色 #14121b

- **现象**：mac 主窗不拖动时正常，一拖动/缩放，标题栏预留区（顶部 34px）+ 圆角外四角露白。
- **根因**：窗口本身不透明（`transparent:false` + `backgroundColor:#14121b`，真机 asar 已核实），
  但页面里仍留着两处 alpha=0：①`html` 的 Windows 透明 GIF 守卫 + `body` 下移 34px → 顶部条带整条无绘制；
  ②`html:root` 的 `clip-path: inset(0 round …)` → 圆角外沿无绘制。
  静止时由窗口底色兜底看不出来；拖动/缩放重绘时空洞里没有页面像素，系统补默认底色 → 白块。
- **修法**：mac 上 `html`/`body`/壳色全部实色 `#14121b`（不再有 alpha=0），`html.fnos-ui-transparent` 的
  半透明壳色规则在 mac 不注入（否则又留 alpha 通道）；Windows 一行未动，仍透明 + 磨砂。
- **实测**（CDP `Page.captureScreenshot` 取 RGBA，不受窗口遮挡影响）：
  修复前 alpha=0 占 **5.11%**（顶部条带与四角全为 `(0,0,0,0)`）；注入同一规则的修复后 **0.00%**（全部 `(20,19,25,255)`）；
  撤销后回到 5.11%（可复现/可回退）。对原本不透明的 85,540 个采样像素逐点比对，仅 24 个有差异、最大通道差 17（clip 边缘抗锯齿）→ 外观无回归。
- **副作用**：mac 上「半透明界面」滑块固定为实色；mac 窗口四角始终由系统 `roundedCorners` 提供。
- **未复现说明**：程序化 `setBounds` 拖动（连拍 16/37 帧）白色像素 0.00%，说明白块只在原生拖动/活动缩放重绘路径出现；
  该路径复测需要授予辅助功能权限（会弹系统 TCC 授权框），故未强行验证，待热部署后实机验收。
  排查记录：`/tmp/claude-white-block.md`。

## v5.1.9（macOS 播放方案 A 落地）

### mac 改用 HTML5 播放，并自动绕开私网地址限制

- **背景**：macOS 的 mpv 构建没有运行时窗口定位能力（无 window-* 属性/命令，geometry 仅启动时生效），
  覆盖窗无法跟随主窗；用户拍板改用 HTML5。
- **改造**：影视页不再自动嵌入 MPV（`embed.skip.mac-html5`）；`mpv:embed` 在 darwin 直接返回；
  直播窗隐藏「🎬 MPV 打开」按钮。
- **关键坑**：Chromium 渲染进程对私有网络地址有 PNA 限制 —— `file://` 页面 fetch `http://192.168.x.x`
  直接 Failed to fetch（主进程 curl 却 200），导致 hls.js 报 `manifestLoadError` 黑屏。
- **修复**：`play()` 前用页面自身能力向 FRP / IPv6 线路要播放列表，按频道名找到同频道真实地址并实测，
  命中即用（换线路必须换主机，只换 `line=` 参数无效）。
- **实测**：点 CCTV1 后 `video.readyState=4 / paused=false / currentTime=12`，日志出现 first-frame、playing，
  地址自动切到 `…10301/play/…m3u8?line=frp`。另清理了直播窗 webSecurity 的重复键。

## v5.1.3

### macOS：移除 mpv 不支持的窗口定位命令

- 实测 mac 上 mpv 日志每帧刷 `Command 'window-move'/'window-resize' not found`（macOS 构建没有这两个命令），
  定位完全无效且污染日志；
- 修法：删除 darwin 分支里的这两条命令，定位统一走 `set_property geometry`（WxH+X+Y）+ `window-*` 属性；
- 实测：直播 MPV 播放正常（980x730 窗口、960x540 画面渲染），日志不再刷命令错误。

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

