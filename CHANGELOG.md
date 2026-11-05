# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订号`。
完整的安装包与发布说明见 [Releases](https://github.com/zhouchunwei513-cyber/fnos-desktop/releases)。

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
