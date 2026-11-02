# -*- coding: utf-8 -*-
import io
s = io.open('main.js', encoding='utf-8', errors='replace').read().split('\n')
io.open('_out.txt', 'w', encoding='utf-8').write('\n'.join(f"{i+1}: {s[i]}" for i in range(3280, 3330)))
print('ok')
