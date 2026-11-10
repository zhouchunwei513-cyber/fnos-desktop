// v3.0.64：自绘应用菜单 preload（只暴露最小能力，渲染层拿不到 node/ipcRenderer 本体）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnMenu', {
  onData: (cb) => { ipcRenderer.on('fnmenu:data', (_e, d) => { try { cb(d); } catch (_) {} }); },
  // v4.0.1：主进程发现菜单尺寸异常时要求渲染层重测
  onRemeasure: (cb) => { ipcRenderer.on('fnmenu:remeasure', () => { try { cb(); } catch (_) {} }); },
  ready: (size) => ipcRenderer.send('fnmenu:ready', size),
  // v5.1.17-menu-fit：macOS 不透明菜单窗按可见面板动态贴合。用 sendSync 保证主进程扩窗完成后再摆子菜单，
  // 否则 setBounds 与视口更新异步，子菜单会被旧窗口裁一帧。
  fit: (size) => { try { return ipcRenderer.sendSync('fnmenu:fit', size); } catch (_) { return null; } },
  isMac: process.platform === 'darwin',
  invoke: (id) => ipcRenderer.send('fnmenu:invoke', id),
  close: () => ipcRenderer.send('fnmenu:close'),
  // v4.0.1：菜单自证日志（写进主进程日志，便于定位「量小了 / 窗口没起来」）
  diag: (tag, data) => ipcRenderer.send('fnmenu:diag', { tag: tag, data: data }),
});
