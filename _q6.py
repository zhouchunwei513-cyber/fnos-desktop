# -*- coding: utf-8 -*-
import io, re
s = io.open('main.js', encoding='utf-8', errors='replace').read()
i = s.find("require('electron')")
out = []
out.append('REQUIRE_LINE %d: %s' % (s[:i].count('\n') + 1, s[max(0, i - 300):i + 300]))
for k in ['screen.getCursorScreenPoint', 'screen.getDisplayNearestPoint', 'const { app, BrowserWindow']:
    j = s.find(k)
    out.append('FIND %s -> %s' % (k, 'yes line %d' % (s[:j].count('\n') + 1) if j >= 0 else 'NO'))
io.open('_out.txt', 'w', encoding='utf-8').write('\n\n'.join(out))
print('ok')
