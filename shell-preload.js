// shell.html (主窗口玻璃外壳) 的 preload —— 仅暴露安全的标题栏/菜单/导航 IPC。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnosShell', {
  // 窗口控制
  minimize: () => ipcRenderer.invoke('shell:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('shell:toggle-maximize'),
  close: () => ipcRenderer.invoke('shell:close'),
  // 主进程 → 渲染进程
  onTitle: (cb) => {
    const h = (_e, t) => cb(t);
    ipcRenderer.on('shell:title', h);
    return () => ipcRenderer.removeListener('shell:title', h);
  },
  onMaximized: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('shell:maximized', h);
    return () => ipcRenderer.removeListener('shell:maximized', h);
  },
  onNavigate: (cb) => {
    const h = (_e, url) => cb(url);
    ipcRenderer.on('shell:navigate', h);
    return () => ipcRenderer.removeListener('shell:navigate', h);
  },
  onLoadFile: (cb) => {
    const h = (_e, u) => cb(u);
    ipcRenderer.on('shell:load-file', h);
    return () => ipcRenderer.removeListener('shell:load-file', h);
  },
  onOpen: (cb) => {
    const h = (_e, target) => cb(target);
    ipcRenderer.on('shell:open', h);
    return () => ipcRenderer.removeListener('shell:open', h);
  },
  onTheme: (cb) => {
    const h = (_e, theme) => cb(theme);
    ipcRenderer.on('shell:theme', h);
    return () => ipcRenderer.removeListener('shell:theme', h);
  },
  // 弹出原生菜单（在对应菜单按钮坐标处弹出，复用主进程模板）
  popupMenu: (payload) => ipcRenderer.invoke('shell:popup-menu', payload),
});
