'use strict';

// mpv-player.js —— 内置 MPV 播放内核管理
// 两种形态：
//   1) 外部独立窗口：openMpv(url, headers, options) —— spawn mpv.exe，MPV 自建窗口
//   2) 应用内嵌入：MpvPlayer.loadfile() 配合 --wid=<HWND> —— 渲染到指定宿主窗口（视频区）
// 通过 Windows named pipe (--input-ipc-server) 做命令/属性控制与事件回调。
// 设计对齐参考客户端 fntv（外部 mpv 进程 + http-header-fields 鉴权 + 大缓存），
// 并额外支持 --wid 嵌入，做到“点开就在应用内播放，不跳出外部窗口”。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const net = require('net');

let mpvMod = null;

// ---------- MPV 可执行文件发现 ----------
function findMpvExe() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'mpv', 'mpv.exe'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'mpv', 'mpv.exe'));
  }
  // 开发环境
  candidates.push(path.join(__dirname, 'mpv', 'mpv.exe'));
  candidates.push(path.join(process.cwd(), 'mpv', 'mpv.exe'));
  // 系统安装
  candidates.push('mpv');
  for (const p of candidates) {
    try {
      if (p === 'mpv') {
        const r = spawnSync('mpv', ['--version'], { windowsHide: true, timeout: 4000 });
        if (!r.error) return 'mpv';
      } else if (fs.existsSync(p)) {
        return p;
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

function getMpvExe() {
  if (!mpvMod) {
    mpvMod = { exe: findMpvExe() };
  }
  return mpvMod.exe;
}

// 内置 MPV 配置目录（含中文右键菜单 Lua + mpv.conf）。随包分发在 resources/mpv-config/。
function findMpvConfigDir() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'mpv-config'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'mpv-config'));
  }
  candidates.push(path.join(__dirname, 'mpv-config'));
  candidates.push(path.join(process.cwd(), 'mpv-config'));
  for (const p of candidates) {
    try { if (fs.existsSync(path.join(p, 'mpv.conf')) || fs.existsSync(path.join(p, 'scripts'))) return p; } catch (_) {}
  }
  return null;
}

function getMpvConfigArgs() {
  const dir = findMpvConfigDir();
  if (!dir) return [];
  // --config-dir 指定配置根目录（mpv.conf + scripts/ 均在其下）
  return [`--config-dir=${dir}`];
}

// ---------- 网络缓存/预读档位（用于消除局域网/在线播放卡顿）----------
// 数值均为 mpv 原生参数；demuxer-readahead-secs 越大缓冲越多越抗抖动。
const CACHE_PRESETS = {
  standard: { // 均衡：约 32MB / 60s 预读
    cache: 'yes',
    'demuxer-max-bytes': '32MiB',
    'demuxer-max-back-bytes': '16MiB',
    'demuxer-readahead-secs': '60',
    'cache-secs': '60',
    'cache-pause': 'yes',
    'cache-pause-initial': 'yes',
    'cache-pause-wait': '1.5'
  },
  smooth: {   // 流畅优先：约 128MB / 120s 预读（4K/高码率推荐）
    cache: 'yes',
    'demuxer-max-bytes': '128MiB',
    'demuxer-max-back-bytes': '48MiB',
    'demuxer-readahead-secs': '120',
    'cache-secs': '120',
    'cache-pause': 'yes',
    'cache-pause-initial': 'yes',
    'cache-pause-wait': '2'
  },
  unlimited: { // 不限速、尽量多读
    cache: 'yes',
    'demuxer-max-bytes': '512MiB',
    'demuxer-max-back-bytes': '128MiB',
    'demuxer-readahead-secs': '300',
    'cache-secs': '300',
    'cache-pause': 'yes',
    'cache-pause-initial': 'yes',
    'cache-pause-wait': '2'
  }
};

function buildCacheArgs(level) {
  const preset = CACHE_PRESETS[level] || CACHE_PRESETS.smooth;
  const args = [];
  for (const [k, v] of Object.entries(preset)) args.push(`--${k}=${v}`);
  return args;
}

function hwDecodeArgs(mode) {
  switch (mode) {
    case 'auto':     // 默认：Windows + Intel 核显（如 N100）用 d3d11va 零拷贝，解码/显示全程留在 GPU，CPU 占用最低
    case 'd3d11va':  return ['--hwdec=d3d11va', '--gpu-context=d3d11'];
    case 'dxva2':    return ['--hwdec=dxva2-copy', '--gpu-context=d3d11'];
    case 'no':       return ['--hwdec=no', '--gpu-context=d3d11'];
    default:         return ['--hwdec=d3d11va', '--gpu-context=d3d11'];
  }
}

// 低功耗/低开销参数（针对 N100 等弱 CPU 双路 4K 场景）：
//  - profile=fast：mpv 官方低负载预设（关闭高质量插值/去band等重滤镜）
//  - 音视频同步用 display-resample 关闭、framedrop 丢帧、线性缩放、BT.2390 tone-map，减轻 GPU/CPU
//  - 关闭 OSD 文字/进度条的持续渲染以外的重特效
function perfArgs() {
  return [
    '--profile=fast',
    '--framedrop=vo',
    '--video-sync=audio',
    '--interpolation=no',
    '--scale=bilinear',
    '--cscale=bilinear',
    '--dscale=bilinear',
    '--tone-mapping=bt.2390',
    '--hdr-compute-peak=no'
  ];
}

// ---------- 嵌入式 MPV 播放器（带 named-pipe IPC）----------
class MpvPlayer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.pipePath = null;
    this.sock = null;
    this.connected = false;
    this._reqId = 1;
    this._pending = new Map();
    this._dead = false;
    this._startTime = 0;
    this._duration = 0;
    this._paused = false;
    this._vol = 100;
    this._lastUrl = '';       // 最近加载的媒体地址（用于出错自动重连）
    this._lastHeaders = null; // 最近一次的媒体头
    this._isLive = false;     // 是否为直播流（eof 也重连）
    this._reloadTries = 0;    // 连续自动重载次数
    this._lastLoadedAt = 0;   // 上次成功 file-loaded 时间
    this._startOpts = null;   // 最近一次 start() 参数（用于进程崩溃后自动重启）
    this._restartTries = 0;   // 进程崩溃自动重启次数
    this._manualStop = false; // 是否为主动停止（stop/destroy），主动停止不自愈
    this._quitByUser = false; // 用户点 mpv 窗口自带关闭按钮（end-file reason=quit）→ 正常退出，不崩溃自愈
    this._coreIdle = false;   // mpv core-idle 属性（true=播放核心空闲，卡住/暂停时为真）
    this._timePosVal = null;  // 最近 time-pos（秒），用于卡死检测
    this._lastTimePos = -1;   // 上一次采样的播放位置
    this._lastProgressAt = 0; // 播放位置最后一次推进的时间戳
    this._watchdogTimer = null; // 卡死看护定时器
    this._seeking = false;     // 是否正在拖动进度条/定位中
    this._seekStartedAt = 0;   // 本次 seek 开始时间戳
    this._onNeedFreshUrl = null; // 点播断流时由主进程注入：重新签名取新鲜播放地址
    this._refreshing = false; // 是否正在重新取流（防重入）
    this._logFilePath = '';   // mpv 自身详细日志文件（fnos-mpv.log）
  }

  // mpv 详细日志文件路径：放 userData（与 fnos-diag.log 同目录），回退系统临时目录
  _resolveLogPath() {
    try {
      const { app } = require('electron');
      const base = (app && typeof app.getPath === 'function') ? app.getPath('userData') : os.tmpdir();
      return path.join(base || os.tmpdir(), 'fnos-mpv.log');
    } catch (_) {
      return path.join(os.tmpdir(), 'fnos-mpv.log');
    }
  }

  isRunning() { return !!this.proc && !this._dead; }

  // opts: { wid, headers, cacheLevel, hwDecode, title, extraArgs, logFile, onNeedFreshUrl(async()=>{url,headers,isLive}) }
  start(opts = {}) {
    const exe = getMpvExe();
    if (!exe) throw new Error('未找到内置 mpv.exe（resources/mpv/mpv.exe 缺失）');
    if (this.proc) this.stop();

    this._startOpts = opts;
    this._manualStop = false;
    this._quitByUser = false;
    this._refreshing = false;
    this._onNeedFreshUrl = (typeof opts.onNeedFreshUrl === 'function') ? opts.onNeedFreshUrl : null;
    this._dead = false;
    this.pipePath = `\\\\.\\pipe\\fnos-mpv-${process.pid}-${Date.now()}`;

    // 详细 mpv 日志文件（fnos-mpv.log）：记录 HTTP 状态/重定向/end-file/demuxer 网络细节，
    // 供离线排查“点播播到一半中断”。超 8MB 启动时截断，防止无限增长。
    this._logFilePath = opts.logFile || this._resolveLogPath();
    try {
      if (fs.existsSync(this._logFilePath)) {
        const st = fs.statSync(this._logFilePath);
        if (st && st.size > 8 * 1024 * 1024) { try { fs.writeFileSync(this._logFilePath, ''); } catch (_) {} }
      }
    } catch (_) {}

    // 界面语言：shinchiro Windows 构建无 gettext 翻译、也没有 --lang 选项，
    // 传 --lang 会被当成未知命令行选项导致 mpv 启动即退出(exit 1)。中文界面改由
    // --config-dir 加载 scripts/fnos-menu.lua（中文右键菜单）实现，这里不传 --lang。
    const args = ['--force-window=yes', '--idle=yes', '--terminal=no', '--msg-level=all=info',
      `--log-file=${this._logFilePath}`,
      // mpv 自身详细日志级别（写入 fnos-mpv.log）：网络/解封装相关调高，便于定位 HTTP 403/401/超时
      '--msg-level=ffmpeg=v,stream=v,demuxer=v,stream-lavf=v,lua=warn,ass=warn'
    ];
    // 内置中文右键菜单 / 配置（--config-dir 指向随包隔离目录，替代 --no-config；
    // 该目录下的 mpv.conf + scripts/fnos-menu.lua 提供中文右键菜单，不读用户全局配置）
    args.push(...getMpvConfigArgs());
    // 直播/HTTP 断流自动重连（交给 ffmpeg 内建重试，覆盖短抖动；长期断链仍由应用层重新取流兜底）
    args.push('--demuxer-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=10,reconnect_on_network_error=1');

    // 形态 A：mpv 原生无边框窗口，覆盖在应用视频区（fntv 同款，最稳，OSC/拖动/键盘全可用）
    //   geometry 使用【屏幕物理像素】坐标（与 Electron getContentBounds()*scaleFactor 一致）。
    // 形态 B：opts.wid 时嵌入到已有 HWND（保留，但默认不再使用——Electron 透明窗与渲染层有输入/层级冲突）。
    if (opts.wid) {
      const hwnd = Buffer.isBuffer(opts.wid) ? opts.wid.readBigUInt64LE(0).toString() : String(opts.wid);
      args.push(`--wid=${hwnd}`);
      args.push('--border=no', '--no-window-dragging', '--osc=yes', '--osd-bar=yes');
    } else {
      // 无边框 + 始终置顶 + 可拖动 + 自带 OSC 控制条 + 不在任务栏重复显示
      args.push('--border=no', '--ontop=yes', '--osc=yes', '--osd-bar=yes',
        '--window-dragging=yes', '--title=FNOS-MPV',
        // keep-open=yes：网络抖动/读取出错/播完时停在最后一帧，绝不退回 "Drop files" 待机画面
        '--keep-open=yes', '--force-window=yes');
      if (opts.geometry && opts.geometry.width > 0) {
        // mpv --geometry=WxH+X+Y（屏幕像素）。不用 --autofit：它会在运行时限制窗口尺寸、
        // 导致跟随主窗口缩放时被钳制，联动交给 setGeometry 的 window-resize/move 命令。
        const g = opts.geometry;
        args.push(`--geometry=${Math.round(g.width)}x${Math.round(g.height)}+${Math.round(g.x)}+${Math.round(g.y)}`);
      }
    }

    // IPC
    args.push(`--input-ipc-server=${this.pipePath}`);

    // 硬解（d3d11va 零拷贝 + d3d11 渲染上下文，N100/核显友好）
    args.push(...hwDecodeArgs(opts.hwDecode || 'auto'));

    // 低功耗/低开销（N100 双路 4K 关键）
    args.push(...perfArgs());

    // 缓存/预读（消卡顿核心）
    args.push(...buildCacheArgs(opts.cacheLevel));

    // 网络健壮性（直播长时间运行易遇运营商断流/抖动，放宽超时）
    args.push('--network-timeout=120');
    args.push('--user-agent=fnOS-Desktop/MPV');

    // HTTP 鉴权头（Cookie / Authorization / Referer / UA）
    if (opts.headers && Object.keys(opts.headers).length) {
      const fields = [];
      for (const [k, v] of Object.entries(opts.headers)) {
        if (v) fields.push(`${k.replace(/^[\s]+|[\s]+$/g, '')}: ${String(v).replace(/,/g, ' ')}`);
      }
      if (fields.length) args.push(`--http-header-fields=${fields.join(',')}`);
    }

    if (opts.extraArgs) args.push(...opts.extraArgs);

    try {
      this.proc = spawn(exe, args, { windowsHide: false });
    } catch (e) {
      this._dead = true;
      throw e;
    }
    this._startTime = Date.now();

    // 转发关键 stdout 日志：错误 + HTTP 状态码/重定向（点播签名失效多表现为 302→4xx）+ 关键事件。
    // mpv 已写详细 fnos-mpv.log；这里仅把关键行经 IPC 汇入诊断日志，避免刷屏。
    const _fwd = (raw) => {
      try {
        const s = String(raw || '');
        s.split(/\r?\n/).forEach((line) => {
          const t = line.trim();
          if (!t) return;
          if (/error|fail|cannot|invalid|forbidden|unauthor|denied|401|403|410|http\/[0-9.]+\s*[345]\d\d|HTTP\/[0-9.]+\s*[345]\d\d|redirect|end of file|end-file|connection|timed?\s*out|reset|refused/i.test(t)) {
            this.emit('log', t.slice(0, 500));
          }
        });
      } catch (_) {}
    };
    this.proc.stdout?.on('data', d => _fwd(d.toString()));
    this.proc.stderr?.on('data', d => _fwd(d.toString()));
    this.proc.on('error', err => { this.emit('log', 'spawn error: ' + err.message); });
    this.proc.on('exit', (code, sig) => {
      const userClosed = this._quitByUser || this._manualStop;
      this._stopWatchdog();
      this._dead = true;
      this.connected = false;
      this._closeSocket();
      this.emit('exit', code, sig, userClosed);
      // 用户主动关闭（点 mpv 窗口 X / end-file reason=quit）或正常退出（code=0）：
      //   属于正常结束，绝不当崩溃自愈——否则会出现"关了又自动打开"。
      // 真正的崩溃（非零码 / 被信号杀死且非用户主动）：自动重启内核并续播，避免画面冻结。
      const cleanExit = userClosed || code === 0;
      if (cleanExit) {
        this.emit('log', 'mpv closed by user (code=' + (sig || code) + '), no auto-restart');
        this._onNeedFreshUrl = null;
        return;
      }
      if (!this._manualStop && this._lastUrl && this._restartTries < 6) {
        this._restartTries++;
        const delay = Math.min(4000, 800 * this._restartTries);
        this.emit('log', 'mpv process crashed (' + (sig || code) + '), auto-restart #' + this._restartTries + ' in ' + delay + 'ms');
        setTimeout(() => {
          try {
            if (this._manualStop || this._quitByUser) return;
            const opts = Object.assign({}, this._startOpts || {});
            this.start(opts);
            // 等 IPC 就绪后续播上一个流（保留直播标记与鉴权头）
            const replay = () => {
              if (this._manualStop || this._quitByUser) return;
              this.loadfile(this._lastUrl, this._lastHeaders, { isLive: this._isLive })
                .then(() => { this._restartTries = 0; })
                .catch(() => {});
            };
            if (this.connected) replay();
            else this.once('ipc-ready', replay);
          } catch (e) {
            this.emit('log', 'mpv restart failed: ' + (e && e.message));
          }
        }, delay);
      }
    });

    // 连接 IPC（mpv 启动后异步创建管道，重试连接）
    this._connectPipe(0);
    return true;
  }

  _connectPipe(attempt) {
    if (this._dead || attempt > 40) {
      if (attempt > 40) this.emit('log', 'mpv ipc connect timeout');
      return;
    }
    const sock = net.connect(this.pipePath);
    this.sock = sock;
    let buf = '';
    sock.on('connect', () => {
      this.connected = true;
      this.emit('ipc-ready');
      // 开启属性事件观察
      this.command(['observe_property', 1, 'pause']);
      this.command(['observe_property', 2, 'time-pos']);
      this.command(['observe_property', 3, 'duration']);
      this.command(['observe_property', 4, 'eof-reached']);
      this.command(['observe_property', 5, 'core-idle']);
      this.command(['observe_property', 6, 'volume']);
      this.command(['observe_property', 7, 'cache-buffering-state']);
      this.command(['observe_property', 8, 'seeking']);
      this._startWatchdog();
    });
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this._handleIpcLine(line);
      }
    });
    sock.on('error', () => {
      this.connected = false;
      sock.destroy();
      if (!this._dead) setTimeout(() => this._connectPipe(attempt + 1), 200);
    });
    sock.on('close', () => { this.connected = false; });
  }

  _closeSocket() {
    try { this.sock && this.sock.destroy(); } catch (_) {}
    this.sock = null;
    this.connected = false;
    for (const [, rej] of this._pending) { try { rej(new Error('mpv ipc closed')); } catch (_) {} }
    this._pending.clear();
  }

  _handleIpcLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    if (msg.request_id && this._pending.has(msg.request_id)) {
      const { resolve, reject } = this._pending.get(msg.request_id);
      this._pending.delete(msg.request_id);
      if (msg.error && msg.error !== 'success') reject(new Error(msg.error));
      else resolve(msg.data);
      return;
    }
    if (msg.event === 'property-change') {
      const id = msg.id;
      const val = msg.data;
      if (id === 1) { this._paused = !!val; this.emit('pause', this._paused); if (!val) this._lastProgressAt = Date.now(); }
      else if (id === 2) {
        if (typeof val === 'number') {
          this._timePosVal = val;
          // 播放位置在推进：刷新"最后推进时间"，卡死看护据此判断是否真的卡住
          if (this._lastTimePos < 0 || Math.abs(val - this._lastTimePos) > 0.01) {
            this._lastTimePos = val; this._lastProgressAt = Date.now();
          }
          this.emit('time', val);
        }
      }
      else if (id === 3) { if (typeof val === 'number' && val > 0) { this._duration = val; this.emit('duration', val); } }
      else if (id === 4) { if (val) this.emit('ended'); }
      else if (id === 5) { this._coreIdle = !!val; }
      else if (id === 6) { if (typeof val === 'number') { this._vol = val; this.emit('volume', val); } }
      else if (id === 7) { if (typeof val === 'number') this.emit('buffering', val); }
      else if (id === 8) {
        // seeking：拖动进度条时为 true，定位完成回 false。seek 后长时间不结束 = 目标位置拉不到数据
        // （常见于点播签名失效），交给卡死看护快速触发"重新取流 + 在目标位置续播"。
        const was = !!this._seeking;
        this._seeking = !!val;
        if (this._seeking && !was) { this._seekStartedAt = Date.now(); this._lastProgressAt = Date.now(); }
        if (!this._seeking) { this._seekStartedAt = 0; this._lastProgressAt = Date.now(); }
      }
      return;
    }
    if (msg.event === 'file-loaded') {
      this._reloadTries = 0; this._restartTries = 0;
      this._lastLoadedAt = Date.now();
      this._lastTimePos = -1; this._lastProgressAt = Date.now(); this._coreIdle = false;
      // 点播续播：崩溃自愈/重新取流后续播到断点
      if (typeof this._resumePos === 'number' && this._resumePos > 1 && !this._isLive) {
        const pos = this._resumePos;
        const doSeek = () => { try { this.seek(pos); } catch (_) {} };
        setTimeout(doSeek, 400);
      }
      this._resumePos = undefined;
      this.emit('loaded');
      return;
    }
    if (msg.event === 'end-file') {
      const reason = msg.reason;
      // 用户点 mpv 窗口自带关闭按钮：标记为用户关闭（供 exit handler 不做崩溃自愈，
      // 并通知主进程回收嵌入层）。这是修复"关闭 mpv 后又自动打开"的关键。
      if (reason === 'quit' || reason === 'shutdown') {
        this._quitByUser = true;
        this.emit('user-closed');
        this.emit('end-file', reason);
        return;
      }
      // 出错(error) 或 直播流意外 eof/redirect：自动恢复当前流（带退避）。
      // 点播(isLive=false)：优先"重新签名取新鲜地址"（飞牛 media/range 是时效签名链接，
      //   播约 10 分钟后续传会 4xx，复用旧地址必失败）；取不到新鲜地址才回放旧地址兜底。
      // 直播：重连同一 URL（m3u8/分片滚动天然刷新）。
      const needReload = (reason === 'error') || (this._isLive && (reason === 'eof' || reason === 'redirect'));
      // 直播断流恢复机会更多：运营商 m3u8 分片滚动/偶发 404，需持续重连；上限 30 次。
      const maxTries = this._isLive ? 30 : 8;
      if (needReload && this._lastUrl && this._reloadTries < maxTries && !this._quitByUser && !this._manualStop) {
        this._reloadTries++;
        const delay = Math.min(3000, 400 * this._reloadTries);
        this.emit('log', 'stream ' + reason + ' (retry #' + this._reloadTries + '/' + maxTries + '), recover in ' + delay + 'ms'
          + (!this._isLive ? ' [VOD -> refresh signed url]' : ''));
        setTimeout(() => { try { this._reloadStream(); } catch (_) {} }, delay);
      }
      this.emit('end-file', reason);
      return;
    }
  }

  command(cmdArr) {
    if (!this.connected || !this.sock) return Promise.reject(new Error('mpv ipc not ready'));
    const request_id = this._reqId++;
    const payload = JSON.stringify({ command: cmdArr, request_id }) + '\n';
    return new Promise((resolve, reject) => {
      this._pending.set(request_id, { resolve, reject });
      try { this.sock.write(payload); } catch (e) { this._pending.delete(request_id); reject(e); }
      setTimeout(() => {
        if (this._pending.has(request_id)) { this._pending.delete(request_id); reject(new Error('mpv cmd timeout')); }
      }, 4000);
    });
  }

  // ---------- 播放卡死看护 ----------
  // 现象：点播签名链接约 10 分钟后失效，mpv 可能卡在缓冲态而不触发 end-file(error)，
  //       表现为"画面/进度不动、点播放没反应"。这里定时采样播放位置：长时间不推进且
  //       core 空闲(在缓冲)且非暂停/起播初期，则判定卡死，触发重新取流恢复。
  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => this._onWatchdogTick(), 2000);
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }
  _stopWatchdog() { try { if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; } } catch (_) {} }

  _onWatchdogTick() {
    try {
      if (!this.connected || this._dead || this._quitByUser || this._manualStop || this._refreshing) return;
      if (this._paused) { this._lastProgressAt = Date.now(); return; }
      // 起播头 30 秒（正常缓冲）不判卡死
      if (Date.now() - this._startTime < 30000) { this._lastProgressAt = Date.now(); return; }
      // 拖动进度条后长时间定位不结束（seeking 持续 true）：目标位置拉不到数据（签名失效），
      // 用更短阈值触发重新取流；恢复时 _timePosVal 已被 mpv 设为目标 seek 位置，正好续到该处。
      if (this._seeking) {
        const seekMs = Date.now() - (this._seekStartedAt || Date.now());
        const seekThreshold = this._isLive ? 12000 : 15000;
        if (seekMs < seekThreshold) return;
        this._reloadTries++;
        this.emit('log', 'seek stuck for ' + Math.round(seekMs / 1000) + 's (retry #' + this._reloadTries + '), re-signing + resume at '
          + (typeof this._timePosVal === 'number' ? Math.round(this._timePosVal) + 's' : '?'));
        this._reloadStream();
        return;
      }
      if (!this._coreIdle) return; // 核心非空闲（正常解码/渲染）
      if (this._reloadTries >= (this._isLive ? 30 : 8)) return;
      const frozenMs = Date.now() - this._lastProgressAt;
      const threshold = this._isLive ? 20000 : 45000; // 直播 20s、点播 45s 无推进
      if (frozenMs < threshold) return;
      this._reloadTries++;
      this.emit('log', 'playback stalled for ' + Math.round(frozenMs / 1000) + 's'
        + ' (retry #' + this._reloadTries + '), forcing recover');
      this._reloadStream();
    } catch (_) {}
  }

  // 断流/卡死恢复：点播优先让主进程重新签名取新鲜地址（飞牛 media/range 签名约 10 分钟失效），
  // 取不到则回放旧地址兜底；直播直接重连（分片/m3u8 会刷新）。
  async _reloadStream() {
    try {
      if (this._quitByUser || this._manualStop) return;
      // 记住断点（点播），file-loaded 后续播
      if (!this._isLive && typeof this._timePosVal === 'number' && this._timePosVal > 1) {
        this._resumePos = this._timePosVal;
      }
      if (this._isLive || !this._onNeedFreshUrl) {
        // 直播或无重新取流回调：回放原地址（直播分片刷新；点播兜底）
        await this.loadfile(this._lastUrl, this._lastHeaders, { isLive: this._isLive });
        return;
      }
      this._refreshing = true;
      this.emit('log', 'VOD stream invalid -> re-signing fresh url ...');
      let fresh = null;
      try { fresh = await this._onNeedFreshUrl(); } catch (e) { this.emit('log', 're-sign callback error: ' + (e && e.message)); }
      this._refreshing = false;
      if (this._quitByUser || this._manualStop) return;
      const url = (fresh && fresh.url) ? fresh.url : this._lastUrl;
      const headers = (fresh && fresh.headers) ? fresh.headers : this._lastHeaders;
      const isLive = fresh ? !!fresh.isLive : this._isLive;
      this.emit('log', 're-signed url ' + (fresh && fresh.url ? 'ok' : 'failed(fallback old)'));
      await this.loadfile(url, headers, { isLive });
    } catch (e) {
      this._refreshing = false;
      this.emit('log', 'reload stream failed: ' + (e && e.message));
    }
  }

  // 加载并播放（可带该媒体专属头）。opts: { isLive }
  async loadfile(url, headers, opts) {
    this._quitByUser = false;
    this._manualStop = false;
    this._lastUrl = url;
    this._lastHeaders = headers || null;
    this._isLive = !!(opts && opts.isLive);
    this._reloadTries = 0;
    this._refreshing = false;
    this._resumePos = undefined;
    this._lastTimePos = -1; this._lastProgressAt = Date.now(); this._coreIdle = false;
    const waitReady = this.connected ? Promise.resolve() :
      new Promise(res => this.once('ipc-ready', res));
    await waitReady;
    // 媒体级 http 头：通过 per-file option 传入（loadfile 的 options 仅支持部分，故用 property 兜底）
    if (headers && Object.keys(headers).length) {
      const fields = [];
      for (const [k, v] of Object.entries(headers)) {
        if (v) fields.push(`${k.replace(/^[\s]+|[\s]+$/g, '')}: ${String(v).replace(/,/g, ' ')}`);
      }
      if (fields.length) {
        try { await this.command(['set_property', 'options/http-header-fields', fields.join(',')]); } catch (_) {}
        const ua = headers['User-Agent'] || headers['user-agent'];
        if (ua) { try { await this.command(['set_property', 'user-agent', ua]); } catch (_) {} }
      }
    }
    await this.command(['loadfile', url, 'replace']);
    try { await this.command(['set_property', 'pause', false]); } catch (_) {}
  }

  play() { return this.command(['set_property', 'pause', false]).catch(() => {}); }
  pause() { return this.command(['set_property', 'pause', true]).catch(() => {}); }
  seek(sec) { return this.command(['seek', Number(sec) || 0, 'absolute']).catch(() => {}); }
  setVolume(v) { return this.command(['set_property', 'volume', Math.max(0, Math.min(130, Number(v) || 0))]).catch(() => {}); }

  // 运行时移动/缩放 mpv 原生窗口（屏幕物理像素坐标）
  // 联动三重保障（全部参数为字符串数字）：
  //   1) set_property geometry：mpv 运行时可移动+缩放窗口
  //   2) window-resize W H
  //   3) window-move X Y（注意：mpv window-move 只接受 <x> <y>，没有 absolute 子命令——多传会报 invalid parameter）
  setGeometry(g) {
    if (!g) return;
    this._geometry = g;
    const apply = () => {
      const x = String(Math.round(g.x)), y = String(Math.round(g.y));
      const w = String(Math.max(160, Math.round(g.width))), h = String(Math.max(90, Math.round(g.height)));
      const geoStr = `${w}x${h}+${x}+${y}`;
      this.command(['set_property', 'geometry', geoStr])
        .catch(e => this.emit('log', 'geometry set fail: ' + (e && e.message)));
      this.command(['window-resize', w, h])
        .catch(() => {});
      this.command(['window-move', x, y])
        .catch(() => {});
    };
    if (!this.connected) { this.once('ipc-ready', apply); return; }
    apply();
  }
  hideWindow() { return this.command(['set_property', 'visibility', 'no']).catch(() => {}); }
  showWindow() {
    if (!this.connected) return Promise.resolve();
    return Promise.resolve()
      .then(() => this.command(['set_property', 'visibility', 'yes']).catch(() => {}))
      .then(() => { if (this._geometry) this.setGeometry(this._geometry); });
  }

  // 置顶开关：偏好设置/对话框等应用子窗口激活时取消 mpv 置顶（否则无边框置顶窗会盖住设置页），
  // 子窗口关闭后恢复置顶。ontop 是 mpv 运行时可写属性。
  setOntop(on) {
    const apply = () => { this.command(['set_property', 'ontop', on ? 'yes' : 'no']).catch(() => {}); };
    if (!this.connected) { this.once('ipc-ready', apply); return; }
    apply();
  }

  stop() {
    this._manualStop = true;   // 主动停止：禁止崩溃自愈
    this._stopWatchdog();
    if (this.proc && !this._dead) {
      try { this.proc.kill(); } catch (_) {}
      // 强制兜底
      try { this.proc.kill('SIGKILL'); } catch (_) {}
    }
    this._dead = true;
    this.connected = false;
    this._closeSocket();
    this.proc = null;
  }
}

// ---------- 模块级单例（嵌入播放复用一个内核）----------
let _embedded = null;
function getEmbeddedPlayer() {
  if (!_embedded || _embedded._dead) _embedded = new MpvPlayer();
  return _embedded;
}

// ---------- 外部独立窗口播放（保留：直播/快捷场景）----------
let _externalProc = null;
function openMpv(url, headers, options = {}) {
  const exe = getMpvExe();
  if (!exe) return { ok: false, reason: '未找到内置 mpv.exe' };
  try {
    if (_externalProc) { try { _externalProc.kill(); } catch (_) {} _externalProc = null; }

    // 不传 --lang：shinchiro Windows 构建无该选项，传了会启动即退出(exit 1)。中文菜单走 config-dir 脚本。
    const args = ['--force-window=yes'];
    args.push(...getMpvConfigArgs());
    args.push(...hwDecodeArgs(options.hwDecode || 'auto'));
    args.push(...perfArgs());
    args.push(...buildCacheArgs(options.cacheLevel || 'smooth'));
    args.push('--network-timeout=60');
    args.push('--demuxer-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=10,reconnect_on_network_error=1');
    if (options.title) args.push(`--title=${options.title}`);

    // 外部窗口鉴权头：统一合并（UA/Referer/Cookie + 自定义 headers），避免重复 --http-header-fields 互相覆盖
    const hfMap = new Map();
    if (options.userAgent) hfMap.set('User-Agent', options.userAgent);
    if (options.referer) hfMap.set('Referer', options.referer);
    if (options.cookie) hfMap.set('Cookie', options.cookie);
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (v) hfMap.set(k, String(v));
      }
    }
    if (options.headers && typeof options.headers === 'object') {
      for (const [k, v] of Object.entries(options.headers)) {
        if (v) hfMap.set(k, String(v));
      }
    }
    if (hfMap.size) {
      const fields = [];
      for (const [k, v] of hfMap.entries()) fields.push(`${k}: ${String(v).replace(/,/g, ' ')}`);
      args.push(`--http-header-fields=${fields.join(',')}`);
    }
    if (options.extraArgs) args.push(...options.extraArgs);
    args.push(url);

    _externalProc = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    _externalProc.unref();
    _externalProc.on('exit', () => { _externalProc = null; });
    return { ok: true, reason: '', pid: _externalProc.pid };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

// ---------- 外部独立窗口播放的包装（供主进程 mpv:play / mpv:status 使用）----------
function getMpvInfo() {
  const exe = getMpvExe();
  if (!exe) return { available: false, reason: '未找到内置 mpv.exe', version: '', source: '' };
  let version = '';
  try {
    const r = spawnSync(exe, ['--version'], { windowsHide: true, timeout: 4000 });
    if (!r.error && r.stdout) { const m = /mpv[^\r\n]*v?(\d+\.\d+[\w.\-]*)/i.exec(r.stdout.toString()); if (m) version = m[1]; }
  } catch (_) {}
  return { available: true, reason: '', version, source: exe };
}

// 外部独立窗口播放（options: {title,isLive,volume,hwDecode,userAgent,referer,cookie}）
function play(url, options = {}) {
  const headers = {};
  if (options.cookie) headers['Cookie'] = options.cookie;
  if (options.referer) headers['Referer'] = options.referer;
  if (options.userAgent) headers['User-Agent'] = options.userAgent;
  const extraArgs = [];
  if (options.volume != null) extraArgs.push(`--volume=${Math.max(0, Math.min(130, Number(options.volume) || 0))}`);
  const res = openMpv(url, Object.keys(headers).length ? headers : null, {
    title: options.title || '飞牛影视',
    hwDecode: options.hwDecode || 'auto',
    cacheLevel: options.isLive ? 'smooth' : 'unlimited',
    extraArgs
  });
  return res;
}

function killAll() {
  try { if (_externalProc) { try { _externalProc.kill(); } catch (_) {} _externalProc = null; } } catch (_) {}
  try { if (_embedded && _embedded.isRunning()) _embedded.stop(); } catch (_) {}
}

module.exports = {
  MpvPlayer,
  getMpvExe,
  openMpv,
  getEmbeddedPlayer,
  buildCacheArgs,
  hwDecodeArgs,
  getMpvInfo,
  play,
  killAll
};
