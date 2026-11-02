# -*- coding: utf-8 -*-
"""v3.0.80: titlebar-inject.js 磨砂层拖动本地平移（background-position 只改一个属性）"""
import io, sys

P = 'titlebar-inject.js'
s = io.open(P, encoding='utf-8', newline='').read()
orig = len(s)
def rep(old, new, tag):
    global s
    n = s.count(old)
    if n != 1:
        print('FAIL', tag, 'count=', n); sys.exit(1)
    s = s.replace(old, new, 1)
    print('ok', tag)

# 1) __paintFrost：图/染色/尺寸没变就只改 background-position
rep("""      if (!g || !g.url) {
        __frostEl.style.backgroundImage = 'none';
        return;
      }""",
"""      if (!g || !g.url) {
        __frostEl.style.backgroundImage = 'none';
        __frostEl.__paintKey = '';
        return;
      }""",
'paint.empty')

rep("""      __frostEl.style.backgroundImage = 'linear-gradient(' + __tint + ',' + __tint + '), url("' + g.url + '")';
      __frostEl.style.backgroundSize = '100% 100%, ' + g.sw + 'px ' + g.sh + 'px';
      __frostEl.style.backgroundPosition = '0 0, ' + (72 - g.wx) + 'px ' + (72 - g.wy) + 'px';""",
"""      // v3.0.80：只有「图 / 染色 / 尺寸」变了才重写 background-image。
      // 拖动时窗口每帧都在动，但图不变，只需改 background-position（纯合成层平移，GPU 直接搬）；
      // 若每帧重新赋 data URL，会触发重新解码整张图，反而把帧率拖死。
      const __pk = g.url + '|' + __tint + '|' + g.sw + 'x' + g.sh;
      if (__frostEl.__paintKey !== __pk) {
        __frostEl.__paintKey = __pk;
        __frostEl.style.backgroundImage = 'linear-gradient(' + __tint + ',' + __tint + '), url("' + g.url + '")';
        __frostEl.style.backgroundSize = '100% 100%, ' + g.sw + 'px ' + g.sh + 'px';
      }
      __frostEl.style.backgroundPosition = '0 0, ' + (72 - g.wx) + 'px ' + (72 - g.wy) + 'px';""",
'paint.key')

# 2) 新增 titlebar-frost-pos 监听
rep("""    function applyStyle(bar) {""",
"""    // v3.0.80：拖动期间主进程挂起抓屏，只推窗口新位置；这里用同一张图平移取景框，
    // 所以拖动时磨砂背景仍然实时跟着窗口走，而不是冻在半路或一卡一卡。
    try {
      ipcRenderer.on('titlebar-frost-pos', (_e, d) => {
        try {
          if (!d || !__frostGeom) return;
          if (TB.material !== 'frosted') return;
          __frostGeom.wx = Number(d.x) || 0;
          __frostGeom.wy = Number(d.y) || 0;
          const bar0 = document.getElementById('fnos-titlebar');
          if (bar0) __paintFrost(bar0);
        } catch (_) {}
      });
    } catch (_) {}

    function applyStyle(bar) {""",
'pos-listener')

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('bytes', orig, '->', len(s))
