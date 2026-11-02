import io
def rd(p):
    return io.open(p,encoding="utf-8",newline="").read()
def wr(p,s):
    io.open(p,"w",encoding="utf-8",newline="").write(s)
fails=[]

# 1) main.js: default true (undefined -> true)
s=rd("main.js")
c=s.count("uiTransparent: s.uiTransparent === true,")
print("main payload spots",c)
if c!=3: fails.append("main payload %d"%c)
s=s.replace("uiTransparent: s.uiTransparent === true,","uiTransparent: s.uiTransparent !== false,")
old=": (__fileCfg && __fileCfg.uiTransparent === true);"
print("fileCfg",s.count(old))
if s.count(old)!=1: fails.append("fileCfg")
s=s.replace(old,": (__fileCfg && __fileCfg.uiTransparent !== false);")
wr("main.js",s)

# 2) titlebar-inject.js
s=rd("titlebar-inject.js")
old="document.documentElement.classList.toggle('fnos-ui-transparent', r.uiTransparent === true);"
print("inj init",s.count(old))
if s.count(old)!=1: fails.append("inj init")
s=s.replace(old,"document.documentElement.classList.toggle('fnos-ui-transparent', r.uiTransparent !== false);")
old2="clip-path:inset(0 round 20px) !important;background:#05060a !important;}"
print("inj css anchor",s.count(old2))
if s.count(old2)!=1: fails.append("inj css anchor")
s=s.replace(old2,"clip-path:inset(0 round 20px) !important;background:#05060a !important;}html.fnos-ui-transparent>body{background:rgba(5,6,10,.38) !important;}")
wr("titlebar-inject.js",s)

# 3) settings.js
s=rd("settings.js")
old3="optUiTrans.checked = info.uiTransparent === true;"
print("settings.js",s.count(old3))
if s.count(old3)!=1: fails.append("settings.js")
s=s.replace(old3,"optUiTrans.checked = info.uiTransparent !== false;")
wr("settings.js",s)

print("FAILS",fails)
