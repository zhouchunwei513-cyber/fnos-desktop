# -*- coding: utf-8 -*-
import io, re
s = io.open('main.js', encoding='utf-8', errors='replace').read()
i = s.find('function buildMenuTemplate')
print('def_line', s[:i].count('\n') + 1)
seg = s[i:i + 20000]
j = seg.find('\nfunction ')
seg = seg[:j if j > 0 else 20000]
print('labels', re.findall(r"label:\s*'([^']{1,24})'", seg))
print('seg_lines', seg.count('\n'))
for m in re.finditer(r".*(app-menu|appMenu|showMenu|menu:popup).*", s):
    ln = s[:m.start()].count('\n') + 1
    if ln > 3000:
        print('TRIG', ln, m.group(0).strip()[:130])
