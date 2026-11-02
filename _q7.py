# -*- coding: utf-8 -*-
import io, re
s = io.open('main.js', encoding='utf-8', errors='replace').read()
out = []
for m in re.finditer(r"\.on\('blur'[^\n]*", s):
    ln = s[:m.start()].count('\n') + 1
    out.append('%d: %s' % (ln, m.group(0).strip()[:200]))
io.open('_out.txt', 'w', encoding='utf-8').write('\n'.join(out))
print(len(out))
