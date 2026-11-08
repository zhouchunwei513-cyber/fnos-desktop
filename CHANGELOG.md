## v5.0.15

### 直播：收紧缓存 + 去掉与 HLS 拉流冲突的重连选项（方案 A）

- 实测 v5.0.14：播放速度正常、硬解 d3d11va、0 丢帧，但 `duration=29.99`（把 3 段窗口当完整媒体），
  pos≈29 时 RESTART → 每 30 秒跳一次；
- 修法（直播专用）：`--demuxer-lavf-o=reconnect=1,reconnect_delay=2,reconnect_delay_max=15`
  （去掉 reconnect_streamed / reconnect_on_network_error），并加
  `--cache-secs=15 --demuxer-max-back=0 --hls-bitrate=max`，让 ffmpeg 持续拉取 playlist。

## v5.0.14

### 直播每 10 秒回到开头：移除 ffmpeg 的 reconnect_at_eof / live_start_index

- IPC 实测（家里机 mpv）：time-pos 9.28 → playback-restart → 0.60 → … → 9.12 → restart，周期≈10s；
  同期客户端 **没有任何 loadfile/end-file 日志** → 不是我们重载，是 ffmpeg 侧自我重开；
- 根因：`--demuxer-lavf-o` 里的 `reconnect_at_eof=1`（分片边界触发重开）与
  `live_start_index=-1`（每次重开都跳到最后一段）组合 → 每 10 秒从新分片头开始；
- 修法：直播只用 `reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay…`，
  点播保持原参数不变。

## v5.0.11

### 自定义内核（mpv-lazy）直播仍循环：禁用 watch-later

- 实测 mpv-lazy 的 `portable_config/mpv.conf` 含 `watch-later-options = start,vid,aid,sid`
  → 会把上次播放位置写入 watch-later，重连/下次播放时按 `start` 跳回 → 直播倒退重播；
- 修法：直播播放时追加 `--no-save-position-on-quit --no-resume-playback`。

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

