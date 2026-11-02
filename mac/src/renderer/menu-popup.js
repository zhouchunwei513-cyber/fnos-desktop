/* v3.0.64 应用菜单（自绘）渲染逻辑
 * 由 main.js 通过 preload 暴露的 window.fnMenu 通信：
 *   收 fnmenu:data({items, theme}) → 构建面板 → 量尺寸 → 回报 ready({w,h}) → 显示
 *   点击叶子项 → invoke(id)（main 按 id 调回原 MenuItem.click）
 */
(function () {
  'use strict';

  var PAD = 18;   /* 留给阴影的边距 */
  var GAP = 6;    /* 子菜单与父面板的间隙 */

  var root = document.getElementById('root');
  var panels = [];      /* 所有面板（含各级子菜单） */
  var basePanel = null;
  var openChain = [];   /* 当前展开链：{ item, panel } */

  /* ---------- 构建 ---------- */

  function makePanel(items, level) {
    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.dataset.level = String(level);
    panel.style.display = 'block';
    panel.style.visibility = 'hidden';
    panel.style.left = PAD + 'px';
    panel.style.top = PAD + 'px';
    allPanels.push(panel);
    root.appendChild(panel);

    for (var i = 0; i < items.length; i++) {
      var node = items[i];
      if (node.t === 'sep') {
        var sep = document.createElement('div');
        sep.className = 'sep';
        panel.appendChild(sep);
        continue;
      }
      var row = document.createElement('div');
      row.className = 'item' + (node.enabled === false ? ' disabled' : '');
      row.dataset.id = node.id || '';

      if (node.t === 'checkbox' || node.t === 'radio') {
        var mark = document.createElement('span');
        mark.className = 'mark';
        mark.textContent = node.checked ? '✓' : '';
        row.appendChild(mark);
      }

      var lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = node.label || ' ';
      if (node.label) lbl.title = node.label;
      row.appendChild(lbl);

      if (node.t === 'sub') {
        var arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '›';
        row.appendChild(arrow);
        row.__child = makePanel(node.items || [], level + 1);
        addHoverHandlers(row, level);
        bindSubClick(row, level);
      } else {
        var acc = document.createElement('span');
        acc.className = 'acc';
        acc.textContent = node.accel || '';
        row.appendChild(acc);
        addHoverHandlers(row, level);
        bindClick(row, node);
      }

      panel.appendChild(row);
    }
    return panel;
  }

  var allPanels = [];

  function addHoverHandlers(row, level) {
    row.addEventListener('mouseenter', function () {
      if (row.__child) openChild(row, level);
      else closeFrom(level);
    });
  }

  function bindSubClick(row, level) {
    row.addEventListener('click', function () { openChild(row, level); });
  }

  function bindClick(row, node) {
    row.addEventListener('click', function () {
      if (node.enabled === false) return;
      try { window.fnMenu.invoke(node.id); } catch (_) {}
    });
  }

  /* ---------- 展开 / 收起 ---------- */

  function closeFrom(level) {
    /* 关掉层级 > level 的所有面板 */
    for (var i = openChain.length - 1; i >= 0; i--) {
      if (openChain[i].panel.dataset.level - 0 > level) {
        openChain[i].panel.style.display = 'none';
        openChain.splice(i, 1);
      }
    }
  }

  function openChild(row, level) {
    var child = row.__child;
    if (!child) return;
    closeFrom(level);
    child.style.display = 'block';
    child.style.visibility = 'visible';
    if (openChain.length === 0 || openChain[openChain.length - 1].panel !== child) {
      openChain.push({ item: row, panel: child });
    }
    positionChild(row, child);
  }

  function positionChild(row, child) {
    var host = row.parentElement;                 /* 父面板 */
    var hostLeft = host.offsetLeft || PAD;
    var cw = child.offsetWidth || 200;
    var chh = child.offsetHeight || 100;
    var rootW = root.clientWidth || window.innerWidth;
    var rootH = root.clientHeight || window.innerHeight;

    var left = hostLeft + host.offsetWidth + GAP;
    if (left + cw > rootW - PAD) {
      left = hostLeft - cw - GAP;
      if (left < PAD) left = Math.max(PAD, rootW - PAD - cw);
    }
    child.style.left = Math.round(left) + 'px';

    var rowTop = host.offsetTop + row.offsetTop;
    var top = rowTop - 8;
    var maxTop = rootH - PAD - chh;
    if (top > maxTop) top = maxTop;
    if (top < PAD) top = PAD;
    child.style.top = Math.round(top) + 'px';
  }

  /* ---------- 尺寸测量 ---------- */

  function needWidth(panel) {
    var w = panel.offsetWidth || 0;
    var childMax = 0;
    var rows = panel.querySelectorAll(':scope > .item');
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].__child;
      if (c) childMax = Math.max(childMax, needWidth(c));
    }
    return childMax > 0 ? w + GAP + childMax : w;
  }

  function maxHeight() {
    var h = 0;
    for (var i = 0; i < allPanels.length; i++) h = Math.max(h, allPanels[i].offsetHeight || 0);
    return h;
  }

  /* ---------- 入口 ---------- */

  function build(data) {
    allPanels = [];
    openChain = [];
    root.innerHTML = '';
    document.body.className = (data && data.theme === 'glass') ? 'glass' : 'dark';
    /* v3.0.81：菜单背景 alpha 跟随「透明界面」滑块（main 随 fnmenu:data 一起下发）。
     * 之前只按百分比在 glass / dark 两套皮之间切换，具体数值没进来，
     * .panel 背景永远写死 .38，用户拖滑块看不出菜单有任何变化。 */
    try {
      var __a = (data && data.alpha != null) ? Number(data.alpha) : 0.38;
      if (!isFinite(__a) || __a < 0) __a = 0.38;
      if (__a > 1) __a = 1;
      document.documentElement.style.setProperty('--fnos-ui-a', String(__a));
    } catch (_) {}

    basePanel = makePanel((data && data.items) || [], 0);
    /* 全部面板此刻均为 display:block + visibility:hidden，可量尺寸 */
    var w = Math.round(needWidth(basePanel) + PAD * 2);
    var h = Math.round(maxHeight() + PAD * 2);
    w = Math.max(150, Math.min(780, w));
    h = Math.max(80, Math.min(880, h));

    /* 隐藏子菜单，只显示一级 */
    for (var i = 0; i < allPanels.length; i++) {
      if (allPanels[i].dataset.level - 0 > 0) allPanels[i].style.display = 'none';
    }
    basePanel.style.visibility = 'visible';

    try { window.fnMenu.ready({ w: w, h: h }); } catch (_) {}
  }

  /* 点击空白关闭 */
  document.addEventListener('mousedown', function (e) {
    if (!e.target || !e.target.closest || !e.target.closest('.panel')) {
      try { window.fnMenu.close(); } catch (_) {}
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { try { window.fnMenu.close(); } catch (_) {} }
  }, true);

  /* 右键/滚轮不下传 */
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });

  window.fnMenu.onData(build);
})();
