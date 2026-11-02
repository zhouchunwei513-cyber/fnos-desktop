'use strict';

/**
 * 菜单栏状态项（Status Item / Tray）
 *  - 使用 template 图（仅 alpha 生效，系统自动适配浅色/深色菜单栏）
 *  - 菜单：显示窗口 / 偏好设置 / 服务器切换 / 检查更新 / 关于 / 退出
 *  - macOS 惯例：点击图标弹出菜单（不直接 toggle 窗口）
 */

const path = require('path');
const { Tray, Menu, app, nativeImage } = require('electron');
const store = require('./store');
const logger = require('./logger');

let tray = null;
let handlers = null;

function templateImage() {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png'),
    path.join(__dirname, '..', '..', 'assets', 'fnos-logo.png')
  ];
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        const sized = img.resize({ width: 18, height: 18, quality: 'best' });
        sized.setTemplateImage(true);
        return sized;
      }
    } catch (_) {}
  }
  return nativeImage.createEmpty();
}

function buildMenu() {
  const h = handlers || {};
  const s = store.get();
  const servers = s.servers || [];

  const serverItems = servers.length
    ? servers.map((sv) => ({
      label: (sv.url === s.activeServer ? '✓ ' : '   ') + (sv.name || sv.url),
      click: () => { try { h.switchServer(sv.url); } catch (_) {} }
    }))
    : [{ label: '未添加服务器', enabled: false }];

  const menu = Menu.buildFromTemplate([
    { label: '显示 FNOS', click: () => { try { h.showMain(); } catch (_) {} } },
    { type: 'separator' },
    { label: '偏好设置…', click: () => { try { h.openSettings(); } catch (_) {} } },
    { label: '重新载入', click: () => { try { h.reload(); } catch (_) {} } },
    { type: 'separator' },
    { label: '服务器', submenu: serverItems },
    { type: 'separator' },
    { label: '检查更新…', click: () => { try { h.checkUpdate(); } catch (_) {} } },
    { label: '关于 FNOS', click: () => { try { h.about(); } catch (_) {} } },
    { type: 'separator' },
    { label: '退出 FNOS', accelerator: 'Command+Q', click: () => { try { h.quit(); } catch (_) {} } }
  ]);

  return menu;
}

function refresh() {
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.setContextMenu(buildMenu());
  } catch (e) {
    logger.warn('tray', 'setContextMenu failed: ' + (e && e.message));
  }
}

function create(h) {
  handlers = h || {};
  if (tray && !tray.isDestroyed()) {
    refresh();
    return tray;
  }
  try {
    tray = new Tray(templateImage());
    tray.setToolTip('FNOS');
    tray.setIgnoreDoubleClickEvents(true);
    refresh();
    logger.info('tray', 'status item created');
  } catch (e) {
    logger.error('tray', 'create failed: ' + (e && e.message));
    tray = null;
  }
  return tray;
}

function destroy() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

module.exports = { create, refresh, destroy, get: () => tray };
