import io
def rd(p): return io.open(p,encoding="utf-8",newline="").read()
def wr(p,s): io.open(p,"w",encoding="utf-8",newline="").write(s)
fails=[]

h=rd("settings.html")
old='<!-- v3.0.62：透明界面（设置 / 帮助 / 检查更新 半透明，可看到背后窗口） -->'
print("h1",h.count(old))
if h.count(old)!=1: fails.append("h1")
h=h.replace(old,'<!-- v3.0.62/63：透明界面（设置 / 帮助 / 检查更新 半透明，可看到背后窗口） -->')

old2='<div class="hotkey-sub">开启后「帮助」与「检查更新（关于）」页面也采用与设置页一致的透明玻璃（可看到背后窗口内容）；设置页本身即为透明玻璃。默认关闭，保持现有外观。</div>'
print("h2",h.count(old2))
if h.count(old2)!=1: fails.append("h2")
h=h.replace(old2,'<div class="hotkey-sub">开启后设置页、帮助页、检查更新（关于）页均为半透明玻璃，可看到背后的窗口与桌面壁纸；关闭则恢复现有的深色不透明界面。默认开启。</div>')
wr("settings.html",h)

c=rd("settings.css")
old3='''/* v3.0.62：「透明界面」——设置页本身即为透明玻璃（html/body 无底色 + 窗口 transparent），
   本页无需额外规则；该开关负责把「帮助页 / 检查更新（关于）页」也切换为同样的透明玻璃。 */'''
print("c1",c.count(old3))
if c.count(old3)!=1: fails.append("c1")
c=c.replace(old3,'''/* v3.0.63：「透明界面」的实际着色由 titlebar-inject 注入（html.fnos-ui-transparent>body），
   因为设置窗 body 的 #05060a 底色也在那里以 !important 注入，必须同处覆盖。
   本文件不需要额外规则。 */''')
wr("settings.css",c)
print("FAILS",fails)
