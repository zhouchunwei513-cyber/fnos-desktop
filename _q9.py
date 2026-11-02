# -*- coding: utf-8 -*-
import io, re

s = io.open('main.js', encoding='utf-8', newline='', errors='replace').read()
lines = s.split('\n')
out = []
for i, l in enumerate(lines, 1):
    if '__mpvMenuOpening' in l:
        out.append('%d: %s' % (i, l.strip()[:160]))
io.open('_out.txt', 'w', encoding='utf-8').write('\n'.join(out))
print('n', len(out))
