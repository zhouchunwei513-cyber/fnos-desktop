import io,re
s=io.open("main.js",encoding="utf-8",errors="replace").read()
for m in re.finditer(r"additionalArguments\s*:\s*\[[^\]]*\]", s):
    ln=s[:m.start()].count("\n")+1
    print(ln, m.group(0).replace("\n"," ")[:120])
print("--- uiTransparent spots ---")
for f in ["main.js","titlebar-inject.js","settings.js","settings-preload.js"]:
    t=io.open(f,encoding="utf-8",errors="replace").read().split("\n")
    for i,l in enumerate(t,1):
        if "uiTransparent" in l or "fnos-ui-transparent" in l:
            print(f"{f}:{i}: {l.strip()[:160]}")
