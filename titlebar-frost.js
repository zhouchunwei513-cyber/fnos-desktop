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
 *  5. v4.0.26：每次采样都会让窗口在录屏/远程画面里短暂消失（见 ACTIVE_MS 段注释），
 *     所以采样必须"越少越好"——聚焦不再触发采样、未聚焦窗口不采样、静止兜底拉到 5min，
 *     并补 `frost.capture {trigger, ms, protectedMs}` 埋点，能直接量化占空比。
 *  6. v4.0.29：把「还会抓」的四条残留路径逐个掐掉（对应二轮验证报告 R1~R4 / P0-1~P0-4）：
 *     - P0-1 纯平移不抓图：已有底图且宽高/显示器没变时，只把窗口新坐标推给渲染层平移取景框
 *       （titlebar-frost-pos），不再重抓 —— 松手、拖动全程零抓屏。
 *     - P0-2 松开不立即抓：按住 <FLAP_MS(300ms) 的 press/release 判为远端输入抖动直接吞掉。
 *     - P0-3 补抓条件化：ACTIVE_MS 那次补抓只在「宽高真的变了」（resize/分屏/缩放）时执行。
 *     - P0-4 show/restore 冷却 15s，窗口显示/还原不再白闪。
 *     - P1 未聚焦一律不抓（只放行开窗首次），首次补图交给 focus 钩子。
 *     埋点新增 frost.reproject / frost.suspend.flap / frost.capture.skip / frost.budget。
 */

const { desktopCapturer, screen } = require('electron');

const THUMB_W = 352;        // 缩略图宽度（越小越糊、传输越省；v3.0.82 从 480 降下来减回读量）
const JPEG_Q = 58;
// v4.0.26（用户工单：QQ 录屏 / UU 远程时窗口"消失又出现"不断循环，RDP 里轻微闪烁）——
// 根因：每次采样都要在 getSources 前后开/关一次 setContentProtection(true)
// （= Win32 WDA_EXCLUDEFROMCAPTURE，"从所有采集管线里排除"），这段时间窗口在录屏/远程画面里
// 就是消失的；而采样被 focus/move/show 高频触发、活跃期每 480ms 补抓一张，
// 采集端看到的就成了约 1Hz 的"消失↔出现"循环。
// 处置：采样频率降两个数量级（活跃期 2s、静止兜底 5min、最小间隔 1s），聚焦不再触发采样，
// 未聚焦窗口不采样。常态零采样，只有用户移动/缩放结束后抓 1 张。
const ACTIVE_MS = 2000;      // 移动结束后紧接着的那次补抓之后，稍等再抓一张（应对连续轻推）
const IDLE_MS = 300000;      // 静止兜底：5min 一次（壁纸变化 5 分钟刷新一次完全够用）
const MIN_GAP = 1000;        // 两次抓取的最小间隔，防抖
const KICK_DEBOUNCE = 220;  // 窗口动过之后多久才允许抓（拖动过程中不抓）
// v4.0.29（P0-2）：按下→松开存活不足这么久的，判为远程输入抖动（UU/RDP 的 press/release
// 粒度粗，实测 30 组里 17 组 <300ms，最短 15ms），「松开」不再触发抓图。
const FLAP_MS = 300;
// v4.0.29（P0-4）：show/restore 的采样冷却——窗口显示/还原时背后桌面通常没变。
const SHOW_COOLDOWN_MS = 15000;

const entryOf = new Map();  // win.id -> entry

let __logger = null;
function setLogger(fn) { __logger = (typeof fn === 'function') ? fn : null; }

function logInfo(evt, obj) {
  try { if (__logger) __logger('info', 'titlebar', evt, obj); } catch (_) {}
}

// v4.0.29：占空比聚合——「窗口在采集画面里消失的时间占比」是这件事唯一值得盯的数。
// 每分钟输出一条 frost.budget（captures 次数 / protectedMs 之和 / duty）。
const __budget = { minute: -1, captures: 0, protectedMs: 0 };
function __budgetTick(protectedMs) {
  const m = Math.floor(Date.now() / 60000);
  if (__budget.minute !== m) {
    if (__budget.captures > 0) {
      logInfo('frost.budget', {
        captures: __budget.captures,
        protectedMsSum: __budget.protectedMs,
        duty: Math.round((__budget.protectedMs / 60000) * 10000) / 10000,
      });
    }
    __budget.minute = m;
    __budget.captures = 0;
    __budget.protectedMs = 0;
  }
  __budget.captures += 1;
  __budget.protectedMs += Math.max(0, Number(protectedMs) || 0);
}

function displayOf(win) {
  try {
    return screen.getDisplayMatching(win.getBounds());
  } catch (_) {
    try { return screen.getPrimaryDisplay(); } catch (_e) { return null; }
  }
}

async function capture(entry, trigger) {
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
  const __t0 = Date.now();     // v4.0.26：整次采样耗时
  let opened = false;
  try { win.setContentProtection(true); opened = true; entry.__protAt = Date.now(); } catch (_) {}
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
    const __protMs = opened ? Math.max(0, Date.now() - (entry.__protAt || __t0)) : 0;
    if (opened) {
      try { win.setContentProtection(prevCp); } catch (_) {}
    }
    // v4.0.26：每次采样一行日志——`protectedMs` 就是窗口在录屏/远程画面里"消失"的时长。
    // 以前只有 capture-fail / suspend，出问题只能靠事件时序反推"这个循环是谁在踢"。
    let __focused = null;
    try { __focused = win.isFocused(); } catch (_) {}
    logInfo('frost.capture', {
      win: win.id,
      trigger: String(trigger || 'timer'),
      ms: Date.now() - __t0,
      protectedMs: __protMs,
      thumb: tw + 'x' + th,
      ok: !!shot,
      focused: __focused,
    });
    __budgetTick(__protMs);
  }
  // v4.0.29（P0-1）：记下这张图对应的「窗口几何 + 显示器」。下次要采样时先比一次：
  // 宽高与显示器都没变、只是位置平移了 → 直接把窗口新坐标推给渲染层平移取景框，不重抓。
  if (shot) {
    entry.lastShotBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    entry.lastShotDisp = String(disp.id);
  }
  return shot;
}

function send(entry, shot) {
  const win = entry.win;
  if (!win || win.isDestroyed() || !shot) return;
  // v3.0.80：拖动期间整段挂起采样，抓回来的图对应的是旧窗口位置，直接丢掉
  if (entry.suspend) return;
  entry.lastAt = Date.now();
  entry.shotAt = entry.lastAt;   // v4.0.26：是否已经有底图（未聚焦延后采样的例外判断）
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

function __safeBounds(win) {
  try { return win && !win.isDestroyed() ? win.getBounds() : null; } catch (_) { return null; }
}

function runOnce(entry) {
  if (!entry || !entry.enabled) return;
  if (!entry.win || entry.win.isDestroyed()) return;
  // 拖动中：不抓，稍后再看一眼（松手会主动 schedule 补抓）
  if (entry.suspend) { schedule(entry, 1200); return; }
  // v4.0.26：未聚焦窗口不采样。聚焦/静止都不会改变窗口背后的画面，而每采一次就要把自己
  // 从采集管线里摘掉 ~300ms（录屏/远程端看到的就是"消失"）。
  // v4.0.29（P1）：从"有底图才延后"收紧成"一律延后"，只给「一张底图都还没有」的开窗类事件
  // 放行一次；其余首次补图交给 focus 钩子（__ensureFocusHook），避免未聚焦窗口被 move/resize
  // 反复抓图。否则磨砂层可能一直空着。
  let __focused = true;
  try { __focused = !!entry.win.isFocused(); } catch (_) { __focused = true; }
  if (!__focused) {
    const __tg = String(entry.trigger || 'timer');
    const __firstAllowed = !entry.shotAt &&
      (__tg === 'enable' || __tg === 'show' || __tg === 'focus-first' || __tg === 'refresh');
    if (!__firstAllowed) {
      logInfo('frost.capture.skip', { win: entry.win.id, reason: 'unfocused', trigger: __tg });
      entry.trigger = 'defer-unfocused';
      schedule(entry, IDLE_MS);
      return;
    }
  }
  if (entry.busy) { schedule(entry, 200); return; }
  const gap = Date.now() - (entry.lastAt || 0);
  if (gap < MIN_GAP) { schedule(entry, MIN_GAP - gap); return; }

  const __trigger = String(entry.trigger || 'timer');
  entry.trigger = '';

  // v4.0.29（P0-1）：纯平移不抓图。窗口只是在这张屏幕图上挪了取景框，背景根本没变，
  // 但每抓一次都要把自己从采集管线里摘掉 ~310ms——录屏/远程端看到的就是"窗口闪没了"。
  // 已有底图时，只要「宽高 + 显示器」没变、只是位置变了，就走 titlebar-frost-pos 平移，
  // 不重新抓屏（该通道拖动期间本来就在用，语义是「窗口新的绝对坐标」）。
  const __bounds = __safeBounds(entry.win);
  const __last = entry.lastShotBounds;
  const __disp = displayOf(entry.win);
  const __dispId = __disp ? String(__disp.id) : '';
  if (__last && __bounds && __trigger !== 'refresh' && __trigger !== 'enable' &&
      __bounds.width === __last.width && __bounds.height === __last.height &&
      (!__dispId || __dispId === entry.lastShotDisp) &&
      (__bounds.x !== __last.x || __bounds.y !== __last.y)) {
    try {
      const wc = entry.win.webContents;
      if (wc && !wc.isDestroyed()) wc.send('titlebar-frost-pos', { x: __bounds.x, y: __bounds.y });
    } catch (_) {}
    entry.lastShotBounds = { x: __bounds.x, y: __bounds.y, width: __bounds.width, height: __bounds.height };
    entry.lastShotDisp = __dispId || entry.lastShotDisp;
    entry.active = false;
    logInfo('frost.reproject', { win: entry.win.id, dx: __bounds.x - __last.x, dy: __bounds.y - __last.y });
    schedule(entry, IDLE_MS);
    return;
  }

  cpReset(entry);
  entry.busy = true;
  Promise.resolve()
    .then(() => capture(entry, __trigger))
    .then((shot) => { if (shot) send(entry, shot); })
    .catch(() => {})
    .then(() => {
      entry.busy = false;
      // v4.0.29（P0-3）：补抓也条件化。ACTIVE_MS 那次补抓本来是为了「连续轻推」，
      // 但对纯平移同样生效，于是每次拖动固定多闪一下（ACTIVE_MS=2s 后准时再来一次）。
      // 这里先看几何：宽高没变、显示器没变 → 纯平移，交给 P0-1，不抓。
      const __b2 = __safeBounds(entry.win);
      const __o2 = entry.lastShotBounds;
      const __d2 = displayOf(entry.win);
      const __d2id = __d2 ? String(__d2.id) : '';
      if (entry.active && __b2 && __o2 &&
          __b2.width === __o2.width && __b2.height === __o2.height &&
          (!__d2id || __d2id === entry.lastShotDisp)) {
        entry.active = false;
        logInfo('frost.capture.skip', { win: entry.win.id, reason: 'same-geom' });
        schedule(entry, IDLE_MS);
        return;
      }
      // 兜底：静止后长时间无事件时仍按 IDLE_MS 更新一次（壁纸/桌面可能变了）
      schedule(entry, entry.active ? ACTIVE_MS : IDLE_MS);
    });
}

/** 标记窗口「刚动过」：debounce 到动作停止后再抓一张（拖动中零抓屏） */
function kick(win, ms, trigger) {
  const entry = entryOf.get(win && win.id);
  if (!entry || !entry.enabled) return;
  const __tg = String(trigger || 'kick');
  // v4.0.29（P0-4）：show/restore 加冷却。窗口显示/还原时背后的桌面通常没变，
  // 为它白闪 310ms 不值得；已有底图时 15s 内不重复抓。
  if (__tg === 'show' || __tg === 'restore') {
    const __age = Date.now() - (entry.lastAt || 0);
    if (entry.shotAt && __age < SHOW_COOLDOWN_MS) {
      logInfo('frost.capture.skip', { win: win.id, reason: 'cooldown', trigger: __tg, ageMs: __age });
      return;
    }
  }
  entry.trigger = __tg;   // v4.0.26：埋点用（谁在踢采样）
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
  entry.trigger = 'refresh';
  entry.active = true;
  schedule(entry, 0);
}

// v4.0.29（P1）：未聚焦窗口不再被 move/resize 拉去抓图，但磨砂层总得有一张底图。
// 聚焦才是"用户真的在看它"的可靠信号——已有底图时无视（v4.0.26 起聚焦不重抓），
// 一张都没有时补抓一次，避免开窗后磨砂层一直是空的。
function __ensureFocusHook(entry) {
  if (!entry || entry.focusHooked) return;
  entry.focusHooked = true;
  try {
    entry.win.on('focus', () => {
      if (!entry.enabled || entry.shotAt) return;
      entry.trigger = 'focus-first';
      entry.active = true;
      schedule(entry, 0);
    });
  } catch (_) {}
}

/** 启用/停用某窗口的磨砂采样 */
function setEnabled(win, on) {
  if (!win || win.isDestroyed()) return;
  let entry = entryOf.get(win.id);
  if (!entry) {
    entry = {
      win, enabled: false, busy: false, lastAt: 0, shotAt: 0, trigger: '', active: true,
      timer: null, activeTimer: null, suspend: false,
      suspendAt: 0, lastShotBounds: null, lastShotDisp: '', focusHooked: false,
    };
    entryOf.set(win.id, entry);
  }
  __ensureFocusHook(entry);
  const want = !!on;
  if (entry.enabled === want) {
    // v4.0.26：状态没变就不要补抓。设置页拖动不透明度/模糊滑块时每 tick 都会走
    // settings:preview-titlebar → __syncFrostAll → setEnabled(win, true)，旧逻辑每次都
    // lastAt=0 + 立即 schedule(0)，等于拖动期间对每个窗口持续"摘出采集管线再放回"，
    // 录屏/远程画面里就是一阵密集闪烁。仅当这张窗口还没有底图时才补一次。
    if (want && !entry.shotAt) { entry.trigger = 'enable'; entry.active = true; schedule(entry, 0); }
    return;
  }
  entry.enabled = want;
  if (want) {
    entry.lastAt = 0;
    entry.trigger = 'enable';
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
    // v4.0.29（P0-2）：松开不再「立即抓」。先看这次按住持续了多久——远程输入的
    // press/release 会成对抖动，存活 <FLAP_MS 的一律当抖动吞掉，不调度抓取；
    // 真正的拖动结束后只排一次 KICK_DEBOUNCE(220ms)，且是否真抓由 P0-1/P0-3 按几何判断。
    const held = Date.now() - (entry.suspendAt || 0);
    entry.suspendAt = 0;
    if (held < FLAP_MS) {
      logInfo('frost.suspend.flap', { win: win.id, held: held });
      return;
    }
    entry.lastAt = 0;
    entry.active = true;
    schedule(entry, KICK_DEBOUNCE);
  } else {
    entry.suspendAt = Date.now();
    if (entry.timer) {
      try { clearTimeout(entry.timer); } catch (_) {}
      entry.timer = null;
    }
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
