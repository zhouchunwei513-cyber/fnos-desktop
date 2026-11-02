# -*- coding: utf-8 -*-
import io
s = io.open('main.js', encoding='utf-8', errors='replace').read().split('\n')
rng = list(range(3420, 3470)) + list(range(5530, 5580)) + list(range(16970, 17005))
io.open('_out.txt', 'w', encoding='utf-8').write('\n'.join('%d: %s' % (i + 1, s[i]) for i in rng))
print('ok')
