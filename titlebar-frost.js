'use strict';
/**
 * titlebar-frost.js —— 标题栏「磨砂」效果的屏幕背景采样器
 *
 * 背景：Windows 上 Electron 的原生 backgroundMaterial:'acrylic' 只在「窗口非透明」时生效，
 * 而非透明窗口拿不到本项目要的 20px 自定义圆角（SetWindowRgn 也裁不掉 DWM 磨砂层，已实测）。
 * 于是磨砂改为「自绘」：抓取窗口背后的真实屏幕画面（桌面/其他程序），交给渲染层做模糊，
 * 圆角、透明标题栏、皮肤体系全部保持原样。
 *
 * 关键点：
 *  1. 抓屏前给窗口设 setContentProtection(true)（WDA_EXCLUDEFROMCAPTURE），否则截到的是窗口自己；
 *     抓完立刻恢复原值，避免影响用户截图/录屏。
 *  2. 缩略图取小（352px 宽）→ 天然低分辨率 + 渲染层再 blur，得到磨砂颗粒感，同时数据量小。
 *  3. v3.0.82：采样从「120ms 常驻轮询」改成「事件驱动 + debounce」。原来的常驻轮询在窗口
 *     移动时每 480ms 就抓一次，而 desktopCapturer.getSources 单次约 300ms 且跑在主进程 ——
 *     等于每半秒把事件循环堵一次，setBounds/IPC 全排队，用户看到的就是「拖动一卡一卡、
 *     菜单点不出来」。现在只在「手停下来 220ms 后 / 切换磨砂 / 松手 / 15s 静止兜底」抓一张。
 *  4. 只在磨砂模式且窗口可见时工作，纯色模式零开销。
 */

const { desktopCapturer, screen } = require('electron');

const THUMB_W = 352;        // 缩略图宽度（越小越糊、传输越省；v3.0.82 从 480 降下来减回读量）
const JPEG_Q = 58;
const ACTIVE_MS = 480;      // 移动结束后紧接着的那次补抓之后，稍等再抓一张（应对连续轻推）
const IDLE_MS = 15000;      // 静止兜底间隔（壁纸/桌面变化时仍能更新，代价可忽略）
const MIN_GAP = 90;         // 两次抓取的最小间隔，防抖
const KICK_DEBOUNCE = 220;  // 窗口动过之后多久才允许抓（拖动过程中不抓）

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
  // v3.0.80：拖动期间整段挂起采样，抓回来的图对应的是旧窗口位置，直接丢掉
  if (entry.suspend) return;
  entry.lastAt = Date.now();
  try {
    const wc = win.webContents;
    if (wc && !wc.isDestroyed()) wc.send('titlebar-frost-bg', shot);
  } catch (_) {}
}

// 单次调度（替代原来的 120ms 常驻轮询）
function schedule(entry, delay) {
  if (!entry || !entry.enabled) return;
  if (entry.timer) { try { clearTimeout(entry.timer); } catch (_) {} }
  entry.timer = setTimeout(() => {
    entry.timer = null;
    runOnce(entry);
  }, Math.max(0, Math.round(delay || 0)));
  try { if (entry.timer.unref) entry.timer.unref(); } catch (_) {}
}

function cpReset(entry) {
  // 兜底：若窗口还停在「排除捕获」状态而当前并没有在抓取（上次 finally 因异常没跑到），强制复位，
  // 否则用户截图/录屏里会看不到自己的窗口
  try {
    if (entry.cpPrev === false && entry.win && !entry.win.isDestroyed() &&
        typeof entry.win.isContentProtected === 'function' && entry.win.isContentProtected()) {
      entry.win.setContentProtection(false);
      logInfo('frost.cp-reset', { win: entry.win.id });
    }
  } catch (_) {}
}

function runOnce(entry) {
  if (!entry || !entry.enabled) return;
  if (!entry.win || entry.win.isDestroyed()) return;
  // 拖动中：不抓，稍后再看一眼（松手会主动 schedule(0) 补抓）
  if (entry.suspend) { schedule(entry, 1200); return; }
  if (entry.busy) { schedule(entry, 200); return; }
  const gap = Date.now() - (entry.lastAt || 0);
  if (gap < MIN_GAP) { schedule(entry, MIN_GAP - gap); return; }

  cpReset(entry);
  entry.busy = true;
  Promise.resolve()
    .then(() => capture(entry))
    .then((shot) => { if (shot) send(entry, shot); })
    .catch(() => {})
    .then(() => {
      entry.busy = false;
      // 兜底：静止后长时间无事件时仍按 IDLE_MS 更新一次（壁纸/桌面可能变了）
      schedule(entry, entry.active ? ACTIVE_MS : IDLE_MS);
    });
}

/** 标记窗口「刚动过」：debounce 到动作停止后再抓一张（拖动中零抓屏） */
function kick(win, ms) {
  const entry = entryOf.get(win && win.id);
  if (!entry || !entry.enabled) return;
  entry.active = true;
  if (entry.activeTimer) { try { clearTimeout(entry.activeTimer); } catch (_) {} }
  entry.activeTimer = setTimeout(() => {
    entry.active = false;
    entry.activeTimer = null;
  }, ms || 2000);
  schedule(entry, KICK_DEBOUNCE);
}

/** 立即抓一张（切到磨砂模式 / 改浓度时用） */
function refresh(win) {
  const entry = entryOf.get(win && win.id);
  if (!entry || !entry.enabled) return;
  entry.lastAt = 0;
  entry.active = true;
  schedule(entry, 0);
}

/** 启用/停用某窗口的磨砂采样 */
function setEnabled(win, on) {
  if (!win || win.isDestroyed()) return;
  let entry = entryOf.get(win.id);
  if (!entry) {
    entry = { win, enabled: false, busy: false, lastAt: 0, active: true, timer: null, activeTimer: null, suspend: false };
    entryOf.set(win.id, entry);
  }
  const want = !!on;
  if (entry.enabled === want) {
    if (want) { entry.lastAt = 0; entry.active = true; schedule(entry, 0); }
    return;
  }
  entry.enabled = want;
  if (want) {
    entry.lastAt = 0;
    entry.active = true;
    schedule(entry, 0);
    logInfo('frost.enable', { win: win.id });
  } else {
    if (entry.timer) { try { clearTimeout(entry.timer); } catch (_) {} entry.timer = null; }
    if (entry.activeTimer) { try { clearTimeout(entry.activeTimer); } catch (_) {} entry.activeTimer = null; }
    logInfo('frost.disable', { win: win.id });
  }
}

/**
 * v3.0.80（用户反馈：磨砂模式下按住标题栏拖动严重不跟手）——
 * 根因：desktopCapturer.getSources 单次约 300ms 且跑在主进程，拖动期间每 0.5s 卡一次事件循环。
 * 但拖动根本不需要重新抓图：抓到的是一整张屏幕画面，窗口只是在这张图上平移取景框。
 * 所以拖动期间整段挂起（渲染层用 titlebar-frost-pos 自己挪 background-position），
 * 松手后再补抓一张（桌面内容可能已经变了）。
 * v3.0.82：挂起动作前移到指针按下那一刻（main.js 的 win-drag-arm），不再等 win-drag-start。
 */
function setSuspend(win, on) {
  const entry = entryOf.get(win && win.id);
  if (!entry) return;
  const want = !!on;
  if (!!entry.suspend === want) return;
  entry.suspend = want;
  logInfo('frost.suspend', { win: win.id, on: want });
  if (!want) {
    entry.lastAt = 0;
    entry.active = true;
    schedule(entry, 0);
  } else if (entry.timer) {
    try { clearTimeout(entry.timer); } catch (_) {}
    entry.timer = null;
  }
}

/** 窗口销毁时清理 */
function dispose(win) {
  const entry = entryOf.get(win && win.id);
  if (!entry) return;
  if (entry.timer) { try { clearTimeout(entry.timer); } catch (_) {} entry.timer = null; }
  if (entry.activeTimer) { try { clearTimeout(entry.activeTimer); } catch (_) {} }
  entry.enabled = false;
  entryOf.delete(win.id);
}

function isEnabled(win) {
  const entry = entryOf.get(win && win.id);
  return !!(entry && entry.enabled);
}

module.exports = { setLogger, setEnabled, refresh, kick, dispose, isEnabled, setSuspend };
