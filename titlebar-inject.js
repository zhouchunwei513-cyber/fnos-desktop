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

    // v1.58：标题栏样式状态。默认【不】自动隐藏（常驻）、透明材质。
    const TB = { autoHide: false, material: 'transparent', opacity: 0, blur: 12, color: '#3B82F6' };
    try {
      const r = ipcRenderer.sendSync('settings:get-titlebar');
      if (r && typeof r === 'object') {
        if (typeof r.autoHide === 'boolean') TB.autoHide = r.autoHide;
        if (r.material === 'frosted' || r.material === 'transparent') TB.material = r.material;
        if (r.opacity != null) TB.opacity = Math.max(0, Math.min(100, Number(r.opacity) || 0));
        if (r.blur != null) TB.blur = Math.max(0, Math.min(40, Number(r.blur) || 0));
        if (r.color) TB.color = String(r.color);
      }
    } catch (_) {}
    let AUTO_HIDE = TB.autoHide;

    const root = () => document.documentElement || document.body || document;

    // 把 #RRGGBB + 不透明度(0~100) 转成 rgba()
    function hexToRgba(hex, a) {
      try {
        let h = String(hex || '').replace('#', '').trim();
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        const n = parseInt(h, 16);
        if (!isFinite(n) || h.length !== 6) return `rgba(0,0,0,${a})`;
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return `rgba(${r},${g},${b},${a})`;
      } catch (_) { return `rgba(0,0,0,${a})`; }
    }

    // 根据设置计算标题栏背景/模糊并应用；同时调整图标配色
    function applyStyle(bar) {
      try {
        if (!bar) return;
        if (TB.material === 'frosted') {
          // 磨砂：带颜色底色（不透明度滑块控制深浅）+ backdrop 模糊（磨砂滑块）
          const a = TB.opacity / 100 * 0.72; // 磨砂模式底色最高约 72%
          bar.style.background = hexToRgba(TB.color, a);
          const blur = Math.max(2, TB.blur);
          bar.style.backdropFilter = `blur(${blur}px) saturate(1.4)`;
          bar.style.webkitBackdropFilter = `blur(${blur}px) saturate(1.4)`;
        } else {
          // 透明：底色由不透明度滑块控制（默认 0=完全透明），无模糊
          const a = TB.opacity / 100;
          bar.style.background = a > 0.001 ? hexToRgba(TB.color, a) : 'transparent';
          bar.style.backdropFilter = 'none';
          bar.style.webkitBackdropFilter = 'none';
        }
        // 底色较深时图标用白，较浅时图标用深色——保证对比
        const darkBg = TB.material === 'frosted' || (TB.material === 'transparent' && TB.opacity > 45);
        bar.__useDarkIcon = !darkBg; // true = 浅底用深图标
        const iconStroke = darkBg ? 'rgba(255,255,255,0.95)' : 'rgba(20,20,20,0.92)';
        const iconShadow = darkBg
          ? 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
          : 'drop-shadow(0 1px 1px rgba(255,255,255,0.6))';
        bar.querySelectorAll('svg').forEach((svg) => {
          svg.querySelectorAll('path,line').forEach((p) => { p.setAttribute('stroke', iconStroke); });
          svg.style.filter = iconShadow;
        });
      } catch (_) {}
    }

    // v1.63：主进程全局光标轮询兜底——嵌入置顶 mpv 会挡住顶部鼠标事件，
    // 光标进入宿主顶部 34px 带时主进程发 force-show:true 强制显示标题栏，离开发 false 恢复。
    try {
      ipcRenderer.on('titlebar:force-show', (_e, data) => {
        try {
          const bar0 = document.getElementById('fnos-titlebar');
          if (!bar0) return;
          forceShow = !!(data && data.show);
          if (forceShow) show(bar0);
          else { if (AUTO_HIDE) hide(bar0); else show(bar0); }
        } catch (_) {}
      });
    } catch (_) {}

    // 监听设置变化（设置页切换后实时生效，无需重启）。payload 为完整样式对象
    try {
      ipcRenderer.on('settings:titlebar-changed', (_e, val) => {
        try {
          if (val && typeof val === 'object') {
            if (typeof val.autoHide === 'boolean') { TB.autoHide = val.autoHide; AUTO_HIDE = val.autoHide; }
            if (val.material === 'frosted' || val.material === 'transparent') TB.material = val.material;
            if (val.opacity != null) TB.opacity = Math.max(0, Math.min(100, Number(val.opacity) || 0));
            if (val.blur != null) TB.blur = Math.max(0, Math.min(40, Number(val.blur) || 0));
            if (val.color) TB.color = String(val.color);
            const bar0 = document.getElementById('fnos-titlebar');
            if (bar0) {
              applyStyle(bar0);
              if (AUTO_HIDE) hide(bar0); else show(bar0);
            }
          } else if (typeof val === 'boolean') {
            // 兼容旧版裸布尔消息
            TB.autoHide = val; AUTO_HIDE = val;
            const bar0 = document.getElementById('fnos-titlebar');
            if (bar0) { if (val) hide(bar0); else show(bar0); }
          }
        } catch (_) {}
      });
    } catch (_) {}

    let forceShow = false; // v1.63：主进程光标轮询判定"鼠标在宿主顶部带"时强制显示
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
        if (forceShow) return;   // 主进程判定鼠标在顶部带，保持显示
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

        // 清理可能残留的旧沉浸黑条（v1.60~v1.61 引入，v1.62 移除：它是 no-drag 层会干扰拖动、且强制黑底）
        try { const old = document.getElementById('fnos-embed-topbar'); if (old) old.remove(); } catch (_) {}

        // ---- 顶部拖动热区：高 34px（与标题栏同高），始终存在、始终可拖动（含标题栏隐藏时） ----
        const hot = document.createElement('div');
        hot.id = 'fnos-titlebar-hotzone';
        hot.setAttribute('aria-hidden', 'true');
        hot.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'height:34px',
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
        menuBtn.title = '菜单（文件/下载/视图/工具/设置/帮助）';
        menuBtn.style.cssText = 'width:46px;height:34px;border:none;outline:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;-webkit-app-region:no-drag;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85));';
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
        btns.style.cssText = '-webkit-app-region:no-drag;pointer-events:auto;display:flex;align-items:stretch;height:34px;margin-right:8px;overflow:hidden;';

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
          // v2.0.3：确保SVG图标不受页面CSS影响
          const svgEl = b.querySelector('svg');
          if (svgEl) { svgEl.style.cssText = 'display:block;pointer-events:none;flex-shrink:0;'; }
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

        // v1.62：原生拖拽兜底。-webkit-app-region:drag 在置顶嵌入 mpv 存在时可能失灵，
        // 这里在顶部热区/标题栏空白处左键 mousedown 主动调 startDrag；点按钮/☰ 时 target
        // 命中按钮（no-drag 区）不触发，避免影响点击。
        const startNativeDrag = (ev) => {
          try {
            if (ev.button !== 0) return;
            const t = ev.target;
            if (t && t.closest && t.closest('button, .fnos-tb-no-drag, #fnos-tb-min, #fnos-tb-max, #fnos-tb-close, #fnos-tb-menu')) return;
            ipcRenderer.send('window-drag');
          } catch (_) {}
        };
        hot.addEventListener('mousedown', startNativeDrag);
        bar.addEventListener('mousedown', startNativeDrag);

        btns.appendChild(minBtn); btns.appendChild(maxBtn); btns.appendChild(closeBtn);
        bar.appendChild(left);
        bar.appendChild(btns);
        root().appendChild(bar);

        // ---- 显隐：document 级鼠标 Y 判定（比 mouseenter 可靠：鼠标已在顶部区域、或元素层级
        //      被其它内容干扰时也能触发）。进入顶部 34px 显示，移出后延迟隐藏（常驻模式永不隐藏） ----
        let __inTop = false;
        document.addEventListener('mousemove', (ev) => {
          try {
            const inTop = (ev.clientY != null && ev.clientY <= 34);
            if (inTop && !__inTop) { __inTop = true; show(bar); }
            else if (!inTop && __inTop) { __inTop = false; scheduleHide(bar, 450); }
          } catch (_) {}
        }, true);
        // 元素级 hover 兜底（某些场景 mousemove target 为窗口按钮等不冒泡到 document 时）
        bar.addEventListener('mouseenter', () => show(bar));
        bar.addEventListener('mouseleave', () => scheduleHide(bar, 450));
        hot.addEventListener('mouseenter', () => show(bar));
        hot.addEventListener('mouseleave', () => scheduleHide(bar, 450));

        // ALT 键调出标题栏（自动隐藏模式下），2.2s 后收回
        window.addEventListener('keydown', (ev) => {
          try {
            if (ev.key === 'Alt' || ev.altKey) {
              show(bar);
              if (AUTO_HIDE) scheduleHide(bar, 2200);
            }
          } catch (_) {}
        }, true);

        // 初始状态：先应用材质/颜色样式，再按自动隐藏决定显隐
        applyStyle(bar);
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

    // ============ v2.0.0 左侧悬浮账号切换面板 ============
    function buildAccountSwitcher() {
      try {
        if (document.getElementById('fnos-account-switcher')) return;

        const panel = document.createElement('div');
        panel.id = 'fnos-account-switcher';
        panel.innerHTML = `
          <div id="fnos-acct-trigger" title="切换账号">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
          <div id="fnos-acct-dropdown" class="fnos-acct-hidden">
            <div class="fnos-acct-header">已登录账号</div>
            <div id="fnos-acct-list"></div>
            <div id="fnos-acct-add" class="fnos-acct-item">+ 登录其它账号</div>
          </div>
        `;

        // iOS27 液态玻璃风格
        const style = document.createElement('style');
        style.textContent = `
          #fnos-account-switcher {
            position: fixed; left: 0; top: 50%; transform: translateY(-50%);
            z-index: 99999; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          }
          #fnos-acct-trigger {
            width: 24px; height: 48px; display: flex; align-items: center; justify-content: center;
            background: rgba(255,255,255,0.08);
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 0 12px 12px 0;
            color: rgba(255,255,255,0.7); cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          }
          #fnos-acct-trigger:hover {
            width: 32px; background: rgba(255,255,255,0.15); color: #fff;
          }
          #fnos-acct-dropdown {
            position: absolute; left: 32px; top: 50%; transform: translateY(-50%);
            min-width: 200px; max-width: 280px;
            background: rgba(30, 27, 46, 0.85);
            backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2);
            padding: 8px 0;
            transition: opacity 0.2s, transform 0.2s;
          }
          .fnos-acct-hidden { opacity: 0 !important; pointer-events: none !important; transform: translateY(-50%) translateX(-8px) !important; }
          .fnos-acct-header {
            padding: 8px 16px 6px; font-size: 11px; color: rgba(255,255,255,0.4);
            text-transform: uppercase; letter-spacing: 0.5px;
          }
          .fnos-acct-item {
            padding: 8px 16px; cursor: pointer; font-size: 13px;
            color: rgba(255,255,255,0.8); display: flex; align-items: center; gap: 8px;
            transition: background 0.15s;
          }
          .fnos-acct-item:hover { background: rgba(255,255,255,0.08); }
          .fnos-acct-item.active { color: #60a5fa; }
          .fnos-acct-item .acct-dot {
            width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
          }
          .fnos-acct-item.active .acct-dot { background: #60a5fa; }
          .fnos-acct-item:not(.active) .acct-dot { background: rgba(255,255,255,0.2); }
          .fnos-acct-item .acct-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .fnos-acct-item .acct-remove {
            opacity: 0; font-size: 14px; color: rgba(255,255,255,0.3);
            transition: opacity 0.15s, color 0.15s; padding: 2px 4px;
          }
          .fnos-acct-item:hover .acct-remove { opacity: 1; }
          .fnos-acct-item .acct-remove:hover { color: #f87171; }
          #fnos-acct-add { color: rgba(255,255,255,0.5); border-top: 1px solid rgba(255,255,255,0.08); margin-top: 4px; padding-top: 10px; }
        `;

        // 事件绑定
        const trigger = panel.querySelector('#fnos-acct-trigger');
        const dropdown = panel.querySelector('#fnos-acct-dropdown');
        let hideTimer = null;

        function showDropdown() {
          clearTimeout(hideTimer);
          dropdown.classList.remove('fnos-acct-hidden');
          loadAccountList();
        }
        function hideDropdown() {
          hideTimer = setTimeout(() => dropdown.classList.add('fnos-acct-hidden'), 300);
        }

        trigger.addEventListener('mouseenter', showDropdown);
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          if (dropdown.classList.contains('fnos-acct-hidden')) showDropdown();
          else hideDropdown();
        });
        panel.addEventListener('mouseleave', hideDropdown);

        async function loadAccountList() {
          try {
            const listEl = panel.querySelector('#fnos-acct-list');
            // 通过 fnos 全局对象调用（preload 暴露的）
            let accounts = [];
            try {
              const res = await (window.fnApi ? window.fnApi.listAccounts() : ipcRenderer.invoke('account:list'));
              if (res && res.success) accounts = res.data || [];
            } catch (_) {}
            
            listEl.innerHTML = '';
            if (accounts.length === 0) {
              listEl.innerHTML = '<div style="padding:8px 16px;font-size:12px;color:rgba(255,255,255,0.3)">暂无已登录账号</div>';
              return;
            }
            accounts.forEach(acct => {
              const item = document.createElement('div');
              item.className = 'fnos-acct-item' + (acct.isActive ? ' active' : '');
              item.innerHTML = `
                <span class="acct-dot"></span>
                <span class="acct-label">${acct.label || acct.origin || '未知'}</span>
                <span class="acct-remove" title="移除账号">×</span>
              `;
              item.querySelector('.acct-label').addEventListener('click', () => {
                if (!acct.isActive) {
                  try {
                    if (window.fnApi) window.fnApi.switchAccount(acct.origin);
                    else ipcRenderer.invoke('account:switch', { origin: acct.origin });
                  } catch (_) {}
                  hideDropdown();
                }
              });
              item.querySelector('.acct-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('确定移除账号 ' + (acct.label || acct.origin) + '？')) {
                  try {
                    if (window.fnApi) window.fnApi.removeAccount(acct.id);
                    else ipcRenderer.invoke('account:remove', { accountId: acct.id });
                  } catch (_) {}
                  loadAccountList();
                }
              });
              listEl.appendChild(item);
            });
          } catch (_) {}
        }

        // 添加账号按钮
        panel.querySelector('#fnos-acct-add').addEventListener('click', () => {
          try {
            if (window.fnos) window.fnos.backToConnect && window.fnos.backToConnect();
            else ipcRenderer.invoke('auth:back-to-connect');
          } catch (_) {}
          hideDropdown();
        });

        document.body.appendChild(style);
        document.body.appendChild(panel);
      } catch (_) {}
    }

    
    const start = () => { try { build(); buildAccountSwitcher(); } catch (_) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) {
    try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.ex', err: String((e && e.message) || e) }); } catch (_) {}
  }
};
