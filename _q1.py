import io,re
out=[]
for f in ["main.js","titlebar-inject.js","preload.js","settings-preload.js"]:
    s=io.open(f,encoding="utf-8",errors="replace").read().split("\n")
    for i,l in enumerate(s,1):
        if re.search(r'Menu\.buildFromTemplate|\.popup\(|setApplicationMenu|Menu\.setApplicationMenu|menu-popup|fnos-menu', l):
            out.append(f"{f}:{i}: {l.strip()[:150]}")
io.open("_out.txt","w",encoding="utf-8").write("\n".join(out))
print(len(out))
