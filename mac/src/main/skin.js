'use strict';
/**
 * 标题栏皮肤（.fskin.zip）管理 —— macOS 实现
 *  安装：解压到 ~/Library/Application Support/FNOS/skins/<name>/
 *  manifest.json 关键字段：{ name, title, bg, horn, height, theme }
 *  macOS 上皮肤作用在窗口外壳工具栏（shell.html），不注入 NAS 页面。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, dialog, BrowserWindow } = require('electron');
const { execFile } = require('child_process');
const prefs = require('./prefs');

function skinsDir() { return path.join(app.getPath('userData'), 'skins'); }

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
  return p;
}

function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // macOS 自带 /usr/bin/unzip，无需第三方依赖
    execFile('/usr/bin/unzip', ['-o', '-qq', zipPath, '-d', destDir], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error('解压失败：' + String((stderr || err.message || '')).slice(0, 300)));
      else resolve(true);
    });
  });
}

function readManifest(dir) {
  // manifest 可能在根，也可能在一层子目录里
  const candidates = [path.join(dir, 'manifest.json')];
  try {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isDirectory()) candidates.push(path.join(p, 'manifest.json')); } catch (_) {}
    }
  } catch (_) {}
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const m = JSON.parse(fs.readFileSync(c, 'utf8'));
        return { manifest: m, base: path.dirname(c) };
      }
    } catch (_) {}
  }
  return null;
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 60);
}

function list() {
  const dir = skinsDir();
  ensureDir(dir);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (!fs.statSync(p).isDirectory()) continue; } catch (_) { continue; }
    const r = readManifest(p);
    if (!r) continue;
    const m = r.manifest || {};
    let st = null;
    try { st = fs.statSync(p); } catch (_) {}
    out.push({
      name: n,
      title: String(m.title || m.name || n),
      bg: !!m.bg,
      horn: !!m.horn,
      height: Number(m.height) || 38,
      installedAt: st ? st.mtimeMs : 0,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function toFileUrl(p) {
  try {
    if (!p || !fs.existsSync(p)) return '';
    return 'file://' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23');
  } catch (_) { return ''; }
}

/** 当前激活皮肤的渲染载荷（供 win.themePayload 使用） */
function activePayload() {
  const name = prefs.load().activeSkin;
  if (!name) return null;
  const dir = path.join(skinsDir(), String(name));
  const r = readManifest(dir);
  if (!r) return null;
  const m = r.manifest || {};
  const pick = (v) => {
    if (!v) return '';
    const abs = path.isAbsolute(v) ? v : path.join(r.base, v);
    return toFileUrl(abs);
  };
  const bg = pick(m.bg);
  const horn = pick(m.horn);
  return {
    name: String(name),
    title: String(m.title || m.name || name),
    bg,
    horn,
    height: Number(m.height) || 38,
  };
}

async function install(parentWin) {
  const win = parentWin && !parentWin.isDestroyed() ? parentWin : BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win || undefined, {
    title: '选择皮肤包',
    properties: ['openFile'],
    filters: [
      { name: 'FNOS 皮肤包', extensions: ['fskin', 'zip'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
  const zip = res.filePaths[0];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-skin-'));
  try {
    await unzip(zip, tmp);
    const r = readManifest(tmp);
    if (!r) return { ok: false, error: '皮肤包缺少 manifest.json' };
    const m = r.manifest || {};
    let name = safeName(m.name || m.title || path.basename(zip).replace(/\.(fskin|zip)$/i, ''));
    if (!name) name = 'skin-' + Date.now();

    const dest = path.join(skinsDir(), name);
    ensureDir(skinsDir());
    try { if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(dest, { recursive: true });

    // 复制 manifest 所在目录的全部内容
    for (const n of fs.readdirSync(r.base)) {
      const src = path.join(r.base, n);
      const dst = path.join(dest, n);
      try { fs.cpSync(src, dst, { recursive: true }); } catch (_) {}
    }
    return { ok: true, name, list: list() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

function remove(name) {
  const n = safeName(name);
  if (!n) return { ok: false, error: '名称无效' };
  const dir = path.join(skinsDir(), n);
  try {
    if (!fs.existsSync(dir)) return { ok: false, error: '皮肤不存在' };
    fs.rmSync(dir, { recursive: true, force: true });
    const s = prefs.load();
    if (String(s.activeSkin || '') === n) prefs.save({ activeSkin: '' });
    return { ok: true, list: list() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { skinsDir, list, install, remove, activePayload };
