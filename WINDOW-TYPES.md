# 飞牛应用窗口类型（逆向结论 + 分类表）

> 版本：v4.0.21　实测环境：`http://192.168.31.101:5666`（fnOS 桌面 + 本机 FNOS 客户端）
> 本文是 `titlebar-inject.js` / `preload.js` / `main.js` 窗口策略的唯一判据文档。
> 改任何标题栏、跳出窗、内嵌窗逻辑前先看这里。

## 一、三类窗口

| # | 窗口形态 | 标题栏 ↻ 刷新 / ↗ 新标签 | 谁画这两钮 | 我们的动作 |
|---|---|---|---|---|
| 1 | 内嵌窗（桌面里的 `.trim-ui__app-layout--window`） | **没有** | — | 零注入，也不转独立窗 |
| 2 | 内嵌窗（同上） | **有** | 窗内页面自己（飞牛 appview 容器页 / 飞牛官方应用页） | 零注入，也不转独立窗 |
| 3 | 独立跳出窗（`createAppWindow` 的 BrowserWindow） | **没有** | 我们的自绘标题栏 | ☰ + ↻ + ↗ + — □ ✕ |

要点：

- 类型 1 / 2 都是**飞牛自己渲染**的内嵌窗，我们不动它的标题栏 —— 飞牛给不给 ↻/↗ 是它的事，缺了就是正常形态，补一个就是多画。
- 类型 3 的窗口是**我们**开的，飞牛页面里没有 ↻/↗，所以只能由自绘标题栏提供，否则用户没有刷新 / 在新标签打开。

## 二、判定依据（可复现）

1. **桌面壳永远不画 ↻/↗**
   抓 `http://<nas>:5666/assets/index-D1auxRov.js`（2.9 MB）后：
   - 内嵌窗标题栏 `trim-ui__app-layout--header` 的 children 固定为
     `[标题, 自定义槽(f), minimize, maximize, close]`；
   - 全文匹配 `刷新` / `新标签` / `newTab` / `new_tab` / `openInNew` 全部 0 命中。
   → 内嵌窗标题栏本身不存在这两钮；「有 ↻/↗ 的内嵌窗」里那两钮只能来自**窗内加载的页面**。
2. **独立跳出窗没有飞牛头**
   `createAppWindow` 打开的是应用真实入口页（`/app/<id>/`、`:3000`、`/cgi/ThirdParty/...`），
   这些页面不带飞牛应用头 → 必须由自绘标题栏补 ↻/↗。
3. **每个应用的形态**来自 `apps-manifest.json` 的 `windowType`
   （`meta` = NAS `/app/list` 或 fntb `/api/client/apps` 的元信息；`preset` = 实测种子；
   `behavior` = `setWindowOpenHandler` 观测回填；空 = 未分类，首次点击后回填）。

## 三、分类表（本机 NAS 实测清单，25 个已分类应用）

### 类型 1 · 内嵌窗，标题栏无 ↻/↗（第三方 FPK 页：`/app/<id>/`、`/cgi/ThirdParty/...`、外部端口）

| 应用 | 窗内入口 |
|---|---|
| App.Native.MdEditor2（Markdown 编辑器） | `/app/App-Native-MdEditor2` |
| baidu.netdisk（百度网盘） | `/app-baidu-netdisk` |
| bililivetools（biliLive-tools） | `:3000/` |
| Cloudflare-QT（Cloudflare 快捷隧道） | `/app/Cloudflare-QT/` |
| fndesk（飞牛桌面管理工具） | `/app/fndesk` |
| fn-docker-to-desktop（把 Docker 放到桌面） | `/app/fn-docker-to-desktop/` |
| FnMessageBot（日志推送） | `/app/FnMessageBot/` |
| fnmedia-ext（飞牛影视在线扩展） | `/app/fnmedia-ext/` |
| fnmusic-ext（fnMusic 音源扩展） | `/app/fnmusic-ext/` |
| fn-ups-manager（UPS 电源管理） | `/cgi/ThirdParty/fn-ups-manager/index.cgi/` |
| moo-mate（Moo Mate） | `/app/moo-mate/` |
| npc（NPC 客户端） | `/cgi/ThirdParty/npc/index.cgi` |
| port_one（Port One） | `:9788/@admin` |

### 类型 2 · 内嵌窗，标题栏有 ↻/↗（窗内是飞牛自有页面）

| 应用 | 窗内入口 | 说明 |
|---|---|---|
| trim.docker（Docker） | `/apps/docker/` | 飞牛自有 SPA，页面自带应用头 |
| trim.iscsi（iSCSI） | `/iscsi/` | 同上 |
| trim.snapshots（文件快照） | `/snapshot` | 同上 |
| trim.vm（虚拟机） | `/vm` | 同上 |
| trim.security（安全中心） | `/app/trim-security` | 飞牛官方 FPK，走飞牛应用壳 |

### 类型 3 · 独立跳出窗，标题栏无 ↻/↗（自绘栏补 ↻ + ↗）

| 应用 | 入口 |
|---|---|
| trim.media（影视） | `/v` |
| trim.music（音乐） | `/music` |
| trim.photos（相册） | `/p` |
| trim.seek（素材库 Seek） | `/seek` |
| Markdown | `:5174/` |
| mdesk（M·Desk） | `:19188/@admin` |
| fndesk_1793081925439（Fndesk_portview） | `/cgi/ThirdParty/fndesk_1793081925439/index.cgi?...` |

> 其余 101 条清单项尚未分类（`windowType` 为空：多为同一应用在不同 origin / 域名下的重复条目、
> 外部链接图标如官网/论坛/帮助中心）。首次启动后由 `behavior` 观测回填。

## 四、客户端处理规则

| 类型 | 启动路径 | 标题栏 |
|---|---|---|
| 1 / 2 | 模拟点击桌面图标 → 飞牛自己开内嵌窗（`__fnosLaunchByClick`，检测到新增 iframe 即 `return`，只记 `launch/embed-kept`） | 完全不碰，零注入 |
| 3 | `windowType=popout` → `__openAppByWindowType` → `createAppWindow` | `titlebar-inject.js` 自绘：☰ + ↻ + ↗ + — □ ✕ |

硬规则：

- 内嵌窗**永远**不许转独立窗（v4.0.19 起）。
- 内嵌窗标题栏**永远**不注入按钮（v4.0.20 起）。
- 独立跳出窗**必须**有 ↻ / ↗（v4.0.18 起，v4.0.20 误删，v4.0.21 恢复）。

## 五、回归记录

| 版本 | 事故 |
|---|---|
| v4.0.19 | 往内嵌窗标题栏注入 ↗（`__fnosEmbedPopoutBtn` / `__fnosEmbedPopoutWatch`）→ 类型 1/2 多画按钮 |
| v4.0.20 | 修正了 v4.0.19，但把「内嵌窗不加按钮」一刀切套到独立跳出窗，删掉类型 3 的 ↻/↗ |
| v4.0.21 | 只按类型下手：1/2 零注入维持，3 恢复 ↻/↗ |

## 六、待实测确认

- 类型 2 的判定靠「窗内是飞牛自有页面」这一条推断（bundle 层面已排除桌面壳自绘）。
  逐个点开截图确认时，看内嵌窗**内部**是否还有一层带 ↻/↗ 的应用头即可。
- `/app/trim-*`（飞牛官方 FPK）与 `/app/<第三方>/` 在 URL 上同族，区别只在前缀；
  若发现某个官方应用其实没有 ↻/↗，把它移到类型 1 并在此处记一笔。
