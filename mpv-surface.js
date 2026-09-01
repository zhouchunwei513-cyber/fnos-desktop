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
      // 用户点 mpv 窗口自带关闭按钮：冒泡给 main.js 回收嵌入层（否则崩溃自愈会重启）
      this.player.on('user-closed', () => { this._dead = true; this._emit('user-closed'); });
      this._started = true;
    } catch (e) {
      this._emit('log', 'surface start failed: ' + (e && e.message));
    }
  }

  _applyGeometry() {
    if (this._dead) return;
    const geo = this._computeScreenGeometry();
    if (geo && this._started) { try { this.player.setGeometry(geo); } catch (_) {} }
  }

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
