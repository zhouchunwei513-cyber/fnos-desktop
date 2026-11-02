# -*- coding: utf-8 -*-
import io

p = 'menu-popup.js'
s = io.open(p, encoding='utf-8', newline='').read()
old = "    panel.style.visibility = 'hidden';\n    if (level > 0) panel.style.display = 'none';\n"
print('count', s.count(old))
assert s.count(old) == 1
s = s.replace(old, "    panel.style.visibility = 'hidden';\n", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('PATCHED')
