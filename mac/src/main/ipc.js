'use strict';

/**
 * 主进程 IPC 注册表（macOS 版）
 * 通道命名沿用 Windows 版语义：settings / server / nav / zoom / log / update / app
 * 主进程 → 渲染层统一走 shell:command（菜单、托盘、快捷键动作下发）
 */

const { ipcMain, shell, clipboard, app, dialog, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const store = require('./store');
const nav = require('./nav');
const logger = require('./logger');
const updater = require('./updater');
const windows = require('./windows');

const WEB_ALLOWED = /^https?:\/\//i;
const DOC_ALLOWED = /^https?:\/\//i;

let wired = false;

function ok(data) { return { ok: true, data }; }
function fail(error) { return { ok: false, error: String(error) }; }

function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      logger.error('ipc', channel + ' failed: ' + (e && e.message));
      return fail(e && e.message ? e.message : e);
    }
  });
}

function currentWebContentsOwner(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function sendCommand(op, payload) {
  windows.sendToShell('shell:command', Object.assign({ op }, payload || {}));
}

function register() {
  if (wired) return;
  wired = true;

  // ---------- 应用 ----------
  safeHandle('app:bootstrap', () => ok(windows.bootstrapPayload()));
  safeHandle('app:version', () => ok({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release()
  }));
  safeHandle('app:paths', () => ok({
    userData: app.getPath('userData'),
    logs: logger.getDir(),
    downloads: app.getPath('downloads'),
    home: app.getPath('home')
  }));
  safeHandle('app:open-external', (_e, url) => {
    const s = String(url || '');
    if (!WEB_ALLOWED.test(s) && !/^mailto:/i.test(s)) return fail('bad url');
    shell.openExternal(s).catch(() => {});
    return ok(true);
  });
  safeHandle('app:reveal-path', (_e, target) => {
    const known = [app.getPath('userData'), logger.getDir(), app.getPath('downloads')];
    const p = String(target || '');
    if (!known.filter(Boolean).some((k) => path.resolve(k) === path.resolve(p))) {
      if (!known.filter(Boolean).some((k) => path.resolve(p).startsWith(path.resolve(k)))) return fail('bad path');
    }
    shell.openPath(p).catch(() => {});
    return ok(true);
  });
  safeHandle('app:copy', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return ok(true);
  });
  safeHandle('app:quit', () => {
    app.quit();
    return ok(true);
  });
  safeHandle('app:hide', () => { app.hide(); return ok(true); });

  // ---------- 设置 ----------
  safeHandle('settings:get', () => ok(store.get()));
  safeHandle('settings:patch', (_e, part) => {
    const next = store.patch(part);
    windows.applyAppearance(next);
    windows.broadcast('settings:changed', next);
    require('./tray').refresh();
    return ok(next);
  });
  safeHandle('settings:reset', () => {
    const next = store.reset();
    windows.applyAppearance(next);
    windows.broadcast('settings:changed', next);
    require('./tray').refresh();
    return ok(next);
  });
  safeHandle('settings:path', () => ok(store.getPath()));

  // ---------- 服务器 ----------
  safeHandle('server:list', () => ok(store.get().servers));
  safeHandle('server:add', async (_e, input) => {
    const r = nav.normalizeServer(input);
    if (!r.ok) return fail(r.reason || 'invalid');
    const next = store.upsertServer(r.url, nav.serverLabel(r.url));
    windows.broadcast('settings:changed', next);
    require('./tray').refresh();
    const https = nav.preferHttps(r.url);
    return ok({ url: r.url, suggestHttps: https || '' });
  });
  safeHandle('server:remove', (_e, url) => {
    const next = store.removeServer(String(url || ''));
    windows.broadcast('settings:changed', next);
    require('./tray').refresh();
    return ok(next);
  });
  safeHandle('server:switch', (_e, url) => {
    const r = nav.normalizeServer(url);
    if (!r.ok) return fail('invalid');
    store.upsertServer(r.url, nav.serverLabel(r.url));
    store.set('lastUrl', r.url);
    windows.sendToShell('shell:command', { op: 'goto', url: r.url, force: true });
    require('./tray').refresh();
    return ok(r.url);
  });
  safeHandle('server:test', async (_e, input) => {
    const r = nav.normalizeServer(input);
    if (!r.ok) return fail(r.reason || 'invalid');
    const candidates = [r.url];
    const https = nav.preferHttps(r.url);
    if (https) candidates.push(https);
    const { net } = require('electron');
    for (const target of candidates) {
      const res = await new Promise((resolve) => {
        let req;
        try {
          req = net.request({ method: 'GET', url: target, redirect: 'follow' });
        } catch (e) {
          resolve({ ok: false, error: String(e && e.message) });
          return;
        }
        req.setHeader('User-Agent', 'FNOS-mac/' + app.getVersion());
        const timer = setTimeout(() => { try { req.abort(); } catch (_) {} resolve({ ok: false, error: 'timeout' }); }, 8000);
        req.on('response', (resp) => {
          clearTimeout(timer);
          try { resp.resume(); } catch (_) {}
          resolve({ ok: resp.statusCode > 0 && resp.statusCode < 500, status: resp.statusCode, url: target });
        });
        req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e && e.message) }); });
        req.end();
      });
      if (res.ok) return ok(res);
    }
    return fail('unreachable');
  });

  // ---------- 导航 ----------
  safeHandle('nav:command', (_e, op, payload) => {
    sendCommand(String(op || ''), payload || {});
    return ok(true);
  });
  safeHandle('nav:record-url', (_e, url) => {
    const s = String(url || '');
    if (nav.isAllowedNavigation(s, store.get().servers)) store.set('lastUrl', s);
    return ok(true);
  });

  // ---------- 缩放 ----------
  safeHandle('zoom:set', (_e, value) => {
    const next = store.set('zoom', value);
    sendCommand('zoom', { value: next.zoom });
    return ok(next.zoom);
  });
  safeHandle('zoom:get', () => ok(store.get().zoom));

  // ---------- 窗口 ----------
  safeHandle('window:toggle-fullscreen', () => { windows.toggleFullScreen(); return ok(true); });
  safeHandle('window:show', () => { windows.showMain(); return ok(true); });
  safeHandle('window:hide', () => {
    const w = windows.getMainWindow();
    if (w) w.hide();
    return ok(true);
  });
  safeHandle('window:toggle-toolbar', () => { sendCommand('toggle-toolbar'); return ok(true); });

  // ---------- 偏好设置窗 ----------
  safeHandle('settings-window:open', (_e, tab) => {
    windows.createSettingsWindow();
    if (tab) {
      setTimeout(() => windows.sendToSettings('settings:goto-tab', { tab: String(tab) }), 260);
    }
    return ok(true);
  });
  safeHandle('settings-window:close', () => { windows.closeSettings(); return ok(true); });

  // ---------- 日志 ----------
  safeHandle('log:list', () => ok({ dir: logger.getDir(), files: logger.listFiles() }));
  safeHandle('log:read', (_e, name) => ok(logger.readFile(name)));
  safeHandle('log:open-folder', () => {
    const dir = logger.getDir();
    if (dir) shell.openPath(dir).catch(() => {});
    return ok(true);
  });
  safeHandle('log:write', (_e, level, scope, message, extra) => {
    const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info;
    fn(scope || 'renderer', message, extra);
    return ok(true);
  });
  safeHandle('log:save-as', async (_e, content, suggested) => {
    const w = windows.getSettingsWindow() || windows.getMainWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: '导出诊断日志',
      defaultPath: String(suggested || ('fnos-diag-' + Date.now() + '.log')),
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
    });
    if (canceled || !filePath) return ok(false);
    try {
      require('fs').writeFileSync(filePath, String(content == null ? '' : content), 'utf8');
      return ok(true);
    } catch (e) {
      return fail(e && e.message);
    }
  });

  // ---------- 更新 ----------
  safeHandle('update:check', async () => ok(await updater.check({ silent: false })));
  safeHandle('update:check-silent', async () => ok(await updater.check({ silent: true })));
  safeHandle('update:info', () => ok({
    version: app.getVersion(),
    repo: updater.repoInfo(),
    lastCheckAt: store.get().update.lastCheckAt
  }));

  // ---------- 关于 ----------
  safeHandle('about:panel', () => {
    app.showAboutPanel();
    return ok(true);
  });
  safeHandle('about:diagnostics', () => {
    const s = store.get();
    const lines = [
      'FNOS macOS ' + app.getVersion(),
      'Electron ' + process.versions.electron + ' / Chrome ' + process.versions.chrome,
      'macOS ' + require('os').release() + ' (' + process.arch + ')',
      'userData: ' + app.getPath('userData'),
      'logs: ' + logger.getDir(),
      'servers: ' + (s.servers.map((x) => x.url).join(', ') || '(none)'),
      'active: ' + (s.activeServer || '-'),
      'material: ' + s.appearance.material + ' / alpha ' + s.appearance.uiAlpha,
      'theme: ' + s.appearance.theme,
      'zoom: ' + s.zoom
    ];
    clipboard.writeText(lines.join('\n'));
    return ok(lines.join('\n'));
  });
}

module.exports = { register, sendCommand };
