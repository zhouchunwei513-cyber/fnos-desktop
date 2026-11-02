# -*- coding: utf-8 -*-
import io

s = io.open('main.js', encoding='utf-8', newline='', errors='replace').read()
lines = s.split('\n')
out = []
for i, l in enumerate(lines, 1):
    if l.startswith('function loadSettings') or l.startswith('function buildMenuTemplate') or l.startswith('let cachedSettings') or l.startswith('var cachedSettings') or l.startswith('const cachedSettings'):
        out.append('%d: %s' % (i, l.strip()[:120]))
io.open('_out.txt', 'w', encoding='utf-8').write('\n'.join(out))
print('n', len(out))
