# FNOS Desktop Client

> Windows 桌面客户端 for [fnOS 飞牛私有云](https://fnos.net/) — 独立窗口运行、多服务器登录态保持、系统托盘、启动密码、一键锁定 / 隐藏、玻璃质感界面。

![version](https://img.shields.io/badge/version-1.9.0-blue)
![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-success)
![license](https://img.shields.io/badge/license-MIT-lightgrey)
![electron](https://img.shields.io/badge/Electron-30-47848F?logo=electron&logoColor=white)

---

## ✨ 功能特性

- 🖥️ **独立窗口运行** — 不依赖浏览器，像原生软件一样使用 fnOS
- 🔐 **多服务器登录态独立保持** — 家里、公司、朋友家的 NAS 各自独立分区，一次登录长期有效
- 🚀 **FN ID 直连** — 支持 IP、域名（默认端口 5666）和 FN ID 三种连接方式
- 🪟 **多窗口多任务** — 飞牛主页打开的每个应用独立窗口，互不干扰
- 📥 **系统托盘常驻** — 关闭窗口可隐藏到托盘后台运行
- 🔒 **启动密码 + 一键锁定** — scrypt + salt 哈希，锁屏需密码恢复
- 👻 **一键隐藏（老板键）** — 连托盘图标一起隐藏，快捷键随时呼出
- ⌨️ **全局快捷键** — 锁定 / 隐藏均可自定义
- 📋 **剪贴板粘贴** — 服务器地址支持直接粘贴 IP / 域名 / FN ID
- 🎨 **深色玻璃质感界面** — 登录页、弹窗、锁屏、设置页统一视觉风格

---

## 📦 下载

最新版本 **v1.9.0**：

- **安装版**（推荐）：`FNOS-Setup-1.9.0.exe`（约 80 MB，Win10 1809+ / Win11 x64）

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
4. 登录信息会通过 Windows DPAPI 加密保存，下次启动自动连接。

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
- 每个服务器使用独立的 `persist:nas-*` session 分区，登录态相互隔离。

**忘记启动密码**：退出 FNOS，删除 `%APPDATA%\FNOS\settings.json`，重新启动后重新设置（历史列表会清空，但 Cookie 登录态保留）。

---

## 🛠️ 从源码构建

### 环境要求

- Node.js 18+（推荐 20 / 24）
- pnpm 9+
- Windows 10 / 11（构建 Windows 安装包）

### 安装与运行

```bash
# 1. 安装依赖
pnpm install

# 2. 开发模式运行
pnpm start

# 3. 打包（出 win-unpacked 目录）
pnpm dist
```

### 生成 NSIS 安装版

`pnpm dist` 默认生成 portable 包。要生成带安装向导的安装版：

```bash
# 1. 先打出 unpacked
pnpm exec electron-builder --win --x64 --dir

# 2. 用 NSIS 编译安装包
bash build/build-installer.sh
```

> Linux / macOS 环境交叉编译 Windows 包时，`build-installer.sh` 会自动使用
> `~/.cache/electron-builder/nsis/nsis-*/linux/makensis`（由 electron-builder
> 下载），无需 wine。

产物位于 `dist/FNOS-Setup-<version>.exe`。

---

## 📁 项目结构

```
.
├── main.js                 # 主进程：窗口 / 托盘 / IPC / 加密存储 / 全局快捷键
├── preload.js              # 主窗口 preload（window.fnos）
├── login.html / .css / .js # 服务器登录页（玻璃风格 + 历史下拉）
├── dialog.html / .css / .js
│   └── dialog-preload.js   # 玻璃风格自定义弹窗
├── lock.html / .css / .js
│   └── lock-preload.js     # 锁屏页（启动密码解锁 / 修改）
├── settings.html / .css / .js
│   └── settings-preload.js # 隐私设置（启动密码 + 快捷键）
├── help.html               # 内置操作帮助页
├── icon.ico / icon.png     # 应用图标
├── assets/                 # 图片等静态资源
├── build/
│   ├── installer.nsi       # 自定义 NSIS 安装脚本
│   └── build-installer.sh  # 调用 makensis 编译安装包
├── build-icon.cjs           # sharp 生成 ico 图标脚本
└── package.json
```

---

## 🧱 技术栈

- [Electron 30](https://www.electronjs.org/)
- [electron-builder 24](https://www.electron.build/)
- 原生 HTML / CSS / JavaScript（无框架、无构建步骤）
- Chromium `persist:` partition 多服务器登录态
- `crypto.scrypt` 密码哈希 + Electron `safeStorage` 凭据加密

---

## 📝 更新日志

### v1.9.0
- 新增启动密码（scrypt + salt 哈希）
- 新增一键锁定 / 一键隐藏（含托盘）
- 新增隐私设置页与全局快捷键自定义
- 新增“编辑”菜单支持服务器地址粘贴
- 多服务器登录态独立保持、历史下拉直连
- 历史记录与登录信息 DPAPI 加密保存

### v1.8.x
- 修复对话框按钮无响应（独立 preload + contextBridge）
- 修复切换服务器登录态丢失（partition 持久化）
- 修复 FN ID / IP / 域名不跳转
- 统一玻璃风格视觉
- 安装包默认创建桌面与开始菜单快捷方式

完整历史见 [Releases](../../releases)。

---

## 📄 License

[MIT](./LICENSE)

---

## ⚠️ 免责声明

本项目为社区爱好者开发的第三方客户端，**与飞牛 fnOS 官方无关**。
fnOS 相关商标、Logo 版权归原权利人所有。使用本软件产生的任何数据
损失或风险由使用者自行承担。
