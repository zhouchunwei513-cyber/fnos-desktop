import io
s=io.open("main.js",encoding="utf-8",errors="replace").read()
i=s.find("function createSettingsWindow")
out=s[i:i+2800]
io.open("_rd_out.txt","w",encoding="utf-8").write(out)
print("WROTE",len(out))
