import io,os,re
pats=["05060a","05060A","rgb(5, 6, 10)","rgb(5,6,10)","rgba(5,6,10","#05060a"]
for f in ["main.js","titlebar-inject.js","settings-preload.js","preload.js","settings.html","settings.css","lock.css"]:
    s=io.open(f,encoding="utf-8",errors="replace").read()
    lines=s.split("\n")
    hits=[]
    for i,l in enumerate(lines,1):
        low=l.lower()
        if "05060a" in low or "5, 6, 10" in l or "5,6,10" in l or "5, 5, 6" in l:
            hits.append(f"  {f}:{i}: {l.strip()[:150]}")
    if hits: print("\n".join(hits))
