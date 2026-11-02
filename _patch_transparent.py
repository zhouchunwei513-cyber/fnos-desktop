# -*- coding: utf-8 -*-
# v3.0.62 「透明界面」开关补丁脚本
import re

def load(p):
    raw = open(p, 'rb').read()
    bom = raw.startswith(b'\xef\xbb\xbf')
    return raw.decode('utf-8-sig'), bom

def save(p, txt, bom):
    open(p, 'wb').write((b'\xef\xbb\xbf' if bom else b'') + txt.encode('utf-8'))

def sub(txt, pat, rep, expect=1, flags=re.M):
    new, n = re.subn(pat, rep, txt, flags=flags)
    if n != expect:
        raise SystemExit('COUNT MISMATCH got=%d expect=%d pat=%s' % (n, expect, pat[:70]))
    return new

ok = []

# ---------------- main.js ----------------
p = 'main.js'
t, bom = load(p)
# 1) settings:get 与 __titlebarPayload 两个 payload 都补 uiTransparent
t = sub(t, r'^(?P<i>[ \t]*)hideAccountBall: s\.hideAccountBall === true,$',
        r'\g<i>hideAccountBall: s.hideAccountBall === true,\n'
        r'\g<i>uiTransparent: s.uiTransparent === true,', expect=3)
# 2) set-ui-options：计算 uiTransparent
t = sub(t, r'^((?P<i>[ \t]*)const hideBall = \(opts && typeof opts\.hideAccountBall === \'boolean\'\)\s*\n'
           r'\s*\? opts\.hideAccountBall\s*\n\s*: \(__fileCfg && __fileCfg\.hideAccountBall === true\);)$',
        r'\g<1>\n'
        r'\g<i>// v3.0.62：可选「透明界面」（设置 / 帮助 / 检查更新（关于）页面半透明）\n'
        r'\g<i>const uiTransparent = (opts && typeof opts.uiTransparent === \'boolean\')\n'
        r'\g<i>  ? opts.uiTransparent\n'
        r'\g<i>  : (__fileCfg && __fileCfg.uiTransparent === true);')
# 3) saveSettings 落盘
t = sub(t, r'^(?P<i>[ \t]*)hideAccountBall: hideBall,$',
        r'\g<i>hideAccountBall: hideBall,\n\g<i>uiTransparent,')
# 4) cachedSettings
t = sub(t, r'^(?P<i>[ \t]*)cachedSettings\.hideAccountBall = hideBall;$',
        r'\g<i>cachedSettings.hideAccountBall = hideBall;\n'
        r'\g<i>cachedSettings.uiTransparent = uiTransparent;')
# 5) 广播 payload
t = sub(t, r'hideAccountBall: hideBall \};', r'hideAccountBall: hideBall, uiTransparent };')
save(p, t, bom); ok.append(p)

# ---------------- settings-preload.js ----------------
p = 'settings-preload.js'
t, bom = load(p)
t = sub(t, r'^(?P<i>[ \t]*)hideAccountBall: typeof opts\?\.hideAccountBall === \'boolean\' \? opts\.hideAccountBall : undefined,$',
        r'\g<i>hideAccountBall: typeof opts?.hideAccountBall === \'boolean\' ? opts.hideAccountBall : undefined,\n'
        r'\g<i>// v3.0.62：可选「透明界面」（设置 / 帮助 / 关于 页面半透明）\n'
        r'\g<i>uiTransparent: typeof opts?.uiTransparent === \'boolean\' ? opts.uiTransparent : undefined,')
save(p, t, bom); ok.append(p)

# ---------------- titlebar-inject.js ----------------
p = 'titlebar-inject.js'
t, bom = load(p)
# 初始 payload
t = sub(t, r'^(?P<i>[ \t]*)if \(typeof r\.hideAccountBall === \'boolean\'\) TB\.hideAccountBall = r\.hideAccountBall;$',
        r'\g<i>if (typeof r.hideAccountBall === \'boolean\') TB.hideAccountBall = r.hideAccountBall;\n'
        r'\g<i>// v3.0.62：可选「透明界面」——给 html 挂 class，由各页面 CSS 接管\n'
        r'\g<i>try { document.documentElement.classList.toggle(\'fnos-ui-transparent\', r.uiTransparent === true); } catch (_) {}')
# 实时广播
t = sub(t, r'^(?P<i>[ \t]*)try \{ if \(window\.__fnApplyBallHidden\) window\.__fnApplyBallHidden\(val\.hideAccountBall\); \} catch \(_\) \{\}\n(?P<j>[ \t]*)\}$',
        r'\g<i>try { if (window.__fnApplyBallHidden) window.__fnApplyBallHidden(val.hideAccountBall); } catch (_) {}\n'
        r'\g<j>}\n'
        r'\g<i>// v3.0.62：透明界面实时切换（无需重启）\n'
        r'\g<i>if (typeof val.uiTransparent === \'boolean\') {\n'
        r'\g<i>  try { document.documentElement.classList.toggle(\'fnos-ui-transparent\', val.uiTransparent === true); } catch (_) {}\n'
        r'\g<i>}')
save(p, t, bom); ok.append(p)

# ---------------- settings.js ----------------
p = 'settings.js'
t, bom = load(p)
t = sub(t, r'^(?P<i>[ \t]*)if \(optHideBall\) optHideBall\.addEventListener\(\'change\', syncHideBallLabel\);$',
        r'\g<i>if (optHideBall) optHideBall.addEventListener(\'change\', syncHideBallLabel);\n'
        r'\n'
        r'\g<i>// v3.0.62：透明界面开关（设置 / 帮助 / 检查更新（关于）页面半透明）\n'
        r'\g<i>const optUiTrans = document.getElementById(\'opt-ui-transparent\');\n'
        r'\g<i>const optUiTransLabel = document.getElementById(\'opt-ui-transparent-label\');\n'
        r'\g<i>const syncUiTransLabel = () => {\n'
        r'\g<i>  if (optUiTransLabel) optUiTransLabel.textContent = (optUiTrans && optUiTrans.checked) ? \'已开启\' : \'已关闭\';\n'
        r'\g<i>};\n'
        r'\g<i>if (optUiTrans) optUiTrans.addEventListener(\'change\', syncUiTransLabel);')
t = sub(t, r'^(?P<i>[ \t]*)if \(optHideBall\) \{ optHideBall\.checked = info\.hideAccountBall === true; syncHideBallLabel\(\); \}$',
        r'\g<i>if (optHideBall) { optHideBall.checked = info.hideAccountBall === true; syncHideBallLabel(); }\n'
        r'\g<i>if (optUiTrans) { optUiTrans.checked = info.uiTransparent === true; syncUiTransLabel(); }')
t = sub(t, r'^(?P<i>[ \t]*)hideAccountBall: !!\(optHideBall && optHideBall\.checked\),$',
        r'\g<i>hideAccountBall: !!(optHideBall && optHideBall.checked),\n'
        r'\g<i>uiTransparent: !!(optUiTrans && optUiTrans.checked),')
save(p, t, bom); ok.append(p)

# ---------------- settings.html ----------------
p = 'settings.html'
t, bom = load(p)
anchor = t.find('id="opt-hide-account-ball-label"')
if anchor < 0:
    raise SystemExit('settings.html anchor not found')
end = t.find('</div>', anchor)
if end < 0:
    raise SystemExit('settings.html close div not found')
end += len('</div>')
block = (
    '\n\n'
    '        <!-- v3.0.62：透明界面（设置/帮助/检查更新 半透明，可看到背后窗口） -->\n'
    '        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid rgba(255,255,255,0.06)">\n'
    '          <div>\n'
    '            <div class="hotkey-title">透明界面</div>\n'
    '            <div class="hotkey-sub">开启后「设置 / 帮助 / 检查更新（关于）」页面变为半透明玻璃，可看到背后窗口内容；默认关闭，保持现有不透明外观。</div>\n'
    '          </div>\n'
    '          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">\n'
    '            <input type="checkbox" id="opt-ui-transparent" style="width:18px;height:18px;cursor:pointer" />\n'
    '            <span id="opt-ui-transparent-label" style="font-size:13px;color:var(--text-secondary,#aab0c0)">已关闭</span>\n'
    '          </label>\n'
    '        </div>'
)
t = t[:end] + block + t[end:]
save(p, t, bom); ok.append(p)

# ---------------- settings.css ----------------
p = 'settings.css'
t, bom = load(p)
t += (
    '\n\n/* v3.0.62：可选「透明界面」——开启后设置页蒙层变淡，背后窗口内容可见 */\n'
    'html.fnos-ui-transparent .scrim {\n'
    '  background: radial-gradient(ellipse at 50% 40%, rgba(8,10,22,.10), rgba(5,6,10,.26) 70%) !important;\n'
    '}\n'
    'html.fnos-ui-transparent .settings-head { border-bottom-color: rgba(255,255,255,.10); }\n'
    'html.fnos-ui-transparent .settings-section { border-bottom-color: rgba(255,255,255,.08); }\n'
)
save(p, t, bom); ok.append(p)

# ---------------- help.html / about.html ----------------
for p, css in [
    ('help.html', '\n/* v3.0.62：可选「透明界面」——去掉页面自带黑底与壁纸层，只留淡蒙层保证可读 */\n'
                  'html.fnos-ui-transparent body { background: rgba(6,8,14,.38) !important; }\n'
                  'html.fnos-ui-transparent .bg-wrap { display: none !important; }\n'),
    ('about.html', '\n/* v3.0.62：可选「透明界面」——去掉页面自带黑底与渐变层，只留淡蒙层保证可读 */\n'
                   'html.fnos-ui-transparent body { background: rgba(5,6,10,.38) !important; }\n'
                   'html.fnos-ui-transparent .bg { display: none !important; }\n'),
]:
    t, bom = load(p)
    i = t.lower().rfind('</head>')
    if i < 0:
        raise SystemExit(p + ' no </head>')
    t = t[:i] + '<style>' + css + '</style>\n' + t[i:]
    save(p, t, bom); ok.append(p)

print('PATCHED', ', '.join(ok))
