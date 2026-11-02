# -*- coding: utf-8 -*-
import io

MAIN = 'main.js'
s = io.open(MAIN, encoding='utf-8', newline='').read()
fails = []

BLOCK = r"""
// ===================== v3.0.64：自绘应用菜单（玻璃 / 深色两套皮） =====================
// 背景：☰ 下拉菜单此前是 Windows 原生菜单（Menu.popup），系统绘制，圆角/透明/配色都改不了。
// 这里改成自绘：主进程把原生模板序列化成 JSON → 独立透明子窗渲染 → 叶子项回传 id 由主进程执行。
// 皮色跟随设置里的「透明界面」开关（uiTransparent，默认开）。
let __menuPopupWin = null;
let __menuRegistry = Object.create(null);
let __menuCtxWin = null;
let __menuShownAt = 0;

const __MENU_ROLE_ACC = { minimize: 'Ctrl+M', close: 'Ctrl+W', toggleDevTools: 'Ctrl+Shift+I', reload: 'Ctrl+R' };

function __menuAccelText(it) {
  try {
    let a = (it && it.accelerator) ? String(it.accelerator) : '';
    if (!a && it && it.role) a = __MENU_ROLE_ACC[it.role] || '';
    if (!a) return '';
    return a
      .replace(/CommandOrControl|CmdOrCtrl/g, process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
      .replace(/Command/g, 'Cmd')
      .replace(/Control/g, 'Ctrl');
  } catch (_) { return ''; }
}

// 把 Menu 结构转成可 JSON 的节点数组，并把 MenuItem 实例存进 registry（id → MenuItem）
function __serializeMenu(menu, registry, ctr, out) {
  const items = (menu && menu.items) ? menu.items : [];
  for (const it of items) {
    try {
      if (!it || it.visible === false) continue;
      if (it.type === 'separator') { out.push({ t: 'sep' }); continue; }
      const id = 'm' + (ctr.n++);
      if (it.submenu && it.submenu.items && it.submenu.items.length) {
        const child = [];
        __serializeMenu(it.submenu, registry, ctr, child);
        if (!child.length) continue;
        registry[id] = it;
        out.push({
          t: 'sub', id: id,
          label: it.label == null ? '' : String(it.label),
          enabled: it.enabled !== false,
          items: child,
        });
      } else {
        registry[id] = it;
        out.push({
          t: (it.type === 'checkbox' || it.type === 'radio') ? it.type : 'cmd',
          id: id,
          label: it.label == null ? '' : String(it.label),
          accel: __menuAccelText(it),
          enabled: it.enabled !== false,
          checked: it.checked === true,
        });
      }
    } catch (_) {}
  }
  return out;
}

function __closeMenuPopupWindow() {
  const w = __menuPopupWin;
  __menuPopupWin = null;
  __menuRegistry = Object.create(null);
  if (w && !w.isDestroyed()) { try { w.destroy(); } catch (_) {} }
}

// 菜单关闭后的收尾（等价于原生菜单 popup 的 callback）
function __afterAppMenuClosed() {
  __mpvMenuOpening = false;
  try { refreshMpvLayer(); } catch (_) {}
  try {
    for (const surf of mpvSurfaces.values()) {
      try {
        if (!surf || surf._dead || (surf.isAlive && !surf.isAlive())) continue;
        surf._applyGeometry && surf._applyGeometry();
        surf._raiseMpv && surf._raiseMpv();
      } catch (_) {}
    }
  } catch (_) {}
  try { dlog('info', 'mpv.layer.menu_close', {}); } catch (_) {}
}

// 打开自绘菜单；返回 false 表示自绘不可用（调用方回退原生菜单）
function showCustomAppMenu(hostWin) {
  const registry = Object.create(null);
  let items = [];
  try {
    const menu = Menu.buildFromTemplate(buildMenuTemplate());
    items = __serializeMenu(menu, registry, { n: 0 }, []);
  } catch (err) {
    try { dlog('warn', 'menu.custom.build', { err: String(err && err.message || err) }); } catch (_) {}
    return false;
  }
  if (!items.length) return false;

  let theme = 'glass';
  try { const st = loadSettings(); if (st && st.uiTransparent === false) theme = 'dark'; } catch (_) {}

  __closeMenuPopupWindow();
  __menuRegistry = registry;
  __menuCtxWin = (hostWin && !hostWin.isDestroyed()) ? hostWin : null;
  __mpvMenuOpening = true;
  try { _applyMpvLayer(true, 'app-menu-open'); } catch (_) {}

  let win = null;
  try {
    win = new BrowserWindow({
      width: 320, height: 420,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      roundedCorners: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'menu-popup-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
  } catch (err) {
    try { dlog('warn', 'menu.custom.win', { err: String(err && err.message || err) }); } catch (_) {}
    __mpvMenuOpening = false;
    try { _applyMpvLayer(false, 'app-menu-open-fail'); } catch (_) {}
    return false;
  }

  win.__isMenuPopup = true;
  __menuPopupWin = win;
  try { win.setMenuBarVisibility(false); } catch (_) {}
  try { win.setAlwaysOnTop(true, 'pop-up-menu'); } catch (_) {}
  win.loadFile(path.join(__dirname, 'menu-popup.html')).catch(() => {});
  win.webContents.once('did-finish-load', () => {
    try { win.webContents.send('fnmenu:data', { items: items, theme: theme }); } catch (_) {}
  });
  // 失焦即关（等价原生菜单点外面关）；__menuShownAt 前 150ms 的不算，避免开窗瞬间自己吃掉
  win.on('blur', () => {
    if (__menuPopupWin !== win) return;
    if (Date.now() - __menuShownAt < 150) return;
    __closeMenuPopupWindow();
    __afterAppMenuClosed();
  });
  win.on('closed', () => { if (__menuPopupWin === win) __menuPopupWin = null; });
  // 兜底：2 秒内没收到渲染层的 ready 就当作渲染失败，收掉并让上层回退原生菜单
  setTimeout(() => {
    if (__menuPopupWin === win && !__menuShownAt) {
      __closeMenuPopupWindow();
      __afterAppMenuClosed();
    }
  }, 2000);
  return true;
}

ipcMain.on('fnmenu:ready', (e, size) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win !== __menuPopupWin || win.isDestroyed()) return;
    const w = Math.max(140, Math.min(820, Math.round((size && size.w) || 320)));
    const h = Math.max(80, Math.min(920, Math.round((size && size.h) || 320)));
    const pt = screen.getCursorScreenPoint();
    let wa = { x: 0, y: 0, width: 1920, height: 1080 };
    try { wa = screen.getDisplayNearestPoint(pt).workArea; } catch (_) {}
    let x = Math.round(pt.x - 18);
    let y = Math.round(pt.y - 18);
    if (x + w > wa.x + wa.width) x = wa.x + wa.width - w;
    if (y + h > wa.y + wa.height) y = wa.y + wa.height - h;
    if (x < wa.x) x = wa.x;
    if (y < wa.y) y = wa.y;
    win.setBounds({ x: x, y: y, width: w, height: h });
    win.show();
    win.focus();
    __menuShownAt = Date.now();
    try { dlog('info', 'menu.custom.ready', { w: w, h: h }); } catch (_) {}
  } catch (_) {}
});

ipcMain.on('fnmenu:close', (e) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win !== __menuPopupWin) return;
    __closeMenuPopupWindow();
    __afterAppMenuClosed();
  } catch (_) {}
});

ipcMain.on('fnmenu:invoke', (e, id) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win !== __menuPopupWin) return;
    const it = __menuRegistry[String(id || '')] || null;
    const host = __menuCtxWin;
    __closeMenuPopupWindow();
    __afterAppMenuClosed();
    if (!it) return;
    // 先关窗并把焦点还给宿主窗口：菜单里很多动作内部用的是 BrowserWindow.getFocusedWindow()，
    // 不还焦点就会被临时菜单窗顶掉（withWebContents / copyCurrentWindowLink 都吃这个）。
    if (host && !host.isDestroyed()) { try { host.focus(); } catch (_) {} }
    setTimeout(() => {
      try {
        if (it.type === 'checkbox') it.checked = !it.checked;
        else if (it.type === 'radio') it.checked = true;
        const role = it.role;
        const target = (host && !host.isDestroyed())
          ? host
          : (BrowserWindow.getFocusedWindow() || (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null));
        if (role === 'minimize') { if (target) target.minimize(); return; }
        if (role === 'close') { if (target) target.close(); return; }
        if (role === 'toggleDevTools') { if (target && target.webContents) target.webContents.toggleDevTools(); return; }
        if (role === 'reload') { if (target && target.webContents) target.webContents.reload(); return; }
        if (typeof it.click === 'function') it.click(it, target, {});
      } catch (err) {
        try { dlog('warn', 'menu.custom.invoke', { err: String(err && err.message || err) }); } catch (_) {}
      }
    }, 60);
  } catch (_) {}
});
// ===================== 自绘应用菜单代码结束 =====================

"""

anchor1 = "// v1.48.0：无边框标题栏的「☰ 菜单」按钮——弹出与原系统菜单栏完全一致的应用菜单"
print('anchor1 count', s.count(anchor1))
if s.count(anchor1) != 1:
    fails.append('anchor1')
s = s.replace(anchor1, BLOCK.lstrip('\n') + anchor1, 1)

anchor2 = "    menu.popup({ window: w || undefined, callback: __appMenuDone });"
print('anchor2 count', s.count(anchor2))
if s.count(anchor2) != 1:
    fails.append('anchor2')
NEW2 = (
    "    // v3.0.64：优先自绘菜单（玻璃/深色，跟随「透明界面」开关）；不可用时回退原生菜单\n"
    "    let __customMenuOk = false;\n"
    "    try { __customMenuOk = showCustomAppMenu(w || null); } catch (_) { __customMenuOk = false; }\n"
    "    if (!__customMenuOk) {\n"
    "      menu.popup({ window: w || undefined, callback: __appMenuDone });\n"
    "    }"
)
s = s.replace(anchor2, NEW2, 1)

io.open(MAIN, 'w', encoding='utf-8', newline='').write(s)
print('FAILS', fails)
