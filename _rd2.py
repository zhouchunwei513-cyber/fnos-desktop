import io,re
out=[]
s=io.open("titlebar-inject.js",encoding="utf-8",errors="replace").read()
for m in re.finditer(r'.*(style\.background|backgroundColor|backdropFilter|fnos-bar-|setAttribute\(\x27style).*', s):
    ln=s[:m.start()].count("\n")+1
    out.append(f"{ln}: {m.group(0).strip()[:200]}")
print("\n".join(out[:60]))
print("---settings.html body tag---")
h=io.open("settings.html",encoding="utf-8",errors="replace").read()
i=h.find("<body")
print(h[i:i+400])
print("--- links ---")
for m in re.finditer(r'<link[^>]*>', h):
    print(m.group(0))
io.open("_rd_out.txt","w",encoding="utf-8").write("\n".join(out[:60])+"\n\n"+h[i:i+400]+"\n")
