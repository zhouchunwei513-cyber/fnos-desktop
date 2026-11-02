# -*- coding: utf-8 -*-
import io, json

p = io.open('package.json', encoding='utf-8', newline='').read()
NL = '\r\n'

anchor = '"main.js",' + NL + '      "mpv-player.js",'
print('anchor', p.count(anchor))
assert p.count(anchor) == 1
ins = ('"main.js",' + NL +
       '      "menu-popup.html",' + NL +
       '      "menu-popup.js",' + NL +
       '      "menu-popup-preload.js",' + NL +
       '      "mpv-player.js",')
p = p.replace(anchor, ins, 1)

old_ver = '"version": "3.0.63"'
print('ver', p.count(old_ver))
assert p.count(old_ver) == 1
p = p.replace(old_ver, '"version": "3.0.64"', 1)

d = json.loads(p)
io.open('package.json', 'w', encoding='utf-8', newline='').write(p)
print('OK ver', d['version'])
print('files0-8', d['build']['files'][:8])
