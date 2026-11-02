# FNOS 桌面客户端 · macOS

飞牛 fnOS 的 macOS 桌面客户端。与 Windows 版**同版本号、同一 Release 并列发布**（当前 `v3.0.81`）。

- Windows：`FNOS-Setup-<version>.exe`
- macOS：`FNOS-<version>-mac-arm64.dmg` / `FNOS-<version>-mac-x64.dmg`（另有 zip 免挂载版）

## 安装

1. 按芯片下载：Apple Silicon 选 `arm64`，Intel 选 `x64`。
2. 打开 dmg，把 **FNOS** 拖进「应用程序」。
3. 首次打开若提示「已损坏，无法打开」，说明隔离属性未清除（本版为免签名分发），执行一次：

```bash
xattr -dr com.apple.quarantine /Applications/FNOS.app
```

之后正常双击即可。

## 架构

```
src/main/            主进程（Node + Electron）
  index.js           生命周期、单实例、参数唤起、会话与扩展、全局快捷键
  prefs.js           设置持久化（与 Windows 版 settings 结构同构）
  win.js             各窗口创建与主题广播（主窗 hiddenInset / 其余标准标题栏）
  nav.js             地址规范化、导航白名单、URL 重写、应用 id 提取
  menu.js            macOS 原生菜单栏 + 托盘 + 右键菜单
  skin.js            .fskin 皮肤包安装/列表/删除/当前皮肤
  shortcut.js        桌面与应用快捷方式（手写最小 .app bundle，无第三方依赖）
  ipc-*.js           IPC 域：auth / settings / shell / app / download / iptv / lock
  mpv-surface.js     视频渲染面（与 Windows 版同源）
  mpv-player.js      MPV 播放器集成（macOS 下自动探测本机 mpv）
  ipc-iptv.js        直播（XTE 基址探测、M3U 解析、XMLTV EPG、回看、TS 录制）
src/renderer/        渲染层：外壳页 + 设置/关于/帮助/下载/锁屏/直播/播放器等
src/renderer/preload.js  注入到 NAS 页面，暴露 window.fnos / fnApi
extensions/          knas-media 播放桥接扩展
```

主窗是 `titleBarStyle: 'hiddenInset'` 的原生窗口：红黄绿交通灯由系统绘制，工具栏由外壳页面自绘并声明 `-webkit-app-region: drag`，**不做整窗 setPosition 轮询**，也不向 NAS 远端页面注入任何标题栏。其余窗口（设置、关于、帮助、下载、直播、播放器、锁屏等）使用系统标准标题栏。

## 与 Windows 版的功能对应

| 能力 | macOS 实现 |
| --- | --- |
| 连接/切换 NAS、连接历史、多账号 | 保留（`persist:connect` 会话，cookie 与登录态复用） |
| 内置应用窗、应用列表、桌面快捷方式 | 保留（快捷方式是手写 `.app` bundle，双击唤起客户端并打开目标地址） |
| 下载中心（进度/暂停/续传/取消） | 保留（Electron DownloadItem，进度窗与 Windows 一致） |
| 电视直播：线路探测、频道、收藏、EPG、回看、录制 | 保留（hls.js 主链路；XTE 基址自动探测） |
| 播放器内嵌播放 | 保留（hls.js）；MPV 需本机已安装 `mpv`，未安装时自动回退 hls.js |
| VLC 外挂播放 | 需本机安装 VLC.app，未安装则回退内置播放器 |
| .fskin 皮肤包（背景图/GIF/MP4、牛角、标题栏高度） | 保留（作用在外壳工具栏） |
| 启动密码、无操作自动锁定、锁屏页 | 保留（scrypt 加盐散列；锁屏覆盖全屏窗口） |
| 标题栏材质：纯色/磨砂、透明度、圆角、分隔线 | 保留（磨砂走 macOS vibrancy） |
| 全局快捷键（锁定 / 隐藏全部） | 保留，`Ctrl` 自动映射为 `⌘`（`Command+Alt+L` / `Command+Alt+H`） |
| 应用菜单、托盘菜单、右键菜单 | 原生菜单栏 + 菜单栏图标 + 原生 `Menu.popup` |
| 日志（查看/导出） | 保留（`~/Library/Logs/FNOS/`） |
| 自动更新 | **改为检查 + 引导下载**：免签名包无法 Squirrel.Mac 静默更新 |

## 已知限制（均为 macOS 平台约束，非功能裁剪）

- **未签名/未公证**：首次启动需清除 quarantine（见上），无法静默自更新。
- **MPV 内置播放**：Windows 版会随包分发 `mpv.exe`；macOS 版不随包分发二进制，需 `brew install mpv`（或改设置里的 mpv 路径）。未安装时直播与点播使用 hls.js / 系统播放器，界面不报错。
- **圆角/标题栏高度**：窗口圆角由系统绘制，`窗角圆角` 选项在 macOS 上不生效（数值仍保存，跨平台同步不丢）。
- **`Ctrl+Alt+*` 默认值**：注册时映射为 `Command+Alt+*`，设置页仍显示原始字符串。

## 开发

```bash
cd mac
npm install
npm start          # 本机调试
npm run dist       # 构建 arm64 + x64 的 dmg/zip
```

需要 Node ≥ 20。构建机为 macOS（`macos-14`），`CSC_IDENTITY_AUTO_DISCOVERY=false` 免签名。

## 发布

推 `v*` tag 会同时触发 Windows 与 macOS 两个 workflow，两边都把产物追加到**同一个** Release：

```bash
git tag v3.0.81 && git push origin v3.0.81
```

也可在 Actions 页手动 Run workflow 并指定 `tag`（用于给已存在的 Release 补 macOS 产物）。
