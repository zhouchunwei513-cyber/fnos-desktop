# -*- coding: utf-8 -*-
"""v3.0.80: titlebar-frost.js 拖动期挂起采样（修「磨砂下拖标题栏严重不跟手」）"""
import io, sys

P = 'titlebar-frost.js'
s = io.open(P, encoding='utf-8', newline='').read()
orig = len(s)
def rep(old, new, tag):
    global s
    n = s.count(old)
    if n != 1:
        print('FAIL', tag, 'count=', n); sys.exit(1)
    s = s.replace(old, new, 1)
    print('ok', tag)

# 1) 常量：降低活动期采样频率（拖动已改为本地平移，不再需要高频重抓）
rep("""const ACTIVE_MS = 240;      // 活动期采样间隔""",
    """const ACTIVE_MS = 480;      // 活动期采样间隔（v3.0.80：拖动已改为本地平移重定位，不必高频重抓）""",
    'ACTIVE_MS')

# 2) send：挂起期间丢弃（拖动中窗口在动，旧位置的图会把背景拉错位）
rep("""function send(entry, shot) {
  const win = entry.win;
  if (!win || win.isDestroyed() || !shot) return;""",
    """function send(entry, shot) {
  const win = entry.win;
  if (!win || win.isDestroyed() || !shot) return;
  // v3.0.80：拖动期间整段挂起采样，抓回来的图对应的是旧窗口位置，直接丢掉
  if (entry.suspend) return;""",
    'send.suspend')

# 3) tick：挂起期间直接返回（不起 timer 逻辑、不做任何抓取）
rep("""function tick(entry) {
  if (!entry.enabled) return;
  if (entry.busy) return;""",
    """function tick(entry) {
  if (!entry.enabled) return;
  if (entry.suspend) return;   // v3.0.80：拖动窗口期间完全不抓屏（见 setSuspend）
  if (entry.busy) return;""",
    'tick.suspend')

# 4) entry 初始化带 suspend 字段
rep("""    entry = { win, enabled: false, busy: false, lastAt: 0, active: true, timer: null, activeTimer: null };""",
    """    entry = { win, enabled: false, busy: false, lastAt: 0, active: true, timer: null, activeTimer: null, suspend: false };""",
    'entry.suspend')

# 5) 新增 setSuspend
rep("""/** 窗口销毁时清理 */""",
    """/**
 * v3.0.80（用户反馈：磨砂模式下按住标题栏拖动严重不跟手）——
 * 根因：desktopCapturer.getSources 单次约 300ms 且跑在主进程，拖动期间每 0.5s 卡一次事件循环，
 * setBounds 被排在后面 → 窗口一卡一卡地追鼠标。
 * 但拖动根本不需要重新抓图：抓到的是一整张屏幕画面，窗口只是在这张图上平移取景框。
 * 所以拖动期间整段挂起（渲染层用 titlebar-frost-pos 自己挪 background-position），
 * 松手后再补抓一张（桌面内容可能已经变了）。
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
    tick(entry);
  }
}

/** 窗口销毁时清理 */""",
    'setSuspend')

# 6) 导出
rep("""module.exports = { setLogger, setEnabled, refresh, kick, dispose, isEnabled };""",
    """module.exports = { setLogger, setEnabled, refresh, kick, dispose, isEnabled, setSuspend };""",
    'exports')

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('bytes', orig, '->', len(s))
