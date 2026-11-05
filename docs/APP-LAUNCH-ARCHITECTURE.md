# 应用启动链路复盘与改造方案（v4.0.61 提案）

> 2026-11-06 03:10 编写 | 现场：飞牛客户端 v4.0.60，NAS `100.103.38.13:5666`，账号体系含 FNID / 内网 / 异地组网 / FRP / DDNS

---

## 一、两条链路到底怎么走的（代码实锤）

### 1.1 程序内打开（点飞牛桌面图标 / 页内 window.open）

```
fnOS 前端 click → window.open / location 变更
  → main.js:6541  win.webContents.setWindowOpenHandler(({url,features}) => …)
  → will-navigate 监听（同源应用的 SPA 跳转）
  → main.js:16874 __appviewToPopout(navUrl)
        ├─ 取 anchor（?anchor=<appId>）
        ├─ 30s 同 anchor 只开一窗（v4.0.58 守卫）
        ├─ __fetchAppCenterUrlLive(anchor)  // 问 app-center 要真实入口，端口不同才用
        └─ createAppWindow(url, {appId, source:'in-app'})
  → main.js:6850 __appLoadTarget(win, url, …)     ← 所有打开方式的**唯一收口**
        ├─ ① fail-memo（ok-url.json，按 appId 记忆 30 天，深链不顶替）
        ├─ ② __lanPrefer59(url, appId)  内网优先
        ├─ ③ __launchUrlNormalize → __launchAccountFix（账号 host 归位）
        └─ ④ win.loadURL()
```

### 1.2 桌面快捷方式打开

```
桌面 .lnk
  → wscript.exe //B fnos-launcher.vbs "<appId>" "<FNOS.exe>" "<nasBase>"
  → vbs：读 %APPDATA%\fnos-client\fnos-launch-endpoint.txt（端口+token）
  → HTTP POST http://127.0.0.1:<port>/launch   app=<appId>&token=…
  → main.js:15937 launch.http server 收单
  → main.js:17917 __resolveLaunchUrl(raw, nasAddr)   // 解析应用入口
  → __openAppByWindowType(appId, name, url, windowType, wthUrl)
  → main.js:6850 __appLoadTarget(…)   ← 与上面汇合，走同一条归一化链
```

**结论：两条链路最终汇合在 `__appLoadTarget`**，差异只在「入口 URL 从哪来」：
程序内 = fnOS 页面给的 anchor/URL；快捷方式 = launcher 传的 appId + `__resolveLaunchUrl` 解析。

### 1.3 归一化链目前有 5 道关卡（顺序即优先级）

| # | 位置 | 作用 | 已知副作用 |
|---|---|---|---|
| ① | `fail-memo`（ok-url.json） | 记住上次成功的 URL，跨网络先试它 | 换账号后可能记住**别的账号**的地址 |
| ② | `__lanPrefer59` | 本机在内网时，把域名/FRP 地址换成内网地址 | 端口不跟着换 → 见 ③ |
| ③ | `__launchAccountFix` | 把「别的账号的 host」换成当前账号 host | v4.0.47 之前**端口不换** → `100.x:103xx` 必拒连（v4.0.60 已按路径整段归位） |
| ④ | `__appviewFallbackUrl` / `__openAppByWindowType` | 决定 embed / popout 形态 + appview 兜底 | appview anchor 对部分应用是 404 |
| ⑤ | 失败轮换 `conn-fallback30` / `port-align41` / entry-check | 连接失败后按候选表再试 | 候选是"猜"出来的，会挂错端口、连锁失败（v4.0.59 加了跨账号短路） |

---

## 二、账号体系现状：隔离做到了没有？

| 账号形态 | 地址特征 | 分区隔离 | URL 归一化 | 结论 |
|---|---|---|---|---|
| **FNID** | `https://fnos.net/<fnid>`（路径区分，非端口） | ✅ `persist:nas-<hash(fnid)>` | ⚠️ 归位按 host 判断，`fnos.net` 是**公共 host**，不同 fnid 同 host → 归位逻辑认不出"这是哪个账号" | 半隔离 |
| **内网 IPv4** | `192.168.x.x:5666` | ✅ | ✅ 私网 host 直连 | 正常 |
| **异地组网（Tailscale）** | `100.x.x.x:5666`（CGNAT 私网段） | ✅ | ⚠️ `100.x` 被当作普通私网，若同时存在多个组网账号会互相顶替 | 半隔离 |
| **FRP 中转** | 公网域名/IP + 高位端口 `103xx` | ✅ | ❌ **端口是 FRP 映射端口，只在公网侧监听**；换 host 不换端口必然拒连 | 有 bug（已修一半） |
| **DDNS** | 公网域名:端口 | ✅ | 同上 | 有 bug |

**判断**：**登录态/分区是真隔离**（每个账号独立 partition，v4.0.48 起还会保活 Cookie）；
**但「URL 归位」是全局猜的**——只看 host 是否"已知别的账号"，不看「这条 URL 属于哪个账号、哪个网络」，所以会拿 A 账号的 host 拼 B 账号的端口。这就是"程序内/快捷方式都打不开"的总根源。

---

## 三、应用形态与端口的两维分类（决定 URL 该怎么拼）

| 形态 | 例子 | 入口特征 | 正确打开方式 |
|---|---|---|---|
| 页内窗（DOM） | 文件管理、Docker、系统设置 | `/appview?anchor=<id>` 或纯 SPA 路由，**无端口** | 主窗内导航，不新开窗 |
| 独立跳出窗（Electron） | 影视 `/v`、相册 `/p`、音乐 `/music` | NAS 同源 + 路径，**无端口** | popout 窗，origin 用当前账号 |
| 第三方 FPK（内嵌） | biliLive-tools `:10305`、qBittorrent `:8080` | **自有端口**，只在某台主机监听 | 必须 host+port **原样成对**，禁止搬家 |
| 反代/FRP 应用 | `/app/trim-security/` 走 `103xx` | 公网端口 ↔ 内网同路径 | **按路径走当前账号 origin**，端口丢弃 |
| CGI 类 | `/cgi/ThirdParty/npc/…` | NAS 同源 + 路径 | 同"反代"处理 |

**判据（v4.0.60 已落地）**：看**路径**而不是看端口。
`/app`、`/appview`、`/cgi`、`/iscsi`、`/vm`、`/snapshot`、`/fn-sync`、`/trim`、`/p`、`/v`、`/music`、`/api`
→ NAS 内置，host+端口整体归位；其余（根路径/自有端口）→ 原样保留。

---

## 四、症结清单（按证据排序）

1. **主机与端口被拆开处理**（最致命）。改写 host 时沿用旧端口 → 必拒连。已修 v4.0.60，但仍有 `__lanPrefer59`、`port-align41`、`conn-fallback30` 三处各自拼 URL 的代码，容易再犯。
2. **"猜"入口而非"问"入口**。app-center 有权威数据（`/app-center/v1/app/installed`，实测 39 条、端口正确），但只在 `__appviewToPopout` 里用过一次，快捷方式链路没走它。
3. **记住的地址没有账号维度**（ok-url.json 只按 appId）。
4. **内外网偏好是"事后改 URL"**，不是"选路策略"。
5. **失败分类不明确**：-102（拒连）/ -118（超时）/ -3（abort）混在一起重试，产生连锁失败与多开窗（v4.0.58/59 已各自堵一半）。

---

## 五、方案：统一入口解析器 `resolveAppEntry()`

### 5.1 设计原则

1. **四元组整体替换**：`{scheme, host, port, path}` 必须来自同一个来源，禁止交叉拼接；
2. **权威优先**：先问 app-center，再退缓存，最后才用传入 URL；
3. **账号维度**：所有记忆（成功地址、失败原因）都带 `accountId`；
4. **失败要分类**，不猜：不可达就说"账号X/网络Y不可达"，不再换端口试；
5. **两条链路同一个入口解析**（快捷方式与程序内共用）。

### 5.2 接口

```js
async function resolveAppEntry({ appId, rawUrl, accountId, netHint }) 
  → { url, kind: 'nas-path'|'third-party'|'appview', accountId, source, attempts[] }
```

**数据源优先级**
1. `app-center/v1/app/installed`（用当前账号 session fetch）→ 取 `appServiceInfo.urls{protocol,host,port,path}`
   - `host` 空 → 用当前账号 host；`port` 空 → 用当前账号端口；`path` 空 → `/`
2. fpk 缓存 / `apps-manifest.json`
3. 偏好设置里的「应用外网地址（URL 重写）」规则（用户显式配的，最高可信度之一）
4. 传入的原始 URL

**选路策略（netHint）**
- `lan`（本机与账号同网段）→ 内网 host 优先
- `tailscale`（100.64/10）→ 组网 host 优先
- `wan`（FRP/DDNS）→ 公网 host+端口整体使用
- 用户显式"内外网切换"优先级最高，覆盖自动判断

**探测与记忆**
- 候选按 (s) 顺序探测：`HEAD` 800ms（失败改 `GET` 读前 1KB）
- 首个 200 即用，写入 `ok-url.v2.json`：`{ [accountId]: { [appId]: {url, at, net} } }`
- 全失败 → 返回 `{kind:'unreachable', because:'account-offline'|'port-closed'|'404'}`

### 5.3 失败分类（对用户话术）

| 分类 | 判据 | 提示 |
|---|---|---|
| `account-offline` | host 属于其他账号且 -118/-7 | 「账号『X』当前连不上，请切换到该账号或检查网络」 |
| `port-closed` | 本机不监听该端口（同主机 -102） | 「该应用入口端口不对，已按 NAS 内置路径尝试」 |
| `entry-404` | appview anchor 404 | 「该应用入口已失效，请在 NAS 上删除或重新添加」 |
| `app-crashed` | 200 但内容为空/白屏 | 「应用未启动，检查 NAS 上该服务状态」 |

### 5.4 落地点（改哪个文件）

- `main.js`：新增 `resolveAppEntry()`（约 200 行），替换 `__launchAccountFix` / `__lanPrefer59` / `__resolveLaunchUrl` 三处的拼装；
- `__appLoadTarget` 只保留「调用 resolver + 加载 + 失败分类」；
- `ok-url.json` 升级为 v2（按账号分桶，旧文件自动迁移）；
- 快捷方式链路 `__resolveLaunchUrl` 改为直接调用 resolver（根治"快捷方式与程序内不一致"）。

---

## 六、分阶段计划

| 阶段 | 内容 | 风险 | 预计 |
|---|---|---|---|
| **P0** | 抽出 resolver（先只做四元组整体替换 + 账号维度记忆），两条链路都改走它 | 中 | 1 天 |
| **P1** | 接 app-center 权威数据 + 探测排序（LAN > 组网 > WAN） | 中 | 1 天 |
| **P2** | 失败分类与话术 + `resolve.v2` 单条完整日志 | 低 | 半天 |
| **P3** | 快捷方式**只写 appId 不写 URL**（launcher 传 appId，URL 完全由客户端解析） | 高（要重生成 .lnk） | 半天 |
| **P4** | FNID 特化：`fnos.net/<fnid>` ↔ 内网/组网地址映射表 | 中 | 半天 |

## 七、验证矩阵（必须逐格实测）

| 账号类型 \ 方式 | 程序内·页内窗 | 程序内·跳出窗 | 快捷方式·页内窗 | 快捷方式·跳出窗 |
|---|---|---|---|---|
| FNID | | | | |
| 内网 IPv4 | | | | |
| 异地组网 | | | | |
| FRP | | | | |
| DDNS | | | | |

每格记录：实际 URL、来源（app-center/缓存/原始）、首次耗时、是否命中记忆。

## 八、日志规范（`resolve.v2` 单条）

```
[resolve.v2] appId=trim.security acct=FNID:xxx net=lan src=app-center
  tried=[http://100.103.38.13:5666/app/trim-security/ ok 273ms]
  final=http://100.103.38.13:5666/app/trim-security/ kind=nas-path
  drop=[http://100.103.38.13:10300/app/trim-security/ reason=port-closed]
```

一条日志就能还原整次决策，用户发日志即可定位。
