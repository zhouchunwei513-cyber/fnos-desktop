# 安全声明（Security Policy）

## 这是什么

FNOS Desktop 是一个基于 Electron 的 fnOS 飞牛私有云桌面客户端。它的本质是：

- **一个定制化的 Chromium 浏览器外壳**，专门用来打开你自己的 fnOS 网页；
- 它不收集、不上传、不转发任何用户数据到任何第三方服务器；
- 它不会把你的账号、密码、Cookie、文件内容发送给作者或任何第三方。

## 数据保存在哪里

所有数据都保存在你本地电脑上：

| 数据 | 保存位置 | 保护方式 |
|---|---|---|
| 服务器地址 / 历史记录 | `%APPDATA%\FNOS\settings.json` | Electron `safeStorage`（Windows DPAPI）加密 |
| 启动密码哈希 | 同上 | scrypt + 随机 salt，不保存明文 |
| 登录态 / Cookie / 缓存 | Chromium 用户数据目录（按服务器分 partition） | 操作系统用户级隔离，绑定当前 Windows 账号 |

`safeStorage` 在 Windows 上使用 DPAPI，**只有当前 Windows 登录用户能够解密**，其他用户或拷贝到其他电脑均无法读取。

## 通信安全

- 程序只与你**自己填写的服务器地址**通信（IP / 域名 / FN ID 解析后的地址）；
- 程序只与 GitHub API 通信用于"检查更新"，不会在检查更新时发送任何可识别身份的信息（仅包含 User-Agent `FNOS-Desktop/<版本>`）；
- 所有其他 Chromium 内置的遥测 / 建议服务 / 翻译等已通过以下命令行参数禁用：
  - `--disable-background-networking`
  - `--disable-domain-reliability`
  - `--disable-client-side-phishing-detection`
  - `--disable-sync`
  - `--metrics-recording-only`
  - 等（完整列表见 `main.js` 启动参数）

## 第三方依赖

- Electron 22（Chromium 108，最后一个支持 Windows 7 的版本）
- 所有 npm 依赖都在 `package.json` 中列明，使用 pnpm 锁定版本（`pnpm-lock.yaml`）
- 内置 **mpv.exe**（GPL v2+ 协议开源），来自 mpv 官方 winbuild，仅用于本地显卡硬解视频，不发起任何网络请求

## CORS 绕过 / KNAS 等效功能说明

为了让飞牛影视的直播源能在程序内正常播放（部分直播源在浏览器中受跨域限制），程序对**目标为你自己服务器 IP / 域名**的请求，在响应头中注入了：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Credentials: true`
- `Access-Control-Allow-Methods/Headers: *`

这只影响你**主动配置并登录的那一台 fnOS 服务器**，不会对任何其他网站生效，也不会把数据发送到任何中间方。

## 代码审计

本项目完全开源，欢迎自行审查：

- 仓库：https://github.com/zhouchunwei513-cyber/fnos-desktop
- 协议：MIT

建议重点审查：

| 文件 | 关注点 |
|---|---|
| `main.js` | 主进程，所有网络/文件/加密/IPC 逻辑 |
| `preload.js` | 暴露给渲染进程的 API 白名单 |
| `*-preload.js` | 各页面独立的 preload（最小权限） |
| `js/*` | 无原生模块，纯前端逻辑 |

## 已知安全设计

1. **contextIsolation: true** + **nodeIntegration: false**：网页无法访问 Node.js API
2. **webSecurity: true**：保持同源策略
3. **setWindowOpenHandler**：所有 `window.open` 都在程序内受管窗口中打开，不调用外部浏览器
4. **will-navigate**：只允许导航到当前服务器 origin 或本地内置页面，阻止跳转到未知域名
5. **权限请求拦截**：摄像头/麦克风/位置等权限默认拒绝
6. **启动密码**：scrypt 加盐哈希 + timingSafeEqual 防时序攻击
7. **锁屏窗口**：屏蔽 Alt+F4、Esc、F5、DevTools，强制必须输入密码
8. **一键隐藏**：彻底销毁托盘图标，只响应你设置的全局快捷键

## 忘记启动密码

启动密码是本地哈希，**无法找回**。重置方法：

1. 退出 FNOS
2. 删除 `%APPDATA%\FNOS\settings.json`
3. 重新启动（历史记录会清空，但各服务器登录态不会清除）

## 报告漏洞

如果你发现安全问题，请通过 GitHub Issues 私下联系作者，或直接提交 PR 修复。请勿在公开 Issue 中提交可利用的 0-day 细节。

## v1.10.3 安全自查清单

| 项 | 状态 |
|---|---|
| `contextIsolation: true` + `nodeIntegration: false`（所有窗口） | ✅ |
| `sandbox: false`（需 preload 暴露 API，但 IPC 白名单最小化） | ✅ |
| 渲染进程无可直接调用的文件系统 / shell 接口 | ✅ |
| 启动密码使用 `scryptSync` + 16 字节随机盐 + `timingSafeEqual` | ✅ |
| settings.json 使用 `safeStorage`（Windows DPAPI）加密 | ✅ |
| 每服务器独立 `persist:nas-<hash>` partition，Cookie/缓存物理隔离 | ✅ |
| 外链下载：`showSaveDialog` 后才 setSavePath/resume，不自动落盘 | ✅ |
| 关闭下载进度窗口仅隐藏，不取消后台下载，任务项可在托盘查看 | ✅ |
| URL 重写规则仅替换 origin/path 前缀，不执行 JS | ✅ |
| CORS 头注入仅作用于用户配置的服务器 partition | ✅ |
| 检查更新只请求 GitHub Releases API，不携带任何身份凭据 | ✅ |
| 全局快捷键（锁定/隐藏）可在设置中自定义，冲突时优雅跳过 | ✅ |
| 锁屏窗口屏蔽 F5/Ctrl+R/ESC/右键/Alt+F4 | ✅ |
| 一键隐藏彻底销毁 Tray，仅全局快捷键可恢复 | ✅ |
| MPV 仅以本地文件路径或当前页 video.src 启动，不接受远程任意命令 | ✅ |
| 无埋点、无崩溃上报、无自动更新下载（仅弹窗提示，由用户手动下载） | ✅ |

## v1.10.4 安全自查补充

| 项 | 状态 |
|---|---|
| 下载速度计算不依赖外部返回值，仅基于 `DownloadItem.getReceivedBytes()` 与本地时间窗口差分 | ✅ |
| ETA 在主进程内基于本地字节计算，不引入额外网络请求 | ✅ |
| 检查更新请求增加 12 秒超时 + `request.abort()`，避免挂起连接长期占用 | ✅ |
| 检查更新仅解析 GitHub API 返回的 `tag_name` / `name` / `html_url` / `body`，不 innerHTML、不执行任何脚本 | ✅ |
| 检查更新失败不静默吞错，向用户给出含 Release 页链接的提示（不自动跳转） | ✅ |
| 锁屏页移除修改密码入口，密码设置 / 修改仅在「设置」窗口（已登录态）内完成 | ✅ |
| 锁屏页 DOM 中 setup-form 默认 `hidden`，仅从设置页以 `mode=change` 打开时才显示 | ✅ |
| 启用 electron-builder `signAndEditExecutable`（默认 true），确保发布的 EXE 内嵌多尺寸品牌图标，防止被伪造为默认 Electron 图标 | ✅ |
| 设置 `app.setAppUserModelId('com.fnos.client')`，Windows 任务栏 / 通知按品牌 AUMID 分组 | ✅ |
| 安装包 NSIS 脚本使用品牌 ICO，桌面 / 开始菜单 / 卸载快捷方式均指向安装目录内 EXE | ✅ |

## v1.10.5 安全自查补充

| 项 | 状态 |
|---|---|
| will-download 去重：同 URL+文件名 1.5s 内只弹一次保存框，防止双下载 | ✅ |
| will-download 触发立即 pause()，阻止 Chromium 默认下载落到默认目录 | ✅ |
| **取消下载不发送任何 DELETE/PUT 到 NAS**：先 pause 1.5s 让服务端 EOF，再 cancel | ✅ |
| CORS 注入收窄到媒体/直播流（m3u8/ts/mp4/mkv/flv 等），不再污染所有响应 | ✅ |
| 移除非法的 `Access-Control-Allow-Credentials: true` + `Allow-Origin: *` 组合 | ✅ |
| OPTIONS 预检只对媒体流短路 204，业务 API 的 OPTIONS 完全透传给 NAS | ✅ |
| 检查更新请求使用 `session.defaultSession`，自动遵循系统代理；不携带 Cookie/凭据 | ✅ |
| 检查更新请求 25s 超时 + 1 次自动重试，失败时只展示文字错误，不解析 HTML | ✅ |
| 恢复 MediaRouter / CastMediaRouteProvider / DialMediaRouteProvider / GlobalMediaControls / HardwareMediaKeyHandling，不影响飞牛投屏等业务 | ✅ |
| 移除 `enable-parallel-downloading` 和 `max-connections-per-host=32`，避免激进并发触发 NAS 网关 bug | ✅ |
| NSIS 安装时先删除旧 .lnk 再重建，调用 SHChangeNotify 刷新图标缓存 | ✅ |
| 快捷方式写入 AppUserModelID，与主程序 `app.setAppUserModelId('com.fnos.client')` 一致 | ✅ |
| 不收集、不上传、不转发任何用户数据；无埋点、无崩溃上报、无自动更新下载 | ✅ |

## v1.11 安全自查补充

| 项 | 状态 |
|---|---|
| **跨 session 全局下载去重**：以「文件名 + 总大小 + URL 路径末段」为指纹，3 秒内相同指纹只弹一次保存框，彻底消除双保存对话框 | ✅ |
| will-download 改为同步回调，立即 `pause()` 后再通过 setImmediate 异步弹保存框，避免默认保存路径与自定义保存框竞争 | ✅ |
| 保存对话框关闭后立即把焦点还给父窗口，避免悬浮窗抢走焦点导致对话框"假滞留" | ✅ |
| 后台下载通过 `activeDownloads` 全局注册表跟踪，`finishedDownloads` 仅保留最近 10 条，不持久化到磁盘 | ✅ |
| 下载窗口关闭按钮在下载未完成时只 `hide()`，不 cancel；下载完成 / 取消后才真正销毁 | ✅ |
| 取消下载继续沿用 `pause → 1.5s → cancel`，不向 NAS 发送任何 DELETE/PUT/POSITION 等业务请求 | ✅ |
| CORS 注入范围保持 v1.10.5 收窄结果（仅 m3u8/ts/mp4/mkv/flv/webm 等媒体 / 直播流），业务 API 完全透传 | ✅ |
| 移除「帮助 → 检查更新…」菜单项，避免在无 GitHub 访问条件下误点；不删除已实现的更新检查代码（保留给未来手动调用） | ✅ |
| NSIS 安装阶段额外调用 `ie4uinit.exe -ClearIconCache` 配合 `SHChangeNotify(SHCNE_ASSOCCHANGED)` 双重刷新图标缓存 | ✅ |
| 未删除/未禁用任何 Chromium 常见服务（投屏、媒体控制、硬件多媒体键、自动更新等保持 v1.10.5 状态） | ✅ |
| 未改变飞牛前端任何业务逻辑；所有下载管理仅作用于 Electron 主进程 DownloadItem 生命周期 | ✅ |
| 不收集、不上传、不转发任何用户数据；无埋点、无崩溃上报、无自动更新下载 | ✅ |

## v1.13 安全自查补充

| 项 | 状态 |
|---|---|
| 修复 `downloadWindows` 未声明导致进度窗创建抛 ReferenceError、进度条不显示且菜单无任务的问题；事件注册与窗口创建加 try/catch 兜底 | ✅ |
| 历史服务器新增独立 `servers.json` 存储（明文 + 原子写 + `.bak` 备份），与 `settings.json` 双保险；`settings.json` 由 DPAPI 加密改为明文 JSON（仅含服务器地址等非敏感信息，密码保存在各 partition Cookie），解决便携版换目录/DPAPI 异常导致历史读空 | ✅ |
| `loadSettings` 合并 `servers.json` 与 `settings.json` 历史（按 partition 去重），任一份存活即不丢历史 | ✅ |
| 连接成功与每次主框架导航后立即 `flushStorageData` / `cookies.flushStorageData`，避免强杀进程丢失登录态 | ✅ |
| 内置 mpv.exe 通过 `asarUnpack` 解包到 `resources/app.asar.unpacked/bin/mpv/`，`findExternalPlayer` 优先查找该路径，可执行文件不从 asar 内 spawn | ✅ |
| 新增「下载」「工具」一级菜单；工具菜单含 MPV 硬解、系统终端、MPV 安装目录；系统终端用临时 .bat 启动 PowerShell/cmd，工作目录定位 MPV 目录，标题纯 ASCII 避免中文解析错误 | ✅ |
| 系统终端仅启动本机控制台，不接收/拼接任何外部输入，无命令注入面 | ✅ |
| 启动诊断日志 `fnos-diag.log` 仅记录 userData 路径、exe 路径、版本、时间，不含任何账号/服务器凭据 | ✅ |
| 取消下载继续走 pause→1.5s→cancel，不向 NAS 发送任何 DELETE/PUT/POSITION | ✅ |
| CORS 注入仍限定媒体流，业务 API 完全透传；保留投屏/媒体键等常见服务 | ✅ |
| 安装包所有图标（安装程序、卸载程序、EXE、快捷方式、标题栏）统一使用飞牛 LOGO `icon.ico`；快捷方式直接引用 `$INSTDIR\icon.ico` + 三重图标缓存刷新 | ✅ |
| 未改变飞牛前端任何业务逻辑；不收集/不上传/不转发任何用户数据 | ✅ |

## v1.12 安全自查补充

| 项 | 状态 |
|---|---|
| **will-download 同步 setSavePath 占位**：在 will-download 回调返回前同步把保存路径指到系统 temp 下唯一 `.part` 文件，彻底抑制 Chromium 自带保存对话框；不再依赖 pause 时序 | ✅ |
| 用户选定路径后再 resume 下载，下载完成把 `.part` rename 到最终路径；同盘走 rename，跨盘回退 copyFile+unlink；用户取消时清理 `.part` | ✅ |
| 临时文件始终位于 `app.getPath('temp')`，不接触 NAS、不接触用户下载目录的残留 | ✅ |
| 全局下载去重保持 v1.11：文件名+总大小+URL path 末段指纹，3 秒窗口，跨所有 partition | ✅ |
| 取消下载继续走 pause→1.5s→cancel，不向 NAS 发送任何 DELETE/PUT/POSITION | ✅ |
| CORS 注入仍限定 m3u8/ts/mp4/mkv/flv/webm 媒体流，业务 API 完全透传 | ✅ |
| 进度窗口 ready-to-show 后用 show()+focus() 强制可见，修复"进度条不见了" | ✅ |
| NSIS 快捷方式图标改为直接引用 `$INSTDIR\icon.ico`（独立 ICO，不依赖 EXE 图标缓存）；删除所有历史名字的旧 .lnk；SHChangeNotify(SHCNE_ASSOCCHANGED) + SHCNE_UPDATEITEM(lnk path) + ie4uinit -show + -ClearIconCache 三重刷新 | ✅ |
| 帮助页改为纯功能/操作手册，不再包含版本更新日志，符合"只介绍功能及操作"要求 | ✅ |
| 性能优化仅关闭飞牛不使用的组件（Speech/Geolocation/Notification/WebPayments/WebBluetooth/WebUSB/WebXR 等），保留 MediaRouter/Cast/DIAL/GlobalMediaControls/HardwareMediaKeyHandling 等常见服务 | ✅ |
| 磁盘缓存回调到 128MB、V8 老生代 512MB / 新生代 32MB，降低单渲染进程基础内存占用 | ✅ |
| 未改变飞牛前端任何业务逻辑；所有下载管理仅作用于 Electron 主进程 DownloadItem 生命周期 | ✅ |
| 不收集、不上传、不转发任何用户数据；无埋点、无崩溃上报、无自动更新下载 | ✅ |

## v1.13 安全自查补充

| 项 | 状态 |
|---|---|
| 修复 `downloadWindows` 未声明导致进度窗创建抛 ReferenceError、进度条不显示且菜单无任务；事件注册与窗口创建加 try/catch 兜底 | ✅ |
| 历史服务器新增独立 `servers.json` 存储（明文 + 原子写 + `.bak` 备份），与 `settings.json` 双保险；`settings.json` 由 DPAPI 加密改为明文 JSON（仅含服务器地址等非敏感信息，密码保存在各 partition Cookie），解决便携版换目录/DPAPI 异常导致历史读空 | ✅ |
| `loadSettings` 合并 `servers.json` 与 `settings.json` 历史（按 partition 去重），任一份存活即不丢历史 | ✅ |
| 连接成功与每次主框架导航后立即 `flushStorageData` / `cookies.flushStorageData`，避免强杀进程丢失登录态 | ✅ |
| 内置 mpv.exe 通过 `asarUnpack` 解包到 `app.asar.unpacked/bin/mpv/`，可执行文件不从 asar 内 spawn | ✅ |
| 新增「下载」「工具」一级菜单；系统终端用临时 .bat 启动本机 PowerShell/cmd，不接收/拼接外部输入，无命令注入面 | ✅ |
| 启动诊断日志 `fnos-diag.log` 仅记录 userData 路径、exe 路径、版本、时间，不含任何账号/服务器凭据 | ✅ |
| 取消下载继续走 pause→1.5s→cancel，不向 NAS 发送任何 DELETE/PUT/POSITION | ✅ |
| 安装包所有图标（安装程序、卸载程序、EXE、快捷方式、标题栏）统一使用飞牛 LOGO `icon.ico`；快捷方式直接引用 `$INSTDIR\icon.ico` + 三重图标缓存刷新 | ✅ |
| 未改变飞牛前端任何业务逻辑；不收集/不上传/不转发任何用户数据 | ✅ |

## 版本对应

- v1.10.0：玻璃锁屏、设置面板、性能开关、Win7 支持（Electron 22）
- v1.10.1：托盘后台下载、下载窗关闭不取消、一级「设置」菜单
- v1.10.2：检查更新、图标多尺寸 ICO、帮助重写
- v1.10.3：修复检查更新双提示、设置窗可滚动、锁屏精简、安全审查文档
- v1.10.4：下载速度/ETA 修复、检查更新交互修复、启动锁屏极简、EXE 图标写入修复
- v1.10.5：双保存对话框修复、取消下载不损坏 NAS 文件、CORS 注入收窄、检查更新代理修复、恢复投屏/媒体服务、快捷方式图标覆盖
- v1.11：跨 session 全局下载去重、后台下载菜单/托盘调出入口、取消检查更新菜单、图标缓存双重刷新、保存对话框焦点修复
- v1.12：will-download 同步 setSavePath 抑制 Chromium 自带对话框（彻底修复双保存框）、.part 临时文件 + 完成后 rename、进度窗强制 show、快捷方式直接引用独立 ICO + 三重图标缓存刷新、帮助页改为纯功能手册、性能优化（关闭飞牛不用的组件）
- v1.13：修复下载进度窗/菜单任务丢失、新增「下载」「工具」一级菜单与系统终端、历史服务器独立 servers.json 双保险持久化、登录态及时落盘、mpv asarUnpack 修复、安装包所有图标统一飞牛 LOGO
- v1.14：修复实验性玻璃标题栏重启不生效（主窗口未读取设置 + 复选框 ID 不匹配 + 增加重启确认与 app:restart IPC）、图标按小米 LOGO 超椭圆圆角比例重绘（含全套 ICO 尺寸）、性能优化（4 线程光栅化、sRGB 色彩配置、隐藏/最小化窗口降帧到 15fps、追加禁用飞牛不用的常驻组件，保留投屏/媒体键/自动更新等常见服务）

## 免责声明

本项目为第三方社区作品，与飞牛（fnOS）官方没有隶属关系。"fnOS"及相关商标归其权利人所有。使用本软件产生的一切后果由使用者自行承担。
