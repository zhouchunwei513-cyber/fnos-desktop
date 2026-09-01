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
  }

  isRunning() { return !!this.proc && !this._dead; }

  // opts: { wid(Buffer/string 嵌入宿主HWND), headers{...}, cacheLevel, hwDecode, title, extraArgs }
  start(opts = {}) {
    const exe = getMpvExe();
    if (!exe) throw new Error('未找到内置 mpv.exe（resources/mpv/mpv.exe 缺失）');
    if (this.proc) this.stop();

    this._startOpts = opts;
    this._manualStop = false;
    this._dead = false;
    this.pipePath = `\\\\.\\pipe\\fnos-mpv-${process.pid}-${Date.now()}`;

    const args = ['--no-config', '--force-window=yes', '--idle=yes', '--terminal=no', '--msg-level=all=info'];

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

    this.proc.stdout?.on('data', d => {
      const s = d.toString();
      if (/error|fail|cannot|http.*40[0-9]|401|403/i.test(s)) this.emit('log', s.trim());
    });
    this.proc.stderr?.on('data', d => this.emit('log', d.toString().trim()));
    this.proc.on('error', err => { this.emit('log', 'spawn error: ' + err.message); });
    this.proc.on('exit', (code, sig) => {
      this._dead = true;
      this.connected = false;
      this._closeSocket();
      this.emit('exit', code, sig);
      // 崩溃自愈：播放中 mpv 进程意外退出（直播长时间运行偶发崩溃/被杀），自动重启内核并续播，
      // 避免画面冻结、点播放无效。主动 stop()/destroy() 会置 _manualStop，不触发自愈。
      if (!this._manualStop && this._lastUrl && this._restartTries < 6) {
        this._restartTries++;
        const delay = Math.min(4000, 800 * this._restartTries);
        this.emit('log', 'mpv process exited (' + (sig || code) + '), auto-restart #' + this._restartTries + ' in ' + delay + 'ms');
        setTimeout(() => {
          try {
            if (this._manualStop) return;
            const opts = Object.assign({}, this._startOpts || {});
            this.start(opts);
            // 等 IPC 就绪后续播上一个流（保留直播标记与鉴权头）
            const replay = () => {
              if (this._manualStop) return;
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
      if (id === 1) { this._paused = !!val; this.emit('pause', this._paused); }
      else if (id === 2) { if (typeof val === 'number') this.emit('time', val); }
      else if (id === 3) { if (typeof val === 'number' && val > 0) { this._duration = val; this.emit('duration', val); } }
      else if (id === 4) { if (val) this.emit('ended'); }
      else if (id === 6) { if (typeof val === 'number') { this._vol = val; this.emit('volume', val); } }
      else if (id === 7) { if (typeof val === 'number') this.emit('buffering', val); }
      return;
    }
    if (msg.event === 'file-loaded') { this._reloadTries = 0; this._restartTries = 0; this._lastLoadedAt = Date.now(); this.emit('loaded'); return; }
    if (msg.event === 'end-file') {
      const reason = msg.reason;
      // 出错(error) 或 直播流意外 eof：自动重载当前流（带退避，最多 8 次），避免退回待机画面
      // 注意：reason 'stop' 是主动 loadfile/stop 触发，不重连。
      const needReload = (reason === 'error') || (this._isLive && (reason === 'eof' || reason === 'redirect'));
      // 直播断流恢复机会更多：运营商 m3u8 分片滚动/偶发 404，需持续重连；上限放宽到 30 次。
      const maxTries = this._isLive ? 30 : 8;
      if (needReload && this._lastUrl && this._reloadTries < maxTries) {
        this._reloadTries++;
        const delay = Math.min(3000, 400 * this._reloadTries);
        this.emit('log', 'stream ' + reason + ', auto-reload #' + this._reloadTries + ' in ' + delay + 'ms');
        setTimeout(() => { try { this.loadfile(this._lastUrl, this._lastHeaders, { isLive: this._isLive }); } catch (_) {} }, delay);
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

  // 加载并播放（可带该媒体专属头）。opts: { isLive }
  async loadfile(url, headers, opts) {
    this._lastUrl = url;
    this._lastHeaders = headers || null;
    this._isLive = !!(opts && opts.isLive);
    this._reloadTries = 0;
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

    const args = ['--force-window=yes', '--no-config'];
    args.push(...hwDecodeArgs(options.hwDecode || 'auto'));
    args.push(...perfArgs());
    args.push(...buildCacheArgs(options.cacheLevel || 'smooth'));
    args.push('--network-timeout=60');
    if (options.title) args.push(`--title=${options.title}`);

    if (headers && Object.keys(headers).length) {
      const fields = [];
      for (const [k, v] of Object.entries(headers)) {
        if (v) fields.push(`${k.replace(/^[\s]+|[\s]+$/g, '')}: ${String(v).replace(/,/g, ' ')}`);
      }
      if (fields.length) args.push(`--http-header-fields=${fields.join(',')}`);
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

module.exports = { MpvPlayer, getMpvExe, openMpv, getEmbeddedPlayer, buildCacheArgs, hwDecodeArgs };
