import io
s=io.open("titlebar-inject.js",encoding="utf-8",errors="replace").read().split("\n")
for i,l in enumerate(s,1):
    if "fnos-ui-transparent>body" in l or "uiTransparent" in l:
        print(f"{i}: {l.strip()[:400]}")
