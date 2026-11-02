'use strict';

/**
 * FNOS macOS 偏好设置逻辑
 * - 所有设置写入 userData/settings.json（经 preload → 主进程 store）
 * - 外观类改动即时预览：主进程同时把变更广播给主窗口
 */

(function () {
  const F = window.fnosSettings;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  let state = null;
  let syncing = false;
  let patchTimer = null;
  let toastTimer = null;
  let resetArmed = false;

  // ---------------- 主题 ----------------
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  function syncTheme() {
    document.body.classList.toggle('theme-dark', mq.matches);
    document.body.classList.toggle('theme-light', !mq.matches);
  }

  try { mq.addEventListener('change', syncTheme); } catch (_) { if (mq.addListener) mq.addListener(syncTheme); }
  syncTheme();

  // ---------------- Toast ----------------
  function toast(msg, ms) {
    if (!msg) return;
    const el = $('toast');
    el.textContent = String(msg);
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 200);
    }, ms || 2200);
  }

  // ---------------- 本地外观预览 ----------------
  function applyAppearance(a) {
    if (!a) return;
    const pct = Number(a.uiAlpha);
    const alpha = Number.isFinite(pct) ? Math.max(0, Math.min(1, (100 - pct) / 100)) : 0.38;
    document.documentElement.style.setProperty('--fnos-ui-a', String(alpha));
    syncTheme();
  }

  // ---------------- 侧栏 ----------------
  function selectPane(name) {
    $$('.sb-item').forEach((b) => b.classList.toggle('is-active', b.dataset.pane === name));
    $$('.pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === name));
    if (name === 'logs') refreshLogs();
    if (name === 'update') refreshUpdate();
  }

  $$('.sb-item').forEach((btn) => {
    btn.addEventListener('click', () => selectPane(btn.dataset.pane));
  });

  // ---------------- 读状态 → 控件 ----------------
  function percent(factor) {
    return Math.round((Number(factor) || 0) * 100);
  }

  function reflect() {
    if (!state) return;
    syncing = true;

    const ap = state.appearance || {};
    $('sel-material').value = ap.material || 'under-window';
    $('rg-ui-alpha').value = String(ap.uiAlpha == null ? 62 : ap.uiAlpha);
    $('ui-alpha-val').textContent = (ap.uiAlpha == null ? 62 : ap.uiAlpha) + '%';
    $('rg-tb-height').value = String(ap.toolbarHeight || 52);
    $('tb-height-val').textContent = (ap.toolbarHeight || 52) + ' pt';
    $('rg-zoom').value = String(state.zoom || 0);
    $('zoom-val').textContent = percent(Math.pow(1.1, Number(state.zoom) || 0)) + '%';

    $$('#seg-theme button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.value === (ap.theme || 'system'));
    });

    const bh = state.behavior || {};
    $('sw-login').checked = !!bh.launchAtLogin;
    $('sw-hide-close').checked = bh.hideOnClose !== false;
    $('sw-restore').checked = bh.restoreLastUrl !== false;
    $('in-hotkey').value = bh.globalHotkey || '';

    applyAppearance(ap);
    renderServers();

    syncing = false;
  }

  // ---------------- 写入 ----------------
  async function patch(partial, opts) {
    const options = opts || {};
    const r = await F.settings.patch(partial);
    if (!r || !r.ok) {
      toast('保存失败：' + ((r && r.error) || '未知错误'));
      return null;
    }
    state = r.data;
    if (!options.quiet) reflect();
    if (!options.noApply) F.settings.applied();
    return state;
  }

  function patchDebounced(partial, ms) {
    if (patchTimer) clearTimeout(patchTimer);
    patchTimer = setTimeout(() => {
      patchTimer = null;
      patch(partial, { quiet: true });
    }, ms == null ? 160 : ms);
  }

  // ---------------- 外观控件 ----------------
  $('sel-material').addEventListener('change', (e) => {
    if (syncing) return;
    patch({ appearance: { material: e.target.value } });
  });

  $('rg-ui-alpha').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('ui-alpha-val').textContent = v + '%';
    document.documentElement.style.setProperty('--fnos-ui-a', String((100 - v) / 100));
    patchDebounced({ appearance: { uiAlpha: v } }, 120);
  });

  $('rg-tb-height').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('tb-height-val').textContent = v + ' pt';
    patchDebounced({ appearance: { toolbarHeight: v } }, 140);
  });

  $('rg-zoom').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('zoom-val').textContent = percent(Math.pow(1.1, v)) + '%';
    patchDebounced({ zoom: v }, 180);
  });

  $$('#seg-theme button').forEach((btn) => {
    btn.addEventListener('click', () => {
      patch({ appearance: { theme: btn.dataset.value } });
    });
  });

  // ---------------- 通用 ----------------
  $('sw-login').addEventListener('change', (e) => {
    if (syncing) return;
    patch({ behavior: { launchAtLogin: !!e.target.checked } });
    toast(e.target.checked ? '已设置为登录时启动' : '已关闭登录时启动');
  });

  $('sw-hide-close').addEventListener('change', (e) => {
    if (syncing) return;
    patch({ behavior: { hideOnClose: !!e.target.checked } });
  });

  $('sw-restore').addEventListener('change', (e) => {
    if (syncing) return;
    patch({ behavior: { restoreLastUrl: !!e.target.checked } });
  });

  $('in-hotkey').addEventListener('change', (e) => {
    if (syncing) return;
    const v = String(e.target.value || '').trim();
    patch({ behavior: { globalHotkey: v } });
    toast(v ? '快捷键已更新：' + v : '已关闭全局快捷键');
  });

  $('btn-reset').addEventListener('click', async () => {
    if (!resetArmed) {
      resetArmed = true;
      $('btn-reset').textContent = '再次点击确认重置';
      setTimeout(() => {
        resetArmed = false;
        $('btn-reset').textContent = '重置全部设置…';
      }, 2600);
      return;
    }
    resetArmed = false;
    $('btn-reset').textContent = '重置全部设置…';
    const r = await F.settings.reset();
    if (r && r.ok) {
      state = r.data;
      reflect();
      F.settings.applied();
      toast('已恢复默认设置');
    }
  });

  // ---------------- 服务器 ----------------
  function renderServers() {
    const list = $('server-list');
    if (!list) return;
    list.innerHTML = '';
    const servers = (state && state.servers) || [];
    if (!servers.length) {
      const li = document.createElement('li');
      li.style.color = 'var(--text-3)';
      li.textContent = '尚未保存任何服务器';
      list.appendChild(li);
      return;
    }
    servers.forEach((sv) => {
      const li = document.createElement('li');

      const url = document.createElement('span');
      url.className = 'sv-url';
      url.textContent = sv.url;
      url.title = sv.url;
      li.appendChild(url);

      if (state.activeServer === sv.url) {
        const badge = document.createElement('span');
        badge.className = 'sv-badge';
        badge.textContent = '当前';
        li.appendChild(badge);
      }

      const open = document.createElement('button');
      open.className = 'sv-act';
      open.textContent = '打开';
      open.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const r = await F.server.switchTo(sv.url);
        if (r && r.ok) toast('已在主窗口打开 ' + sv.url);
        else toast('打开失败');
      });
      li.appendChild(open);

      const del = document.createElement('button');
      del.className = 'sv-act sv-del';
      del.textContent = '移除';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const r = await F.server.remove(sv.url);
        if (r && r.ok) {
          const lst = await F.server.list();
          if (lst && lst.ok && state) state.servers = lst.data;
          renderServers();
          toast('已移除');
        }
      });
      li.appendChild(del);

      list.appendChild(li);
    });
  }

  function hintServer(text, kind) {
    const el = $('hint-server');
    el.textContent = text;
    el.className = 'row-hint' + (kind ? '' : '');
    el.style.color = kind === 'error' ? 'var(--danger)' : kind === 'ok' ? '#30d158' : '';
  }

  $('btn-add').addEventListener('click', async () => {
    const raw = $('in-server').value.trim();
    if (!raw) {
      hintServer('请填写服务器地址', 'error');
      return;
    }
    const btn = $('btn-add');
    btn.disabled = true;
    const r = await F.server.add(raw);
    btn.disabled = false;
    if (!r || !r.ok) {
      hintServer('地址无效：' + ((r && r.error) || '未知原因'), 'error');
      return;
    }
    hintServer('已保存 ' + r.data.url, 'ok');
    $('in-server').value = '';
    const lst = await F.server.list();
    if (lst && lst.ok && state) {
      state.servers = lst.data;
      renderServers();
    }
    toast('已添加 ' + r.data.url);
  });

  $('btn-test').addEventListener('click', async () => {
    const raw = $('in-server').value.trim();
    if (!raw) {
      hintServer('请填写服务器地址', 'error');
      return;
    }
    const btn = $('btn-test');
    btn.disabled = true;
    hintServer('正在测试…');
    const r = await F.server.test(raw);
    btn.disabled = false;
    if (r && r.ok && r.data && r.data.ok) {
      hintServer('连接正常（HTTP ' + r.data.status + '）', 'ok');
    } else {
      const err = (r && r.data && r.data.error) || (r && r.error) || '无法访问';
      hintServer('连接失败：' + err, 'error');
    }
  });

  $('in-server').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-add').click();
  });

  // ---------------- 更新 ----------------
  async function refreshUpdate() {
    const v = await F.version();
    if (v && v.ok) {
      $('ver-current').textContent = 'v' + v.data.version;
      $('about-version').textContent = 'v' + v.data.version + ' · ' + v.data.arch;
      $('about-env').textContent =
        'Electron ' + v.data.electron + ' · Chrome ' + v.data.chrome + ' · macOS ' + (v.data.osVersion || v.data.platform);
    }
    const info = await F.update.info();
    if (info && info.ok) {
      const t = Number(info.data.lastCheckAt);
      $('ver-checked').textContent = t ? new Date(t).toLocaleString('zh-CN') : '尚未检查';
    }
  }

  $('btn-check-update').addEventListener('click', async () => {
    const btn = $('btn-check-update');
    btn.disabled = true;
    btn.textContent = '检查中…';
    await F.update.check();
    btn.disabled = false;
    btn.textContent = '立即检查';
    refreshUpdate();
  });

  $('btn-copy-xattr').addEventListener('click', async () => {
    await F.app.copy($('cmd-xattr').textContent);
    toast('命令已拷贝到剪贴板');
  });

  // ---------------- 日志 ----------------
  let logFiles = [];

  async function refreshLogs() {
    const r = await F.log.list();
    if (!r || !r.ok) return;
    $('log-dir').textContent = r.data.dir || '—';
    logFiles = r.data.files || [];
    const sel = $('log-files');
    sel.innerHTML = '';
    if (!logFiles.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '暂无日志文件';
      sel.appendChild(opt);
      return;
    }
    logFiles.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f.name;
      opt.textContent = f.name + '（' + Math.max(1, Math.round(f.size / 1024)) + ' KB）';
      sel.appendChild(opt);
    });
  }

  $('btn-load-log').addEventListener('click', async () => {
    const name = $('log-files').value;
    if (!name) return;
    const r = await F.log.read(name);
    $('log-view').value = (r && r.ok && r.data) || '（空）';
    $('log-view').scrollTop = $('log-view').scrollHeight;
  });

  $('btn-open-logs').addEventListener('click', () => F.log.openFolder());

  $('btn-export-log').addEventListener('click', async () => {
    const content = $('log-view').value;
    if (!content) {
      toast('请先查看一份日志');
      return;
    }
    const name = $('log-files').value || 'fnos.log';
    const okSave = await F.log.saveAs(content, 'fnos-export-' + name);
    if (okSave && okSave.ok && okSave.data) toast('已导出');
  });

  // ---------------- 关于 ----------------
  $('btn-about-panel').addEventListener('click', () => F.about.panel());

  $('btn-diag').addEventListener('click', async () => {
    const r = await F.about.diagnostics();
    if (r && r.ok) toast('诊断信息已复制到剪贴板');
  });

  $('btn-open-config').addEventListener('click', async () => {
    const p = await F.settings.path();
    if (p && p.ok) F.app.revealPath(p.data.replace(/\/settings\.json$/, ''));
  });

  $('about-logo').addEventListener('error', (e) => { e.target.style.display = 'none'; });

  // ---------------- 事件 ----------------
  F.on('settings:changed', (s) => {
    if (!s) return;
    state = s;
    reflect();
  });

  F.on('settings:goto-tab', (p) => {
    if (p && p.tab) selectPane(String(p.tab));
  });

  F.on('shell:appearance', (a) => applyAppearance(a));

  // ---------------- 初始化 ----------------
  async function init() {
    const r = await F.settings.get();
    if (r && r.ok) {
      state = r.data;
      reflect();
    } else {
      toast('无法读取设置');
    }
    await refreshUpdate();
    await refreshLogs();
  }

  init();
})();
