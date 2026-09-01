# FNOS 桌面客户端（内置 MPV 播放内核）

> Windows 桌面客户端 for [fnOS 飞牛私有云 / 飞牛影视](https://www.fnos.com/) —— 加入 **MPV 硬解播放内核**与**内置电视直播**，让 Chromium 播不动的片子「点开即看」。

![version](https://img.shields.io/badge/version-1.27.1-blue)
![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011%20x64-success)
![electron](https://img.shields.io/badge/Electron-22-47848F?logo=electron&logoColor=white)

> ⚠️ **第三方社区作品**：本客户端由社区爱好者开发，与飞牛 fnOS 官方无关。

## 📥 下载
见 [**Releases 下载页**](https://github.com/zhouchunwei513-cyber/fnos-desktop/releases)，下载 `FNOS-<version>-portable.exe`（绿色便携版，免安装）。

---

## ✨ 功能特性

### 🎬 MPV 播放内核（核心）
- **硬解优先**：`mpv + d3d11va + gpu-context=d3d11`，显卡硬解，4K / HEVC / 10bit 流畅不占 CPU；
- **点开即看**：点「用 MPV 打开」，MPV 无边框置顶窗精确覆盖网页视频，缩放 / 拖动 / 最小化**实时联动**；
- **智能取流**：自动识别飞牛影视电影接口（带 Authx 签名 + Cookie）、IPTV 运营商直连 `m3u8`（移动/联通/电信 HLS，含 IPv6）、网页转码网关流（`/wp/`）；
- **干扰过滤**：排除 `play/record` 上报等业务接口，打分制选出真实视频流（`.m3u8` 最高分）；
- **断线自愈**：直播自动重连（30 次、超时 120s）；**MPV 崩溃自动重启续播**；
- **OSC 控制条**：进度 / 音量 / 音轨 / 字幕 / 全屏；
- **不干扰原生**：能播的仍走网页，需要时才用 MPV。

### 📺 内置电视直播（配合 XTE-IPTV）
- 内置「电视直播」窗口，频道 / 播放源由配套工具 **XTE-IPTV** 提供；
- 直播同样走 MPV 硬解，换台即用、断线自动重连。

### 🖥️ 桌面能力
独立窗口运行、多服务器登录态独立保持（IP / 域名 / FN ID 三种连接）、多窗口多任务、系统托盘常驻、启动密码 + 一键锁定、一键隐藏老板键、全局快捷键自定义、深色玻璃质感界面。

---

## 📺 配合 XTE-IPTV 使用内置直播

| 组件 | 作用 |
|---|---|
| **XTE-IPTV**（配套工具） | 抓取 / 整理 / 转换 IPTV 订阅，输出频道与播放地址 |
| **FNOS 桌面客户端**（本项目） | 内置直播入口 + MPV 硬解播放 |

步骤：① 用 XTE-IPTV 配好 IPTV 订阅 → ② 打开客户端内置「电视直播」→ ③ 点频道自动 MPV 硬解播放。详见飞牛论坛发布帖：<https://club.fnnas.com/forum.php?mod=viewthread&tid=70920>

---

## 🚀 快速开始
1. 从 Releases 下载 `FNOS-<version>-portable.exe` 双击运行；
2. 登录页输入服务器地址（IP / 域名 / FN ID）并登录；
3. 飞牛影视里遇到播不动的片子，点「**用 MPV 打开**」；
4. MPV 自动贴合视频位置硬解播放；看直播打开内置「电视直播」即可。

> 系统要求：Windows 10 1809+ / Windows 11 x64，显卡支持 D3D11。SmartScreen 提示选「更多信息 → 仍要运行」（未做商业签名）。

## ⌨️ 快捷键
一键锁定 `Ctrl+Alt+L`、一键隐藏 `Ctrl+Alt+H`、返回主页 `Alt+H`、切换服务器 `Ctrl+Shift+L`、刷新 `F5`/`Ctrl+F5`、全屏 `F11`。

## 🔒 安全
登录信息用 Electron `safeStorage`（DPAPI）加密；启动密码 scrypt + salt 哈希；多服务器独立 session 分区；播跨域运营商直播源不带任何 NAS 凭据。忘密码：删除 `%APPDATA%\FNOS\settings.json` 重启。

---

## 🛠️ 从源码构建
环境：Node.js 18+、pnpm 9+、Windows 10/11 x64。

```bash
pnpm install
# 本地构建需先准备 mpv：下载 mpv-x86_64 构建解压出 mpv.exe（及 d3dcompiler_43.dll）放到项目根目录 mpv/
#   https://sourceforge.net/projects/mpv-player-windows/files/64bit/
pnpm start      # 开发运行
pnpm dist       # 打包便携版 -> dist/FNOS-<version>-portable.exe
```

> mpv.exe 约 120MB，超过 GitHub 单文件 100MB 限制，故不入库；GitHub Actions 构建时自动下载官方 mpv。

**自动构建发布**：push `v*` 标签（如 `v1.27.1`）即触发 Actions：装依赖 → 下载官方 mpv → electron-builder 打包 → 发布到该 tag 的 Release 附件。也可在 Actions 页手动 Run workflow。

## 📁 项目结构
`main.js`（主进程/MPV 嵌入联动/直播窗）、`mpv-player.js`（MPV 子进程/取流/崩溃自愈/重连）、`mpv-surface.js`（无边框置顶窗 DIP 几何/跟随）、`preload.js`（网页注入/智能取流/坐标上报）、`live.*`（内置直播）、`login/lock/settings.*`（登录锁屏设置）、`vendor/hls.min.js`、`mpv/`（构建时生成，不入库）。

## 🧱 技术栈
Electron 22 + electron-builder 24（portable x64）、mpv（GPL）+ d3d11va 硬解、原生 HTML/CSS/JS、Chromium persist 分区、scrypt + safeStorage、Performance Resource Timing 流扫描 + 清单打分。

## 📝 更新日志
- **v1.27.1**：修复 MPV 窗口不对齐（DIP 几何 + 实测 webview 边界）；直播缩放/拖动联动；MPV 崩溃自动重启续播，直播重连 8→30、超时 120s。
- **v1.27.0**：修复直播黑屏（排除 play/record 上报误判，打分制锁定真实 m3u8）；新增跨域运营商直连源资源扫描。

## 📄 License
自有代码 [MIT](./LICENSE)；内置 **mpv 遵循 GPLv2+**（<https://mpv.io>），仅以外部进程方式调用、不修改 mpv；Electron、ffmpeg 等第三方组件版权归各自权利人。

## ⚠️ 免责声明
社区第三方客户端，与飞牛 fnOS 官方无关，fnOS 商标/Logo 版权归原权利人。直播依赖你合法获取的 IPTV 订阅与 XTE-IPTV，请遵守当地法规与版权。使用风险自负。
