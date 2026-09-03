'use strict';

// mpv-surface.js —— 应用内"视觉嵌入"播放层
// 采用 fntv 同款：mpv 自己的原生窗口（无边框、置顶、自带 OSC、可拖动），
// 但用屏幕坐标几何定位覆盖到宿主窗口的视频区域，随父窗移动/缩放跟随。
// 相比 Electron 透明覆盖窗 + --wid 的方案，原生窗口没有渲染层级/输入冲突，OSC、键盘、拖动全部可用。
//
// dipRect: 视频区相对【宿主内容区】的 DIP 坐标 {x,y,width,height}
// viewOffset: <webview> 在宿主页面内的偏移（标题栏等），DIP，{x,y}

const mpvMod = require('./mpv-player');

class MpvSurface {
  // parentWin: 宿主 BrowserWindow；dipRect: 视频区（相对内容区 DIP）
  constructor(parentWin, dipRect, opts = {}) {
    this.parent = parentWin;
    this._dead = false;
    this.viewOffset = { x: opts.viewOffsetX || 0, y: opts.viewOffsetY || 0 };
    this.dipRect = dipRect || { x: 0, y: 0, width: 800, height: 450 };
    this.player = new mpvMod.MpvPlayer();
    this._started = false;
    this._startSettings = opts.settings || {};
    this._onNeedFreshUrl = (typeof opts.onNeedFreshUrl === 'function') ? opts.onNeedFreshUrl : null;
    this._pollTimer = null;
    this._lastBoundsKey = '';
    // 画中画状态：小窗时脱离视频区几何跟随，固定右下角小尺寸、保持置顶、可自由拖动。
    this._pip = false;
    this._pipSavedGeo = null;
    // 注：log/end-file/exit 监听由 main.js（embedMpvPlay）统一绑定，这里不重复绑定。

    // 父窗移动/缩放/最小化时跟随
    if (parentWin && !parentWin.isDestroyed()) {
      this._moveHandler = () => this._applyGeometry();
      this._resizeHandler = () => this._applyGeometry();
      this._minHandler = () => { try { this.player.hideWindow(); } catch (_) {} };
      this._restoreHandler = () => { try { this.player.showWindow(); this._applyGeometry(); } catch (_) {} };
      this._closedHandler = () => this.destroy();
      parentWin.on('move', this._moveHandler);
      parentWin.on('resize', this._resizeHandler);
      parentWin.on('minimize', this._minHandler);
      parentWin.on('restore', this._restoreHandler);
      parentWin.on('closed', this._closedHandler);

      // 轮询兜底：拖动/缩放窗口时 'move'/'resize' 事件在部分平台不连续触发，
      // 定时比对内容区位置，变化即重新定位，保证 mpv 窗口始终贴合视频区。
      this._lastBoundsKey = '';
      this._pollTimer = setInterval(() => {
        try {
          const w = this.parent;
          if (!w || w.isDestroyed()) { this.destroy(); return; }
          if (w.isMinimized() || !w.isVisible()) return;
          const cb = w.getContentBounds();
          const key = `${cb.x},${cb.y},${cb.width},${cb.height}`;
          if (key !== this._lastBoundsKey) { this._lastBoundsKey = key; this._applyGeometry(); }
        } catch (_) {}
      }, 500);
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
  _computeScreenGeometry() {
    const r = this.dipRect;
    const off = this.viewOffset;
    const win = this.parent;
    if (!win || win.isDestroyed()) return null;
    const cb = win.getContentBounds();      // 内容区屏幕 DIP 坐标
    const x = cb.x + (off.x || 0) + (r.x || 0);
    const y = cb.y + (off.y || 0) + (r.y || 0);
    const width = Math.max(160, r.width);
    const height = Math.max(90, r.height);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    };
  }

  _start() {
    const geo = this._computeScreenGeometry();
    try {
      this.player.start({
        geometry: geo || undefined,
        hwDecode: this._startSettings.hwDecode || 'auto',
        cacheLevel: this._startSettings.cacheLevel || 'smooth',
        headers: this._startSettings.headers || null,
        // 点播断流（签名链接时效失效）时，由主进程注入回调重新签名取新鲜地址
        onNeedFreshUrl: this._onNeedFreshUrl || null
      });
      // 用户点 mpv 窗口自带关闭按钮：仅标记本嵌入层死亡。
      // 注意：绝不能再把 'user-closed' 通过 this.player.emit 回抛出去——该事件的监听者
      // 正是 player 自身，回抛会再次触发本处理器形成无限递归（事件风暴，主线程卡死/日志刷爆）。
      // main.js 直接在 player 上监听 'user-closed'/'exit' 做回收与通知网页，这里不中转。
      this.player.on('user-closed', () => { this._dead = true; });
      this._started = true;
    } catch (e) {
      this._emit('log', 'surface start failed: ' + (e && e.message));
    }
  }

  _applyGeometry() {
    if (this._dead) return;
    // 画中画小窗期间脱离视频区跟随（窗口已固定为右下角小尺寸并可被用户自由拖动），
    // 不再随宿主窗移动/滚动重定位。
    if (this._pip) return;
    const geo = this._computeScreenGeometry();
    if (geo && this._started) { try { this.player.setGeometry(geo); } catch (_) {} }
  }

  // 画中画：true=进入小窗（记录当前几何，缩到宿主内容区右下角 420px 宽、保持置顶、可拖动）；
  //        false=还原（重新贴合视频区并跟随）。返回进入后的 PiP 状态。
  // 画中画：进入小窗（记录全屏几何，缩到右下角小窗，置顶可拖动）；退出即还原全屏贴合。
  // mode: 'enter' | 'exit' | 'toggle'；sizePx 为小窗宽度（可调节大小）。
  async setPiP(mode, sizePx) {
    if (this._dead) return { ok: false, error: '播放器已关闭', pip: false };
    try {
      const want = mode === 'enter' ? true : mode === 'exit' ? false : !this._pip;
      const p = this.player;
      if (want) {
        // 进入画中画前，保存当前全屏几何，便于退出时精确还原
        if (!this._pip) {
          this._pipSavedGeo = this._computeScreenGeometry();
          this._pipSize = sizePx || this._pipSize || 420;
        } else if (sizePx) {
          this._pipSize = sizePx; // 已在画中画时调节大小
        }
        this._pip = true;
        try { await p.command(['set_property', 'ontop', 'yes']); } catch (_) {}
        // v1.32.2：画中画小窗【始终保持无边框】。运行时把 border 切到 yes 会让 Windows/d3d11
        //   的 mpv 重建窗口，重置几何与位置，出现带标题栏的全画面大窗（用户反馈的根因）。
        //   窗口本就 --window-dragging=yes，无边框小窗同样可自由拖动。
        try { await p.command(['set_property', 'border', 'no']); } catch (_) {}
        const full = this._pipSavedGeo || this._computeScreenGeometry();
        if (full && full.width > 0) {
          const w = Math.min(this._pipSize, Math.round(full.width * 0.9));
          const h = Math.round(w * 9 / 16);
          const x = Math.round(full.x + full.width - w - 24);
          const y = Math.round(full.y + full.height - h - 24);
          // 清掉去抖缓存，强制下发小窗几何（避免与全屏几何被判为"未变化"而不缩小）
          p._lastGeoStr = '';
          try { await p.setGeometry({ x, y, width: w, height: h }); } catch (_) {}
        }
        try { this._emit("log", "pip enter size=" + this._pipSize); } catch (_) {}
      } else {
        // 退出画中画：保持无边框、还原全屏几何并重新跟随视频区（点播/直播共用）
        this._pip = false;
        try { await p.command(['set_property', 'border', 'no']); } catch (_) {}
        try { await p.command(['set_property', 'ontop', 'yes']); } catch (_) {}
        this._lastBoundsKey = '';
        p._lastGeoStr = ''; // 强制重新下发全屏几何，确保退出后精确贴合并恢复跟随
        this._applyGeometry();
        try { this._emit("log", "pip exit"); } catch (_) {}
      }
      return { ok: true, pip: this._pip };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), pip: !!this._pip };
    }
  }

  // 兼容旧入口
  async togglePiP() { return this.setPiP('toggle'); }

  isPip() { return !!this._pip; }

  // 更新视频区 DIP 坐标（guest 持续上报 / 网页滚动 / 缩放）
  setRect(dipRect, viewOffset) {
    if (dipRect) this.dipRect = dipRect;
    if (viewOffset) this.viewOffset = { x: viewOffset.x || 0, y: viewOffset.y || 0 };
    this._applyGeometry();
  }

  setVisible(v) {
    if (this._dead) return;
    try { v ? this.player.showWindow() : this.player.hideWindow(); } catch (_) {}
  }

  // 置顶开关（设置页/对话框打开时降层，关闭后恢复）
  setOntop(on) {
    if (this._dead) return;
    try { this.player.setOntop(on); } catch (_) {}
  }

  isAlive() { return !this._dead && this.player && this.player.isRunning(); }

  play(url, headers, opts) { return this.player.loadfile(url, headers, opts); }

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
    try { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; } } catch (_) {}
    try {
      if (this.parent && !this.parent.isDestroyed()) {
        this.parent.removeListener('move', this._moveHandler);
        this.parent.removeListener('resize', this._resizeHandler);
        this.parent.removeListener('minimize', this._minHandler);
        this.parent.removeListener('restore', this._restoreHandler);
        this.parent.removeListener('closed', this._closedHandler);
      }
    } catch (_) {}
    try { this.player.stop(); } catch (_) {}
  }
}

module.exports = { MpvSurface };
