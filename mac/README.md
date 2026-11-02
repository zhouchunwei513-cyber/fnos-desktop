# FNOS for macOS

飞牛（fnOS）NAS 桌面客户端 —— **macOS 原生规范版**。

本目录是一套**独立重写**的实现（Electron + 原生 macOS 交互规范），与仓库根目录的 Windows 版工程完全隔离：
不共享入口文件、不复用历史 mac 分支代码、不依赖 Windows 专属模块。两边各自打包、各自发版。

- 版本：`1.0.0`
- 目标系统：macOS 11 Big Sur 及以上（arm64 / x64 双架构）
- 运行时：Electron 44.4.3

---

## 1. 为什么是"重写"而不是移植

Windows 版的实现大量依赖 Win32 行为，这些在 macOS 上要么不存在、要么有害：

| Windows 版机制 | 用途 | macOS 处理 |
| --- | --- | --- |
| `desktopCapturer` 抓屏 + CSS 平移做磨砂 | 标题栏毛玻璃 | **删除**。改用系统材质 `vibrancy`（NSVisualEffectView），零 CPU 开销、原生模糊 |
| 自绘标题栏 + 自绘拖动（`mouse_event` / `setPosition` 循环） | 无边框窗口拖动 | **删除**。改 `-webkit-app-region: drag`，拖动由窗口服务器处理 |
| 自绘 ☰ 下拉菜单（`menu-popup.html`） | 应用菜单 | 改用**原生菜单栏**（`Menu.buildFromTemplate`）+ 托盘 `Menu` |
| 手写圆角/阴影/边框抑制（DWM） | 视觉 | **删除**。窗口阴影、圆角、聚焦态全部交给系统 |
| `pngToIco` + WIC 图标转换 | 图标 | 直接用 1024×1024 PNG，electron-builder 生成 `.icns` |
| 注册表写 `Run` 键自启 | 开机自启 | `app.setLoginItemSettings`（登录项） |
| Wscript `.lnk` 桌面快捷方式 | 快捷方式 | 由 dmg 内的 `/Applications` 链接完成安装 |
| NSIS 安装包 | 分发 | dmg + zip（拖入"应用程序"） |
| MPV / IPTV 播放器（Win 二进制） | 视频直播 | 仓库内没有 macOS 版播放器二进制，接口保留、第一阶段不启用（见 §7） |

---

## 2. 目录结构

```
mac/
├── package.json                  # 独立工程（name: fnos-mac）
├── build/
│   ├── icon.png                  # 1024×1024，electron-builder 自动转 icns
│   └── entitlements.mac.plist    # hardened runtime 权限声明
├── assets/
│   ├── fnos-logo.png             # 界面 logo（连接页 / 关于）
│   └── trayTemplate.png          # 可选：菜单栏 template 图标（缺省由 logo 缩放生成）
└── src/
    ├── main/
    │   ├── index.js              # 生命周期、单实例、证书策略、自启、Dock
    │   ├── windows.js            # 主窗 / 偏好设置窗、vibrancy、webview 策略
    │   ├── menu.js               # 原生菜单栏（App / 文件 / 编辑 / 显示 / 前往 / 窗口 / 帮助）
    │   ├── tray.js               # 菜单栏状态项（template 图）
    │   ├── ipc.js                # 37 个 IPC 通道（settings / server / nav / zoom / log / update / app）
    │   ├── store.js              # settings.json 原子读写 + 默认值归一化
    │   ├── nav.js                # 地址规范化、HTTPS 探测、导航白名单
    │   ├── updater.js            # 检查更新（GitHub Releases，mac-v* tag）
    │   └── logger.js             # ~/Library/Logs/FNOS 按天切割、保留 7 天
    ├── preload/
    │   ├── app-preload.js        # 壳页能力白名单（window.fnos）
    │   └── settings-preload.js   # 偏好设置窗能力白名单（window.fnosSettings）
    └── renderer/
        ├── shell.html/.css/.js   # 主窗：工具栏 + webview + 连接页 + 查找条 + 错误页
        └── settings.html/.css/.js# 偏好设置：外观 / 通用 / 服务器 / 更新 / 日志 / 关于
```

---

## 3. macOS 规范落点

| 规范 | 实现 |
| --- | --- |
| 窗口外观 | `titleBarStyle: 'hiddenInset'`，红绿灯内嵌工具栏，位置 `trafficLightPosition {x:18,y:19}`；圆角与阴影交给系统 |
| 材质 | `vibrancy: 'under-window' \| 'content' \| 'sidebar' \| 'fullscreen-ui'` + `visualEffectState: 'active'`；可切"纯色"关闭材质 |
| 拖动 | 工具栏 `-webkit-app-region: drag`，按钮 `no-drag`；不做任何自绘拖动 |
| 菜单栏 | 原生 `Menu`；应用菜单含 关于 / 检查更新 / 偏好设置 ⌘, / 服务 / 隐藏 / 退出；编辑与窗口菜单使用系统 `role` |
| 应用生命周期 | `window-all-closed` **不退出**；`activate` 恢复窗口；关闭窗口默认隐藏，⌘Q 才退出 |
| 偏好设置 | 独立窗口（不 modal），⌘, 打开；关闭即销毁；左侧栏 + 分组表单（macOS Ventura 风格） |
| 关于 | `app.setAboutPanelOptions` + `app.showAboutPanel()`，使用系统标准面板 |
| 状态栏 | `Tray` + template 图（自动适配浅色/深色菜单栏） |
| 自启 | `app.setLoginItemSettings({ openAtLogin, openAsHidden })` |
| 外观跟随 | `nativeTheme.themeSource = 'system' \| 'light' \| 'dark'`，并监听 `prefers-color-scheme` |
| 快捷键 | 全部用 `Command` 系；菜单项即快捷键入口，不与系统冲突（不注册默认全局热键） |
| 剪贴板/选择 | 表单内 `user-select: text`，其余 `none`；右键菜单交给系统 |
| 文件对话框 | `dialog.showSaveDialog`（日志导出），走沙盒化系统面板 |
| 沙盒与权限 | `contextIsolation: true`、`nodeIntegration: false`、preload 白名单；hardened runtime + entitlements |
| 证书 | 自签名 NAS：仅对**已保存过的服务器主机**放行 `certificate-error`，其余一律拒绝 |
| 日志 | `~/Library/Logs/FNOS/fnos-YYYY-MM-DD.log`（`app.setAppLogsPath()`） |

---

## 4. 功能对照表（Windows 版 → macOS 版）

| 功能 | Windows 版 | macOS 版 | 说明 |
| --- | --- | --- | --- |
| 连接 NAS / 多服务器切换 | ✅ | ✅ | 地址规范化、`server:test` 探活、最近使用列表 |
| 自签名证书放行 | ✅ | ✅ | 仅放行已保存主机 |
| 免登录态复用 | ✅ | ✅ | `partition: persist:fnos` 持久会话 |
| 主窗口 webview 承载 | ✅ | ✅ | 工具栏 + webview（`persist:fnos`） |
| 后退/前进/重载/主页 | ✅ | ✅ | 工具栏 + 菜单 + ⌘[ ⌘] ⌘R ⇧⌘H |
| 页面内查找 | ✅ | ✅ | ⌘F 查找条（`findInPage` + 命中计数） |
| 页面缩放 | ✅ | ✅ | ⌘= / ⌘- / ⌘0，持久化 |
| 全屏 | ✅ | ✅ | ⌃⌘F（系统 role）+ 工具栏自动让位 |
| 工具栏显示/隐藏 | ✅ | ✅ | ⌥⌘T |
| 磨砂 / 纯色外观 | ✅（抓屏方案） | ✅（系统 vibrancy） | macOS 用原生材质，无抓屏开销 |
| 界面透明度 | ✅ | ✅ | 0–100 滑块，实时作用于工具栏/查找条/设置窗 |
| 工具栏高度 | ✅ | ✅ | 40–96pt 可调 |
| 浅色/深色/跟随系统 | ✅ | ✅ | `nativeTheme` |
| 托盘（状态栏） | ✅ | ✅ | 显示窗口 / 偏好设置 / 服务器切换 / 检查更新 / 退出 |
| 关闭窗口最小化到托盘 | ✅ | ✅ | `hideOnClose`（macOS 惯例：隐藏而非退出） |
| 开机自启 | ✅（注册表） | ✅（登录项） | 可隐藏启动 |
| 全局快捷键唤出 | ✅ | ✅（可选，默认关） | 形如 `Command+Shift+F` |
| 恢复上次页面/窗口位置 | ✅ | ✅ | `window` + `lastUrl` |
| 检查更新 | ✅ | ✅（检查 + 引导下载） | macOS 免签名无法静默安装，见 §6 |
| 日志查看/导出 | ✅ | ✅ | 偏好设置 → 日志，按天切割 + 导出 |
| 诊断信息复制 | ✅ | ✅ | 帮助菜单 / 关于页 |
| 关于面板 | ✅（自绘） | ✅（系统面板） | `showAboutPanel` |
| 单实例 | ✅ | ✅ | `requestSingleInstanceLock` + `second-instance` → 显示窗口 |
| 桌面快捷方式 | ✅（.lnk） | ➖ | 由 dmg 内的"应用程序"链接替代 |
| 标题栏皮肤包（.fskin） | ✅ | ➖ | 与自绘标题栏强绑定；macOS 用系统材质与原生菜单，皮肤体系不适用 |
| MPV 播放器 / IPTV 直播 | ✅ | ⏸ | 缺 macOS 播放器二进制，接口保留、第一阶段禁用 |

---

## 5. 本地开发与打包

```bash
cd mac
npm install

npm start            # 开发运行
npm run dev          # 带 --dev
npm run dist:arm64   # 只出 arm64（Apple Silicon）
npm run dist:x64     # 只出 x64（Intel）
npm run dist         # 双架构 dmg + zip
```

产物在 `mac/dist/`：

```
FNOS-mac-1.0.0-arm64.dmg
FNOS-mac-1.0.0-arm64-mac.zip
FNOS-mac-1.0.0-x64.dmg
FNOS-mac-1.0.0-x64-mac.zip
```

---

## 6. 分发与 Gatekeeper

本工程采用**免签名（ad-hoc）分发**：`mac.identity = null` + CI 中 `CSC_IDENTITY_AUTO_DISCOVERY=false`。
不签名就无法走 Squirrel.Mac 静默更新，因此"检查更新"是**检查 + 引导下载**。

用户首次打开：

1. 下载对应架构的 `dmg`；
2. 打开 dmg，把 `FNOS` 拖进"应用程序"；
3. 首次启动若提示 *"FNOS 已损坏，无法打开"*，在"终端"执行一次：

```bash
xattr -dr com.apple.quarantine /Applications/FNOS.app
```

或：系统设置 → 隐私与安全性 → 仍要打开。

> 若日后拿到 Apple Developer ID 与公证凭据，把 `mac.identity`、`CSC_LINK`、`CSC_KEY_PASSWORD`、`notarytool` 配置接上即可恢复"下载即开"体验。

---

## 7. 已知限制

- **MPV / IPTV 未启用**：仓库只内置 Windows 版播放器运行时（`mpv/mpv.exe` 等）。macOS 需要 `mpv.app`（arm64 / x64）与 `--wid` 嵌入支持，第一阶段不打包。相关入口在 UI 中隐藏，接口保留以便后续接入。
- **标题栏皮肤（.fskin）不适用**：皮肤包依赖自绘标题栏与自定义拖动，macOS 下改用系统材质 + 原生菜单，故整套皮肤体系不迁移。
- **未签名**：见 §6，无法静默更新。
- **局域网权限**：macOS 15 起首次访问局域网设备会弹"本地网络"授权，已在 `NSLocalNetworkUsageDescription` 声明用途。

---

## 8. CI

`.github/workflows/mac-build.yml`：

- 触发：push tag `mac-v*`（如 `mac-v1.0.0`），或手动 `workflow_dispatch` 并填 tag；
- 运行于 `macos-14`；
- 先对全部源码跑 `node --check`；
- `electron-builder --mac --arm64 --x64` 出 dmg + zip；
- 上传 artifact，并用 `gh` 创建/更新 Release（4 次重试 + 资产回读校验）。

Windows 的 `build.yml` 只认 `v*` tag，`mac-v*` 不会触发 Windows 构建。

---

## 9. 数据目录

| 内容 | 路径 |
| --- | --- |
| 设置 | `~/Library/Application Support/FNOS/settings.json` |
| 日志 | `~/Library/Logs/FNOS/fnos-YYYY-MM-DD.log`（保留 7 天） |
| 会话/Cookie | `~/Library/Application Support/FNOS/Partitions/fnos` |

> 沙箱外运行（免签名 dmg）即为上述默认路径，无需额外授权。

---

## 10. 快捷键

| 快捷键 | 动作 |
| --- | --- |
| ⌘, | 偏好设置 |
| ⌘N | 连接新服务器 |
| ⇧⌘L | 回到上次页面 |
| ⌘R / ⇧⌘R | 重新载入 / 强制重新载入 |
| ⌘[ / ⌘] | 后退 / 前进 |
| ⇧⌘H | 主页 |
| ⇧⌘S | 切换服务器 |
| ⌘F | 页面内查找 |
| ⌘= / ⌘- / ⌘0 | 放大 / 缩小 / 实际大小 |
| ⌃⌘F | 全屏 |
| ⌥⌘T | 显示/隐藏工具栏 |
| ⌘1 / ⌘2 | 主窗口 / 偏好设置 |
| ⌘W | 关闭窗口（按设置隐藏或退出） |
| ⌘Q | 退出 FNOS |
