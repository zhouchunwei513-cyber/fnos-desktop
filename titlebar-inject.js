// titlebar-inject.js — 统一的无边框自定义标题栏注入
// 被 preload.js / settings-preload.js / live-preload.js 复用，保证所有窗口标题栏一致。
// 功能：顶部拖动热区、☰ 菜单、最小化/最大化/关闭（实心按钮）、自动隐藏（默认关闭）、
//       ALT 键调出、设置实时更新、SPA 重渲染自愈。
// 用法（preload 内）：require('./titlebar-inject')({ ipcRenderer })
'use strict';

module.exports = function injectTitleBar(ctx) {
  let ipcRenderer = ctx && ctx.ipcRenderer;
  if (!ipcRenderer) { try { ipcRenderer = require('electron').ipcRenderer; } catch (_) {} }
  if (!ipcRenderer) return;
  try {
    if (typeof window === 'undefined') return;
    if (window.top !== window) return; // 仅顶层框架

    // 默认【不】自动隐藏标题栏（常驻）。用户在设置中开启后才自动隐藏。
    let AUTO_HIDE = false;
    try {
      const r = ipcRenderer.sendSync('settings:get-titlebar');
      if (r && typeof r.autoHide === 'boolean') AUTO_HIDE = r.autoHide;
    } catch (_) {}

    const root = () => document.documentElement || document.body || document;

    // 监听设置变化（设置页切换开关后实时生效，无需重启）
    try {
      ipcRenderer.on('settings:titlebar-changed', (_e, val) => {
        try {
          const on = !!val;
          AUTO_HIDE = on;
          const bar = document.getElementById('fnos-titlebar');
          if (bar) {
            if (on) { hide(bar); } else { show(bar); }
          }
        } catch (_) {}
      });
    } catch (_) {}

    function show(bar) {
      try {
        if (bar.__hideTimer) { clearTimeout(bar.__hideTimer); bar.__hideTimer = null; }
        bar.style.transform = 'translateY(0)';
        bar.style.opacity = '1';
        bar.style.pointerEvents = 'auto';
      } catch (_) {}
    }
    function hide(bar) {
      try {
        if (!AUTO_HIDE) return;
        if (bar.__menuOpen) return;
        bar.style.transform = 'translateY(-100%)';
        bar.style.opacity = '0';
        bar.style.pointerEvents = 'none';
      } catch (_) {}
    }
    function scheduleHide(bar, ms) {
      try {
        if (!AUTO_HIDE) return;
        if (bar.__hideTimer) clearTimeout(bar.__hideTimer);
        bar.__hideTimer = setTimeout(() => { bar.__hideTimer = null; hide(bar); }, ms || 600);
        if (bar.__hideTimer.unref) bar.__hideTimer.unref();
      } catch (_) {}
    }

    function build() {
      try {
        if (document.getElementById('fnos-titlebar')) return;

        // ---- 顶部拖动热区：高 28px 隐形条，始终存在、始终可拖动（含标题栏隐藏时） ----
        const hot = document.createElement('div');
        hot.id = 'fnos-titlebar-hotzone';
        hot.setAttribute('aria-hidden', 'true');
        hot.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'height:28px',
          'z-index:2147483646', 'pointer-events:auto', 'background:transparent',
          '-webkit-app-region:drag', 'user-select:none'
        ].join(';');
        root().appendChild(hot);

        // ---- 标题栏 ----
        const bar = document.createElement('div');
        bar.id = 'fnos-titlebar';
        bar.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'height:34px',
          'z-index:2147483647', 'display:flex', 'align-items:center',
          'justify-content:space-between', 'box-sizing:border-box',
          'pointer-events:auto',
          // v1.57：标题栏统一为【完全透明】，直接透出网页内容（与主页面一致）；
          // 不再有深色填充/毛玻璃，避免在浅色应用（应用中心/飞牛音乐）顶部出现一条实色栏。
          'background:transparent', 'backdrop-filter:none', '-webkit-backdrop-filter:none',
          '-webkit-app-region:drag', 'user-select:none',
          'transition:transform .16s ease,opacity .16s ease'
        ].join(';');

        // 左侧：☰ 菜单按钮（弹出原系统菜单栏全部内容）
        const left = document.createElement('div');
        left.style.cssText = '-webkit-app-region:no-drag;pointer-events:auto;display:flex;align-items:center;height:34px;padding-left:6px;margin-left:4px;';
        const menuBtn = document.createElement('button');
        menuBtn.id = 'fnos-tb-menu';
        menuBtn.title = '菜单（文件/下载/编辑/视图/工具/设置/帮助）';
        menuBtn.style.cssText = 'width:40px;height:28px;border:none;outline:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;-webkit-app-region:no-drag;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85));';
        menuBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="rgba(255,255,255,0.95)" stroke-width="1.5" stroke-linecap="round"/></svg>';
        menuBtn.addEventListener('mouseenter', () => { menuBtn.style.background = 'rgba(255,255,255,0.12)'; });
        menuBtn.addEventListener('mouseleave', () => { menuBtn.style.background = 'transparent'; });
        menuBtn.addEventListener('click', () => {
          try {
            ipcRenderer.send('app-popup-menu');
            bar.__menuOpen = true;
            setTimeout(() => { bar.__menuOpen = false; scheduleHide(bar, 600); }, 1600);
          } catch (_) {}
        });
        left.appendChild(menuBtn);

        // 右侧：最小化/最大化/关闭——实心 Windows 风格，按钮可点击区域充足
        const btns = document.createElement('div');
        btns.style.cssText = '-webkit-app-region:no-drag;pointer-events:auto;display:flex;align-items:stretch;height:34px;margin-right:0;overflow:hidden;';

        const mkBtn = (id, svg, hoverBg) => {
          const b = document.createElement('button');
          b.id = id;
          b.title = id === 'fnos-tb-min' ? '最小化' : id === 'fnos-tb-max' ? '最大化/还原' : '关闭';
          b.style.cssText = [
            'width:46px', 'height:34px', 'border:none', 'outline:none',
            'background:transparent', 'color:#fff',
            'cursor:pointer', 'display:flex', 'align-items:center', 'justify-content:center',
            'padding:0', '-webkit-app-region:no-drag', 'flex:0 0 auto',
            'filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85))'
          ].join(';');
          b.innerHTML = svg;
          b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
          b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
          return b;
        };

        const minBtn = mkBtn('fnos-tb-min',
          '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M3 8H13" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/></svg>', 'rgba(255,255,255,0.22)');
        const maxBtn = mkBtn('fnos-tb-max',
          '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2" fill="none" stroke="#fff" stroke-width="1.3"/></svg>', 'rgba(255,255,255,0.22)');
        const closeBtn = mkBtn('fnos-tb-close',
          '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 4L12 12M12 4L4 12" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/></svg>', '#E81123');

        minBtn.addEventListener('click', () => { try { ipcRenderer.send('window-minimize'); } catch (_) {} });
        maxBtn.addEventListener('click', () => { try { ipcRenderer.send('window-maximize'); } catch (_) {} });
        closeBtn.addEventListener('click', () => { try { ipcRenderer.send('window-close'); } catch (_) {} });
        bar.addEventListener('dblclick', (ev) => {
          if (ev.target === bar || ev.target === hot) { try { ipcRenderer.send('window-maximize'); } catch (_) {} }
        });

        btns.appendChild(minBtn); btns.appendChild(maxBtn); btns.appendChild(closeBtn);
        bar.appendChild(left);
        bar.appendChild(btns);
        root().appendChild(bar);

        // ---- 显隐：标题栏/热区 hover 时保持显示，移出后延迟隐藏（常驻模式永不隐藏） ----
        bar.addEventListener('mouseenter', () => show(bar));
        bar.addEventListener('mouseleave', () => scheduleHide(bar, 500));
        hot.addEventListener('mouseenter', () => show(bar));
        hot.addEventListener('mouseleave', () => scheduleHide(bar, 500));

        // ALT 键调出标题栏（自动隐藏模式下），2.2s 后收回
        window.addEventListener('keydown', (ev) => {
          try {
            if (ev.key === 'Alt' || ev.altKey) {
              show(bar);
              if (AUTO_HIDE) scheduleHide(bar, 2200);
            }
          } catch (_) {}
        }, true);

        // 初始状态
        if (AUTO_HIDE) hide(bar); else show(bar);

        // ---- 防 SPA 重渲染清除：节点被移除则重注 ----
        try {
          const mo = new MutationObserver(() => {
            try {
              if (!document.getElementById('fnos-titlebar') || !document.getElementById('fnos-titlebar-hotzone')) {
                mo.disconnect();
                build();
              }
            } catch (_) {}
          });
          mo.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch (_) {}

        try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.injected', autoHide: AUTO_HIDE, path: (location.pathname || '').slice(0, 50) }); } catch (_) {}
      } catch (e) {
        try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.build.ex', err: String((e && e.message) || e) }); } catch (_) {}
      }
    }

    const start = () => { try { build(); } catch (_) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) {
    try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.ex', err: String((e && e.message) || e) }); } catch (_) {}
  }
};
