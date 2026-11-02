# -*- coding: utf-8 -*-
import io, re

s = io.open('settings.html', encoding='utf-8', newline='', errors='replace').read()
i = s.find('opt-ui-transparent')
seg = s[max(0, i - 800):i + 200]
io.open('_out.txt', 'w', encoding='utf-8').write(seg)
print('ok')
