'use strict';
/**
 * 菜单（macOS）
 *  - 原生应用菜单栏（屏幕顶部）：符合 macOS 规范，应用菜单含关于/偏好设置/服务/隐藏/退出
 *  - 外壳工具栏菜单（shell.html 的 menubar）：点按钮时把对应子菜单在按钮坐标弹出，与 Windows 版一致
 *  - 菜单栏图标（Tray / 状态栏）
 */
const { Menu, Tray, app, nativeImage, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let ctx = null;
let tray = null;
let cachedIcon = null;

function init(context) {
  ctx = context || {};
  build();
}

function call(name, ...args) {
  try {
    const fn = ctx && ctx[name];
    if (typeof fn === 'function') return fn(...args);
  } catch (_) {}
  return undefined;
}

const LABEL_MAP = { file: '文件', downloads: '下载', view: '视图', tools: '工具', settings: '设置', help: '帮助' };

function acc(s, key) {
  try {
    const a = (s && s.shortcuts && s.shortcuts[key]) || '';
    // Windows 快捷键（Ctrl+…）在 mac 上转换为 Command
    return String(a).replace(/\bCtrl\b/g, 'Command');
  } catch (_) { return ''; }
}

function buildDownloadsMenu() {
  const list = call('downloadList') || [];
  if (!Array.isArray(list) || list.length === 0) {
    return [{ label: '（暂无下载任务）', enabled: false }];
  }
  return list.slice(0, 12).map((d) => ({
    label: (d.filename || '下载') + (d.pct != null ? '  ' + Math.round(d.pct) + '%' : ''),
    click: () => call('openDownloadWindow', d.id),
  }));
}

function buildTemplate() {
  const s = call('settings') || {};
  const lockAcc = acc(s, 'lockApp');
  const hideAcc = acc(s, 'hideAll');

  const appMenu = {
    label: app.name || 'FNOS',
    submenu: [
      { label: '关于 FNOS', click: () => call('openAbout') },
      { type: 'separator' },
      { label: '偏好设置…', accelerator: 'Command+,', click: () => call('openSettings') },
      { type: 'separator' },
      { role: 'services', label: '服务' },
      { type: 'separator' },
      { role: 'hide', label: '隐藏 FNOS' },
      { role: 'hideOthers', label: '隐藏其他' },
      { role: 'unhide', label: '全部显示' },
      { type: 'separator' },
      { role: 'quit', label: '退出 FNOS' },
    ],
  };

  const fileMenu = {
    label: '文件',
    submenu: [
      { label: '返回 FNOS 主页', accelerator: 'Command+Shift+H', click: () => call('goHome') },
      {
        label: '切换账号',
        submenu: (() => {
          const accts = call('accounts') || [];
          if (!accts.length) return [{ label: '（暂无已登录账号）', enabled: false }];
          return accts.map((a) => ({
            label: (a.isActive ? '● ' : '  ') + (a.label || a.origin),
            click: () => { if (!a.isActive) call('switchAccount', a.origin); },
          })).concat([
            { type: 'separator' },
            { label: '登录其它账号…', click: () => call('showConnectPage') },
          ]);
        })(),
      },
      { type: 'separator' },
      { label: '切换窗口', submenu: call('windowList') || [{ label: '（暂无后台运行的程序）', enabled: false }] },
      { type: 'separator' },
      { label: '锁定 FNOS' + (lockAcc ? '  (' + lockAcc + ')' : ''), click: () => call('lockApp') },
      { label: '一键隐藏 / 呼出' + (hideAcc ? '  (' + hideAcc + ')' : ''), click: () => call('toggleHidden') },
      { type: 'separator' },
      { role: 'close', label: '关闭窗口' },
    ],
  };

  const downloadMenu = { label: '下载', submenu: buildDownloadsMenu() };

  const viewMenu = {
    label: '视图',
    submenu: [
      { label: '返回上一页', accelerator: 'Command+[', click: () => call('navigate', 'back') },
      { label: '前进下一页', accelerator: 'Command+]', click: () => call('navigate', 'forward') },
      { type: 'separator' },
      { label: '刷新', accelerator: 'Command+R', click: () => call('navigate', 'reload') },
      { label: '强制刷新', accelerator: 'Command+Shift+R', click: () => call('navigate', 'forceReload') },
      { type: 'separator' },
      { label: '重置缩放', accelerator: 'Command+0', click: () => call('zoom', 'reset') },
      { label: '放大', accelerator: 'Command+=', click: () => call('zoom', 'in') },
      { label: '缩小', accelerator: 'Command+-', click: () => call('zoom', 'out') },
      { type: 'separator' },
      { label: '全屏', accelerator: 'Control+Command+F', registerAccelerator: false, click: () => call('toggleFullScreen') },
      { type: 'separator' },
      { role: 'toggleDevTools', label: '开发者工具' },
    ],
  };

  const toolsMenu = {
    label: '工具',
    submenu: [
      { label: '📺 电视直播（原生播放器）', click: () => call('openLive') },
      { type: 'separator' },
      { label: '⌨️ 键盘快捷键…', click: () => call('openSettings', 'shortcuts') },
      { type: 'separator' },
      { label: '🔗 复制当前窗口链接地址', accelerator: 'Command+Shift+C', click: () => call('copyLink') },
      { label: '📁 打开日志目录', click: () => call('openLogs') },
    ],
  };

  const settingsMenu = {
    label: '设置',
    submenu: [
      { label: '偏好设置…', accelerator: 'Command+,', click: () => call('openSettings') },
    ],
  };

  const helpMenu = {
    label: '帮助',
    submenu: [
      { label: '操作步骤帮助', click: () => call('openHelp') },
      { label: '检查更新…', click: () => call('checkUpdate') },
      { type: 'separator' },
      { label: '项目主页', click: () => call('openHomepage') },
    ],
  };

  const windowMenu = {
    label: '窗口',
    role: 'windowMenu',
    submenu: [
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: '缩放' },
      { type: 'separator' },
      { label: '隐藏到菜单栏', click: () => call('hideAllWindows') },
      { type: 'separator' },
      { role: 'front', label: '前置全部窗口' },
    ],
  };

  return [appMenu, fileMenu, downloadMenu, viewMenu, toolsMenu, settingsMenu, windowMenu, helpMenu];
}

function build() {
  try {
    const m = Menu.buildFromTemplate(buildTemplate());
    Menu.setApplicationMenu(m);
  } catch (_) {}
}

function refresh() { build(); }

/** 外壳工具栏点菜单：把对应子菜单在坐标处弹出 */
function popupAt(win, payload) {
  try {
    const id = payload && payload.id;
    const label = LABEL_MAP[id];
    if (!label) return;
    const tpl = buildTemplate();
    const top = tpl.find((x) => x.label === label);
    if (!top || !top.submenu) return;
    const sub = Menu.buildFromTemplate(top.submenu);
    const x = Number.isFinite(payload.x) ? Math.round(payload.x) : undefined;
    const y = Number.isFinite(payload.y) ? Math.round(payload.y) : undefined;
    sub.popup({ window: win || undefined, x, y, callback: () => {} });
  } catch (_) {}
}

// ───────────────────────── 菜单栏图标 ─────────────────────────
function trayIcon() {
  if (cachedIcon) return cachedIcon;
  try {
    const p = path.join(ctx.assetsDir, 'fnos-logo.png');
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p).resize({ width: 18, height: 18 });
      img.setTemplateImage(false);
      cachedIcon = img;
      return img;
    }
  } catch (_) {}
  return nativeImage.createEmpty();
}

function ensureTray() {
  if (tray) return tray;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('FNOS');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 FNOS', click: () => call('focusMain') },
      { label: '偏好设置…', click: () => call('openSettings') },
      { label: '电视直播', click: () => call('openLive') },
      { type: 'separator' },
      { label: '操作帮助', click: () => call('openHelp') },
      { label: '关于 FNOS', click: () => call('openAbout') },
      { type: 'separator' },
      { label: '退出', click: () => call('quit') },
    ]));
    tray.on('click', () => call('focusMain'));
    return tray;
  } catch (_) { return null; }
}

function destroyTray() {
  try { if (tray) { tray.destroy(); tray = null; } } catch (_) {}
}

module.exports = { init, build, refresh, popupAt, ensureTray, destroyTray, LABEL_MAP };
