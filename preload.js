'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 安全地暴露给登录页/渲染页面使用。
// 所有 IPC 通道统一为 auth: 前缀，与 main.js 保持一致。
contextBridge.exposeInMainWorld('fnos', {
  // 连接服务器（服务器地址、FN ID、域名、IP）
  connect: (server) => ipcRenderer.invoke('auth:connect', { server }),
  // 读取最近成功连接的服务器 + 历史列表
  loadLastServer: () => ipcRenderer.invoke('auth:load-history'),
  // 返回连接页（切换服务器）
  backToConnect: () => ipcRenderer.invoke('auth:back-to-connect'),
  // 删除一条历史（传入 partition 字符串）
  removeHistory: (partition) => ipcRenderer.invoke('auth:remove-history', { partition }),
  platform: process.platform,
  version: '1.10.3'
});
