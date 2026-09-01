// 玻璃外壳渲染逻辑：自定义标题栏 + 菜单栏 + 动态 webview（支持切换 partition）
(function () {
  'use strict';
  const shell = window.fnosShell;
  const content = document.getElementById('content');
  const loader = document.getElementById('loader');
  const loaderText = document.getElementById('loader-text');
  const titleEl = document.getElementById('app-title');

  let view = null;

  document.getElementById('btn-min').addEventListener('click', () => shell.minimize());
  document.getElementById('btn-max').addEventListener('click', () => shell.toggleMaximize());
  document.getElementById('btn-close').addEventListener('click', () => shell.close());

  shell.onMaximized((isMax) => {
    document.body.setAttribute('data-maximized', isMax ? 'true' : 'false');
    const ic = document.getElementById('icon-max');
    if (isMax) {
      ic.innerHTML = '<rect x="3" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/><path d="M5 3V2.5H9.5V7H9" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>';
    } else {
      ic.innerHTML = '<rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/>';
    }
  });
  shell.onTitle((t) => { if (t) titleEl.textContent = t; });

  // 主题色：设置页可选的标题栏颜色（自绘标题栏透明/可选色）
  shell.onTheme((theme) => {
    try {
      if (theme && theme.themeColor) {
        const c = theme.themeColor;
        // 用用户选定颜色生成半透明毛玻璃背景（保留透明度，透出下层内容）
        const withAlpha = (hex, a) => {
          const m = /^#?([0-9a-f]{6})$/i.exec(hex);
          if (!m) return hex;
          const n = parseInt(m[1], 16);
          return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
        };
        document.documentElement.style.setProperty('--tb-bg', withAlpha(c, 0.72));
      }
    } catch (_) {}
  });

  document.querySelectorAll('.menu-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      shell.popupMenu({ id: el.dataset.menu, x: Math.round(rect.left), y: Math.round(rect.bottom) });
    });
  });

  function showLoader(text) {
    if (text) loaderText.textContent = text;
    loader.classList.remove('hidden');
  }
  function hideLoader() { loader.classList.add('hidden'); }

  function createWebView(partition, src) {
    if (view) { try { view.remove(); } catch (_) {} view = null; }
    const wv = document.createElement('webview');
    wv.setAttribute('partition', partition);
    wv.setAttribute('src', src);
    wv.setAttribute('preload', 'preload.js');
    wv.setAttribute('allowpopups', 'true');
    wv.setAttribute('webpreferences',
      'contextIsolation=true,nativeWindowOpen=true,allowRunningInsecureContent=true,nodeIntegration=false');
    wv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;outline:none;';
    content.appendChild(wv);
    view = wv;

    wv.addEventListener('did-start-loading', () => showLoader('正在加载…'));
    wv.addEventListener('dom-ready', () => {
      try {
        wv.insertCSS('html,body{overscroll-behavior:none;}::-webkit-scrollbar{width:10px;height:10px;}::-webkit-scrollbar-thumb{background:rgba(120,130,150,.45);border-radius:6px;}');
      } catch (_) {}
    });
    wv.addEventListener('did-stop-loading', () => hideLoader());
    wv.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3) hideLoader(); });
    wv.addEventListener('page-title-updated', (e) => { if (e.title) titleEl.textContent = e.title; });
    showLoader('正在连接…');
    return wv;
  }

  shell.onOpen((target) => {
    if (!target) return;
    if (target.replace) {
      createWebView(target.partition || 'persist:connect', target.url || 'about:blank');
    } else if (view && /^https?:/i.test(target.url || '')) {
      view.loadURL(target.url);
    }
  });

  shell.onNavigate((action) => {
    if (!view) return;
    try {
      if (action === 'reload') view.reload();
      else if (action === 'forceReload') view.reloadIgnoringCache();
      else if (action === 'back' && view.canGoBack()) view.goBack();
      else if (action === 'forward' && view.canGoForward()) view.goForward();
    } catch (_) {}
  });
})();
