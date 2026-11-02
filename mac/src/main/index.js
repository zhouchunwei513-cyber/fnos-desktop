'use strict';

/**
 * FNOS for macOS — 主进程入口
 * macOS 规范落点：
 *  - 单一实例；关闭窗口不退出（Dock 常驻）；点 Dock 图标恢复窗口
 *  - 应用菜单 / 窗口菜单 / 编辑菜单走系统原生 role
 *  - 日志写 ~/Library/Logs/FNOS
 *  - 关于面板使用系统标准面板（app.showAboutPanel）
 *  - 自启动使用 SMAppService 底层（app.setLoginItemSettings）
 */

const path = require('path');
const os = require('os');
const { app, nativeTheme, globalShortcut, shell, dialog } = require('electron');

app.setName('FNOS');

const logger = require('./logger');
const store = require('./store');
const nav = require('./nav');
const windows = require('./windows');
const menu = require('./menu');
const tray = require('./tray');
const updater = require('./updater');
const ipc = require('./ipc');

const isDev = !app.isPackaged;
let appReady = false;

// ---------- 日志目录（macOS: ~/Library/Logs/FNOS）----------
try {
  app.setAppLogsPath();
  logger.init(app.getPath('logs'));
} catch (e) {
  logger.init(path.join(app.getPath('userData'), 'logs'));
}

process.on('uncaughtException', (e) => {
  logger.error('main', 'uncaughtException: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  logger.error('main', 'unhandledRejection: ' + (e && e.stack ? e.stack : e));
});

// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    windows.showMain();
  });

  // ---------- 自签名证书：仅放行已保存的 NAS 主机 ----------
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    try {
      const host = new URL(url).hostname;
      const allowed = nav.allowedHostnames(store.get().servers);
      if (nav.hostMatches(host, allowed)) {
        logger.warn('tls', 'accepted certificate for ' + host + ' (' + error + ')');
        event.preventDefault();
        callback(true);
        return;
      }
    } catch (_) {}
    callback(false);
  });

  // ---------- 菜单/托盘动作 ----------
  const actions = {
    showMain: () => windows.showMain(),
    focusMain: () => windows.showMain(),
    openSettings: () => windows.createSettingsWindow(),
    reload: () => ipc.sendCommand('reload'),
    forceReload: () => ipc.sendCommand('force-reload'),
    goBack: () => ipc.sendCommand('back'),
    goForward: () => ipc.sendCommand('forward'),
    goHome: () => ipc.sendCommand('home'),
    goLast: () => {
      const last = store.get().lastUrl || store.get().activeServer;
      if (last) ipc.sendCommand('goto', { url: last, force: true });
    },
    connectNew: () => {
      windows.showMain();
      ipc.sendCommand('connect-new');
    },
    switchServer: (url) => {
      if (url) {
        store.upsertServer(url, nav.serverLabel(url));
        ipc.sendCommand('goto', { url, force: true });
      } else {
        ipc.sendCommand('switch-server');
      }
      tray.refresh();
    },
    zoomIn: () => ipc.sendCommand('zoom-step', { step: 1 }),
    zoomOut: () => ipc.sendCommand('zoom-step', { step: -1 }),
    zoomReset: () => ipc.sendCommand('zoom-step', { step: 0 }),
    toggleToolbar: () => ipc.sendCommand('toggle-toolbar'),
    findInPage: () => ipc.sendCommand('find'),
    openGuestDevTools: () => ipc.sendCommand('guest-devtools'),
    checkUpdate: () => { updater.check({ silent: false }).catch(() => {}); },
    about: () => app.showAboutPanel(),
    quit: () => app.quit(),
    openLogs: () => {
      const dir = logger.getDir();
      if (dir) shell.openPath(dir).catch(() => {});
    },
    openConfig: () => {
      shell.openPath(app.getPath('userData')).catch(() => {});
    },
    openReadme: () => openRepo('mac/README.md'),
    openWebsite: () => openRepo(''),
    copyDiagnostics: () => {
      const s = store.get();
      const text = [
        'FNOS macOS ' + app.getVersion(),
        'Electron ' + process.versions.electron + ' / Chrome ' + process.versions.chrome,
        'macOS ' + os.release() + ' (' + process.arch + ')',
        'userData: ' + app.getPath('userData'),
        'logs: ' + logger.getDir(),
        'servers: ' + (s.servers.map((x) => x.url).join(', ') || '(none)'),
        'active: ' + (s.activeServer || '-'),
        'material: ' + s.appearance.material + ' / alpha ' + s.appearance.uiAlpha,
        'theme: ' + s.appearance.theme,
        'zoom: ' + s.zoom
      ].join('\n');
      require('electron').clipboard.writeText(text);
    }
  };

  function openRepo(sub) {
    const info = updater.repoInfo();
    if (!info) {
      shell.openExternal('https://github.com').catch(() => {});
      return;
    }
    const base = 'https://github.com/' + info.owner + '/' + info.repo;
    const target = sub ? base + '/blob/main/' + sub : base;
    shell.openExternal(target).catch(() => {});
  }

  function setupDock() {
    if (!app.dock) return;
    try {
      const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch (_) {}
  }

  function applyLoginItem(settings) {
    const want = !!(settings && settings.behavior && settings.behavior.launchAtLogin);
    try {
      const isDevMode = isDev;
      app.setLoginItemSettings({
        openAtLogin: want,
        openAsHidden: true,
        path: process.execPath,
        args: isDevMode ? [path.join(__dirname, '..', '..')] : []
      });
    } catch (e) {
      logger.warn('lifecycle', 'setLoginItemSettings failed: ' + (e && e.message));
    }
  }

  function registerGlobalHotkey() {
    try { globalShortcut.unregisterAll(); } catch (_) {}
    const accel = (store.get().behavior && store.get().behavior.globalHotkey) || '';
    if (!accel) return;
    try {
      const okReg = globalShortcut.register(accel, () => {
        windows.toggleMainVisibility();
      });
      if (!okReg) logger.warn('hotkey', 'register failed: ' + accel);
      else logger.info('hotkey', 'registered: ' + accel);
    } catch (e) {
      logger.warn('hotkey', 'register error: ' + (e && e.message));
    }
  }

  // ---------- 生命周期 ----------
  app.whenReady().then(() => {
    appReady = true;
    logger.info('lifecycle', 'app ready v' + app.getVersion() + ' electron ' + process.versions.electron + ' macOS ' + os.release());

    app.setAboutPanelOptions({
      applicationName: 'FNOS',
      applicationVersion: app.getVersion(),
      version: 'Electron ' + process.versions.electron,
      copyright: '© ' + new Date().getFullYear() + ' FNOS Desktop',
      credits: '飞牛 NAS 桌面客户端 · macOS 版',
      authors: ['FNOS Desktop']
    });

    nativeTheme.themeSource = store.get().appearance.theme;

    ipc.register();
    menu.build(actions);
    windows.createMainWindow();
    tray.create({
      showMain: actions.showMain,
      openSettings: actions.openSettings,
      reload: actions.reload,
      switchServer: (url) => actions.switchServer(url),
      checkUpdate: actions.checkUpdate,
      about: actions.about,
      quit: actions.quit
    });
    setupDock();
    applyLoginItem(store.get());
    registerGlobalHotkey();
    updater.scheduleDailyCheck();

    app.on('activate', () => {
      if (windows.getMainWindow()) windows.showMain();
      else windows.createMainWindow();
    });

    // 外观变化（跟随系统）时通知渲染层
    nativeTheme.on('updated', () => {
      windows.broadcast('shell:system-theme', {
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      });
    });

    // 设置变更后同步自启动与快捷键
    const { ipcMain } = require('electron');
    ipcMain.on('settings:applied', () => {
      applyLoginItem(store.get());
      registerGlobalHotkey();
      tray.refresh();
    });
  });

  app.on('before-quit', () => {
    windows.markQuitting();
    try { globalShortcut.unregisterAll(); } catch (_) {}
    logger.info('lifecycle', 'before-quit');
  });

  app.on('will-quit', () => {
    tray.destroy();
    logger.close();
  });

  // macOS：关闭所有窗口不退出应用
  app.on('window-all-closed', () => {
    // 保持驻留；仅当用户在设置里要求"退出"时由菜单触发 app.quit()
  });

  app.on('quit', () => {
    logger.info('lifecycle', 'quit');
  });
}
