# -*- coding: utf-8 -*-
import io
for f in ['titlebar-frost.js', 'main.js', 'titlebar-inject.js', 'package.json']:
    b = open(f, 'rb').read(6)
    print(f, b)
    raw = open(f, 'rb').read()
    print('  len', len(raw), 'bom_ff_fe', raw[:2] == b'\xff\xfe', 'bom_ef_bb', raw[:3] == b'\xef\xbb\xbf')
    # try decode
    for enc in ('utf-8', 'utf-16'):
        try:
            t = raw.decode(enc)
            print('  decode', enc, 'ok', len(t), repr(t[:40]))
            break
        except Exception as e:
            print('  decode', enc, 'fail', e)
