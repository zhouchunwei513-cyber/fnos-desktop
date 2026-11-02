'use strict';
/**
 * titlebar-frost.js —— 标题栏「磨砂」效果的屏幕背景采样器（v3.0.78）
 *
 * 背景：Windows 上 Electron 的原生 backgroundMaterial:'acrylic' 只在「窗口非透明」时生效，
 * 而非透明窗口拿不到本项目要的 20px 自定义圆角（SetWindowRgn 也裁不掉 DWM 磨砂层，已实测）。
 * 于是磨砂改为「自绘」：抓取窗口背后的真实屏幕画面（桌面/其他程序），交给渲染层做模糊，
 * 圆角、透明标题栏、皮肤体系全部保持原样。
 *
 * 关键点：
 *  1. 抓屏前给窗口设 setContentProtection(true)（WDA_EXCLUDEFROMCAPTURE），否则截到的是窗口自己；
 *     抓完立刻恢复原值，避免影响用户截图/录屏。
 *  2. 缩略图取小（480px 宽）→ 天然低分辨率 + 渲染层再 blur，得到磨砂颗粒感，同时数据量小。
 *  3. 采样节奏：窗口移动/缩放/激活后走 ACTIVE_MS；静止 IDLE_MS；最小化/隐藏则停。
 *  4. 只在磨砂模式且窗口可见时工作，纯色模式零开销。
 */

const { desktopCapturer, screen } = require('electron');

const THUMB_W = 480;        // 缩略图宽度（越小越糊、传输越省）
const JPEG_Q = 58;
const ACTIVE_MS = 240;      // 活动期采样间隔
const IDLE_MS = 6000;       // 静止期采样间隔（实测单次抓取约 300ms，静止期拉长以降低干扰与功耗）
const MIN_GAP = 90;         // 两次抓取的最小间隔，防抖

const entryOf = new Map();  // win.id -> entry

let __logger = null;
function setLogger(fn) { __logger = (typeof fn === 'function') ? fn : null; }

function logInfo(evt, obj) {
  try { if (__logger) __logger('info', 'titlebar', evt, obj); } catch (_) {}
}

function displayOf(win) {
  try {
    return screen.getDisplayMatching(win.getBounds());
  } catch (_) {
    try { return screen.getPrimaryDisplay(); } catch (_e) { return null; }
  }
}

async function capture(entry) {
  const win = entry.win;
  if (!win || win.isDestroyed()) return null;
  if (!entry.enabled) return null;
  let visible = true;
  try { visible = win.isVisible() && !win.isMinimized(); } catch (_) { visible = false; }
  if (!visible) return null;
  const disp = displayOf(win);
  if (!disp) return null;

  const tw = THUMB_W;
  const th = Math.max(1, Math.round((tw * disp.size.height) / Math.max(1, disp.size.width)));
  const bounds = win.getBounds();

  // 抓取期间把自己从画面里排除（WDA_EXCLUDEFROMCAPTURE）
  // 首次抓取时记住窗口原本的 contentProtection 值（用户可能自己开过隐私保护），抓完原样恢复
  let prevCp = false;
  if (entry.cpPrev === undefined) {
    try { entry.cpPrev = (typeof win.isContentProtected === 'function') ? !!win.isContentProtected() : false; } catch (_) { entry.cpPrev = false; }
  }
  prevCp = !!entry.cpPrev;
  // 只给主窗设即可：实测 WDA_EXCLUDEFROMCAPTURE 按窗口树生效，webview 的 OOPIF guest（独立 HWND）
  // 会随主窗一起从截图里消失，不会出现"自己糊自己"
  let opened = false;
  try { win.setContentProtection(true); opened = true; } catch (_) {}
  let shot = null;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: tw, height: th },
      fetchWindowIcons: false,
    });
    if (sources && sources.length) {
      const sid = String(disp.id);
      let src = null;
      for (const s of sources) {
        if (String(s.display_id) === sid) { src = s; break; }
      }
      if (!src) src = sources[0];
      if (src && src.thumbnail && !src.thumbnail.isEmpty()) {
        const buf = src.thumbnail.toJPEG(JPEG_Q);
        if (buf && buf.length) {
          shot = {
            url: 'data:image/jpeg;base64,' + buf.toString('base64'),
            sw: disp.size.width,     // 屏幕逻辑宽（CSS px）
            sh: disp.size.height,
            wx: bounds.x,            // 窗口左上角在屏幕上的逻辑坐标
            wy: bounds.y,
            bw: bounds.width,
            bh: bounds.height,
          };
        }
      }
    }
  } catch (err) {
    logInfo('frost.capture-fail', { err: String((err && err.message) || err).slice(0, 160) });
  } finally {
    if (opened) {
      try { win.setContentProtection(prevCp); } catch (_) {}
    }
  }
  return shot;
}

function send(entry, shot) {
  const win = entry.win;
  if (!win || win.isDestroyed() || !shot) return;
  entry.lastAt = Date.now();
  try {
    const wc = win.webContents;
    if (wc && !wc.isDestroyed()) wc.send('titlebar-frost-bg', shot);
  } catch (_) {}
}

function tick(entry) {
  if (!entry.enabled) return;
  if (entry.busy) return;
  // 兜底：若窗口还停在「排除捕获」状态而当前并没有在抓取（上次 finally 因异常没跑到），强制复位，
  // 否则用户截图/录屏里会看不到自己的窗口
  try {
    if (entry.cpPrev === false && entry.win && !entry.win.isDestroyed() &&
        typeof entry.win.isContentProtected === 'function' && entry.win.isContentProtected()) {
      entry.win.setContentProtection(false);
      logInfo('frost.cp-reset', { win: entry.win.id });
    }
  } catch (_) {}
  const now = Date.now();
  const gap = now - (entry.lastAt || 0);
  const want = entry.active ? ACTIVE_MS : IDLE_MS;
  if (gap < Math.max(MIN_GAP, want)) return;
  entry.busy = true;
  Promise.resolve()
    .then(() => capture(entry))
    .then((shot) => { if (shot) send(entry, shot); })
    .catch(() => {})
    .then(() => { entry.busy = false; });
}

function ensureTimer(entry) {
  if (entry.timer) return;
  entry.timer = setInterval(() => tick(entry), 120);
  try { if (entry.timer.unref) entry.timer.unref(); } catch (_) {}
}

function stopTimer(entry) {
  if (entry.timer) {
    try { clearInterval(entry.timer); } catch (_) {}
    entry.timer = null;
  }
}

/** 标记窗口「刚动过」，接下来一段时间用高频采样 */
function kick(win, ms) {
  const entry = entryOf.get(win && win.id);
  if (!entry || !entry.enabled) return;
  entry.active = true;
  if (entry.activeTimer) { try { clearTimeout(entry.activeTimer); } catch (_) {} }
  entry.activeTimer = setTimeout(() => {
    entry.active = false;
    entry.activeTimer = null;
  }, ms || 1400);
  tick(entry);
}

/** 立即抓一张（切到磨砂模式 / 改浓度时用） */
function refresh(win) {
  const entry = entryOf.get(win && win.id);
  if (!entry || !entry.enabled) return;
  entry.lastAt = 0;
  entry.active = true;
  tick(entry);
}

/** 启用/停用某窗口的磨砂采样 */
function setEnabled(win, on) {
  if (!win || win.isDestroyed()) return;
  let entry = entryOf.get(win.id);
  if (!entry) {
    entry = { win, enabled: false, busy: false, lastAt: 0, active: true, timer: null, activeTimer: null };
    entryOf.set(win.id, entry);
  }
  const want = !!on;
  if (entry.enabled === want) {
    if (want) { entry.lastAt = 0; entry.active = true; tick(entry); }
    return;
  }
  entry.enabled = want;
  if (want) {
    ensureTimer(entry);
    entry.lastAt = 0;
    entry.active = true;
    tick(entry);
    logInfo('frost.enable', { win: win.id });
  } else {
    stopTimer(entry);
    if (entry.activeTimer) { try { clearTimeout(entry.activeTimer); } catch (_) {} entry.activeTimer = null; }
    logInfo('frost.disable', { win: win.id });
  }
}

/** 窗口销毁时清理 */
function dispose(win) {
  const entry = entryOf.get(win && win.id);
  if (!entry) return;
  stopTimer(entry);
  if (entry.activeTimer) { try { clearTimeout(entry.activeTimer); } catch (_) {} }
  entry.enabled = false;
  entryOf.delete(win.id);
}

function isEnabled(win) {
  const entry = entryOf.get(win && win.id);
  return !!(entry && entry.enabled);
}

module.exports = { setLogger, setEnabled, refresh, kick, dispose, isEnabled };
