# -*- coding: utf-8 -*-
import io, json

fails = []

# ---- package.json: files + version ----
p = io.open('package.json', encoding='utf-8', newline='').read()
old_files = '      "main.js",\n      "mpv-player.js",'
print('files anchor', p.count(old_files))
if p.count(old_files) != 1:
    fails.append('files anchor')
p = p.replace(old_files, '      "main.js",\n      "menu-popup.html",\n      "menu-popup.js",\n      "menu-popup-preload.js",\n      "mpv-player.js",', 1)

old_ver = '"version": "3.0.63"'
print('pkg ver', p.count(old_ver))
if p.count(old_ver) != 1:
    fails.append('pkg ver')
p = p.replace(old_ver, '"version": "3.0.64"', 1)
json.loads(p)
io.open('package.json', 'w', encoding='utf-8', newline='').write(p)

# ---- main.js: APP_VERSION ----
m = io.open('main.js', encoding='utf-8', newline='').read()
old_av = "const APP_VERSION = '3.0.63';"
print('appver', m.count(old_av))
if m.count(old_av) != 1:
    fails.append('appver')
m = m.replace(old_av, "const APP_VERSION = '3.0.64';", 1)
io.open('main.js', 'w', encoding='utf-8', newline='').write(m)

# ---- settings.html: 文案加入 ☰ 菜单 ----
h = io.open('settings.html', encoding='utf-8', newline='').read()
old_txt = '<div class="hotkey-sub">开启后设置页、帮助页、检查更新（关于）页均为半透明玻璃，可看到背后的窗口与桌面壁纸；关闭则恢复现有的深色不透明界面。默认开启。</div>'
print('hint', h.count(old_txt))
if h.count(old_txt) != 1:
    fails.append('hint')
h = h.replace(old_txt, '<div class="hotkey-sub">开启后设置页、帮助页、检查更新（关于）页以及 ☰ 下拉菜单均为半透明玻璃，可看到背后的窗口与桌面壁纸；关闭则全部恢复深色不透明界面。默认开启。</div>', 1)
io.open('settings.html', 'w', encoding='utf-8', newline='').write(h)

print('FAILS', fails)
