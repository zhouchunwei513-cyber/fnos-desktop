# -*- coding: utf-8 -*-
import io, json

fails = []


def rd(p):
    return io.open(p, encoding='utf-8', newline='').read()


def wr(p, s):
    io.open(p, 'w', encoding='utf-8', newline='').write(s)


# 1) main.js：每次打开菜单把 __menuShownAt 归零，保证兜底定时器有效
p = 'main.js'
s = rd(p)
old = """  __menuCtxWin = (hostWin && !hostWin.isDestroyed()) ? hostWin : null;
  __mpvMenuOpening = true;"""
new = """  __menuCtxWin = (hostWin && !hostWin.isDestroyed()) ? hostWin : null;
  __menuShownAt = 0;
  __mpvMenuOpening = true;"""
if s.count(old) != 1:
    fails.append('shownat')
s = s.replace(old, new)
wr(p, s)

# 2) menu-popup.js：PAD 18 给阴影留余量；行高 32 更接近系统菜单
p = 'menu-popup.js'
s = rd(p)
old = "  var PAD = 14;   /* 留给阴影的边距 */"
new = "  var PAD = 18;   /* 留给阴影的边距 */"
if s.count(old) != 1:
    fails.append('pad')
s = s.replace(old, new)
wr(p, s)

# 3) settings.html：说明文案补上「☰ 菜单」
p = 'settings.html'
s = rd(p)
old = '开启后设置页、帮助页、检查更新（关于）页均为半透明玻璃，可看到背后的窗口与桌面壁纸；关闭则恢复现有的深色不透明界面。默认开启。'
new = '开启后设置页、帮助页、检查更新（关于）页以及标题栏「☰」下拉菜单均为半透明玻璃，可看到背后的窗口与桌面壁纸；关闭则恢复现有的深色界面。默认开启。'
if s.count(old) != 1:
    fails.append('hint')
s = s.replace(old, new)
wr(p, s)

# 4) 版本号校验
m = rd('main.js')
print('APP_VERSION', "const APP_VERSION = '3.0.64';" in m)
pk = json.loads(rd('package.json'))
print('PKG_VERSION', pk.get('version'))
print('FILES_HAS_MENU', 'menu-popup.html' in (pk.get('build', {}).get('files') or []))
print('FAILS', fails)
