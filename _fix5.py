# -*- coding: utf-8 -*-
# 校正：设置页本身即透明（无 scrim 层），开关只负责帮助页/关于页
p = 'settings.css'
raw = open(p, 'rb').read()
bom = raw.startswith(b'\xef\xbb\xbf')
t = raw.decode('utf-8-sig')
OLD = (
    '/* v3.0.62：可选「透明界面」——开启后设置页蒙层变淡，背后窗口内容可见 */\n'
    'html.fnos-ui-transparent .scrim {\n'
    '  background: radial-gradient(ellipse at 50% 40%, rgba(8,10,22,.10), rgba(5,6,10,.26) 70%) !important;\n'
    '}\n'
    'html.fnos-ui-transparent .settings-head { border-bottom-color: rgba(255,255,255,.10); }\n'
    'html.fnos-ui-transparent .settings-section { border-bottom-color: rgba(255,255,255,.08); }\n'
)
OLD = OLD.replace('\n', '\r\n') if '\r\n' in t else OLD
NEW = (
    '/* v3.0.62：「透明界面」——设置页本身即为透明玻璃（html/body 无底色 + 窗口 transparent），\n'
    '   本页无需额外规则；该开关负责把「帮助页 / 检查更新（关于）页」也切换为同样的透明玻璃。 */\n'
)
NEW = NEW.replace('\n', '\r\n') if '\r\n' in t else NEW
if t.count(OLD) != 1:
    raise SystemExit('settings.css block count=%d' % t.count(OLD))
t = t.replace(OLD, NEW, 1)
open(p, 'wb').write((b'\xef\xbb\xbf' if bom else b'') + t.encode('utf-8'))
print('settings.css ok')

# 更新设置页文案
p = 'settings.html'
raw = open(p, 'rb').read()
bom = raw.startswith(b'\xef\xbb\xbf')
t = raw.decode('utf-8-sig')
O2 = '开启后「设置 / 帮助 / 检查更新（关于）」页面变为半透明玻璃，可看到背后窗口内容；默认关闭，保持现有不透明外观。'
N2 = '开启后「帮助」与「检查更新（关于）」页面也采用与设置页一致的透明玻璃（可看到背后窗口内容）；设置页本身即为透明玻璃。默认关闭，保持现有外观。'
if t.count(O2) != 1:
    raise SystemExit('settings.html text count=%d' % t.count(O2))
t = t.replace(O2, N2, 1)
open(p, 'wb').write((b'\xef\xbb\xbf' if bom else b'') + t.encode('utf-8'))
print('settings.html ok')
