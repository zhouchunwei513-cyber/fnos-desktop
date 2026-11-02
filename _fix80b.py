# -*- coding: utf-8 -*-
"""v3.0.80: main.js 拖动期间挂起磨砂采样 + 每帧推送新窗口位置"""
import io, sys

P = 'main.js'
s = io.open(P, encoding='utf-8', newline='').read()
orig = len(s)
def rep(old, new, tag):
    global s
    n = s.count(old)
    if n != 1:
        print('FAIL', tag, 'count=', n); sys.exit(1)
    s = s.replace(old, new, 1)
    print('ok', tag)

# 1) 在 __dragPollStop 前插入挂起/定位 helper，并让 __dragPollStop 负责收尾恢复
rep("""let __dragPollTimer = null;
function __dragPollStop() {
  try { if (__dragPollTimer) { clearInterval(__dragPollTimer); __dragPollTimer = null; } } catch (_) {}
}""",
"""let __dragPollTimer = null;
// ==================== v3.0.80：拖动期间挂起磨砂采样 ====================
// 用户反馈「设置磨砂效果后按住标题栏拖动严重不跟手」。根因：磨砂背景靠主进程 desktopCapturer
// 抓屏，单次约 300ms 且跑在主进程，拖动时每半秒把事件循环堵一次 → setBounds 排队 → 窗口一卡一卡。
// 但拖动根本不需要重抓：抓到的是整张屏幕画面，窗口只是在这张图上平移取景框。所以拖动期间
// 整段挂起采样，只把新窗口位置推给渲染层（background-position 平移），松手后再补抓一张。
let __frostDragWin = null;
function __frostDragStart(w) {
  try {
    if (!w || w.isDestroyed()) return;
    if (!titlebarFrost.isEnabled(w)) return;
    __frostDragWin = w;
    titlebarFrost.setSuspend(w, true);
  } catch (_) {}
}
function __frostDragEnd() {
  const w = __frostDragWin;
  __frostDragWin = null;
  if (!w) return;
  try { if (!w.isDestroyed()) titlebarFrost.setSuspend(w, false); } catch (_) {}
}
function __frostPosTick(w, x, y) {
  try {
    if (!w || w.isDestroyed()) return;
    if (!titlebarFrost.isEnabled(w)) return;
    const wc = w.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send('titlebar-frost-pos', { x: x, y: y });
  } catch (_) {}
}
function __dragPollStop() {
  try { if (__dragPollTimer) { clearInterval(__dragPollTimer); __dragPollTimer = null; } } catch (_) {}
  __frostDragEnd();
}""",
'poll-stop')

# 2) win-drag-start：开拖即挂起采样
rep("""    __dragPollStart(st);
    try {
      fnosLog('info', 'window', 'drag.start win=' + w.id + ' o=' + st.ox + ',' + st.oy""",
"""    __dragPollStart(st);
    __frostDragStart(w);
    try {
      fnosLog('info', 'window', 'drag.start win=' + w.id + ' o=' + st.ox + ',' + st.oy""",
'drag-start')

# 3) poll 循环里每次移动后推位置
rep("""      if (nx !== d.lx || ny !== d.ly) {
        d.lx = nx; d.ly = ny;
        try {
          if (d.w0 && d.h0) d.win.setBounds({ x: nx, y: ny, width: d.w0, height: d.h0 });
          else d.win.setPosition(nx, ny);
        } catch (_) {}
      }""",
"""      if (nx !== d.lx || ny !== d.ly) {
        d.lx = nx; d.ly = ny;
        try {
          if (d.w0 && d.h0) d.win.setBounds({ x: nx, y: ny, width: d.w0, height: d.h0 });
          else d.win.setPosition(nx, ny);
        } catch (_) {}
        __frostPosTick(d.win, nx, ny);
      }""",
'poll-pos')

# 4) win-drag-move 路径同样推位置
rep("""    if (nx === d.lx && ny === d.ly) return;
    d.lx = nx; d.ly = ny;
    try {
      if (d.w0 && d.h0) d.win.setBounds({ x: nx, y: ny, width: d.w0, height: d.h0 });
      else d.win.setPosition(nx, ny);
    } catch (_) {
      try { d.win.setPosition(nx, ny); } catch (_) {}
    }""",
"""    if (nx === d.lx && ny === d.ly) return;
    d.lx = nx; d.ly = ny;
    try {
      if (d.w0 && d.h0) d.win.setBounds({ x: nx, y: ny, width: d.w0, height: d.h0 });
      else d.win.setPosition(nx, ny);
    } catch (_) {
      try { d.win.setPosition(nx, ny); } catch (_) {}
    }
    __frostPosTick(d.win, nx, ny);""",
'move-pos')

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('bytes', orig, '->', len(s))
