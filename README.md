# FNOS Desktop Client

> Windows 桌面客户端 for [fnOS 飞牛私有云](https://fnos.net/) — 独立窗口运行、多服务器登录态保持、内置 MPV 播放内核、系统托盘、启动密码、一键锁定 / 隐藏、玻璃质感界面。

![version](https://img.shields.io/badge/version-4.0.4-blue)
![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-success)
![license](https://img.shields.io/badge/license-MIT-lightgrey)
![electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)

---

## ✨ 功能特性

- 🖥️ **独立窗口运行** — 不依赖浏览器，像原生软件一样使用 fnOS
- 🔐 **多服务器登录态独立保持** — 家里、公司、朋友家的 NAS 各自独立分区，一次登录长期有效
- 🚀 **FN ID 直连** — 支持 IP、域名（默认端口 5666）和 FN ID 三种连接方式
- 🪟 **多窗口多任务** — 飞牛主页打开的每个应用独立窗口，互不干扰
- 📥 **内置下载中心** — 进度 / 暂停 / 续传 / 取消，独立下载窗口
- 🎬 **内置 MPV 播放内核** — 随包分发 `mpv.exe`（HEVC 10bit / 4K / HLS / FLV / RTSP 全解码），网页里解不了的片子一键用 MPV 打开，自动带登录 Cookie / UA / Referer
- 📺 **电视直播** — 内置 hls.js 播放器，线路探测、频道收藏、EPG、回看、录制
- 🧩 **应用快捷方式** — 桌面快捷方式直达飞牛应用，程序内启动复用主窗口
- 🎨 **玻璃质感界面** — 登录页、弹窗、锁屏、设置页统一视觉；标题栏支持纯色 / 磨砂 / 透明界面与圆角
- 🖼️ **.fskin 皮肤包** — 背景图 / GIF / MP4、牛角、标题栏高度可换
- 📥 **系统托盘常驻** — 关闭窗口可隐藏到托盘后台运行
- 🔒 **启动密码 + 一键锁定** — scrypt + salt 哈希，锁屏需密码恢复；支持无操作自动锁定
- 👻 **一键隐藏（老板键）** — 连托盘图标一起隐藏，快捷键随时呼出
- ⌨️ **全局快捷键** — 锁定 / 隐藏均可自定义
- 🔄 **检查更新** — 帮助 / 关于页直连 GitHub Releases 比对版本，手动下载安装包
- 🧯 **GPU 兼容模式** — 绿屏 / 花屏机器可一键切软件渲染

> v4.0.0 起本项目仅发布 Windows 版本，macOS 源码与工作流已从仓库移除。

---

## 📦 下载

最新版本 **v4.0.4**（[发布页](https://github.com/zhouchunwei513-cyber/fnos-desktop/releases/latest)）：

- **安装版**（推荐）：`FNOS-4.0.4-setup.exe`（约 140 MB，Win10 1809+ / Win11 x64，含内置 MPV）

> 安装到当前用户目录，**无需管理员权限**，默认创建桌面和开始菜单快捷方式。

---

## 🚀 快速开始

### 连接 fnOS

1. 双击桌面 **FNOS** 图标启动。
2. 在登录页输入以下任意一种：

| 地址类型 | 示例 |
|---|---|
| 局域网 IP | `192.168.1.100` |
| 自定义端口 IP | `192.168.1.100:8000` |
| 域名 | `nas.example.com` |
| 完整 URL | `https://nas.example.com` |
| FN ID | `abc123` / `fn-abc123` |
| FN ID 链接 | `fnos.net/abc123` |

3. 点击登录，跳转到 fnOS 账号登录页完成登录。
4. 登录信息会通过 Windows DPAPI（Electron `safeStorage`）加密保存，下次启动自动连接。

---

## ⌨️ 快捷键

| 功能 | 默认快捷键 | 可自定义 |
|---|---|---|
| 一键锁定 | `Ctrl + Alt + L` | ✅ |
| 一键隐藏 / 呼出 | `Ctrl + Alt + H` | ✅ |
| 返回 FNOS 主页 | `Alt + H` | — |
| 切换服务器 | `Ctrl + Shift + L` | — |
| 返回上一页 / 前进 | `Alt + ←` / `Alt + →` | — |
| 刷新 / 强制刷新 | `F5` / `Ctrl + F5` | — |
| 全屏切换 | `F11`（`Esc` 退出） | — |

自定义方式：菜单 **文件 → 隐私设置…** → 快捷键区域，按下组合键录制并保存。

---

## 🔒 安全说明

- 历史记录与登录信息使用 Electron `safeStorage`（Windows DPAPI）加密，绑定当前 Windows 用户账户。
- 启动密码使用 **scrypt + 随机 salt + `timingSafeEqual`** 哈希校验，明文永不落盘。
- 每个服务器使用独立的 `persist:` session 分区，登录态相互隔离。
- 检查更新只请求 GitHub Releases API，不携带任何身份凭据，不自动下载安装包。

**忘记启动密码**：退出 FNOS，删除 `%APPDATA%\FNOS\settings.json`，重新启动后重新设置（历史列表会清空，但 Cookie 登录态保留）。

---

## 🛠️ 构建

安装包由 GitHub Actions 在云端 Windows runner 构建，**推送 `v*` tag 即自动构建并发布到 Releases**。

### 云端构建（推荐）

```bash
git tag v4.0.4
git push origin v4.0.4
```

`.github/workflows/build.yml` 流程：`npm ci` → JS 语法自检 → 下载 `mpv-runtime` 运行时 → `electron-builder` 打 NSIS →
校验 `mpv.exe` 已打包 + 安装包体积 → `gh release upload`（4 次重试 + 回读自证）。

也可在 Actions 页面手动 `Run workflow`（可填自定义 mpv 直链）。

### 本地构建

环境要求：Node.js 20+、Windows 10 / 11。

```bash
# 1. 安装依赖
npm ci

# 2. 准备 MPV 运行时（CI 会自动下载，本地需手工放到 mpv/）
#    mpv/mpv.exe + mpv/d3dcompiler_43.dll

# 3. 开发模式运行
npm start

# 4. 打包（NSIS 安装包）
npm run dist
```

产物位于 `dist/FNOS-4.0.4-setup.exe`。

> `compression` 保持 `normal`：`maximum` 压缩大体积 MPV 时会导致 NSIS 7z 归档失败。

---

## 📁 项目结构

```
.
├── main.js                  # 主进程：窗口 / 托盘 / IPC / 加密存储 / 全局快捷键 / 更新检查
├── preload.js               # 主窗口 preload（window.fnos）
├── titlebar-inject.js       # 飞牛页面内标题栏注入（磨砂 / 拖拽 / 菜单）
├── titlebar-frost.js        # 磨砂采样（事件驱动 + debounce）
├── menu-popup.html/.js      # 玻璃风格标题栏菜单（窗口常驻复用）
├── login.html/.css/.js      # 服务器登录页
├── lock.* / dialog.* / settings.* / download.* / live.*   # 锁屏 / 弹窗 / 设置 / 下载 / 直播
├── about.html / help.html / update-progress.html          # 关于 / 帮助 / 更新进度
├── mpv-player.js / mpv-surface.js / mpv-helper.js         # MPV 内核集成
├── shell.* / subapp-preload.js                            # 应用外壳页与子应用 preload
├── logger.js                # 日志
├── assets/ extensions/ vendor/ mpv-config/                # 静态资源 / 扩展 / hls.js / MPV 配置
├── build/                   # 图标与 NSIS 脚本
├── docs/forum/              # 历史版本发布公告
└── .github/workflows/       # Windows 构建与发布
```

---

## 🧱 技术栈

- [Electron 44](https://www.electronjs.org/) + [electron-builder 26](https://www.electron.build/)
- 原生 HTML / CSS / JavaScript（无框架、无构建步骤）
- Chromium `persist:` partition 多服务器登录态
- 内置 MPV（`child_process.spawn`，`--http-header-fields` 注入登录态）
- hls.js（内置直播播放器）
- `crypto.scrypt` 密码哈希 + Electron `safeStorage` 凭据加密

---

## 📝 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。完整历史见 [Releases](../../releases)。

### v4.0.4（当前）

- **修复最上排图标点不动、按住却拖走窗口**：标题栏不再注册系统级 `-webkit-app-region: drag`
  （系统拖动区会吞掉 mousedown，DOM 收不到事件），拖动只走自定义通道，系统拖动区仅保留顶部 6px 热区
- 新增命中诊断日志 `tb.hit`（顶部 150px 内按下记录命中链与标题栏几何）、
  `ctl.minimize/maximize/close`、`drag.legacy`

### v4.0.3

- **拖动严格限制在标题栏内**：修复 v4.0.2 回归 —— 内容区点击会变成拖动、应用图标点不动
  - `mouseup` 不再享受宽限，按下状态不会被残留到下一次点击
  - 只有标题栏来源的按下才会发起拖动；标题栏外按下会立即清掉残留状态
  - 主进程自愈启动必须以标题栏 `arm` 为前提
- 保留 v4.0.2 的「第一次就能拖」

### v4.0.2

- **修复第一次拖动失败**：点标题栏拖动时首帧 `buttons=0` 噪声把整次拖动作废，现已加按下宽限 + 主进程自愈启动
- 新增拖动链路日志（`drag.arm` / `drag.start.heal` / `drag.start.dup`），便于定位

### v4.0.1

- **修复菜单错乱**：点 ☰ 后面板被压成 150×260、菜单项文字溢出、桌面图标透过面板
  - 面板宽度改由内容决定（`width: max-content`），测量不再读会被视口夹住的 `offsetWidth`
  - 布局与字体稳定后补量一次，主进程对可疑尺寸回退到上次正确尺寸并要求重测
  - 菜单背景不透明度下限锁 0.9，不再跟随「透明界面」滑块降到 0.38
- 新增菜单测量自证日志（`menu.custom.measure` / `menu.custom.size.suspect`）

### v4.0.0

- 版本号全线统一到 `4.0.0`（主进程 / package.json / lock）
- 仓库大扫除：移除 100+ 个本地临时脚本与调试文本，历史公告归档到 `docs/forum/`
- CI 加固：构建前 `node --check` 语法自检，构建后校验 `mpv.exe` 与安装包体积，拒绝空包发布
- 仓库定位收敛为 Windows 单平台，运行时行为与 3.0.82 一致（除版本号）

### 3.0.x

- 磨砂标题栏拖动跟手性优化（按下即武装拖动、拖动期挂起采样、最大化还原校验）
- 标题栏菜单窗口常驻复用，减少反复创建
- 菜单背景透明度跟随「透明界面」滑块
- 更早历史见 [Releases](../../releases)

---

## 📄 License

[MIT](./LICENSE)

---

## ⚠️ 免责声明

本项目为社区爱好者开发的第三方客户端，**与飞牛 fnOS 官方无关**。
fnOS 相关商标、Logo 版权归原权利人所有。使用本软件产生的任何数据
损失或风险由使用者自行承担。
