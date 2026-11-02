'use strict';
/**
 * macOS 桌面 / 应用快捷方式
 *
 * 不依赖任何第三方工具：手写最小 .app bundle
 *   Foo.app/Contents/Info.plist
 *   Foo.app/Contents/MacOS/launcher   （shell 脚本，open -b <bundleId> --args --fnos-open=<url>）
 *   Foo.app/Contents/Resources/icon.icns（由 PNG 用 sips + iconutil 生成，失败则跳过）
 * 双击后唤起已安装的 FNOS 客户端并把目标 URL 交给主进程打开。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, nativeImage } = require('electron');
const { execFileSync } = require('child_process');

const BUNDLE_ID = 'com.fnos.desktop';

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 60) || 'FNOS';
}

function xmlEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeInfoPlist(name, execName) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    '  <key>CFBundleName</key><string>' + xmlEscape(name) + '</string>\n' +
    '  <key>CFBundleDisplayName</key><string>' + xmlEscape(name) + '</string>\n' +
    '  <key>CFBundleIdentifier</key><string>' + BUNDLE_ID + '.shortcut.' + xmlEscape(String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'app') + '</string>\n' +
    '  <key>CFBundleExecutable</key><string>' + execName + '</string>\n' +
    '  <key>CFBundlePackageType</key><string>APPL</string>\n' +
    '  <key>CFBundleShortVersionString</key><string>1.0</string>\n' +
    '  <key>CFBundleVersion</key><string>1</string>\n' +
    '  <key>LSMinimumSystemVersion</key><string>11.0</string>\n' +
    '  <key>LSUIElement</key><false/>\n' +
    '  <key>CFBundleIconFile</key><string>icon</string>\n' +
    '</dict>\n</plist>\n';
}

function makeLauncher(url) {
  // 优先按 bundle id 唤起（与安装路径无关）；失败则按名字唤起
  return '#!/bin/sh\n' +
    'TARGET=' + shq(url) + '\n' +
    'open -b ' + BUNDLE_ID + ' --args --fnos-open="$TARGET" 2>/dev/null || ' +
    'open -a "FNOS" --args --fnos-open="$TARGET" 2>/dev/null || ' +
    'open "$TARGET"\n';
}

function pngToIcns(pngPath, outIcns) {
  // 用系统自带 sips + iconutil 生成 icns；任一步失败就返回 false（用系统默认图标）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-icns-'));
  try {
    const setDir = path.join(tmp, 'icon.iconset');
    fs.mkdirSync(setDir, { recursive: true });
    const sizes = [16, 32, 64, 128, 256, 512];
    for (const s of sizes) {
      execFileSync('/usr/bin/sips', ['-z', String(s), String(s), pngPath, '--out', path.join(setDir, 'icon_' + s + 'x' + s + '.png')], { stdio: 'ignore', timeout: 20000 });
      execFileSync('/usr/bin/sips', ['-z', String(s * 2), String(s * 2), pngPath, '--out', path.join(setDir, 'icon_' + s + 'x' + s + '@2x.png')], { stdio: 'ignore', timeout: 20000 });
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', setDir, '-o', outIcns], { stdio: 'ignore', timeout: 30000 });
    return fs.existsSync(outIcns);
  } catch (_) {
    return false;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * 创建一个 .app 快捷方式
 * @param {object} o { dir, name, url, iconBase64, iconExt }
 */
function createAppBundle(o) {
  const dir = o.dir;
  const name = safeName(o.name);
  const bundlePath = path.join(dir, name + '.app');
  try {
    fs.mkdirSync(path.join(bundlePath, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(bundlePath, 'Contents', 'Resources'), { recursive: true });

    fs.writeFileSync(path.join(bundlePath, 'Contents', 'Info.plist'), makeInfoPlist(name, 'launcher'), 'utf8');

    const launcher = path.join(bundlePath, 'Contents', 'MacOS', 'launcher');
    fs.writeFileSync(launcher, makeLauncher(o.url), 'utf8');
    fs.chmodSync(launcher, 0o755);

    // 图标
    let iconOk = false;
    try {
      if (o.iconBase64) {
        const raw = String(o.iconBase64).replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '');
        const buf = Buffer.from(raw, 'base64');
        if (buf.length > 200) {
          const ext = (o.iconExt || 'png').replace(/^\./, '');
          const tmpPng = path.join(bundlePath, 'Contents', 'Resources', '__icon_src.' + ext);
          fs.writeFileSync(tmpPng, buf);
          if (ext === 'png') {
            iconOk = pngToIcns(tmpPng, path.join(bundlePath, 'Contents', 'Resources', 'icon.icns'));
          } else {
            // 其它格式先转 png 再转 icns
            const conv = path.join(bundlePath, 'Contents', 'Resources', '__icon_conv.png');
            try {
              execFileSync('/usr/bin/sips', ['-s', 'format', 'png', tmpPng, '--out', conv], { stdio: 'ignore', timeout: 20000 });
              iconOk = pngToIcns(conv, path.join(bundlePath, 'Contents', 'Resources', 'icon.icns'));
            } catch (_) {}
            try { if (fs.existsSync(conv)) fs.unlinkSync(conv); } catch (_) {}
          }
          try { if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng); } catch (_) {}
        }
      }
    } catch (_) {}

    // 让 Finder 立即刷新图标缓存
    try { execFileSync('/usr/bin/touch', [bundlePath], { stdio: 'ignore', timeout: 5000 }); } catch (_) {}

    return { ok: true, path: bundlePath, name, icon: iconOk };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function desktopDir() {
  try {
    const p = path.join(os.homedir(), 'Desktop');
    if (fs.existsSync(p)) return p;
  } catch (_) {}
  return app.getPath('desktop');
}

function appsDir() {
  const p = path.join(os.homedir(), 'Applications', 'FNOS 应用');
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
  return p;
}

function removeBundle(dir, name) {
  const p = path.join(dir, safeName(name) + '.app');
  try {
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); return true; }
  } catch (_) {}
  return false;
}

module.exports = { createAppBundle, desktopDir, appsDir, removeBundle, safeName, BUNDLE_ID };
