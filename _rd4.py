import io,re
s=io.open("settings.css",encoding="utf-8",errors="replace").read().replace("\ufeff","")
lines=s.split("\n")
res=[]
for i,l in enumerate(lines,1):
    if re.search(r'radial-gradient|::before|::after|--bg|background:\s*(#|rgb)', l):
        res.append(f"{i}: {l.strip()[:180]}")
io.open("_out.txt","w",encoding="utf-8").write("\n".join(res))
print(len(res))
