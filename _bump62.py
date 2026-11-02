# -*- coding: utf-8 -*-
def bump(path, old, new):
    raw = open(path, 'rb').read()
    bom = raw.startswith(b'\xef\xbb\xbf')
    txt = raw.decode('utf-8-sig')
    n = txt.count(old)
    if n != 1:
        print('WARN', path, 'count=', n)
        return
    txt = txt.replace(old, new, 1)
    open(path, 'wb').write((b'\xef\xbb\xbf' if bom else b'') + txt.encode('utf-8'))
    print('OK', path, 'bom=', bom)

bump('main.js', "const APP_VERSION = '3.0.61';", "const APP_VERSION = '3.0.62';")
bump('package.json', '"version": "3.0.61"', '"version": "3.0.62"')
