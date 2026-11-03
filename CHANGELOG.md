# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订号`。
完整的安装包与发布说明见 [Releases](https://github.com/zhouchunwei513-cyber/fnos-desktop/releases)。

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
