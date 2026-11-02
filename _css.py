import io,re
for f in ["settings.css","lock.css"]:
    s=io.open(f,encoding="utf-8",errors="replace").read()
    s=s.replace("\ufeff","")
    print("=====",f,len(s))
    for m in re.finditer(r'([^{}]{0,200})\{([^{}]*)\}', s):
        sel=" ".join(m.group(1).split())
        sel=sel.split("*/")[-1].strip()
        b=m.group(2)
        if "background" in b and re.search(r'(body|html|settings-body|settings-card|overlay|scrim|bg)', sel, re.I):
            print("---",sel,"=>"," ".join(b.split())[:220])
