# -*- coding: utf-8 -*-
# 修复 patch1 里 re.sub 替换串把 \' 写进 JS 的问题
import io

BS = chr(92)  # backslash

def load(p):
    raw = open(p, 'rb').read()
    bom = raw.startswith(b'\xef\xbb\xbf')
    return raw.decode('utf-8-sig'), bom

def save(p, txt, bom):
    open(p, 'wb').write((b'\xef\xbb\xbf' if bom else b'') + txt.encode('utf-8'))

for p in ['main.js', 'titlebar-inject.js', 'settings-preload.js']:
    t, bom = load(p)
    n0 = t.count(BS + "'")
    # 把转义掉的引号还原（本仓库这三个文件里除我们刚插入的代码外没有需要保留的 \' 语义）
    t2 = t.replace(BS + "'", "'")
    save(p, t2, bom)
    print(p, 'escaped_quotes_before=', n0, 'after=', t2.count(BS + "'"))
