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

  // v1.71.0：飞牛主页按窗口大小自动缩放页面及图标。
  // 大窗口下飞牛主页图标网格偏大/错位，这里以 1440x810 为基准整体 zoom 缩放
  // （窗口越大缩放越小，图标相对窗口变小），小窗口保持 1.0；窗口尺寸变化与
  // SPA 路由切换时自动重新计算。
  function injectHomeScale(wv) {
    try {
      wv.executeJavaScript(`(function () {
        'use strict';
        function isHomePage() {
          var p = location.pathname || '/';
          return p === '/' || p === '/apps' || p === '/desktop' || p === '/home' || p === '/app';
        }
        function applyScale() {
          try {
            if (!isHomePage()) return;
            var s = Math.min(1440 / window.innerWidth, 810 / window.innerHeight);
            s = Math.max(0.55, Math.min(1.0, s));
            var el = document.documentElement;
            var cur = parseFloat(el.style.zoom) || 1;
            if (Math.abs(cur - s) > 0.01) el.style.zoom = s;
          } catch (_) {}
        }
        window.addEventListener('resize', applyScale);
        var _lastPath = location.pathname;
        setInterval(function () {
          try { if (location.pathname !== _lastPath) { _lastPath = location.pathname; applyScale(); } } catch (_) {}
        }, 800);
        applyScale();
      })();`, true).catch(() => {});
    } catch (_) {}
  }

  // v1.73.0：扫描主页中的应用入口（SPA 渲染完成后的应用卡片）
  //   1) a[href] 指向同主机不同端口的独立应用（原有）
  //   2) 常见应用卡片容器（app-card/app-item/app-entry/desktop-app 等，应用可能
  //      不是 <a> 而是 div+图标+onclick 结构）——应用增减时都能扫到
  //   3) 图标支持 data: URL（内联 SVG/PNG），名称做空白清理
  // v1.74.0：重写应用扫描——飞牛主页应用打开走前端路由(appview?anchor)或独立端口，
  // 卡片多为 div+图标+onclick 结构（非 <a>），且应用可增可减。多策略：
  //   1) 所有 a[href]：不再限不同端口，同主机同端口路径/相对路径也收
  //   2) 从图标 img 向上找名称容器：紧凑卡片（图标+短名称）即应用，高效且
  //      不依赖具体 class 名；从图标路径提取 appName（/icons/{appName}/ 模式）
  //      构造 appview anchor 打开地址
  //   3) 名称清洗、图标转绝对、按最终 URL 去重——应用增减自动同步
  // v1.75.0：持续循环扫描应用。修复：飞牛主页未登录时是登录页（无应用卡片），
  // 登录后 SPA 才渲染应用卡片，旧版固定次数(1.5/4/8s)扫描会错过登录后的渲染，
  // 导致 apps 永远为空、快捷方式/任务栏图标无法创建。现在每 10s 循环扫描一次，
  // 仅当结果变化（应用增/减）时才上报，自动同步。
  let __lastAppsSig = '';
  let __appScanTimer = null;
  function collectApps(wv) {
    try {
      wv.executeJavaScript(`(function(){
        try {
          // v1.75.0：登录页没有应用卡片，直接跳过（SPA 登录态未就绪时也是空）
          var pp = (location.pathname || '').toLowerCase();
          if (pp.indexOf('/login') === 0 || pp === 'login') return '__SKIP__';
          var origin = location.origin;
          var res = [];
          var seen = {};
          var clean = function(s){ return String(s||'').replace(/\s+/g,' ').trim(); };
          var toAbs = function(u){
            if (!u) return '';
            try { return new URL(u, origin).href; } catch(e){ return ''; }
          };
          // 飞牛应用图标常见路径：/static/app/icons/{appName}/icon.png、/icons/{appName}.png
          var appNameFromUrl = function(u){
            if (!u) return '';
            var m = /\/icons\/([^\/?#]+?)(?:\/|\.[a-z0-9]+$|$)/i.exec(u);
            if (m) { try { return decodeURIComponent(m[1]); } catch(e){ return m[1]; } }
            return '';
          };
          var pushApp = function(name, url, icon, appName){
            if (!name) return;
            if (name.length > 40) name = name.slice(0, 40);
            var abs = toAbs(url);
            var finalUrl = /^https?:/i.test(abs) ? abs : '';
            if (!finalUrl && appName) {
              // 前端路由打开：/appview?anchor=https://{appName}
              finalUrl = origin + '/appview?anchor=' + encodeURIComponent('https://' + appName);
            }
            if (!finalUrl) return;
            if (seen[finalUrl]) return;
            seen[finalUrl] = 1;
            res.push({ name: name, url: finalUrl, icon: icon || '', appName: appName || '' });
          };
          // 1) 所有链接（同主机不同端口/同端口路径/相对路径都收，不再过滤端口）
          var links = document.querySelectorAll('a[href]');
          for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var img = a.querySelector('img');
            var icon = img ? (img.currentSrc || img.src || '') : '';
            var nm = clean(a.innerText || a.title || (img && img.alt) || '');
            if (!nm && img) nm = clean(img.alt || '');
            pushApp(nm, a.href, icon, appNameFromUrl(icon));
          }
          // 2) 图标 img 向上找名称容器（应用卡片 = 图标 + 短名称，最多上溯 4 层）
          var imgs = document.querySelectorAll('img');
          var done = {};
          for (var q = 0; q < imgs.length; q++) {
            var im = imgs[q];
            var icon2 = im.currentSrc || im.src || '';
            var nm2 = clean(im.alt || '');
            var href2 = '';
            var cur = im;
            for (var d = 0; d < 4 && cur; d++) {
              var pe = cur.parentElement;
              if (!pe) break;
              if (!href2 && pe.tagName === 'A') href2 = pe.href || '';
              var t = clean(pe.innerText || '');
              if (t && t.length <= 40 && !/\s/.test(t)) nm2 = t;
              cur = pe;
            }
            if (!nm2 || nm2.length > 40) continue;
            var k2 = href2 || icon2;
            if (done[k2]) continue;
            done[k2] = 1;
            pushApp(nm2, href2, icon2, appNameFromUrl(icon2));
          }
          return JSON.stringify(res);
        } catch (e) { return '[]'; }
      })()`, true).then((json) => {
        try {
          if (json === '__SKIP__') return;
          const apps = JSON.parse(json || '[]');
          const sig = JSON.stringify(apps);
          if (sig === __lastAppsSig) return;
          __lastAppsSig = sig;
          if (window.fnosShell && window.fnosShell.reportApps) {
            window.fnosShell.reportApps(apps);
          }
        } catch (_) {}
      }).catch(() => {});
    } catch (_) {}
  }

  // v1.75.0：启动持续扫描——立即扫一次 + 每 10s 循环（登录后/应用增减自动同步）
  function startAppScan(wv) {
    try {
      if (__appScanTimer) { clearInterval(__appScanTimer); __appScanTimer = null; }
      collectApps(wv);
      __appScanTimer = setInterval(() => { try { collectApps(wv); } catch (_) {} }, 10000);
    } catch (_) {}
  }

  function createWebView(partition, src) {
    if (view) { try { view.remove(); } catch (_) {} view = null; }
    const wv = document.createElement('webview');
    wv.setAttribute('partition', partition);
    wv.setAttribute('src', src);
    wv.setAttribute('preload', 'preload.js');
    wv.setAttribute('allowpopups', 'true');
    wv.setAttribute('webpreferences',
      'contextIsolation=true,nativeWindowOpen=true,allowRunningInsecureContent=true,nodeIntegration=false,backgroundThrottling=false');
    wv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;outline:none;';
    content.appendChild(wv);
    view = wv;

    wv.addEventListener('did-start-loading', () => showLoader('正在加载…'));
    wv.addEventListener('dom-ready', () => {
      try {
        // v1.69.0：侧边栏透明玻璃 + 滚动条美化。飞牛 NAS 网页（webview 内）的左侧
        // 导航侧边栏默认是纯深色实底，这里统一注入半透明毛玻璃：低透明底色透出下层
        // 内容 + backdrop blur 磨砂。选择器尽量覆盖常见 sidebar/aside 类名与属性片段，
        // 避免命中 nav（会误伤顶部导航）等过宽元素。
        wv.insertCSS(`
html,body{overscroll-behavior:none;}
::-webkit-scrollbar{width:10px;height:10px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:rgba(120,130,150,.45);border-radius:6px;}
::-webkit-scrollbar-thumb:hover{background:rgba(140,150,170,.65);}
aside, .sidebar, .side-bar, .side-nav, .left-nav, .left-sidebar, .layout-sidebar,
.el-aside, .aside-container, .menu-container, .drawer, .side-panel,
[class*="sidebar"], [class*="side-bar"], [class*="side-nav"], [class*="left-nav"],
[class*="left-sidebar"], [class*="aside"] {
  background: rgba(18, 22, 32, 0.42) !important;
  backdrop-filter: blur(18px) saturate(1.35) !important;
  -webkit-backdrop-filter: blur(18px) saturate(1.35) !important;
  border-right: 1px solid rgba(255,255,255,0.06) !important;
  box-shadow: none !important;
}`);
      } catch (_) {}
      injectHomeScale(wv);
      startAppScan(wv);
    });
    wv.addEventListener('did-navigate', () => {
      injectHomeScale(wv);
      startAppScan(wv);
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
