# -*- coding: utf-8 -*-
# 在 titlebar-inject.js 里加「透明界面」class 应用（纯字符串替换，不做转义处理）
p = 'titlebar-inject.js'
raw = open(p, 'rb').read()
bom = raw.startswith(b'\xef\xbb\xbf')
t = raw.decode('utf-8-sig')

A_OLD = "        if (typeof r.hideAccountBall === 'boolean') TB.hideAccountBall = r.hideAccountBall;"
A_NEW = (
    "        if (typeof r.hideAccountBall === 'boolean') TB.hideAccountBall = r.hideAccountBall;\n"
    "        // v3.0.62：可选「透明界面」——给 html 挂 class，由各页面 CSS 接管\n"
    "        try { document.documentElement.classList.toggle('fnos-ui-transparent', r.uiTransparent === true); } catch (_) {}"
)

B_OLD = (
    "              try { if (window.__fnApplyBallHidden) window.__fnApplyBallHidden(val.hideAccountBall); } catch (_) {}\n"
    "            }"
)
B_NEW = (
    "              try { if (window.__fnApplyBallHidden) window.__fnApplyBallHidden(val.hideAccountBall); } catch (_) {}\n"
    "            }\n"
    "            // v3.0.62：透明界面实时切换（无需重启）\n"
    "            if (typeof val.uiTransparent === 'boolean') {\n"
    "              try { document.documentElement.classList.toggle('fnos-ui-transparent', val.uiTransparent === true); } catch (_) {}\n"
    "            }"
)

for old, new, name in [(A_OLD, A_NEW, 'A'), (B_OLD, B_NEW, 'B')]:
    n = t.count(old)
    if n != 1:
        raise SystemExit('%s count=%d' % (name, n))
    t = t.replace(old, new, 1)

open(p, 'wb').write((b'\xef\xbb\xbf' if bom else b'') + t.encode('utf-8'))
print('INJECTED titlebar-inject.js ok')
