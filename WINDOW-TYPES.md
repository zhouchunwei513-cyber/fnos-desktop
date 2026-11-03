# 飞牛应用窗口类型（实测分类）

> 版本：v4.0.21　环境：`http://192.168.31.101:5666`（fnOS 桌面，账号 fnos）
> 方法：Playwright + Chrome 无头登录飞牛桌面，逐个点击 40 个桌面图标，记录
> ①是否新开标签页 ②桌面内是否新增 `.trim-ui__app-layout--window` ③该窗标题栏里
> 有没有 `#iframe-btns-*-refresh` / `#iframe-btns-*-newwindow` 这对按钮。
> 脚本：`tools/classify-windows.py`、`tools/probe-embed-btn.py`（本地工具链，`.gitignore` 的 `/tools/` 不入库）；
> 原始数据 `build-out/window-types-v4.json`（同样不入库）。需要重跑时按文末命令即可。

## 一、三类窗口

| # | 形态 | 标题栏 ↻ 刷新 / ↗ 新标签 | 谁画 | 我们做什么 |
|---|---|---|---|---|
| 1 | 内嵌窗 | **没有** | — | 零注入，不转独立窗 |
| 2 | 内嵌窗 | **有**（`刷新页面` / `新标签页打开`） | 飞牛自己挂在窗标题栏上 | 零注入，不转独立窗 |
| 3 | 独立跳出窗（新标签页） | **没有** | 我们的自绘标题栏 | ☰ + ↻ + ↗ + — □ ✕ |

判定口径（用户口径，与实测一致）：
点图标后**浏览器开了新标签页** = 类型 3；**没开新标签、桌面里出现窗口** = 类型 1/2，
再看该窗标题栏有没有那两个按钮。

## 二、机制（DOM 实测）

- 类型 2 的两个按钮不是我们加的，是飞牛自己渲染的：
  位置在 `.trim-ui__app-layout--header` 内 `.flex.items-center` 按钮组里，排在 `— □ ✕` **左边**，
  每个 46×44，`id="iframe-btns-<应用路径签名>-refresh"` / `-newwindow`，
  `title="刷新页面"` / `"新标签页打开"`。
- **只有窗内是 iframe 应用页时**才挂这对按钮；飞牛自己的 SPA 页（文件管理/系统设置/资源管理/
  日志/备份/下载/回收站/应用中心）和 Docker 都不挂 → 这才是类型 1 和 2 的真实分界。
  按钮是 iframe 页加载完成后才挂上的，所以打开瞬间看不到，要等 1～6 秒。
- 类型 3 是浏览器新标签页里的裸应用页，没有 `.trim-ui__app-layout--header`，也就没有 ↻/↗。

## 三、实测分类表（40 个桌面图标）

### 类型 1 · 内嵌窗，标题栏无 ↻/↗（9 个）

| 应用 | 窗内来源 |
|---|---|
| 文件管理 | 飞牛 SPA 内联 |
| 系统设置 | 飞牛 SPA 内联 |
| 资源管理 | 飞牛 SPA 内联 |
| 日志 | 飞牛 SPA 内联 |
| 备份 | 飞牛 SPA 内联 |
| 下载 | 飞牛 SPA 内联 |
| 回收站 | 飞牛 SPA 内联 |
| 应用中心 | 飞牛 SPA 内联 |
| Docker | `/apps/docker/`（iframe，但飞牛不给这对按钮） |

### 类型 2 · 内嵌窗，标题栏有 ↻/↗（20 个）

| 应用 | 窗内 iframe |
|---|---|
| Lucky | `/app/Lucky/` |
| 安全中心 | `/app/trim-security` |
| 文件快照 | `/snapshot?ver=0.0.1` |
| 百度网盘 | `/app-baidu-netdisk?ver=0.0.1` |
| NPC 客户端 | `/cgi/ThirdParty/npc/index.cgi` |
| iSCSI | `/iscsi/` |
| 日志推送 | `/app/FnMessageBot/` |
| 虚拟机 | `/vm?ver=0.9.0` |
| 飞牛同步 | `/fn-sync/` |
| Markdown 编辑器 | `/app/App-Native-MdEditor2` |
| UPS 电源管理 | `/cgi/ThirdParty/fn-ups-manager/index.cgi/` |
| Fndesk | `/app/fndesk` |
| CF 快捷隧道 | `/app/Cloudflare-QT/` |
| FnDepot 商店 | `/app/fndepot` |
| fnMusic 扩展管理 | `/app/fnmusic-ext/?_v=2.6.9` |
| fnOS Apps（桌面窗口） | `:8011/` |
| Moo | `/app/moo/` |
| 敲门 knock | `/cgi/ThirdParty/fn-knock/index.cgi/` |
| 影视在线扩展管理 | `/app/fnmedia-ext/` |
| biliLive-tools | `:3000/` |

### 类型 3 · 独立跳出窗，标题栏无 ↻/↗（9 个）

| 应用 | 新标签页地址 |
|---|---|
| 影视 | `/v` |
| 相册 | `/p` |
| 音乐 | `/music` |
| 素材库 Seek | `/seek/?ver=0.0.1` |
| FNTB 图标管理器 | `:18080/` |
| OpenList | `:34600/` |
| XTE | `:34500/` |
| lan-sheriff | `:2911/` |
| fnOS Apps | `:8011/` |

> `桌面`、`全部应用` 是启动器按钮，不是应用，点击无窗口。

## 四、客户端规则（对应代码）

| 类型 | 启动路径 | 标题栏 |
|---|---|---|
| 1 / 2 | 模拟点击桌面图标 → 飞牛自己开内嵌窗（`__fnosLaunchByClick`，检测到新增 iframe 即 return，记 `launch/embed-kept`） | 完全不碰，零注入 |
| 3 | `windowType=popout` → `__openAppByWindowType` → `createAppWindow` | `titlebar-inject.js` 自绘：☰ + ↻ + ↗ + — □ ✕ |

硬规则：

- 内嵌窗**永远**不转独立窗。
- 内嵌窗标题栏**永远**不注入按钮（类型 2 的按钮是飞牛的，类型 1 本来就没有，都不要动）。
- 独立跳出窗**必须**有 ↻ / ↗（那是我们自己开的窗，飞牛不给）。

## 五、回归记录

| 版本 | 事故 |
|---|---|
| v4.0.19 | 往内嵌窗标题栏注入 ↗（`__fnosEmbedPopoutBtn` / `__fnosEmbedPopoutWatch`）→ 类型 1/2 多画按钮 |
| v4.0.20 | 修了 v4.0.19，但把「内嵌窗不加按钮」一刀切套到独立跳出窗，删掉类型 3 的 ↻/↗ |
| v4.0.21 | 只按类型下手：1/2 零注入维持，3 恢复 ↻/↗ |

## 六、复现

```powershell
# 全量分类（约 3～4 分钟，40 个图标）
python tools/classify-windows.py --server http://192.168.31.101:5666 --user <账号> --password <密码> --headless --out build-out/window-types-v4.json

# 单个应用：打印标题栏结构 + 按钮祖先链
python tools/probe-embed-btn.py "Lucky"
```
