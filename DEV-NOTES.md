# 飞牛 PC 客户端开发说明文档（r14 · v2.4.0）

> 对应需求《飞牛 PC 客户端 Electron+Vue3 需求文档》第三部分交付物 8。
> 本文档说明：交付物映射关系、模块调用顺序、IPC 事件定义、测试步骤、已知限制。

---

## 0. 架构与交付物映射

本项目为**扁平 JS 多窗口架构**（main.js 主进程 + preload.js/settings-preload.js/settings.html/js 渲染层），
无 src/ 目录与 TypeScript 构建链。按前置约定 1（兼容现有项目结构、禁止大规模重构），需求交付物按下表映射落地：

| 需求交付物 | 本项目落地位置 | 说明 |
|---|---|---|
| src/main/index.ts | `main.js`（单实例锁 705-731 / second-instance `__handleSecondInstance` / 托盘 `ensureTray`+`rebuildTrayMenu` / 窗口 `createMainWindow`+`hideMainToBackground`） | 主入口逻辑全部在 main.js |
| src/main/utils/logger.ts | `logger.js`（新建，CommonJS） | 主/渲染进程共用统一日志工具 |
| src/main/utils/iconLoader.ts | `main.js`：`fetchFpkIcon` / `pngToIco` / `applyHomeFpkIcons` / `refreshFpkApps` / iconTasks | 图标加载链路 |
| src/main/utils/shortcut.ts | `main.js`：`ipcMain.handle('create-desktop-shortcut')` + `__resolveLaunchUrl` + `__notifyOpenFpkApp` + `__fpkLookupSync` | 桌面快捷方式创建 |
| src/main/utils/autoLaunch.ts | `main.js`：`__setAutoLaunchRegistry()` | 注册表开机自启工具函数 |
| renderer/components/setting/AppList.vue | `settings.html` + `settings.js`（应用管理面板 app-card 列表） | 设置页每行"创建快捷方式"按钮 |
| renderer/router/index.ts | 映射说明见"已知限制"第 1 条 | 渲染进程路由跳转映射为独立应用窗口加载 |
| 开发说明文档 | 本文档 | — |

## 1. 模块调用顺序（强制开发顺序 1-9，代码内已按此组织）

1. **logger.js（统一日志）**：`log(level, module, msg, {params, ret, err}, runMode, proc)` /
   `earlyLog()`（锁判断早期阶段）/ `forRenderer(ipcSend, runMode)`（渲染进程，经既有
   `fnos:media-log` IPC 汇入，不新增 IPC）。main.js 的 `fnosLog()` 委托 logger.js。
   错误文案统一"未找到"，error 日志内不出现"不存在"三字（fntb 日志弹窗下拉标记同删）。
2. **图标链路（iconLoader 映射）**：主页注入脚本（版本化 URL：nonce 页面级 + ver 列表级，
   apply 幂等防 MutationObserver 死循环、防 NAS 前端覆盖回退）→ `refreshCustom` 5s 拉取列表
   版本递增强制绕开 HTTP 缓存 → iconTasks 每次实时重下载（禁磁盘缓存命中旧图）→
   应用窗口任务栏图标 FPK 实时链路（`refreshFpkApps → fetchFpkIcon → win.setIcon`，URL `?v=ms` 档）。
3. **主入口（index.ts 映射）**：单实例锁判断第一时间执行（705-731）→ `app.on('second-instance',
   __handleSecondInstance)` 紧随注册（app.ready 之前）→ 场景 A/B → 托盘固定 2 项 → 窗口恒 hide。
4. **IPC 三事件**（见第 2 节，严格按需求定义，无自定义事件）。
5. **shortcut**：快捷方式统一 `--launch-app={应用唯一 ID} --nas={nas地址}`；
   图标 FPK 优先实时拉取（pngToIco → fpk_*.ico），回退 iconPath/manifest；
   错误分类"权限不足 / 桌面路径不存在"；成功提示"桌面快捷方式已生成"。
6. **autoLaunch**：`__setAutoLaunchRegistry(enable)` 写注册表
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FNOS = exe 完整路径`（**命令不带应用 ID**），
   开关状态持久化 settings JSON `autoLaunch` 字段（等价 electron-store，见已知限制 3）。
7. **AppList（AppList.vue 映射）**：设置页每行"创建快捷方式"按钮 + 结果反馈弹窗；
   自启开关文字固定、提示语固定。
8. **异常处理**：IPC/握手超时弹"飞牛客户端进程异常，无法唤起应用，是否重启飞牛？"（确认后重启，
   PowerShell 弹窗，main.js 655-663）；appId 不存在弹"找不到该应用，请重新创建快捷方式。"；
   权限不足返回错误信息弹窗；托盘定时检测自动重建（`__trayGuard` 30s + resume + 5s）。
9. **边界自测**：见第 3 节。

## 2. IPC 事件定义（严格三事件，Main/Renderer 分离）

| 方向 | 事件名 | 参数 | 行为 |
|---|---|---|---|
| Main → Renderer | `open-fpk-app` | `appId`（另附 found/url/ts） | `found:true`：主进程在飞牛框架内（独立应用窗口）加载应用，渲染进程记录唤起指令；`found:false`：渲染进程弹窗"找不到该应用，请重新创建快捷方式。"（preload.js 监听处理） |
| Renderer → Main | `create-desktop-shortcut` | `{ appId, appName }` | 创建桌面快捷方式（`.lnk`），返回 `{ success, msg }`，渲染进程弹窗反馈 |
| Renderer → Main | `set-auto-launch` | `{ enable }` | 注册表写入开机自启，返回 `{ success, msg }` |

> 既有兼容事件（`settings:set-autostart` 等）保留并委托同一实现，不属于新增定义。
> 渲染进程日志复用既有 `fnos:media-log` 通道汇入主进程日志文件，未新增 IPC 事件（前置约定 2）。

## 3. 测试步骤（2.7 边界用例逐条对照）

1. **重复双击同一快捷方式**：首次启动走场景 B（加载完成 hide+托盘）并打开应用；再次双击走场景 A
   ——新进程握手后 `app.exit(0)` 不建窗，主进程 second-instance 解析 `--launch-app` 打开应用。
   预期：仅一个应用窗口、无第二个主程序实例、主窗口不自动弹出。
2. **运行中唤起其他应用**：双击另一应用快捷方式，主进程 `createAppWindow` 打开新应用窗口。
   预期：两个应用窗口并存，无崩溃、无主页弹出。
3. **开机自启重启**：开启自启 → 重启电脑。预期：FNOS 自动启动且**只驻留托盘**，不弹主页、
   不自动打开任何应用；托盘菜单仅【显示主界面】【退出程序】。
4. **重复点击"创建快捷方式"**：多次点击。预期：每次实时拉取 FPK 图标（禁本地缓存），
   `.lnk` 同名覆盖写入成功；成功弹"桌面快捷方式已生成"。
5. **休眠/关机恢复后唤起**：电脑休眠恢复后双击快捷方式。预期：托盘经 `__trayGuard` 定时检测/
   resume 事件自动重建；second-instance 唤起链路正常。
6. **关闭应用后重复唤起同一应用**：关闭应用窗口再双击快捷方式。预期：重新打开应用窗口，
   主窗口保持隐藏。
7. **快捷方式指向的应用已从 FPK 删除**：双击该快捷方式。预期：渲染进程弹窗
   "找不到该应用，请重新创建快捷方式。"，不打开空白窗口、不崩溃。

**日志验证**：`%APPDATA%/.../userData/logs/fnos-{date}.log` 行格式
`[时间戳] [级别] [main|renderer] [模块] [runMode] 消息 {params json}` + Error 堆栈；
关键节点（启动锁判断/second-instance/IPC/托盘/快捷方式/唤起/图标/窗口显隐/自启/异常）均带参数。

**图标验证**：fntb 修改某应用图标后，主页刷新（F5）立即展示新图标，5 秒内自动同步；
任务栏/快捷方式图标从 FPK 实时拉取；全链路不读旧本地缓存。

## 4. 已知限制与映射说明

1. **"渲染进程路由跳转加载应用"已按需求落实（v2.4.7 后台模拟点击，用户定案）**：`open-fpk-app` IPC 事件流保留（需求 2.5-1）；渲染进程在隐藏主窗内**模拟点击飞牛桌面应用图标**启动应用（≡真实点击，参数/解析/登录链路全等价）。飞牛应用两种窗口模式：**A 独立跳出窗**（前端 `window.open` → setWindowOpenHandler → `createAppWindow`）/ **B 桌面内嵌窗**（iframe 窗口容器，↻↗ 标题栏）；快捷方式统一呈现"从主程序跳出的窗口"：点击后监测新增 iframe（模式 B）→ `window.open(src)` 转跳出窗。主程序藏托盘、跳出窗显示在桌面。
  - **否定链（勿回头）**：v2.4.1 直开 createAppWindow="新建窗口启动"（≠程序内启动）；v2.4.2 整页跳丢壳；v2.4.3 模拟点击方向对但图标 DOM 假设错（真 DOM：div.cursor-pointer + img.semi-image-img，alt=显示名，[飞牛论坛油猴帖](https://club.fnnas.com/topic/3893/)实证）退化；v2.4.4 容器须 show 主界面；v2.4.5/2.4.6 `appview?anchor=` 直开**不等价点击**（Lucky 实测"应用 lucky 不存在或未安装"——anchor 是显示名，解析失败）。
  - **图标匹配（v2.4.7）**：img.semi-image-img 两轮匹配（精确 alt=anchor → 模糊 alt/data-src 含 anchor，大小写不敏感 Lucky/lucky）；150ms×40 重试；兜底 `window.open(url)` → createAppWindow（不再整页跳/静默）。
  - **机制调研**：Electron 单实例官方范式 = `app.requestSingleInstanceLock()` + `app.on("second-instance", (event, argv, …))` + 锁失败方 quit（微信/QQ/VS Code 同款）：[Electron app 文档](https://www.electronjs.org/zh/docs/latest/api/app)、[Deep Links 教程](https://www.electronjs.org/zh/docs/latest/tutorial/launch-app-from-url-in-another-app/)、[掘金企业级实战](https://juejin.cn/post/7164985606463258638)。
  - **速度定案（v2.4.8）**：快捷方式直启 portable exe"20 多倍"差距根因 = 每次自解压 app.asar 到随机 Temp 目录（diag 日志实证），程序内链路实测仅 15ms（锁判断→icon-clicked→appwin.create）；定案 **wscript 触发器（毫秒级、无黑窗）+ loopback HTTP 触发通道**（127.0.0.1 随机端口 + 每次启动随机 token）直通常驻主程序走模拟点击链路，主程序未运行时回落冷启动 exe（second-instance 兜底完整保留、旧 .lnk 兼容）；embed-to-popup 转跳出后清理主窗内嵌窗（window.open 成功才删，防应用丢失）。全网调研否决 V8 snapshot / require 延迟等框架级优化（只省数百 ms，消不掉 portable 解压固有成本；微信/QQ 式轻量触发器 + 本地通道是标准解法）。
  - **两模式定案（v2.4.9）**：桌面内嵌窗型（Lucky/docker/网盘：点击先在主窗开 iframe 内嵌窗）→ preload 监测到内嵌窗后 window.open 带 **fnos-embed-style** 标记（不再裸转跳出）→ registerWindow handler 识别 features 标记 → createAppWindow(embedStyle:true) → titlebar-inject 按 additionalArguments 标记渲染 **fnOS 内嵌窗形态标题栏**（黑底+应用 logo/标题+↻↗—□✕ 五钮，↻reload、↗跳出为独立窗、—□✕ 现成 IPC），主窗内嵌原件**无条件清理**（v2.4.8 按 window.open 返回值判断、deny 恒 null=死代码，embed-removed 从未触发，已修正）；独立跳出窗型（飞牛音乐等前端自发 window.open 无标记）→ 正常跳出窗不变；主界面规则不变（快捷方式流程永不弹出；点主程序图标/托盘调出）。**零新增 IPC、零新增打包文件**。

2. **second-instance 无应用参数时显示主窗口**（v2.4.1 用户反馈调整）：用户点击主程序启动
   = 显式查看主界面意图 → show + focus；带应用参数的快捷方式唤起仍隐藏主窗口。托盘图标
   **单击**展示主界面的行为保留（人工动作，等效托盘【显示主界面】）。
3. **electron-store 未引入**：按前置约定 1 不引入新依赖，开关状态以既有 settings JSON
   （`saveSettings({ autoLaunch })`）持久化，语义等价。
4. **切账号 partition destroy**（既有行为）保留：切换账号会销毁对应 webview 分区，
   该分区内应用窗口需重新唤起。
5. **旧快捷方式参数兼容**：v2.3.3 及以前生成的 `--app=URL` 快捷方式仍可解析打开，
   新生成快捷方式统一 `--launch-app={应用唯一 ID}`。
6. **未登录状态**：快捷方式唤起时主进程未登录则入队 `__pendingAppUrl`，登录完成后自动打开
   应用；登录页（/login）显示属登录流程必要展示，非主页弹出。
7. **主窗口显示策略（v2.4.5，用户反馈模型定案）**：点击启动飞牛主程（无应用参数）显示主
   窗口（主页，含 10s 黑屏兜底）；桌面快捷方式（`--launch-app`/`--app`/`--open-app`）
   **不显示主界面**（用户模型：场景 1"不新开主窗口"、场景 2"启动完成后隐藏主界面，只驻留
   托盘"、场景 3"没有主界面"）——程序内启动以复用式应用窗呈现应用（≡主页点击图标效果）；
   开机自启（Run 键命令带 `--autostart` 标记、不带应用 ID）隐藏主窗口只驻留托盘（需求 2.2
   不变）。

## 5. 版本记录

- **fnos v2.4.0**（APP_VERSION + package.json）：本次 r14 全部 BUG 修复与新功能。
- **fntb v2.18.7**（manifest + BUILTIN_VERSION）：日志弹窗删除"(不存在)"标记等 3 处文案。
- **fnos v2.4.1**（真机反馈修复）：① `logger.js` 补入 electron-builder `build.files` 打包白名单
  （根因：打包缺失导致 preload.js `require('./logger.js')` 抛 MODULE_NOT_FOUND 阻断
  `exposeInMainWorld('fnos')` 与标题栏注入 → 登录报 window.fnos undefined、标题栏消失）；
  ② preload.js logger require 加 try/catch 降级 stub（防御同类问题）；③ 主窗口显示策略按用户
  要求条件化（见上"已知限制 7"）；④ 开机自启 Run 键值加 `--autostart` 标记；⑤ second-instance
  无参 show。
- **fnos v2.4.2**（用户反馈）：快捷方式改为**程序内启动应用**——`open-fpk-app` found:true 时
  渲染进程在主窗口内同窗导航到应用页面（不新建独立应用窗口、不隐藏主窗口）；快捷方式路径
  移除 `createAppWindow`/`hideMainToBackground`；did-navigate 后显示主窗口 + 2s 兜底；
  found:false 弹窗前确保窗口可见。
- **fnos v2.4.3**（用户反馈 + 全网调研）：程序内启动定论实现——模拟点击飞牛桌面应用图标，
  由飞牛桌面前端在桌面内以 iframe 窗口容器（fnOS 桌面窗口，ui `type:"iframe"` 窗口模式）打开
  应用（≡主页点击图标效果）；移除 v2.4.2 顶层整页跳 `/appview` 方案与 did-navigate show 链路；
  快捷方式改为通知前 show 主窗口（桌面窗口容器在其内部）；续点机制（不在桌面先回桌面根路由，
  页面重载后自动续点，fromRetry 防登录页死循环）；6s 无图标退回同窗导航兜底（日志
  `icon-not-found` 供下轮诊断）。
- **fnos v2.4.4**（反馈 4 + 桌面图标 DOM 实证）：程序内启动改为**桌面窗口容器**（iframe）
  确定性实现——主窗口内注入窗口容器（标题栏/拖动/缩放/iframe 加载 appview 或应用 URL）；
  修正图标点击匹配（真实 DOM = div + `img.semi-image-img`，dispatchEvent 防 `<a>` 默认跳转，
  2s 未命中即开容器）；移除 v2.4.3 `location.assign` 兜底（真机日志定案其因图标 DOM 假设错误
  恒 `icon-not-found` 而退化为被否定的 v2.4.2 行为）；快捷方式启动流程期（8s）内全局
  `setWindowOpenHandler` 将一切 http(s) 开窗转入容器（`fnos-deskwin-open`），全程无新 OS 窗口。
- **fnos v2.4.5**（用户反馈模型定案：快捷方式=触发器）：程序内启动重构为**复用式应用窗**
  `__openAppInClientWindow`（单例 `__appLaunchWindow`：已存在则 `loadURL` 同窗切应用 + 聚焦=
  毫秒级秒开，不存在才建一次；≡主页点击图标效果）；主进程 `__notifyOpenFpkApp` 链路直开
  复用窗（最短路径）；快捷方式流程主界面永不 show（删 v2.4.4 全部 SHOW+2s 兜底）；
  preload 删 v2.4.4 桌面窗口容器/图标点击/整页跳/2s 轮询（`handled-by-main` 观察日志保留
  open-fpk-app 事件流）；流程期全局开窗兜底改转复用窗（`to-reuse`）；`createAppWindow`
  透传窗口引用。三场景：①实例在跑=IPC 复用窗秒开；②冷启动=主界面隐藏驻托盘+应用窗加载
  应用；③--autostart 常驻后=IPC 唤起毫秒级、没有主界面。
- **v2.4.6**（2026-09-23，反馈 5"没改过来还是老样子"）：真机日志定案两 bug——①弹窗出登录页（SHARED_PARTITION 与主窗 session 不同源，appview 重定向 `/login`）→ partition 走 currentPartition 同源秒进应用；②关窗后复用链路断、观感"每次弹新窗"→ 同应用秒开聚焦（`__fnosLaunchAppId`）+ `appwin.reuse-closed` 埋点。用户选择题定案形态=独立应用窗复用同一扇。11 项验证 PASS。
- **v2.4.7**（2026-09-23，反馈 6"完全是两码事"+两种窗口模式截图定案）：程序内启动终极定案=**后台模拟点击桌面图标**（≡真实点击，唯一等价链路：参数/解析/登录全由飞牛前端处理）；`appview?anchor=` 直开不等价（Lucky"应用 lucky 不存在或未安装"实锤）。窗口呈现统一"跳出的窗口"（模式 B 内嵌 iframe 监测 → window.open 转跳出）；拆除 v2.4.5/2.4.6 复用窗直开与流程期拦截。15 项验证 PASS。
- **v2.4.8**（2026-09-23，反馈 7"差了 20 多倍"+"还有 LUCKY 内嵌式窗口"）：**秒开定案**——快捷方式改 wscript 触发器脚本 + loopback HTTP 触发通道（随机 token 鉴权）直通常驻主程序模拟点击链路，绕过 portable 自解压（20 倍差距根因，diag 实证 Temp 解压；程序内链路 15ms 实测）；主程序未运行回落冷启动 exe（second-instance 兜底完整保留，旧 .lnk 兼容）。embed-to-popup 转跳出后清理主窗内嵌窗（window.open 成功才删）；图标未命中重试 150ms×40（提速 4 倍）。22 项验证 PASS。
- **v2.4.9**（2026-09-23，反馈 8 两种窗口模式自动适配）：**内嵌窗型不再自动转跳出**——preload 带 fnos-embed-style 标记开宿主应用窗，titlebar-inject 渲染 fnOS 内嵌窗形态标题栏（logo+标题+↻↗—□✕），主窗内嵌原件无条件清理（修正 v2.4.8 window.open 返回值恒 null 的清理死代码）；跳出窗型（前端 window.open）正常跳出不变；主界面规则不变。零新增 IPC。28 项验证 PASS。
- **v2.4.10**（2026-09-23，发布链修复）：v2.4.9 内容不变；v2.4.9 CI success 但 Release assets=0（softprops files glob 空匹配静默+上传软失败偶发，Upload artifact 同 glob 成功=产物完好）——Release 步改 gh CLI 显式流程：无产物拒绝发布空 Release、上传 4 次重试、--clobber 幂等可重跑、rc/beta 打 prerelease。
