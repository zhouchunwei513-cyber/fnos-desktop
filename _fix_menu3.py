# -*- coding: utf-8 -*-
import io

p = 'menu-popup.js'
s = io.open(p, encoding='utf-8', newline='').read()

old = """    closeFrom(level);
    child.style.display = 'block';
"""
new = """    closeFrom(level);
    child.style.display = 'block';
    child.style.visibility = 'visible';
"""
print('cnt', s.count(old))
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('PATCHED')
