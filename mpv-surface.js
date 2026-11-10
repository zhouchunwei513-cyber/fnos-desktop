'use strict';

// mpv-surface.js —— 应用内"视觉嵌入"播放层
// 采用 fntv 同款：mpv 自己的原生窗口（无边框、置顶、自带 OSC、可拖动），
// 但用屏幕坐标几何定位覆盖到宿主窗口的视频区域，随父窗移动/缩放跟随。
// 相比 Electron 透明覆盖窗 + --wid 的方案，原生窗口没有渲染层级/输入冲突，OSC、键盘、拖动全部可用。
//
// dipRect: 视频区相对【宿主内容区】的 DIP 坐标 {x,y,width,height}
// viewOffset: <webview> 在宿主页面内的偏移（标题栏等），DIP，{x,y}

const mpvMod = require('./mpv-player');

// ===== v5.1.23：macOS 覆盖窗几何基础设施 =====
// 真机事实：mac 版 mpv 没有 window-move / window-resize；运行期 set_property geometry 只写属性、
// 窗口不动。窗口位置只在 spawn 时由 --geometry 决定。因此 mac 上要「严丝合缝」只有两条路：
//   ① 启动时把坐标换算成 mpv/cocoa 认可的原点（本文件 _macMpvGeometry）；
//   ② 播放区矩形发生显著变化后，带新 --geometry 重启 mpv（_maybeRestartForGeometry）。
// 另加一条只读量尺：CGWindowList 取 mpv 窗口真实屏幕矩形（不需要辅助功能/录屏授权），
// 用来在真机上量化「期望 vs 实际」，并给首次启动做自校准。
const { execFile: __execFile } = require('child_process');

function __execOut(file, args, timeout) {
  return new Promise((resolve) => {
    try {
      __execFile(file, args, { timeout: timeout || 2500, maxBuffer: 1 << 20 }, (err, stdout) => {
        resolve(err ? '' : String(stdout || ''));
      });
    } catch (_) { resolve(''); }
  });
}

let __macCgBroken = false;
// 用 mpv 自己的 pid 选窗口，避免页面上同时存在多个 mpv（独立窗/残留）时量错。
async function __macWindowRectByPid(pid) {
  if (process.platform !== 'darwin' || !pid) return null;
  if (!__macCgBroken) {
    const js = "ObjC.import('CoreGraphics');\n"
      + "var list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID)) || [];\n"
      + "var out = null;\n"
      + "for (var i = 0; i < list.length; i++) {\n"
      + "  var w = list[i] || {};\n"
      + "  if (Number(w.kCGWindowOwnerPID) === " + Number(pid) + " && Number(w.kCGWindowLayer) === 0) {\n"
      + "    var b = w.kCGWindowBounds || {};\n"
      + "    var x = Number(b.X), y = Number(b.Y), ww = Number(b.Width), hh = Number(b.Height);\n"
      + "    if (isFinite(x) && isFinite(y) && ww > 1 && hh > 1) { out = {x:x,y:y,width:ww,height:hh,src:'cg'}; break; }\n"
      + "  }\n"
      + "}\n"
      + "JSON.stringify(out);";
    const out = await __execOut('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], 3000);
    try {
      const o = JSON.parse(String(out).trim() || 'null');
      if (o && o.width > 1) return o;
    } catch (_) { __macCgBroken = true; }
  }
  // 兜底：System Events（需要「辅助功能」授权；adhoc 重签会让授权失效，故仅作兜底）
  const se = 'tell application "System Events" to tell (first process whose unix id is ' + Number(pid)
    + ') to get {position of window 1, size of window 1}';
  const out2 = await __execOut('/usr/bin/osascript', ['-e', se], 2500);
  const m = /\{\s*(-?\d+)\s*,\s*(-?\d+)\s*\},\s*\{\s*(\d+)\s*,\s*(\d+)\s*\}/.exec(out2);
  if (m) return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]), src: 'se' };
  return null;
}

let __macGeomCache = null;
function __macGeomPath() {
  try {
    const { app } = require('electron');
    return require('path').join(app.getPath('userData'), 'mpv-mac-geom.json');
  } catch (_) { return ''; }
}
function __loadMacGeom() {
  if (__macGeomCache) return __macGeomCache;
  let o = null;
  try { const f = __macGeomPath(); if (f) o = JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch (_) {}
  // v5.1.24（真机实测）：mac 上 --geometry 的 y 语义既不是纯左上也不是纯左下，
  // 实测「期望 (620,100,980,730) → 实际窗口 (620,130,980,730)」= **恒定 +30px 垂直偏移**，
  // x/宽/高 全部精确。30px 正是 mpv 窗口自带的那条头部（--border=no 也去不掉）。
  // 自校准本应把这 30px 学出来，但真机上 CGWindowList 量不到窗口（日志 `mpv.calib.nomeasure`），
  // 于是永远停在默认值。这里把实测值直接写进默认：adjY=-30。
  // 若将来校准能量到窗口，它会覆盖这里的值。
  __macGeomCache = Object.assign({ mode: 'top', adjX: 0, adjY: -30, adjW: 0, adjH: 0, calibBroken: true }, (o && typeof o === 'object') ? o : {});
  return __macGeomCache;
}
function __saveMacGeom(g) {
  // 原地更新：多个 surface（主窗/直播窗）可能共享同一个缓存对象，替换引用会让它们各说各话。
  if (!__macGeomCache) __macGeomCache = {};
  Object.assign(__macGeomCache, g);
  try {
    const f = __macGeomPath();
    if (!f) return;
    require('fs').mkdirSync(require('path').dirname(f), { recursive: true });
    require('fs').writeFileSync(f, JSON.stringify(__macGeomCache, null, 2));
  } catch (_) {}
}

// v5.1.4：本模块的 mac 真机诊断日志（与 main.js 的 [MACDIAG] 同格式，直接落 fnos-diag.log）
let __mkLogPath = '';
function __mk(event, extra) {
  try {
    if (!__mkLogPath) {
      const path = require('path');
      __mkLogPath = path.join(require('electron').app.getPath('userData'), 'logs', 'fnos-diag.log');
    }
    let line = `[MACDIAG] ${event}`;
    if (extra !== undefined && extra !== null) {
      try { line += ' ' + JSON.stringify(extra); } catch (_) { line += ' ' + String(extra); }
    }
    require('fs').appendFileSync(__mkLogPath, `[FNOS] ${new Date().toISOString()} ${line}\n`);
  } catch (_) {}
}

class MpvSurface {
  // parentWin: 宿主 BrowserWindow；dipRect: 视频区（相对内容区 DIP）
  // opts.standalone: true 表示【独立播放器窗口】（菜单"用 mpv 打开"）。与嵌入覆盖窗不同：
  //   - 窗口无边框但【不置顶、不绑定父窗几何、可自由移动/缩放/双击全屏】，任务栏可见；
  //   - 仍走 IPC，故画中画/字幕/弹幕/倍速等中文菜单功能全部可用；
  //   - 画中画时缩到屏幕右下角并置顶，退出时还原到画中画前的窗口几何（而不是贴合视频区）。
  constructor(parentWin, dipRect, opts = {}) {
    this.parent = parentWin;
    this.parentId = (parentWin && parentWin.id) || 0;
    this._dead = false;
    this._standalone = !!opts.standalone;
    // v2.15.93：宿主窗口标题栏高度（主窗口 36px、应用/直播窗 34px），
    // 用于把 mpv 顶边对齐到标题栏下方（见 _computeScreenGeometry 的双向对齐）。
    this._titlebarHeight = opts.titlebarHeight || 34;
    this.viewOffset = { x: opts.viewOffsetX || 0, y: opts.viewOffsetY || 0 };
    this.dipRect = dipRect || { x: 0, y: 0, width: 800, height: 450 };
    this.player = new mpvMod.MpvPlayer({ standalone: this._standalone });
    // v2.15.88：mpv 窗口所在显示器的 DPI 缩放（SetWindowRgn 圆角物理像素换算用）
    this._scaleFactor = 1;
    try {
      const { screen } = require('electron');
      const b = (parentWin && !parentWin.isDestroyed()) ? parentWin.getBounds() : null;
      const d = b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay();
      this._scaleFactor = (d && d.scaleFactor) || 1;
    } catch (_) {}
    this._started = false;
    this._startSettings = opts.settings || {};
    this._onNeedFreshUrl = (typeof opts.onNeedFreshUrl === 'function') ? opts.onNeedFreshUrl : null;
    // v2.21.0：字幕样式回采回调（用户拖动字幕/调字号后由主进程落盘，下次起播沿用）
    this._onSubStyle = (typeof opts.onSubStyle === 'function') ? opts.onSubStyle : null;
    this._pollTimer = null;
    this._lastBoundsKey = '';
    // v2.15.89：resize 比例兜底基准。记录上次对齐时的内容区宽高与 dipRect，
    // 用于宿主窗口缩放时，若 guest 的 reportRect 尚未同步上报新视频区坐标，则按
    // 内容区宽高变化比例就地缩放 dipRect 的 width/height，保证 MPV 跟随窗口缩放。
    this._baseCbW = 0;
    this._baseCbH = 0;
    this._baseDip = null;
    // 画中画状态：小窗时脱离视频区几何跟随，固定右下角小尺寸、保持置顶、可自由拖动。
    this._pip = false;
    // v3.0.71（用户反馈「MPV 前置等级太高」）：是否已把 mpv 挂成宿主窗口的从属窗口。
    // 挂上之后层级由 Windows 的 owner 关系保证（恒在宿主之上、不压别的程序/任务栏），
    // 不再用 ontop(topmost)；只有全屏/画中画时才临时切回真置顶。
    this._ownerOk = false;
    // v2.17.54：宿主窗口是否处于全屏（窗口级全屏或网页 HTML 全屏）。全屏时 mpv 铺满整屏，
    // 且不再做"标题栏 34px 下压"（全屏没有标题栏）；退出全屏自动回到按视频区跟随。
    this._hostFs = false;
    // v2.17.56：每次进入全屏只打一条 embed.fs.geo（显示器 bounds vs 宿主内容区），便于定位偏差
    this._fsGeoLogged = false;
    // v2.17.54：进入全屏前的视频区坐标/偏移快照。全屏期间 guest 会上报铺满视口的 rect，
    // 若不快照恢复，退出全屏后会停在全屏尺寸，直到下一次 reportRect 才纠正（表现为不还原）。
    this._fsSavedDip = null;
    this._fsSavedView = null;
    this._pipSavedGeo = null;
    // 独立窗口画中画：保存进入小窗前 mpv 自身的窗口几何（屏幕 DIP），退出时精确还原
    this._pipSavedWin = null;
    // v5.1.23（mac 覆盖窗贴合）：坐标换算参数 / 自校准 / 显著变化重启
    this._macGeom = (process.platform === 'darwin') ? __loadMacGeom() : null;
    this._geomAtSpawn = null;     // 本次 spawn 时的期望矩形（Electron 顶左原点，屏幕 DIP）
    this._spawnGeo = null;        // 本次真正交给 mpv --geometry 的矩形（已换算）
    this._macCalibPromise = null;
    this._restartTimer = null;
    this._restarting = false;
    this._sigAt = 0;
    this._lastPlay = null;
    this._coreHooked = false;
    this._ownerHooked = false;
    if (this._macGeom) {
      try {
        const __d = this._hostDisplay();
        const __k = this._macDisplayKey(__d);
        if (this._macGeom.displayKey && this._macGeom.displayKey !== __k) {
          // 换了显示器（分辨率/缩放变了）→ 旧的常量修正不可信，重新校准
          this._macGeom.adjX = 0; this._macGeom.adjY = 0; this._macGeom.adjW = 0; this._macGeom.adjH = 0;
        }
        this._macGeom.displayKey = __k;
      } catch (_) {}
    }
    // 注：log/end-file/exit 监听由 main.js（embedMpvPlay）统一绑定，这里不重复绑定。

    // 独立窗口：不跟随父窗、不绑定父窗生命周期（由 main.js 在 mpv 退出时回收）。
    // v1.49.0：移除 v1.48 的"拖回自动吸附"——它会把独立 mpv 窗口强制 resize 成整个主窗口
    // 尺寸覆盖上去，挡住飞牛界面操作。独立窗口应始终保持独立、可自由拖动/缩放。
    if (this._standalone) {
      this._start();
      return;
    }

    // 父窗移动/缩放/最小化时跟随
    if (parentWin && !parentWin.isDestroyed()) {
      // v1.63：嵌入 mpv 虽常驻 ontop，但宿主窗口拖动/激活时偶尔会被系统提到 mpv 之上
      // （mpv 跑到飞牛窗口后面被盖住）。移动结束/恢复/首帧后强制重新置顶 mpv 一次。
      // v3.0.77（用户工单：MPV 前置等级太高，要跟随宿主窗层级）——
      // 旧实现在宿主每次 move/resize/focus/show/loaded 时都无条件 setOntop(true)，等于把 mpv
      // 一次次重新打成系统级 topmost（HWND_TOPMOST），把微信/桌面/任务栏全压在下面，v3.0.71
      // 辛苦挂上的 owner 从属关系等于白挂——这就是「前置等级还没改过来」的直接原因。
      // 现在 owner 已挂上时改走 _applyTopPolicy()：常规窗口化播放 ontop=no，靠 Windows 的
      // owned-window 规则保证「恒在宿主之上、但不会盖住别的程序」；只有画中画 / 宿主全屏
      // 这两种本来就要盖住任务栏的场景才真正置顶。
      this._raiseMpv = () => {
        try {
          if (!this.player || !this.player.isRunning() || this._pip || this._docked) return;
          if (this._ownerOk && !this._standalone) { this._applyTopPolicy(); return; }
          this.player.setOntop(true);
        } catch (_) {}
      };
      this._moveHandler = () => { this._trackTransit('move', 700); this._burstRect(400); this._applyGeometry(); this._raiseMpv(); try { if (!this._chasing) this._chase(8); } catch (_) {} };
      this._resizeHandler = () => { this._trackTransit('resize', 900); this._burstRect(700); this._applyGeometry(); this._raiseMpv(); try { if (!this._chasing) this._chase(12); } catch (_) {} };
      this._minHandler = () => { try { this.player.hideWindow(); } catch (_) {} };
      this._restoreHandler = () => { try { this.player.showWindow(); this._applyGeometry(); } catch (_) {} this._raiseMpv(); };
      // v1.48.0：父窗被一键隐藏/锁定（hide）/重新呼出（show）时，嵌入 mpv 原生窗口也要跟随，
      // 否则主窗隐藏后播放器仍停留在屏幕上。
      this._hideHandler = () => { try { this.player.hideWindow(); } catch (_) {} };
      this._showHandler = () => { try { this.player.showWindow(); this._applyGeometry(); } catch (_) {} this._raiseMpv(); };
      this._closedHandler = () => this.destroy();
      parentWin.on('move', this._moveHandler);
      parentWin.on('resize', this._resizeHandler);
      parentWin.on('minimize', this._minHandler);
      parentWin.on('restore', this._restoreHandler);
      parentWin.on('hide', this._hideHandler);
      parentWin.on('show', this._showHandler);
      parentWin.on('focus', this._raiseMpv);
      parentWin.on('closed', this._closedHandler);
      // v2.17.54：宿主 全屏/退出全屏/最大化/退出最大化 时立即重排。
      // 此前只监听 move/resize/minimize/restore：全屏时 _computeScreenGeometry 仍按
      // "标题栏 34px 下压"算，顶部留 34px 缺口、高度少 34px；且 dipRect 会被 resize
      // 比例兜底污染，退出全屏后回不到原来的跟随 —— 表现为"飞牛影视全屏了 MPV 没跟"。
      this._fsEnter = () => {
        const wasFs = this._isHostFs();
        // v2.17.55（用户反馈：电视直播全屏时 MPV 与窗口错位、不贴合）——
        // 进入全屏一律置标记。此前窗口级全屏只靠 win.isFullScreen() 实时判断，但 transparent +
        // frame:false 窗口上它恒为 false，直播窗连全屏事件都没有，于是全屏后 MPV 仍按视频区跟随。
        // 现在主进程用 setHostState() 显式下发全屏真值，这里统一落到 _hostFs。
        this._hostFs = true;
        if (!wasFs) {
          this._fsSavedDip = { x: this.dipRect.x, y: this.dipRect.y, width: this.dipRect.width, height: this.dipRect.height };
          this._fsSavedView = { x: this.viewOffset.x || 0, y: this.viewOffset.y || 0 };
        }
        try { this.player._lastGeoStr = ''; } catch (_) {}
        this._burstRect(900);
        this._applyGeometry();
        try { if (!this._chasing) this._chase(24); } catch (_) {}
        this._raiseMpv();
        // v3.0.71：全屏要盖住任务栏 → 临时真置顶；退出全屏回到“只压宿主”的从属层级
        try { this._applyTopPolicy(); } catch (_) {}
      };
      this._fsExit = () => {
        this._hostFs = false;
        this._fsGeoLogged = false;
        // 退出全屏：先回到全屏前的视频区（随后 guest reportRect 会按真实布局再校准）
        if (this._fsSavedDip) { this.dipRect = { x: this._fsSavedDip.x, y: this._fsSavedDip.y, width: this._fsSavedDip.width, height: this._fsSavedDip.height }; this._fsSavedDip = null; }
        if (this._fsSavedView) { this.viewOffset = { x: this._fsSavedView.x, y: this._fsSavedView.y }; this._fsSavedView = null; }
        this._baseCbW = 0; this._baseCbH = 0; this._baseDip = null;
        // v2.24.8：退出全屏后冻结 sync 缩放，等宿主窗口动画稳定（回到窗口化尺寸）后再重建基准，
        // 避免用过渡期全屏尺寸当基准把 dipRect 等比缩小（详见 _syncDipToResize 内注释）。
        this._syncFreezeUntil = Date.now() + 800;
        try { this.player._lastGeoStr = ''; } catch (_) {}
        this._burstRect(900);
        this._applyGeometry();
        try { if (!this._chasing) this._chase(24); } catch (_) {}
        this._raiseMpv();
        try { this._applyTopPolicy(); } catch (_) {}
      };
      this._enterFsHandler = () => this._fsEnter();
      this._leaveFsHandler = () => this._fsExit();
      this._enterHtmlFsHandler = () => this._fsEnter();
      this._leaveHtmlFsHandler = () => this._fsExit();
      this._maximizeHandler = () => {
        try { this.player._lastGeoStr = ''; } catch (_) {}
        this._burstRect(900);
        this._trackTransit('maximize', 1800);
        this._applyGeometry();
        try { if (!this._chasing) this._chase(20); } catch (_) {}
        this._raiseMpv();
      };
      parentWin.on('enter-full-screen', this._enterFsHandler);
      parentWin.on('leave-full-screen', this._leaveFsHandler);
      parentWin.on('maximize', this._maximizeHandler);
      parentWin.on('unmaximize', this._maximizeHandler);
      // 网页层 HTML 全屏（飞牛播放器自带的全屏按钮）：窗口 bounds 不变，视频铺满视口，
      // mpv 必须同步铺满。Electron 22 起事件挂在 webContents 上。
      try {
        const wc = parentWin.webContents;
        if (wc) {
          wc.on('enter-html-full-screen', this._enterHtmlFsHandler);
          wc.on('leave-html-full-screen', this._leaveHtmlFsHandler);
        }
      } catch (_) {}

      // 轮询兜底：拖动/缩放窗口时 'move'/'resize' 事件在部分平台不连续触发，
      // 定时比对内容区位置，变化即重新定位，保证 mpv 窗口始终贴合视频区。
      this._lastBoundsKey = '';
      this._pollTick = 0;
      this._pollTimer = setInterval(() => {
        try {
          const w = this.parent;
          if (!w || w.isDestroyed()) { this.destroy(); return; }
          if (w.isMinimized() || !w.isVisible()) return;
          const cb = w.getContentBounds();
          const key = `${cb.x},${cb.y},${cb.width},${cb.height}`;
          this._lastBoundsKey = key;
          // v1.61：嵌入窗【每 500ms 强制对齐】纠偏。mpv 在首帧离屏隐藏→恢复、IPC geometry
          // 时序等情况下自身位置会漂移（恢复时可能套用离屏 -32000 旧几何），宿主不动时旧逻辑
          // 不会重定位，导致 mpv 上沿盖住悬浮标题栏（无法拖动/改样式）。这里无条件 _applyGeometry，
          // player.setGeometry 内部按几何串去抖，位置正确时不产生额外 IPC。
          this._applyGeometry();
          // v3.0.71：mpv 进出全屏/换片可能重建窗口样式而丢掉 owner，周期性补挂一次（极廉价）
          try {
            if (this._ownerOk && !this._pip && (Date.now() - (this._ownerTouchAt || 0)) > 3000) {
              this._ownerTouchAt = Date.now();
              if (this.player && this.player.isRunning()) this.player.reassertOwner();
            }
          } catch (_) {}
        } catch (_) {}
      }, 200);
      if (this._pollTimer.unref) this._pollTimer.unref();
    }

    this._start();
  }

  _emit(ev, ...a) { try { this.player.emit(ev, ...a); } catch (_) {} }
  // 视频区屏幕几何（DIP）。
  // 坐标链路：内容区屏幕坐标(getContentBounds) + webview 在内容区内偏移(viewOffset)
  //           + 视频 <video> 在 webview 视口内坐标(dipRect)。
  // 注意：mpv 是 DPI-aware 的独立窗口，--geometry/window-move/resize 都按【屏幕 DIP 逻辑坐标】
  //       解释（与 Electron getContentBounds 一致）。不要再乘 scaleFactor，否则在 125%/150%
  //       缩放的显示器上会出现放大错位（顶部黑条/越界）。
  // v2.17.54：宿主是否处于全屏（事件缓存 + Electron 实时状态兜底）
  _isHostFs() {
    if (this._standalone) return false;
    try {
      const w = this.parent;
      if (w && !w.isDestroyed() && typeof w.isFullScreen === 'function' && w.isFullScreen()) return true;
    } catch (_) {}
    return !!this._hostFs;
  }

  _computeScreenGeometry() {
    const r = this.dipRect;
    const off = this.viewOffset;
    const win = this.parent;
    if (!win || win.isDestroyed()) return null;
    const cb = win.getContentBounds();      // 内容区屏幕 DIP 坐标
    // v2.17.54：宿主全屏（窗口全屏 / 网页 HTML 全屏）时 mpv 铺满整屏，
    // 不做标题栏下压、不按视频区留边 —— 用户要求"飞牛影视全屏，MPV 也全屏并跟随"。
    // 退出全屏后本分支不再命中，自动回到按视频区 dipRect 跟随，即"恢复全屏前的跟随"。
    // v2.17.56（用户要求"识别到飞牛影视/电视直播窗口全屏时，MPV 播放器立即铺满整个 Windows 桌面"）
    // —— 原来这里取宿主 getContentBounds()：实测这些 transparent + frame:false 窗口上
    // setFullScreen(true) 会半失败（位置挪到屏幕左上、尺寸没撑满），content bounds 仍是
    // 1280x820 级别，于是 MPV 只盖一个小矩形 = 用户看到的"播放器和窗口错位、没铺满桌面"。
    // 现改为直接取【宿主所在显示器的 bounds】（整屏，含任务栏），与宿主自身尺寸无关：
    // 全屏一被识别到就立即铺满整个 Windows 桌面。
    if (!this._pip && this._isHostFs()) {
      let db = null;
      try {
        const { screen } = require('electron');
        db = screen.getDisplayMatching(win.getBounds()).bounds;
      } catch (_) {}
      const t = db || cb;
      if (!this._fsGeoLogged) {
        this._fsGeoLogged = true;
        try {
          this._emit('log', 'embed.fs.geo db=' + [t.x, t.y, t.width, t.height].join(',')
            + ' cb=' + [cb.x, cb.y, cb.width, cb.height].join(','));
        } catch (_) {}
      }
      return {
        x: Math.round(t.x),
        y: Math.round(t.y),
        width: Math.round(t.width),
        height: Math.round(t.height)
      };
    }
    let x = cb.x + (off.x || 0) + (r.x || 0);
    let y = cb.y + (off.y || 0) + (r.y || 0);
    let width = Math.max(160, r.width);
    let height = Math.max(90, r.height);
    // v1.60：内嵌 mpv 是无边框置顶窗，会盖住宿主悬浮标题栏区域。强制把 mpv 顶边压到
    // 标题栏(34px)下方，标题栏永远在 mpv 之上（可拖动/点按钮），标题栏下方即为 mpv 黑底，
    // 自动隐藏标题栏后顶部纯黑与 mpv 黑边一致。standalone（菜单"用mpv打开"）不绑定父窗，不约束。
    // v5.1.23：mac 上不做 34px 标题栏下压——直播/影视页的 body 已被 titlebar-inject 整体下移
    // 34px，上报的 dipRect 就是「播放区」本身；再压一次会在顶部留一条 34px 灰带，
    // 正好违反用户「上边不许露灰」的要求。Windows 行为不变。
    if (!this._standalone && !this._pip && process.platform !== 'darwin') {
      // v2.15.93：由单向"向下压"改为双向对齐。点播页 <video> 的 dipRect.y 含飞牛影视自身标题栏
      // （点播页约 51px），而 fnos 主窗口标题栏只有 36px，露出的约 15px 飞牛标题栏会留在 mpv 上方，
      // 导致"覆盖不了标题栏下方"。现将 mpv 顶边对齐到标题栏底边 topY：高于则下压、低于则上扩。
      const topY = cb.y + (off.y || 0) + this._titlebarHeight;
      const dy = y - topY;
      if (dy !== 0) {
        y = topY;
        height = Math.max(90, height + dy);
      }
    }
    // v2.17.57（同一份日志实证）—— mpv 是独立置顶窗，一旦算出的矩形超出宿主内容区
    //（典型：退出全屏瞬间网页补报一次全屏期的 dipRect 1920x1080，而窗口已复原成 1280x820，
    // 于是得到"尺寸取全屏、位置取窗口"的 1920x1080+320+140），画面就会跑出窗口、看着错位。
    // 这里加一道硬约束：mpv 永远不许超出宿主内容区，多出来的部分按内容区裁掉。
    if (!this._standalone && !this._pip && cb && cb.width > 0 && cb.height > 0) {
      const maxW = cb.width - (x - cb.x);
      const maxH = cb.height - (y - cb.y);
      if (maxW > 0 && width > maxW) width = maxW;
      if (maxH > 0 && height > maxH) height = maxH;
    }
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    };
  }

  // ===== v5.1.23：macOS 覆盖窗几何 =====
  _hostDisplay() {
    try {
      const { screen } = require('electron');
      const w = this.parent;
      const b = (w && !w.isDestroyed()) ? w.getBounds() : null;
      return b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay();
    } catch (_) { return null; }
  }

  _macDisplayKey(d) {
    if (!d || !d.bounds) return 'unknown';
    return Math.round(d.bounds.width) + 'x' + Math.round(d.bounds.height)
      + '@' + (Math.round((d.scaleFactor || 1) * 100) / 100);
  }

  // Electron 屏幕坐标（左上原点）→ mpv/cocoa --geometry 坐标（左下原点）。
  // 现象级证据：宿主内容区 (252,118,1280,819)，播放区相对内容区 x=300,y=34,w=980,h=729
  // → 期望屏幕矩形 (552,152,980,729)；实际观感是整体下移（上方灰带 + 下方压控制条）。
  // 在 1080p 屏上左下原点换算得到 y=1080-152-729=199，正好下移 47px，与现象一致。
  // mode/adj* 由首次启动自校准写回（mpv 版本/显示器语义变化时也能自愈）。
  _macMpvGeometry(geo) {
    if (!geo) return null;
    if (process.platform !== 'darwin' || this._standalone) {
      return { x: geo.x, y: geo.y, width: geo.width, height: geo.height };
    }
    const g = this._macGeom || __loadMacGeom();
    const d = this._hostDisplay();
    let x = geo.x, y = geo.y, width = geo.width, height = geo.height;
    if (g.mode === 'bottom' && d && d.bounds) {
      y = d.bounds.y + d.bounds.height - geo.y - geo.height;
    }
    x += Number(g.adjX) || 0;
    y += Number(g.adjY) || 0;
    width += Number(g.adjW) || 0;
    height += Number(g.adjH) || 0;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }

  _isOffscreenRect(r) {
    return !!(r && (r.x <= -20000 || r.y <= -20000));
  }

  _rectClose(a, b, tol) {
    if (!a || !b) return false;
    const t = (typeof tol === 'number') ? tol : 2;
    return Math.abs(a.x - b.x) <= t && Math.abs(a.y - b.y) <= t
      && Math.abs(a.width - b.width) <= t && Math.abs(a.height - b.height) <= t;
  }

  _measureWindowAfterSpawn() {
    // 窗口从 spawn 到被 CGWindowList 看见约 200~600ms（mpv 建窗 + 首帧前）。
    return (async () => {
      for (let i = 0; i < 14; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 220 : 180));
        const pid = this.player && this.player.proc && this.player.proc.pid;
        if (!pid) continue;
        const r = await __macWindowRectByPid(pid);
        if (r) return r;
      }
      return null;
    })();
  }

  async _respawnAndMeasure() {
    if (this._dead || !this.player) return null;
    try { this.player.stop(); } catch (_) {}
    try { this.player._ownerOk = false; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
    if (this._dead) return null;
    try { this._start(); } catch (_) { return null; }
    return await this._measureWindowAfterSpawn();
  }

  // 首次起播前的自校准（发生在 loadfile 之前，不打断画面）：
  //   采样 0：默认按「左下原点」换算 → 量真实窗口；
  //   采样 1：换「左上原点」再量（最常见二选一，命中即收敛）；
  //   采样 2：用前两次求斜率（+1/-1），解出精确 --geometry，兜住菜单栏/可见区常量偏移。
  // 结果持久化到 userData/mpv-mac-geom.json，后续启动只做一次校验，不再重启。
  async _calibrateMacGeometry() {
    const want = this._computeScreenGeometry();
    if (!want) return;
    const wantRect = { x: want.x, y: want.y, width: want.width, height: want.height };
    let a0 = await this._measureWindowAfterSpawn();
    if (!a0) {
      try { __mk('macdiag.mpv.calib.nomeasure', { want: wantRect, spawn: this._spawnGeo }); } catch (_) {}
      return;
    }
    // 量到 -32000 说明 IPC 就绪时那次「移出屏幕隐藏」真的生效了 —— 在 mac 上只有
    // AppleScript 通道能做到这一点（geometry 属性不会移窗），即辅助功能授权可用。
    // 这种情况无需换算坐标：随后 _applyGeometry 会用正确顶左坐标把窗口摆回播放区。
    if (this._isOffscreenRect(a0)) {
      this.player._asOk = true;
      try { __mk('macdiag.mpv.calib.as-ok', { got: a0 }); } catch (_) {}
      return;
    }
    try { __mk('macdiag.mpv.calib.sample', { n: 0, mode: this._macGeom.mode, want: wantRect, spawn: this._spawnGeo, got: a0 }); } catch (_) {}
    if (this._rectClose(a0, wantRect)) { __saveMacGeom(this._macGeom); return; }

    const s0 = this._spawnGeo ? { x: this._spawnGeo.x, y: this._spawnGeo.y, width: this._spawnGeo.width, height: this._spawnGeo.height } : null;
    const mode0 = this._macGeom.mode;
    this._macGeom.mode = (mode0 === 'bottom') ? 'top' : 'bottom';
    const a1 = await this._respawnAndMeasure();
    if (this._isOffscreenRect(a1)) {
      // 同上：测量窗口期间被 AppleScript 移到 -32000（隐藏）= 授权可用；把 mode 还原，交给 AS 通道。
      this.player._asOk = true;
      this._macGeom.mode = mode0;
      try { __mk('macdiag.mpv.calib.as-ok', { n: 1, got: a1 }); } catch (_) {}
      return;
    }
    try { __mk('macdiag.mpv.calib.sample', { n: 1, mode: this._macGeom.mode, want: wantRect, spawn: this._spawnGeo, got: a1 }); } catch (_) {}
    if (a1 && this._rectClose(a1, wantRect)) { __saveMacGeom(this._macGeom); return; }
    if (!a1 || !s0 || !this._spawnGeo) {
      // 第二次测不到 → 无法判断哪种语义，回到原 mode（默认左下原点），不要留下投机性结论
      this._macGeom.mode = mode0;
      __saveMacGeom(this._macGeom);
      return;
    }

    const s1 = { x: this._spawnGeo.x, y: this._spawnGeo.y, width: this._spawnGeo.width, height: this._spawnGeo.height };
    const dSpawnY = s1.y - s0.y;
    const slopeY = (Math.abs(dSpawnY) >= 8) ? (a1.y - a0.y) / dSpawnY : 1;
    const closer = (Math.abs(a1.y - wantRect.y) <= Math.abs(a0.y - wantRect.y)) ? a1 : a0;
    if (Math.abs(slopeY) < 0.2) {
      // mpv 完全忽略 y：只能保证尺寸/横向贴合，记日志停止折腾
      try { __mk('macdiag.mpv.calib.ignore-y', { a0, a1, want: wantRect }); } catch (_) {}
      __saveMacGeom(this._macGeom);
      return;
    }
    const __prevAdj = { adjX: this._macGeom.adjX, adjY: this._macGeom.adjY, adjW: this._macGeom.adjW, adjH: this._macGeom.adjH, mode: this._macGeom.mode };
    this._macGeom.adjX += (wantRect.x - closer.x);
    this._macGeom.adjY += (wantRect.y - closer.y) / slopeY;
    this._macGeom.adjW += (wantRect.width - closer.width);
    this._macGeom.adjH += (wantRect.height - closer.height);
    const sane = Math.abs(this._macGeom.adjX) < 2400 && Math.abs(this._macGeom.adjY) < 2400
      && Math.abs(this._macGeom.adjW) < 400 && Math.abs(this._macGeom.adjH) < 400;
    if (!sane) {
      this._macGeom.adjX = 0; this._macGeom.adjY = 0; this._macGeom.adjW = 0; this._macGeom.adjH = 0;
      try { __mk('macdiag.mpv.calib.insane', { a0, a1, want: wantRect }); } catch (_) {}
      __saveMacGeom(this._macGeom);
      return;
    }
    const a2 = await this._respawnAndMeasure();
    const ok2 = this._rectClose(a2, wantRect);
    try {
      __mk('macdiag.mpv.calib.sample', {
        n: 2, mode: this._macGeom.mode, want: wantRect, spawn: this._spawnGeo, got: a2,
        adj: { x: this._macGeom.adjX, y: this._macGeom.adjY, w: this._macGeom.adjW, h: this._macGeom.adjH }, ok: ok2
      });
    } catch (_) {}
    // 修正后仍不收敛（例如 CGWindowBounds 含阴影/读到了别的窗口）→ 回退到「最接近的那一档语义」，
    // 绝不把一次坏修正持久化，避免下次启动从一开始就错。
    if (!ok2) {
      this._macGeom.adjX = __prevAdj.adjX; this._macGeom.adjY = __prevAdj.adjY;
      this._macGeom.adjW = __prevAdj.adjW; this._macGeom.adjH = __prevAdj.adjH;
    }
    __saveMacGeom(this._macGeom);
  }

  _macAlignBeforePlay() {
    if (process.platform !== 'darwin' || this._standalone) return Promise.resolve();
    if (this._macCalibPromise) return this._macCalibPromise;
    this._macCalibPromise = this._calibrateMacGeometry()
      .catch((e) => { try { __mk('macdiag.mpv.calib.err', { err: String(e && e.message || e) }); } catch (_) {} })
      .then(() => { this._macCalibPromise = null; });
    return this._macCalibPromise;
  }

  async _macVerify(tag) {
    if (process.platform !== 'darwin' || this._standalone || !this._started) return null;
    const want = this._computeScreenGeometry();
    const pid = this.player && this.player.proc && this.player.proc.pid;
    const got = await __macWindowRectByPid(pid);
    if (!want || !got) {
      try { __mk('macdiag.mpv.verify.nomeasure', { tag, want: want, spawn: this._spawnGeo }); } catch (_) {}
      return null;
    }
    const out = {
      tag, mode: this._macGeom.mode, want, spawn: this._spawnGeo, got,
      delta: { dx: got.x - want.x, dy: got.y - want.y, dw: got.width - want.width, dh: got.height - want.height }
    };
    this._macLastVerify = out;
    try { __mk('macdiag.mpv.geom.verify', out); } catch (_) {}
    return out;
  }

  async getMacWindowRect() {
    const pid = this.player && this.player.proc && this.player.proc.pid;
    return __macWindowRectByPid(pid);
  }

  // 播放区矩形显著变化（>16px 或宽/高 >2%）→ mac 上只能带新 --geometry 重启 mpv。
  // 只在直播启用：点播重启会打断观看，且点播页用窗口全屏（mpv fullscreen）不依赖几何。
  // 拖动/缩放期间连续触发，用 650ms 静默期合并成一次重启。
  _maybeRestartForGeometry(geo) {
    if (process.platform !== 'darwin' || this._standalone) return;
    if (!this._startSettings || !this._startSettings.isLive) return;
    if (this._dead || this._restarting || this._pip || this._isHostFs()) return;
    if (this._macCalibPromise) return; // 校准期间不要在两次 spawn 之间插重启
    if (this.player && this.player._asOk) return; // 辅助功能可用时窗口能实时跟随，不必重启
    const base = this._geomAtSpawn;
    if (!base || !geo) return;
    const dx = Math.abs(geo.x - base.x), dy = Math.abs(geo.y - base.y);
    const dw = Math.abs(geo.width - base.width), dh = Math.abs(geo.height - base.height);
    const sig = dx > 16 || dy > 16 || dw > 16 || dh > 16
      || dw > Math.max(1, base.width * 0.02) || dh > Math.max(1, base.height * 0.02);
    if (!sig) return;
    this._sigAt = Date.now();
    if (this._restartTimer) return;
    const tick = () => {
      this._restartTimer = null;
      if (this._dead || this._restarting) return;
      if (Date.now() - this._sigAt < 650) {
        this._restartTimer = setTimeout(tick, 200);
        if (this._restartTimer.unref) this._restartTimer.unref();
        return;
      }
      this._doRestartForGeometry('rect-change');
    };
    this._restartTimer = setTimeout(tick, 650);
    if (this._restartTimer.unref) this._restartTimer.unref();
  }

  _doRestartForGeometry(reason) {
    if (this._dead || this._restarting || this._pip || this._standalone) return;
    if (this._macCalibPromise) return;
    if (this.player && this.player._asOk) return;
    const target = this._computeScreenGeometry();
    if (!target) return;
    const playInfo = this._lastPlay;
    const from = this._geomAtSpawn ? { x: this._geomAtSpawn.x, y: this._geomAtSpawn.y, width: this._geomAtSpawn.width, height: this._geomAtSpawn.height } : null;
    this._restarting = true;
    try {
      __mk('macdiag.mpv.restart', {
        reason, from, to: target,
        delta: from ? { dx: target.x - from.x, dy: target.y - from.y, dw: target.width - from.width, dh: target.height - from.height } : null
      });
    } catch (_) {}
    try { this.player.stop(); } catch (_) {}
    try { this.player._ownerOk = false; } catch (_) {}
    const t = setTimeout(() => {
      if (this._dead) { this._restarting = false; return; }
      try { this._start(); } catch (e) {
        this._restarting = false;
        try { __mk('macdiag.mpv.restart.fail', { err: String(e && e.message || e) }); } catch (_) {}
        return;
      }
      const release = () => {
        this._restarting = false;
        // 立刻把新几何写进 player._geometry：loadfile 的「首帧前隐藏 → 首帧 reveal」用的是它，
        // 不清会被旧坐标带到错误位置（mac 上属性虽不移窗，但 reveal 路径仍依赖该值）。
        try { this._applyGeometry(); } catch (_) {}
        if (playInfo && this.player.isRunning()) {
          try {
            this.player.loadfile(playInfo.url, playInfo.headers, playInfo.opts)
              .catch((err) => { try { __mk('macdiag.mpv.restart.loadfail', { err: String(err && err.message || err) }); } catch (_) {} });
          } catch (_) {}
        }
        const vt = setTimeout(() => { try { this._macVerify('restart'); } catch (_) {} }, 1300);
        if (vt.unref) vt.unref();
      };
      if (this.player.connected) release(); else this.player.once('ipc-ready', release);
      const guard = setTimeout(() => { this._restarting = false; }, 9000);
      if (guard.unref) guard.unref();
    }, 160);
    if (t.unref) t.unref();
  }

  _start() {
    const geo = this._computeScreenGeometry();
    // v5.1.23（mac 覆盖窗贴合）——macOS 上 mpv 只在【启动那一刻】按 --geometry 定位，
    // 运行期改 geometry 属性不会移动窗口。因此这里必须把「Electron 顶左原点坐标」换算成
    // mpv/cocoa 认可的坐标再交给 spawn（见 _macMpvGeometry），并记录本次启动的期望矩形，
    // 供首次校准与后续「几何显著变化 → 重启贴合」使用。
    const spawnGeo = geo ? this._macMpvGeometry(geo) : null;
    this._geomAtSpawn = geo ? { x: geo.x, y: geo.y, width: geo.width, height: geo.height } : null;
    this._spawnGeo = spawnGeo ? { x: spawnGeo.x, y: spawnGeo.y, width: spawnGeo.width, height: spawnGeo.height } : null;
    try {
      __mk('macdiag.mpv.spawn', {
        standalone: !!this._standalone, isLive: !!this._startSettings.isLive,
        want: this._geomAtSpawn, spawn: this._spawnGeo, mode: (this._macGeom && this._macGeom.mode) || ''
      });
    } catch (_) {}
    try {
      this.player.start({
        // 关键：必须把 standalone 透传给 MpvPlayer.start()，否则 spawn 会误走嵌入覆盖窗分支
        //（--ontop=yes/--title=FNOS-MPV/--geometry），导致"用 mpv 打开"的独立窗变成带标题栏的置顶窗、
        // 画中画/自由移动等独立窗逻辑全部失效。
        standalone: this._standalone,
        geometry: spawnGeo || undefined,
        isLive: !!this._startSettings.isLive,
        title: this._startSettings.title || '',
        hwDecode: this._startSettings.hwDecode || 'auto',
        cacheLevel: this._startSettings.cacheLevel || 'smooth',
        headers: this._startSettings.headers || null,
        // 点播断流（签名链接时效失效）时，由主进程注入回调重新签名取新鲜地址
        onNeedFreshUrl: this._onNeedFreshUrl || null,
        // v2.21.0：自定义 MPV 内核（mpv-lazy 等）/ 附加启动参数 / 配置来源 /
        // 低功耗预设（null=自动：内置开、自定义关）/ 字幕样式（位置、字号、缩放）
        // v5.0.5（用户要求：设置里可选内置/自定义内核）——只有 coreMode==='custom' 才用外部 exe
        mpvExe: (this._startSettings.coreMode === 'custom') ? (this._startSettings.exePath || '') : '',
        mpvArgs: this._startSettings.extraArgs || '',
        configMode: this._startSettings.configMode || 'builtin',
        perfPreset: (typeof this._startSettings.perfPreset === 'boolean') ? this._startSettings.perfPreset : undefined,
        subStyle: this._startSettings.subStyle || null,
        onSubStyle: this._onSubStyle || null,
        scaleFactor: this._scaleFactor || 1
      });
      // 用户点 mpv 窗口自带关闭按钮：仅标记本嵌入层死亡。
      // 注意：绝不能再把 'user-closed' 通过 this.player.emit 回抛出去——该事件的监听者
      // 正是 player 自身，回抛会再次触发本处理器形成无限递归（事件风暴，主线程卡死/日志刷爆）。
      // main.js 直接在 player 上监听 'user-closed'/'exit' 做回收与通知网页，这里不中转。
      if (!this._coreHooked) {
        this._coreHooked = true;
        this.player.on('user-closed', () => { this._dead = true; });
        // 首帧就绪、mpv 窗口从离屏隐藏移回时，立即按当前视频区几何对齐（含 34px 标题栏下压），
        // 不必等 500ms 轮询，避免首帧短暂盖住悬浮标题栏。
        this.player.on('first-frame', () => {
          try { this.player._lastGeoStr = ''; this._applyGeometry(); } catch (_) {}
          // v5.1.23：首帧后再量一次真实窗口矩形，把「期望 vs 实际」写进 diag 日志（真机验收用）
          const __vt = setTimeout(() => { try { this._macVerify('first-frame'); } catch (_) {} }, 900);
          if (__vt.unref) __vt.unref();
        });
        // v2.17.54：换片/自动播放下一集（同一 mpv 进程 loadfile 重载）后强制重新对齐一次。
        // 首帧前窗口会离屏隐藏（-32000）再 reveal，reveal 用的是最后一次下发的几何；
        // 这里清掉去抖缓存并重算，避免换集瞬间跳到旧位置/旧尺寸（"丢失跟随"）。
        this.player.on('loaded', () => { try { this.player._lastGeoStr = ''; this._applyGeometry(); this._raiseMpv(); } catch (_) {} });
      }
      // v3.0.71（用户要求：MPV 只要压在飞牛影视 / 电视直播之上并跟随它们）——
      // 把 mpv 原生窗口挂成宿主 BrowserWindow 的从属(owner)窗口：
      //   · Windows 保证 owned 窗口恒定在 owner 之上 → 宿主拖动/激活/最大化时 mpv 不会被自己盖住；
      //   · owner 不是 topmost → 切到别的程序时 mpv 不再压在人家和任务栏上面（此前 ontop 的问题）。
      // 挂接成功后才把 mpv 的 ontop 关掉；失败（helper 起不来等）保持原行为，不影响播放。
      try {
        if (!this._ownerHooked) {
          this._ownerHooked = true;
          this.player.on('owner-attached', () => {
            this._ownerOk = true;
            try { this._applyTopPolicy(); } catch (_) {}
          });
        }
        if (!this._standalone && this.parent && !this.parent.isDestroyed()) {
          this.player.attachOwner(this.parent.getNativeWindowHandle());
        }
      } catch (_) {}
      this._started = true;
    } catch (e) {
      this._emit('log', 'surface start failed: ' + (e && e.message));
    }
  }

  // v2.24.0（用户反馈：来回切全屏/最大化时 MPV 跟随卡顿、画面跟不上宿主窗口）——
  // 几何下发做 leading+trailing 节流：窗口动画期间最多约 40 次/秒把新几何推给 mpv（跟得上），
  // 同时保证最后一次几何一定会补发（不会停在动画中间某一帧，动画结束后也不会残留错位）。
  _pushGeometry(geo) {
    if (!geo) return;
    // v5.1.25（真机实测定位到根因）——运行期下发的是【未换算】的左上原点矩形，
    // 而 spawn 时下发的是 _macMpvGeometry() 换算后的矩形；cocoa 下 `set_property geometry`
    // 的 y 会被 mpv 加上自身 30px 头部 → 运行期这一发总是比目标低 30px，
    // 于是"启动瞬间刚好贴合、200ms 后被跟随逻辑推到 130"（实测 want y=100，窗口落在 130）。
    // 修法：darwin 上运行期也走同一套换算，保证 spawn 与 follow 用的是同一个坐标系。
    // v5.1.26：换算下沉到 MpvPlayer.setGeometry（唯一出口），这里不再重复换算，
    // 否则会双扣 30px。见 mpv-player.js 的 setGeometry。
    const now = Date.now();
    this._geoWant = geo;
    // v5.1.4（用户报第 1 项：mac 上 MPV 窗口不跟随主窗）——
    // 之前整条跟随链路没有任何可检索日志，无法判断「宿主几何变了没」「几何发下去了没」
    // 「mpv 收下了没」。这里补 macdiag.mpv.follow.push（500ms 节流），带宿主 contentBounds。
    try {
      if (!this._followLogAt || now - this._followLogAt >= 500) {
        this._followLogAt = now;
        let host = null;
        try { host = this.parent && !this.parent.isDestroyed() ? this.parent.getContentBounds() : null; } catch (_) {}
        __mk('macdiag.mpv.follow.push', {
          standalone: !!this._standalone, pip: !!this._pip, host,
          push: { x: Math.round(geo.x), y: Math.round(geo.y), w: Math.round(geo.width), h: Math.round(geo.height) },
          dipRect: this.dipRect, viewOffset: this.viewOffset
        });
      }
    } catch (_) {}
    // v2.24.4：记下“我们最近一次真正下发的几何”，供 audit 判断 mpv 是“还没追上”还是“真没接受”
    this._pushKey = Math.max(160, Math.round(geo.width)) + 'x' + Math.max(90, Math.round(geo.height)) +
      '+' + Math.round(geo.x) + '+' + Math.round(geo.y);
    this._pushKeyAt = now;
    if (!this._geoLastAt || now - this._geoLastAt >= 24) {
      this._geoLastAt = now;
      try { this.player.setGeometry(geo); } catch (_) {}
      // v5.1.4（用户报第 1 项）mac 专用兜底：宿主【只移动不改尺寸】时，macOS 上单发
      // set_property geometry 只保证尺寸生效，origin 有时不跟随（Windows 的 w32 会重排整个 frame，
      // cocoa 不会）。这里在"位置变了、尺寸没变"时把宽度抖 1px 再改回，逼 cocoa 走一次
      // 完整 frame 重排（40ms，肉眼不可见），保证 MPV 窗口跟着主窗移动。
      if (process.platform === 'darwin') {
        try {
          const posKey = Math.round(geo.x) + ',' + Math.round(geo.y);
          if (this._lastPosKey && this._lastPosKey !== posKey) {
            const jig = { x: geo.x, y: geo.y, width: Math.round(geo.width) + 1, height: geo.height };
            try { this.player.setGeometry(jig); } catch (_) {}
            const self = this;
            const t = setTimeout(() => { try { if (!self._dead) self.player.setGeometry(geo); } catch (_) {} }, 40);
            if (t.unref) t.unref();
            __mk('macdiag.mpv.follow.jiggle', { from: this._lastPosKey, to: posKey });
          }
          this._lastPosKey = posKey;
        } catch (_) {}
      }
      return;
    }
    if (this._geoTrailTimer) return;
    const wait = Math.max(8, 24 - (now - this._geoLastAt));
    this._geoTrailTimer = setTimeout(() => {
      this._geoTrailTimer = null;
      const g = this._geoWant;
      if (!g) return;
      this._geoLastAt = Date.now();
      try { this.player.setGeometry(g); } catch (_) {}
    }, wait);
    if (this._geoTrailTimer.unref) this._geoTrailTimer.unref();
  }

  // v2.24.5（用户反馈：直播比点播更明显"跟不上"）——
  // 日志实测：最大化瞬间 guest 只报了"宽度按比例、高度沿用旧的"中间值（980x731 → 1470x731），
  // 真正的 1620x943 要等 guest 的 500ms 定时器才上报，mpv 因此被改两次尺寸（先错后对）= 画面跳两步。
  // 这里在过渡开始时让 guest 以 30ms 间隔连续上报视频区（默认 700ms），宿主仍按 24ms 节流下发，
  // mpv 就能跟着页面布局一帧帧走。只在过渡期间触发，静息时零开销。
  _burstRect(ms) {
    try {
      const now = Date.now();
      if (this._burstAt && now - this._burstAt < 120) return;
      this._burstAt = now;
      const wc = this._guestWc;
      if (!wc || (wc.isDestroyed && wc.isDestroyed())) return;
      wc.send('mpv:rect-burst', Math.max(200, Math.min(1500, ms || 700)));
    } catch (_) {}
  }

  // v2.24.0：过渡期追帧。全屏/最大化切换时宿主窗口有一段 100~300ms 的动画，Electron 在这段时间里
  // 可能只发一两帧 resize，光靠事件会让 mpv 停在中间尺寸（视频里"窗口先变大、播放器一秒后才跟上"）。
  // 这里在过渡开始后每 16ms 重算一帧几何，直到宿主尺寸稳定。
  _chase(times) {
    if (this._chaseTimer) { try { clearTimeout(this._chaseTimer); } catch (_) {} this._chaseTimer = null; }
    let left = times || 12;
    this._chasing = true;
    const tick = () => {
      this._chaseTimer = null;
      try { this._applyGeometry(); } catch (_) {}
      left -= 1;
      if (left > 0) {
        this._chaseTimer = setTimeout(tick, 16);
        if (this._chaseTimer.unref) this._chaseTimer.unref();
      } else {
        this._chasing = false;
      }
    };
    this._chaseTimer = setTimeout(tick, 16);
    if (this._chaseTimer.unref) this._chaseTimer.unref();
  }

  _applyGeometry() {
    if (this._dead) return;
    // 画中画小窗期间脱离视频区跟随（窗口已固定为右下角小尺寸并可被用户自由拖动），
    // 不再随宿主窗移动/滚动重定位。
    if (this._pip) return;
    // v2.15.94：最小化/隐藏时不重算几何。Windows 最小化会把窗口移到离屏(-32000)，
    // move/resize 事件仍会触发，此时 getContentBounds 返回离屏/异常值，会污染
    // dipRect(_syncDipToResize) 和 mpv 几何(_computeScreenGeometry)，导致恢复后
    // 播放器变小卡在左上角、不再跟随。这里与轮询守卫一致地跳过。
    const _w = this.parent;
    if (_w && !_w.isDestroyed() && (_w.isMinimized() || !_w.isVisible())) return;
    // v2.17.54：全屏期间不按内容区比例缩放 dipRect（全屏尺寸跨度大，缩放会污染视频区坐标，
    // 退出全屏就回不到原来的跟随）。全屏几何由 _computeScreenGeometry 直接给整屏。
    if (!this._isHostFs()) this._syncDipToResize();
    // v2.17.59（用户第四次反馈"飞牛影视/电视直播全屏下 MPV 还是错位"）——
    // v2.17.58 的 osd-dimensions 回执实锤：全屏时 mpv 真实窗口只有 1834x1032（= workArea 高 1032
    // × 16:9），不是我们下发的 1920x1080。普通无边框窗口（--border=no）用 geometry 撑到显示器尺寸
    // 会被 mpv/Windows 限制在 workArea（不含任务栏 48px），geometry 发多少次都撑不满、右侧/底部
    // 留灰边。改用 mpv fullscreen 模式（set_property fullscreen），由 mpv 自行接管窗口尺寸、
    // 覆盖整个显示器（含任务栏），这才是"全屏铺满桌面"的正解。
    const fs = this._isHostFs();
    let __fsToggled = false;
    if (fs !== !!this._mpvFsOn) {
      __fsToggled = true;
      this._mpvFsOn = fs;
      try {
        this.player.setFullscreen(fs);
        // v2.24.0：mpv 自己进出 fullscreen 需要 0.5~1.5s 才落地，这段时间下发的 geometry 会被它
        // 覆盖掉（日志实测退出全屏后 1.7s 内 mpv 仍是 1920x1080，宿主已是 1299x745）。这里开 2s 的
        // audit 快通道（100ms 一次、最多 14 次重发），mpv 一落地就立刻被拉回正确尺寸。
        try { this.player._markTransit(800); } catch (_) {}
        this._trackTransit(fs ? 'fs-on' : 'fs-off', 2600);
        this._emit('log', 'embed.fs.fullscreen ' + (fs ? 'on' : 'off'));
      } catch (_) {}
      try { this.player._lastGeoStr = ''; } catch (_) {}
    }
    if (fs) return; // 全屏交给 fullscreen 模式，不走 geometry 定位/尺寸审计
    // v2.24.0：仅在刚发生全屏切换时追帧（宿主尺寸分几帧变化），平时不追，避免常驻高频重算
    if (__fsToggled && !this._chasing) { try { this._chase(24); } catch (_) {} }
    // v2.17.57（用户反馈：飞牛影视/电视直播全屏时 MPV 还是错位）——
    // 本机 mpv 构建不支持 window-* 写入，定位只靠 set_property geometry 兜底；一旦有旧几何迟到
    // 覆盖掉新几何，player._lastGeoStr 仍记着"正确"的串，去抖会让后续轮询再也不重发，
    // 错位就永久化（实测退出全屏后画面停在 1920x1080+320+140）。这里每 2s 主动清一次去抖缓存，
    // 强制按当前真实位置重发一次，相当于自愈心跳；_reassert 期间不刷 embed.align 日志。
    const __now = Date.now();
    let __reassert = false;
    if (!this._lastReassertTs || __now - this._lastReassertTs >= 2000) {
      this._lastReassertTs = __now;
      __reassert = true;
      try { this.player._lastGeoStr = ''; } catch (_) {}
    }
    const geo = this._computeScreenGeometry();
    if (geo && this._started) {
      try {
        const before = this.player._lastGeoStr;
        this._pushGeometry(geo);
        try { this.player._markTransit(150); } catch (_) {}
        const after = `${Math.max(160, geo.width)}x${Math.max(90, geo.height)}+${geo.x}+${geo.y}`;
        if (!__reassert && before !== after) {
          // v1.68.0：宿主拖动/网页滚动时 setRect 上报极频繁（几百 ms 内几十次），
          // 逐条打 embed.align 会把 fnos-diag.log 刷爆。做日志节流：几何有实质变化时
          // 每 400ms 最多记一条，定位仍走 setGeometry 去抖后的真实 IPC。
          const now = Date.now();
          if (!this._lastAlignLogTs || now - this._lastAlignLogTs >= 400) {
            this._lastAlignLogTs = now;
            const cb = this.parent && !this.parent.isDestroyed() ? this.parent.getContentBounds() : null;
            this._emit('log', 'embed.align ' + JSON.stringify(geo) + (cb ? ' contentTop=' + cb.y : ''));
          }
        }
      } catch (_) {}
    }
    if (geo && this._started) this._auditMpvWin(geo);
    // v5.1.23（mac）：播放区几何显著变化时，带新 --geometry 重启 mpv（运行期移不动窗口）
    if (geo && this._started) this._maybeRestartForGeometry(geo);
  }

  // v2.17.58（用户第三次反馈"飞牛影视/电视直播全屏下 MPV 还是错位"）——
  // 此前所有修法都建立在"我们下发的 geometry 就是 mpv 窗口的真实尺寸"这个假设上，但日志里从来
  // 没有 mpv 侧的回执：本机 mpv 构建 window-width/window-height 写入一律返回 -3（不支持），
  // set_property geometry 只回 1（不保证已生效），所以 mpv 窗口到底多大、是否被
  // keepaspect / DPI 截过，一直是黑盒。这里用只读属性 osd-dimensions 直接问 mpv 的真实像素尺寸，
  // 与我们下发的不一致就清掉去抖缓存并立刻重下发（自愈），同时记一次 mpv.win.mismatch 供定位。
  // 同一组 want/got 连续重试 3 次仍不收敛就停止重发（避免和 mpv 内部约束死斗），只保留日志。
  // v2.24.2：把"这次是大跨度窗口变化"登记下来——顺带开审计快通道。低配机上窗口施加
  // 本身要几百毫秒，慢心跳会漏掉中间态；同时记录 mpv 追上目标尺寸的耗时，settle 后写一行
  // mpv.track 到 diag 日志，用户机上一眼看出到底慢在哪个阶段。
  _trackTransit(tag, ms) {
    try {
      const now = Date.now();
      const until = now + Math.max(300, ms || 0);
      if (!this._winAuditFastUntil || until > this._winAuditFastUntil) this._winAuditFastUntil = until;
      this._track = { tag: tag, t0: now, worst: 0, done: false };
    } catch (_) {}
  }

  _auditMpvWin(geo) {
    try {
      if (!geo || !this.player || typeof this.player.command !== 'function') return;
      const now = Date.now();
      // v2.24.0：全屏切换后的 2s 内走快通道（100ms 一次），其余时间保持 1200ms 心跳
      const fast = !!(this._winAuditFastUntil && now < this._winAuditFastUntil);
      if (this._winAuditTs && now - this._winAuditTs < (fast ? 50 : 1200)) return;
      this._winAuditTs = now;
      const want = {
        x: Math.round(geo.x),
        y: Math.round(geo.y),
        width: Math.max(160, Math.round(geo.width)),
        height: Math.max(90, Math.round(geo.height))
      };
      const wantKey = want.width + 'x' + want.height;
      Promise.resolve(this.player.command(['get_property', 'osd-dimensions'])).then((d) => {
        try {
          const w = d && (d.w || d.width);
          const h = d && (d.h || d.height);
          if (!w || !h || w <= 0 || h <= 0) return;
          // v5.1.4：mpv 真实窗口尺寸回执（mac 上唯一能读到的窗口侧证据）
          try {
            if (!this._ackLogAt || now - this._ackLogAt >= 1000) {
              this._ackLogAt = now;
              __mk('macdiag.mpv.follow.ack', { want: wantKey, got: w + 'x' + h, match: (Math.abs(w - want.width) <= 2 && Math.abs(h - want.height) <= 2) });
            }
          } catch (_) {}
          if (Math.abs(w - want.width) <= 2 && Math.abs(h - want.height) <= 2) {
            this._winAuditKey = '';
            this._winAuditTries = 0;
            // v2.24.7（用户反馈 3：MPV 的 R 角又开始不保持）——SetWindowRgn 的区域不会随窗口
            // 尺寸变化而缩放，mpv 换文件/重建 VO 还会把区域清空。每次尺寸真正收敛时补裁一次。
            try {
              const ck = w + 'x' + h;
              if (this._cornerDims !== ck) {
                this._cornerDims = ck;
                const self = this;
                const t = setTimeout(() => {
                  try {
                    if (self._dead || !self.player) return;
                    if (typeof self.player._applyRoundedCorners === 'function') self.player._applyRoundedCorners();
                    self._emit('log', 'mpv.corner.keepalive ' + ck);
                  } catch (_) {}
                }, 60);
                if (t.unref) t.unref();
              }
            } catch (_) {}
            const tr = this._track;
            if (tr && !tr.done) {
              tr.done = true;
              this._emit('log', 'mpv.track ' + tr.tag + ' settled=' + (now - tr.t0) + 'ms worst=' + Math.round(tr.worst) + 'px');
            }
            return;
          }
          if (this._track && !this._track.done) {
            const dv = Math.abs(w - want.width) + Math.abs(h - want.height);
            if (dv > this._track.worst) this._track.worst = dv;
          }
          const key = wantKey + '>' + w + 'x' + h;
          if (this._winAuditKey !== key) {
            this._winAuditKey = key;
            this._winAuditTries = 0;
            this._emit('log', 'mpv.win.mismatch want=' + wantKey + ' got=' + w + 'x' + h + ' fs=' + (this._isHostFs() ? 1 : 0));
          }
          // v2.24.4：mpv 的 osd-dimensions 在 VO 重配期间仍报旧值，此前每 100ms 据此重推一次几何，
          // 等于反复逼 mpv 重配 VO，迟到的重配又和用户下一次切换打架（实测反复最大化“永远慢一步”）。
          // 现在：这组几何只要是我们 600ms 内刚下发的，就只等不重推；超过 600ms 才判定“真没接受”重推。
          const pushKey = want.width + 'x' + want.height + '+' + want.x + '+' + want.y;
          if (this._pushKey === pushKey && now - (this._pushKeyAt || 0) < 600) return;
          if ((this._winAuditTries || 0) >= (fast ? 8 : 3)) return;
          this._winAuditTries = (this._winAuditTries || 0) + 1;
          try { this.player._lastGeoStr = ''; } catch (_) {}
          try { this.player.setGeometry(want); } catch (_) {}
          this._pushKeyAt = now;
        } catch (_) {}
      }).catch(() => {});
    } catch (_) {}
  }

  // v2.15.89：resize 比例兜底——宿主窗口缩放时，若 guest 的 reportRect 尚未同步更新
  // dipRect，则按内容区宽高变化比例就地缩放 dipRect 的 width/height，保证 MPV 跟随缩放。
  // x/y 保持不变（视频区在页面中的位置由导航栏/侧边栏等固定布局决定，通常不随缩放变化）。
  _syncDipToResize() {
    try {
      const w = this.parent;
      if (!w || w.isDestroyed() || this._standalone) return;
      // v2.24.8（用户反馈 2：直播切全屏 MPV 越切越小）——退出全屏过渡期内冻结缩放，
      // 否则 _fsExit 重置 _baseCbW=0 后，sync 的 else 分支会用"退出全屏动画中的 cb 尺寸"
      // （约 1920x1035）重建基准，动画结束后 resize 再按 sw=1280/1920≈0.667 把 dipRect
      // 反复等比缩小（实测 853→569→379→253→169，每切一次全屏缩一次）。
      if (this._syncFreezeUntil && Date.now() < this._syncFreezeUntil) return;
      // v2.15.94：最小化/隐藏时不缩放（getContentBounds 返回离屏/异常值会污染 dipRect）
      if (w.isMinimized() || !w.isVisible()) return;
      const cb = w.getContentBounds();
      if (!cb || cb.width <= 0 || cb.height <= 0) return;
      if (this._baseCbW > 0) {
        const cbChanged = cb.width !== this._baseCbW || cb.height !== this._baseCbH;
        if (cbChanged) {
          const dipChanged = !this._baseDip ||
            this.dipRect.width !== this._baseDip.width ||
            this.dipRect.height !== this._baseDip.height;
          if (!dipChanged) {
            // reportRect 尚未同步：按内容区宽高变化比例缩放视频区宽高
            const sw = cb.width / this._baseCbW;
            const sh = cb.height / this._baseCbH;
            // v2.15.94：变化比例异常（如最小化/恢复瞬时宽高突变）不缩放，仅刷新基准，
            // 避免把 dipRect 缩成 160x90 或放大到异常值。
            if (sw > 0 && sh > 0 && sw < 4 && sh < 4) {
              // width 始终按 sw 缩放：视频区宽度跟随内容区宽度，等比正确。
              this.dipRect.width = Math.max(160, Math.round(this.dipRect.width * sw));
              // v2.15.95：height 只在宽高近似等比（小幅拖动边框）时按 sh 缩放。最大化/还原
              // 等宽高不等比变化时，视频区高度跟随视频宽高比 + 上下黑边（不跟随内容区高度），
              // 用 sh 缩放会把高度缩错（实测最大化 879→1015，正确约 991），导致最大化/还原后
              // MPV 高度错误、反复抖动（"不跟随"）。此时保持旧高度，交由 guest reportRect
              // （500ms 定时 + resize + MutationObserver）上报真实值一次性纠正。
              // v2.24.7（用户反馈 1/2：直播切全屏 MPV 越切越小、明显跟不上）——
              // 直播页视频区就是内容区铺满（高度跟内容区高度走），点播页视频区高度才由
              // 视频宽高比 + 黑边决定。所以直播也按 sh 缩放高度，避免'宽度先到位、高度
              // 靠猜'的两跳（实测 980x731 → 1470x731 → 1620x943）。
              if ((this.player && this.player._isLive) || Math.abs(sw - sh) < 0.08) {
                this.dipRect.height = Math.max(90, Math.round(this.dipRect.height * sh));
              }
            }
          }
          // 更新基准（reportRect 已同步则仅刷新基准，不缩放）
          this._baseCbW = cb.width;
          this._baseCbH = cb.height;
          this._baseDip = { x: this.dipRect.x, y: this.dipRect.y, width: this.dipRect.width, height: this.dipRect.height };
        }
      } else {
        this._baseCbW = cb.width;
        this._baseCbH = cb.height;
        this._baseDip = { x: this.dipRect.x, y: this.dipRect.y, width: this.dipRect.width, height: this.dipRect.height };
      }
    } catch (_) {}
  }

  // v1.48.0：宿主窗口重新显示（一键呼出/解锁）后调用：恢复可见并重新贴合视频区。
  onHostShown() {
    try {
      if (this._dead || this._standalone) return;
      try { this.player.showWindow(); } catch (_) {}
      this._applyGeometry();
    } catch (_) {}
  }

  // ---------------- 独立窗口拖回吸附（v1.48.0） ----------------
  _startDockPolling() {
    if (this._dockTimer || this._dead) return;
    let lastMpvKey = '';
    this._dockTimer = setInterval(async () => {
      try {
        if (this._dead || this._pip) return;
        const p = this.player;
        if (!p.connected) return;
        // 读 mpv 原生窗口当前几何（屏幕 DIP）
        let gx, gy, gw, gh;
        try {
          const [x, y, w, h] = await Promise.all([
            p.getProperty('x'), p.getProperty('y'), p.getProperty('width'), p.getProperty('height')
          ]);
          gx = parseInt(x, 10); gy = parseInt(y, 10); gw = parseInt(w, 10); gh = parseInt(h, 10);
        } catch (_) { return; }
        if (!isFinite(gx) || !isFinite(gw) || gw <= 0) return;
        const mpvKey = `${gx},${gy},${gw},${gh}`;
        const target = this._resolveDockTarget ? this._resolveDockTarget() : null;
        if (!target) { // 无可吸附宿主：若已吸附则脱离
          if (this._docked) { this._docked = false; try { p.command(['set_property', 'ontop', 'no']); } catch (_) {} }
          lastMpvKey = mpvKey; return;
        }
        // mpv 窗口与宿主内容区的重叠面积占比
        const ox = Math.max(0, Math.min(gx + gw, target.x + target.width) - Math.max(gx, target.x));
        const oy = Math.max(0, Math.min(gy + gh, target.y + target.height) - Math.max(gy, target.y));
        const overlap = ox * oy;
        const mpvArea = gw * gh;
        const ratio = mpvArea > 0 ? overlap / mpvArea : 0;
        // 吸附阈值：窗口超过 55% 面积进入宿主区域 → 吸附贴合
        const shouldDock = ratio >= 0.55;
        if (shouldDock && !this._docked) {
          this._docked = true;
          try {
            // 贴合到宿主内容区（留边），置顶并跟随
            this._dockTarget = target;
            await p.command(['set_property', 'ontop', 'yes']);
            p.setGeometry({ x: target.x, y: target.y, width: target.width, height: target.height });
            this._emit('log', 'dock.attach ' + JSON.stringify(target));
          } catch (_) {}
        } else if (!shouldDock && this._docked) {
          // 拖出宿主区域 → 脱离，恢复自由窗口
          this._docked = false;
          try { p.command(['set_property', 'ontop', 'no']); } catch (_) {}
          this._dockTarget = null;
          this._emit('log', 'dock.detach');
        } else if (this._docked) {
          // 已吸附：宿主移动/缩放时持续贴合（独立窗口没有父窗 move 事件，靠轮询对齐）
          const tk = `${target.x},${target.y},${target.width},${target.height}`;
          if (tk !== this._lastDockTargetKey) {
            this._lastDockTargetKey = tk;
            this._dockTarget = target;
            try { p.setGeometry({ x: target.x, y: target.y, width: target.width, height: target.height }); } catch (_) {}
          }
        }
        lastMpvKey = mpvKey;
      } catch (_) {}
    }, 600);
    if (this._dockTimer.unref) this._dockTimer.unref();
  }

  // 画中画：true=进入小窗（记录当前几何，缩到宿主内容区右下角 420px 宽、保持置顶、可拖动）；
  //        false=还原（重新贴合视频区并跟随）。返回进入后的 PiP 状态。
  // 画中画：进入小窗（记录全屏几何，缩到右下角小窗，置顶可拖动）；退出即还原全屏贴合。
  // mode: 'enter' | 'exit' | 'toggle'；sizePx 为小窗宽度（可调节大小）。
  // 计算画中画小窗几何（屏幕 DIP）。独立窗口用屏幕工作区，嵌入覆盖窗用宿主内容区。
  _computePiPBase() {
    if (this._standalone) {
      try {
        const { screen } = require('electron');
        const wa = screen.getPrimaryDisplay().workArea; // {x,y,width,height}
        return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
      } catch (_) { return { x: 0, y: 0, width: 1920, height: 1080 }; }
    }
    return this._computeScreenGeometry();
  }

  async setPiP(mode, sizePx) {
    if (this._dead) return { ok: false, error: '播放器已关闭', pip: false };
    try {
      const want = mode === 'enter' ? true : mode === 'exit' ? false : !this._pip;
      const p = this.player;
      try { this._emit("log", "pip request mode=" + mode + " want=" + (want ? "enter" : "exit") + " standalone=" + (this._standalone ? 1 : 0) + " pip=" + (this._pip ? 1 : 0)); } catch (_) {}
      if (want) {
        if (!this._pip) {
          this._pipSize = sizePx || this._pipSize || 420;
          if (this._standalone) {
            // 独立窗口：先退出全屏，再保存 mpv 自身窗口几何（x/y/width/height）
            try { await p.command(['set_property', 'fullscreen', 'no']); } catch (_) {}
            try {
              const [x, y, w, h] = await Promise.all([
                p.getProperty('x'), p.getProperty('y'), p.getProperty('width'), p.getProperty('height')
              ]);
              if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) && w > 0) {
                this._pipSavedWin = { x, y, width: w, height: h };
              }
            } catch (_) {}
          } else {
            this._pipSavedGeo = this._computeScreenGeometry();
          }
        } else if (sizePx) {
          this._pipSize = sizePx; // 已在画中画时调节大小
        }
        this._pip = true;
        // 进入小窗前必须退出全屏，否则全屏会覆盖几何导致"仍是全画面"
        try { await p.command(['set_property', 'fullscreen', 'no']); } catch (_) {}
        try { await p.command(['set_property', 'ontop', 'yes']); } catch (_) {}
        // 两种形态都保持无边框（运行时切 border 会让 Windows/d3d11 重建窗口、重置几何）
        try { await p.command(['set_property', 'border', 'no']); } catch (_) {}
        // 暂停宿主几何跟随，避免小窗被周期 setRect 拉回视频区
        this._lastBoundsKey = '__pip__';
        const full = this._standalone ? this._computePiPBase() : (this._pipSavedGeo || this._computeScreenGeometry());
        if (full && full.width > 0) {
          const w = Math.min(this._pipSize, Math.round(full.width * 0.9));
          const h = Math.round(w * 9 / 16);
          const x = Math.round(full.x + full.width - w - 24);
          const y = Math.round(full.y + full.height - h - 24);
          p._lastGeoStr = ''; // 清掉去抖缓存，强制下发小窗几何
          try { await p.setGeometry({ x, y, width: w, height: h }); } catch (_) {}
        }
        try { this._emit("log", "pip enter size=" + this._pipSize); } catch (_) {}
      } else {
        // 退出画中画
        this._pip = false;
        try { await p.command(['set_property', 'fullscreen', 'no']); } catch (_) {}
        try { await p.command(['set_property', 'border', 'no']); } catch (_) {}
        if (this._standalone) {
          // 独立窗口：恢复置顶策略（不常驻置顶），并还原到进入画中画前的窗口几何
          try { await p.command(['set_property', 'ontop', 'no']); } catch (_) {}
          p._lastGeoStr = '';
          if (this._pipSavedWin) { try { await p.setGeometry(this._pipSavedWin); } catch (_) {} }
          this._pipSavedWin = null;
        } else {
          // 嵌入覆盖窗：保持置顶，重新贴合视频区并恢复跟随
          try { await p.command(['set_property', 'ontop', 'yes']); } catch (_) {}
          this._lastBoundsKey = '';
          p._lastGeoStr = '';
          this._applyGeometry();
        }
        try { this._emit("log", "pip exit"); } catch (_) {}
      }
      // v3.0.71：画中画窗口保持置顶，退出画中画回到“只压宿主”的从属层级
      try { this._applyTopPolicy(); } catch (_) {}
      return { ok: true, pip: this._pip };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), pip: !!this._pip };
    }
  }

  // 兼容旧入口
  async togglePiP() { return this.setPiP('toggle'); }

  isPip() { return !!this._pip; }

  // v2.17.55：主进程下发宿主全屏真值（唯一权威来源 __fsStateMap）。
  // 为什么不在渲染层自己判断：Electron 的 isFullScreen() 在 transparent + frame:false 窗口上
  // 恒为 false；电视直播窗又是独立创建路径，enter-full-screen 等事件原本完全没接线。
  // 幂等：状态没变就只重算一次几何，避免与 200ms 轮询互相打架。
  setHostState(st) {
    if (this._standalone || this._dead) return;
    const fs = !!(st && st.fs);
    if (fs === this._isHostFs()) { this._applyGeometry(); return; }
    if (fs) { try { this._fsEnter(); } catch (_) {} }
    else { try { this._fsExit(); } catch (_) {} }
  }

  // 更新视频区 DIP 坐标（guest 持续上报 / 网页滚动 / 缩放）
  setRect(dipRect, viewOffset) {
    if (dipRect) {
      this.dipRect = dipRect;
      // v2.15.89：reportRect 已同步上报新坐标，同步刷新 resize 兜底基准，避免
      // 网页滚动导致的 dipRect 变化被误判为"resize 未同步"而重复缩放。
      if (this._baseCbW > 0) {
        this._baseDip = { x: this.dipRect.x, y: this.dipRect.y, width: this.dipRect.width, height: this.dipRect.height };
      }
    }
    if (viewOffset) this.viewOffset = { x: viewOffset.x || 0, y: viewOffset.y || 0 };
    this._applyGeometry();
  }

  setVisible(v) {
    if (this._dead) return;
    try { v ? this.player.showWindow() : this.player.hideWindow(); } catch (_) {}
  }

  // v3.0.71：统一决定 mpv 原生窗口的层级。
  //   · 已挂 owner（常规窗口化播放）：ontop=no —— Windows 的从属关系已保证它恒在宿主之上，
  //     不需要 topmost，也就不会压住别的程序和任务栏；
  //   · 宿主全屏 / 画中画：ontop=yes —— 这两种场景本来就要盖住任务栏与其它窗口；
  //   · 未挂上 owner / 独立播放器：保持原有行为不动。
  _applyTopPolicy() {
    if (this._dead || this._standalone) return;
    if (!this._ownerOk) return;
    const p = this.player;
    if (!p || !p.isRunning() || !p.connected) return;
    const wantTop = !!this._pip || this._isHostFs();
    try { p.command(['set_property', 'ontop', wantTop ? 'yes' : 'no']).catch(() => {}); } catch (_) {}
  }

  // 置顶开关（设置页/对话框打开时降层，关闭后恢复）
  setOntop(on) {
    if (this._dead) return;
    // v3.0.71：挂上 owner 后，层级不再由 ontop 决定（否则关掉对话框又会被重新置顶成
    // 压住一切），统一交给 _applyTopPolicy；
    if (this._ownerOk && !this._standalone) { try { this._applyTopPolicy(); } catch (_) {} return; }
    try { this.player.setOntop(on); } catch (_) {}
  }

  isAlive() { return !this._dead && this.player && this.player.isRunning(); }

  play(url, headers, opts) {
    // 记住最后一次播放参数：mac 上「几何显著变化 → 重启 mpv」后要原样重放同一路流。
    this._lastPlay = { url, headers: headers || null, opts: Object.assign({}, opts || {}) };
    if (process.platform !== 'darwin' || this._standalone) return this.player.loadfile(url, headers, opts);
    // v5.1.31（用户反馈：影视 MPV 起播慢 4.7 秒）——真机取证定位到根因：
    // 「播放前自校准」会额外 spawn 1~2 次 mpv 去量窗口真实位置，每次量不到就轮询 ~2.5s 才放弃；
    // 而真机上 CGWindowList/System Events 都量不到（日志 `macdiag.mpv.calib.nomeasure`），
    // 于是每次播放白等约 4.7 秒 —— 实测 mpv `spawn→IPC 就绪` 只要 203ms，
    // 但 mpv 收到 loadfile 已经是 4.949s，差值全在这里。
    // 既然测量在真机上不可用，且偏移量已由实测常量给出（adjY=-30），直接跳过校准。
    if (__loadMacGeom().calibBroken) {
      return this.player.loadfile(url, headers, opts);
    }
    // mac：先做启动几何自校准（最多两次额外 spawn，都发生在 loadfile 之前，不会打断画面），再加载媒体。
    return this._macAlignBeforePlay().then(() => {
      if (this._dead) return;
      return this.player.loadfile(url, headers, opts);
    });
  }

  control(action, value) {
    const p = this.player;
    if (!p.isRunning()) return;
    switch (action) {
      case 'pauseToggle': return p.command(['cycle', 'pause']).catch(() => {});
      case 'seek': return p.seek(value);
      case 'volume': return p.setVolume(value);
      case 'stop': return p.command(['stop']).catch(() => {});
    }
  }

  destroy() {
    if (this._dead) return;
    this._dead = true;
    // v5.1.23：停掉 mac 重启贴合/校准留下的定时器
    try { if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; } } catch (_) {}
    try { if (this._macCalibTimer) { clearTimeout(this._macCalibTimer); this._macCalibTimer = null; } } catch (_) {}
    try { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; } } catch (_) {}
    try { if (this._dockTimer) { clearInterval(this._dockTimer); this._dockTimer = null; } } catch (_) {}
    try {
      if (this.parent && !this.parent.isDestroyed()) {
        this.parent.removeListener('move', this._moveHandler);
        this.parent.removeListener('resize', this._resizeHandler);
        this.parent.removeListener('minimize', this._minHandler);
        this.parent.removeListener('restore', this._restoreHandler);
        this.parent.removeListener('hide', this._hideHandler);
        this.parent.removeListener('show', this._showHandler);
        try { this.parent.removeListener('focus', this._raiseMpv); } catch (_) {}
        this.parent.removeListener('closed', this._closedHandler);
        try { this.parent.removeListener('enter-full-screen', this._enterFsHandler); } catch (_) {}
        try { this.parent.removeListener('leave-full-screen', this._leaveFsHandler); } catch (_) {}
        try { this.parent.removeListener('maximize', this._maximizeHandler); } catch (_) {}
        try { this.parent.removeListener('unmaximize', this._maximizeHandler); } catch (_) {}
        try {
          const wc = this.parent.webContents;
          if (wc) {
            wc.removeListener('enter-html-full-screen', this._enterHtmlFsHandler);
            wc.removeListener('leave-html-full-screen', this._leaveHtmlFsHandler);
          }
        } catch (_) {}
      }
    } catch (_) {}
    try { this.player.stop(); } catch (_) {}
  }
}

module.exports = { MpvSurface };
