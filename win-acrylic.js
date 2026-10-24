'use strict';
/**
 * v2.17.25：标题栏系统级毛玻璃（Windows blur-behind）
 *
 * 背景：CSS backdrop-filter 在 Electron 透明窗口里只能模糊【窗口内部】绘制的内容，模糊不到
 * 窗口外的桌面。旧布局为了让内容不被标题栏遮挡，把 body 整体下移 34px，标题栏背后就是空的
 * html —— 透明窗下即桌面，backdrop-filter 没有模糊源，磨砂滑块怎么拖都没有变化。
 * 用户要求保留「内容不被遮挡」的旧布局，因此改用系统级方案：给窗口开 DWM 的
 * ACCENT_ENABLE_BLURBEHIND（通过未文档化的 user32!SetWindowCompositionAttribute）。
 * 窗口背景变成「模糊后的桌面」，body 的不透明内容会盖住其余区域，视觉上只有标题栏那一条
 * 显示毛玻璃 —— 内容照旧不被遮挡。vscode-vibrancy / TranslucentTB 用的是同一套 API。
 *
 * 实现：常驻一个 PowerShell 进程，启动时 Add-Type 编译一次 C# 辅助类，之后每次只往 stdin
 * 写一行 `hwnd|state|flags|gradient`，避免每次调用都重新编译（否则拖动滑块会有 1~2s 延迟）。
 */

const PS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$src = @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class FnosAccent {',
  '  [StructLayout(LayoutKind.Sequential)] public struct AccentPolicy { public int AccentState; public int AccentFlags; public int GradientColor; public int AnimationId; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct WinData { public int Attribute; public IntPtr Data; public int SizeOfData; }',
  '  [DllImport("user32.dll")] public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WinData d);',
  '  public static int Apply(IntPtr h, int state, int flags, int gradient) {',
  '    AccentPolicy ap = new AccentPolicy();',
  '    ap.AccentState = state; ap.AccentFlags = flags; ap.GradientColor = gradient; ap.AnimationId = 0;',
  '    int sz = Marshal.SizeOf(ap);',
  '    IntPtr p = Marshal.AllocHGlobal(sz);',
  '    Marshal.StructureToPtr(ap, p, false);',
  '    WinData d = new WinData();',
  '    d.Attribute = 19; d.Data = p; d.SizeOfData = sz;',
  '    int r = SetWindowCompositionAttribute(h, ref d);',
  '    Marshal.FreeHGlobal(p);',
  '    return r;',
  '  }',
  '}',
  "'@",
  'Add-Type -TypeDefinition $src -ErrorAction Stop',
  "[Console]::Out.WriteLine('READY')",
  '[Console]::Out.Flush()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  "  if ($line -eq 'EXIT') { break }",
  "  $p = $line.Split('|')",
  '  if ($p.Length -ge 4) {',
  '    try { [void][FnosAccent]::Apply([IntPtr][Int64]$p[0], [int]$p[1], [int]$p[2], [int][uint32]$p[3]) } catch { }',
  '  }',
  '}'
].join('\n');

module.exports = function createAcrylic(deps) {
  const app = deps.app;
  const BrowserWindow = deps.BrowserWindow;
  const cp = deps.cp;
  const dlog = typeof deps.dlog === 'function' ? deps.dlog : () => {};
  const clampInt = deps.clampInt;
  const getSettings = typeof deps.getSettings === 'function' ? deps.getSettings : () => ({});
  const resolvePsExe = typeof deps.resolvePsExe === 'function' ? deps.resolvePsExe : () => 'powershell';

  let proc = null;
  let fail = 0;
  let lastLog = 0;

  function log(level, data) {
    // 限流：拖动滑块时别把日志刷爆
    const now = Date.now();
    if (level !== 'warn' && now - lastLog < 1500) return;
    lastLog = now;
    try { dlog(level, 'titlebar.acrylic', data); } catch (_) {}
  }

  function spawn() {
    if (process.platform !== 'win32') return null;
    if (proc && !proc.killed && proc.stdin && !proc.stdin.destroyed) return proc;
    if (fail >= 3) return null;
    try {
      const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
      const exe = resolvePsExe();
      const p = cp.spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: false
      });
      p.on('exit', () => { if (proc === p) proc = null; });
      p.on('error', (e) => {
        fail++;
        if (proc === p) proc = null;
        try { dlog('warn', 'titlebar.acrylic', { spawnFail: String((e && e.message) || e).slice(0, 200) }); } catch (_) {}
      });
      p.stdout.on('data', (b) => { try { if (String(b).indexOf('READY') >= 0) log('info', { ready: true, exe: exe }); } catch (_) {} });
      p.stderr.on('data', (b) => {
        try {
          const t = String(b || '').trim();
          if (t) { fail++; try { dlog('warn', 'titlebar.acrylic', { err: t.slice(0, 300) }); } catch (_) {} }
        } catch (_) {}
      });
      proc = p;
      return p;
    } catch (e) {
      fail++;
      try { dlog('warn', 'titlebar.acrylic', { spawnFail: String((e && e.message) || e).slice(0, 200) }); } catch (_) {}
      return null;
    }
  }

  // #RRGGBB -> COLORREF（0x00BBGGRR），AccentPolicy.GradientColor 用的是 ABGR 排布
  function hexToBgr(hex) {
    try {
      let h = String(hex || '').replace('#', '').trim();
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const n = parseInt(h, 16);
      if (!isFinite(n) || h.length !== 6) return 0;
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return ((b << 16) | (g << 8) | r) >>> 0;
    } catch (_) { return 0; }
  }

  // 系统 blur-behind 的模糊半径由系统固定、不能按 px 调，所以把「磨砂程度」映射成浓度：
  // 越大底色越厚（视觉上糊得越实），「不透明度」继续控制整体深浅，两个滑块都能看到变化。
  function cfgOf(material, opacity, blur, color) {
    const on = material === 'frosted';
    const op = clampInt(opacity, 0, 100, 0);
    const bl = clampInt(blur, 0, 40, 12);
    const tint = Math.min(0.5, (op / 100) * 0.35 + (bl / 40) * 0.12);
    return { on: on, tint: tint, color: String(color || '#3B82F6') };
  }

  function cfgFromSettings() {
    const s = getSettings() || {};
    return cfgOf(s.titleBarMaterial, s.titleBarOpacity, s.titleBarBlur, s.titleBarColor);
  }

  function applyOne(win, cfg) {
    try {
      if (process.platform !== 'win32') return;
      if (!win || win.isDestroyed()) return;
      let buf = null;
      try { buf = win.getNativeWindowHandle(); } catch (_) { return; }
      if (!buf || !buf.length) return;
      let hwnd = '';
      try {
        hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
      } catch (_) { return; }
      if (!hwnd || hwnd === '0') return;
      const p = spawn();
      if (!p || !p.stdin || p.stdin.destroyed) return;
      let state = 0;
      let gradient = 0;
      if (cfg && cfg.on) {
        state = 3; // 3 = ACCENT_ENABLE_BLURBEHIND（4 = acrylic，Win11 上拖动会掉帧，3 更稳）
        const a = Math.round(Math.max(0, Math.min(1, cfg.tint)) * 255);
        gradient = (((a << 24) >>> 0) | hexToBgr(cfg.color)) >>> 0;
      }
      try { p.stdin.write(hwnd + '|' + state + '|2|' + gradient + '\n'); } catch (_) {}
    } catch (_) {}
  }

  function applyAll(cfg) {
    if (process.platform !== 'win32') return;
    const c = cfg || cfgFromSettings();
    try {
      for (const w of BrowserWindow.getAllWindows()) applyOne(w, c);
    } catch (_) {}
  }

  function applyFromPayload(p) {
    try {
      applyAll(cfgOf(p && p.material, p && p.opacity, p && p.blur, p && p.color));
    } catch (_) {}
  }

  // 每个窗口一出现就套用（磨砂是全局设置：主窗 / 设置窗 / 应用窗 / 直播窗统一）
  try {
    app.on('browser-window-created', (_e, win) => {
      try {
        const apply = () => applyOne(win, cfgFromSettings());
        win.once('ready-to-show', () => {
          apply();
          setTimeout(() => { try { apply(); } catch (_) {} }, 900);
        });
        win.on('show', apply);
        win.webContents.on('did-finish-load', apply);
        let t = 0;
        const bump = () => {
          if (t) clearTimeout(t);
          t = setTimeout(() => { t = 0; apply(); }, 260);
        };
        win.on('resize', bump);
        win.on('move', bump);
        win.on('restore', apply);
        win.on('focus', apply);
      } catch (_) {}
    });
  } catch (_) {}

  // 退出时收掉常驻 PowerShell，别留孤儿进程
  try {
    app.on('will-quit', () => {
      try { if (proc && proc.stdin) proc.stdin.write('EXIT\n'); } catch (_) {}
      try { if (proc) proc.kill(); } catch (_) {}
      proc = null;
    });
  } catch (_) {}

  return {
    applyAll: applyAll,
    applyFromPayload: applyFromPayload,
    applyOne: applyOne,
    cfgFromSettings: cfgFromSettings,
    cfgOf: cfgOf,
    dispose: () => {
      try { if (proc && proc.stdin) proc.stdin.write('EXIT\n'); } catch (_) {}
      try { if (proc) proc.kill(); } catch (_) {}
      proc = null;
    }
  };
};
