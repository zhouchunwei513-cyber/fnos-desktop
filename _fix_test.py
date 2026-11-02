# -*- coding: utf-8 -*-
import io

p = '_menutest/main.js'
s = io.open(p, encoding='utf-8', newline='').read()

old = """    await win.webContents.executeJavaScript(
      "(function(){var it=document.querySelector('.panel[data-level=\\"0\\"] .item'); it.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); return true;})();"
    ).catch(() => {});"""
new = """    const diag1 = await win.webContents.executeJavaScript(
      "(function(){var it=document.querySelector('.panel[data-level=\\"0\\"] .item'); it.dispatchEvent(new MouseEvent('mouseenter'));"
      + "var p=document.querySelector('.panel[data-level=\\"1\\"]');"
      + "return {hasChild: !!it.__child, disp: p?p.style.display:null, vis: p?p.style.visibility:null, left: p?p.style.left:null, top: p?p.style.top:null, ow: p?p.offsetWidth:null};})();"
    ).catch((e) => ({ err: String(e) }));
    console.log('DIAG1', JSON.stringify(diag1));"""
assert s.count(old) == 1, s.count(old)
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('OK')
