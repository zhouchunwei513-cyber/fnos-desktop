# -*- coding: utf-8 -*-
# v3.0.62 补丁（第二轮）：settings.js / settings.html / settings.css / help.html / about.html
import re

def load(p):
    raw = open(p, 'rb').read()
    bom = raw.startswith(b'\xef\xbb\xbf')
    return raw.decode('utf-8-sig'), bom

def save(p, txt, bom):
    open(p, 'wb').write((b'\xef\xbb\xbf' if bom else b'') + txt.encode('utf-8'))

def nl_of(t):
    return '\r\n' if '\r\n' in t else '\n'

def sub(txt, pat, rep, expect=1):
    new, n = re.subn(pat, rep, txt, flags=re.M)
    if n != expect:
        raise SystemExit('COUNT MISMATCH got=%d expect=%d pat=%s' % (n, expect, pat[:80]))
    return new

ok = []

# ---------------- settings.js ----------------
p = 'settings.js'
t, bom = load(p)
N = nl_of(t)
t = sub(t, r"^(?P<i>[ \t]*)if \(optHideBall\) optHideBall\.addEventListener\('change', syncHideBallLabel\);\r?$",
        lambda m: (m.group('i') + "if (optHideBall) optHideBall.addEventListener('change', syncHideBallLabel);" + N +
                   N +
                   m.group('i') + "// v3.0.62：透明界面开关（设置 / 帮助 / 检查更新（关于）页面半透明）" + N +
                   m.group('i') + "const optUiTrans = document.getElementById('opt-ui-transparent');" + N +
                   m.group('i') + "const optUiTransLabel = document.getElementById('opt-ui-transparent-label');" + N +
                   m.group('i') + "const syncUiTransLabel = () => {" + N +
                   m.group('i') + "  if (optUiTransLabel) optUiTransLabel.textContent = (optUiTrans && optUiTrans.checked) ? '已开启' : '已关闭';" + N +
                   m.group('i') + "};" + N +
                   m.group('i') + "if (optUiTrans) optUiTrans.addEventListener('change', syncUiTransLabel);"))
t = sub(t, r"^(?P<i>[ \t]*)if \(optHideBall\) \{ optHideBall\.checked = info\.hideAccountBall === true; syncHideBallLabel\(\); \}\r?$",
        lambda m: (m.group('i') + "if (optHideBall) { optHideBall.checked = info.hideAccountBall === true; syncHideBallLabel(); }" + N +
                   m.group('i') + "if (optUiTrans) { optUiTrans.checked = info.uiTransparent === true; syncUiTransLabel(); }"))
t = sub(t, r"^(?P<i>[ \t]*)hideAccountBall: !!\(optHideBall && optHideBall\.checked\),\r?$",
        lambda m: (m.group('i') + "hideAccountBall: !!(optHideBall && optHideBall.checked)," + N +
                   m.group('i') + "uiTransparent: !!(optUiTrans && optUiTrans.checked),"))
save(p, t, bom); ok.append(p)

# ---------------- settings.html ----------------
p = 'settings.html'
t, bom = load(p)
N = nl_of(t)
anchor = t.find('id="opt-hide-account-ball-label"')
if anchor < 0:
    raise SystemExit('settings.html anchor missing')
end = t.find('</div>', anchor)
if end < 0:
    raise SystemExit('settings.html </div> missing')
end += len('</div>')
block = (N + N +
    '        <!-- v3.0.62：透明界面（设置 / 帮助 / 检查更新 半透明，可看到背后窗口） -->' + N +
    '        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid rgba(255,255,255,0.06)">' + N +
    '          <div>' + N +
    '            <div class="hotkey-title">透明界面</div>' + N +
    '            <div class="hotkey-sub">开启后「设置 / 帮助 / 检查更新（关于）」页面变为半透明玻璃，可看到背后窗口内容；默认关闭，保持现有不透明外观。</div>' + N +
    '          </div>' + N +
    '          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">' + N +
    '            <input type="checkbox" id="opt-ui-transparent" style="width:18px;height:18px;cursor:pointer" />' + N +
    '            <span id="opt-ui-transparent-label" style="font-size:13px;color:var(--text-secondary,#aab0c0)">已关闭</span>' + N +
    '          </label>' + N +
    '        </div>')
t = t[:end] + block + t[end:]
save(p, t, bom); ok.append(p)

# ---------------- settings.css ----------------
p = 'settings.css'
t, bom = load(p)
N = nl_of(t)
t = t + N + N + (
    '/* v3.0.62：可选「透明界面」——开启后设置页蒙层变淡，背后窗口内容可见 */' + N +
    'html.fnos-ui-transparent .scrim {' + N +
    '  background: radial-gradient(ellipse at 50% 40%, rgba(8,10,22,.10), rgba(5,6,10,.26) 70%) !important;' + N +
    '}' + N +
    'html.fnos-ui-transparent .settings-head { border-bottom-color: rgba(255,255,255,.10); }' + N +
    'html.fnos-ui-transparent .settings-section { border-bottom-color: rgba(255,255,255,.08); }' + N)
save(p, t, bom); ok.append(p)

# ---------------- help.html / about.html ----------------
jobs = [
    ('help.html',
     'html.fnos-ui-transparent body { background: rgba(6,8,14,.38) !important; }',
     'html.fnos-ui-transparent .bg-wrap { display: none !important; }',
     '/* v3.0.62：可选「透明界面」——去掉页面自带黑底与壁纸层，只留淡蒙层保证可读 */'),
    ('about.html',
     'html.fnos-ui-transparent body { background: rgba(5,6,10,.38) !important; }',
     'html.fnos-ui-transparent .bg { display: none !important; }',
     '/* v3.0.62：可选「透明界面」——去掉页面自带黑底与渐变层，只留淡蒙层保证可读 */'),
]
for p, r1, r2, cmt in jobs:
    t, bom = load(p)
    N = nl_of(t)
    i = t.lower().rfind('</head>')
    if i < 0:
        raise SystemExit(p + ' no </head>')
    t = t[:i] + ('<style>' + N + cmt + N + r1 + N + r2 + N + '</style>' + N) + t[i:]
    save(p, t, bom); ok.append(p)

print('PATCHED2', ', '.join(ok))
