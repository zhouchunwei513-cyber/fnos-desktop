// macOS 外壳增强层：皮肤 / 透明度 / 圆角 / 工具栏动作
// 只读取主进程下发的 theme 对象，不修改 shell.js 的任何既有逻辑。
(function () {
  'use strict';
  var shell = window.fnosShell;
  if (!shell) return;

  var root = document.documentElement;
  var titlebar = document.getElementById('titlebar');
  var skinLayer = document.getElementById('skin-layer');
  var skinVideo = document.getElementById('skin-video');
  var skinHorn = document.getElementById('skin-horn');
  var veil = document.getElementById('tb-veil');
  var content = document.getElementById('content');
  var busyDot = document.getElementById('busy-dot');
  var menubar = document.getElementById('menubar');

  function hexToRgba(hex, a) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function num(v, def) {
    var n = Number(v);
    return isFinite(n) ? n : def;
  }

  function applyTheme(t) {
    if (!t) return;
    try {
      // ── 工具栏底色：磨砂 / 纯色 ──
      var material = t.titleBarMaterial === 'frosted' ? 'frosted' : 'solid';
      var opacity = Math.max(0, Math.min(100, num(t.titleBarOpacity, 96))) / 100;
      var bg = null;
      if (material === 'frosted') {
        var fa = Math.max(2, Math.min(35, num(t.titleBarFrostAlpha, 10))) / 100;
        var fr = hexToRgba(t.titleBarFrostColor || '#ffffff', fa);
        var base = hexToRgba(t.themeColor || '#1e1b2e', opacity);
        if (fr && base) {
          // 叠层：主题色底 + 霜白薄雾
          titlebar.style.backgroundImage = 'linear-gradient(' + fr + ',' + fr + ')';
          titlebar.style.backgroundColor = base;
        } else if (base) {
          titlebar.style.backgroundImage = 'none';
          titlebar.style.backgroundColor = base;
        }
        titlebar.style.backdropFilter = 'blur(20px) saturate(1.6)';
        titlebar.style.webkitBackdropFilter = 'blur(20px) saturate(1.6)';
      } else {
        var sa = Math.max(90, Math.min(100, num(t.titleBarSolidAlpha, 100))) / 100;
        var solid = hexToRgba(t.titleBarSolidColor || t.titleBarColor || t.themeColor || '#101426', sa);
        if (solid) {
          titlebar.style.backgroundImage = 'none';
          titlebar.style.backgroundColor = solid;
        }
        titlebar.style.backdropFilter = '';
        titlebar.style.webkitBackdropFilter = '';
      }

      // ── 高光（顶部 1px 亮线，Windows 版 titleBarHighlight 语义） ──
      var hi = Math.max(0, Math.min(100, num(t.titleBarHighlight, 55))) / 100;
      veil.style.background = hi > 0
        ? 'linear-gradient(180deg, rgba(255,255,255,' + (hi * 0.10).toFixed(3) + ') 0%, rgba(255,255,255,0) 55%)'
        : 'transparent';

      // ── 分隔线 ──
      root.style.setProperty('--tb-divider', t.titleBarDivider === false
        ? 'transparent' : 'rgba(255,255,255,0.08)');

      // ── 透明度（uiTransparent）──
      var alpha = num(t.uiAlpha, 1);
      root.style.setProperty('--tb-alpha', String(alpha));

      // ── 圆角（barCorner: round / half / square） ──
      var barR = t.barCorner === 'square' ? 0 : (t.barCorner === 'half' ? 6 : 10);
      root.style.setProperty('--tb-radius', barR + 'px');

      // ── 皮肤 ──
      applySkin(t.skin);

      // ── 窗口聚焦态 ──
      document.body.setAttribute('data-focused', t.focused === false ? 'false' : 'true');
    } catch (_) {}
  }

  var curSkinKey = '';
  function applySkin(skin) {
    try {
      if (!skin || !skin.bg) {
        if (curSkinKey) {
          curSkinKey = '';
          skinLayer.classList.remove('on');
          skinLayer.style.backgroundImage = 'none';
          skinVideo.style.display = 'none';
          try { skinVideo.pause(); skinVideo.removeAttribute('src'); skinVideo.load(); } catch (_) {}
          skinHorn.style.display = 'none';
        }
        return;
      }
      var key = String(skin.bg) + '|' + String(skin.horn || '') + '|' + String(skin.height || '');
      if (key === curSkinKey) return;
      curSkinKey = key;

      var isVideo = /\.(mp4|webm)(\?|$)/i.test(skin.bg);
      if (isVideo) {
        skinLayer.style.backgroundImage = 'none';
        skinVideo.style.display = 'block';
        if (skinVideo.getAttribute('src') !== skin.bg) {
          skinVideo.setAttribute('src', skin.bg);
          try { skinVideo.play(); } catch (_) {}
        }
      } else {
        try { skinVideo.pause(); skinVideo.style.display = 'none'; } catch (_) {}
        skinLayer.style.backgroundImage = 'url("' + String(skin.bg).replace(/"/g, '\\"') + '")';
      }
      skinLayer.classList.add('on');

      if (skin.horn) {
        skinHorn.setAttribute('src', skin.horn);
        skinHorn.style.display = 'block';
      } else {
        skinHorn.style.display = 'none';
      }

      var h = Number(skin.height);
      if (isFinite(h) && h >= 20 && h <= 80) {
        root.style.setProperty('--tb-height', h + 'px');
      } else {
        root.style.setProperty('--tb-height', '38px');
      }
    } catch (_) {}
  }

  // 主进程广播 theme（复用 shell-preload 的 onTheme 通道，多监听器互不影响）
  try { shell.onTheme(applyTheme); } catch (_) {}

  // ── 工具栏动作 ──
  function currentView() {
    return content ? content.querySelector('webview') : null;
  }

  var btnHome = document.getElementById('btn-home');
  var btnReload = document.getElementById('btn-reload');
  var btnSettings = document.getElementById('btn-settings');

  if (btnHome) btnHome.addEventListener('click', function () {
    var wv = currentView();
    if (!wv) return;
    try {
      var u = new URL(wv.getURL());
      wv.loadURL(u.origin + '/');
    } catch (_) { try { wv.reload(); } catch (e) {} }
  });

  if (btnReload) btnReload.addEventListener('click', function () {
    var wv = currentView();
    if (wv) { try { wv.reloadIgnoringCache(); } catch (_) { try { wv.reload(); } catch (e) {} } }
  });

  if (btnSettings) btnSettings.addEventListener('click', function (e) {
    e.stopPropagation();
    var r = btnSettings.getBoundingClientRect();
    try { shell.popupMenu({ id: 'settings', x: Math.round(r.left), y: Math.round(r.bottom) }); } catch (_) {}
  });

  // 菜单项按下时给视觉反馈（点击弹菜单仍由 shell.js 负责）
  if (menubar) {
    menubar.addEventListener('mousedown', function (e) {
      var it = e.target.closest ? e.target.closest('.menu-item') : null;
      if (!it) return;
      menubar.querySelectorAll('.menu-item').forEach(function (x) { x.classList.remove('open'); });
      it.classList.add('open');
      setTimeout(function () { it.classList.remove('open'); }, 900);
    });
  }

  // ── 加载指示：监听动态插入的 webview ──
  function bindWebview(wv) {
    if (!wv || wv.__macBound) return;
    wv.__macBound = true;
    var show = function () { if (busyDot) busyDot.classList.add('on'); };
    var hide = function () { if (busyDot) busyDot.classList.remove('on'); };
    wv.addEventListener('did-start-loading', show);
    wv.addEventListener('did-stop-loading', hide);
    wv.addEventListener('did-fail-load', function (e) { if (e && e.errorCode !== -3) hide(); });
    wv.addEventListener('did-navigate', hide);
  }

  function scan() {
    var wvs = content ? content.querySelectorAll('webview') : [];
    for (var i = 0; i < wvs.length; i++) bindWebview(wvs[i]);
  }

  if (content) {
    try {
      new MutationObserver(scan).observe(content, { childList: true, subtree: true });
    } catch (_) {}
    scan();
    setInterval(scan, 3000);
  }
})();
