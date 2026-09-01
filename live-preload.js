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
