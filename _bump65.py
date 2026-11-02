# -*- coding: utf-8 -*-
import io, json

s = io.open('main.js', encoding='utf-8', newline='').read()
old = "const APP_VERSION = '3.0.64';"
assert s.count(old) == 1, s.count(old)
s = s.replace(old, "const APP_VERSION = '3.0.65';")
io.open('main.js', 'w', encoding='utf-8', newline='').write(s)

p = io.open('package.json', encoding='utf-8', newline='').read()
old2 = '"version": "3.0.64"'
assert p.count(old2) == 1, p.count(old2)
p = p.replace(old2, '"version": "3.0.65"')
io.open('package.json', 'w', encoding='utf-8', newline='').write(p)
json.loads(p)
print('BUMP_OK')
