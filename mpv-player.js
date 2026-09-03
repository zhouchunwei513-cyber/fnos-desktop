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
  live: {     // 直播轻量：约 16MB / 20s 预读（N100 双路场景给直播用，demuxer 负担/内存占用最低，够抗短抖动即可）
    cache: 'yes',
    'demuxer-max-bytes': '16MiB',
    'demuxer-max-back-bytes': '8MiB',
    'demuxer-readahead-secs': '20',
    'cache-secs': '20',
    'cache-pause': 'yes',
    'cache-pause-initial': 'yes',
    'cache-pause-wait': '1.2'
  },
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
    '--hdr-compute-peak=no',
    // N100 双路 4K 弱机减负：音频统一按立体声处理，避免多声道上混/重采样的额外 CPU 开销。
    // 注意：不要加 --vf=clr —— "clr" 只能作为运行时命令(vf clr)，写在命令行里会被当成滤镜名，
    // mpv 报 "Option vf: 'clr' isn't supported" 致命错误、启动即 exit 1（默认本就无滤镜链，无需清）。
    '--audio-channels=stereo'
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
    this._eofReached = false;  // mpv eof-reached 属性
    this._buffering = 100;     // cache-buffering-state（<100 表示正在缓冲）
    this._userPause = false;   // 是否为"用户主动暂停"（区别于 keep-open 提前 EOF 的自动暂停）
    this._fileLoadedAt = 0;    // 最近一次 file-loaded 时间戳（起播宽限基准）
    this._loadStartAt = 0;     // loadfile 发起时间戳（file-loaded 前的宽限基准）
    this._earlyEofTries = 0;   // 点播提前 EOF 恢复次数
    this._resumeTargetAt = 0;  // 续播定位目标秒数；播放越过该位置+5s 判定续播成功并重置计数
    this._lastRecoverAt = 0;   // 最近一次自动恢复时间戳（恢复冷却，防重复触发）
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
    // 重置 IPC 就绪 promise（新进程/新管道）
    this.connected = false;
    this._readyPromise = null;
    this._resolveReady = null;
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
      `--log-file=${this._logFilePath}`
    ];
    // 内置中文右键菜单 / 配置（--config-dir 指向随包隔离目录，替代 --no-config；
    // 该目录下的 mpv.conf + scripts/fnos-menu.lua 提供中文右键菜单，不读用户全局配置）
    args.push(...getMpvConfigArgs());
    // v1.29.2 关键：Windows 构建默认【不加载】内置 @context_menu.lua（Windows 走原生 menu.conf，
    // 而我们没有提供 menu.conf，原生菜单为空），导致 fnos-menu.lua 发出的
    // 'script-message context_menu open' 没有任何监听者——右键绑定触发了却无菜单可弹。
    // 这里强制加载内置 OSD 上下文菜单脚本（它会监听 context_menu open 并读取 menu-data 渲染中文菜单）。
    args.push('--load-context-menu=yes');
    // 把 lua 日志级别从 warn 提到 info，便于在 fnos-mpv.log 里确认菜单脚本/内置脚本是否成功加载
    args.push('--msg-level=ffmpeg=v,stream=v,demuxer=v,stream-lavf=v,lua=info,ass=warn');
    // 直播/HTTP 断流自动重连（交给 ffmpeg 内建重试，覆盖短抖动；长期断链仍由应用层重新取流兜底）
    // reconnect_retries/on_http_error：NAS 中途断开长连接（partial file）时让 ffmpeg 多试几次断点续传，
    // 而不是很快放弃触发"提前 EOF"。
    // 注意：reconnect_on_http_error 的值(如 4xx,5xx)含逗号，会被 mpv 当成 demuxer-lavf-o 的
    // 选项分隔符，这里不传（默认已覆盖 404/429/500/503）。其余键值用逗号分隔即可。
    args.push('--demuxer-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_at_eof=1,reconnect_on_network_error=1,reconnect_delay=2,reconnect_delay_max=15,reconnect_retries=8');

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
        // mpv --geometry=WxH+X+Y（屏幕像素）。运行时跟随主窗口移动/缩放统一用 set_property
        // geometry（shinchiro 构建没有 window-resize/window-move 命令）。
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

    // 缓存/预读（消卡顿核心）。嵌入共用进程：点播用用户档位（默认 smooth），
    // 直播用轻量 live 档（N100 双路时直播 demuxer 负担/内存最低，20s 缓冲足够抗运营商抖动）。
    const effectiveCache = (opts.isLive && !opts.cacheLevel) ? 'live' : (opts.cacheLevel || 'smooth');
    args.push(...buildCacheArgs(effectiveCache));

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
      // 把本地助手服务地址经环境变量透传给 mpv 内的 lua（中文右键菜单在线字幕/本地字幕/画中画用）。
      // lua 用 os.getenv 读取，再经 Windows 自带 curl.exe 调用 127.0.0.1，仅回环、带 token。
      const childEnv = Object.assign({}, process.env);
      try {
        const g = (typeof global !== 'undefined') ? global : {};
        if (g.__mpvHelperPort) childEnv.FNOS_MPV_HELPER_PORT = String(g.__mpvHelperPort);
        if (g.__mpvHelperToken) childEnv.FNOS_MPV_HELPER_TOKEN = String(g.__mpvHelperToken);
      } catch (_) {}
      this.proc = spawn(exe, args, { windowsHide: false, env: childEnv });
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

  // 返回一个在 IPC 就绪后 resolve 的 Promise；用缓存 promise 而非 once('ipc-ready')，
  // 避免"事件已触发、监听才注册"的竞态导致 loadfile 永不发送（mpv 停在待机画面）。
  _whenReady() {
    if (this.connected) return Promise.resolve();
    if (!this._readyPromise) {
      this._readyPromise = new Promise(resolve => { this._resolveReady = res; });
    }
    return this._readyPromise;
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
      // 缓存的 ready promise 先 resolve，再发事件，避免调用方晚于事件注册监听而永久挂起
      if (this._resolveReady) { try { this._resolveReady(); } catch (_) {} this._resolveReady = null; }
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
      if (id === 1) {
        this._paused = !!val;
        // 区分用户暂停与 keep-open 自动暂停：若暂停时已 eof（提前 EOF 自动暂停），不算用户意图。
        if (val) { if (!this._eofReached) this._userPause = true; }
        else { this._userPause = false; this._lastProgressAt = Date.now(); }
        this.emit('pause', this._paused);
      }
      else if (id === 2) {
        if (typeof val === 'number') {
          this._timePosVal = val;
          // 续播成功确认：新流已定位到断点并继续往后播（越过断点 5s），
          // 说明本次恢复真正生效——重置提前 EOF 计数，允许后续再次断流时继续恢复（长时间播放 NAS 可能多次断连）。
          if (this._resumeTargetAt && val > this._resumeTargetAt + 5) {
            this._resumeTargetAt = 0;
            this._earlyEofTries = 0;
          }
          // 播放位置在推进：刷新"最后推进时间"，卡死看护据此判断是否真的卡住
          if (this._lastTimePos < 0 || Math.abs(val - this._lastTimePos) > 0.01) {
            this._lastTimePos = val; this._lastProgressAt = Date.now();
          }
          this.emit('time', val);
        }
      }
      else if (id === 3) { if (typeof val === 'number' && val > 0) { this._duration = val; this.emit('duration', val); } }
      else if (id === 4) {
        this._eofReached = !!val;
        if (val) {
          this._userPause = false; // 提前 EOF 时的暂停是 keep-open 自动暂停，非用户主动
          this.emit('ended');
          this._handlePrematureEof();
        }
      }
      else if (id === 5) { this._coreIdle = !!val; }
      else if (id === 6) { if (typeof val === 'number') { this._vol = val; this.emit('volume', val); } }
      else if (id === 7) { this._buffering = (typeof val === 'number') ? val : 0; this.emit('buffering', this._buffering); }
      else if (id === 8) {
        // seeking：拖动进度条时为 true。仅记录状态，卡顿统一交给 watchdog 的
        // "core-idle + 无进度 + 过了起播宽限"判定，避免起播缓冲误报 seek stuck。
        const was = !!this._seeking;
        this._seeking = !!val;
        if (this._seeking && !was) this._seekStartedAt = Date.now();
        if (!this._seeking) this._seekStartedAt = 0;
      }
      return;
    }
    if (msg.event === 'file-loaded') {
      this._reloadTries = 0; this._restartTries = 0;
      this._startupTries = 0; // 起播确认成功，清掉 startup watchdog 计数
      if (this._startupTimer) { clearTimeout(this._startupTimer); this._startupTimer = null; }
      this._lastLoadedAt = Date.now();
      this._fileLoadedAt = Date.now(); // 起播宽限计时基准（loadfile 时也会重置）
      this._lastTimePos = -1; this._lastProgressAt = Date.now(); this._coreIdle = false;
      this._eofReached = false; this._seeking = false; this._seekStartedAt = 0;
      this._buffering = 100; this._recoveringStall = false;
      // 点播续播：崩溃自愈/重新取流后续播到断点。HTTP 上的 MKV 首次 seek 可能因索引/关键帧
      // 尚未就绪而失败，这里做"seek→校验位置→必要时重试"，确保真正回到断点而不是从头播。
      if (typeof this._resumePos === 'number' && this._resumePos > 1 && !this._isLive) {
        const target = this._resumePos;
        const trySeek = (attempt) => {
          try {
            this.seek(target);
            if (attempt < 3) {
              setTimeout(() => {
                const cur = (typeof this._timePosVal === 'number') ? this._timePosVal : 0;
                // 位置离目标差 6s 以上 = 上一次 seek 没到位，重试
                if (Math.abs(cur - target) > 6 && !this._quitByUser && !this._manualStop) trySeek(attempt + 1);
              }, attempt === 0 ? 700 : 1600);
            }
          } catch (_) {}
        };
        trySeek(0);
        this._resumeTargetAt = target; // time-pos 越过断点 5s 即判定续播成功，重置 earlyEof 计数
        this.emit('log', 'resume seek to ' + Math.round(target) + 's after re-load');
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
  // ---------- 起播确认看护（修复"打开 MKV 停在 mpv 待机画面（Drop files or URLs）"）----------
  // 现象：loadfile 已发出，但因首包 4xx/解封装失败/地址未就绪等原因 mpv 没能 file-loaded，
  //       end-file(error) 在极少数情况下也未触发自动恢复，mpv 保持 idle 待机画面（看似"没播放"）。
  // 这里在起播宽限窗口结束后若仍未 file-loaded，则按断流恢复流程重试（点播会重新签名取地址）。
  _armStartupWatchdog() {
    try {
      if (this._startupTimer) { clearTimeout(this._startupTimer); this._startupTimer = null; }
      this._startupTries = this._startupTries || 0;
      // 起播宽限：网络较慢/大文件解封装，给 20s；超过仍未 loaded 才介入
      const graceMs = (this._isLive ? 18000 : 20000);
      this._startupTimer = setTimeout(() => {
        this._startupTimer = null;
        try {
          if (this._dead || this._quitByUser || this._manualStop || this._refreshing) return;
          // 已经成功加载（file-loaded 触发后会置 _fileLoadedAt）或已经在播放有位置推进：健康
          if (this._fileLoadedAt) return;
          // 直播允许更多重试（m3u8 偶发首包失败）；点播 3 次
          const max = this._isLive ? 6 : 3;
          if (this._startupTries >= max) {
            this.emit('log', 'startup watchdog gave up after ' + max + ' tries (no file-loaded)');
            return;
          }
          this._startupTries++;
          this._userPause = false;
          this.emit('log', 'startup watchdog: no file-loaded after ' + Math.round(graceMs / 1000)
            + 's (idle screen?), recover retry #' + this._startupTries);
          this._reloadStream();
        } catch (_) {}
      }, graceMs);
      if (this._startupTimer.unref) this._startupTimer.unref();
    } catch (_) {}
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => this._onWatchdogTick(), 2000);
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }
  _stopWatchdog() { try { if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; } } catch (_) {} }

  _onWatchdogTick() {
    try {
      if (!this.connected || this._dead || this._quitByUser || this._manualStop || this._refreshing) return;
      // 用户主动暂停（点了暂停按钮/菜单项）才算健康暂停；
      // 注意：--keep-open=yes 在提前 EOF/断流时会让 mpv "自动暂停"（用户没点过暂停），
      // 这种暂停绝不能当作健康，否则卡死永不恢复。
      if (this._paused && this._userPause) return;
      // 起播宽限：以 file-loaded 时刻为基准（loadfile 即重置），避开正常缓冲误判。
      const anchor = this._fileLoadedAt || this._loadStartAt || this._startTime;
      if (anchor && Date.now() - anchor < (this._isLive ? 25000 : 30000)) { this._lastProgressAt = Date.now(); return; }
      // 播放位置在推进（解码在跑）：一切正常，刷新健康时间戳。
      // 拖进度条定位完成后 time-pos 会跳到目标位置，同样算"有进展"，不再做脆弱的 seeking 时长判断。
      if (typeof this._timePosVal === 'number' && this._lastTimePos >= 0 && this._timePosVal > this._lastTimePos) {
        this._lastProgressAt = Date.now();
      }
      if (!this._coreIdle) { this._lastProgressAt = Date.now(); return; } // 核心非空闲（正常解码/渲染）
      if (this._reloadTries >= (this._isLive ? 30 : 8)) return;
      const frozenMs = Date.now() - this._lastProgressAt;
      const threshold = this._isLive ? 20000 : 40000; // 直播 20s、点播 40s 无推进
      if (frozenMs < threshold) return;
      this._reloadTries++;
      this.emit('log', 'playback stalled for ' + Math.round(frozenMs / 1000) + 's'
        + ' (paused=' + this._paused + ',eof=' + this._eofReached + ',retry #' + this._reloadTries + '), forcing recover');
      this._reloadStream();
    } catch (_) {}
  }

  // 点播提前 EOF：HTTP 长连接被服务端中途断开、lavf 重连耗尽后，mpv 在远未到片尾时
  // 触发 eof-reached（配合 keep-open 自动暂停）。表现为"播着播着停住、点播放没反应、
  // 拖进度条画面只动一下"。此时若进度明显未到 duration，则重新签名取流并续播到断点。
  _handlePrematureEof() {
    try {
      if (this._isLive || this._quitByUser || this._manualStop || this._refreshing) return;
      if (this._earlyEofTries >= 8) return;
      const pos = (typeof this._timePosVal === 'number') ? this._timePosVal : 0;
      // duration 已知且离片尾还差 10s 以上 = 非正常播完；duration 未知则交给卡死看护兜底。
      if (!(this._duration > 0 && pos < this._duration - 10)) return;
      this._earlyEofTries++;
      this.emit('log', 'premature EOF at ' + Math.round(pos) + 's / ' + Math.round(this._duration)
        + 's (retry #' + this._earlyEofTries + '), re-signing + resume');
      this._reloadStream();
    } catch (_) {}
  }

  // 断流/卡死恢复：点播优先让主进程重新签名取新鲜地址（飞牛 media/range 签名约 10 分钟失效），
  // 取不到则回放旧地址兜底；直播直接重连（分片/m3u8 会刷新）。
  async _reloadStream() {
    try {
      if (this._quitByUser || this._manualStop) return;
      // 恢复冷却：提前 EOF 事件与卡死看护可能在同一时段先后触发，8s 内只恢复一次。
      const now = Date.now();
      if (now - (this._lastRecoverAt || 0) < 8000) return;
      this._lastRecoverAt = now;
      // 记住断点（点播），file-loaded 后续播
      if (!this._isLive && typeof this._timePosVal === 'number' && this._timePosVal > 1) {
        this._resumePos = this._timePosVal;
      }
      // 重新取流期间强制让 mpv 退出自动暂停态（keep-open 在 EOF 时会暂停），
      // 否则新流加载后仍暂停，表现为"点播放没反应"。
      this._userPause = false;
      const recoverOpts = { isLive: this._isLive, recover: true };
      if (this._isLive || !this._onNeedFreshUrl) {
        // 直播或无重新取流回调：回放原地址（直播分片刷新；点播兜底）。recover=true 保留断点。
        await this.loadfile(this._lastUrl, this._lastHeaders, recoverOpts);
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
      // recover=true：保留 _resumePos，让新流 file-loaded 后 seek 回断点（否则从头播=循环）。
      await this.loadfile(url, headers, { isLive, recover: true, resumePos: this._resumePos });
    } catch (e) {
      this._refreshing = false;
      this.emit('log', 'reload stream failed: ' + (e && e.message));
    }
  }

  // 加载并播放（可带该媒体专属头）。opts: { isLive, recover, resumePos }
  // recover=true 表示这是断流恢复（重新签名/重连）：保留 _resumePos，新流 file-loaded 后 seek 回断点，
  // 不能像"打开新视频"那样把断点清空（否则恢复后会从头播放，表现为播一段时间就回到开头循环）。
  async loadfile(url, headers, opts) {
    this._quitByUser = false;
    this._manualStop = false;
    this._lastUrl = url;
    this._lastHeaders = headers || null;
    this._isLive = !!(opts && opts.isLive);
    this._reloadTries = 0;
    this._refreshing = false;
    const recover = !!(opts && opts.recover);
    if (recover) {
      // 恢复场景：若显式带了 resumePos 就采用，否则沿用 _reloadStream 已记录的断点；
      // 点播兜底（旧地址重连）同样要保留断点。
      if (typeof (opts && opts.resumePos) === 'number' && opts.resumePos > 1) this._resumePos = opts.resumePos;
      // 不重置 _earlyEofTries（新流若再提前 EOF 仍需受上限保护），其余进度状态照常刷新。
    } else {
      this._resumePos = undefined;
      this._earlyEofTries = 0;
    }
    this._lastTimePos = -1; this._lastProgressAt = Date.now(); this._coreIdle = false;
    this._eofReached = false; this._userPause = false; this._seeking = false; this._seekStartedAt = 0;
    this._loadStartAt = Date.now(); this._fileLoadedAt = 0;
    this._buffering = 100;
    this._armStartupWatchdog();
    const waitReady = this.connected ? Promise.resolve() : this._whenReady();
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

  play() { this._userPause = false; return this.command(['set_property', 'pause', false]).catch(() => {}); }
  pause() { this._userPause = true; return this.command(['set_property', 'pause', true]).catch(() => {}); }
  seek(sec) { return this.command(['seek', Number(sec) || 0, 'absolute']).catch(() => {}); }
  setVolume(v) { return this.command(['set_property', 'volume', Math.max(0, Math.min(130, Number(v) || 0))]).catch(() => {}); }

  // 运行时移动/缩放 mpv 原生窗口（屏幕物理像素坐标）
  // 注意：shinchiro Windows 构建（gpu-next）【没有】 window-resize / window-move 命令，
  // 调用只会刷 "Command not found" 错误日志。运行时统一用可写的 geometry 属性
  // （格式 WxH+X+Y，屏幕像素），--geometry 与它一致，窗口位置/尺寸都能联动。
  setGeometry(g) {
    if (!g) return;
    this._geometry = g;
    const apply = () => {
      const x = String(Math.round(g.x)), y = String(Math.round(g.y));
      const w = String(Math.max(160, Math.round(g.width))), h = String(Math.max(90, Math.round(g.height)));
      const geoStr = `${w}x${h}+${x}+${y}`;
      // 与上次实际下发的几何一致就不重复发 IPC（500ms 轮询会频繁调用，去抖减少主线程/IPC 负担）
      if (this._lastGeoStr === geoStr) return;
      this._lastGeoStr = geoStr;
      this.command(['set_property', 'geometry', geoStr])
        .catch(e => this.emit('log', 'geometry set fail: ' + (e && e.message)));
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
    // 注意：reconnect_on_http_error 的值(如 4xx,5xx)含逗号，会被 mpv 当成 demuxer-lavf-o 的
    // 选项分隔符，这里不传（默认已覆盖 404/429/500/503）。其余键值用逗号分隔即可。
    args.push('--demuxer-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_at_eof=1,reconnect_on_network_error=1,reconnect_delay=2,reconnect_delay_max=15,reconnect_retries=8');
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

    const _extEnv = Object.assign({}, process.env);
    try {
      if (global.__mpvHelperPort) _extEnv.FNOS_MPV_HELPER_PORT = String(global.__mpvHelperPort);
      if (global.__mpvHelperToken) _extEnv.FNOS_MPV_HELPER_TOKEN = String(global.__mpvHelperToken);
    } catch (_) {}
    _externalProc = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: _extEnv
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
    cacheLevel: options.isLive ? 'live' : 'unlimited',
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
