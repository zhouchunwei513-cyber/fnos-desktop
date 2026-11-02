# -*- coding: utf-8 -*-
import io, json, re

p = io.open('package.json', encoding='utf-8', newline='').read()
print('CRLF', p.count('\r\n'), 'LF', p.count('\n'))
m = re.search(r'([ \t]*)"main\.js",(\r?\n)', p)
print('found main.js entry', bool(m), repr(m.group(0)) if m else '')
if m:
    nl = m.group(2)
    ins = m.group(0) + '      "menu-popup.html",' + nl + '      "menu-popup.js",' + nl + '      "menu-popup-preload.js",' + nl
    p = p[:m.start()] + ins + p[m.end():]
    json.loads(p)
    io.open('package.json', 'w', encoding='utf-8', newline='').write(p)
    print('INSERTED')
else:
    print('STILL FAIL')
d = json.loads(p)
print('files', d['build']['files'][:6], 'ver', d['version'])
