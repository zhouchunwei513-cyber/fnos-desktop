# -*- coding: utf-8 -*-
import io
p = '_patch_transparent.py'
s = io.open(p, encoding='utf-8').read()
s = s.replace("expect=2)", "expect=3)", 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('expect3=', 'expect=3)' in s)
