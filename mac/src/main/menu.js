'use strict';

/**
 * 原生菜单栏（macOS 规范）
 *  - 首个菜单为应用菜单（FNOS）：关于 / 检查更新 / 偏好设置 Cmd+, / 服务 / 隐藏 / 退出
 *  - 编辑、窗口菜单使用系统 role，保证撤销重做、最小化、缩放等行为与系统一致
 *  - 所有自定义项都通过 handlers 回调，不在此处直接触碰窗口对象
 */

const { Menu, app } = require('electron');

let lastHandlers = null;

const isDev = () => !app.isPackaged;

function buildTemplate(h) {
  const on = (fn) => () => {
    try { fn(); } catch (_) {}
  };

  const appMenu = {
    label: app.name || 'FNOS',
    submenu: [
      { role: 'about', label: '关于 FNOS' },
      { label: '检查更新…', click: on(h.checkUpdate) },
      { type: 'separator' },
      { label: '偏好设置…', accelerator: 'Command+,', click: on(h.openSettings) },
      { type: 'separator' },
      { role: 'services', label: '服务', submenu: [] },
      { type: 'separator' },
      { role: 'hide', label: '隐藏 FNOS' },
      { role: 'hideOthers', label: '隐藏其他' },
      { role: 'unhide', label: '全部显示' },
      { type: 'separator' },
      { role: 'quit', label: '退出 FNOS' }
    ]
  };

  const fileMenu = {
    label: '文件',
    submenu: [
      { label: '连接新服务器…', accelerator: 'Command+N', click: on(h.connectNew) },
      { label: '回到上次页面', accelerator: 'Command+Shift+L', click: on(h.goLast) },
      { type: 'separator' },
      { label: '重新载入', accelerator: 'Command+R', click: on(h.reload) },
      { label: '强制重新载入', accelerator: 'Command+Shift+R', click: on(h.forceReload) },
      { type: 'separator' },
      { role: 'close', label: '关闭窗口' }
    ]
  };

  const editMenu = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '拷贝' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
      { role: 'delete', label: '删除' },
      { role: 'selectAll', label: '全选' },
      { type: 'separator' },
      { label: '在页面中查找…', accelerator: 'Command+F', click: on(h.findInPage) }
    ]
  };

  const viewMenu = {
    label: '显示',
    submenu: [
      { label: '放大', accelerator: 'Command+=', click: on(h.zoomIn) },
      { label: '缩小', accelerator: 'Command+-', click: on(h.zoomOut) },
      { label: '实际大小', accelerator: 'Command+0', click: on(h.zoomReset) },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '进入全屏幕' },
      { type: 'separator' },
      { label: '显示／隐藏工具栏', accelerator: 'Command+Alt+T', click: on(h.toggleToolbar) },
      { label: '自定义外观…', click: on(h.openSettings) },
      { type: 'separator' },
      {
        label: '开发者',
        submenu: [
          { role: 'reload', label: '重新载入壳页' },
          { role: 'toggleDevTools', label: '切换开发者工具' },
          { type: 'separator' },
          { label: '打开页面调试器', click: on(h.openGuestDevTools) }
        ]
      }
    ]
  };

  const goMenu = {
    label: '前往',
    submenu: [
      { label: '后退', accelerator: 'Command+[', click: on(h.goBack) },
      { label: '前进', accelerator: 'Command+]', click: on(h.goForward) },
      { label: '主页', accelerator: 'Command+Shift+H', click: on(h.goHome) },
      { type: 'separator' },
      { label: '切换服务器…', accelerator: 'Command+Shift+S', click: on(h.switchServer) }
    ]
  };

  const windowMenu = {
    label: '窗口',
    role: 'windowMenu',
    submenu: [
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: '缩放' },
      { type: 'separator' },
      { label: '主窗口', accelerator: 'Command+1', click: on(h.focusMain) },
      { label: '偏好设置', accelerator: 'Command+2', click: on(h.openSettings) },
      { type: 'separator' },
      { role: 'front', label: '前置全部窗口' }
    ]
  };

  const helpMenu = {
    label: '帮助',
    role: 'help',
    submenu: [
      { label: 'FNOS 客户端使用说明', click: on(h.openReadme) },
      { label: '打开日志文件夹', click: on(h.openLogs) },
      { label: '打开配置文件夹', click: on(h.openConfig) },
      { type: 'separator' },
      { label: '项目主页', click: on(h.openWebsite) },
      { type: 'separator' },
      { label: '诊断信息（复制到剪贴板）', click: on(h.copyDiagnostics) }
    ]
  };

  const template = [appMenu, fileMenu, editMenu, viewMenu, goMenu, windowMenu, helpMenu];

  if (isDev()) {
    // 开发期额外暴露壳页调试入口
    viewMenu.submenu.push({ type: 'separator' }, { role: 'forceReload', label: '强制重载壳页' });
  }

  return template;
}

function build(handlers) {
  lastHandlers = handlers || lastHandlers || {};
  const menu = Menu.buildFromTemplate(buildTemplate(lastHandlers));
  Menu.setApplicationMenu(menu);
  return menu;
}

function rebuild() {
  if (lastHandlers) build(lastHandlers);
}

module.exports = { build, rebuild };
