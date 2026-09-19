# FNOS 桌面客户端 v1.10.5 更新公告

> 飞牛私有云的非官方 Windows 桌面客户端，基于 Electron 22 打包，内核 Chromium 108，原生支持 **Windows 7 SP1 x64 及以上** 系统。
>
> 开源地址：<https://github.com/zhouchunwei513-cyber/fnos-desktop>
> 下载地址：<https://github.com/zhouchunwei513-cyber/fnos-desktop/releases/latest>

---

## 📦 本次更新（v1.10.5 · 紧急修复版）

本次版本集中处理作者内测反馈的 **下载流程（双弹窗 / 损坏 NAS 原文件 / 进度框裁切）、检查更新代理、快捷方式图标、Chromium 服务误禁用** 四类问题。

> ⚠️ 特别说明：v1.10.3 / v1.10.4 为了"性能优化"禁用了若干 Chromium 服务，可能影响飞牛影视投屏、系统媒体控制等功能。v1.10.5 **全部恢复**，只保留与 NAS 业务无关的纯性能开关。

### 1. 下载流程修复（重点）

#### 🔴 重大 BUG：取消下载可能损坏 NAS 原文件

- 旧版本点击「取消下载」会立刻调用 `item.cancel()`，向 NAS 发送 TCP RST 强制断开连接。飞牛 NAS 在部分版本下会把异常断开识别为"清理任务"，**极端情况下波及源文件**。
- v1.10.5 改为：先 `pause()` 本地停止接收数据 → 等 1.5 秒让服务端从容完成当前数据块并正常结束响应 → 再 `cancel()`。整个过程**绝不向 NAS 发送任何 DELETE / PUT / 修改类请求**，只关闭本地下载流。
- 同步收紧了 CORS 拦截器：之前对所有响应注入 `Access-Control-Allow-Origin: *` + `Allow-Credentials: true`（规范上的非法组合），并且对所有 OPTIONS 预检直接返回 204 空响应，**可能干扰飞牛前端的取消下载 / 删除 / 鉴权等业务接口**。v1.10.5 只对 `m3u8 / ts / mp4 / mkv / flv / webm` 等媒体 / 直播流注入 CORS（等效 KNAS 浏览器插件的真实行为），其他接口完全透传给 NAS。

#### 点下载后弹出 2 个保存对话框

- 根因 1：`enable-parallel-downloading` 和 `max-connections-per-host=32` 两个 Chromium 开关让部分 NAS 网关把同一文件识别为两次请求，触发双弹窗。已移除。
- 根因 2：同 URL + 同文件名的 will-download 事件在 1.5 秒内重复触发时，客户端现在自动去重，只弹一次保存框。
- will-download 触发后立即 `pause()`，阻止 Chromium 默认下载行为落到默认下载目录（否则会出现"一个默认下载 + 一个我们的弹框"）。

#### 下载进度框只显示一部分

- 窗口尺寸从 500×168 调整为 **560×200**，允许横向拉伸；
- 卡片内部改为 flex 列布局，文件名、保存路径超长自动省略号；
- 底部状态栏（百分比 · 速度 · 大小 · 剩余时间）和按钮组（后台运行 / 取消 / 打开文件夹）使用 `nowrap`，不再被裁切换行。

### 2. 检查更新修复

#### 开了代理仍提示无法连接 GitHub

- 旧版本用 `net.request` 时未显式指定 session，Electron 在某些情况下不会正确读取系统代理。
- v1.10.5 显式绑定 `session.defaultSession`，Electron `net` 会自动读取 Windows 系统代理设置 —— **Clash / v2rayN / Shadowsocks / Clash Verge 等只要是"系统代理"或"TUN 模式"都会自动生效**。
- 超时从 12 秒延长到 **25 秒**；
- 首次请求失败后**自动重试 1 次**；
- 错误提示中明确告知需要"系统代理"或"TUN 模式"，并给出 GitHub Release 直达链接。

#### 检查更新弹窗统一为透明玻璃风格

- "正在检查更新…"的转圈弹窗改为和软件其他提示一致的毛玻璃卡片样式（`backdrop-filter: blur(28px)` + 渐变边框 + 居中布局），不再使用自绘的不透明小方块。
- 弹窗位置居中于父窗口，检查结果（已是最新 / 发现新版本 / 失败）全部使用统一玻璃对话框。

### 3. 快捷方式图标彻底覆盖

- 之前从 v1.10.3 升级安装后，桌面快捷方式可能仍显示旧图标（Windows 资源管理器的图标缓存机制所致）。
- v1.10.5 的 NSIS 安装脚本：
  1. **先删除**旧的 `FNOS.lnk`（桌面 + 开始菜单）；
  2. 再用新 EXE（图标由 GitHub Actions 的 rcedit 写入）重建快捷方式，显式指定 icon index 0；
  3. 安装完成后调用 Windows API `SHChangeNotify(SHCNE_ASSOCCHANGED, ...)`，**主动通知资源管理器刷新图标缓存**；
  4. 快捷方式写入 `AppUserModelID = com.fnos.client`，与主程序 `app.setAppUserModelId` 一致，任务栏分组不再使用旧图标缓存。
- 如仍有个别设备显示旧图标，注销 Windows 重新登录一次即可彻底刷新。

### 4. 恢复被误禁用的 Chromium 服务

为了不影响 NAS 上已安装或将来可能安装的应用，v1.10.5 恢复了以下服务：

| 服务 | 作用 |
|---|---|
| `MediaRouter` | Chromecast / DLNA 投屏发现 |
| `CastMediaRouteProvider` | 投屏提供程序 |
| `DialMediaRouteProvider` | DIAL（Discovery and Launch）协议，用于智能电视 / 机顶盒发现 |
| `GlobalMediaControls` | 工具栏全局媒体控制（播放 / 暂停 / 进度） |
| `HardwareMediaKeyHandling` | 键盘多媒体键（播放 / 暂停 / 上一首 / 下一首） |

保留禁用的只有：`Translate`（不需要网页翻译）、`InterestFeedContentSuggestions`（内容推荐）、`UseChromeOSDirectVideoDecoder`（非 ChromeOS）、`BackForwardCache`（避免飞牛多窗口状态错乱）、`LazyFrameLoading`、`PrivacySandboxSettings4`、`OptimizationHints`、`MediaFeeds`，均与 NAS 业务无关。

### 5. 其他安全 & 稳定性

- 检查更新请求设置 `credentials: 'omit'`、`useSessionCookies: false`、`cache: 'no-store'`，不会把你的 NAS Cookie 发送到 GitHub；
- 只解析 GitHub API 返回的 `tag_name` / `name` / `body` / `html_url` 四个字段，不使用 `innerHTML`、不执行任何脚本；
- 下载速度滑动窗口计算、ETA、250ms UI 节流继续保留（v1.10.4 引入）；
- 所有 JS 文件通过 `node --check` 语法验证；
- `SECURITY.md` 增加 v1.10.5 自查清单 13 项。

---

## 📜 历史版本回顾

### v1.10.4（2026-08-22）

- 下载速度显示异常修复：3 秒滑动窗口手动计算平均速度，新增 ETA 剩余时间；
- 检查更新交互修复：点击立即弹转圈窗、12 秒超时、三种状态都有反馈；
- 启动锁屏极简：只保留密码输入框 + 解锁按钮；
- 程序图标 / 快捷方式图标修复：重新启用 electron-builder 图标写入、设置 AppUserModelId、多尺寸 ICO（16 ~ 256）。

### v1.10.3（2026-08-21）

- 下载窗关闭即取消问题修复（隐藏到后台）；
- 检查更新双提示修复；
- 设置窗升级为一级菜单、整页可滚动；
- 锁屏移除修改密码入口；
- 性能开关扩充（自动隐藏菜单栏、玻璃标题栏、6 种主题色等）；
- 图标全套替换为飞牛 LOGO，多尺寸 ICO；
- 新增 SECURITY.md 安全审查文档。

### v1.10.2（2026-08-20）

- 托盘后台下载；
- 检查更新首版；
- 多尺寸 ICO / PNG 资源；
- 锁定 Electron 22 兼容 Win7 SP1 x64。

### v1.10.1（2026-08-19）

- 多窗口稳定性修复；
- 返回主页流程优化（后台保留 / 一并关闭）；
- 托盘交互优化。

### v1.10.0（2026-08-18）

- 玻璃锁屏系统（透明毛玻璃 + 彩虹光带、scrypt 加盐哈希）；
- 图形化设置面板；
- 一键隐藏（全局快捷键彻底销毁托盘 + 所有窗口）；
- 全局快捷键自定义；
- 多服务器 partition 隔离；
- OAuth 弹窗修复；
- 直播跨域 / 绿屏修复。

---

## ⬇️ 下载与安装

1. 打开 Release 页面：<https://github.com/zhouchunwei513-cyber/fnos-desktop/releases/latest>
2. 下载 `FNOS-Setup-1.10.5.exe`；
3. 双击运行，按向导安装。建议保持默认路径 `%LOCALAPPDATA%\Programs\FNOS`，无需管理员权限；
4. 首次启动输入 fnOS 服务器地址（IP / 域名 / FN ID 均可），在客户端内完成登录。

> 🔒 本程序不上传任何账号、密码、Cookie 或文件内容到第三方，所有数据使用 Windows DPAPI 加密保存在本机。详见仓库 `SECURITY.md`。

---

## 🐛 反馈渠道

- GitHub Issues：<https://github.com/zhouchunwei513-cyber/fnos-desktop/issues>
- 飞牛论坛本帖下回帖

如在使用中遇到问题，请尽量附上：Windows 版本、fnOS 版本、复现步骤、截图，方便定位修复。
