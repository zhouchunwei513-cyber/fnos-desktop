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

  /* ---------- 尺寸测量 ----------
   * v4.0.1（用户工单「点 ☰ 菜单压成 150×260、文字溢出、两套文字叠在一起」）——
   * 旧实现读 panel.offsetWidth：.panel 是 position:absolute 且没有显式宽度，shrink-to-fit
   * 会被包含块（#root = 窗口宽）夹住；窗口又是 320×420 的预建隐藏窗，于是量出来≈0，
   * 被 Math.max(150,…) 兜到下限，setBounds 成 150×260，窗口变小又反过来夹住下一次测量 —— 自锁。
   * 现在 CSS 给 .panel 显式 width:max-content（宽度只由内容决定，与窗口多大无关），
   * 这里直接读布局矩形；并在布局/字体稳定后再补量一次。
   */

  function panelRect(panel) {
    if (!panel) return { w: 0, h: 0 };
    var r = panel.getBoundingClientRect();
    return {
      w: Math.round(r.width) || Math.round(panel.scrollWidth) || 0,
      h: Math.round(r.height) || Math.round(panel.scrollHeight) || 0,
    };
  }

  function needWidth(panel) {
    var w = panelRect(panel).w;
    var childMax = 0;
    var rows = panel.children;
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].__child;
      if (c) childMax = Math.max(childMax, needWidth(c));
    }
    return childMax > 0 ? w + GAP + childMax : w;
  }

  function maxHeight() {
    var h = 0;
    for (var i = 0; i < allPanels.length; i++) h = Math.max(h, panelRect(allPanels[i]).h);
    return h;
  }

  /* v4.0.1：子菜单面板在测量时是 display:none，量出来恒为 0 —— 于是窗口宽度只按主面板算，
   * 展开子菜单时右侧没位置，positionChild 只能翻到左边压在主面板上（「两套文字叠在一起」）。
   * 这里在测量期间临时把所有面板设为可布局（visibility:hidden 不会真的显示），量完恢复。 */
  function withAllPanelsMeasurable(fn) {
    var saved = [];
    for (var i = 0; i < allPanels.length; i++) {
      var p = allPanels[i];
      saved.push({ p: p, d: p.style.display, v: p.style.visibility });
      p.style.display = 'block';
      p.style.visibility = 'hidden';
    }
    try {
      return fn();
    } finally {
      for (var j = 0; j < saved.length; j++) {
        saved[j].p.style.display = saved[j].d;
        saved[j].p.style.visibility = saved[j].v;
      }
    }
  }

  /* ---------- 入口 ---------- */

  /* v3.0.82：窗口常驻复用后，连续开关同一个菜单会重复推同一份数据。
   * 结构没变就不重建 DOM（几百个节点全销毁重插是肉眼可见的一下顿），只重新量尺寸回报；
   * 有变化（勾选态/后台窗口列表/透明界面滑块）才整棵重建。 */
  var __lastKey = '';

  var __lastReported = { w: 0, h: 0 };
  var __measureSeq = 0;

  function measureAndReport(opts) {
    if (!basePanel) return;
    var force = !!(opts && opts.force);
    var final = !!(opts && opts.final);
    var m = withAllPanelsMeasurable(function () {
      return { w: needWidth(basePanel), h: maxHeight() };
    });
    var w = Math.round(m.w + PAD * 2);
    var h = Math.round(m.h + PAD * 2);
    /* v4.0.1：内容宽度明显小于「最小面板」时，说明这一帧还没完成布局（预热窗口刚 show、
     * 首帧还没排），此时上报只会让主进程把菜单压扁。直接不报，交给稳定帧后的补量。
     * （最小面板 min-width 92 + padding 12 + 两侧 PAD 36 ≈ 140，取 150 作阈值。） */
    if (!final && (m.w < 150 || m.h < 80)) return;
    /* v4.0.1：下限从 150 抬到 200 —— 150 正是旧版「量到接近 0 被 clamp」的特征值，
     * 主进程会把 ≤200 的上报判为可疑并回推重测。 */
    w = Math.max(200, Math.min(780, w));
    h = Math.max(120, Math.min(880, h));
    if (!force && w === __lastReported.w && h === __lastReported.h) return;
    __lastReported = { w: w, h: h };
    try { window.fnMenu.ready({ w: w, h: h }); } catch (_) {}
  }

  /* v4.0.1：同步量一次先让窗口尽快有正确尺寸，再等「双 rAF + 字体就绪」补量一次。
   * 首帧字体回退（PingFang → 雅黑）会让文字宽度差几个像素，补量只在尺寸变化时上报。 */
  function measureAndReportStable() {
    measureAndReport({ force: true, final: false });
    var seq = ++__measureSeq;
    function again() {
      if (seq !== __measureSeq || !basePanel) return;
      measureAndReport({ force: false, final: true });
    }
    try {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          try {
            if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
              document.fonts.ready.then(again, again);
            } else again();
          } catch (_) { again(); }
        });
      });
    } catch (_) { again(); }
  }

  function resetOpenChain() {
    openChain = [];
    for (var i = 0; i < allPanels.length; i++) {
      if ((allPanels[i].dataset.level - 0) > 0) {
        allPanels[i].style.display = 'none';
        allPanels[i].style.visibility = 'hidden';
      }
    }
    if (basePanel) basePanel.style.visibility = 'visible';
  }

  /* v4.0.1：自证日志——出问题时一眼能看出是「量小了」还是「窗口没起来」 */
  function diagMeasure(stage) {
    try {
      if (!window.fnMenu || typeof window.fnMenu.diag !== 'function' || !basePanel) return;
      window.fnMenu.diag('menu.custom.measure', {
        stage: stage,
        items: basePanel.querySelectorAll('.item').length,
        panelW: basePanel.offsetWidth,
        panelScrollW: basePanel.scrollWidth,
        panelRectW: panelRect(basePanel).w,
        rootW: root.clientWidth,
        winW: window.innerWidth,
        dpr: window.devicePixelRatio || 1,
        vis: document.visibilityState,
      });
    } catch (_) {}
  }

  function build(data) {
    var key = '';
    try {
      key = JSON.stringify({
        i: (data && data.items) || [],
        t: (data && data.theme) || '',
        a: (data && data.alpha != null) ? Number(data.alpha) : 0.92,
      });
    } catch (_) { key = ''; }

    if (key && key === __lastKey && basePanel) {
      resetOpenChain();
      measureAndReportStable();
      return;
    }
    __lastKey = key;

    allPanels = [];
    openChain = [];
    root.innerHTML = '';
    document.body.className = (data && data.theme === 'glass') ? 'glass' : 'dark';
    /* v3.0.81：菜单背景 alpha 跟随「透明界面」滑块（main 随 fnmenu:data 一起下发）。
     * v4.0.1：菜单是瞬时浮层，背景必须压住桌面图标——下限锁到 0.9，
     * 不再跟着滑块一路降到 0.38（用户工单症状 2：桌面图标透过菜单）。 */
    try {
      var __a = (data && data.alpha != null) ? Number(data.alpha) : 0.92;
      if (!isFinite(__a) || __a < 0) __a = 0.92;
      if (__a > 1) __a = 1;
      if (__a < 0.9) __a = 0.9;
      document.documentElement.style.setProperty('--fnos-ui-a', String(__a));
    } catch (_) {}

    basePanel = makePanel((data && data.items) || [], 0);
    /* 全部面板此刻均为 display:block + visibility:hidden，可量尺寸 */
    for (var i = 0; i < allPanels.length; i++) {
      if (allPanels[i].dataset.level - 0 > 0) allPanels[i].style.display = 'none';
    }
    basePanel.style.visibility = 'visible';
    diagMeasure('build');
    measureAndReportStable();
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
  /* v4.0.1：主进程判定上报尺寸可疑（窗口被压扁）时回推这里重测一次 */
  try {
    if (typeof window.fnMenu.onRemeasure === 'function') {
      window.fnMenu.onRemeasure(function () {
        diagMeasure('remeasure');
        measureAndReportStable();
      });
    }
  } catch (_) {}
})();
