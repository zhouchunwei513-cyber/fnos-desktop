# -*- coding: utf-8 -*-
import io

p = 'menu-popup.html'
s = io.open(p, encoding='utf-8', newline='').read()

old = "    min-width: 208px;"
new = "    min-width: 92px;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 一级面板只有两字标签，行内左右留白略收一点，视觉更紧凑
old2 = """    height: 30px;
    padding: 0 10px;"""
new2 = """    height: 30px;
    padding: 0 10px;
    min-height: 30px;"""
assert s.count(old2) == 1
s = s.replace(old2, new2, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('CSS_PATCHED')
