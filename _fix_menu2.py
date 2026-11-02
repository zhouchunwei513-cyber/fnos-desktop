# -*- coding: utf-8 -*-
import io

p = 'menu-popup.js'
s = io.open(p, encoding='utf-8', newline='').read()
fails = []

old1 = """        row.__child = makePanel(node.items || [], level + 1);
        addHoverHandlers(row, level);
"""
new1 = """        row.__child = makePanel(node.items || [], level + 1);
        addHoverHandlers(row, level);
        bindSubClick(row, level);
"""
if s.count(old1) != 1:
    fails.append('bind1')
s = s.replace(old1, new1)

old2 = """  function bindClick(row, node) {
    row.addEventListener('click', function () {
      if (node.enabled === false) return;
      if (row.__child) { openChild(row, node.__level || 0); return; }
      try { window.fnMenu.invoke(node.id); } catch (_) {}
    });
  }
"""
new2 = """  function bindSubClick(row, level) {
    row.addEventListener('click', function () { openChild(row, level); });
  }

  function bindClick(row, node) {
    row.addEventListener('click', function () {
      if (node.enabled === false) return;
      try { window.fnMenu.invoke(node.id); } catch (_) {}
    });
  }
"""
if s.count(old2) != 1:
    fails.append('bind2')
s = s.replace(old2, new2)

old3 = """    try { window.fnMenu.ready({ w: w, h: h }); } catch (_) {}
    try { window.fnMenu.shown(); } catch (_) {}
"""
new3 = """    try { window.fnMenu.ready({ w: w, h: h }); } catch (_) {}
"""
if s.count(old3) != 1:
    fails.append('bind3')
s = s.replace(old3, new3)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('FAILS', fails)
