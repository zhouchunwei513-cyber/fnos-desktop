# FNOS 桌面客户端（内置 MPV 播放内核）

> Windows 桌面客户端 for [fnOS 飞牛私有云 / 飞牛影视](https://www.fnos.com/) —— 加入 **MPV 硬解播放内核**与**内置电视直播**，让 Chromium 播不动的片子「点开即看」。
>
> 独立窗口、多服务器登录态、系统托盘、启动密码、一键锁定 / 隐藏、玻璃质感界面，并在视频位置无缝嵌入 MPV。

![version](https://img.shields.io/badge/version-1.27.1-blue)
![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011%20x64-success)
![electron](https://img.shields.io/badge/Electron-22-47848F?logo=electron&logoColor=white)

> ⚠️ **第三方社区作品**：本客户端由社区爱好者开发，与飞牛 fnOS 官方无关。fnOS 商标、Logo 版权归原权利人所有。

---

## ✨ 功能特性

### 🎬 MPV 播放内核（核心）
飞牛影视网页版用浏览器（Chromium）播放，遇到 **HEVC / H.265、10bit、4K 高码率、MKV 封装、杜比音轨、HLS / FLV 直播流** 等常卡顿、黑屏或提示「无法播放」。本客户端在视频区域**无缝嵌入 MPV 播放器**：

- **硬解优先**：`mpv + d3d11va + gpu-context=d3d11`，调用显卡硬件解码，4K / HEVC / 10bit 流畅不占 CPU；
- **点开即看**：点「用 MPV 打开」，MPV 无边框置顶窗精确覆盖网页视频位置，窗口缩放 / 拖动 / 最小化**实时联动**；
- **智能取流**：自动识别真实可播地址——飞牛影视电影 / 剧集（自动携带 Authx 签名与 Cookie）、IPTV 运营商直连 `m3u8`（移动 / 联通 / 电信 HLS，含 IPv6）、网页转码网关流（`/wp/`）；
- **干扰过滤**：自动排除 `play/record`（播放记录上报）等业务接口，用「打分制」选出最可能是流的请求（`.m3u8` 最高分）；
- **断线自愈**：直播中断自动重连（最多 30 次、网络超时 120 秒）；**MPV 进程崩溃自动重启并续播**；
- **OSC 控制条**：进度 / 音量 / 音轨 / 字幕 / 全屏一应俱全；
- **不干扰原生**：能正常播放的视频仍走网页，需要时才用 MPV。

### 📺 内置电视直播（配合 XTE-IPTV）
- 客户端内置「电视直播」独立窗口；
- 直播频道 / 播放源由配套工具 **XTE-IPTV** 提供（见下文）；
- 直播同样走 MPV 硬解，换台即用、断线自动重连。

### 🖥️ 桌面客户端基础能力
- 🪟 **独立窗口运行**，不依赖浏览器；
- 🔐 **多服务器登录态独立保持**：家里 / 公司 / 朋友家 NAS 各自独立分区，一次登录长期有效；
- 🚀 支持 **IP / 域名（默认 5666）/ FN ID** 三种连接方式；
- 🪟 飞牛主页打开的每个应用**独立窗口、多任务互不干扰**；
- 📥 **系统托盘常驻**，关窗可后台运行；
- 🔒 **启动密码 + 一键锁定**（scrypt + salt）、**一键隐藏老板键**；
- ⌨️ 全局快捷键可自定义；🎨 深色玻璃质感界面。

---

## 📺 配合 XTE-IPTV 使用内置直播

| 组件 | 作用 |
|---|---|
| **XTE-IPTV**（配套工具） | 把 IPTV 订阅（运营商源 / 网络源）抓取、整理、转换，输出客户端可识别的频道与播放地址 |
| **FNOS 桌面客户端**（本项目） | 内置直播入口 + MPV 硬解播放，负责把频道流畅放出来 |

**步骤**：
1. 按 XTE-IPTV 说明配置好 IPTV 订阅，得到可用频道 / 播放源；
2. 启动本客户端，打开内置「电视直播」窗口；
3. 点任意频道 → 自动调 MPV 硬解播放；
4. 4K / HEVC 台用 MPV 硬解明显比浏览器流畅，断流自动重连。

> XTE-IPTV 的获取与配置见飞牛论坛发布帖：<https://club.fnnas.com/forum.php?mod=viewthread&tid=70920>

---

## 📦 下载

绿色便携版（免安装，单文件 `exe`，双击即用）：见本仓库 **[Releases](../../releases)** 的 `FNOS-<version>-portable.exe`。

> 系统要求：Windows 10 1809+ / Windows 11，x64，显卡支持 D3D11。首次运行会自解压到临时目录；如 SmartScreen 提示，选「更多信息 → 仍要运行」（未做商业签名）。

---

## 🚀 快速开始

1. 从 Releases 下载 `FNOS-<version>-portable.exe` 双击运行；
2. 登录页输入服务器地址（IP / 域名 / FN ID），完成飞牛账号登录；
3. 打开飞牛影视，遇到播不动的片子，点「**用 MPV 打开**」；
4. MPV 自动贴合视频位置硬解播放，缩放 / 拖动窗口实时跟随；
5. 看直播：打开内置「电视直播」，选频道即可（需先配置 XTE-IPTV）。

---

## ⌨️ 快捷键

| 功能 | 默认快捷键 | 可自定义 |
|---|---|---|
| 一键锁定 | `Ctrl + Alt + L` | ✅ |
| 一键隐藏 / 呼出 | `Ctrl + Alt + H` | ✅ |
| 返回 FNOS 主页 | `Alt + H` | — |
| 切换服务器 | `Ctrl + Shift + L` | — |
| 返回 / 前进 | `Alt + ←` / `Alt + →` | — |
| 刷新 / 强制刷新 | `F5` / `Ctrl + F5` | — |
| 全屏切换 | `F11`（`Esc` 退出） | — |

---

## 🔒 安全说明

- 登录信息用 Electron `safeStorage`（Windows DPAPI）加密，绑定本机当前用户；
- 启动密码用 **scrypt + 随机 salt + `timingSafeEqual`** 哈希校验，明文不落盘；
- 多服务器用独立 `persist:nas-*` session 分区，登录态互相隔离；
- MPV 只在播放飞牛影视时携带 NAS 鉴权；跨域运营商直播源**不带任何 NAS 凭据**。

**忘记启动密码**：退出 FNOS，删除 `%APPDATA%\FNOS\settings.json` 后重启重设。

---

## 🛠️ 从源码构建

### 环境要求
- Node.js 18+（推荐 20）、pnpm 9+、Windows 10/11 x64

```bash
# 1. 安装依赖
pnpm install

# 2. 准备内置 mpv（本地构建才需要；CI 自动完成）
#    下载 mpv Windows x86_64 构建，解压出 mpv.exe（及 d3dcompiler_43.dll）放到项目根目录 mpv/：
#    https://sourceforge.net/projects/mpv-player-windows/files/64bit/

# 3. 开发运行
pnpm start

# 4. 打包便携版（产物 dist/FNOS-<version>-portable.exe）
pnpm dist
```

> **为什么 mpv.exe 不在仓库里？** 它约 120MB，超过 GitHub 单文件 100MB 限制，故不入库；GitHub Actions 构建时自动下载官方 mpv 并打包。

### 自动构建发布（GitHub Actions）
给仓库打 `v*` 标签（如 `v1.27.1`）并 push，Actions 会自动：安装依赖 → 下载官方 mpv → electron-builder 打包 → 发布到该 tag 的 **Release** 附件。也可在 **Actions → Build & Release → Run workflow** 手动触发。

---

## 📁 项目结构

```
├── main.js               # 主进程：窗口/托盘/IPC/加密/MPV 嵌入联动/直播窗口
├── mpv-player.js         # MPV 子进程封装：启动参数、取流、崩溃自愈、重连、几何
├── mpv-surface.js        # MPV 无边框置顶窗：DIP 几何、跟随父窗口移动/缩放
├── preload.js            # 飞牛网页注入：菜单「用MPV打开」、智能取流、视频坐标上报
├── live-preload.js / live.html        # 内置电视直播窗口
├── login.* / lock.* / settings.*      # 登录/锁屏/隐私设置（玻璃风格）
├── vendor/hls.min.js     # HLS 播放库
├── mpv/                  # 【构建时生成，不入库】mpv.exe + d3dcompiler_43.dll
└── package.json
```

---

## 🧱 技术栈

- [Electron 22](https://www.electronjs.org/) + [electron-builder 24](https://www.electron.build/)（portable x64）
- [mpv](https://mpv.io/)（GPL）+ `d3d11va` 硬件解码
- 原生 HTML / CSS / JavaScript（无框架、无打包步骤）
- Chromium `persist:` partition 多服务器登录态；`crypto.scrypt` + `safeStorage`
- 智能流识别：Performance Resource Timing 扫描 + 播放代理正则 + 清单打分

---

## 📝 更新日志

### v1.27.1
- 修复 MPV 窗口与飞牛窗口不对齐：几何全程按屏幕 DIP 逻辑坐标，实测 webview 边界
- 修复直播缩放 / 拖动不联动：500ms 轮询 + 父窗口 move/resize/minimize/restore 监听
- 修复「播一会停止、点播放按钮无效」：MPV 崩溃自动重启续播；直播重连 8→30；网络超时 120s

### v1.27.0
- 修复直播 MPV 黑屏：排除 `play/record` 上报接口误判；清单打分制精准锁定真实 m3u8
- 新增 Performance Resource Timing 资源扫描，跨域运营商直连源也能识别

---

## 📄 License

- 本项目**自有代码**采用 [MIT](./LICENSE)；
- 内置 **mpv 播放器遵循 GPLv2+**（<https://mpv.io>），本程序仅以启动外部进程方式调用、不修改 mpv 本身；
- Electron、ffmpeg（随 mpv）等第三方组件版权归各自权利人。

---

## ⚠️ 免责声明

本项目为社区爱好者开发的**第三方**客户端，与飞牛 fnOS 官方无关。fnOS 商标、Logo 版权归原权利人所有。
电视直播依赖你自行合法获取的 IPTV 订阅与配套 XTE-IPTV 工具，请遵守当地法律法规与版权要求。
使用本软件产生的任何数据损失或风险由使用者自行承担。
