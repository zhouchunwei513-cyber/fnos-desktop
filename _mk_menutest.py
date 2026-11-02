# -*- coding: utf-8 -*-
import io, os
os.makedirs('_menutest', exist_ok=True)

MAIN = r"""
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const items = [
  { t: 'sub', id: 'm0', label: '文件', enabled: true, items: [
    { t: 'cmd', id: 'm1', label: '返回 FNOS 主页', accel: 'Alt+H', enabled: true },
    { t: 'sub', id: 'm2', label: '切换账号', enabled: true, items: [
      { t: 'cmd', id: 'm3', label: '● 家庭 NAS', accel: '', enabled: true },
      { t: 'cmd', id: 'm4', label: '  公司 NAS', accel: '', enabled: true },
      { t: 'sep' },
      { t: 'cmd', id: 'm5', label: '登录其它账号…', accel: '', enabled: true }
    ]},
    { t: 'sep' },
    { t: 'sub', id: 'm6', label: '切换窗口', enabled: true, items: [
      { t: 'cmd', id: 'm7', label: '（暂无后台运行的程序）', accel: '', enabled: false }
    ]},
    { t: 'sep' },
    { t: 'cmd', id: 'm8', label: '一键隐藏 / 呼出  (Ctrl+Alt+H)', accel: '', enabled: true },
    { t: 'sep' },
    { t: 'cmd', id: 'm9', label: '最小化', accel: 'Ctrl+M', enabled: true },
    { t: 'cmd', id: 'm10', label: '隐藏到托盘', accel: '', enabled: true },
    { t: 'cmd', id: 'm11', label: '关闭', accel: 'Ctrl+W', enabled: true }
  ]},
  { t: 'sub', id: 'm12', label: '下载', enabled: true, items: [
    { t: 'cmd', id: 'm13', label: '（暂无正在进行的下载）', accel: '', enabled: false }
  ]},
  { t: 'sub', id: 'm14', label: '视图', enabled: true, items: [
    { t: 'cmd', id: 'm15', label: '返回上一页', accel: 'Alt+Left', enabled: true },
    { t: 'cmd', id: 'm16', label: '刷新', accel: 'F5', enabled: true },
    { t: 'sep' },
    { t: 'cmd', id: 'm17', label: '重置缩放', accel: 'Ctrl+0', enabled: true }
  ]},
  { t: 'sub', id: 'm18', label: '工具', enabled: true, items: [
    { t: 'cmd', id: 'm19', label: '📺 电视直播（原生播放器）', accel: '', enabled: true },
    { t: 'sep' },
    { t: 'cmd', id: 'm20', label: '🎬 用 MPV 嵌入播放当前视频（兼容 HEVC/4K/MKV）', accel: 'Ctrl+Shift+P', enabled: true },
    { t: 'sep' },
    { t: 'cmd', id: 'm21', label: '🔗 复制当前窗口链接地址', accel: 'Ctrl+Shift+C', enabled: true }
  ]},
  { t: 'sub', id: 'm22', label: '设置', enabled: true, items: [
    { t: 'cmd', id: 'm23', label: '偏好设置…', accel: 'Ctrl+,', enabled: true }
  ]},
  { t: 'sub', id: 'm24', label: '帮助', enabled: true, items: [
    { t: 'cmd', id: 'm25', label: '操作步骤帮助', accel: '', enabled: true }
  ]},
  { t: 'sub', id: 'm26', label: '关于', enabled: true, items: [
    { t: 'cmd', id: 'm27', label: '关于 FNOS', accel: '', enabled: true }
  ]}
];

const theme = process.argv.includes('--dark') ? 'dark' : 'glass';
let win = null;
let size = { w: 400, h: 400 };

function shot(file) {
  return win.webContents.capturePage().then((img) => {
    fs.writeFileSync(path.join(__dirname, file), img.toPNG());
    console.log('SHOT', file);
  });
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 400, height: 400, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', hasShadow: false, resizable: false, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'menu-popup-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'menu-popup.html'));
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('fnmenu:data', { items: items, theme: theme });
  });
});

ipcMain.on('fnmenu:ready', (_e, s) => {
  size = { w: Math.round(s.w), h: Math.round(s.h) };
  console.log('READY', JSON.stringify(size));
  win.setBounds({ x: 40, y: 40, width: size.w, height: size.h });
  win.showInactive();
  // 模拟桌面壁纸，便于判断玻璃底的可读性
  win.webContents.executeJavaScript(
    "document.body.classList.contains('glass') ? (document.body.style.background='linear-gradient(135deg,#6b5138,#2a3550 60%,#141a26)') : null;"
  ).catch(() => {});
  setTimeout(async () => {
    await shot('shot_base_' + theme + '.png');
    // 展开第一个子菜单
    await win.webContents.executeJavaScript(
      "(function(){var it=document.querySelector('.panel[data-level=\"0\"] .item'); it.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); return true;})();"
    ).catch(() => {});
    setTimeout(async () => {
      await win.webContents.executeJavaScript(
        "(function(){var p=document.querySelectorAll('.panel[data-level=\"1\"]')[0]; var it=p.querySelector('.item'); it.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); return true;})();"
      ).catch(() => {});
      setTimeout(async () => {
        await shot('shot_sub_' + theme + '.png');
        console.log('DONE');
        app.quit();
      }, 400);
    }, 400);
  }, 500);
});

setTimeout(() => { console.log('TIMEOUT'); app.quit(); }, 15000);
"""

io.open('_menutest/main.js', 'w', encoding='utf-8').write(MAIN)
print('written')
