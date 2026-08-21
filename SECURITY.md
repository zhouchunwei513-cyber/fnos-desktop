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

- Electron 30（Chromium + Node.js）
- 所有 npm 依赖都在 `package.json` 中列明，使用 pnpm 锁定版本（`pnpm-lock.yaml`）
- 不包含任何闭源二进制或来源不明的脚本

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

## 免责声明

本项目为第三方社区作品，与飞牛（fnOS）官方没有隶属关系。"fnOS"及相关商标归其权利人所有。使用本软件产生的一切后果由使用者自行承担。
