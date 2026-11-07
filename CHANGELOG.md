## v5.1.11（未发版，未部署）

### 应用窗与主窗口统一标题栏 / 窗口显示逻辑（用户要求）

用户明确：应用窗要用与程序主窗口（`--fnos-shell`）同一套标题栏与窗口显示逻辑
（主窗口是期望效果），三处实测差异全部收口，只改必要文件，未升 `package.json` 版本。

- **差异①标题栏显隐**：v5.1.5 起 `__tbFollowsHide` 只让应用窗在隐藏时把让位归零，
  主窗因窗口高度带 +34px 保持 34px → 鼠标推顶调出/移开时，应用窗内容整体上跳/下推 34px，
  主窗内容不动。现在 `__tbFollowsHide = false`，两窗同一模型：窗口外框 = 内容 + 标题栏高度。
- **差异②四角**：录屏逐帧放大采样实锤——同机主窗左上角是大圆角，应用窗左上角是直线直角。
  根因两处：①应用窗专属 `#fnos-win-backplate` 用 `clip-path:inherit`，根节点 clip-path 对
  fixed 后代不生效，底板按矩形铺满把四角填回直角；②内嵌窗 `buildEmbed()` 完全没有四角处理、
  标题栏圆角写死 6px。现在四角唯一来源是 `--fnos-win-r`（`__applyWinCornerStyle` 写入）：
  backplate / 设置窗 / xapp / 应用窗 / 认证页 / 主窗 / 内嵌窗全部引用同一变量，
  `start()` 在所有形态 build 之后统一落一次，内嵌窗标题栏改走 `__fixBarRadius`（按标题栏四角）。
- **差异③34px 让位空带**：快捷方式/冷启动打开的应用窗外框没有 +标题栏高度，配合旧「隐藏归零」
  会出现空带/内容被压。`main.js __fitGeo41` 的 `ratio=1` 分支现在同样 `+bar`，与 in-app 分支一致。

主窗口行为不变（原先 `__tbFollowsHide` 已是 false；四角本来由 `#fnos-win-corner` 覆盖，
现改为同一变量的显式取值，数值一致）。

## v5.1.10（未发版）

### 标题栏四角 / 窗口四角 / MPV 圆角 三项审计修复

- 规范③：窗口裁剪顶部半径不再 `Math.max(窗口上两角, 标题栏上两角)`，
  严格按「窗口四角」取值（半圆角/直角 = 上两角 0），两套设置彻底解耦；
- 规范②：撤销音乐应用窗用 `html:root:root` 强制四角 20px 的写法
  （特异性 0,2,1 压过 `#fnos-win-corner` 的 0,1,1，导致音乐窗无视窗口四角设置）；
- 规范④⑤：MPV 圆角只读「窗口四角」（直播窗仅右上角，半圆角/直角全直），
  `setCornerStyle` 时立即重裁正在播放的窗口，不再等 3s 心跳；顺带更正过时注释。

## v5.1.9

### 应用窗强制不透明底色（用户选择）

- 应用自带 `body{background:rgba(…,0.45)}` 会把桌面透出来，圆角/接缝显灰；
- 修法：应用窗注入 `html>body{background-color:#121517 !important;background-image:none}`；
- 代价：应用窗彻底实心（不再有半透明观感），换取边角干净。

## v5.1.8

### 「透明界面」不再套到应用窗

- 用户澄清：透明界面只针对飞牛菜单 / 二级面板，应用窗不该跟着变半透明；
- 根因：`__applyUiAlpha()` 无条件给 html 加 `fnos-ui-transparent`，应用窗 body 于是被
  刷成 `rgba(5,6,10,α)` → 圆角楔形/1px 接缝透出桌面，看起来是灰色底板；
- 修法：仅非应用窗（主窗口/菜单）才加该 class。

## v5.1.2

### 应用窗给 html 垫不透明底（消除整窗透桌面）

- 实测：应用页 `body` 背景是 `rgba(17,19,23,0.45)`（半透明），窗口本身透明 → 桌面透满整窗；
- 修法：应用窗给 `html` 垫 `#14121b` 不透明底，body 的半透明色叠在其上 → 整窗不再透桌面，
  布局与圆角不受影响。

## v5.1.0

### 应用窗启用系统 DWM 圆角

- 用户要求：页面圆角之外的四个小角不要再露出桌面；
- 修法：应用窗 `roundedCorners: true`（Win11 由系统把窗口本身裁成圆角）；
- 若出现历史问题（#444444 边框），把该项改回 false 即可回退。

## v5.0.9

### 窗口上两角：标题栏与窗口设置取"更圆"的那个

- 现象：窗口四角=半圆角时顶部两角是方的，但标题栏四角设的是圆角，看起来"没生效"；
- 规则：同一对物理角只能一个半径 → 取 `max(窗口上角, 标题栏上角)`：
  窗口半圆角(0) + 标题栏圆角(20) → 上两角 20；两者都直角 → 方；
- 下两角仍只由「窗口四角」决定。

## v5.0.8

### 应用窗底色回退为透明（四角恢复按设置显示圆角）

- v5.0.6 把底色改深色是为了盖住"底部空带"，但真相是 v5.0.7 修的**滚动条**；
- 深色底导致四角出现深色方块（圆角外露出窗口底色）→ 回退为透明；
- 现在：滚动条已隐藏、四角按「标题栏四角 / 窗口四角」正常显示圆角。

## v5.0.7

### 应用窗隐藏滚动条

- 用户实锤：底部那条不是空带，是**横向滚动条**，右侧那条是纵向滚动条；
- 修法：应用窗统一注入 `::-webkit-scrollbar{width:0;height:0;display:none}` +
  `scrollbar-width:none`，滚轮/键盘滚动能力保留。

## v5.0.6

### 应用窗底色改为深色（消除底部空带）

- 应用自身会在底部 / 圆角处留透明区，透明窗口会透出桌面 → 看起来是一条黑带；
- 修法：应用窗 `backgroundColor` 由 `#00000000` 改为 `#14121b`，与页面同色，空带不可见；
- 圆角处也不再透桌面（与音乐窗处理一致）。

## v5.0.5

### 关闭 iframe 试点（应用拒绝被包裹）

- v5.0.3/5.0.4 把 DSH 应用窗装进 iframe 后，页面直接报 `Invalid token`（应用侧拒帧 / 鉴权链路不兼容）；
- 处理：试点开关置为 false，应用窗恢复直载，功能不受影响；
- 结论：真视口要走 **WebContentsView 内缩**（原生子视图下移 34px），不能靠 iframe。

## v5.0.3

### 应用窗「真视口」试点：iframe 包裹

- 背景：应用按 `100vh` 自行排版，而窗口视口含 34px 标题栏 → 底部空带 / 顶部被压 / 播放条被裁，
  逐个应用打 CSS 补丁已经反复失效；
- 试点：仅 DSH 应用窗（`/app/fn-deepseek-harness`）改为加载一个包装页，
  内部 iframe `top:34px; height:calc(100vh - 34px)`，让应用拿到真实短视口；
- 日志 `appwin.wrap.pilot`；验证通过后推广到其它应用窗。

## v5.0.2

### 回退 v5.0.1 的 DSH 根容器偏移

- 实测 `top:20px` 会把 `#root` 推到 54..702（视口 682），反而溢出 20px；
- 该页根容器位置随窗口尺寸/圆角变化，不能写死偏移 → 回退为不干预，待拿到稳定复现再修。

## v5.0.1

### DSH 应用窗底部空带修复

- 实测：该页 `#root` 为 static、height=视口-34，但实际矩形落在 14..664（body 为 34..684），
  顶部被抬走 20px、底部正好空 20px（等于窗口圆角半径）；
- 修法：仅针对 `/app/fn-deepseek-harness` 加 `#root{position:relative;top:20px}`，不影响其它应用。

## v5.0.0

> 里程碑版本：v4 系列的全部修复与优化收口，版本号正式晋级 5.0.0。

### 圆角体系（新增 / 修复）
- 「标题栏四角」「窗口四角」各自五档：小圆角 10px / 大圆角 20px / 小半圆角 / 大半圆角 / 直角；
- **修复**：窗口四角设置不再篡改标题栏上两角（页面裁剪只读窗口设置，标题栏独立绘制）；
- MPV 圆角跟随「窗口四角」：影视窗四角/半圆角；电视直播窗仅右上角（半圆角与直角档归 0）。

### 容器 / 第三方应用
- 标题栏皮肤在所有应用窗生效（静态图改用 data:URL，修 blob 不渲染导致的空标题栏）；
- fixed 全屏布局的应用（MoonTV 等）自动让出 34px，不再被标题栏压住；
- qBittorrent 底部状态栏固定（根因三层：100vh 根容器、body 滚动、内容区未让位）；
- 窗口尺寸/位置记忆按 appview anchor 分键，容器窗关掉重开能回到原位。

### 交互 / 稳定性
- 连接失败后「返回 FNOS 主页」不再无响应；
- 标题栏自动隐藏：推到顶部立即出现（去掉 1.5s 延时）；
- 外部链接（非 NAS 主机）交给系统浏览器，不再弹「应用打不开」。

### 性能
- 入口解析预热、重应用资源预取、加载骨架屏、关窗即停加载。

# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订号`。
完整的安装包与发布说明见 [Releases](https://github.com/zhouchunwei513-cyber/fnos-desktop/releases)。

## v4.0.78

### 音乐窗根治：完全不做 body 几何调整 + 不注入自绘栏

根因：应用窗 body transform 创建包含块 → 音乐页 fixed 播放条被下移 34px 被裁掉；
自绘栏注入又造成顶部金色栏 + 底部白色边缘。

修法（三处同判 `/music`）：
1. build() 跳过自绘栏注入（防双重标题栏）；
2. CSS 几何分支跳过 body transform/padding/margin（播放条贴视口底）；
3. main.js 对 /music 用 frame:true 系统原生标题栏，transparent:false。

## v4.0.110

### 窗口四角与标题栏四角彻底独立（用户澄清）

- 规则：页面（窗口外形）四角**只**取【窗口四角】；标题栏圆角由 `__fixBarRadius` 用
  【标题栏四角】独立绘制，互不写入对方；
- 效果：窗口选「小/大半圆角」「直角」时，窗口顶部两角为直角；
  标题栏的圆角设置只作用于标题栏元素自身，不再改写窗口裁剪。

## v4.0.109

### 电视直播 MPV 圆角：半圆角档归 0（对齐规范 4.2）

- 现状核对：直播 MPV 已跟随「窗口四角」（`__cornerStyle`），且只裁右上角，半径 10/20 正确；
- 差异：`half-*` 档原来仍会出右上角圆角，按规范 4.2 应为 **四角全直**；
- 修法：`this._isLive` 分支改为 `mode = __mpvHalf ? 'none' : 'top-right'`。

## v4.0.108

### 修复：窗口四角覆盖标题栏四角（两套设置完全解耦）

- 现象：窗口四角选「圆角」后，标题栏上两角被强制变成 20px，不受标题栏自身设置控制；
- 根因：页面 `clip-path` 的**上沿**半径取自 `winCorner`（`__topR = __winHalf ? 0 : __winR`），
  而这条 clip 作用于整个 html（含标题栏）→ 视觉上覆盖了标题栏设置；
- 修法：`__topR` 改取 **barCorner**、`__botR` 仍取 winCorner；
  标题栏半圆角（上两角圆）与窗口半圆角（下两角圆）的数值映射本就正确，保持不变；
- 五档数值：小=10px、大=20px、直角=0px。

## v4.0.107

### 外部链接交给系统浏览器

- 现象：点 GitHub Release 链接，客户端把它当应用打开 → 弹「应用打不开」；
- 修法：`window.open`/`setWindowOpenHandler` 里，凡 **非 NAS 主机** 的 http(s) 链接
  一律 `shell.openExternal` 并拒绝建窗；日志 `nav.external.open`。

## v4.0.106

### 1) 连接失败后「返回 FNOS 主页」无响应
- 主窗口停在连接失败/错误页时，确认框 `glassMessageBox` 弹不出来 → Promise 永不 resolve；
- 修法：检测到主窗处于错误/连接页时直接 `goHomeDirect()`；并给确认框 Promise 加 `.catch` 兜底。

### 2) 自动隐藏标题栏：去掉 1.5s 延时
- 鼠标推到顶部原来 1500ms 才出现，按用户要求改为 **立即出现**（延时 0）。

## v4.0.105

### 窗口几何记忆：appview 窗按 anchor 分键

- 现象：容器窗关掉再开，位置/大小记不住；
- 根因：所有 appview 窗的 `pathname` 都是 `/appview`，几何 key 全部相同 → 互相覆盖；
- 修法：`__winGeoKey` 优先取 URL 的 `?anchor=`（如 `trim.docker`）作为 key。

## v4.0.104

### fixed 全屏层让位：选择器改为后代匹配

- 实测 MoonTV DOM：`.fixed.inset-0` 位于 `MAIN` 之内（`BODY > MAIN > DIV`），
  v4.0.103 的 `html>body>div.fixed.inset-0` 匹配不到 → 让位没生效；
- 修法：改成 `html>body div.fixed.inset-0`（后代），仍然只影响这类全屏固定层。

## v4.0.103

### 第三方应用：fixed 全屏首层让位 34px

- 现象：MoonTV 等应用首层是 Tailwind `div.fixed.inset-0`，`position:fixed` 不参与 html 的
  `padding-top`，内容顶到 0 被标题栏盖住（实测内容容器 top=-44）；
- 修法：`html>body>div.fixed.inset-0{top:34px/缩放; height:calc(100vh - 34px/缩放)}`，
  等价于给这类布局一个真实短视口。

## v4.0.102

### 标题栏静态底图改用 data:URL（blob 不渲染的最终解法）

- 决定性与实验：同一 `#fnos-tb-bg` 图层，把背景改成纯红色 → **立刻显示红色**，
  说明图层、尺寸、z-index、display 全部正常，问题在 **blob 图片解不出来**；
- 修法：图片类素材一律生成 `data:<mime>;base64,…`（同步解码、无 blob 生命周期问题），
  视频等非图片素材仍走 blob。

## v4.0.101

### 标题栏静态底图不复用 blob 缓存（修复「有 blob 却不渲染」）

- 实测：同一窗口 `#fnos-tb-bg` 的 `backgroundImage` 是 `blob:…`、尺寸/display/cover 全对，
  屏幕上却是灰色；把 `z-index` 从 -2 改 0 仍灰 → 排除层级，判定为**失效 blob 被复用**；
- 同一皮肤在 Docker appview 窗显示正常，独立窗异常 → 印证「部分窗口复用到了失效 URL」；
- 修法：`bg_alpha.*`/静态底图**不进 `__skinAssetCache`**，每次调用都重新 `URL.createObjectURL`。

## v4.0.100

### 应用窗标题栏皮肤：直接用静态图，不再解码视频

- 实测：应用窗（`--fnos-app-window` / appview）里 `bg.mp4` 解码失败率极高（code4），
  `skin.applied kind=video` 但永远没有首帧 → 标题栏空条；静态图 `bg_alpha.webp` 则稳定可用；
- 修法：应用窗一律用静态图，视频分支只留给主窗；日志 `titlebar.skin.appwin.static`。

## v4.0.99

### 标题栏皮肤：视频不出画面时看门狗换静态图

- 实证：`skin.applied {kind:video, hasBg:true}` 但同窗 `skin.video.error code4` → video 元素在、
  却永远没有首帧，图层是空的（用户看到蓝灰条）；
- 修法：video 挂载后 1.5s 检查 `readyState`，仍 <2 就移除 video 并铺 `bg_alpha.webp`，
  日志 `titlebar.skin.video.watchdog {rs, to}`。

## v4.0.98

### 标题栏皮肤：applyStyle 末尾强制兜底铺图

- 日志证明素材可读（`skin.asset st:ok` bg.mp4 + bg_alpha.webp），但最终 `#fnos-tb-bg`
  没有背景图 → 说明中途被重建/清空；
- 修法：每次 `applyStyle()` 末尾检查「图层在 && 无 video && 无 backgroundImage」→ 直接用
  `skinDir` 铺 `bg_alpha.webp`，日志 `titlebar.skin.static.enforce`。

## v4.0.97

### 标题栏皮肤：deferred 分支主动重拉设置（v4.0.96 只轮询不重取）

- v4.0.96 只轮询 `__skinState`，但 appview 窗里该值恒为空；正确做法是调用既有的
  `__skinReloadSoon()`（内部 `ipcRenderer.sendSync('settings:get-titlebar')` 重取 + 重画）；
- 修法：deferred 分支铺占位后 400ms 触发一次 `__skinReloadSoon()`，日志见 `skin.refetch`。

## v4.0.96

### 标题栏皮肤：等皮肤设置到位后补图（根因修复）

- 实测：appview/内嵌窗的标题栏在「皮肤设置经 IPC 下发」之前就建好了，此时 `__skinState.skinDir`
  为空 → `__loadSkinAsset` 返回空 → 退成 `rgba(12,16,30,.94)` 深色占位，之后再无人重刷
  （实测 `#fnos-tb-bg` 只有底色、`backgroundImage:none`）；
- 修法：占位后启动 300ms 轮询（最多 13 次 ≈ 4s），`skinDir` 一到就铺 `bg_alpha.webp`，
  日志 `titlebar.skin.static.retry-ok`。

## v4.0.95

### 内嵌 appview 窗：套皮肤 + 内容让位

- 用户实测的两个窗都是 `appview?anchor=trim.docker`（内嵌窗），走 buildEmbed 分支：
  ① 原来只盖一条半透明栏、不套皮肤 → qBittorrent 显示蓝灰条；
  ② 覆盖式标题栏、不给页面让位 → 顶部内容被压住；
- 修法：buildEmbed 里 a) 给 html 加 34px padding-top 并同步 body 高度；
  b) 标题栏铺皮肤静态图 `bg_alpha.webp`；日志 `embed.skin.static`。

## v4.0.94

### 标题栏皮肤：后台/隐藏窗口先用静态图顶上

- v4.0.93 只在「视频解码报错」时回退静态图；但另一条路径是窗口被判定为后台/隐藏
  （`__skinCanDecodeVideo()` 为假）→ 只铺深色占位，且部分窗口 visibilitychange 不触发 → 永久灰条；
- 修法：deferred 分支也先铺 `bg_alpha.webp` 静态图（同一画面），窗口可见后再升级成视频；
- 日志 `titlebar.skin.defer.static`。

## v4.0.93

### 标题栏视频皮肤解码失败时回退静态图

- 现象：容器应用（qBittorrent/MoonTV 等）标题栏皮肤包加载不上，变成透明条；
- 日志实锤：`titlebar.skin.video.error code4:MEDIA_ELEMENT_ERROR`（bg.mp4 在部分窗口解不出来），
  旧代码只记日志没有兜底；
- 修法：视频 `error` 时改用皮肤自带的静态图 `bg_alpha.webp` 铺满标题栏（同一画面），
  日志 `titlebar.skin.video.fallback`。

## v4.0.92

### qBittorrent：底栏不再压住详情面板

- `#desktopFooter` 是 absolute 不占布局，`#pageWrapper` 按 100% 撑满 → 面板最后几行被底栏盖住；
- 修法：`#pageWrapper{height:calc(100% - 60px - 28px)}`（扣掉头部 60 + 底栏 28）；
- 实测：pageWrapper 94..552、footer 552..580，两者严丝合缝。

## v4.0.91

### qBittorrent：滚动侧栏时底栏不再跟着走

- 浏览器对比实测：浏览器里 `body{overflow:hidden}`（应用自己管内部滚动），
  客户端第三方分支给 body 设了 `overflow-y:auto` → 滚侧栏时整个 body 一起滚，绝对定位的
  `#desktopFooter` 跟着移动；
- 修法：`html:has(>body>#desktop)>body{overflow:hidden}`，只在 qBittorrent 这类
  「根容器就是 #desktop」的页面关闭 body 滚动，其它第三方应用不受影响。

## v4.0.90

### qBittorrent：底部状态栏不再错位（第三方应用 100vh 根容器）

- 现象：滚侧栏时底部状态栏跟着走/被裁，浏览器里正常；
- 根因：qBittorrent WebUI 的 `#desktop` 用 `100vh` 铺满，html 让位 34px 后它比可视区高 34px，
  `#desktopFooter` 被顶出视口；
- 修法（第三方应用分支 CSS）：`html>body>#desktop{height:calc(100vh - 34px/缩放)}`，
  `#desktopFooter{flex:0 0 auto}` → 底栏重新贴住窗口底部，滚动侧栏不再移动。

## v4.0.89

### 飞牛音乐：四角强制 20px 圆角

- 根因：用户「窗口四角」= **大半圆角**，其定义就是「上两角直角 + 下两角圆」→ 上面两角天生是方的；
- 修法：音乐窗用 `html:root:root`（更高优先级）强制四角 20px，压过圆角模块的 `html:root` 规则；
- 窗口保持透明（v4.0.88），圆角外无任何像素。

## v4.0.88

### 飞牛音乐：圆角外那圈"直角"去掉

- 现象：窗口是不透明的方角窗口，页面裁成 20px 圆角 → 圆角外的四个小方块露出窗口底色（灰），看起来像"圆角外套了个直角"；
- 修法：音乐窗改回**透明窗口**（四角真正镂空），页面 `clip-path` 四角统一 20px，html/body 全透明；
- 结果：窗口视觉上就是一块 20px 圆角的矩形，圆角外没有任何像素。

## v4.0.87

### 应用窗记住尺寸/比例/位置

- 用户要求：客户端与应用窗关闭、重启后记住原来的窗口大小与位置；
- 存储：`userData/win-geo.v1.json`，按 `appId`（无 appId 用 URL path）分键；
- 打开时优先用上次的 bounds（并做屏幕可见性校验，跑到屏幕外则回退默认布局）；
- 拖动/缩放 600ms 防抖落盘，关闭时再存一次；最小化/最大化/全屏态不覆盖记忆值；
- 日志 `appwin.geo87 {key, restored}`。

## v4.0.86

### 飞牛音乐：保留 20px 圆角 + 去掉页面 body 背景

- 用户要求：应用窗保留 **20px 圆角**，同时去掉音乐页自带的 `body{background:rgb(44,40,56)}`；
- 修法：`html{clip-path:inset(0 round calc(20px/--fnos-f)); background:#14121b}`
  + `html>body{background:transparent}`；
- 圆角处露出的是窗口自身深色底（v4.0.84 的 `backgroundColor:#14121b`），既保留圆角又没有灰边。

## v4.0.85

### 飞牛音乐：四个角的灰色来源与消除

- 灰色 = 音乐页自带的 `body{background:rgb(44,40,56)}`，在窗口圆角与标题栏两端露出来；
- 修法：/music 下 `html/body` 背景统一成页面主深色 `#14121b`，去掉 html 的圆角裁剪与标题栏圆角，
  窗口四边不再露出灰边。

## v4.0.84

### 飞牛音乐：四角不再透出桌面壁纸

- 应用窗默认 `transparent:true`（圆角处透出桌面壁纸，自绘标题栏需要）；
- 音乐页是满铺深色页面，透过圆角看到的壁纸（蓝/红渐变）很突兀 → 音乐窗改
  `transparent:false` + `backgroundColor:#14121b`，四角为深色底，不再像"加了块底布"。

## v4.0.83

### 飞牛音乐：播放条缩放到 80%（用户要求）

- `/music` 专用 CSS 加 `.music-player-glass{transform:scale(.8);transform-origin:bottom center}`；
- 实测播放条 576×72 → **461×58**，底边对齐、水平居中，不再遮挡内容。

## v4.0.82

### 飞牛音乐：播放条底部不再被裁

- v4.0.81 后播放条已出现，但仍被底部裁掉 18px：body 让位 34px 后 `#root` 仍按 100vh 排，
  实际区域变成 34..834，底部 34px 溢出视口；
- 修法（/music 专用 CSS）：`#root{height:calc(100vh - 34px)}` + `.music-app-layout{height:100%}`，
  整页正好落在 34..800；实测播放条 712–784，完整可见（与浏览器一致）。

## v4.0.81

### 飞牛音乐：几何补偿彻底跳过（v4.0.80 之后仍被推下去）

- 第二处几何同步模块（周期性重写 body 的 `transform/height`）会覆盖 v4.0.80 的跳过；
- 修法：音乐页在该模块里直接 `return`，并清掉之前写入的 inline `transform/height/max-height/min-height`，
  让 /music 专用 CSS（body padding-top 让位）独立生效。

## v4.0.80

### 飞牛音乐：播放条消失 / 整页下移（浏览器对比定位）

- 浏览器里音乐页正常；客户端里整页下移 **75px**、底部悬浮播放条被挤出视口；
- 根因：/music 专用分支用 `body{padding-top:34px;height:100vh}`（不 transform），
  但标题栏代码的「html padding 为 0 时的 transform 兜底」又给 body 加了
  `translateY(34px/--fnos-f)`（实测 41.16px）→ **34+41=75px 双偏移**，
  页面 absolute 图层整体下移且仍是 100vh 高 → 播放条落到视口外；
- 修法：音乐页（`/music`）跳过该 transform 兜底，只保留 body padding 让位。

## v4.0.79

### 音乐窗播放条完整显示 + 自绘标题栏（用户：被裁+偏大）

根因：播放条是 `position:absolute; bottom:0`（相对 body 的 padding box），
任何 body 高度/transform/margin 改动都会把它推离视口底。

修法（`__padStyle`）：
- `body{padding-top:34px; height:100vh; box-sizing:border-box; overflow:hidden}`
- body 总高 = 视口高，padding box 底 = 视口底 → 播放条贴底完整可见
- 自绘金色标题栏恢复正常注入（固定在顶部，覆盖 body 的 padding 区）

## v4.0.78

### 音乐窗：用系统原生标题栏

对 /music 启用 frame:true，但用户要求自绘标题栏 → 已回退。

## v4.0.76

### 音乐窗：系统原生标题栏（--fnos-native-frame）

对 /music 的应用窗启用 frame:true + transparent:false，页面视口和浏览器一致。

## v4.0.74

### 音乐窗：顶部透明框 + 底部控制栏仍被裁（接 v4.0.73）

- v4.0.73 的 `html{padding-top}` 方案会在窗口顶部留一条 padding 区，窗口透明时透出桌面 →「透明框」；
- 改用 **`body{margin-top:41px; height:calc(100vh-41px)}`**：
  - 不创建包含块 → `position:fixed; bottom:0` 的播放控制栏继续贴**视口底部**，完整可见；
  - 内容整体下移 41px、高度扣掉 41px → 不溢出；
  - 顶部 41px 由自绘标题栏覆盖，不再透出桌面。

## v4.0.73

### 飞牛音乐：底部播放条/列表底部被裁（浏览器正常）

- 音乐 App 的播放条是 `position:fixed; bottom:0`；而应用窗标题栏让位用的是 **body transform**
  （`transform` 会创建包含块，fixed 后代改为相对 body 定位）→ 播放条整体下移 41px，被窗口下沿裁掉；
- 修法：音乐窗改用**第三方应用同款策略**——`html{padding-top:标题栏高}` 让位、
  `body{height:100%}`，不做 transform → fixed 继续相对 viewport 定位，几何与浏览器一致；
- 第三方应用（`--fnos-xapp`）本来就是这个策略，本次把 `/music` 也纳入。

## v4.0.72

### 页内窗自绘栏改为「覆盖式」，修应用底部被裁（飞牛音乐播放条只露一半）

- v4.0.71 的 resize 重排没有根治；真正原因是**布局高度**：自绘栏作为第一个 flex 子节点插入（36px），
  而原生表头被 `display:none` 移除（44px），应用页面按 `100vh` 计算的布局整体超出窗口 →
  底部播放条被窗口下边缘裁掉一半；
- 修法：
  1. 原生表头改为 `visibility:hidden`（**保留 44px 占位**，不再 `display:none`）；
  2. 自绘栏改为**绝对定位覆盖**在原生表头上（`position:absolute; top/left/right:0; height=原生表头高`），
     不占布局空间 → 应用的 100vh 布局与浏览器里完全一致；
  3. 保留 v4.0.71 的 resize 派发作为兜底。

## v4.0.71

### 重应用资源预取

- 桌面就绪 8s 后，对固定几个重应用（相册 `/p`、`/seek`、安全中心 `/app/trim-security`、音乐 `/music`）
  预拉**首页 HTML + 页内 js/css** 到同一 partition 的 HTTP 缓存；
- 用户真正点开时命中缓存，省掉首包与静态资源的网络往返；失败静默，不影响任何加载逻辑；
- 日志 `launch.prefetch.heavy {paths, htmlOk, assetOk}`。

## v4.0.71

### 飞牛音乐底部播放条缺失，拖动标题栏才出现（用户视频取证）

- 自绘栏是"后插"进窗口第一个子节点的，窗口内容区因此变矮 36px；音乐/影视等的**底部播放条是绝对定位、
  按加载时容器尺寸算的**，插入后不重算 → 底部被顶出可视区，拖动窗口触发重排后才露出来；
- 修法：插入自绘栏后在第 0/60/220/700ms 主动 `dispatchEvent(new Event('resize'))`（window + document +
  所有 iframe 的 contentWindow），逼页面重排一次。

## v4.0.70

> 启动性能与体感优化（数据驱动：三台机器 400+ 条 `appwin.load.done`）。

### 1. 重应用加载骨架屏

- 窗口创建后 **300ms 仍未加载完**，就在页面里盖一层骨架（应用名 + 旋转），
  `did-finish-load` / `did-fail-load` 立刻撤掉；快应用（<300ms）根本不会出现骨架；
- 日志 `appwin.skeleton.show`（diag）；实测 seek/相册/fn-deepseek-harness 均按预期触发。

### 2. 入口解析预热

- app-center 清单拉取提前到启动后 **2.5s**（原 6s）；
- 清单到手后调用 `__warmResolveTopApps(12)`：前 12 个应用入口一次性过一遍
  `__resolveAppEntry`，让账号维度记忆 `ok-url.v2.json` 与 app-center 权威候选提前就绪；
- 日志 `launch.warm.resolve {cached, warmed}`，实测 `cached:28, warmed:12`。

## v4.0.69

### 启动性能：关窗即停止加载（数据驱动）

- 三台机器 400+ 条 `appwin.load.done` 统计发现：>3s 的慢加载全部集中在 seek / 相册 /
  安全中心 / 百度网盘 / npc / iscsi 等重应用，`ms` 高达 **50~156 秒**——窗口早已 close，
  页面仍在后台继续加载到 `did-finish-load` 才打点，污染统计且白占网络/CPU；
- 修法：应用窗 `close` 时先 `webContents.stop()`，并记 `appwin.close.stop` 日志；
- 真实加载耗时（客户端自带打点）：**快捷方式中位 594ms、程序内中位 952ms**，本来已是秒开级别。

## v4.0.68

### 自绘标题栏「镜像原生按钮」（用户工单：把原生栏的按钮补回来）

- 之前自绘栏固定画 min/max/close，导致「预览」窗这类带**刷新/新窗口/搜索/下载**的窗口丢按钮；
- 改为**通用镜像**：克隆原生 header 里全部 `.cursor-pointer` 控件（取最外层，避免重复），
  点击代理到原生元素（`clone.onclick → src.click()`），图标与行为都和原生一致；
- 镜像到 ≥1 个控件时不再重复画自己的 min/max/close；镜像不到才回退旧逻辑。

## v4.0.67

### 预览窗「最小化」点了没反应（用户工单 + 视频取证）

- CDP 实测：`.trim-ui__app-layout--window` 有两个窗口——「文件管理」header 里 3 个按钮
  （min/max/close），「预览」header 里**只有 2 个**（max/close，**原生没有最小化**）；
- 旧代码无条件画 min/max/close 三个，最小化代理到不存在的 `.app-layout-header-minimize` → 死键；
- 修法：按原生 header 实际拥有的按钮类决定画哪些（min/max/close 各自判断），
  预览窗现在只显示「最大化 + 关闭」，和系统原生行为一致。

## v4.0.66

### 登录页不再出现滚动条（用户工单：右侧一条竖滚动条）

- `login.css` 追加硬化规则：`html/body` 强制 `overflow:hidden`，并对 `*::-webkit-scrollbar`
  宽度归零（含 `scrollbar-width:none`），任何缩放下都不会再出现滚动条。

## v4.0.65

> 用户工单：家里电脑上「内网账号 192.168.31.101 浏览器能开，客户端打不开」。

### 1. 未登录时不再把窗口弹回连接页（实锤）

- 日志实锤：`login.page detected url=http://192.168.31.101:5666/login` → `login.flag hasTicket:0`
  → 1 秒后 `window.destroy reason=connectpage`。
- 根因：NAS 未登录时把 `/` 302 到 `/login`，`mainWindow.loadURL()` 对 302 后的导航
  可能 reject 成 `ERR_ABORTED/ERR_FAILED`，旧代码 `.catch(() => showConnectPage())`
  直接销毁窗口 → 用户根本来不及在 NAS 登录页输账号密码。
- 修法：catch 里判断「当前 URL 已是 NAS 的 http(s) 页面」就保留窗口（日志
  `login.keep-window why=nav-aborted`），登录成功后 SPA 自己进桌面。

### 2. 登录态诊断补充

- 新增 `login.keep-window` 日志，配合既有 `login.page / login.flag / login.state`
  一眼能看出「是掉登录还是网络问题」。

## v4.0.64

> 多账号实测（第 2 个账号 `121.40.186.165:10300`）抓到的两个链路问题。

### 1. 切账号后快捷方式仍按旧账号解析（实锤）

- `fnos-launch-endpoint.txt` 第 4 行 `nasBase` 只在进程启动时写入；切换账号后不更新，
  快捷方式 `/launch` 收到的仍是旧 origin。实测：切到 `121.40.186.165:10300` 后打开
  `bililivetools`，被拼成 `http://121.40.186.165:5666/`（旧端口），必然超时。
- 修法：① `switchAccount()` 切完立刻把 endpoint 第 4 行改成新 origin；
  ② `__resolveLaunchUrl()` 一律以进程内实时 `__liveOriginBase()` 覆盖传入的 nasAddr。

### 2. 失败分类新增 `port-not-exposed`

- 公网/反代账号通常只映射 NAS 主端口（实测该账号只映射 10300），第三方自有端口
  （`:18080`、`:3000`）从外部不可达，表现为 -118 超时。
- `__failReason()` 识别「同主机、端口≠当前账号端口」→ `port-not-exposed`，
  与 `network-timeout` 区分开，方便给用户"该应用端口未对外开放"的明确提示。

## v4.0.63

> 实测矩阵跑出来抓到两个"权威数据其实是公网地址"的坑（v4.0.62 的 app-center 候选接进来后才暴露）。

### 1. `buildAppCenterUrl` 照搬 `fullUrl`

app-center 条目里的 `fullUrl` 是**公网/反代地址**（实测 `com.fntb.iconmgr → http://121.40.186.165:10307/`、
`bililivetools → http://121.40.186.165:10305/`）。客户端原来无条件优先用它，于是在局域网/组网环境下
打开第三方应用会跑到另一个账号的 host 上，必然超时。

**修法**：`fullUrl` 只在「host 与当前账号一致」或「条目没有任何相对字段（urls.path/port/host）」时才用；
否则用「当前账号 origin + 条目里的 port/path」重新拼，并记 `shortcut.url app-center fullUrl ignored (cross-host)`。

### 2. 解析器兜底

`__resolveAppEntry()` 新增丢弃规则：候选 host 属于**已登记的其他账号** → `drops reason=other-account-host`，
不再可能把别的账号地址当成最终结果。

## v4.0.62

> 复盘文档 `docs/APP-LAUNCH-ARCHITECTURE.md` 的 **P1**：把"按规则推断"升级为"按权威数据 + 失败分类"。

### 新增

1. **app-center 权威候选**：`__resolveAppEntry()` 在「账号维度记忆」之后接入
   `app-center/v1/app/installed` 解析出的真实入口（`__appCenterUrlCache`），候选顺序
   `memo → app-center → rebind-nas-path → raw`。
2. **预热**：本次没有 app-center 数据时，后台触发 `__fetchAppCenterUrlLive(appId)`，
   下次打开直接命中，不增加当前这次打开的耗时。
3. **失败分类** `__failReason(code, url)`，写入 `appwin.load.fail` 的 `reason` 字段：
   | reason | 含义 | 典型场景 |
   |---|---|---|
   | `account-offline` | 另一个账号的 host 连不上 | 切账号后打开旧账号应用 |
   | `port-closed` | 同机端口无人监听 | FRP 高位端口 103xx 在内网 |
   | `network-timeout` | 其他网络超时 | 组网/公网不稳 |
   | `dns` | 解析失败 | DDNS 域名 |
   | `aborted` | 自己取消/被导航替换 | 不算真失败，避免噪声 |
   | `entry-404` | 入口失效 | appview anchor 已被删 |

## v4.0.61

> 用户要求：整体复盘「程序内打开 / 快捷方式打开」两条链路，在 FNID / 内网 / 异地组网 / FRP / DDNS
> 五种账号下都要能正常加载；出方案后自行判断最优解落地。复盘文档见
> `docs/APP-LAUNCH-ARCHITECTURE.md`，本版落地 **P0（统一解析器）+ P2（失败分类与日志）**。

### 新增 `__resolveAppEntry()`（`main.js`，两条链路共用）

- **四元组整体替换**：`scheme/host/port/path` 只允许来自同一来源；
  NAS 内置路径（`/app /appview /cgi /iscsi /vm /snapshot /fn-sync /trim /p /v /music /api`）
  一律重绑到**当前账号 origin**，禁止「旧账号端口 + 当前 host」的拼接。
- **账号维度记忆**：新增 `ok-url.v2.json`，结构 `{ items: { <账号>: { <appId>: {url, at} } } }`，
  取代全局 `ok-url.json`；且**只在 `appwin.load.done` 成功时写入**，不会把失败地址记成可用。
- **最终纠偏**：`__appLoadTarget` 在历史的多处归一化之后再做一次「NAS 路径 → 当前 origin」兜底，
  防止老代码再次拆开 host/port（日志 `resolve.v2.final-guard`）。
- **单条可读日志** `resolve.v2`：appId / 账号 / kind / 来源 / 最终 URL / 被丢弃候选及原因 / 候选列表。

### 与既有机制的关系

- v4.0.47/4.0.60 的「第三方端口不归位」「NAS 路径整段归位」逻辑保留，但由解析器统一裁决；
- v3.0.58 的全局 memo 不再参与选路（文件保留，仅历史参考）。

## v4.0.60

> 接 v4.0.59：用户选定「在 NAS 侧修正入口」。查证后的真实数据形态与修法如下。

### 查证

- `app-center/v1/app/installed`（39 个应用）返回的端口是**正确**的（如 `com.fntb.iconmgr=18080`、`OpenList=34600`），
  host 为空（= 用当前 NAS 主机）。
- 但应用条目里嵌着**公网地址**：例如 `fndesk_1793498656305` 的 URL 参数
  `uB2=121.40.186.165:10311`。登录态把 host 换成当前 NAS（100.103.38.13）后**端口仍是 103xx** →
  本机不监听 103xx（实测 10300/10301/10303/10307/10311 全部拒连）→ `ERR_CONNECTION_REFUSED`。
- 另一类 `121.40.186.165:*` 是另一个账号的 NAS，当前不可达（-118 超时，v4.0.59 已给明确错误页）。

### 修复（把「看端口」改成「看路径」）

- NAS 内置路径（`/app/`、`/appview`、`/cgi/`、`/iscsi`、`/vm`、`/snapshot`、`/fn-sync`、`/trim`、`/p`、`/v`、`/music`、`/api`）：
  换账号时 **host + 端口整体换成当前账号 origin**（不再沿用旧账号的 103xx），日志
  `launch.account-fix mode=nas-path-full-remap`。
- 第三方容器端口（`biliLive-tools :10305`、qBittorrent 等，路径不在上述集合）：
  维持 v4.0.47 的「不归位」，避免把容器应用搬到不存在的端口上。

## v4.0.59

> 用户工单：切换账号后，分别用「程序内打开」和「桌面快捷方式打开」各试一遍，大部分应用打不开；
> 要求查日志、列明哪些应用没加载成功；缺日志就补。

### 日志统计（近 3MB / 128 条失败记录）

| 失败主页 | 次数 | 错误 | 判定 |
|---|---|---|---|
| `http://100.103.38.13:10300` | 21 | -102 ERR_CONNECTION_REFUSED | 本机**不监听** 103xx 端口（实测 10300/10303/10307/10311 全部拒连），是别的账号/外网的端口被套到本机 |
| `http://121.40.186.165:*` | 23 | -118 ERR_CONNECTION_TIMED_OUT | **另一个账号的 NAS 当前不可达**（实测 121.40.186.165:5666 超时） |
| `chrome-error://chromewebdata/` | 14 | -3 | 上面两类失败的连锁结果 |

受影响 appId（部分）：`trim.sync_server`、`trim.security`、`trim.download-center`、`trim.iscsi`、
`npc`、`xte`、`FnMessageBot`、`com.fntb.iconmgr`、`fn-deepseek-harness`（走另一个账号时）。

### 修复

- 连接类失败（-102/-105/-106/-118/-7/-21/-137/-324）时，若目标 host 属于**已登记的其他账号**：
  立即显示「账号『X』当前连不上」错误页并**停止重试**（此前会继续换端口/换候选，导致一串连锁失败）。
  新增日志 `appwin.cross-account-unreachable`（appId / host / account / code）。
- 说明：`100.103.38.13:103xx` 这类「本机端口不监听」的入口，属于服务端登记数据问题，
  客户端已按 v4.0.58 的重复开窗守卫限制为一个窗口；彻底解决需在 NAS 侧修正该应用的入口端口。

## v4.0.58

> 用户工单：「用桌面快捷方式打开应用后，大部分应用报错，然后重复启动报错窗口，一个劲跳窗口。」

### 日志实锤

```
renderer.launch icon-not-found fallback-window-open  in={"anchor":"fndesk_1793327681330"}   ← 每 ~6.8s 一次
wintype appview.to-popout  app=fndesk_1793327681330
appwin  popout.load        url=.../appview?anchor=fndesk_1793327681330  source=in-app
appwin  errpage.hard-reload36  url=.../appview?anchor=fndesk_1793327681330
```

- 直接请求该地址：`appview http=404`（NAS 上这个 fndesk 应用入口已不存在），
  而 `http://nas:5666/` 仍是 200 —— 不是网络问题，是**这个应用入口失效**。
- 失败的页面每轮都**再开一个新窗口**，原有的 2s 防抖拦不住 6.8s 的循环 → 窗口走马灯。

### 修复

- `__appviewToPopout()` 的重复开窗守卫从「2s 内同 anchor 不双开」升级为：
  **同 anchor 30s 内只允许一个窗口**——已有该 anchor 的窗口（即使停在错误页）就只 restore/show/focus，
  不再开新窗，日志 `appview.dup-skip`。用户关掉错误窗后再点仍可重试。

### 待用户处理（数据问题，不是客户端 bug）

- 失效入口是 `fndesk_1793327681330`，请在飞牛桌面删掉对应那个图标/快捷方式（客户端无法判断它叫什么名字，
  只能知道 anchor）。删掉后所有跳窗现象即消失。

## v4.0.57

> 用户工单：「检查标题栏四角与窗口四角设置会不会互相冲突、互相影响——要求两者完全独立；
> 标题栏五档（大圆角/小圆角/大半圆角/小半圆角/直角），窗口五档（大圆角/小圆角/小半圆角/大半圆角/直角）。」

### 排查结论（确实存在耦合 + 一档没生效）

1. **耦合**：`__applyWinCornerStyle()` 里窗口裁剪的「上两角」直接取标题栏设置
   （`__topR = __barR`，v4.0.39 引入），所以改**标题栏**圆角会篡改**窗口**顶部裁剪。
2. **规格未落地**：`__botR = __winHalf ? __winR : __winR` 两个分支完全相同，
   窗口「小半圆角/大半圆角」与「小圆角/大圆角」效果一样，等于半圆角档对窗口无效。

### 修复

- 窗口四角**只**由 `winCorner` 决定：
  `round-*` → 四角圆；`half-*` → 上两角直角 + 下两角圆；`square` → 四角直角。
- 标题栏四角**只**由 `barCorner` 决定（`__fixBarRadius` 未变）。
- 两套设置零耦合；新增 `corner.apply` 日志（barCorner / winCorner / half / topR / botR），
  便于事后核对「改一个有没有动另一个」。

## v4.0.56

> 用户需求：「菜单工具里增加『用默认浏览器打开此窗口』选项，要实测能跑通。」

### 实现

- 「工具」菜单新增 `🌐 用默认浏览器打开此窗口`（快捷键 Ctrl+Shift+O，无边框窗下以菜单点击为准）。
- 新增 `openCurrentWindowInBrowser()`：与「复制当前窗口链接地址」共用同一条 URL 解析——
  优先窗口自身地址（`webContents.getURL()`），不是 http(s) 时退回当前应用窗/guest 的地址；
  解析不到只记日志不弹窗。
- 打开走 `shell.openExternal()`（即系统默认浏览器），成功/失败都写 `menu.open-browser` 日志
  （`ok`、`url`、`winId`、`err`），便于事后对账。

## v4.0.55

> 用户纠正：「自动拉起 DSH 只应该在你热部署重启客户端时做，不该写进客户端程序——别的用户机器上
> 根本没装 DSH，客户端凭什么去启动它？」

### 回滚

- 删除 v4.0.49 引入的客户端侧自动拉起（`autoLaunchDsh` 设置项 + `app.whenReady()` 后 10s 打开
  `/app/fn-deepseek-harness` 的逻辑），客户端不再主动打开任何 DSH 窗口。
- **热部署时的拉起保留在 `DS1/tools/deploy.sh` 第 7 步**（走桌面快捷方式 `DeepSeek Harness.lnk`），
  只影响开发/测试环节，不进入安装包行为。

## v4.0.54

> 接 v4.0.53：迁移时若 `logs/` 里已有同名文件（新版启动会先创建），旧文件被跳过、
> 一直留在根目录（实测残留 `fnos-diag.log` 25MB、`fnos-web.log` 162KB）。

- `__migrateStrayLogs()` 改为：目标存在时把源文件**改名归档**为 `logs/<name>.old-YYYYMMDDHHMMSS`，
  仍然搬进同一个文件夹，根目录不再残留日志。
- 迁移失败（占用等）时先复制再删除，保证不丢内容。

## v4.0.53

> 用户要求：「把安装包的所有日志文件搞到一块，弄一个文件夹……安装以后产生日志全在一个文件夹里面。」

### 现状（实测盘点）

- `%APPDATA%\fnos-client\logs\`：主日志 `fnos-YYYY-MM-DD.log`（按天）
- `%APPDATA%\fnos-client\`（**根目录**，散落 4 个）：`fnos-diag.log`（25MB）、`fnos-web.log`、`fnos-mpv.log`、`fnos-live.log`

### 变更

1. 新增 `__fnosLogDir()` / `__fnosLogFile(name)`：所有日志统一写到 `%APPDATA%\fnos-client\logs\`。
2. 路径全部改到该目录：`fnos-diag.log`、`fnos-web.log`、`fnos-live.log`（含 `.1/.2/.3` 轮转）、
   `fnos-mpv.log`（`mpv-player.js` 的 `_resolveLogPath()` 同步改，并自动建目录）。
3. 启动 3s 后执行 `__migrateStrayLogs()`：把根目录里的历史日志**搬到** `logs/`（同名不覆盖、失败则复制后删除）。
4. 目录不存在时自动创建，不再依赖任何上游先建目录。

### 用户视角

以后只需要看/发**一个文件夹**：`%APPDATA%\fnos-client\logs\`
其中按天的主日志是 `fnos-YYYY-MM-DD.log`，其余诊断/网页/播放器/直播日志也都在同一层。

## v4.0.52

> 接 v4.0.50/51 的登录态日志，修两个**会让诊断失真**的问题（都是实测发现）。

1. **`session.getAllSessions()` 在本机恒返回 0** → Cookie 保活（`__keepLoginSweep`）其实一直空转，
   写日志的 `sessions=0` 也是同一个原因。改用 `__allSessions()`：从 `webContents.getAllWebContents()`
   + `BrowserWindow.getAllWindows()` 反查各自的 `session`，天然覆盖主窗/页内应用/快捷方式应用窗。
2. **`hasSecret` / `secretLen` 被日志脱敏成 `***`**（logger 的敏感键含 `secret`），导致最关键的
   「票据在不在」反而看不到。渲染层字段改名为 `hasTicket` / `ticketLen`。

## v4.0.51

> 接 v4.0.50 的登录态日志，修两个落地问题。

1. **`login.flag`（渲染层上报）原本只进 `fnos-diag.log`**：用户要发日志时通常找不到那份。
   主进程 `fnos:media-log` 处理器里对 `login.*` 阶段额外写一条到 `fnos-YYYY-MM-DD.log`（前缀 `[login]`）。
2. **`login.state sessions=0`**：启动 15s 太早，partition 还没建。改为启动 8s 挂 Cookie 监听，
   并在 15s / 60s / 180s 各快照一次（`startup+15s` / `+60s` / `+180s`），之后每 10 分钟一次。

## v4.0.50

> 用户要求：「增强登录态的日志记录。我让用户出现这种状况的时候，把日志发给我，然后发给你修复这个问题。」

### 新增登录态诊断日志（全部落在 `%APPDATA%\fnos-client\logs\fnos-YYYY-MM-DD.log`，前缀 `[login]`）

| 日志 | 时机 | 内容 |
|---|---|---|
| `login.state` | 启动后 15s、每 10 分钟、以及「检测到登录页」时 | 当前 `keepLogin` 开关、session 数量 |
| `login.state.part` | 同上，逐个 partition | partition 名、Cookie 总数、持久数、会话级数、按域名分布 |
| `login.cookie` | Cookie 变更时（只关心 token/session/auth/uid/login/secret 等） | `set/del`、名字、域名、路径、**过期时间或 SESSION**、变更原因（cause）；**值一律不落盘** |
| `login.flag`（渲染层） | 每页 `__applyKeepLogin` 应用后 | 期望值、`os-keep-login` 实际值、`fnos-Secret` 是否存在及长度、URL、origin |
| `login.page` | 任何 webContents 落到 `/login`、`passport`、`/api/v1/auth` | 完整 URL + 触发一次 `login.state` 快照 |
| `keep-login.sweep` | 每 5 分钟 Cookie 保活扫描 | `fixed=N total=M` |

### 用法（给用户的话术）

出问题时：关掉客户端 → 打开 `%APPDATA%\fnos-client\logs\` → 把当天的 `fnos-YYYY-MM-DD.log`
（或只用 `Select-String '\[login\]'` 过滤后的部分）发过来即可定位是哪一层掉了：
`login.page` 出现 = 这层已掉；`login.flag hasSecret=0` = 票据没存住；`login.cookie del` = 被谁清掉了。

## v4.0.49

> 用户工单（2026-11-05）：「为什么每次部署、飞牛客户端重启以后，你自己（DeepSeek Harness）不启动呢？」

### 现状

- 只有 `DS1/tools/deploy.sh` 会在部署后调桌面快捷方式拉起 DSH；
- 用户**手动**重启客户端、或客户端崩溃自愈后，不会自动恢复到 DSH 窗口。

### 实现（客户端自己负责，不再依赖部署脚本）

- 新增设置 `autoLaunchDsh`（默认 `true`）。
- `app.whenReady()` 后 10s：若本地还没有 `/app/fn-deepseek-harness` 窗口，则用
  `__openAppByWindowType()` 打开（与 `/launch` 接口同一条路径），日志 `launch dsh.autostart ok|fail|skip=exists`。
- 已有 N 个应用窗时只跳过、不重复开。

### 顺带（DS1 侧，不进安装包）

- 微信语音去重改为**按音频内容 sha1**（重放会换文件名/消息 id）+ 注入层「内容哈希 24h 窗口」；
  实测重放副本被 `dedupe skip` 拦下。

## v4.0.48

> 用户需求（2026-11-05，语音）：涉及密码/账户登录的地方都要**保持登录**，除非用户主动退出、
> 或取消「保持登录」；开关放偏好设置里，**全局一个**，**覆盖三层**（主程序 / 桌面内页内应用 / 快捷方式独立应用窗）。

### 现状实测（先测后改）

- 主程序对 NAS 的登录：飞牛前端把票据放 `localStorage`——`fnos-Secret`（24 字符）+ 标记 `os-keep-login=1`；
  CDP 实测重启后**确实保住了**（直接进桌面）。
- 各 partition 的 `Network/Cookies` 里只有 `osrt` / `language`，**没有登录票据**；
  说明主程序登录不靠 Cookie，而第三方应用（qBittorrent、biliLive-tools 等）普遍用**会话级 Cookie**，
  Chromium 退出即清 —— 这才是「应用里登录保不住」的主因。

### 实现

1. **新增全局设置 `keepLogin`（默认开）**：`settings.html` 偏好设置新增「登录状态」区块 + 开关；
   `settings-preload.js` 暴露 `setKeepLogin`；主进程 `settings:get` 返回该值。
2. **渲染层强制**（`titlebar-inject.js __applyKeepLogin`，主窗/应用窗/快捷方式窗都跑）：
   - 开：`os-keep-login='1'`，并把只在 `sessionStorage` 的 `fnos-Secret` 搬回 `localStorage`；
   - 关：`os-keep-login='0'`，并把 `fnos-Secret` 挪进 `sessionStorage`（退出即失效）；
   - 监听 `settings:keep-login-changed` 实时响应，无需重启。
3. **主进程 Cookie 保活**（`__keepLoginSweep`）：启动 20s 后 + 每 5 分钟，遍历 `session.getAllSessions()`，
   把 `session === true` 的会话级 Cookie 改写成 **+1 年** 的持久 Cookie（覆盖所有 partition/第三方应用），
   并 `flushStore()` 落盘；开关关闭时整个 sweep 直接跳过。日志 `login keep-login.sweep fixed=N total=M`。

### 边界

- 用户主动「退出登录」：飞牛自己会清 `fnos-Secret`，我们不做任何拦截。
- 删除历史服务器 / 移除账号：仍按原逻辑清该 partition 的存储（保留原有行为）。

## v4.0.47

> 用户工单（2026-11-05 22:45）：① biliLive-tools 直播录制里点「观看直播」，弹出的播放窗报错；
> ② 同一路直播在这个应用内看卡顿，浏览器看不卡；日志里没有播放侧记录。

### 1. 「观看直播」弹窗报错 —— 账号主机归位误改第三方端口（根因实锤）

日志（fnos-2026-11-05.log 14:39:22~14:39:33）：

```
launch.account-fix  fromHost 121.40.186.165  toHost 100.103.38.13
appwin.target-fix  http://121.40.186.165:10305/#/liveVideoPlayer?...  →  http://100.103.38.13:10305/...
appwin.nav-error   code=-102 ERR_CONNECTION_REFUSED
appwin.load.fail   → error.html?app=FNOS...
```

- biliLive-tools 跑在 `:10305`（独立容器服务），播放页就是它自己的 `#/liveVideoPlayer?...`。
- `__launchAccountFix()`（多账号 host 归位）把主机名从 `121.40.186.165` 换成当前登录 NAS
  的 `100.103.38.13`，但**端口保持 10305**；10305 只在前者监听 → 连接被拒 → 错误页。
- 修法：URL 显式带端口且与当前 NAS Web 端口不同 → 判定为第三方应用端口，**不做主机归位**，
  记 `launch.account-fix.skip reason=third-party-port`。

### 2. 应用内看直播卡顿 —— 补播放侧诊断埋点

日志此前完全没有播放侧数据，无法判断是硬解/丢帧/缓冲还是网络。`preload.js` 新增
`__fnMediaDiag()`（走既有 `fnos:media-log`，落成 `mpv.preload.video.*`）：

- `video.support`：MSE 是否可用、H.264/HEVC 支持、UA、CPU 核数
- `video.found`：来源页、`currentSrc`、分辨率、是否 MSE 直播流
- `video.playing/waiting/stalled/seeking/error/ratechange/ended`：每次带上
  `currentTime / readyState / networkState / droppedVideoFrames / totalVideoFrames / 缓冲水位 / 错误码`
- `video.sample`：播放中每 5s 一条（共 6 条），额外算 `speed = Δ媒体时间 / Δ墙钟`，
  **< 1 就是卡**（1.0 表示实时跟播）

## v4.0.46

> 接 v4.0.45（页内应用窗自绘标题栏）的两处收尾：深色主题配色核对 + 窗口初始摆到视口外。

### 1. 深色主题配色（已核对，无需改动）

自绘栏每 2s 从「被隐藏的原生表头」读 computed `background/color` 跟随，实测切换深色后
文字/图标变白、背景与原生一致（原生表头背景本身是 `rgba(...,0)` 全透明，由窗口底色透出），
无违和，不改代码。

### 2. 窗口初始摆到视口外 → 夹回可视区（新增 `__clampPos` / `__clampInView`）

- 现象（CDP 实测）：飞牛把 Docker 窗摆到 `left:253px width:1100px`，视口只有 1246px，
  右缘 1353 越界，右上角 — □ ✕ 落在视口外，点不到。
- 修法：窗口出现在可视区外时自动夹回，且与拖动共用同一套边界口径：
  - 能整窗放下（宽/高 ≤ 可视区）→ 整窗不越界；
  - 放不下 → 至少保留 120px 宽 + 44px（标题栏）在可视区内。
- 时机：注入后 120/500/1200ms 各夹一次（打开动画/布局稳定后才准），**只越界才动**，
  并打 `inpage.clamp` 日志记录前后位置。

### 3. 拖动边界同步

拖动期间的夹取改为调用 `__clampPos`，与窗口出现时完全一致（此前拖动允许 `left` 到
`视口宽-120`，与「整窗放下」口径不一致，会出现「拖出去后自动弹回」）。

## v4.0.45

> 用户定案（2026-11-05）：「程序内打开的所有应用，标题栏一律用自绘标题栏」——
> 不再去修飞牛前端那套拖动/窗控，直接从根上接管。

### 根因

- 客户端主窗里飞牛桌面打开的应用窗（`.trim-ui__app-layout--window`）的拖动与 — □ ✕
  全部由飞牛前端 bundle 的 `DDe` 钩子处理（header 上 `mousedown` → document `mousemove`，
  按 `clientX/clientY` 改内联 `left/top`，并把这些值夹在
  `left∈[260-width, clientWidth-100]`、`top∈[0, clientHeight-55]`）。
- 这套逻辑与我们的窗口体系无关，高 DPI + RDP 会话下表现为「拖动反向」「点窗控逐次下移，
  最后 top 撞到 `clientHeight-55` 夹取上限、标题栏滑出可视区拖不回来」。
  第三方代码改不动，改为接管。

### 修复（`titlebar-inject.js` 新增 `__watchInPageWindows()`，仅主窗生效）

1. 隐藏页面自带的 44px 表头：注入 `[data-fnos-iw-hdr="1"]{display:none!important}`（走样式表，
   React 重渲染不会把 inline 还原）；
2. 注入 36px 自绘栏：应用图标 + 应用名 + — □ ✕，配色读原生表头的 computed style，主题切换每 2s 跟随；
3. **拖动自己算**：`pointerdown` 记起点，`pointermove` 只用 `clientX/clientY` 增量写
   **body 坐标**的 `style.left/top`，夹取用 `document.body.clientWidth/Height`
   （`top` 下限 0 = 正好贴着主窗自绘标题栏下沿）；**绝不使用 `screenX/screenY`**；
4. 窗控**代理到飞牛原生按钮**（`.app-layout-header-minimize/-maximize/-close`，表头虽隐藏但仍可
   `click()`），因此 `activeWindows` / 托盘 / 最大化 class 状态全部由飞牛自己维护，不会两套状态打架；
   双击标题栏 = 最大化/还原；
5. 松手时把光标最终位置回灌一次 `mousedown/mouseup`，让飞牛重读 rect 同步内部基准，
   避免之后窗口 resize 时按旧基准把窗口拽回原位；
6. `MutationObserver`（rAF 节流）兜住新开的窗口与 React 重渲染。

### 验证（真机 CDP，合成输入走完整事件链）

- 注入后原生表头 `display:none`、自绘栏出现，标题「文件管理」；
- 拖动 `(700,70)→(600,120)`：窗口 `left 163→63`、`top 18→68`，**Δ 精确 1:1，方向正确**；
- 点自绘 □：窗口铺满 `[0,37,1246,678]`；再点精确还原 `[63,105,1100,716]`。

### 配套（DS1 侧，不进安装包）

- `tools/deploy.sh` 第 7 步改为用 Windows 桌面快捷方式
  `C:\Users\<user>\Desktop\DeepSeek Harness.lnk` 重新拉起 DSH（用户要求）：
  快捷方式缺失时回退老的 `wscript + fnos-launcher.vbs` 路径。
  实测 `launch.open ok:true windowType:embed`。

## v4.0.44

> 用户反馈（单位机 34" 带鱼屏 250% 缩放，用 100% 笔记本 RDP 进来）：
> ① 程序内打开的内嵌窗应用拖动反向（往上拖窗口往下跳、往下拖往上跳）；
> ② 点内嵌窗的关闭/最大化/最小化按钮，窗口每点一次往下挪一点，几次后顶边贴到主窗下沿、拖不动。

### 根因（日志 + CDP 实测）

1. **这类窗口根本没走客户端自己的标题栏。** `createAppWindow` 里 `__embedAuto` 判定「URL 是
   `/appview` 且不是快捷方式」的内嵌窗加 `--fnos-embed-style`；而 preload 自 v4.0.9 起对带这个
   旗标的窗口**直接跳过标题栏注入**（当时为了消除「两条标题栏叠一起」）。于是拖动、—/□/✕
   全部由飞牛页面自己画的那条 AppLayout 表头处理。
2. 这正好解释日志怪象：客户端在跑、日志在写，但**完全没有这类窗口的 `drag.arm/start/move/end`
   与 `ctl.maximize`**（只有别的窗口的 `ctl.close`）。v4.0.43 改的「主进程光标同源相减」只作用于
   我们自己的 `win-drag-*` 通道，对内嵌窗无效。
3. CDP 实测（本机 9222，打开 `/appview?anchor=…` 窗口）：窗口里 `document.getElementById('fnos-titlebar')`
   为 `null`，只有页面 AppLayout 表头 —— 与代码判定一致。

### 修复

- `preload.js`：内嵌窗（`--fnos-embed-style`）**恢复注入自绘标题栏**（走 `buildEmbed`：
  logo + 标题 + — □ ✕），拖动/窗控重新回到主进程 `win-drag-*` / `window-minimize|maximize|close`
  通道，直接吃 v4.0.43 的坐标同源修正。
- `main.js`（`createAppWindow`）：内嵌窗在 `did-finish-load` / SPA `did-navigate-in-page` 时
  `insertCSS('[class*="app-layout--header"]{display:none !important}')`，把页面自带的那条表头隐藏，
  只留我们一条（避免 v4.0.9 的两条标题栏叠一起）；并新增 `appwin.embed-bar` 日志留痕。
- 页面表头由 appview 容器在**主框架**渲染，`insertCSS` 只作用于主框架，不会误伤应用 iframe 里的工具栏。
- `titlebar-inject.js`：内嵌窗自绘栏的标题不能空着——页面表头被隐藏后，标题按「appview 表头标题 →
  URL `anchor` → `document.title`」补采（前 6 秒补采 5 次）。截图实测：一条栏 + 应用名 + — □ ✕。

### 验证（CDP + 日志，真机热部署 v4.0.44）

- 内嵌窗里 `document.getElementById('fnos-titlebar')` 存在，按钮 = `fnos-tb-min/max/close`；
  主进程日志 `appwin.embed-bar win=6 why=load`。
- 拖动：`drag.start.src win=… useMain=0 arm=1109,352` → `drag.move base=1109,352 cur=1100,360 -> 500,343`
  → 窗口 (509,335) → (500,343)，与指针同向同量（合成输入无真实光标，故走渲染层同源分支）。
- 按钮：`ctl.maximize win=8 before=509,335,1032,684` → `ctl.maximize.done after=0,0,1920,1048`；
  `ctl.close win=8 bounds=… max=1`。
- 截图：内嵌窗只有一条自绘标题栏（左侧应用名、右侧 — □ ✕），页面自带表头已隐藏。
- 仍待用户真实鼠标复核：`useMain=1` 分支的手感、还原后是否有亚像素偏移。

## v4.0.43

> 用户反馈：250% 缩放 + RDP 100% 环境下拖动反向跳、拖不跟手（仅热部署，正式记录并入本版）。

### 根因

- `win-drag-move` 的基准 `d.sx/d.sy` 来自渲染层 DOM 的 `screenX/screenY`（CSS 像素），
  而位移用的当前光标来自主进程 `screen.getCursorScreenPoint()`（DIP）；两套坐标系在高 DPI /
  混合 DPI 下比例不同，位移被放大甚至反向。

### 修复

- `main.js`：`win-drag-move` 改为「当前光标也由主进程读取」，与窗口 `getBounds()` 同源相减；
- 新增 `drag.move`（前 3 帧）、`ctl.maximize.done` / `ctl.unmaximize.done` 的 bounds 留痕。

## v4.0.42

> 用户反馈：改用 Tailscale 地址登录后，桌面快捷方式打不开 DeepSeek Harness。

### 根因（两处叠加，日志实证）

1. **端口停留在旧 origin**：快捷方式/manifest 存的是公网完整地址
   `http://<host>:10300/app/xxx`，换成 Tailscale 后主机变成 `100.x`、端口却还是 `10300`
   → `ERR_CONNECTION_REFUSED`（日志：`url:"http://100.103.38.13:10300/app/fn-deepseek-harness"`）。
2. **入口质检误判**：端口修正后 `/app/fn-deepseek-harness` 已 200 加载成功，
   但质检把 iframe 形态、正文极短的 DSH 页判成坏入口 → 回退 `/appview?anchor=…`（404）。

### 改动

- `main.js`：连接被拒时，若目标是 NAS 内置应用页（`/app/`、`/appview`），
  按「同主机已知 origin」（settings.origin / history / 账号列表）的真实端口重试一次
  （只作用于内置应用页，第三方容器端口不动）。
- `main.js`：入口质检放宽——落在 `/app/<id>/` 且非登录页时直接认定为有效入口，
  不再切候选链（日志 `appwin.entry-check.app-route-ok`）。

### 验证

```
appwin.load.done {"url":"http://100.103.38.13:5666/app/fn-deepseek-harness"}
窗口标题：飞牛PC客户端 — DeepSeek Harness
```
快捷方式在 Tailscale 会话下可正常打开；热部署 0 ERROR。
## v4.0.39

> 用户工单：标题栏 / 窗口四角「圆角 / 半圆角」各拆成大小两档（共五档），修掉
> 「窗口选圆角后标题栏上两角被强制改成 20px」的老 BUG，两套配置彻底解耦。

### 一、五档定义

| 档位 | 标题栏（上两角 / 下两角） | 窗口（上两角 / 下两角） |
|---|---|---|
| 小圆角 `round-small` | 10 / 10 | 10 / 10 |
| 大圆角 `round-large` | 20 / 20 | 20 / 20 |
| 小半圆角 `half-small` | 10 / 0 | 0 / 10 |
| 大半圆角 `half-large` | 20 / 0 | 0 / 20 |
| 直角 `square` | 0 / 0 | 0 / 0 |

旧值自动迁移：`round → round-large`、`half → half-large`、`square` 不变（观感与升级前一致）。

### 二、解耦实现（修 Bug 的关键）

窗口外形由 `html` 的 `clip-path` 裁出。此前它按「窗口四角」一刀切，把标题栏的上两角也按 20px 裁掉，
看起来就是"标题栏被窗口设置篡改"。

现在改为：**上两角取标题栏档位、下两角取窗口档位**，两套设置各管一半、互不改写。
于是「窗口=直角 + 标题栏=小圆角」能正确呈现为"上圆下直"，反之亦然。

### 三、MPV

- 影视播放窗：完全跟随「窗口四角」（`all` / `half` / `none` + 半径 10/20）；
- 电视直播窗：只右上角出圆角，其余三角固定直角（大档 20px / 小档 10px）；
- 半径按档位下发（此前固定 40 直径），预览时也即时同步（`settings:preview-titlebar` 里补了 setCornerStyle）。

### 四、验证（真机实测矩阵）

```
标题栏（窗口固定大圆角）: 小圆角→10px | 大圆角→20px | 小半圆→10 10 0 0 | 大半圆→20 20 0 0 | 直角→0
窗口  （标题栏固定小圆角）: 小圆角→10 10 10 10 | 大圆角→10 10 20 20 | 小半圆→10 10 10 10
                            大半圆→10 10 20 20 | 直角→10 10 0 0
```

- 改窗口档位时标题栏 `border-radius` 不变（解耦验证通过）；
- 保存后 `settings.json` 落盘 `barCorner=half-small / winCorner=round-large`，重启客户端后仍生效；
- 热部署 0 ERROR。

## v4.0.38

> 用户反馈（含录屏）：客户端内 qBittorrent 的「配色方案」选浅色/深色/自动都不生效；浏览器打开同一页面完全正常。

### 根因（两处叠加）

1. **客户端把 prefers-color-scheme 锁成了自身主题**：`nativeTheme.themeSource` 被显式设成客户端
   主题（light/dark），是**全局**的；第三方页因此看不到 Windows 真实深浅色，"自动"永远跟客户端走。
2. **qB 自己的时序 bug 被放大**：`color-scheme.js` 在 load 早期用
   `ClientData.get('color_scheme')` 决定 class，而该值来自服务端 `clientdata`
   （`qbt_color_scheme`），那时还没回来 → 只能按 prefers-color-scheme 兜底；
   之后值到了却不再重算，于是"选了深色还是白底"。浏览器里兜底值恰好等于系统值，所以看起来正常。

### 改动

| 位置 | 改动 |
|---|---|
| `main.js` | 第三方窗（`--fnos-xapp`）的 `prefers-color-scheme` 改为**读 Windows 注册表 AppsUseLightTheme 的真值**（`__sysThemeDark38`），不再跟随客户端主题；历史"对调"开关仍可用 |
| `main.js` | `__nudgeQbTheme38`：通过已附加的 debugger 在主世界调用 qB 自己的 `ColorScheme.update()`，让 clientdata 到达后立刻重算 |
| `main.js` | 轮询看守（1.2s×50 次，主进程定时器不受遮挡节流）——页面内的 setTimeout/setInterval 在窗口被遮挡时会被 throttling，实测无效 |

### 验证（真机）

- 保存「浅色」→ 重新打开窗口：`html` 无 `dark`、body 白底；
- 保存「深色」→ 重新打开窗口：`html.dark`、body `rgb(18,18,18)`；
- 打开设置改深色并点保存 → 约 1.2s 内自动变深（无需手动刷新）；
- 日志 `xapp.qb-theme38 {ret:"ok:dark:…"}`（仅变化时记录）；0 ERROR；
- 仅热部署，未推送远端。

### 追加：深浅混搭（用户截图：浅色页面里黑滚动条 / 黑右键菜单）

`html` 上的内联 `color-scheme: dark` 是**残留**：qB 切主题只 toggle `dark` 类，不会回收这个属性；
而滚动条、下拉菜单、列头右键菜单等原生控件按 `color-scheme` 绘制 → 浅色页面里继续出现深色部件。
修复：看守脚本在调用 `update()` 后，按页面实际是否带 `dark` 类把 `color-scheme` 同步成 light/dark。
验证：浅色下表格滚动条、列头右键菜单均为浅色（截图像素确认）。

## v4.0.36

> 用户反馈：客户端里的应用窗口「先能打开，后来自动跳到错误页（应用不存在或未安装）」。

### 根因（日志实证）

```
appwin.nav-error   {code:-102 ERR_CONNECTION_REFUSED, url:"http://<host>/app/fn-deepseek-harness"}  ← 地址丢了端口 :10300
appwin.conn-fallback30 → 改走 /appview?anchor=fn-deepseek-harness → 404「应用不存在」
```

链路是三层叠加：

1. 某条入口数据给的是**不带端口**的裸 host，窗口连 `:80` 被拒；
2. 连接失败回退逻辑直接改走 `appview?anchor=`，但 `/app/<id>/` 类应用没有这个 anchor → 404；
3. 客户端窗口里还缓存了**旧版前端**（实测：同一地址强制刷新后正常，缓存态报
   `Failed to load plugins … cot-translation`），被入口质检判成坏入口，进一步加剧跳转。

### 改动

| 位置 | 改动 |
|---|---|
| `main.js` | `did-fail-load` 增加**端口自愈**：连接失败且 URL 缺端口、与当前站点同 host 时，先用 `origin` 补端口重试一次，再考虑 appview 回退 |
| `main.js` | `__fnShowErrPage` 增加**一次强制刷新**：显示错误页前先 `reloadIgnoringCache()`，每窗仅一次，刷新后仍坏才显示错误页 |
| `main.js` | 新增 `settings:clear-cache`：清 HTTP 缓存 / ServiceWorker / ShaderCache，**不动 Cookie 与 localStorage**，登录态保留 |
| `settings.html` / `settings.js` / `settings-preload.js` | 设置页新增「维护 ▸ 清理应用缓存」按钮，清理后提示占用大小 |

### 验证（真机）

- `appwin.port-fix36`：`http://host/app/…` → `http://host:10300/app/…`，窗口正常加载；
- 设置页按钮实测：`已清理（约 127.1 MB），重新打开应用即可`；
- 人为打开不存在的 anchor：日志出现 `errpage.hard-reload36`（先强制刷新，不再直跳错误页）；
- 热部署哈希一致、进程数 6、日志 0 ERROR。

### 追加：设置页样式对齐 + 部署脚本自动恢复窗口

- 「维护」区块改为标准 `<section class="settings-section">` 结构（标题条 / 描述 / 行内按钮），
  与偏好设置页其余卡片风格一致；此前是裸 `hotkey-row`，视觉上脱离卡片；
- `tools/deploy.sh` 增加「7/8 恢复 DSH 窗口」：热部署会重启客户端，脚本自动用桌面快捷方式
  （`fnos-launcher.vbs fn-deepseek-harness`）把对话窗拉回来，避免部署后无窗可用。

### 已知限制补充（qBittorrent 这类 Docker 容器）

容器 WebUI **没有注册成 fnOS 应用**（`/app-center/v1/app/installed` 39 个应用里查无此项），
因此没有 appview anchor，客户端内无法按应用打开；已在桌面生成 `qBittorrent.url`
（指向 Tailscale 地址），双击用浏览器打开。

## v4.0.35

> 用户反馈：**从桌面快捷方式启动的内嵌窗应用没有标题栏**——窗口既没有 ☰ 也没有 —□✕，还不能拖动。

### 根因

`createAppWindow` 里的 `__embedAuto` 只按 URL 判定：路径是 `/appview` 就认为 fnOS 前端会自绘
默认标题栏（logo + 标题 + ↻↗—□✕），于是**跳过自绘标题栏注入**。

但快捷方式的目标正是 `/appview?anchor=<appId>`，而该路径在快捷方式场景下 fnOS 前端并不渲染
那套标题栏（实测窗口全裸）。程序内从应用中心点开时才有默认标题栏，所以只有"快捷方式启动"这一路出问题。

### 修复

`__embedAuto` 增加来源判定：`opts.source === 'shortcut'` 时**强制走自绘标题栏**（`return false`），
其余路径保持原行为（程序内打开仍是 embed 形态，保留 fnOS 默认标题栏与「新标签打开」按钮）。

### 验证

- 用真实快捷方式链路复现：`wscript fnos-launcher.vbs "Docker" FNOS.exe <origin>`；
- 修复前：`/appview?anchor=trim.docker` 窗口无任何标题栏；
- 修复后：窗口左上出现 ☰、右上出现 —□✕，可拖动可关闭（截图比对通过）；
- `node --check` 通过，热部署后进程正常、日志 0 ERROR。

### 追加修复（同日，用户对比截图反馈）

补上标题栏后暴露出第二个问题：快捷方式窗口里**页面内容被压住**——appview 页面自带一条
浮动表头（`app-layout--header`），实测它与本页 iframe 的 `top` 都是 0（去掉我们的位移后依旧重叠），
于是侧栏首项被压在表头下面，视觉上"串行"。

修复：仅当 `source === 'shortcut'` 且 `__embedAuto === false`（即本条自绘标题栏路径）时，
在 `did-finish-load` 注入 `[class*="app-layout--header"]{display:none}` —— 该浮层内容
（应用名 + 关闭）与自绘标题栏重复，隐藏后内容紧贴标题栏下沿，与客户端内打开一致。

对比验证：同一 `appview?anchor=trim.docker`，修复前侧栏首项与表头文字重叠，修复后
标题栏 + 应用内容层次正常（截图比对通过），`#fnos-titlebar` 仍在、未被改动。

## v4.0.34

> 用户需求：把「强力卸载器」集成进客户端，菜单里直接调用。

### 做了什么

在 **帮助** 菜单新增「卸载 FNOS 客户端…」，点击后二次确认 → 启动随包分发的
`FNOS-Uninstaller.exe`（管理员权限）→ 客户端自动退出，避免占用文件导致清理失败。

| 位置 | 改动 |
|---|---|
| `main.js` | 新增 `getUninstallerPath()`（打包态 `resources/uninstaller/`、开发态 `bin/uninstaller/`）与 `launchUninstaller()`（确认框 → `shell.openPath` 提权启动 → 兜底 PowerShell `Start-Process -Verb RunAs` → 1.5s 后退出应用） |
| `main.js` | 菜单模板 `帮助` 子菜单插入「卸载 FNOS 客户端…」；走自绘菜单（`fnmenu:invoke`）与原生菜单同源，零分叉 |
| `package.json` | `win.extraResources` 增加 `bin/uninstaller → uninstaller` |
| `.github/workflows/build.yml` | 打包前用 `csc` 编译 `tools/uninstaller`，产物缺失即中止发布 |
| `.gitignore` | 忽略 `bin/uninstaller/*.exe` 编译产物（仓库只存 `.cs` 源码） |

### 验证

- `node --check main.js` 通过；
- 热部署到真机：`app.asar` SHA256 本地/远端一致，重启后 6 进程、日志 0 ERROR；
- 菜单实测：帮助 ▸ 卸载 FNOS 客户端… 条目可见；点击弹出确认框（含卸载器路径），
  取消后正常关闭、不启动卸载器；
- 卸载器定位日志：`[uninstall] menu.click` / `exe` 两条 info 级记录。

## v4.0.33

> 用户反馈：v4.0.32 把 Docker 应用主题对调后，要求「再调回来」。

### 做了什么

把 v4.0.32 的「第三方应用窗主题对调」**默认关闭**，第三方页恢复 4.0.31 行为（拿到与客户端一致的 `prefers-color-scheme`）。

不是简单删代码，关闭路径做了三处收紧，确保等同 4.0.31：

| 位置 | 4.0.32（开） | 4.0.33（关，默认） |
|---|---|---|
| `__XAPP_INVERT_DEFAULT` | `true` | `false` |
| `__registerXappWin31()` | 注册 `did-start-loading`/`did-finish-load`/`did-navigate-in-page`/`devtools-closed` 四个监听并入集合 | 开关为关时**直接 return**：不挂监听、不进集合、不 attach |
| `__applyXappThemeInvert31()` | 先 `debugger.attach` 再判断开关 | 开关判断提到 attach **之前**；仅在「此前已 attach 过」的窗口上清覆写并 detach，绝不新 attach |

所以关闭态下的第三方应用窗：没有 debugger 附着、没有 `Emulation.setEmulatedMedia`、没有新增监听，行为与 4.0.31 一致。

### 想再对调一次

- 临时：`settings.json` 写 `"xappThemeInvert": true`，重启即生效（不用重装）；
- 永久：把 `main.js` 的 `__XAPP_INVERT_DEFAULT` 改回 `true` 再发版。

日志口径不变：只有开启对调时才打 `xapp.theme-invert{sees,clientSees}`；关闭态不会出现这条日志——如果还看到它，说明 `settings.json` 里残留了 `xappThemeInvert: true`。

## v4.0.32

> 用户反馈：DOCKER 应用的主题模式暗模式和亮模式反了，要求把两者对调。

### 先把事实说清：方向没接反，但观感确实是反的

4.0.30/4.0.31 的探针日志（`fnos-diag`）可以逐项对上：

```json
{"kind":"skip","reason":"third-party-page","href":"http://192.168.31.101:8080/",
 "clientDark":false,"clientTheme":"light","mqDark":false,"pageColorScheme":"light",
 "bodyBg":"rgb(5, 6, 10)"}
```

客户端选的是亮模式（`storeMode=10`），第三方页拿到的也是亮（`mqDark:false`、`pageColorScheme:light`）——**链路本身没有接反**。问题在于这类容器应用（Docker 映射端口出来的页面）自己有默认配色（实测页面底色 `rgb(5,6,10)`，本身就是深色 UI），它只是用 `prefers-color-scheme` 去切"亮色变体"，于是客户端选亮时页面反而亮得很奇怪、选暗时又变得不对。按你的要求，本版直接做**对调**。

### 实现：只对第三方应用窗反转，壳层零波及

不能直接对 `nativeTheme.themeSource` 取反——它是**全局**的，会把飞牛自家页面里依赖 `prefers-color-scheme` 的组件、Electron 原生控件（菜单/滚动条/弹窗）一起翻转，壳层会乱。

改用 CDP 的 `Emulation.setEmulatedMedia`，对**单个 webContents** 强制 `prefers-color-scheme`：

- 同时覆盖该页的 **CSS `@media`** 与 **JS `matchMedia`**，正是"只调换 Docker 应用"需要的粒度；
- 只在 `--fnos-xapp` 旗标窗（`win.__fnosXApp45`）上 `debugger.attach`，主窗/设置页/影视直播窗不 attach，**表现与 4.0.31 逐像素一致**；
- 注册时机与补偿：`did-start-loading` 就先 attach（emulation 在导航间保持，首帧即反相，不会"先正后反"闪一下），`did-finish-load` / `did-navigate-in-page` 再兜底重发；用户按 F12 开过开发者工具会顶掉 attach，`devtools-closed` 后自动补回；
- 主题真值变化（`theme:mode` 上报、系统 `nativeTheme updated`、30s 轮询）时 `__broadcastXappTheme31()` 全量重刷，**不刷新页面**即反相跟随。

新增日志 `xapp.theme-invert{why,winId,wcId,sees,clientSees,storeMode,url}`：`sees` 是页面实际拿到的值，`clientSees` 是客户端真值，两者应当**恒互反**。若哪天又"反回去"，一条日志就能定位是哪一层翻了。

### 回滚 / 再对调

- 开关常量：`main.js` 的 `__XAPP_INVERT_DEFAULT`（现为 `true`）；
- 或直接在 `settings.json` 写 `"xappThemeInvert": false`，重启即恢复 4.0.31 行为，**不需要重装**；
- 关掉开关时会主动 `features: []` 清覆写并 `detach`，不是留个半截状态。

### 边界（说清楚免得白试）

本版只覆盖**独立应用窗**（`--fnos-xapp` 旗标窗）。如果某个 Docker 应用是**嵌在飞牛桌面 iframe 里**显示的（和主窗同一个 webContents），对它做 emulation 会连壳层一起翻，所以刻意没碰；这类场景需要等飞牛前端自己提供主题参数，或用 webview 独立 guest 后再纳入。

## v4.0.31

> 用户反馈 2 条：①磨砂/纯色下换皮肤要等很久才出来 ②账号悬浮球希望跟随标题栏的材质/颜色/浓度，也要能单独设置。

### 1. 换皮肤慢：四条放大链路逐一掐掉

日志（`fnos-diag(14).log`，22:14:32~22:14:38）里 6 秒内点了 10 次皮肤，每次 `skin.asset` 100~1705ms，`skin.video.ok` 成对出现——这不是"读文件慢"，是下面四条放大链路叠在一起：

| 链路 | 原行为 | 现在 |
|---|---|---|
| ① 广播双发 | 先给每个 `BrowserWindow` 发一遍 `settings:titlebar-changed`，再用 `getAllWebContents()` 发一遍 → 每个窗口的渲染进程收到 2 次，皮肤视频解码 2 次、blob 建 2 次 | 只保留 `getAllWebContents()` 一轮（它已含全部窗口与 webview guest），日志新增 `titlebar.push{targets,wins}` 可直接核对 |
| ② 后台窗口也解视频 | 50+ 个窗口（含最小化/被遮住的）同时解一段背景 mp4，主线程+GPU+磁盘一起排队 | 新增 `__skinCanDecodeVideo()`：`document.hidden`/`visibilityState!=='visible'` 时只铺底色占位，窗口重新可见或获得焦点再补视频（`skin.video.resume`）；`skin.video.defer` 记录被延后的窗口 |
| ③ 磨砂反复抓屏 | 每拖一次滑块/点一次皮肤都走 `__syncFrostAll` → 每个窗口 `setEnabled` 重建采样器（每次保护 300ms） | `__syncFrostAll` 增加"开关+窗口集合"指纹，没变化直接跳过（`frost.sync.skip`）；皮肤接管整条标题栏时 `__frostWanted()` 直接返回 false，不再抓屏 |
| ④ 设置高频重放 | 拖滑块每 40ms 一条广播，渲染端每次都重建皮肤层 | 渲染端对 `settings:titlebar-changed` 做 payload 指纹去重，同一份配置不再重放 |

另外：切皮肤时把「不属于当前皮肤目录」的 blob URL 全部 revoke（`skin.asset.prune`），此前只增不减；新增 `skin.applied{hasBg,kind,deferred,hasShape}` 回执，下次再慢能直接看出是哪个窗口、哪一步、是否被降级。

### 2. 悬浮球外观可跟随标题栏，也可单独设置

设置 → 界面 → 「悬浮球外观」：

- **跟随标题栏**（默认）：球直接吃标题栏当前材质与配色——标题栏切磨砂/纯色、改颜色、拖浓度，球同步变（`follow` 模式下球体 = 标题栏的镜像，不再是一块固定白玻璃）。
- **单独设置**：球用自己的材质（纯色/磨砂）、颜色、浓度，标题栏怎么改都不影响球。
- 球只有 40px，磨砂浓度按标题栏的 2%~35% 会糊成一坨，这里收敛到 55% 上限；纯色浓度下限 40%（再低深色壁纸上图标就看不清）；浅色底+足够不透明时图标自动转深色。

数据链：`settings.json` 六个字段（`ballAppearanceMode/ballMaterial/ballSolidColor/ballSolidAlpha/ballFrostColor/ballFrostAlpha`）→ `set-ui-options` / `preview-titlebar` 白名单 → `__ballPayload()` 统一派生 → 渲染端 `__applyBallLook()` 写 CSS 变量 → `#fnos-acct-trigger` 读取。改完即时预览，点「保存界面设置」长期生效。

（白名单六字段逐个放行，避免重演 v3.0.70 四角、v3.0.23 悬浮球开关那种"保存后静默回弹"。）

## v4.0.30

> 用户反馈 5 条：①亮/暗模式下 Docker 应用大多不跟随 ②部分应用启动后跳到飞牛主页 ③日志能否覆盖这些情况 ④客户端与浏览器都打不开是否与客户端无关 ⑤「无操作自动锁定」下拉菜单被下方卡片遮住。

### 1. 下拉菜单被卡片遮挡（设置页，纯 CSS）

`settings.css` 里每张 `.settings-section` 都带 `backdrop-filter`（非 none 即创建层叠上下文），同级卡片按 DOM 顺序绘制，后面的十几张卡片整体压住前面卡片里的菜单。原来只在 `.hotkey-row` / `.form-field` 上加 `z-index:200`，那是在**同一张卡片内部**比较，出了卡片必然输给后面的卡片。

修复：新增一条 `.settings-card > .settings-section:has(.glass-select.open){position:relative;z-index:300}` —— 打开下拉的那张卡片整体浮到其余卡片之上，菜单随卡片一起显示在最前面。透明度、磨砂、配色一律未动，其余 7 个下拉（隐藏模式 / FPK 线路 / VLC 系列）同时生效。

### 2. 应用打不开时不再静默跳飞牛主页

`main.js` 的 `did-fail-load` 里，连接类失败（-102/-324 等）会把窗口改跳到 `fail-cand` 候选列表第一项——就是 NAS 主页 `:5666/`。于是「容器没起 / 端口没监听」被伪装成「应用跳回了飞牛主页」，用户看不到任何真实错误（日志实证：`:4500`、`:8768` 均是 `code=-102` → `fail-cand.try → :5666/`）。

修复：新增 `__fnIsAppEntryUrl30()`，判据是 **http(s) 且端口与 NAS 主站不同**（同机 Docker 应用正是异端口；NAS 登录页 / FN Connect 中继换域名但端口相同，仍走原兜底，不会打断登录流程）。命中即**不进 fail-cand**，直接调用既有错误页 `appwin.error-page`，保留原始 URL + 错误码 + 重试按钮；`:4500` 会明确显示「应用服务没有运行 / 服务只在 127.0.0.1 监听 / 端口已变 / 防火墙拦截」四条原因。

### 3. 日志增强（4 类）

- `popout.load` 补 `appId`（此前 114/114 条为空）、`appEntry`（发起前所在页面）、`opener`；appId 为空时从 `/appview?anchor=`、`fndesk_<id>` 反推。
- `fail-cand.final {from, to, shown: error-page|chromium-native|none, reason}` —— 补终态，此前只有 build/try/exhausted，看不出「最后用户看到的是什么」。
- `theme.sync` 补 `mode`（light/dark/system 可读）与 `thirdPartySees`（第三方页实际会拿到的 mq 值）。
- 第三方页 `theme.normalize{kind:skip}` 补 `clientDark / clientTheme / mqMatch`，并在 3s 后复查一条（`when:"after-3s"`）：`mqMatch:true` = 页面层已拿到客户端主题，观感仍不对则是应用自身主题开关；`mqMatch:false` = 客户端 `themeSource` 未生效。

### 4. 主题不跟随：定位结论

日志（`fnos-diag(13).log`）里 39 条第三方页 `kind:"skip"` 与 46 条 `kind:"apply"` 的拆分是干净的：apply 只落在 `:5666`、`file://…settings.html/about.html`、`chrome-error`，**第三方页没有被注入壳色**，`mqDark` 也随 `theme.sync`（`storeMode:10→light / 20→dark`）变化。也就是说客户端在「页面能拿到什么主题」这一层已经跟随；剩下不跟随的应用是**自身主题开关**（qBittorrent「使用深色主题」这类），需要在应用内设置或由部署侧统一关掉其内置主题。新增的 `mqMatch` 就是用来一眼区分这两类情况的。

### 5. 客户端与浏览器都打不开 → 容器侧

`CONNECTION_REFUSED(-102)` / `EMPTY_RESPONSE(-324)` 是传输层事实，客户端和浏览器看到的一致。`:4500`、`:8768` 需要容器在跑、端口已映射、服务监听 `0.0.0.0`；`:6881` 是 BitTorrent 的 peer 端口（qBittorrent 的 WebUI 在 `:8080`），入口指错了，改端口或删掉该图标即可。这部分交给部署侧（DeepSeek Harness）。

## v4.0.29

> 二轮验证：QQ 录屏里已经不闪了，但 **UU 远程下只要拖动窗口，被控端窗口仍会「一会消失一会出现」**。录屏逐帧量化：一次拖动固定闪两下——松手瞬间一下、+2.0 秒再一下，每下 0.30~0.33 秒，与日志 `frost.capture.protectedMs`（median 317ms）完全吻合。

### 根因

`setContentProtection(true)` = `WDA_EXCLUDEFROMCAPTURE`，只影响采集管线。磨砂背景靠自采样，每采一次就要把自己从采集管线里摘掉约 310ms，远程/录屏端看到的就是窗口整块消失。4.0.26 已把频率压下来，但还留着四条「还会抓」的路径：

1. **松手立即抓**（主因）：`setSuspend(win,false)` 里 `schedule(entry, 0)`，拖完只是平移，背后那张桌面图根本没变。
2. **+2 秒补抓**：`ACTIVE_MS=2000` 的「应对连续轻推」对纯平移同样生效，于是每次拖动固定多闪一下。
3. **arm 抖动**：远程输入 press/release 粒度粗，实测 30 组里 17 组存活 <300ms（最短 15ms），每次「松开」都走 `schedule(0)` 抓一张。
4. **show / restore 各抓一张**：窗口显示/还原时背后桌面通常没变，白闪 310ms。

### 改动（全部集中在 `titlebar-frost.js`，不动 `main.js`）

- **P0-1 纯平移不抓图**：已有底图、且宽高与显示器都没变时，只把窗口新坐标推给渲染层（复用 `titlebar-frost-pos` 平移取景框），不重新抓屏。抓图成功后记下 `lastShotBounds` / `lastShotDisp` 作为比对基准。
- **P0-2 松手不立即抓**：按住 <300ms 判为远端输入抖动，直接吞掉（`frost.suspend.flap`）；真拖动结束后只排一次 220ms debounce，且是否真抓交给 P0-1/P0-3 按几何判断。
- **P0-3 补抓条件化**：`ACTIVE_MS` 那次补抓只在「宽高真的变了」（resize/分屏/缩放/换显示器）时执行，纯平移跳过。
- **P0-4 show/restore 冷却**：15s 内已有底图就不再为「显示/还原」重抓。
- **P1 未聚焦一律不抓**：原来「有底图才延后」收紧为「一律延后」，只放行开窗首次（`enable`/`show`/`refresh`）；首次补图交给 `focus` 钩子，避免磨砂层一直空着。
- **埋点**：新增 `frost.reproject {dx,dy}`、`frost.suspend.flap {held}`、`frost.capture.skip {reason: unfocused|same-geom|cooldown}`、`frost.budget {captures, protectedMsSum, duty}`（每分钟一条，占空比是这件事唯一值得盯的数）。

### 影响面

- 拖动、松手、显示、还原：**零抓屏、零消失**；单纯移动不再刷新磨砂底图（背景最多陈旧 5 分钟，由 `IDLE_MS` 兜底）。
- 缩放窗口、分屏、拖到另一块显示器：仍会重抓一张（宽高或显示器变了，旧图的取景框确实不够用）。
- 切纯色模式：依旧零采样。

### 验收口径

连续拖动 5 次 + 静置 60s → 录屏消失段 **0**；日志侧 `frost.reproject` ≥ 5 条、`frost.capture` 0 次；缩放 3 次 → 消失段 ≤3 且每段 ≤0.35s；任意 10 分钟 `duty < 0.5%`（当前 3.6%）。

## v4.0.28

> 用户要求：主程序内打开的所有应用（内嵌窗、独立跳出窗），标题栏一律删除「刷新」和「新标签打开」两个按钮。

### 改动

这两颗按钮有两个来源，分别处理：

1. **我们自绘的标题栏**（`titlebar-inject.js`）——独立跳出窗/新标签窗用的那套 ☰ + ↻ + ↗ + — □ ✕：
   - 删除 `reloadBtn` / `newtabBtn` 的创建、点击事件与 `appendChild`，只剩 ☰ + — □ ✕；
   - 内嵌窗自绘栏（EMBED 分支）同样删掉 ↻，只剩 — □ ✕；
   - `__need` 自愈清单（MutationObserver 全件检查）同步移除 `fnos-tb-reload` / `fnos-tb-newtab`——**这一步必须做**，否则这两个 id 永远查不到，DOM 一变就被判定「标题栏缺件」而整件重建，表现为标题栏反复闪。
2. **飞牛自己画在窗标题栏上的两颗**（内嵌窗，`WINDOW-TYPES.md` 类型 2）——`iframe-btns-<签名>-refresh` / `-newwindow`：
   - 追加一条注入 CSS（`#fnos-hide-iframe-btns`）：按 `id` 前缀+后缀与 `title`（`刷新页面` / `新标签页打开`）精确定位，`display:none` + 宽度归零，布局自动收掉那 92px；
   - CSS 规则对「iframe 加载完 1~6 秒后才挂上」的按钮同样生效，不需要轮询找元素；
   - 只认这两个 id 后缀 / 两个 title，☰ 与 — □ ✕ 一概不碰；主窗口/子框架均注入，`head` 被 SPA 重建时自动补一次（3s 巡检，2 分钟后停）。

### 影响面

- 内嵌窗（桌面里出现的窗口）、独立跳出窗（新标签页开的窗口）、以及主程序自身标题栏，标题栏都只剩 ☰ 菜单 + — □ ✕。
- 刷新仍可用：应用窗里按 `F5`/`Ctrl+R` 走正常快捷键；新标签打开不再提供入口。

## v4.0.27

> 用户反馈两件事：① 用 MPV 播影片「加载不上」（页面一直停在加载中，没有任何报错）；② 「记住播放进度（续播·与网页端互通）」开关根本管不住影视入口——关掉它也照样一打开就进上次那部片子。

### 一、MPV 加载不上

**根因**
1. 起播流程是「先 `surf.play()` 播，再 `probeMediaRange()` 记日志」——探活结果只进 diag，不参与决策。服务端对 `/v/api/v1/media/range/<guid>` 回 400（空 body、6~15ms 即时拒绝，跨 3 个 mediaGuid、连续 4 天 100% 复现）时，mpv 只会给 `loading failed(reason 4)`，网页永远停在加载中。
2. `mpv-player.js` 把 `end-file error` 一律当可恢复：同 URL 重试 8 次（每次还要先向网页要"新鲜地址"），4xx 属于终态，重试是纯空转，用户干等近 80 秒。
3. 请求头构造有两处会把自己写坏：
   - `--user-agent=fnOS-Desktop/MPV` 被无条件塞进命令行，而 headers 里本来就有 `getNasUA()` 的浏览器 UA → 请求里两条 `User-Agent`，部分反代/源站直接 400/403；
   - `options/http-header-fields` 以**字符串**下发且做了 `,`→空格 替换（mpv 的 string-list 按逗号切分），UA/Cookie 里的合法逗号被永久篡改。

**修复**
1. `main.js` 新增 `probeMediaRangeStatus()`（Promise + 4s 超时 + 响应头），`mpv:embed` 在 `surf.play()` **之前**探活：服务端明确 4xx → 不启动 mpv，直接回 `{ok:false, httpStatus, reason}` 并记 `mpv.embed.reject`（含 Cookie 名、`urlHasQuery`、`content-type`）。网络错误/超时/5xx 一律放行，避免误杀可播流。
   - 探活被 4xx 拒绝时**再做一次带 `Authorization` 的重探**（`mpv.embed.auth-retry`）：v2.15.88 起点播流刻意只带 Cookie（过期 JWT 会让 media/range 回 JSON 报错），但有些服务端恰好要求 JWT，于是变成 400「加载不上」。只有带 token 真拿到 2xx 才改用它，过期 token 继续 4xx → 行为与旧版一致。
2. 起播后挂一次性 `fatal` 监听，把状态码以 `mpv:play-failed` 推回网页。
3. `preload.js`：`mpv:embed` 返回值 `ok:false` 或收到 `mpv:play-failed` 时，撤销接管、还原网页播放器，并弹一条 shadow DOM 提示写明 HTTP 状态（4s 内只弹一次）。
4. `mpv-player.js`：从 mpv 日志抓 `HTTP error NNN` / `HTTP/x.x NNN` 存入 `_lastHttpStatus`；`end-file` 时若 25s 内见过 4xx → 判终态（`_fatalStop`），清起播看护、发 `fatal`、不重试，`_reloadStream()` 也拒绝再拉流；`loadfile()` 重置终态标记，不影响下次切集。
5. 头构造：headers 里已有 UA 就不再加 `--user-agent`；`options/http-header-fields` 改为**数组**形式 `set_property`（元素内逗号不再被切分），并去掉重复的 `set_property user-agent`。

### 二、影视入口记不住"上次看到哪" / 关了续播还是进片子

**根因**
1. 影视前端自己会按服务端「继续观看」直接跳 `/v/video/<guid>`；
2. 入口学习缓存把「上次停留在 `/v/video/<guid>`」记成该应用的入口，于是每次启动都命中深链——本地续播开关与它无关，所以开关看起来"不起作用"。

**修复**
1. `main.js` 新增 `lastPlayForTrimMedia()`：复用本地进度库（`userData/play-progress.json` 的 `g:<guid>` 记录），取 30 天内、>30s、未到 95% 的最近一条；**开关关闭时直接返回 null**。
2. 影视入口（仅裸入口 `/v`，用户主动点某部片子的深链不动）在入口缓存**之前**单独决策：开关开 → 开 `/v/video/<guid>`；开关关 → 一律 `/v`，并且绕过入口缓存（`appwin.entry-cache.bypass`），同时清掉历史上被写成深链的 `/v` 缓存。
3. `preload.js` 新增 `startTrimGuard27()`：开关关闭时，若从 `/v` 进来自动跳到 `/v/video/*`，`replaceState` 回 `/v` 并触发 `popstate`；2s 内有用户交互一律放行、最多回弹 2 次、只监控 20s。
4. `mpv:settings-changed` 带上 `resume`，开关热生效（关掉后当前页立即武装守卫，无需重启）。

### 验证
- MPV：服务端 4xx 时应**秒级**失败并弹出「HTTP 400」提示，不再空转 80 秒；正常片源起播多一次 GET 探活（局域网约 10ms，直播/跨域直连源不探）。
- 续播开：关掉影视窗口再打开 → 直接回到上次那部片子，进度接着走。
- 续播关：关掉影视窗口再打开 → 影视主页；手动点某部片子仍能正常进入播放。

## v4.0.26

> 用户反馈：用 **UU 远程 / QQ 录屏**时客户端窗口「消失又出现」不停循环；**Windows 远程桌面**里界面轻微闪烁。

### 根因（磨砂背景的采样机制与采集管线互斥）
1. 磨砂背景要「截取窗口背后的桌面」，为此每次采样都在 `getSources` 前后各调一次 `win.setContentProtection(true/false)`。`true` 对应 Win32 `WDA_EXCLUDEFROMCAPTURE`——窗口会**从所有采集管线里消失**（录屏、远程、直播都看不见它），采样结束才恢复。
2. 采样被 `focus / move / resize / show / restore` 五个事件踢，且活跃期每 480ms 补抓一张。录屏端看到的就是：每 0.5~1s 消失一次、每次约 300ms 的「消失↔出现」循环。
3. 远程桌面下 Chromium 常回落软件渲染，`capturePage()` 更容易返回空帧/黑帧，被 `black-scan` 单帧判成黑屏 → `reload`，画面肉眼可见跳一下；每次采样在远程画面里也是一次闪烁。
4. `__ghostBurst` 松手后以 8ms 连刷 90 次 `setBackgroundColor` 赶灰带，每次重合成在采集端都是一帧变化，录屏里表现为边缘/底色轻微脉动。

### 修复
1. 采样频率降两个数量级：`ACTIVE_MS 480→2000`、`IDLE_MS 45000→300000`、`MIN_GAP 90→1000`（`titlebar-frost.js`）。
2. **聚焦不再触发采样**：`main.js` 删除 `win.on('focus', kick)`。聚焦不改变窗口背后的画面，却是最频繁的踢源。
3. **未聚焦窗口不采样**：`runOnce` 前置判断（首图例外），延到下次事件或 5min 兜底。
4. `__ghostBurst`：90×8ms 连续重合成 → 5 次递增间隔（8/30/80/150/300ms），带令牌作废旧轮次。
5. `black-scan`：空图（`capturePage` 空帧 / `isEmpty`）直接跳过并记 `black-scan.skip`；黑/白判定改为**连续 2 次一致**（间隔 ≥1.5s）才 reload，避免大面积浅色的正常页面被判白屏后反复重载。
6. 新增埋点 `frost.capture {trigger, ms, protectedMs, thumb, ok, focused}`——`protectedMs` 就是窗口在采集端「消失」的时长，可直接量化占空比；`black-scan.check` 增 `consecutive`。
7. `setEnabled` 状态未变化时不再补抓：设置页拖动不透明度/模糊滑块每 tick 都会走 `settings:preview-titlebar → __syncFrostAll → setEnabled(win,true)`，旧逻辑每次都 `lastAt=0` + 立即抓一张（拖动期间对每个窗口持续"摘出采集管线再放回"），现在是密集闪烁的另一个来源。仅当窗口还没有底图时才补一次。

### 验证
- QQ / UU 录屏：窗口全程可见，不再周期性消失（拖窗结束后最多一次 <300ms 的采样窗口）。
- 远程桌面：不再整窗跳变/重载；静止时零采样。
- 正常使用：磨砂底在移动/缩放结束后照常刷新，另有 5 分钟兜底。

## v4.0.25

> 用户反馈（截图 + diag 日志）：Docker 应用（Next Terminal / qBittorrent 等）在程序内**暗模式正常，切到亮模式后整片"黑底深字"**读不出来。

### 根因（三条都在注入层，本质都是「壳把常量色/主题硬塞给第三方页面」）
1. `titlebar-inject.js` 主窗 / 设置窗 / 全屏态样式里写死 `background:#05060a !important` 铺在 `html>body` 上——常量，不随亮暗切换。Docker 应用经 `fnos-domain-in-main` 直接加载进主窗时，那个 `body` 就是应用自己的 body：暗模式深底浅字恰好能读，亮模式深底深字读不出。
2. `__themeNormalize` 对**所有**注入页面无条件开工：装 `matchMedia` 桥（把页面真实的 `prefers-color-scheme` 并掉）、写 `html{color-scheme}`、写/删 `body[theme-dark|theme-light]`、重写 iframe 主题参数 → 第三方页面连"自己是亮还是暗"都判断不了。
3. `__applyXappBodyBg` 扫 body 前 40 个元素"抢"第一个不透明大块的颜色补到 body，且带 `!important`：抢到装饰块/遮罩层就整页涂错色，页面之后也改不回来。

### 修复（`titlebar-inject.js`）
1. 新增「自家页面 / 第三方页面」判定 `__fnIsThirdParty25`：以主进程下发的 `nasOrigin`（`titlebar:should-inject`）为界，只有同源前缀匹配的飞牛自家页面归壳管；其余 http(s) 页面（`*.fnos.net` 下的 Docker 应用、`100.x` 直连应用）一律不碰。`file://` 自家页面（连接页/设置/关于）不受影响。
2. 壳色收窄：主窗 `html>body`、设置窗 `html>body` 与 `html.fnos-ui-transparent>body`、全屏态 `html[data-fnos-fs="1"]>body` 四处硬编码的 `#05060a` 统一走 `__shellBgCss25` / `__FN_SHELL_BG25`，第三方页面为空串（不写）。
3. 主题注入加门控：第三方页面整段跳过 `__themeNormalize`（不装 matchMedia 桥、不写 colorScheme / `body[theme-*]`、不改 iframe 主题参数），只留一条跳过日志 + 页面原始底色探针。
4. `__applyXappBodyBg` 降级：只在 `document.readyState === 'complete'` 且 html 与 body **都透明**时补一次壳色，去掉"扫元素抢色"与 `!important`；页面自己有任何 `background-color` 就完全不碰。
5. qBittorrent 底栏兜底 `var(--color-background,#ffffff)` → `transparent`（深色主题下原本会凭空画出一条白底栏）。

### 新增埋点（`fnos:media-log` → diag 日志）
- `theme.apply`：写入后的 colorScheme / body 主题属性 / mqDark（原先只有 `mq-patched`，看不出"到底改了什么"）
- `theme.skip`：第三方页面被跳过 + html/body 计算底色、页面原 colorScheme、mqDark 真值
- `shell.bg.write`：本次分支（shell/settings/app/xapp）、写入值、是否第三方、html/body 实际底色
- `titlebar.xapp-bg`：补底色的值与来源（`from:'shell-const'`）

### 验证
- 暗模式：与旧版一致（Docker 应用仍是页面自己的暗色）。
- 亮模式：Docker 应用恢复页面自身浅色，不再出现 `#05060a`；标题栏/圆角/缩放/内嵌窗几何不变。

## v4.0.24

> 用户工单（含录屏）：程序内打开内嵌窗应用（Docker 等），点 ✕ 关不掉，点下去窗口会"躲避"一下。
> 同机 Chrome 打开同一 NAS 网页，一次点击即关闭 → 问题在客户端注入层，不在飞牛前端。

### 根因（两条独立的注入层问题，都指向标题栏那条带）
1. **整条标题栏图层吃掉了点击**：`#fnos-titlebar` 是 `pointer-events:auto` + `z-index:2147483647`、
   高 34~36px、fixed 覆盖窗口顶部。飞牛桌面内嵌窗的标题栏常常就压在这条带的边缘，
   点 ✕ 时 mousedown 落在我们的 bar 上，页面根本没收到。
2. **bar/hot 的 mousedown 是"按下即拖"**：`startNativeDrag` 里直接
   `ipcRenderer.send('window-drag')`，没有位移阈值。于是按下瞬间原生窗口开始跟手移动
   （视觉上就是"躲避"），mouseup 时鼠标已经不在原来的 ✕ 上 → `click` 不触发 → 关不掉。
   （`dragStrip` 早在 v2.17.46 就改成了 3px 阈值，bar/hot 一直漏改。）

### 修复（`titlebar-inject.js`）
1. 两处标题栏（主标题栏 `build()` / 内嵌窗标题栏 `buildEmbed()`）的 bar 由
   `pointer-events:auto` 改为 **`pointer-events:none`**；只有 `☰`(left)、`— □ ✕`(btns)、
   中段拖拽条(dragStrip) 各自 `pointer-events:auto`。其余区域点击直接穿透到页面，
   被 bar 盖住的飞牛 ✕ 也能一次点中。
2. bar / hot 的拖拽统一改为**阈值拖拽**：按下只记坐标，`mousemove` 累计超过 4px 才
   `send('window-drag')`；没动就是纯点击，绝不移动原生窗口。双击（<450ms 且 <8px）仍是最大化/还原。
3. 新增埋点：`tb.drag.start / tb.drag.end {trigger,dx,dy,moved,durMs}`、`tb.drag.dblclick`，
   走 `fnos:media-log` → diag 日志，下次复现能直接看到 `moved:false` 还是 `moved:true`。

### 验证
- `electron --check titlebar-inject.js` 通过。
- 仍保留：标题栏拖动（中段 dragStrip、顶部热区）、双击最大化、☰ 菜单、— □ ✕ 点击。
  由于 bar 不再吃事件，拖动窗口请用中段空白区（宽度自适应，足够用）。

## v4.0.23

> 用户反馈：推了 4.0.22 之后点「检查更新」只看得到 4.0.20。

### 根因（GitHub Releases 语义 + 并行构建）
- 客户端走 `https://api.github.com/repos/.../releases/latest`，而 GitHub 的「latest」是
  **按 Release 创建时间**挑的，不是按版本号。
- v4.0.20 / v4.0.21 两个标签是一次 push 推上去的，Actions 并行跑：v4.0.21 的 release
  16:45:58Z 创建，v4.0.20 的 16:46:23Z 创建（晚 25 秒）→ `latest` = **v4.0.20**。
- 用户点检查更新时 v4.0.22 的构建还没跑完（17:13:36Z 才发布），所以只看到 4.0.20。
- 另两条通道（`/releases/latest` 的 302、`releases.atom`）拿的也是同一个「latest」，
  同样会被这个顺序问题坑到。

### 修复
1. `main.js`：新增 `RELEASES_LIST`，`__viaApi()` 改为拉 `releases?per_page=20`，
   过滤 draft / prerelease 后**按版本号取最大**；列表通道异常才退回 `/releases/latest`。
2. `main.js`：竞速胜出者若不是 api 通道，再用列表通道复核一次，取更高版本，
   落 `update/check.prefer-higher`。
3. `.github/workflows/build.yml`：加 `concurrency: build-release`（`cancel-in-progress: false`），
   一次推多个 tag 时构建串行，杜绝「旧版本 release 后创建」。

### 验证
- `GET /releases/latest` 与 `releases.atom` 现在都指向 v4.0.22（推送后已自然正确）。
- 新版检查更新逻辑对「latest 指向旧版本」的场景免疫（取列表最大版本）。

## v4.0.22

> 用户工单（NAS 192.168.50.91 / 4.0.x）：桌面快捷方式双击启动应用，窗口里装的是**飞牛 NAS 桌面**
> （主页面），不是对应应用界面。相册 / 影视 / 音乐 三个快捷方式 10 次启动 10 次复现。

### 根因（日志实证：创建链算出 `…/appview?anchor=trim.xxx`，启动链却加载 `…:5666/`）
1. `__rootUrlFallback()` 只有 app-center 一级兜底：FPK 缓存给系统应用返回站点根 `http://nas/`，
   启动链走到这里就原样返回，缺创建链那条「`/appview?anchor=`」兜底。
2. 探针把「站点根 200」当「地址有效」：`launch.probe ok:true` → `__appviewFallbackUrl` 永不触发。
3. `__liveOriginFixUrl()` 用 `host`（含端口）比较：`nas` vs `nas:5666` 判为不同主机 → 端口不补。
4. 创建时算对的 URL 只写进日志，`.lnk` 只带 appId，启动时只能重新猜。

### 修复
1. 新增 `__isRootishUrl()`（根路径判定，不看端口）+ `__isNasDesktopUrl()`（**是不是 NAS 桌面**：
   根路径且与当前 NAS 同 host、端口为空或同端口）。后者才用于决定改写——`http://nas:34600/`
   这类同机异端口是应用自己的根地址（OpenList / XTE / biliLive-tools），绝不能被当桌面改掉。
2. 重写 `__rootUrlFallback(u, name, appId)`：三级兜底 app-center → manifest/behavior → `trim.*`
   的 `/appview?anchor=`，每级落 `launch.rooturl.fallback {tier}`。
3. `__resolveLaunchUrl` 四个返回点全部传入 appId；FPK 分支补 `launch.resolve.step {step,isRootish}`。
4. 探针后加**根地址保险丝**：最终 URL 仍是站点根就强制改 `appview?anchor=`，落 `launch.rooturl.guard`。
5. `__liveOriginFixUrl`：同主机名、仅端口缺失且是站点根 → 归位到当前 origin（不动 `:3000` 这类应用端口）。
6. 快捷方式创建成功后把 `launchUrl` 写 `userData/shortcut-urls.json`；`__resolveLaunchUrl` 第 0 步
   优先用它（主机一致 + 非站点根才用，换 NAS 自动失效），落 `launch.url.from-shortcut`。
7. `appwin.load.done` 增加自检：窗内 URL 是站点根就记 `appwin.url.mismatch`（error）。

### 验证
- `electron --check main.js` 通过；`__isRootishUrl` 1 处定义 / 11 处调用。
- 端到端：loopback `/launch?app=trim.music` → 日志出现 `launch.resolve.step` 与最终 `launch.entry-final`，
  URL 为 `…/appview?anchor=trim.music`（非站点根）。

## v4.0.21

> 用户纠正 v4.0.20：飞牛应用窗口分三类 —— ① 内嵌窗（标题栏无 ↻/↗）② 内嵌窗（标题栏有 ↻/↗）
> ③ 独立跳出窗（标题栏无 ↻/↗）。v4.0.20 把「内嵌窗不加按钮」一刀切套到了 ③ 上，
> 导致独立跳出窗没有刷新 / 新标签打开。

### 逆向结论（`/assets/index-D1auxRov.js` 全文核过）
- 内嵌窗标题栏 `trim-ui__app-layout--header` children 固定为
  `[标题, 自定义槽, minimize, maximize, close]`，`刷新`/`新标签`/`newTab`/`openInNew` 全 0 命中
  → **内嵌窗标题栏本身永不画 ↻/↗**，类型 ② 的那两钮来自窗内加载的飞牛自有页面。
- 独立跳出窗由 `createAppWindow` 打开应用真实入口（`/app/<id>/`、`:3000`、`/cgi/ThirdParty/...`），
  页面不带飞牛应用头 → 只有自绘标题栏能给 ↻/↗。

### 修复
1. `titlebar-inject.js`：恢复 v4.0.18 的「↻ 刷新」「↗ 新标签打开」（仅非主窗），
   `__need` 自愈清单同步带上 `fnos-tb-reload` / `fnos-tb-newtab`；注释改写为三类型判定说明。
2. 类型 ①/②（内嵌窗）继续保持 v4.0.20 的零注入，不转独立窗。
3. 新增 `WINDOW-TYPES.md`：三类定义、判定依据、本机 25 个已分类应用的清单
   （类型 1 = 13 个第三方 FPK 页；类型 2 = 5 个飞牛自有页；类型 3 = 7 个跳出窗）。

### 验证
- `electron --check`：`main.js` / `preload.js` / `titlebar-inject.js` 全部通过；`read_lints` 无告警。
- 版本号同步 `package.json` / `main.js` = 4.0.21。

## v4.0.20

> 用户纠正 v4.0.19：内嵌窗标题栏不要加任何按钮。飞牛的「↻ 刷新 / ↗ 新标签」是**由应用自身
> 决定有没有、而且成对出现**的；没有这两个按钮的内嵌窗本身就是正常形态，我们额外补一个 ↗
> 属于「多画一个按钮」。

### 修复
1. `preload.js`：删除 `__fnosEmbedPopoutBtn()`（往飞牛标题栏注入 ↗）与
   `__fnosEmbedPopoutWatch()`（MutationObserver 扫描 `.trim-ui__app-layout--window` 补按钮）。
2. `preload.js`：`__fnosLaunchByClick()` 的 iframe 轮询分支改为「检测到新增内嵌窗即 return」，
   只记一条 `launch/embed-kept` 日志，不再读取 `.app-layout-header-close` 上溯窗口盒子、不再注入。
3. `titlebar-inject.js`：撤销 v4.0.18 给自绘标题栏加的「↻ 刷新」「↗ 新标签打开」。
   独立跳出窗的标题栏恢复为 `☰ + — □ ✕`，与主窗口一致；`__need` 自愈清单同步还原，
   不再为非主窗单独要求 `fnos-tb-reload` / `fnos-tb-newtab`。
4. v4.0.19 的另一项修复保留：内嵌窗**不再**被自动转成独立窗口。
   现在内嵌窗完全交回飞牛自己渲染 —— 一个按钮都不加、窗口形态也不改。

### 验证
- 全文检索 `__fnosEmbedPopoutBtn` / `__fnosEmbedPopoutWatch` / `.fnos-embed-popout`：
  仅剩注释与历史 changelog，无任何可执行残留（不会 ReferenceError）。
- `read_lints` 无告警；版本号已同步 `package.json` / `main.js`。

## v4.0.19（第 2、3 条已于 v4.0.20 撤销）

> 用户工单：内嵌窗被强制转成独立窗口，飞牛自带的 44px 标题栏（— □ ✕）连同「新标签打开」的入口
> 一起消失。要求：内嵌窗一律用飞牛自带标题栏，同时保留「新标签打开 → 变成独立窗口
> （可以拖到主程序窗口外面最大化）」。

### 逆向结论（在 192.168.31.101:5666 实测）
- 飞牛「内嵌窗」= 桌面 SPA 里的绝对定位窗口 `.trim-ui__app-layout--window`
  （默认 1100×640，最大化后 1418×835），标题栏 `.trim-ui__app-layout--header` 固定 44px，
  按钮只有 `app-layout-header-minimize / maximize / close`；应用内容在 iframe 里
  （第三方应用直连 `:3000` 等端口）。
- 前端 bundle `/assets/index-D1auxRov.js` 里标题栏 children 固定为
  `[标题, minimize?, maximize?, close]`，**不渲染任何「刷新 / 新标签」按钮**，最大化前后都一样。
- 由此确认：「↻ ↗」只能由客户端提供，而且必须挂在内嵌窗自己的标题栏上，用户才够得到。

### 修复
1. `preload.js`：删除「内嵌窗自动转独立窗口」逻辑（原来 `window.open(..., 'fnos-embed-style,...')`
   之后直接 `removeChild` 内嵌窗容器），改为保留飞牛内嵌窗原样显示。
2. 新增 `__fnosEmbedPopoutBtn()`：在飞牛标题栏按钮组最左侧注入一个 ↗
   （class 复用飞牛的 `w-base` + `px-[15px]` + hover 样式，46×44 与 — □ ✕ 同尺寸，
   `title="在新标签打开（变成独立窗口）"`），点击才走原来的
   `window.open(..., 'fnos-embed-style,fnos-anchor=...')` → 独立窗口，可拖出主程序。
3. 新增全局观察器 `__fnosEmbedPopoutWatch()`：主窗内任何时刻出现
   `.trim-ui__app-layout--window` 都补 ↗（不依赖「快捷方式启动」链路那 3.2s 轮询）。

### 验证
- 真实 `preload.js` 以主窗身份（`--fnos-shell`）加载飞牛并点开 biliLive-tools：
  标题栏按钮 = `↗(popout) + minimize + maximize + close`，popout 46×44 位于按钮组最左，
  内嵌窗顶边 y=36 正好在主窗标题栏（36px）之下，无重叠、无遮挡；
- 语法检查全部通过。

## v4.0.18

> 用户工单：内嵌窗应用的标题栏被改成了自绘栏，fnOS 默认标题栏上的「新标签打开」没了 ——
> 那是高频功能，必须保留。

### 修复
1. `titlebar-inject.js`：应用窗/跳转窗的自绘标题栏补回「↻ 刷新」「↗ 新标签打开」
   （SPA 自愈重建检查一并纳入；主窗不加——刷新会把 fnOS 桌面整页重载）。
   点「↗」走 `window.open(当前URL, '_blank')` → 主进程 `setWindowOpenHandler` →
   `createAppWindow`，等价「在新标签打开当前页面」，不新增 IPC。
2. `main.js`：`createAppWindow` 新增 `__embedAuto` —— `/appview` 容器页自动使用
   `--fnos-embed-style`（embed 形态不注入），把 fnOS 前端自绘的默认标题栏
   （logo + 标题 + ↻ ↗ — □ ✕）让出来，避免双标题栏。
   `/app/<id>/` 应用页暂不放开：本地无法验证这类页面是否自带默认标题栏（需要 fnOS token），
   误判会让窗口变成无边框且没有任何按钮；这类窗口继续用自绘栏 + 新增的两个按钮。

### 验证
- 真实 preload 复现截图：biliLive-tools 应用窗标题栏为 ☰ + ↻ + ↗ + — □ ✕，侧边栏 12 项完整；
- 语法检查全部通过。
- `/app/Cloudflare-QT/` 直接抓取返回 `invalid token`，无法离线判定默认标题栏是否存在，故按保守策略处理。

## v4.0.17

> 用户工单：新标签打开应用，侧边栏少了 4 项（直播录制/看板/视频处理/工具）、内容区显示不全；
> 直播观看页面信息也不全。

### 根因
- v4.0.14 为了让 Naive UI `n-layout--absolute-positioned` 让出标题栏高度，加了一条子串选择器
  `[class*="absolute-positioned"]{top:34px !important}`。
- 该子串同时命中 `n-layout-footer--absolute-positioned` / `n-layout-sider--absolute-positioned` /
  `n-layout-header--absolute-positioned` 等子组件：底部菜单（登出/日志/关于/设置）的 `bottom:0`
  被强塞进来的 `top:34px` 顶掉，footer 从侧栏**底部跳到顶部**，正好盖住主菜单的
  直播录制/看板/视频处理/工具 四项 —— 看起来就是"菜单少了 4 项、页面加载不全"。
- 实测（真实 preload + `--fnos-app-window --fnos-xapp` 复现）：修复前 footer 菜单
  y=74~218（顶部），修复后 y=563~749（底部），与浏览器内布局一致。

### 修复
1. `titlebar-inject.js`：选择器收窄为 `[class~="n-layout--absolute-positioned"]`（精确 token 匹配），
   只动布局根节点本身，不再波及 footer / sider / header。
2. `main.js`：诊断 `window.create` 的 flags 恒 false —— `browser-window-created` 触发瞬间
   `getLastWebPreferences()` 还没带上 `additionalArguments`。改为 `setImmediate` 后读取，
   仍为空则在 `did-finish-load` 补记 `window.create.late`，并附 `addl` 原始参数便于对账。

### 验证
- 真实 preload 复现：压制页、直播观看页侧边栏均恢复完整 12 项，footer 回到底部，标题栏不压内容；
- `main.js` / `titlebar-inject.js` 语法检查通过。

## v4.0.16

> 用户工单：内嵌窗打开的界面正常，新标签打开的窗口整窗透明——桌面和后面的文档透了出来。

### 根因
- 独立弹窗（新标签窗）是 `transparent: true` 的 BrowserWindow，而 xapp 分支 CSS 只给
  `html` 设了 `background: transparent`（让标题栏透出桌面），**body 没设背景色** → 整窗透明。
- 内嵌窗（webview）有主窗口的不透明底垫着，所以完全看不出问题。

### 修复（titlebar-inject.js）
1. 新增 `__applyXappBodyBg()`：给 body 补不透明底色。优先取页面自身背景色（body → 根容器），
   取不到按深浅色主题兜底；注入时 + 500ms + 1800ms 三次探测（SPA 首帧后才挂根容器背景）。
   `html` 仍保持透明，标题栏区域（y=0~barH）的透桌面/磨砂不受影响。
2. 磨砂抓屏失败时的兜底底色从 35% 提到 80%——`frost.capture-fail` 是异常态，
   浅色桌面下 35% 的 frostColor 叠上去几乎发白，标题栏看起来"没生效"。
3. 新增诊断 `titlebar.xapp-bg`（实际填充的底色）。

### 验证
- `titlebar-inject.js` 语法检查通过；
- 待实机回归：新标签窗不再透出桌面、内容区底色与页面一致、标题栏可辨识。

## v4.0.15

> 用户工单：标题栏不压内容区了（v4.0.14 修好了），但内容区页面加载不全（被截断）。
> band 诊断实锤两个问题。

### 根因（band 字段硬数据）
1. **小组件被误移**：`n-base-selection__border` / `n-button__border` 等组件内部装饰元素
   也是 `position:absolute;top:0`，被 `__shiftFixedTop` 误移 → 布局错乱。
2. **大容器下移后高度溢出**：`n-layout`（`position:absolute;top:0`）下移到 y=34 后，
   高度未约束 → 溢出视口 34px → 底部内容被截断。

### 修复（titlebar-inject.js）
1. `position:absolute` 只移大容器（`rect.height > 80px`），避免误移组件内部小组件。
2. 下移后同步约束 `max-height: calc(100vh - shift)`，防止高度溢出视口导致内容截断。

## v4.0.14

> 用户工单：标题栏仍压住内容区。band 诊断实锤根因。

### 根因（band 字段硬数据）
```
band: [{"cls":"n-layout n-layout--absolute-positioned layout","pos":"absolute","top":"0px","rectTop":0}]
```
Naive UI 的 `n-layout--absolute-positioned` 用 `position:absolute;top:0`（相对视口定位），
`__shiftFixedTop` 只处理 `position:fixed/sticky`，**漏了 `position:absolute`** → 整个布局容器停在 y=0，被标题栏压住。

### 修复（titlebar-inject.js）
1. `__shiftFixedTop` 增加 `position:absolute;top≈0` 且 `rectTop≈0` 的元素接管
   （只接管相对视口定位的 absolute，有定位祖先的不动）。
2. CSS 兜底补充 `.absolute.top-0` 和 `[class*="absolute-positioned"]`（Naive UI 常见）。

## v4.0.13

> 用户工单 1：标题栏仍压住内容区（v4.0.12 已让位但仍不够）。
> 用户工单 2：安装程序弹「FNOS 无法关闭，请手动关闭它」死循环。
> 用户工单 3：tb.hit 实锤 barH=37 但 bodyTransform=35.3 → 内容顶部 1.7px 被压。

### 修复 1：标题栏高度与 body 偏移不一致（tb.hit 硬数据）
- 根因：`--fnos-bar-h` 设为 `__skinHeight`（34），但 bar 实际 inline 高度是 `__skinHeight + 2`（36，主窗盖接缝），
  body transform 用 `calc(var(--fnos-bar-h) / var(--fnos-f))` 计算 → 值偏小 → 让位不足。
- 修复：`__applyTitlebarHeight` 将 `--fnos-bar-h` 设为实际 inline 高度（含 +2px），
  与 `__barHeight()` 统一，消除 1.7px 偏差。

### 修复 2：安装程序「FNOS 无法关闭」死循环
- 根因：点 × = 隐藏到托盘（产品设计），进程不退出；安装程序发 WM_CLOSE 后等进程退出必然超时。
  弹窗文案引导用户点 × → 又是隐藏 → 死循环。
- **P0-1 协作退出**：`FNOS.exe --quit` → 已有实例收到 `second-instance` 后立即退出
  （先 `destroy` 主窗再 `quit`，防渲染进程卡住；800ms 硬兜底 `app.exit(0)`）。
- **P0-2 退出信标**：安装程序写 `%APPDATA%\fnos-client\quit.request` 后轮询进程，
  本进程 `fs.watch` 监听到即协作退出（给 UAC 提权切断父子关系的场景兜底）。
- **P1 日志增强**：`quit.request` / `quit.begin` / `quit.exit` / `quit.beacon_ready`。

### 修复 3：标题栏让位诊断增强
- `titlebar.fixed-top` 增加 `band` 字段：输出标题栏带内未被接管的元素（tag/id/cls/pos/top/rectTop），
  精确定位「内容被压」的根因元素。

### 验证
- `titlebar-inject.js` / `main.js` 语法检查通过；
- 待实机回归：安装程序不再弹「FNOS 无法关闭」、tb.hit 中 barBottom === bodyTransform Y 值、
  titlebar.fixed-top 的 band 字段定位到压内容的元素。

## v4.0.12

> 用户工单：v4.0.11 标题栏形式已正确（跟随偏好设置），但标题栏仍然压住内容区。
> 日志实锤：`titlebar.fixed-top count:0`，`__shiftFixedTop` 找不到贴顶元素；
> `html{padding-top}` 可能被页面自身 CSS 的 `!important` 规则覆盖。

### 修复（titlebar-inject.js）
1. **inline style 兜底 html padding-top**：页面 CSS 的 `!important` 可能覆盖 `<style>` 里的
   `html{padding-top}`。用 `html.style.setProperty('padding-top', ..., 'important')` 兜底
   （inline !important > stylesheet !important），保证让位一定生效。
2. **穿透 shadow DOM**：`__shiftFixedTop` 原来用 `querySelectorAll('*')` 不进 shadow root，
   组件库（Vuetify/Naive UI）封装的贴顶元素漏检。现在递归收集 shadow DOM（最多 3 层）。
3. **放宽 fixed 元素检测**：原来要求 computed `top≈0` 且 `rect.top` 在标题栏带内，
   对 `top` 值非标准写法（`inset:0`、CSS 变量等）漏检。现在以 `rect.top` 为主要判据，
   `top` 值仅做辅助过滤（范围放宽到 `[-barPx, barPx]`）。
4. **body transform 兜底**：注入后 200ms 检查 `html` 实际 `padding-top`，若被压成 0
   则改用 `body{transform:translateY(34px)}` 让位（v3.0.46 的原始方案），
   并上报 `titlebar.transform-fallback` 诊断日志。
5. **诊断增强**：上报 `titlebar.padding-check`（htmlPadTop / bodyMarginTop / barH），
   复现一次即可确认让位是否生效。

### 验证
- `titlebar-inject.js` 语法检查通过；
- 待实机回归：biliLive-tools 顶栏/录制任务标签栏不被压、
  `titlebar.padding-check` 显示 `htmlPadTop: 34px`（或 `transform-fallback` 触发）。

## v4.0.11

> 用户工单：v4.0.10 的 fixed 顶栏让位修复无效，"标题栏压住内容区"问题照旧；
> 非主窗标题栏"形式和偏好设置里不一样"；半圆角对 xapp 窗口不生效。
> 本版从日志实锤出发，修 5 个根因。

### 根因 A/B（压住内容区）：__shiftFixedTop 节流丢任务 + sticky 未覆盖
- **节流 bug**：v4.0.10 的 `__run` 在 700ms 内直接 `return` **不补跑**，SPA 首帧/路由动态插入的
  `position:fixed;top:0` 顶栏被永久跳过（日志实锤：wcId=7 `count:0`，wcId=6 只命中 1 个无关元素）。
  改为延迟补跑，保证每次 bump 最终都会执行。
- **sticky 漏检**：`position:sticky;top:0` 的顶栏/标签栏（Tailwind / Naive UI 常见）同样被标题栏
  压住，原来只认 `position:fixed`。现在 fixed + sticky 都接管。
- **MutationObserver 盲区**：原来只监听 `childList`，SPA 组件重渲染只改 class/style 不增删节点时
  完全收不到通知。补 `attributes` + `attributeFilter: ['style','class']`。
- **CSS 兜底**：`.fixed.top-0` / `.sticky.top-0` / `[class*="fixed"][class*="top-0"]` 等常见组件库
  类名先用 CSS 让位，JS 接管前不压内容。

### 根因 C/D（"标题栏形式不一样"）：非主窗标题栏恒透明 → 透出页面顶栏
- **初始背景**：非主窗 `__barBg` 原来恒 `transparent`，现在按偏好设值——
  磨砂 → frostColor 35% 底；纯色 → solidColor 90%+ 底。
- **磨砂抓屏失败降级**：`frost.capture-fail`（日志实锤）时 `__frostGeom` 为 null，
  磨砂层空白、标题栏只剩 10% 淡染色 → 几乎透明 → 透出页面自身顶栏，看起来是"另一套标题栏"。
  抓屏未就绪时用 35% 不透明底色兜底；抓屏成功后 `titlebar-frost-bg` 处理器自动降回正常 frostAlpha。

### 根因 E（半圆角不生效）：winCorner 选择器不覆盖 html
- xapp 分支把 `clip-path` 写在 `html` 上，`__applyWinCornerStyle` 的 "half" 只覆盖 `html:root>body`
  → html 的 20px 全圆角压过来，xapp 窗永远全圆角。现在 half/round 都同时命中 `html:root`。

### 验证
- `titlebar-inject.js` / `main.js` 语法检查通过；
- 待实机回归：biliLive-tools 顶栏/录制任务标签栏不被压、磨砂/纯色切换即时生效、
  半圆角对 xapp 窗口生效、jump/new-tab 窗标题栏与主窗一致。

## v4.0.10

> 用户工单「标题栏压住内容区第一行」的根因修复（第三方应用窗，如 biliLive-tools 顶栏 / 录制任务标签栏）。

### 根因
v3.0.46 为修好「第三方应用底栏压住面板字段」，把 `--fnos-xapp` 窗的让位方式从
`body transform` 换成了 `html{padding-top:34px}`（fixed 继续相对 viewport，几何与浏览器一致）。
但 **`position:fixed` 元素不参与 html 的 padding 布局**：顶栏、标签栏这类 `fixed;top:0`
仍然停在视口 y=0，正好被 34px 的标题栏盖住第一行；底栏（`bottom:0`）不受影响，
正是「上面压、下面好」的现象。

### 修复（titlebar-inject.js）
- 新增 `__shiftFixedTop()`：只接管「`position:fixed` 且自身 `top≈0`、实际画在视口顶边」的元素，
  把 `top` 相对原值下移一个标题栏高度（`--fnos-bar-h / --fnos-f`，跟随标题栏高度与页面缩放）。
- 幂等 / 可还原：原 `top` 只在首次接管时记在元素上（`__fnosTopShift`），窗口缩放、
  改标题栏高度、页面缩放、全屏切换都按原值重算，不会叠加偏移；全屏（`data-fnos-fs=1`）时还原。
- 不误伤：标题栏自身与全部注入节点（`id^="fnos-"`、`[data-fnos-tb]`）、顶部拖动热区、
  已接管元素的 fixed 后代（避免双倍位移）、`top` 为 `auto/百分比/calc`、负值离屏元素一律跳过。
- 重算链路：`resize` + body 子节点 MutationObserver + html `style`/`data-fnos-fs` 变化，
  350ms 防抖 + 700ms 最小间隔（大页面不全文档高频扫描）。
- 日志增强：接管结果变化时上报 `mpv.preload` / `titlebar.fixed-top`
  （`shift` / `barH` / `count` / `sample`），复现一次即可确认是否命中。

### 说明
- 标题栏材质（磨砂/纯色）与窗口四角（圆角/直角/半圆角）此前已由偏好设置驱动
  （v3.0.70/3.0.71 实时预览、v4.0.7 对应用窗/跳转窗/新标签窗生效），本版未改动其行为。

### 验证
- `titlebar-inject.js` 语法检查通过（`electron --check`）；
- 待实机回归：biliLive-tools 顶栏 / 录制任务标签栏不再与标题栏重叠；
  窗口缩放、全屏进出、改标题栏高度后偏移量与标题栏高度一致。

## v4.0.9

> 两个实锤问题（日志 `titlebar.skipped` / `titlebar.injected` 对照）：内嵌窗出现两条标题栏；
> 应用内跳转窗、内嵌窗↗新建标签窗没有客户端标题栏，只剩页面自绘的老式假窗控。

### 1）内嵌窗两条标题栏
`titlebar-inject` 在内嵌窗（`--fnos-embed-style`）里又注入了一条标题栏，而内嵌窗页面本身
已经画了一套 fnOS 内嵌窗标题栏（logo + 标题 + ↻ ↗ — □ ✕），于是两条叠着。
按用户口径「内嵌窗标题栏采用默认的」：preload 注入守卫遇到 `--fnos-embed-style` 直接跳过注入，
内嵌窗只保留页面自带那一条。

### 2）应用内跳转窗 / 新标签窗没有客户端标题栏（只有老式假窗控）
`frameLessOverride()`（网页 `window.open` 弹出的所有窗口）此前**不传任何 `--fnos-*` 旗标**，
preload 守卫判定「http(s) 且无旗标」→ 跳过注入。结果这些窗口：
- 没有客户端标题栏，只剩页面自己画的假窗控（偏好设置里当然没有这种样式）；
- 没有内容让位，视觉上就是「一条不认识的标题栏压在内容区上」。

修复：按目标地址补旗标 —— 统一 `--fnos-app-window`；跨站（第三方应用）再加 `--fnos-xapp`。
于是它们与应用窗完全同一条链路：偏好设置驱动的标题栏（磨砂/纯色/透明度/四角）+ 内容让位
（应用窗 body 让位 34px，第三方 `html` padding-top 34px），标题栏在内容区上方、不压内容。

## v4.0.8

> 标题栏排障日志增强（不改外观行为）：为「应用窗 / 跳转窗 / 新标签窗标题栏与主程序不一致」补观测，
> 复现一次即可从日志定位根因，不再靠录屏逐帧猜。

### 主进程（main.js）
- `app.on('browser-window-created')` 记录每个窗口的 `window.create`：
  `winId` + `bounds{x,y,w,h}` + `flags{shell/app/embed/xapp/live}` + `menuPopup`；
  首个 `did-finish-load` 再补一条 `window.url`（该窗口实际加载的地址）。
  —— 用来判断「跳出来的窗口/新标签窗口」到底带了哪些参数、窗口几何给了多少。

### 渲染层（titlebar-inject.js）
- 每个窗口注入完成后上报一次 `mpv.preload.titlebar.injected`（去重，一窗一次）：
  `style`（standard/embed）、`mode`（main/app/xapp/settings/embed）、
  `barH`、`barRect{x,y,w,h}`、`win{w,h}`、以及 `settings{material/opacity/autoHide/
  barCorner/winCorner/frostColor/frostAlpha/solidColor/solidAlpha/divider}`。
  —— 用来判断「偏好设置里标题栏相关设置」在这个窗口到底生效成什么、标题栏实际画在哪条带。

## v4.0.7

> 撤回 v4.0.6 三处误改，并按用户口径重做：内嵌窗标题栏保持默认，磨砂（透壁纸）不动，
> 应用窗/跳转窗的标题栏高度与内容让位一致（不压内容），标题栏四角设置对所有窗口生效。

### 撤回（v4.0.6 改错了）
1. **不再强制实色深色渐变**：非主窗恢复 `background: transparent`。
   「透出壁纸」是磨砂材质的正常效果（主进程抓屏 + 渲染层 blur），不是 bug；
   真正的外观仍由偏好设置决定：纯色 → `solidColor` 实色，磨砂 → 透明 + 磨砂层。
2. **盖接缝 2px 只留给主窗**。v4.0.6 把它推广到所有窗口，等于让应用窗标题栏
   压住内容区第一行 —— 与「标题栏在内容区上方、不要压住内容」相反。
3. **恢复内嵌窗默认标题栏**：`EMBED` 重新按 `--fnos-embed-style` 判定，
   内嵌窗继续用「logo + 标题 + ↻ ↗ — □ ✕」；要统一的是它跳出来的窗口和新标签打开的窗口
   （这些窗口没有该参数，走 `build()`：☰ + — □ ✕，与主程序同款）。

### 新增
- `applyStyle()` 统一按 `TB.barCorner` 设置标题栏圆角：
  `round → 10px 四角 / half → 10px 10px 0 0 / square → 0`。
  此前该设置只在「皮肤」模式下生效，非皮肤窗口的圆角是创建时写死的 10px，
  所以在偏好设置里改「标题栏四角」时，应用窗、跳转窗、新标签窗完全没有反应。
  窗口四角继续由 `#fnos-win-corner`（`__applyWinCornerStyle`）负责，两者互不干扰。

## v4.0.6

> 用户工单：应用窗、应用内跳转窗的标题栏和主程序不一致，要求所有应用窗口统一采用主程序标题栏（标题栏占据内容区上方）。

### 现象（视频 Rec 0006 逐帧核对）
应用窗口顶部实际是「两层」：最上面是客户端标题栏（☰ + — □ ✕），但它是
`background: transparent`，那 34px 透出的是**桌面壁纸**（视频里那条半透明蓝带）；
紧贴其下才是应用自己的顶栏（logo + 名称 + 刷新/新窗口/—/□/✕）。
主程序窗口则是实色深色渐变条 —— 两者放在一起就是两套东西。

### 根因
- `titlebar-inject.js`：`__barBg = __isMainWin ? 深色渐变 : transparent`，应用窗/弹窗一律透明，
  于是「标题栏」看上去是壁纸色，和主程序不同源；
- 盖接缝的 2px 只在主窗生效，应用窗是 34px，高分 DPI 下条与内容之间会透出一道灰线；
- 带 `--fnos-embed-style` 的窗口还会切成「logo + 标题 + ↻ ↗ — □ ✕」另一套内嵌窗标题栏，
  与主程序的 ☰ + — □ ✕ 又不同。

### 修复
- 所有窗口的标题栏统一用主程序同一条深色渐变，不再透出壁纸；
- 盖接缝 2px 从「仅主窗」改为「所有窗口」，消除应用窗顶部灰线；
- 内嵌窗标题栏（logo/标题/↻↗）停用，任何窗口都走 `build()`：☰ + — □ ✕；
- 内容让位机制不变（应用窗 body translateY 34px、第三方应用 html padding-top 34px），
  即标题栏始终占据内容区上方独立一条，不覆盖页面内容。

## v4.0.5

> 修复「程序内打开应用不是应用主页面」「直播录制中切不同直播间仍是同一间」——同一个根因：入口学习缓存把别的地址写进了本应用的键。

### 判断依据（真机日志 2026-11-03）
- 打开 biliLive-tools：`appwin.create.entry {"url":"http://192.168.31.101:3000/"}` →
  `appwin.entry-cache.hit {"key":"path:192.168.31.101:3000|/","url":"http://192.168.31.101:5666/"}`，
  实际加载成了 NAS 桌面（不是应用主页），且每次打开都会 `entry-cache.confirm` 把 5666 再写回去（10 次自污染）。
- 切直播间：`appwin.create.entry` 带的是 `liveId=B`，命中缓存后 `dom-ready` 的 URL 变成上一次的 `liveId=A`。

### 根因
1. `path:` 键只含 `host|pathname`，SPA 的 hash 路由（`#/liveVideoPlayer?liveId=…`、`#/compress`）全被折叠进同一键；
2. `entry-cache.confirm` 用「请求 URL 的键」存「窗口最终落地的 URL」，一旦首跳被改写/中转，就把 A 的地址永久写进 B 的键。

### 修复
- 新增同一性闸门 `__entryCacheApplicable`：命中要求端口/路径/查询/哈希一致，深链请求（应用内具体页面）一律不许被覆盖；
- 落盘 `__entryCacheSave(key, url, reqUrl)` 增加同一性校验，深链与 `#/` 路由永不入库；
- 启动时清理已污染条目（值与键不同端口/不同路径，或值本身是深链），旧版本留下的脏数据自动消失；
- `windowTypeUrl`（下次开窗的兜底 realUrl）与换路记忆 `ok-url.json` 只记裸入口，不再记直播间深链。

### 日志增强
- `nav.navigate` / `nav.in-page` / `nav.fail`：所有 webContents（主窗/应用窗/webview guest/弹窗）的整页导航、SPA 路由跳转、主框架失败；
- `appwin.open.request`：谁（wcId/类型/来源 URL）发起的 `window.open`、目标 URL、是否深链；
- `appwin.entry-cache.skip` / `entry-cache.purge405` / `cache.save.skip`：缓存被拦下/清理的原因；
- `appwin.console-warn`：应用自身 warning 级日志（20s/窗 节流），补齐只有 error 时的前因。

## v4.0.4

> 修复「窗口最上排图标点不了，但按住能把窗口拖走」。

### 判断依据
- 抽帧确认：窗口内容已正常下移，桌面图标在标题栏下方可见；异常只发生在标题栏这一条。
- 日志：11:38 时段**没有一条** `drag.arm` / `drag.start` / `drag.move`，但窗口确实被拖走了 →
  说明走的不是自定义拖动链路，而是 Windows 的系统级拖动区（`-webkit-app-region: drag`）：
  mousedown 被交给系统移动循环，DOM 收不到事件、click 不触发，按住却能拖窗口。

### 修复
- 标题栏、左侧区、按钮容器，以及换肤 / 自动隐藏 / 全屏回退路径里的 `-webkit-app-region: drag`
  全部改为 `no-drag`；系统级拖动区只保留顶部 **6px** 热区。
- 标题栏中部继续走 `win-drag-*` 自定义通道（arm → start → poll），拖动行为不变。

### 日志增强（此后每次修复都会同步加强）
- `tb.hit`：窗口顶部 150px 内任意按下都记录命中链（`tag#id.class < 父级…`）、
  标题栏高度/底边、热区高度、拖动条高度、`body` 的 padding-top 与 transform、html padding、dpr
  —— 下次「点不动」能直接看出是谁在上面挡着。
- `ctl.minimize` / `ctl.maximize` / `ctl.close`：窗口按钮点击是否真的到达主进程。
- `drag.legacy`：旧 `window-drag` 通道被触发时记录（排查「谁在拖窗口」）。

## v4.0.3

> 修复 v4.0.2 引入的回归：**内容区点击变成拖动、应用图标点不动**。拖动重新严格限制在标题栏内。

### 根因
v4.0.2 为了修「第一次拖不动」，给 `__endDrag` 加了 120ms 宽限，但把 `mouseup` 也一起宽限了：
快速点一下标题栏后 `__fnosDsDown` 不会被清掉，紧接着在内容区按下（那次按下不会重置它）再移动，
就被当成「上一次拖动的继续」—— 窗口跟着走、应用图标点不中，看起来整个窗口都成了拖动区。

### 修复
- `__endDrag(reason)`：只有 `blur` / `pointercancel` 这类激活噪声给 120ms 宽限，
  `mouseup` / `pointerup` 一律立即生效。
- 标题栏 `mousedown` 打来源标记 `__fnosDsSrc = 'tb'`；`__fwd` 只在来源为标题栏时才允许发起拖动。
- 新增文档级 `mousedown` 捕获：在标题栏之外按下，立即清掉残留的按下状态
  （内容区的点击永远只是点击）。
- 主进程：`win-drag-move` 的自愈启动必须以 1.5s 内有效的标题栏 `arm` 为前提，
  没有 arm 记录一律忽略并记 `drag.move.noarm` —— 这是「严格限制在标题栏内」的主进程硬闸。

### 保留
- v4.0.2 的「第一次就能拖」仍然有效：按下宽限 + arm + 自愈三条路径都在，只是全部绑在标题栏上。

## v4.0.2

> 修复「第一次拖动窗口肯定失败，非得再按一次标题栏才能拖动」。

### 证据
- `fnos-2026-11-03.log` 里 30 次拖动全部成对出现 `drag.start` / `drag.end` 且有位移；
  失败的那几次**连一条 `drag.start` 都没有** → 整次拖动在到达主进程之前就被作废了。

### 修复
- 渲染层：`mousedown` 记录按下时刻；按下后 200ms 内忽略 `buttons === 0` 的移动帧。
  窗口从「未激活」被点激活时，头几帧 `buttons` 可能是 0，旧逻辑据此立刻 `endDrag`，
  整次拖动作废 —— 这正是「第一次拖不动、第二次才行」的来源。
- 渲染层：`__endDrag` 对「刚按下 120ms 内的 blur / pointerup 噪声帧」不响应（激活窗口时系统会补发）。
- 主进程：`win-drag-move` 支持自愈启动 —— 收到带 `buttons ≠ 0` 的移动但没有拖动状态时，
  按 arm 记录的按下点补建拖动（只认左键按着的帧，松手后的滑动到不了这条路径，无误触）。
- 主进程：忽略重复的 `win-drag-start`，避免二次重建基准导致窗口跳一下。
- 新增日志：`drag.arm` / `drag.arm-end` / `drag.start.heal` / `drag.start.dup`，
  下次仍在现场就能一眼看出断在哪一步。

### 验证
- 语法自检通过；拖动链路的关键分支（arm → start / heal → poll → end）逐条走查。
- 注意：这类问题依赖真实窗口激活时序，最终以实机日志为准；若仍复现，日志会直接标出断点。

## v4.0.1

> 修复 v3.0.82 引入的**菜单错乱**回归（面板被压成 150×260、菜单项文字溢出、桌面图标透过面板）。

### 根因
- 菜单窗口改为常驻复用后，预建窗口只有 `320×420`；页面在这个小窗里做首次布局，
  `.panel` 是绝对定位且没有显式宽度，`shrink-to-fit` 被包含块（`#root` = 窗口宽）夹住。
- 渲染层读 `panel.offsetWidth` 量到≈0，被 `Math.max(150, …)` 兜到下限 → 上报 150×260 →
  主进程 `setBounds` 把窗口真的改成 150×260 → 窗口变小又反过来夹住下一次测量，**自锁**。

### 修复
- 渲染层：`.panel` 改用 `width: max-content`（宽度只由内容决定，与窗口多大无关），测量改读
  `getBoundingClientRect()`，并把下限从 150 抬到 200（150 是「量到 0」的特征值）。
- 渲染层：`build()` 后先同步量一次保证速度，再在**双 `requestAnimationFrame` + `document.fonts.ready`**
  之后补量一次；只有尺寸变化才重复上报，不打扰主进程。
- 主进程：预建窗口尺寸 `320×420` → `640×420`；`fnmenu:ready` 对 `w≤200 || h≤120` 的上报判为可疑，
  先用最近一次可信尺寸显示并回推 `fnmenu:remeasure`（每次打开最多 3 次，防来回拉扯）。
- 菜单面板背景不透明度下限锁 **0.9**（原来跟随「透明界面」滑块可低到 0.38，桌面图标会透出来）。
- 新增自证日志：渲染层 `menu.custom.measure`（`panelScrollW` / `rootW` / `winW` / dpr），
  主进程 `menu.custom.size.suspect`（可疑尺寸命中记录），下次出问题可直接定位。

### 验收
- 菜单宽度 ≈ 630~650px，菜单项完整不截断
- 面板背景不透（alpha ≥ 0.9），不再出现桌面图标与文字叠加
- 连续开关 20 次尺寸稳定，`menu.custom.size.suspect` 计数为 0
- 打开速度保持「预建 + 复用」的毫秒级，不退化

## v4.0.0

> 发行工程化版本：对外是新一轮大版本，运行时行为与 v3.0.82 保持一致（差异仅版本号），
> 主要价值在版本体系归一、仓库整理与发布链路加固。

### 版本体系
- `package.json` → `4.0.0`，`main.js` 的 `APP_VERSION` 同步为 `4.0.0`
- `package-lock.json` 根版本号同步，避免 `npm ci` 版本漂移
- 安装包命名统一：`FNOS-4.0.0-setup.exe`
- 平台收敛：仓库仅保留 Windows 端源码与构建流程（macOS 源码 / 工作流已于上一提交移除）

### 仓库整理
- 移除 100+ 个本地临时脚本、调试文本与 `_menutest/` 试验目录（`_*.py` / `_*.txt` / `_tsettings.html` 等），
  这些文件属于本地打补丁过程的中间产物，从未参与运行
- 删除写死 Linux 沙箱路径的废弃构建脚本 `run-build.sh`
- 历史版本发布公告归档到 `docs/forum/`
- `.gitignore` 增补 CI 临时产物（`mpv.7z`、`mvpmpt/`）与本地工具目录条目

### 发布链路加固
- Windows 构建新增 **语法自检**：构建前对根目录全部 JS 执行 `node --check`，语法错误直接失败，
  不再产出半成品安装包
- Windows 构建新增 **安装包体积校验**：NSIS 产物缺失或小于阈值（缺 MPV 内核的典型症状）即终止发布
- 沿用并保留原有的 `mpv.exe` 打包校验、Release 资产上传 4 次重试与上传后回读自证
- Release 标题统一为 `FNOS <tag>`，自动生成变更说明
- 本地脚本 `build/build-installer.sh` 输出名对齐 `package.json` 的 `artifactName`

### 文档
- README 重写：4.0 功能全景、下载、云端构建流程、项目结构、技术栈
- 新增 CHANGELOG（本文件）
- `AGENTS.md` 版本号、Electron 版本与发布流程校正

## v3.0.82

- 最大化窗口拖拽还原：修复还原到「第 0 帧」导致的尺寸错乱（还原后二次校验实际 bounds）
- 拖动「按下即武装」：按下标题栏立即登记起点并挂起磨砂采样，2px 阈值内不再吞掉位移
- 标题栏菜单窗口常驻复用，连续开关不再重复创建窗口
- 磨砂采样改为事件驱动 + debounce（缩略图 480 → 352），降低常驻轮询带来的回读开销

## v3.0.81

- 菜单背景透明度跟随「透明界面」滑块
- 拖动起步阈值 4px → 2px，去掉「刚按下拖不动」的手感问题
- 拖动首帧不再空等一个 16ms 定时器

## v3.0.80

- 磨砂模式下按住标题栏拖动严重不跟手：拖动期间挂起抓屏采样，改用同一张图本地平移取景框
- 拖动期间由主进程按帧推送新窗口位置，不再重复抓屏

更早版本（v1.x / v2.x）变更见 [Releases](https://github.com/zhouchunwei513-cyber/fnos-desktop/releases)。
