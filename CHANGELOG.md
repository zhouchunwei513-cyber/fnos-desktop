## v5.0.10

### MPV 无法启动（exit 1）——移除内核不认识的参数

- 现象：点 MPV 播放，内置/自定义内核都起不来；日志 `mpv.player.exit {"code":1}`
- 根因：v5.0.3 加的 `--hls-live-edge`、`--demuxer-lavf-o-add` 在该 mpv 构建里是**未知选项**，
  mpv 解析失败即 exit 1（v5.0.9 的空跑版本已回退）；
- 本版：删除这两个参数；直播起点改为 `--demuxer-lavf-o=…,live_start_index=-1`
  （ffmpeg 侧选项，未知也不致命）。实测待用户点击播放验证。

## v5.0.9

### 回退致命参数：MPV 无法启动（exit 1）

- 现象：点 MPV 播放，内置/自定义内核都起不来；日志 `mpv.player.exit {"code":1}`
- 根因：v5.0.3 引入的 `--hls-live-edge` / `--demuxer-lavf-o-add` 在该 mpv 构建里是**未知选项**，
  mpv 解析失败即 exit 1；
- 修法：删除这两个参数，直播起点改为合进已有的 `--demuxer-lavf-o=…,live_start_index=-1`
  （ffmpeg 侧选项，未知也不致命）。

## v5.0.7

### 直播"十几秒重播"根因修复：isLive 没传给播放器

- 实测（宿舍机捕获 mpv 命令行）：有 `--loop-file=no`，但**没有** `--hls-live-edge` →
  说明 v5.0.3 的直播参数没生效，因为 `payload.isLive` 没传进 MpvSurface 的 settings；
- 根因：`main.js` 的 embed 分支只 `const st = getMpvSettings()`，payload.isLive 仅用于打日志；
- 修法：`st = Object.assign({}, getMpvSettings(), { isLive: payload.isLive || payload.scope === 'live' })`
  → mpv 按直播处理：加 `--hls-live-edge=1`、EOF 走直播重连而不是点播重载。

## v5.0.4

### 应用内点链接：改为客户端新窗口打开

- 用户要求：应用里点链接/点功能，一律在客户端以新窗口打开，不再跳系统浏览器；
- 修法：`setWindowOpenHandler` 里非 NAS 主机的 http(s) 地址由 `shell.openExternal` 改为
  `createAppWindow(url, { source: 'external' })`（失败才回退浏览器）；
- 日志 `nav.external.window`。

