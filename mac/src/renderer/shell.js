'use strict';

/**
 * FNOS macOS 壳页逻辑
 * - 单 webview 承载 NAS 页面；工具栏由本页绘制（macOS 上红绿灯内嵌）
 * - 外观（vibrancy 材质 / 界面透明度 / 工具栏高度）由偏好设置写入，本页只负责套用变量
 * - 所有系统级动作通过 window.fnos（preload 白名单）转主进程
 */

(function () {
  const F = window.fnos;
  const $ = (id) => document.getElementById(id);

  const view = $('view');
  const elConnect = $('connect');
  const elError = $('error');
  const elProgress = $('progress');
  const elFindbar = $('findbar');
  const elAddrHost = $('addr-host');
  const elAddrPath = $('addr-path');
  const elAddrLock = $('addr-lock');
  const elToast = $('toast');

  let boot = null;
  let viewReady = false;
  let pendingUrl = '';
  let zoom = 0;
  let toastTimer = null;
  let findMatches = 0;
  let findActive = 0;

  // ---------------- 主题 ----------------
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const useDark = () => mq.matches;

  function syncTheme() {
    document.body.classList.toggle('theme-dark', useDark());
    document.body.classList.toggle('theme-light', !useDark());
  }

  try {
    mq.addEventListener('change', syncTheme);
  } catch (_) {
    if (mq.addListener) mq.addListener(syncTheme);
  }
  syncTheme();

  // ---------------- 外观 ----------------
  function applyAppearance(a) {
    if (!a) return;
    const pct = Number(a.uiAlpha);
    const alpha = Number.isFinite(pct) ? Math.max(0, Math.min(1, (100 - pct) / 100)) : 0.38;
    document.documentElement.style.setProperty('--fnos-ui-a', String(alpha));

    const th = Number(a.toolbarHeight);
    document.documentElement.style.setProperty('--tb-h', (Number.isFinite(th) ? th : 52) + 'px');

    document.body.classList.toggle('material-solid', a.material === 'none');
    syncTheme();
  }

  // ---------------- Toast ----------------
  function toast(msg, ms) {
    if (!msg) return;
    elToast.textContent = String(msg);
    elToast.hidden = false;
    requestAnimationFrame(() => elToast.classList.add('show'));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      elToast.classList.remove('show');
      setTimeout(() => { elToast.hidden = true; }, 200);
    }, ms || 2200);
  }

  // ---------------- 地址栏 ----------------
  function renderAddr(url) {
    let host = '未连接';
    let path = '';
    let secure = false;
    try {
      const u = new URL(String(url));
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        host = u.host;
        path = (u.pathname || '/') + (u.search || '');
        secure = u.protocol === 'https:';
      }
    } catch (_) {}
    elAddrHost.textContent = host;
    elAddrPath.textContent = path;
    elAddrLock.hidden = !secure;
    $('addr').title = String(url || '');
  }

  // ---------------- 导航按钮 ----------------
  function updateNavButtons() {
    let canBack = false;
    let canFwd = false;
    if (viewReady) {
      try {
        canBack = view.canGoBack();
        canFwd = view.canGoForward();
      } catch (_) {}
    }
    $('btn-back').disabled = !canBack;
    $('btn-forward').disabled = !canFwd;
  }

  function currentUrl() {
    try { return viewReady ? view.getURL() : ''; } catch (_) { return ''; }
  }

  // ---------------- 载入 ----------------
  function loadUrl(url) {
    const target = String(url || '');
    if (!target) return;
    elError.hidden = true;
    if (!viewReady) {
      pendingUrl = target;
      return;
    }
    try {
      const p = view.loadURL(target);
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      showError('无法载入', String(e && e.message ? e.message : e));
    }
  }

  function applyZoom() {
    if (!viewReady) return;
    try { view.setZoomFactor(Math.pow(1.1, zoom)); } catch (_) {}
  }

  function showError(title, detail) {
    $('err-title').textContent = title || '无法载入页面';
    $('err-detail').textContent = detail || '';
    elError.hidden = false;
  }

  // ---------------- 连接页 ----------------
  function serversNow() {
    return (boot && boot.servers) || [];
  }

  function renderSaved() {
    const list = $('saved-list');
    const wrap = $('saved-wrap');
    const items = serversNow();
    list.innerHTML = '';
    if (!items.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    items.forEach((sv) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'sv-url';
      span.textContent = sv.url;
      const del = document.createElement('button');
      del.className = 'sv-del';
      del.textContent = '移除';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const r = await F.server.remove(sv.url);
        if (r.ok) {
          boot.servers = r.data.servers;
          renderSaved();
        }
      });
      li.appendChild(span);
      li.appendChild(del);
      li.addEventListener('click', () => {
        $('in-server').value = sv.url;
        doConnect();
      });
      list.appendChild(li);
    });
  }

  function showConnect(prefill) {
    $('hint-server').className = 'field-hint';
    $('hint-server').textContent = '支持 IP、IP:端口、域名；不填协议默认 http';
    if (typeof prefill === 'string' && prefill) $('in-server').value = prefill;
    elError.hidden = true;
    elConnect.hidden = false;
    renderSaved();
    setTimeout(() => { try { $('in-server').focus(); $('in-server').select(); } catch (_) {} }, 60);
  }

  function hideConnect() {
    elConnect.hidden = true;
  }

  function hint(text, kind) {
    const el = $('hint-server');
    el.textContent = text;
    el.className = 'field-hint' + (kind ? ' is-' + kind : '');
  }

  async function doConnect() {
    const raw = $('in-server').value.trim();
    if (!raw) {
      hint('请填写服务器地址', 'error');
      return;
    }
    const btn = $('btn-connect');
    btn.disabled = true;
    hint('正在连接…');

    const add = await F.server.add(raw);
    if (!add.ok) {
      btn.disabled = false;
      hint('地址无效：' + (add.error || '未知原因'), 'error');
      return;
    }
    const finalUrl = add.data.url;

    // 刷新本地服务器列表（供下次启动/托盘使用）
    const lst = await F.server.list();
    if (lst.ok) boot.servers = lst.data;

    // 裸 443/8443 的 http 地址：先探 https，成功则优先
    let target = finalUrl;
    if (add.data.suggestHttps) {
      hint('正在尝试 HTTPS…');
      const t = await F.server.test(finalUrl);
      if (t.ok && t.data && t.data.url) target = t.data.url;
    }

    btn.disabled = false;
    hideConnect();
    renderSaved();
    loadUrl(target);
    toast('已连接 ' + finalUrl);
  }

  async function doTest() {
    const raw = $('in-server').value.trim();
    if (!raw) {
      hint('请填写服务器地址', 'error');
      return;
    }
    const btn = $('btn-test');
    btn.disabled = true;
    hint('正在测试…');
    const r = await F.server.test(raw);
    btn.disabled = false;
    if (r.ok && r.data && r.data.ok) {
      hint('连接正常（HTTP ' + r.data.status + '）' + (r.data.url && r.data.url.indexOf('https:') === 0 ? ' · HTTPS' : ''), 'ok');
    } else {
      const err = (r.data && r.data.error) || r.error || '无法访问';
      hint('连接失败：' + err + '。若是自签 HTTPS，可直接点"连接"继续。', 'error');
    }
  }

  // ---------------- 查找 ----------------
  function openFind() {
    elFindbar.hidden = false;
    document.body.classList.add('find-open');
    setTimeout(() => { try { $('find-input').focus(); $('find-input').select(); } catch (_) {} }, 40);
  }

  function closeFind() {
    elFindbar.hidden = true;
    document.body.classList.remove('find-open');
    try { view.stopFindInPage('clearSelection'); } catch (_) {}
    findMatches = 0;
    findActive = 0;
    $('find-count').textContent = '0/0';
  }

  function runFind(forward) {
    const text = $('find-input').value;
    if (!viewReady) return;
    if (!text) {
      try { view.stopFindInPage('clearSelection'); } catch (_) {}
      $('find-count').textContent = '0/0';
      return;
    }
    try {
      view.findInPage(text, { forward: forward !== false, findNext: forward === false ? false : true });
    } catch (_) {}
  }

  // ---------------- webview 事件 ----------------
  view.addEventListener('dom-ready', () => {
    viewReady = true;
    applyZoom();
    if (pendingUrl) {
      const u = pendingUrl;
      pendingUrl = '';
      loadUrl(u);
    }
    updateNavButtons();
  });

  view.addEventListener('did-start-loading', () => {
    elProgress.hidden = false;
  });

  view.addEventListener('did-stop-loading', () => {
    elProgress.hidden = true;
    updateNavButtons();
    renderAddr(currentUrl());
  });

  view.addEventListener('did-navigate', (e) => {
    renderAddr(e.url);
    updateNavButtons();
    if (F && F.nav) F.nav.recordUrl(e.url);
  });

  view.addEventListener('did-navigate-in-page', (e) => {
    renderAddr(e.url);
    updateNavButtons();
  });

  view.addEventListener('page-title-updated', (e) => {
    document.title = e.title || 'FNOS';
  });

  view.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return; // ABORTED
    if (e.isMainFrame === false) return;
    const desc = e.errorDescription || '未知错误';
    showError('无法载入页面', desc + '（' + e.errorCode + '）\n' + (e.validatedURL || ''));
  });

  view.addEventListener('found-in-page', (e) => {
    const r = e.result || {};
    findMatches = r.matches || 0;
    findActive = r.activeMatchOrdinal || 0;
    $('find-count').textContent = findMatches ? findActive + '/' + findMatches : '0/0';
  });

  view.addEventListener('crashed', () => {
    showError('页面进程已退出', '可尝试重新载入；若反复出现，请在帮助菜单复制诊断信息。');
  });

  // ---------------- 主进程命令 ----------------
  const COMMANDS = {
    back: () => { try { if (view.canGoBack()) view.goBack(); } catch (_) {} },
    forward: () => { try { if (view.canGoForward()) view.goForward(); } catch (_) {} },
    reload: () => { try { view.reload(); } catch (_) {} },
    'force-reload': () => { try { view.reloadIgnoringCache(); } catch (_) {} },
    home: () => {
      const home = (boot && (boot.server || (boot.servers[0] && boot.servers[0].url))) || '';
      if (home) loadUrl(home);
      else showConnect('');
    },
    goto: (msg) => {
      if (msg && msg.url) {
        hideConnect();
        loadUrl(msg.url);
      }
    },
    'zoom-step': (msg) => {
      const step = Number(msg && msg.step);
      zoom = step === 0 ? 0 : Math.max(-3, Math.min(5, zoom + (step > 0 ? 1 : -1)));
      applyZoom();
      F.zoom.set(zoom);
      toast('缩放 ' + Math.round(Math.pow(1.1, zoom) * 100) + '%');
    },
    zoom: (msg) => {
      zoom = Number(msg && msg.value) || 0;
      applyZoom();
    },
    'toggle-toolbar': () => {
      document.body.classList.toggle('toolbar-hidden');
    },
    find: () => openFind(),
    'guest-devtools': () => { try { view.openDevTools(); } catch (_) {} },
    'connect-new': () => showConnect(''),
    'switch-server': () => showConnect('')
  };

  F.on('shell:command', (msg) => {
    if (!msg || !msg.op) return;
    const fn = COMMANDS[msg.op];
    if (fn) {
      try { fn(msg); } catch (e) { console.error(e); }
    }
  });

  F.on('shell:appearance', (a) => applyAppearance(a));
  F.on('shell:fullscreen', (p) => {
    document.body.classList.toggle('fullscreen', !!(p && p.fullscreen));
  });
  F.on('shell:load-failed', (p) => {
    if (!p) return;
    showError('无法载入页面', (p.desc || '') + '（' + (p.code || '') + '）\n' + (p.url || ''));
  });
  F.on('shell:crashed', () => {
    showError('页面进程已退出', '可尝试重新载入。');
  });
  F.on('shell:title', (p) => {
    if (p && p.title) document.title = p.title;
  });

  // ---------------- 工具栏交互 ----------------
  $('btn-back').addEventListener('click', () => COMMANDS.back());
  $('btn-forward').addEventListener('click', () => COMMANDS.forward());
  $('btn-reload').addEventListener('click', () => COMMANDS.reload());
  $('btn-home').addEventListener('click', () => COMMANDS.home());
  $('btn-server').addEventListener('click', () => showConnect(''));
  $('btn-settings').addEventListener('click', () => F.settingsWindow.open());

  $('btn-test').addEventListener('click', doTest);
  $('btn-connect').addEventListener('click', doConnect);
  $('in-server').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doConnect();
    if (e.key === 'Escape') {
      if (boot && (boot.server || boot.lastUrl)) hideConnect();
    }
  });

  $('btn-err-retry').addEventListener('click', () => {
    elError.hidden = true;
    COMMANDS.reload();
  });
  $('btn-err-connect').addEventListener('click', () => {
    elError.hidden = true;
    showConnect('');
  });

  $('find-input').addEventListener('input', () => runFind(true));
  $('find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runFind(!e.shiftKey);
    if (e.key === 'Escape') closeFind();
  });
  $('find-next').addEventListener('click', () => runFind(true));
  $('find-prev').addEventListener('click', () => runFind(false));
  $('find-close').addEventListener('click', closeFind);

  $('brand-logo').addEventListener('error', (e) => {
    e.target.style.display = 'none';
  });

  // ---------------- 初始化 ----------------
  function urlFromHash() {
    try {
      const h = String(location.hash || '');
      const m = h.match(/#url=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    } catch (_) {}
    return '';
  }

  async function init() {
    try {
      boot = await F.bootstrap();
    } catch (e) {
      showError('初始化失败', String(e && e.message ? e.message : e));
      return;
    }
    if (!boot || !boot.settings) {
      showError('初始化失败', '无法读取应用配置');
      return;
    }

    applyAppearance(boot.settings.appearance);
    zoom = Number(boot.settings.zoom) || 0;
    renderSaved();

    const start = urlFromHash() || boot.lastUrl || boot.server || '';
    if (start) {
      hideConnect();
      renderAddr(start);
      loadUrl(start);
    } else {
      showConnect('');
    }

    if (boot.isFullScreen) document.body.classList.add('fullscreen');

    F.on('settings:changed', (s) => {
      if (!s) return;
      boot.settings = s;
      boot.servers = s.servers || [];
      applyAppearance(s.appearance);
      zoom = Number(s.zoom) || 0;
      applyZoom();
      renderSaved();
    });

    F.on('shell:system-theme', () => syncTheme());
  }

  init();
})();
