import io,json
def rd(p): return io.open(p,encoding="utf-8",newline="").read()
def wr(p,s): io.open(p,"w",encoding="utf-8",newline="").write(s)
s=rd("main.js")
old="const APP_VERSION = '3.0.62';"
print("ver",s.count(old))
s=s.replace(old,"const APP_VERSION = '3.0.63';")
wr("main.js",s)
p=rd("package.json")
print('pkgver',p.count('"version": "3.0.62"'))
p=p.replace('"version": "3.0.62"','"version": "3.0.63"')
wr("package.json",p)
json.loads(p)
print("JSON_OK")
