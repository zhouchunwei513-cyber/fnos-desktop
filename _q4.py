# -*- coding: utf-8 -*-
import io
s = io.open('main.js', encoding='utf-8', errors='replace').read()
i = s.find('function buildMenuTemplate')
seg = s[i:i + 30000]
j = seg.find('\nfunction ', 10)
if j > 0:
    seg = seg[:j]
io.open('_menu_tpl.txt', 'w', encoding='utf-8').write(seg)
print('lines', seg.count('\n'), 'chars', len(seg))
