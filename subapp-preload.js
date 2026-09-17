/**
 * 子应用 preload 脚本 - v2.0.0
 * 安全隔离：contextBridge 桥接 API，暴露 window.fnApi
 * nodeIntegration: false, contextIsolation: true
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnApi', {
  /**
   * 获取已安装的子应用列表
   * @returns {Promise<{success:boolean, msg:string, data:Array}>}
   */
  getInstalledApps: () => {
    console.log('[fnApi] getInstalledApps called');
    return ipcRenderer.invoke('get-installed-apps');
  },

  /**
   * 安装 NAS 子应用
   * @param {Object} payload - { appId, appName, iconData(base64), iconExt, nasAddress }
   * @returns {Promise<{success:boolean, msg:string, data:Object}>}
   */
  installNasApp: (payload) => {
    console.log('[fnApi] installNasApp called', payload);
    return ipcRenderer.invoke('install-nas-app', payload);
  },

  /**
   * 卸载 NAS 子应用
   * @param {Object} payload - { appId }
   * @returns {Promise<{success:boolean, msg:string, data:null}>}
   */
  uninstallNasApp: (payload) => {
    console.log('[fnApi] uninstallNasApp called', payload);
    return ipcRenderer.invoke('uninstall-nas-app', payload);
  },

  /**
   * 创建桌面快捷方式
   * @param {Object} payload - { appId, appName, iconPath, nasAddress }
   * @returns {Promise<{success:boolean, msg:string, data:Object}>}
   */
  createDesktopShortcut: (payload) => {
    console.log('[fnApi] createDesktopShortcut called', payload);
    return ipcRenderer.invoke('create-desktop-shortcut', payload);
  },
});
