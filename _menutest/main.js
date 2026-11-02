const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const items = [
  { t: 'sub', id: 'm0', label: '文件', enabled: true, items: [
    { t: 'cmd', id: 'm1', label: '返回 FNOS 主页', accel: 'Alt+H', enabled: true },
    { t: 'sub', id: 'm2', label: '切换账号', enabled: true, items: [
      { t: 'cmd', id: 'm3', label: '家庭 NAS', accel: '', enabled: true },
      { t: 'cmd', id: 'm4', label: '公司 NAS', accel: '', enabled: true },
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

function shot(file) {
  return win.webContents.capturePage().then((img) => {
    fs.writeFileSync(path.join(__dirname, file), img.toPNG());
    console.log('SHOT', file);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

ipcMain.on('fnmenu:ready', async (_e, s) => {
  win.setBounds({ x: 40, y: 40, width: Math.round(s.w), height: Math.round(s.h) });
  win.showInactive();
  win.webContents.executeJavaScript(
    "if(document.body.classList.contains('glass')){document.body.style.background='linear-gradient(135deg,#7a6a52,#2a3550 55%,#101622)';}else{document.body.style.background='linear-gradient(135deg,#8792a8,#5b6478 55%,#3d4454)';}"
  ).catch(() => {});
  await sleep(450);
  await shot('shot_base_' + theme + '.png');

  const diag1 = await win.webContents.executeJavaScript(`
    (function(){
      var base = document.querySelector('.panel[data-level="0"]');
      base.querySelectorAll('.item')[0].dispatchEvent(new MouseEvent('mouseenter'));
      var lv1 = document.querySelector('.panel[data-level="1"]');
      return { disp: lv1 && lv1.style.display, left: lv1 && lv1.style.left, top: lv1 && lv1.style.top, ow: lv1 && lv1.offsetWidth };
    })();
  `).catch((e) => ({ err: String(e) }));
  console.log('DIAG1', JSON.stringify(diag1));
  await sleep(300);
  await shot('shot_sub_' + theme + '.png');

  const diag2 = await win.webContents.executeJavaScript(`
    (function(){
      var lv1 = document.querySelector('.panel[data-level="1"]');
      var subRow = lv1.children[1];
      subRow.dispatchEvent(new MouseEvent('mouseenter'));
      var lv2 = lv1.children[1].__child;
      return { label: subRow.textContent, disp: lv2 && lv2.style.display, left: lv2 && lv2.style.left, top: lv2 && lv2.style.top, ow: lv2 && lv2.offsetWidth, oh: lv2 && lv2.offsetHeight };
    })();
  `).catch((e) => ({ err: String(e) }));
  console.log('DIAG2', JSON.stringify(diag2));
  await sleep(300);
  await shot('shot_sub2_' + theme + '.png');
  console.log('DONE');
  app.quit();
});

setTimeout(() => { console.log('TIMEOUT'); app.quit(); }, 20000);
