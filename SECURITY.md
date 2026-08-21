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

## 版本对应

- v1.10.0：玻璃锁屏、设置面板、性能开关、Win7 支持（Electron 22）
- v1.10.1：托盘后台下载、下载窗关闭不取消、一级「设置」菜单
- v1.10.2：检查更新、图标多尺寸 ICO、帮助重写
- v1.10.3：修复检查更新双提示、设置窗可滚动、锁屏精简、安全审查文档
- v1.10.4：下载速度/ETA 修复、检查更新交互修复、启动锁屏极简、EXE 图标写入修复
- v1.10.5：双保存对话框修复、取消下载不损坏 NAS 文件、CORS 注入收窄、检查更新代理修复、恢复投屏/媒体服务、快捷方式图标覆盖

## 免责声明

本项目为第三方社区作品，与飞牛（fnOS）官方没有隶属关系。"fnOS"及相关商标归其权利人所有。使用本软件产生的一切后果由使用者自行承担。
