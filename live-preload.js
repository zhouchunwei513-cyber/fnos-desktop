'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 原生直播播放器使用的桥接 API（contextIsolation 安全暴露）
contextBridge.exposeInMainWorld('fnosLive', {
  // 初始上下文：NAS 基地址、当前线路、收藏、本地代理地址与运行状态
  getContext: () => ipcRenderer.invoke('iptv:get-context'),
  // 按线路拉取并解析播放列表（主进程完成网络请求，规避 CORS）
  fetchPlaylist: (line) => ipcRenderer.invoke('iptv:fetch-playlist', line),
  // 切换订阅线路（inner/ipv6/frp）
  setLine: (line) => ipcRenderer.invoke('iptv:set-line', line),
  // v1.16.1：探测三条线路连通性与延迟，按内网>IPv6>FRP顺序选第一条可用
  probeLines: (force) => ipcRenderer.invoke('iptv:probe-lines', { force: !!force }),
  // v1.16.1：网络变化事件（自动模式下重新探测）
  onNetworkChanged: (cb) => {
    const h = () => cb();
    ipcRenderer.on('live:network-changed', h);
    return () => ipcRenderer.removeListener('live:network-changed', h);
  },
  // 收藏/取消收藏
  toggleFavorite: (name) => ipcRenderer.invoke('iptv:toggle-favorite', name),
  // v1.17.7：本地代理模块已移除，直播流直连 FPK 服务端。
  // 外部（菜单/webview）请求播放某频道
  onPlay: (cb) => {
    const h = (_e, ch) => cb(ch);
    ipcRenderer.on('live:play', h);
    return () => ipcRenderer.removeListener('live:play', h);
  },
  // v1.17.1：把内置播放器诊断日志写入主进程 fnos-diag.log
  diagLog: (line) => ipcRenderer.invoke('diag:log', String(line || '')),

  // ===== v1.23.0：EPG / 回看 / 录制 / 增强日志 =====
  // 拉取 EPG（XMLTV，主进程缓存 6 小时）
  fetchEpg: (url) => ipcRenderer.invoke('iptv:fetch-epg', url),
  // 根据频道与时间区间构造回看 URL
  catchupUrl: (channel, startMs, stopMs) => ipcRenderer.invoke('iptv:catchup-url', channel, startMs, stopMs),
  // 开始录制（返回 id + 文件路径）
  recordStart: (channel) => ipcRenderer.invoke('iptv:record-start', channel),
  // 停止录制
  recordStop: (id) => ipcRenderer.invoke('iptv:record-stop', id),
  // 列出正在进行的录制
  recordList: () => ipcRenderer.invoke('iptv:record-list'),
  // 打开录制保存目录
  recordOpenFolder: (id) => ipcRenderer.invoke('iptv:record-open-folder', id),
  // 录制状态变化（开始/停止）
  onRecordingState: (cb) => {
    const h = (_e, info) => cb(info);
    ipcRenderer.on('iptv:recording-state', h);
    return () => ipcRenderer.removeListener('iptv:recording-state', h);
  },
  // 录制进度（分片数/字节数）
  onRecordingProgress: (cb) => {
    const h = (_e, info) => cb(info);
    ipcRenderer.on('iptv:recording-progress', h);
    return () => ipcRenderer.removeListener('iptv:recording-progress', h);
  },
  // 结构化直播日志
  liveLog: (level, event, data) => ipcRenderer.invoke('iptv:log', level, event, data),
  // v1.26.0：用内置 MPV 应用内嵌入播放当前流（4K/HEVC/E-AC-3 等内置 hls.js 解不了时的兜底）
  mpvPlay: (url, meta) => ipcRenderer.invoke('mpv:play', { url, title: (meta && meta.title) || '', isLive: !!(meta && meta.isLive) }),
  mpvEmbed: (payload) => ipcRenderer.invoke('mpv:embed', payload || {}),
  mpvEmbedRect: (rect) => ipcRenderer.send('mpv:embed-rect', rect),
  onMpvEmbedClosed: (cb) => { const h = () => cb && cb(); ipcRenderer.on('mpv:embed-closed', h); return () => ipcRenderer.removeListener('mpv:embed-closed', h); },

  // ===== v1.24.0：libVLC 通道（v1.25.0 起停用，保留为空实现，旧调用安全回退 hls.js）=====
  vlcStatus: () => ipcRenderer.invoke('vlc:status'),
  vlcPlay: () => Promise.resolve({ ok: false, fallback: true }),
  vlcRect: () => Promise.resolve({ ok: true }),
  vlcVisible: () => Promise.resolve({ ok: true }),
  vlcControl: () => Promise.resolve({ ok: true }),
  vlcSet: () => Promise.resolve({ ok: true }),
  vlcDestroy: () => Promise.resolve({ ok: true }),
  onVlcEvent: () => () => {},
});

// ============================================================================
// v1.50.0：电视直播窗口统一无边框自定义标题栏（与主窗口/应用窗口风格一致）。
// 默认隐藏，鼠标移到窗口顶部热区下滑显示，移开自动上滑隐藏；☰ 弹出应用菜单，
// 右侧最小化/最大化/关闭。直播页为本地 file:// 或远程 http，均注入。
// ============================================================================
(function injectLiveTitleBar() {
  try {
    const BTN_HOVER_BG = 'rgba(128,128,128,0.35)';
    const CLOSE_HOVER_BG = 'rgba(232,17,35,0.85)';
    const iconStroke = 'rgba(255,255,255,0.92)';

    function buildBar() {
      if (document.getElementById('fnos-titlebar')) return;
      const bar = document.createElement('div');
      bar.id = 'fnos-titlebar';
      bar.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'height:34px',
        'z-index:2147483647', 'display:flex', 'align-items:center',
        'justify-content:space-between', 'pointer-events:none',
        'background:transparent',
        '-webkit-app-region:drag', 'user-select:none',
        'transform:translateY(-100%)', 'transition:transform .18s ease', 'opacity:0'
      ].join(';');

      const left = document.createElement('div');
      left.style.cssText = '-webkit-app-region:no-drag;pointer-events:auto;display:flex;align-items:center;height:34px;gap:2px;padding-left:6px;margin-left:4px;border-radius:8px;background:rgba(10,12,18,0.55);';
      const menuBtn = document.createElement('button');
      menuBtn.title = '菜单';
      menuBtn.style.cssText = 'width:40px;height:30px;border:none;outline:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;-webkit-app-region:no-drag;';
      menuBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="' + iconStroke + '" stroke-width="1.4" stroke-linecap="round"/></svg>';
      menuBtn.addEventListener('mouseenter', () => { menuBtn.style.background = BTN_HOVER_BG; });
      menuBtn.addEventListener('mouseleave', () => { menuBtn.style.background = 'transparent'; });
      menuBtn.addEventListener('click', () => { try { ipcRenderer.send('app-popup-menu'); } catch (_) {} });
      left.appendChild(menuBtn);

      const btns = document.createElement('div');
      btns.style.cssText = '-webkit-app-region:no-drag;pointer-events:auto;display:flex;align-items:center;height:34px;gap:2px;padding-right:6px;margin-right:4px;border-radius:8px;background:rgba(10,12,18,0.55);';
      const mkBtn = (id, svg, hoverBg, onClick) => {
        const b = document.createElement('button');
        b.id = id;
        b.title = id === 'fnos-tb-min' ? '最小化' : id === 'fnos-tb-max' ? '最大化/还原' : '关闭';
        b.style.cssText = 'width:40px;height:30px;border:none;outline:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;-webkit-app-region:no-drag;';
        b.innerHTML = svg;
        b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
        b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
        b.addEventListener('click', onClick);
        return b;
      };
      const minBtn = mkBtn('fnos-tb-min',
        '<svg width="13" height="13" viewBox="0 0 16 16"><path d="M3 8H13" stroke="' + iconStroke + '" stroke-width="1.4" stroke-linecap="round"/></svg>',
        BTN_HOVER_BG, () => { try { ipcRenderer.send('window-minimize'); } catch (_) {} });
      const maxBtn = mkBtn('fnos-tb-max',
        '<svg width="13" height="13" viewBox="0 0 16 16"><rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.4" fill="none" stroke="' + iconStroke + '" stroke-width="1.4"/></svg>',
        BTN_HOVER_BG, () => { try { ipcRenderer.send('window-maximize'); } catch (_) {} });
      const closeBtn = mkBtn('fnos-tb-close',
        '<svg width="13" height="13" viewBox="0 0 16 16"><path d="M4 4L12 12M12 4L4 12" stroke="' + iconStroke + '" stroke-width="1.4" stroke-linecap="round"/></svg>',
        CLOSE_HOVER_BG, () => { try { ipcRenderer.send('window-close'); } catch (_) {} });

      bar.addEventListener('dblclick', (ev) => { if (ev.target === bar || ev.target === btns) { try { ipcRenderer.send('window-maximize'); } catch (_) {} } });
      btns.appendChild(minBtn); btns.appendChild(maxBtn); btns.appendChild(closeBtn);
      bar.appendChild(left); bar.appendChild(btns);
      (document.body || document.documentElement).appendChild(bar);

      // 自动显隐
      let hideTimer = null;
      const showBar = () => { try { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } bar.style.transform = 'translateY(0)'; bar.style.opacity = '1'; bar.style.pointerEvents = 'auto'; } catch (_) {} };
      const hideBar = () => { try { if (bar.__menuOpen || bar.__hover) return; bar.style.transform = 'translateY(-100%)'; bar.style.opacity = '0'; bar.style.pointerEvents = 'none'; } catch (_) {} };
      const scheduleHide = (d) => { try { if (hideTimer) clearTimeout(hideTimer); hideTimer = setTimeout(() => { hideTimer = null; hideBar(); }, d || 350); if (hideTimer.unref) hideTimer.unref(); } catch (_) {} };
      bar.addEventListener('mouseenter', () => { bar.__hover = true; showBar(); });
      bar.addEventListener('mouseleave', () => { bar.__hover = false; scheduleHide(300); });
      menuBtn.addEventListener('click', () => { try { bar.__menuOpen = true; setTimeout(() => { bar.__menuOpen = false; scheduleHide(400); }, 1500); } catch (_) {} });

      const hot = document.createElement('div');
      hot.style.cssText = 'position:fixed;top:0;left:0;right:0;height:8px;z-index:2147483646;pointer-events:auto;-webkit-app-region:drag;user-select:none;';
      hot.addEventListener('mouseenter', showBar);
      hot.addEventListener('mouseleave', () => scheduleHide(300));
      // v1.51.0：移除全局 capture mousemove（卡顿源），显隐由热区/标题栏 hover 事件驱动。
      (document.body || document.documentElement).appendChild(hot);
    }

    const start = () => { try { buildBar(); } catch (_) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) { try { ipcRenderer.invoke('diag:log', 'live titlebar inject ex: ' + String(e && e.message || e)); } catch (_) {} }
})();
