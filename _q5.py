# -*- coding: utf-8 -*-
import io, re
s = io.open('main.js', encoding='utf-8', errors='replace').read()
lines = s.split('\n')
want = ['function withWebContents', 'function pickMenuGuest', 'function hostWindowFromSender', 'function _applyMpvLayer', 'function buildDownloadsMenu']
out = []
for w in want:
    i = s.find(w)
    if i < 0:
        out.append('MISSING ' + w)
        continue
    ln = s[:i].count('\n') + 1
    seg = s[i:i + 1200]
    out.append('===== %s (line %d)\n%s' % (w, ln, seg))
io.open('_out.txt', 'w', encoding='utf-8').write('\n\n'.join(out))
print('ok')
