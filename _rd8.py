import io
h=io.open("settings.html",encoding="utf-8",newline="",errors="replace").read()
i=h.find("opt-ui-transparent")
c=io.open("settings.css",encoding="utf-8",newline="",errors="replace").read()
j=c.find("v3.0.62")
io.open("_out.txt","w",encoding="utf-8").write("HTML:\n"+h[max(0,i-650):i+650]+"\n\nCSS:\n"+c[max(0,j-250):j+500])
print("ok")
