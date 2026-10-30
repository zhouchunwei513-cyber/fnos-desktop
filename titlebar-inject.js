// titlebar-inject.js — 统一的无边框自定义标题栏注入
// 被 preload.js / settings-preload.js / live-preload.js 复用，保证所有窗口标题栏一致。
// 功能：顶部拖动热区、☰ 菜单、最小化/最大化/关闭（实心按钮）、自动隐藏（默认关闭）、
//       ALT 键调出、设置实时更新、SPA 重渲染自愈。
// 用法（preload 内）：require('./titlebar-inject')({ ipcRenderer })
'use strict';

module.exports = function injectTitleBar(ctx) {
  let ipcRenderer = ctx && ctx.ipcRenderer;
  let __fs = null, __path = null;
  try { __fs = require('fs'); } catch (_) {}
  try { __path = require('path'); } catch (_) {}
  if (!ipcRenderer) { try { ipcRenderer = require('electron').ipcRenderer; } catch (_) {} }
  if (!ipcRenderer) return;
  try {
    if (typeof window === 'undefined') return;
    // v2.5.7 r23（问题1/3 根修）：子帧（含跨源 iframe）不再整段跳过——appview 应用窗的假窗控
    //（"—▣✕"）与日夜混搭都在 iframe 内容里（截图实锤：Docker 窗控挂 iframe 内标题区、黑栏=壳/
    // 白区=iframe）。nodeIntegrationInSubFrames 开启后 preload 进每个 iframe：子帧只跑 chrome
    // 清理+主题归一，不注入标题栏。
    const __SUB = (window.top !== window);
    // v2.15.3：macOS 用 titleBarStyle:hiddenInset（原生红绿灯内嵌），本标题栏只画 ☰菜单+拖动，
    // 不画 —□✕（最小化/最大化/关闭交给原生红绿灯）；Windows 保持自绘 —□✕。
    // v2.15.4：isMac 双通道判定——preload 上下文 process.platform 可用，但个别内嵌窗注入点
    // process 可能不可用，补 navigator 兜底，确保 mac 上绝不画自绘 —□✕（红绿灯交原生）。
    const isMac = (typeof process !== 'undefined' && process.platform === 'darwin') ||
      (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(String(navigator.platform || '') + String(navigator.userAgent || '')));

    // ---------------- v2.5.2 r18：appview 容器页 chrome 清理 + 布局修复 + 状态埋点 ----------------
    // r18 实测（图2/5/7）：appview?anchor= 顶层独立窗里 fnOS 前端把桌面壳残留全部渲染：右上角
    // 模拟窗口按钮（与本注入标题栏叠成两套最大化/关闭=双标题栏问题）、左侧 dock 黑块（挤占内容
    // 区致布局错位）、左下角头像浮钮（图5/6/7）。本段仅作用于 /appview 顶层页面（应用内容在其
    // 自带 iframe/子框架，window.top 判断已隔离），按"fixed 定位+屏幕边缘区域+形态"启发式隐藏
    // 壳残留（排除注入标题栏 #fnos-tb-bar）；容器页唯一应用 iframe 强制撑满视口（尺寸塌缩型
    // 黑屏）；采样状态埋点供诊断，被隐藏元素逐个留痕可回查。
    // v2.5.4 r20：清理范围由主进程 chromeFix 决定（NAS 同源 appview/独立应用窗；主窗桌面不清
    // 理防误杀），isAppview 初值=appview 路径，should-inject 后按 chromeFix 放开；setTimeout(0)
    // 保证同步 should-inject 查询先行
    let isAppview = /\/appview/i.test(String(location.pathname || ''));
    try {
      const __chromeGo = function () { if (!isAppview && !__SUB) return;
        // v2.10.0 r30（问题1/2 根修）：假窗控清扫与 iframe 撑满只在 --fnos-app-window 应用窗内生效
        //——主窗整棵 frame 树（web 桌面内嵌窗真窗控/真实布局）全豁免；无旗标默认不动（安全方向）。
        try { if (!process || !process.argv || process.argv.indexOf('--fnos-app-window') < 0) return; } catch (_) { return; }
        (function __appviewChromeFix() {
          const __log = (o) => { try { ipcRenderer.send('fnos:media-log', Object.assign({ stage: 'appview.chrome-fix' }, o)); } catch (_) {} };
          const __hidden = [];
          const __isOurs = (el) => !!(el && el.closest && el.closest('#fnos-titlebar, #fnos-titlebar-hotzone, [data-fnos-tb], [id^="fnos-tb-"]'));
          const __apply = () => {
            try {
              const ifs = document.querySelectorAll('iframe');
              if (ifs.length === 1) {
                const f = ifs[0];
                if (!f.__fnFixFull) {
                  f.__fnFixFull = true;
                  f.style.setProperty('position', 'fixed', 'important');
                  f.style.setProperty('inset', '0', 'important');
                  f.style.setProperty('width', '100vw', 'important');
                  f.style.setProperty('height', '100vh', 'important');
                  f.style.setProperty('border', '0', 'important');
                  f.style.setProperty('margin', '0', 'important');
                  f.style.setProperty('padding', '0', 'important');
                  f.style.setProperty('z-index', '2147483000', 'important');
                  __log({ kind: 'iframe-fullsize' });
                }
              }
              const vw = window.innerWidth, vh = window.innerHeight;
              // v2.5.6 r22（问题1）：扫描面扩到同源 iframe 文档——appview 应用中心的"—▣✕"
              // 假窗控在 iframe 子框架内=主文档扫描够不到（r22 candidate-dump 空转实锤）
              let nodes = Array.from(document.body ? document.body.querySelectorAll('*') : []);
              try {
                const __ifs22 = document.querySelectorAll('iframe');
                for (let __fi22 = 0; __fi22 < __ifs22.length && nodes.length < 4000; __fi22++) {
                  try {
                    const __d22 = __ifs22[__fi22].contentDocument;
                    if (__d22 && __d22.body) nodes = nodes.concat(Array.from(__d22.body.querySelectorAll('*')));
                  } catch (_) {}
                }
              } catch (_) {}
              for (let i = 0; i < nodes.length; i++) {
                const el = nodes[i];
                try {
                  if (__isOurs(el) || __hidden.indexOf(el) >= 0) continue;
                  const cs = getComputedStyle(el);
                  // v2.5.7 r23（问题1 根修）：不再限定 fixed——截图实锤假窗控为 static/absolute
                  // flex 排版（r22 只认 fixed=漏杀根源）；误杀防线改由各形态的位置/图标/文本条件把关
                  const __pos = cs.position;
                  if (cs.display === 'none' || cs.visibility === 'hidden') continue;
                  const r = el.getBoundingClientRect();
                  if (r.width <= 0 || r.height <= 0) continue;
                  const cnt = el.querySelectorAll('button, [role="button"], [class*="btn" i], [class*="close" i], [class*="win-ctrl" i], [class*="titlebar" i], [class*="title-bar" i], svg, [class*="ctrl" i]').length;
                  // v2.5.6 r22（问题1）：窗控符号文本判定——"—▣✕"文本字符假窗控被 !text 条件
                  // 排除=漏杀真凶（r22 截图 1 黄框实锤）；窗控符号集（横线/方框/叉号 unicode）
                  // 视为无文本；文本=窗控符号序列直接命中形态 A3。
                  const __txtRaw = (el.textContent || '').trim();
                  const __winctlOnly = __txtRaw.length > 0 && __txtRaw.length <= 16 && /^[\u002D\u002E\u00B7\u2013\u2014\u2015\u2500\u2501\u2581\u2588\u25A0\u25A1\u25A2\u25A3\u25B2\u25BC\u2715\u2716\u2717\u2718\u00D7\u2212\u2312\u25CB\u25CF\u2726\u274C\u274E\u2750\u0041\s]+$/.test(__txtRaw) && /[\u002D\u2013\u2014\u2500\u25A0\u25A1\u25A2\u25A3\u2715\u2716\u2717\u00D7\u274C]/.test(__txtRaw);
                  const __noTxt = !__txtRaw || __winctlOnly;
                  // 形态 A：右上角假窗口按钮组（与注入标题栏叠成双标题栏）
                  // v2.5.4 r20：组判定放宽（回收站/Docker 假窗控组宽高超旧阈值=漏杀实锤）+无文本要求
                  // v2.5.5 r21：再放宽（top 140→180/贴右 260→320/宽 520→720/高 120→160）+新增
                  // 形态 A2 通栏假标题栏（宽≥半屏、高≤56、≥3 控件）——r21 复验仍有残留实锤
                  // v2.5.7 r23：形态 A4 窗控图标特征组——svg 特征识别（最小化=单横线/最大化=
                  // 方框/关闭=两条交叉斜线）≥1、组内 2+ 控件、紧贴右上（top≤110、贴右≤96、
                  // 组≤320×72）、无文本，不依赖 position（static flex 排版窗控实锤）
                  const __svgSig = (function () {
                    let hit = 0;
                    try {
                      const svgs = el.querySelectorAll ? el.querySelectorAll('svg') : [];
                      for (let si = 0; si < svgs.length && hit < 2; si++) {
                        const sg = svgs[si];
                        const lns = sg.querySelectorAll('line');
                        let cross = 0, horiz = 0;
                        for (let li = 0; li < lns.length; li++) {
                          const a = lns[li];
                          const x1 = a.getAttribute('x1'), x2 = a.getAttribute('x2'), y1 = a.getAttribute('y1'), y2 = a.getAttribute('y2');
                          if (x1 !== x2 && y1 !== y2) cross++;
                          if (y1 === y2 && x1 !== x2) horiz++;
                        }
                        if (cross >= 2) { hit = 2; continue; } // 关闭=交叉双斜线
                        if (horiz >= 1) hit = Math.max(hit, 1); // 最小化=水平线
                        const rcs = sg.querySelectorAll('rect');
                        for (let ri = 0; ri < rcs.length; ri++) {
                          const w = Number(rcs[ri].getAttribute('width') || 0);
                          if (w >= 6 && w <= 40) { hit = Math.max(hit, 1); break; } // 最大化=小方框
                        }
                        const pts = sg.querySelectorAll('path');
                        for (let pi = 0; pi < pts.length && hit < 2; pi++) {
                          const d = String(pts[pi].getAttribute('d') || '');
                          const nseg = (d.match(/[ML]/gi) || []).length;
                          if (d.length > 0 && d.length <= 48 && nseg >= 2 && nseg <= 4) hit = Math.max(hit, 1);
                        }
                      }
                    } catch (_) {}
                    return hit;
                  })();
                  const __winGroup = r.top <= 110 && (vw - r.right) <= 96 && r.width <= 320 && r.height <= 72 && cnt >= 2 && __noTxt && __svgSig >= 1;
                  const fakeWinBtns = (r.top <= 180 && (vw - r.right) <= 320 && r.width <= 720 && r.height <= 160 && cnt >= 2 && __noTxt && (__pos === 'fixed' || __pos === 'absolute'))
                    || (r.top <= 8 && r.height <= 56 && r.width >= vw * 0.5 && cnt >= 3 && __noTxt)
                    || (r.top <= 120 && (vw - r.right) <= 260 && r.width <= 560 && r.height <= 90 && __winctlOnly && (__pos === 'fixed' || __pos === 'absolute'))
                    || __winGroup;
                  // 形态 B：左侧 dock 竖长条（黑块挤占内容区）
                  const dockRail = (__pos === 'fixed' || __pos === 'absolute') && r.left <= 88 && r.width <= 132 && r.height >= vh * 0.3;
                  // 形态 C：左/右下角头像悬浮小圆钮（≥20px 排除 1×1 角标 IMG 误杀——r19 hiddenCount:1 实锤）
                  const cornerFab = (__pos === 'fixed' || __pos === 'absolute') && r.width <= 170 && r.height <= 170 && r.width >= 20 && r.height >= 20 && (vh - r.bottom) <= 130 && (r.left <= 130 || (vw - r.right) <= 130);
                  // 形态 D：右上角窗控形态单个小按钮兜底（组判定不满足时逐按钮清）——保守收窄：
                  // 仅 48×48 内、贴右≤96、svg 图标、无文本、无 aria-label/title（真功能按钮都有）
                  const fakeBtnOne = r.top <= 80 && (vw - r.right) <= 48 && r.width <= 48 && r.height <= 48 && r.width >= 14 && r.height >= 14
                    && (el.querySelector && el.querySelector('svg')) && __noTxt && __svgSig >= 1
                    && !el.getAttribute('aria-label') && !el.getAttribute('title');
                  if (fakeWinBtns || dockRail || cornerFab || fakeBtnOne) {
                    el.style.setProperty('display', 'none', 'important');
                    __hidden.push(el);
                    __log({ kind: fakeWinBtns ? 'fake-winbtns' : (dockRail ? 'dock-rail' : (fakeBtnOne ? 'fake-btn' : 'corner-fab')), tag: String(el.tagName || '').slice(0, 16), cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 60), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
                  }
                } catch (_) {}
              }
            } catch (_) {}
          };
          __apply();
          setTimeout(__apply, 800);
          setTimeout(__apply, 2000);
          setTimeout(__apply, 4500);
          try {
            let __tick = false;
            const mo = new MutationObserver(() => {
              try {
                if (!__tick) { __tick = true; setTimeout(() => { __tick = false; __apply(); }, 400); }
              } catch (_) {}
            });
            mo.observe(document.documentElement, { childList: true, subtree: true });
          } catch (_) {}
          setTimeout(() => {
            try {
              const ifs = document.querySelectorAll('iframe');
              const f = ifs[0];
              __log({ kind: 'state', iframes: ifs.length, ifSize: f ? [f.clientWidth | 0, f.clientHeight | 0] : null, hiddenCount: __hidden.length, doc: [document.body ? document.body.clientWidth | 0 : 0, document.body ? document.body.clientHeight | 0 : 0], href: String(location.href || '').slice(0, 120) });
              // v2.5.5 r21（问题7）：右上角残留候选 dump——未被隐藏规则命中的 fixed 元素留痕
              try {
                const __vw = window.innerWidth, __cand = [];
                // v2.5.6 r22：dump 面扩到同源 iframe 文档（假窗控在 iframe 内=主文档 dump 空转实锤）
                let __nodes = Array.from(document.body ? document.body.querySelectorAll('*') : []);
                try {
                  const __ifs22b = document.querySelectorAll('iframe');
                  for (let __fi22b = 0; __fi22b < __ifs22b.length && __nodes.length < 4000; __fi22b++) {
                    try { const __d22b = __ifs22b[__fi22b].contentDocument; if (__d22b && __d22b.body) __nodes = __nodes.concat(Array.from(__d22b.body.querySelectorAll('*'))); } catch (_) {}
                  }
                } catch (_) {}
                for (let i = 0; i < __nodes.length && __cand.length < 16; i++) {
                  const el = __nodes[i];
                  try {
                    if (__isOurs(el) || __hidden.indexOf(el) >= 0) continue;
                    const cs = getComputedStyle(el);
                    if ((cs.position !== 'fixed' && cs.position !== 'absolute') || cs.display === 'none' || cs.visibility === 'hidden') continue;
                    const r2 = el.getBoundingClientRect();
                    if (r2.width <= 0 || r2.height <= 0) continue;
                    if (r2.top <= 200 && (__vw - r2.right) <= 340) {
                      __cand.push({ tag: String(el.tagName || '').slice(0, 12), cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 40), rect: [Math.round(r2.left), Math.round(r2.top), Math.round(r2.width), Math.round(r2.height)], txt: String(el.textContent || '').trim().slice(0, 12) });
                    }
                  } catch (_) {}
                }
                if (__cand.length) __log({ kind: 'candidate-dump', n: __cand.length, items: __cand });
              } catch (_) {}
            } catch (_) {}
          }, 5200);
        })();
      };
      setTimeout(__chromeGo, 0);
    } catch (_) {}

    // v2.2.4：查询主进程——XTE 等自带标题栏的应用跳过自定义标题栏注入，
    // 避免叠加错位（用户截图：XTE 启动界面左上汉堡菜单 + 右上窗口按钮重叠）。
    try {
      const __skipQuery = ipcRenderer.sendSync('titlebar:should-inject');
      // v2.5.4 r20：chrome 清理放开到 NAS 独立应用窗（/iscsi/ 等非 appview 路径壳残件）+
      // nasOrigin 供 __themeNormalize 范围判定
      try { if (__skipQuery && __skipQuery.chromeFix) isAppview = true; } catch (_) {}
      try { if (__skipQuery && __skipQuery.nasOrigin) window.__fnosNasOrigin = String(__skipQuery.nasOrigin); } catch (_) {}
      if (__skipQuery && __skipQuery.skip) {
        try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.skipped', reason: __skipQuery.reason, path: (location.pathname || '').slice(0, 60) }); } catch (_) {}
        return;
      }
    } catch (_) {}

    // ---------------- v2.5.4 r20：全 NAS 页面日夜模式统一跟随系统（问题3根修） ----------------
    // 特征值三层（实锤自 fnOS 前端 bundle）：系统=nativeTheme.shouldUseDarkColors（Windows 注册表
    // AppsUseLightTheme）→matchMedia('(prefers-color-scheme: dark)')；fnOS 存储 localStorage
    // ['os-theme-mode'|'fnos-theme-mode']（10=LIGHT/20=DARK/30=OS）；DOM=body[theme-dark]/
    // body[theme-light]。混搭=壳（存储驱动）与 iframe 内容（media query/参数驱动）分叉。
    // 修法（机制无关钉死渲染层）：body attribute 按系统值持续归一 + 存储归一 30 + 同源 iframe
    // 递归 + 跨源 iframe src 主题参数覆盖 + postMessage 通知 + 系统切换实时跟随。
    // v2.8.0 r28（问题⑤增强日志）：页面 fetch/XHR 失败埋点 app.api-error——iSCSI LUN 列表 API 挂起
    // 等网络层问题此前无痕（仅顶层 nav-error），现在日志可直接跟踪失败请求（via/status/err）。
    try {
      (function __apiErrHook28() {
        try {
          const __send = (o) => { try { ipcRenderer.send('fnos:media-log', Object.assign({ stage: 'app.api-error' }, o)); } catch (_) {} };
          try {
            const __of = window.fetch;
            if (__of) {
              window.fetch = function () {
                const __u = String((arguments[0] && arguments[0].url) || arguments[0] || '').slice(0, 160);
                try {
                  return __of.apply(this, arguments).then((r) => {
                    try { if (!r || !r.ok) __send({ via: 'fetch', url: __u, status: r && r.status }); } catch (_) {}
                    return r;
                  }).catch((e) => { try { __send({ via: 'fetch', url: __u, err: String(e && e.message || e).slice(0, 80) }); } catch (_) {} throw e; });
                } catch (_) { return __of.apply(this, arguments); }
              };
            }
          } catch (_) {}
          try {
            const __xo = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (m, u) {
              try { this.__fnApiU28 = String(u || '').slice(0, 160); this.__fnApiM28 = String(m || ''); } catch (_) {}
              return __xo.apply(this, arguments);
            };
            ['error', 'timeout', 'abort'].forEach((ev) => {
              try {
                XMLHttpRequest.prototype.addEventListener(ev, function () {
                  try { __send({ via: 'xhr-' + ev, method: this.__fnApiM28, url: this.__fnApiU28, status: this.status }); } catch (_) {}
                });
              } catch (_) {}
            });
          } catch (_) {}
        } catch (_) {}
      })();
    } catch (_) {}
    (function __themeNormalize() {
      // v2.5.5 r21（问题3 全窗统一）：系统日夜特征值——matchMedia('(prefers-color-scheme: dark)')
      // （Electron 映射 Windows 注册表 HKCU\...\Themes\Personalize\AppsUseLightTheme，0=深色）。
      // 快捷方式独立窗/外源页面同样归一（r21 实锤：快捷方式窗日夜混搭致字段不可见）：
      // matchMedia 桥（组件库/iframe 读同一系统值）+ html colorScheme + body attr + fnOS 存储 30。
      const __isNas = (() => { try { return !!(window.__fnosNasOrigin && String(location.href).indexOf(window.__fnosNasOrigin) === 0); } catch (_) { return false; } })();
      const __log = (o) => { try { ipcRenderer.send('fnos:media-log', Object.assign({ stage: 'theme.normalize' }, o)); } catch (_) {} };
      let __sysDark = false;
      let __origMQ = null;
      try { __origMQ = window.matchMedia ? window.matchMedia.bind(window) : null; } catch (_) {}
      // v2.5.6 r22：真值改从主进程 nativeTheme 取（themeSource 显式化后 CSS @media 与
      // matchMedia 桥同源=混搭根修）；IPC 不可用回退原生 matchMedia 真值。30s 跟随系统切换。
      const __refreshDark = () => {
        try {
          const v = ipcRenderer.sendSync('theme:sys-dark');
          if (typeof v === 'boolean') { __sysDark = v; return; }
        } catch (_) {}
        try { __sysDark = !!(__origMQ && __origMQ('(prefers-color-scheme: dark)').matches); } catch (_) {}
      };
      __refreshDark();
      try { setInterval(__refreshDark, 30000); } catch (_) {}
      try {
        if (__origMQ) {
          window.matchMedia = function (q) {
            const res = __origMQ(q);
            try {
              const s = String(q || '').toLowerCase().replace(/\s/g, '');
              if (s.indexOf('prefers-color-scheme:dark') >= 0) {
                Object.defineProperty(res, 'matches', { get: () => __sysDark });
              } else if (s.indexOf('prefers-color-scheme:light') >= 0) {
                Object.defineProperty(res, 'matches', { get: () => !__sysDark });
              }
            } catch (_) {}
            return res;
          };
          __log({ kind: 'mq-patched', dark: __sysDark, href: String(location.href || '').slice(0, 120) });
        }
      } catch (_) {}
      const __isDark = () => __sysDark;
      const __apply = (doc) => {
        try {
          if (!doc || !doc.documentElement) return;
          try { doc.documentElement.style.colorScheme = __isDark() ? 'dark' : 'light'; } catch (_) {}
          if (!doc.body) return;
          const dark = __isDark();
          const want = dark ? 'theme-dark' : 'theme-light';
          const drop = dark ? 'theme-light' : 'theme-dark';
          if (doc.body.getAttribute(drop) !== null) doc.body.removeAttribute(drop);
          if (doc.body.getAttribute(want) === null) doc.body.setAttribute(want, '');
        } catch (_) {}
      };
      // v2.9.0 r29（问题③根修）：不再改写用户主题设置——os-theme-mode/fnos-theme-mode 三态
      //（10=亮 20=暗 30=跟随系统）是唯一真值（与 Windows 无关，用户实锤："亮暗和 Windows 没
      // 关系，只是程序内的设置"）。r28 强写 30=覆盖用户"暗模式(20)"选择=亮暗混搭根源。
      // 现改为向主进程上报三态真值（theme:mode），全层解析同源。
      if (__isNas) {
        try {
          const keys = ['os-theme-mode', 'fnos-theme-mode'];
          const before = keys.map((k) => k + '=' + String(localStorage.getItem(k)));
          let __mode = '';
          for (const k of keys) { try { const v = localStorage.getItem(k); if (v) { __mode = String(v); break; } } catch (_) {} }
          try { ipcRenderer.sendSync('theme:mode', __mode); } catch (_) {}
          __log({ kind: 'store-respect29', before: before.join(','), mode: __mode || '(未设置)', dark: __isDark(), href: String(location.href || '').slice(0, 120) });
        } catch (e) { __log({ kind: 'store-err', err: String(e && e.message || e) }); }
      }
      __apply(document);
      try {
        const mo = new MutationObserver(() => { __apply(document); });
        mo.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['theme-dark', 'theme-light'] });
      } catch (_) {}
      const __frames = () => {
        try {
          const ifs = document.querySelectorAll('iframe');
          ifs.forEach((f) => {
            // 同源 iframe：递归钉死 body attribute + colorScheme
            try { if (f.contentDocument) __apply(f.contentDocument); } catch (_) {}
            try {
              if (!f.src || !/^https?:/i.test(f.src)) return;
              const u = new URL(f.src);
              const keys2 = ['theme', 'dark', 'mode', 'color_scheme', 'colorScheme', 'theme_mode', 'themeMode'];
              let changed = false;
              keys2.forEach((k) => {
                if (u.searchParams.has(k)) {
                  const v = __isDark() ? 'dark' : 'light';
                  if (u.searchParams.get(k) !== v) { u.searchParams.set(k, v); changed = true; }
                }
              });
              if (changed) {
                const old = String(f.src).slice(0, 140);
                f.src = u.toString();
                __log({ kind: 'iframe-src', old, to: u.toString().slice(0, 140) });
              }
              try { if (f.contentWindow) f.contentWindow.postMessage({ source: 'fnos-tb', theme: __isDark() ? 'dark' : 'light' }, '*'); } catch (_) {}
              // v2.5.5 r21：跨源 iframe load 后补发 postMessage（早发时子框架未就绪会丢）
              try {
                if (!f.__fnThemeHook) {
                  f.__fnThemeHook = true;
                  f.addEventListener('load', () => { try { if (f.contentWindow) f.contentWindow.postMessage({ source: 'fnos-tb', theme: __isDark() ? 'dark' : 'light' }, '*'); } catch (_) {} });
                }
              } catch (_) {}
            } catch (_) {}
          });
          // 状态埋点（R20-G）：iframe src 留痕——v2.5.6 r22 降噪（问题7）：frames n:0 空转
          // 刷屏 2188 条实锤；仅 n>0 且签名变化时记（保跟踪能力去刷屏）
          try {
            const __srcs22 = Array.from(ifs).slice(0, 4).map((f) => String(f.src || '').slice(0, 120));
            const __sigF22 = ifs.length + ':' + __srcs22.join('|');
            if (ifs.length > 0 && __sigF22 !== (globalThis.__fnFramesSig || '')) {
              globalThis.__fnFramesSig = __sigF22;
              __log({ kind: 'frames', n: ifs.length, srcs: __srcs22 });
            }
          } catch (_) {}
        } catch (_) {}
      };
      // v2.5.5 r21：iframe 扫描持续化（SPA 晚挂 iframe 早扫漏掉=frames n:0 实锤）
      setTimeout(__frames, 800);
      setTimeout(__frames, 2500);
      try {
        const mo2 = new MutationObserver(() => { try { __frames(); } catch (_) {} });
        mo2.observe(document.documentElement || document, { childList: true, subtree: true });
      } catch (_) {}
      setInterval(() => { try { __frames(); } catch (_) {} }, 8000);
      try {
        const mq = __origMQ && __origMQ('(prefers-color-scheme: dark)');
        if (mq && mq.addEventListener) {
          mq.addEventListener('change', () => { __refreshDark(); __apply(document); __frames(); __log({ kind: 'system-switch', dark: __isDark() }); });
        }
      } catch (_) {}
      setInterval(() => { __apply(document); }, 5000);
    })();

    // v2.5.7 r23：子帧只做 chrome 清理+主题归一，不注入标题栏/拖动热区
    try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.enter', sub: __SUB, href: String(location.href||'').slice(0,80) }); } catch(_) {}
    if (__SUB) return;

    // v1.58：标题栏样式状态。默认【不】自动隐藏（常驻）、透明材质。
    // v2.19.0：material = 'solid'（纯色）| 'frosted'（磨砂玻璃）；blur = 磨砂强度 0~40px
    // 标题栏皮肤状态（主进程 settings:get-titlebar / settings:titlebar-changed 下发）
    let __skinState = { skinDir: '', skin: null };
    // 标题栏有效高度（body 下移量），皮肤 titlebar.height 覆盖，默认 34
    let __skinHeight = 34;

    // 读皮肤素材文件 -> blob URL（避开 file:// 受 webSecurity 限制）
    const __skinAssetCache = new Map();
    function __loadSkinAsset(skinDir, src) {
      try {
        if (!__fs || !__path || !skinDir || !src) return null;
        const p = __path.join(skinDir, String(src));
        if (!__fs.existsSync(p)) return null;
        let __stamp = 0;
        try { __stamp = __fs.statSync(p).mtimeMs || 0; } catch (_) {}
        const __ck = p + '|' + __stamp;
        const __hit = __skinAssetCache.get(__ck);
        if (__hit) return __hit;
        const buf = __fs.readFileSync(p);
        const ext = String(src).toLowerCase().split('.').pop();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm' }[ext] || 'application/octet-stream';
        const blob = new Blob([buf], { type: mime });
        const __u = URL.createObjectURL(blob);
        __skinAssetCache.set(__ck, __u);
        return __u;
      } catch (_) { return null; }
    }

    // 标题栏有效高度：皮肤 titlebar.height（20~80，默认 34）→ --fnos-bar-h（body 下移量）+ bar inline 高度
    function __applyTitlebarHeight() {
      try {
        const s = __skinState.skin;
        const h = s && s.titlebar ? Number(s.titlebar.height) : NaN;
        __skinHeight = (isFinite(h) && h >= 20 && h <= 80) ? Math.round(h) : 34;
        const el = document.documentElement;
        if (el && el.style) el.style.setProperty('--fnos-bar-h', __skinHeight + 'px');
        // 同步 bar inline 高度（主窗 +2px 盖接缝，其余不变），保持 __barHeight() 的 parseFloat 可读
        const bar = document.getElementById('fnos-titlebar');
        if (bar) bar.style.height = (__skinHeight + (bar.__tbIsMain ? 2 : 0)) + 'px';
      } catch (_) {}
    }

    // 给标题栏挂背景层(z-index:-2) + 形状层(z-index:-1)子元素（绝对定位，不参与 flex）
    function __attachSkinLayers(bar) {
      try {
        if (!bar || bar.__shapeLayer) return;
        const bgLayer = document.createElement('div');
        bgLayer.id = 'fnos-tb-bg';
        bgLayer.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;-webkit-app-region:no-drag;z-index:-2;display:none;background-size:cover;background-position:center;background-repeat:no-repeat;overflow:hidden;border-radius:inherit;';
        const shapeLayer = document.createElement('div');
        shapeLayer.id = 'fnos-tb-shape';
        shapeLayer.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;-webkit-app-region:no-drag;z-index:-1;display:none;background-size:100% 100%;background-position:center;background-repeat:no-repeat;border-radius:inherit;';
        bar.appendChild(bgLayer);
        bar.appendChild(shapeLayer);
        bar.__bgLayer = bgLayer;
        bar.__shapeLayer = shapeLayer;
      } catch (_) {}
    }

    // 应用皮肤背景/形状到子元素；返回是否有皮肤背景接管（true = 背景层渲染，bar 自身透明）
    function __applySkinLayers(bar) {
      try {
        if (!bar) return false;
        const bgLayer = bar.__bgLayer || null;
        const shapeLayer = bar.__shapeLayer || null;
        const tb = __skinState.skin && __skinState.skin.titlebar;
        const bg = tb && tb.background;
        const shape = tb && tb.shape;
        const __sig = (function () {
          try {
            const d = String((__skinState && __skinState.skinDir) || '');
            const mt = [bg && bg.src, shape && shape.src].map(function (x) {
              try { return x ? (__fs.statSync(__path.join(d, String(x))).mtimeMs || 0) : 0; } catch (_) { return 0; }
            }).join(',');
            return d + '|' + JSON.stringify(bg || null) + '|' + JSON.stringify(shape || null) + '|' + mt;
          } catch (_) { return ''; }
        })();
        if (__sig && bar.__skinSig === __sig) return !!bar.__skinHasBg;
        if (bgLayer) { bgLayer.style.display = 'none'; bgLayer.style.backgroundImage = 'none'; bgLayer.style.backgroundColor = 'transparent'; bgLayer.innerHTML = ''; }
        if (shapeLayer) { shapeLayer.style.display = 'none'; shapeLayer.style.backgroundImage = 'none'; shapeLayer.innerHTML = ''; }
        let hasBg = false;
        if (bg && bg.type && bg.type !== 'none') {
          if (bg.type === 'video' && bg.src) {
            const url = __loadSkinAsset(__skinState.skinDir, bg.src);
            if (url && bgLayer) {
              const v = document.createElement('video');
              v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
              v.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;pointer-events:none;-webkit-app-region:no-drag;';
              v.src = url;
              bgLayer.appendChild(v);
              bgLayer.style.display = 'block';
              hasBg = true;
            }
          } else if ((bg.type === 'image' || bg.type === 'gif') && bg.src) {
            const url = __loadSkinAsset(__skinState.skinDir, bg.src);
            if (url && bgLayer) {
              bgLayer.style.backgroundImage = 'url("' + url + '")';
              bgLayer.style.backgroundSize = bg.size || 'cover';
              bgLayer.style.backgroundPosition = bg.position || 'center';
              bgLayer.style.backgroundRepeat = bg.repeat || 'no-repeat';
              bgLayer.style.display = 'block';
              hasBg = true;
            }
          } else if (bg.type === 'color') {
            if (bgLayer) { bgLayer.style.backgroundColor = bg.color || '#3B82F6'; bgLayer.style.display = 'block'; hasBg = true; }
          } else if (bg.type === 'gradient') {
            if (bgLayer) { bgLayer.style.backgroundImage = bg.gradient || bg.css || ''; bgLayer.style.display = 'block'; hasBg = true; }
          }
        }
        if (shape && shape.type && shape.type !== 'none' && shape.src) {
          const url = __loadSkinAsset(__skinState.skinDir, shape.src);
          if (url && shapeLayer) {
            shapeLayer.style.display = 'block';
            const __stok = String(Date.now()) + '_' + Math.random();
            bar.__shapeToken = __stok;
            // shape.mode:
            //   fill = 素材本身就是标题栏比例的长图，整条铺满
            //   ends = 素材是单只装饰，两端各一只、等比高度、绝不拉伸（右端水平镜像）
            //   缺省 = 按素材宽高比自适应（>= 8 走 fill，否则 ends）
            const __fill = function () {
              try {
                shapeLayer.innerHTML = '';
                shapeLayer.style.backgroundImage = 'url("' + url + '")';
                shapeLayer.style.backgroundSize = shape.stretch === false ? (shape.size || 'auto') : '100% 100%';
                shapeLayer.style.backgroundPosition = shape.position || 'center';
                shapeLayer.style.backgroundRepeat = shape.repeat || 'no-repeat';
              } catch (_) {}
            };
            const __ends = function () {
              try {
                shapeLayer.innerHTML = '';
                shapeLayer.style.backgroundImage = 'none';
                const mk = function (isRight) {
                  const im = document.createElement('img');
                  im.src = url;
                  im.draggable = false;
                  im.style.cssText = 'position:absolute;top:0;height:100%;width:auto;pointer-events:none;-webkit-app-region:no-drag;' + (isRight ? 'right:0;' : 'left:0;');
                  if (isRight) im.style.transform = 'scaleX(-1)';
                  shapeLayer.appendChild(im);
                };
                mk(false);
                if (shape.mirror !== false) mk(true);
              } catch (_) {}
            };
            const __mode = (shape.mode === 'ends' || shape.mode === 'fill') ? shape.mode : '';
            if (__mode === 'fill') {
              __fill();
            } else if (__mode === 'ends') {
              __ends();
            } else {
              const probe = new Image();
              probe.onload = function () {
                if (bar.__shapeToken !== __stok) return;
                const nw = probe.naturalWidth || 1;
                const nh = probe.naturalHeight || 1;
                if (nw / nh >= 8) { __fill(); } else { __ends(); }
              };
              probe.onerror = function () { if (bar.__shapeToken === __stok) __fill(); };
              probe.src = url;
            }
          }
        }
        bar.__skinSig = __sig;
        bar.__skinHasBg = hasBg;
        return hasBg;
      } catch (_) { return false; }
    }

    const TB = { autoHide: false, opacity: 0, color: '#3B82F6', material: 'solid', blur: 20, highlight: 55, hideAccountBall: false };
    try {
      const r = ipcRenderer.sendSync('settings:get-titlebar');
      if (r && typeof r === 'object') {
        if (typeof r.autoHide === 'boolean') TB.autoHide = r.autoHide;
        if (r.opacity != null) TB.opacity = Math.max(0, Math.min(100, Number(r.opacity) || 0));
        if (r.color) TB.color = String(r.color);
        // v2.19.0：材质 + 磨砂强度（老配置缺字段时回落 solid，行为与之前完全一致）
        TB.material = (r.material === 'frosted') ? 'frosted' : 'solid';
        if (r.blur != null) TB.blur = Math.max(0, Math.min(40, Number(r.blur) || 0));
        if (r.highlight != null) TB.highlight = Math.max(0, Math.min(100, Number(r.highlight)));
        if (r.skinDir) __skinState.skinDir = String(r.skinDir);
        if (r.skin && typeof r.skin === 'object') __skinState.skin = r.skin;
        // v3.0.23：悬浮球隐藏开关
        if (typeof r.hideAccountBall === 'boolean') TB.hideAccountBall = r.hideAccountBall;
      }
    } catch (_) {}
    __applyTitlebarHeight();
    let AUTO_HIDE = TB.autoHide;

    const root = () => document.documentElement || document.body || document;
    // v2.17.11: titlebar actual height (CSS px). Offset and push-down both use it,
    // so a page that grows the bar cannot leave content still covered.
    const __barHeight = () => {
      try {
        const b = document.getElementById('fnos-titlebar');
        if (!b) return 34;
        // v2.17.15: prefer the inline height (34px / 36px). The bar carries
        // zoom:calc(1/var(--fnos-f)), so getBoundingClientRect would report 34/f and any
        // caller dividing by f again would double-compensate.
        const inline = parseFloat(b.style.height);
        if (isFinite(inline) && inline > 20 && inline < 120) return Math.round(inline);
        const h = Math.round(b.getBoundingClientRect().height);
        return (h > 20 && h < 120) ? h : 34;
      } catch (_) { return 34; }
    };

    // v2.4.9（反馈 8 两种窗口模式自动适配）：内嵌窗形态宿主窗标记（主进程 additionalArguments
    // 传入），命中时渲染 fnOS 内嵌窗样式标题栏（logo+标题+↻↗—□✕），而非跳出窗的 ☰+系统钮样式。
    let EMBED = false;
    try { EMBED = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv.indexOf('--fnos-embed-style') >= 0 : false; } catch (_) {}

    // 把 #RRGGBB + 不透明度(0~100) 转成 rgba()
    function hexToRgba(hex, a) {
      try {
        let h = String(hex || '').replace('#', '').trim();
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        const n = parseInt(h, 16);
        if (!isFinite(n) || h.length !== 6) return `rgba(0,0,0,${a})`;
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return `rgba(${r},${g},${b},${a})`;
      } catch (_) { return `rgba(0,0,0,${a})`; }
    }



    // 根据设置计算标题栏背景/模糊并应用；同时调整图标配色
    function applyStyle(bar) {
      try {
        if (!bar) return;
        if (__applySkinLayers(bar)) {
          bar.style.setProperty('-webkit-app-region', 'no-drag');
          bar.__skinNoDrag = true;
          bar.style.background = 'transparent';
          bar.style.backgroundImage = 'none';
          bar.style.backdropFilter = 'none';
          bar.style.webkitBackdropFilter = 'none';
          bar.style.boxShadow = 'none';
          const __skinIconDark = !!(__skinState.skin && __skinState.skin.titlebar && __skinState.skin.titlebar.content && __skinState.skin.titlebar.content.iconDark);
          bar.__useDarkIcon = !__skinIconDark;
          const __skStroke = __skinIconDark ? 'rgba(20,20,20,0.92)' : 'rgba(255,255,255,0.95)';
          const __skShadow = __skinIconDark ? 'drop-shadow(0 1px 1px rgba(255,255,255,0.6))' : 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))';
          bar.querySelectorAll('svg').forEach((svg) => {
            svg.querySelectorAll('path,line,rect').forEach((p) => { try { p.style.setProperty('stroke', __skStroke, 'important'); } catch (_) { p.setAttribute('stroke', __skStroke); } });
            svg.style.filter = __skShadow;
          });
          return;
        }
        {
          if (bar.__skinNoDrag) { bar.__skinNoDrag = false; try { bar.style.setProperty('-webkit-app-region', 'drag'); } catch (_) {} }
          // v2.15.14：默认深色渐变。旧默认 opacity=0 → 'transparent' 在深色壁纸下标题栏完全隐形。
          const a = TB.opacity / 100;
          // v2.19.0（用户要求）：磨砂玻璃材质。三层叠加做出"雾面玻璃"：
          //   1) 细噪点（SVG feTurbulence）—— 关键是它让磨砂"成立"：标题栏盖在 <webview> 等
          //      跨进程内容之上时，backdrop-filter 未必采样得到，但噪点+高光依然呈现雾面颗粒感
          //   2) 顶部白色高光渐变 —— 玻璃上沿的受光质感
          //   3) 底色 —— 用户颜色（磨砂下最低 10% alpha，太透会完全看不见材质）
          const frosted = TB.material === 'frosted';
          const __blur = Math.max(0, Math.min(40, Number(TB.blur) || 0));
          if (frosted) {
            const alpha = a > 0.001 ? Math.max(a, 0.10) : 0.24;
            const noiseOpacity = Math.max(0.04, Math.min(0.15, 0.15 - __blur * 0.0025)).toFixed(2);
            const noise = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'120\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'2\' stitchTiles=\'stitch\'/%3E%3CfeColorMatrix type=\'saturate\' values=\'0\'/%3E%3C/filter%3E%3Crect width=\'120\' height=\'120\' filter=\'url(%23n)\' opacity=\'' + noiseOpacity + '\'/%3E%3C/svg%3E")';
            // v2.19.2（用户要求）：高光强度可调，默认拉到接近 Win11 亚克力那种"上沿亮、向下渐弱"的受光。
            // hl=0 → 0.06（几乎无高光，纯靠模糊+噪点）；hl=55 → 0.40；hl=100 → 0.68
            const __hl = Math.max(0, Math.min(100, (TB.highlight == null ? 55 : Number(TB.highlight))));
            const __hi = 0.06 + (__hl / 100) * 0.62;
            const __w = (k) => 'rgba(255,255,255,' + (__hi * k).toFixed(3) + ')';
            // v2.19.2（用户要求加强高光）：顶部 1.5px 硬亮线 + 上小下大的快衰减，
            // 对齐 Win11 标题栏「上沿受光、往下越暗、底部反光」的层次
            const __topline = 'linear-gradient(180deg, ' + __w(1.4) + ' 0px, ' + __w(1.4) + ' 1.5px, rgba(255,255,255,0) 1.5px)';
            bar.style.backgroundImage = noise + ', ' + __topline + ', linear-gradient(180deg, ' + __w(1) + ' 0%, ' + __w(0.86) + ' 14%, ' + __w(0.50) + ' 46%, ' + __w(0.26) + ' 80%, ' + __w(0.34) + ' 100%)';
            bar.style.backgroundRepeat = 'repeat, no-repeat, no-repeat';
            bar.style.backgroundSize = '120px 120px, 100% 100%, auto';
            bar.style.backgroundColor = a > 0.001 ? hexToRgba(TB.color, alpha) : 'rgba(16,20,36,0.34)';
            bar.style.backdropFilter = 'blur(' + __blur + 'px) saturate(160%)';
            bar.style.webkitBackdropFilter = 'blur(' + __blur + 'px) saturate(160%)';
            bar.style.boxShadow = 'inset 0 1px 0 ' + __w(0.9) + ', inset 0 -1px 0 ' + __w(0.35);
          } else if (a > 0.001) {
            bar.style.background = hexToRgba(TB.color, a);
            bar.style.backdropFilter = 'none';
            bar.style.webkitBackdropFilter = 'none';
            bar.style.boxShadow = 'none';
          } else {
            // v2.15.69：设置窗口透明后标题栏透出桌面灰边，改深色渐变；主/应用窗口保持 transparent 透出下层
            var __argvS = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
            // v2.15.77：补排除直播窗口（--fnos-live-window）。直播窗口既无 --fnos-shell 也无
            // --fnos-app-window，旧条件会把它误判成设置窗口 → bar 被刷成深色渐变不透明，
            // 压在透明标题栏位置就成了用户看到的"长方形黑条"。
            var __isSettingsS = __argvS.indexOf('--fnos-shell') < 0 && __argvS.indexOf('--fnos-app-window') < 0 && __argvS.indexOf('--fnos-live-window') < 0;
            bar.style.background = __isSettingsS ? 'linear-gradient(180deg, rgb(6,9,21) 0%, rgb(3,6,16) 100%)' : 'transparent';
            bar.style.backdropFilter = 'none';
            bar.style.webkitBackdropFilter = 'none';
            bar.style.boxShadow = 'none';
          }
        }
        // 底色较深时图标用白，较浅时图标用深色——保证对比
        // v2.15.14：opacity=0 默认走深色渐变 → 也用白图标
        // v2.19.0：磨砂玻璃底色偏深（用户色+白高光+噪点），图标一律用白
        const darkBg = (TB.material === 'frosted') ? (TB.opacity <= 60) : (TB.opacity > 45 || TB.opacity <= 0.001);
        bar.__useDarkIcon = !darkBg; // true = 浅底用深图标
        const iconStroke = darkBg ? 'rgba(255,255,255,0.95)' : 'rgba(20,20,20,0.92)';
        const iconShadow = darkBg
          ? 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
          : 'drop-shadow(0 1px 1px rgba(255,255,255,0.6))';
        bar.querySelectorAll('svg').forEach((svg) => {
          svg.querySelectorAll('path,line,rect').forEach((p) => { try { p.style.setProperty('stroke', iconStroke, 'important'); } catch (_) { p.setAttribute('stroke', iconStroke); } });
          svg.style.filter = iconShadow;
        });

      } catch (_) {}
    }

    // v1.63：主进程全局光标轮询兜底——嵌入置顶 mpv 会挡住顶部鼠标事件，
    // 光标进入宿主顶部 34px 带时主进程发 force-show:true 强制显示标题栏，离开发 false 恢复。
    try {
      ipcRenderer.on('titlebar:force-show', (_e, data) => {
        try {
          const bar0 = document.getElementById('fnos-titlebar');
          if (!bar0) return;
          forceShow = !!(data && data.show);
          if (forceShow) show(bar0);
          else { if (AUTO_HIDE) hide(bar0); else show(bar0); }
        } catch (_) {}
      });
    } catch (_) {}

    // 监听设置变化（设置页切换后实时生效，无需重启）。payload 为完整样式对象
    try {
      ipcRenderer.on('settings:titlebar-changed', (_e, val) => {
        try {
          if (val && typeof val === 'object') {
            if (typeof val.autoHide === 'boolean') { TB.autoHide = val.autoHide; AUTO_HIDE = val.autoHide; }
            if (val.opacity != null) TB.opacity = Math.max(0, Math.min(100, Number(val.opacity) || 0));
            if (val.color) TB.color = String(val.color);
            // v2.19.0：材质 / 磨砂强度（预览与保存都会走这里）
            if (val.material) TB.material = (val.material === 'frosted') ? 'frosted' : 'solid';
            if (val.blur != null) TB.blur = Math.max(0, Math.min(40, Number(val.blur) || 0));
            if (val.highlight != null) TB.highlight = Math.max(0, Math.min(100, Number(val.highlight)));
            if (val.skinDir != null) __skinState.skinDir = String(val.skinDir);
            if (val.skin != null) __skinState.skin = (val.skin && typeof val.skin === 'object') ? val.skin : null;
            // v3.0.23：悬浮球隐藏开关（设置页勾选后立即隐藏 / 显示，不需要重启）
            if (typeof val.hideAccountBall === 'boolean') {
              TB.hideAccountBall = val.hideAccountBall;
              try { if (window.__fnApplyBallHidden) window.__fnApplyBallHidden(val.hideAccountBall); } catch (_) {}
            }
            __applyTitlebarHeight();
            const bar0 = document.getElementById('fnos-titlebar');
            if (bar0) {
              applyStyle(bar0);
              if (AUTO_HIDE) hide(bar0); else show(bar0);
            }
          } else if (typeof val === 'boolean') {
            // 兼容旧版裸布尔消息
            TB.autoHide = val; AUTO_HIDE = val;
            const bar0 = document.getElementById('fnos-titlebar');
            if (bar0) { if (val) hide(bar0); else show(bar0); }
          }
        } catch (_) {}
      });
    } catch (_) {}

    let forceShow = false; // v1.63：主进程光标轮询判定"鼠标在宿主顶部带"时强制显示
    function show(bar) {
      try {
        if (bar.__hideTimer) { clearTimeout(bar.__hideTimer); bar.__hideTimer = null; }
        bar.style.transform = 'translateY(0)';
        bar.style.opacity = '1';
        bar.style.pointerEvents = 'auto';
        if (window.__fnosFsOn) return;
        // v2.15.43: 自动隐藏调出后 -webkit-app-region:drag 的拖拽区域可能因 transform 过渡失效，
        // 强制 no-drag→drag 重注册拖拽区域，恢复可拖动
        if (window.__fnosFsOn) {
          // v2.17.35：全屏态标题栏一律 no-drag。drag 区会让 Windows 把整屏窗口"拖出全屏"，
          // 而用户要求全屏只能由 ESC / 菜单「退出全屏」结束，所以全屏时不再注册拖拽区。
          bar.style.setProperty('-webkit-app-region', 'no-drag');
        } else if (AUTO_HIDE && !bar.__skinNoDrag) {
          bar.style.setProperty('-webkit-app-region', 'no-drag');
          void bar.offsetHeight; // 强制同步 reflow，确保 no-drag 先生效
          bar.style.setProperty('-webkit-app-region', 'drag');
        }
      } catch (_) {}
    }
    function hide(bar) {
      try {
        // v2.17.33：全屏态强制悬浮——用户没开自动隐藏时也要能收起（鼠标移到顶部再出现）
        if (!AUTO_HIDE && !window.__fnosFsOn) return;
        if (forceShow) return;   // 主进程判定鼠标在顶部带，保持显示
        if (bar.__menuOpen) return;
        bar.style.transform = 'translateY(-100%)';
        bar.style.opacity = '0';
        bar.style.pointerEvents = 'none';
      } catch (_) {}
    }
    function scheduleHide(bar, ms) {
      try {
        if (!AUTO_HIDE && !window.__fnosFsOn) return;
        if (bar.__hideTimer) clearTimeout(bar.__hideTimer);
        bar.__hideTimer = setTimeout(() => { bar.__hideTimer = null; hide(bar); }, ms || 600);
        if (bar.__hideTimer.unref) bar.__hideTimer.unref();
      } catch (_) {}
    }

    function build() {
      try {
        if (document.getElementById('fnos-titlebar')) return;

        // 清理可能残留的旧沉浸黑条（v1.60~v1.61 引入，v1.62 移除：它是 no-drag 层会干扰拖动、且强制黑底）
        try { const old = document.getElementById('fnos-embed-topbar'); if (old) old.remove(); } catch (_) {}

        // ---- 顶部拖动热区：高 34px（与标题栏同高），始终存在、始终可拖动（含标题栏隐藏时） ----
        const hot = document.createElement('div');
        hot.id = 'fnos-titlebar-hotzone';
        hot.setAttribute('aria-hidden', 'true');
        hot.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'height:6px',
          'z-index:2147483646', 'pointer-events:auto', 'background:transparent', '-webkit-app-region:drag',
          'user-select:none'
        ].join(';');
        root().appendChild(hot);

        // ---- 标题栏 ----
        const bar = document.createElement('div');
        bar.id = 'fnos-titlebar'; // 注意：id 必须是 fnos-titlebar（MutationObserver/build 检测依赖）
        bar.setAttribute('data-fnos-tb', '1'); // v2.5.4 r20：清理排除标记（r18 的 fnos-tb-bar 双赋值被上一行覆盖，改用 data 属性）
        // v2.15.56：主窗口标题栏改用深色填充（飞牛状态栏同色系）——标题栏透明透出 Windows 桌面灰色壁纸
        // 会形成"灰条"；深色填充让标题栏与飞牛桌面顶部状态栏视觉连贯，消除灰条。应用/设置窗口保持透明
        // （v1.57 原因：避免浅色应用顶部出现实色栏；设置窗口不透明背景本身即深色）。
        const __argvB = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
        const __isMainWin = __argvB.indexOf('--fnos-shell') >= 0 && __argvB.indexOf('--fnos-app-window') < 0;
        const __barBg = __isMainWin ? 'linear-gradient(180deg, rgb(6,9,21) 0%, rgb(3,6,16) 100%)' : 'transparent';
        // v2.15.71：主窗口标题栏高度 34->35px，标题栏本体向下侵入内容区 1px 盖住接缝，
        // 取代 v2.15.70 伪元素方案（伪元素在 Windows 高分 DPI 下仍会透细线）。
        // 仅主窗口生效，设置窗/应用窗保持 34px 不变。
        bar.__tbIsMain = __isMainWin; // 皮肤高度联动：主窗视觉高度 = 有效高度 + 2px 盖接缝
        bar.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'width:calc(100vw * var(--fnos-f, 1))', 'height:' + (__skinHeight + (__isMainWin ? 2 : 0)) + 'px',
          'z-index:2147483647', 'display:flex', 'align-items:center',
          'justify-content:space-between', 'box-sizing:border-box',
          'pointer-events:auto',
          // v2.15.99：标题栏四角统一采用相同的小 R 角（四角均为 10px，小于窗口 clip-path 20px 大圆角）
          'border-radius:10px',
          'background:' + __barBg,
          // v2.15.74：主窗口底部 1px 同色实边，与 height 36px 配合把重叠 1px 加到 2px，
          // 吸收 Windows 高分 DPI 下窗口缩放产生的小数亚像素抗锯齿，根治间歇性灰线。
          // box-sizing:border-box 使内容盒仍为 35px，标题栏按钮/菜单垂直位置与 v2.15.73 完全一致。
          // v2.15.80: the 1px border-bottom was painted rgb(3,6,16), the same colour as the gradient tail, so it never read as a border but did form a hard 1px band where the bar meets the content - the dark line under the titlebar. Transparent keeps the box geometry identical (border-box, content box still 35px, buttons unmoved) while letting the bar gradient show through that 1px, so the edge is continuous and the seam is still covered.
          'border-bottom:none',
          '-webkit-app-region:drag',
          'user-select:none',
          'transition:transform .16s ease,opacity .16s ease',
          // v2.17.15: every window type now cancels page zoom on the bar, so its
          // pixels stay identical while only the page content zooms.
          'zoom:calc(1 / var(--fnos-f, 1))'
        ].filter(Boolean).join(';');

        // v2.15.84: grey band at the top of the content area while the window geometry changes.
        // Four recordings analysed frame by frame (r65..r68) all show the same thing: the band is
        // always the first ~3-33px of body -- screen y = window top + 34, i.e. directly below the
        // titlebar -- spans the full window width, follows body's 20px corner radius, colour is a
        // flat rgb(67,67,67), and it exists only while the window is being resized or dragged.
        // That colour is the opaque backdrop DWM composites into a transparent frameless window
        // while the new frame has not landed yet (Present1 and IDCompositionDevice::Commit are
        // asynchronous and cannot be synchronised; see Electron blog "Improving Window Resize
        // Behavior").
        // v2.15.81-83 painted an opaque strip over that area, but they also covered y=0..70 --
        // including the titlebar strip itself -- which showed up as a dark rectangle behind the
        // transparent titlebar, and v2.15.83 painted it permanently. Both were wrong. The titlebar
        // strip must stay fully transparent at all times; only the first 36px of body may be
        // covered, and only while the geometry is actually changing. The cover colour is #120606,
        // the dark red-black the desktop wallpaper itself starts with on this machine, so the flash
        // reads as part of the content top rather than as a bar.
        // v2.17.5: with the zoom factor removed (v2.17.0) body matches the window 1:1, so the DWM
        // backdrop that lands before the new frame only shows as a 1-3px seam at body's top edge --
        // not the ~30px band the zoom-0.7 era produced. A 34px #120606 cover was then painting a
        // full-height dark red band that reads as a black bar under the titlebar (frame-by-frame
        // scan of the user's recording: 30px tall, rgb(15,4,4)). Keep only a 4px seam cover in
        // body's own backdrop colour #05060a.
        // v2.17.6: that 4px cover was itself the bar the user kept seeing. Frame-by-frame scan of
        // the v2.17.5 recording (645f/26.677fps/1732x1110) finds a 4px dark band sitting exactly at
        // body's top edge (video y=240..243, core rgb(5,5,6), full width, appears only while the
        // window moves, clears ~260ms after release) -- i.e. the cover painting over the first rows
        // of real content, not a DWM seam. With the 1:1 geometry and __ghostBurst re-committing the
        // layer, the seam it guards is at most 1px, so the cover is shrunk to exactly that 1px.
        // v2.17.7: two separate 1px dark rows were left under the bar. Frame-by-frame scan of the
        // v2.17.6 recording (585f/23.439fps/1920x1072, frosted bar): y=241 is the blurred bar
        // (rgb(170,107,84) BGR) and y=242 drops to rgb(98,83,99) -- the row where bar's
        // border-bottom sits. An alpha-0 border still occupies the border box and Chromium only
        // applies backdrop-filter to the content box, so that 1px showed the unblurred dark content
        // instead of the blurred bar: that is the hairline. Border removed (content box 35->36px,
        // buttons shift 0.5px, invisible) so the blurred backdrop now reaches the very edge.
        // The resize cover goes to height 0 as well: the DWM seam it guarded no longer exists
        // (215 sampled frames, zero neutral-grey rows), and in frosted mode the dark cover was
        // bleeding through the translucent bar as a second 1px line while dragging.
        // v2.15.84 also swaps the html::before pseudo element for a real div: a page style reset can
        // neutralise pseudo elements, an element with an inline style cannot be overridden.
        try {
          if (__isMainWin) {
            let __rcEl = document.getElementById('fnos-resize-cover');
            if (!__rcEl) {
              __rcEl = document.createElement('div');
              __rcEl.id = 'fnos-resize-cover';
              __rcEl.style.cssText = 'position:fixed;top:34px;left:0;right:0;height:0;background:#05060a;z-index:2147483645;pointer-events:none;display:none;';
              (document.documentElement || document.body).appendChild(__rcEl);
            }
            if (!window.__fnosResizeCover) {
              window.__fnosResizeCover = true;
              let __rcT = 0;
              const __rcBump = function () {
                const el = document.getElementById('fnos-resize-cover');
                if (el) { try { el.style.display = 'block'; } catch (_) {} }
                if (__rcT) clearTimeout(__rcT);
                __rcT = setTimeout(function () {
                  __rcT = 0;
                  const e2 = document.getElementById('fnos-resize-cover');
                  if (e2) { try { e2.style.display = 'none'; } catch (_) {} }
                }, 260);
              };
              window.addEventListener('resize', __rcBump, { passive: true });
              // A window move fires no DOM event, but window.screenX/screenY follow it.
              let __rcX = window.screenX, __rcY = window.screenY;
              const __rcWatch = function () {
                if (window.screenX !== __rcX || window.screenY !== __rcY) {
                  __rcX = window.screenX;
                  __rcY = window.screenY;
                  __rcBump();
                }
                requestAnimationFrame(__rcWatch);
              };
              requestAnimationFrame(__rcWatch);
            }
          }
        } catch (_) {}

        // 左侧：☰ 菜单按钮（弹出原系统菜单栏全部内容）
        const left = document.createElement('div');
        left.style.cssText = '-webkit-app-region:drag;pointer-events:auto;display:flex;align-items:center;height:34px;padding-left:' + (isMac ? '82px' : '6px') + ';margin-left:4px;';
        const menuBtn = document.createElement('button');
        menuBtn.id = 'fnos-tb-menu';
        menuBtn.title = '菜单（文件/下载/视图/工具/设置/帮助）';
        menuBtn.style.cssText = 'width:46px;height:34px;border:none;outline:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;-webkit-app-region:no-drag;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85));';
        menuBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="rgba(255,255,255,0.95)" stroke-width="1.5" stroke-linecap="round"/></svg>';
        menuBtn.addEventListener('mouseenter', () => { menuBtn.style.background = 'rgba(255,255,255,0.12)'; });
        menuBtn.addEventListener('mouseleave', () => { menuBtn.style.background = 'transparent'; });
        menuBtn.addEventListener('click', () => {
          try {
            ipcRenderer.send('app-popup-menu');
            bar.__menuOpen = true;
            setTimeout(() => { bar.__menuOpen = false; scheduleHide(bar, 600); }, 1600);
          } catch (_) {}
        });
        left.appendChild(menuBtn);

        // 右侧：最小化/最大化/关闭——实心 Windows 风格，按钮可点击区域充足
        const btns = document.createElement('div');
        btns.style.cssText = '-webkit-app-region:drag;pointer-events:auto;display:flex;align-items:stretch;height:34px;margin-right:8px;overflow:hidden;';

        const mkBtn = (id, svg, hoverBg) => {
          const b = document.createElement('button');
          b.id = id;
          b.title = id === 'fnos-tb-min' ? '最小化' : id === 'fnos-tb-max' ? '最大化/还原' : '关闭';
          b.style.cssText = [
            'width:46px', 'height:34px', 'border:none', 'outline:none',
            'background:transparent', 'color:#fff',
            'cursor:pointer', 'display:flex', 'align-items:center', 'justify-content:center',
            'padding:0', '-webkit-app-region:no-drag', 'flex:0 0 auto',
            'filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85))'
          ].join(';');
          b.innerHTML = svg;
          // v2.0.3：确保SVG图标不受页面CSS影响
          const svgEl = b.querySelector('svg');
          if (svgEl) { svgEl.style.cssText = 'display:block;pointer-events:none;flex-shrink:0;'; }
          b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
          b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
          return b;
        };

        const minBtn = mkBtn('fnos-tb-min',
          '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M3 8H13" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/></svg>', 'rgba(255,255,255,0.22)');
        const maxBtn = mkBtn('fnos-tb-max',
          '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2" fill="none" stroke="#fff" stroke-width="1.3"/></svg>', 'rgba(255,255,255,0.22)');
        const closeBtn = mkBtn('fnos-tb-close',
          '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 4L12 12M12 4L4 12" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/></svg>', '#E81123');

        minBtn.addEventListener('click', () => { try { ipcRenderer.send('window-minimize'); } catch (_) {} });
        maxBtn.addEventListener('click', () => { try { ipcRenderer.send('window-maximize'); } catch (_) {} });
        closeBtn.addEventListener('click', () => { try { ipcRenderer.send('window-close'); } catch (_) {} });
        // v1.62：原生拖拽兜底。-webkit-app-region:drag 在置顶嵌入 mpv 存在时可能失灵，
        // 这里在顶部热区/标题栏空白处左键 mousedown 主动调 startDrag；点按钮/☰ 时 target
        // 命中按钮（no-drag 区）不触发，避免影响点击。
        // v2.17.45：双击标题栏最大化/还原。drag region 上 dblclick 事件被系统拖拽机制吞掉
        // 不触发（旧 bar.addEventListener('dblclick') 实测无效），改为在 mousedown 里用两次
        // 按下的时间/位置间隔自判双击：双击→window-maximize（__toggleMaxWin 已支持还原到
        // 最大化前的 bounds）；单击→window-drag（拖拽）。
        let __lastTbDown = 0, __lastTbDownX = 0, __lastTbDownY = 0;
        const startNativeDrag = (ev) => {
          try {
            if (ev.button !== 0) return;
            const t = ev.target;
            if (t && t.closest && t.closest('#fnos-tb-dragstrip, button, .fnos-tb-no-drag, #fnos-tb-min, #fnos-tb-max, #fnos-tb-close, #fnos-tb-menu')) return;
            const __now = Date.now();
            const __sx = ev.screenX || 0, __sy = ev.screenY || 0;
            if (__now - __lastTbDown < 450 && Math.abs(__sx - __lastTbDownX) < 8 && Math.abs(__sy - __lastTbDownY) < 8) {
              __lastTbDown = 0;
              try { ipcRenderer.send('window-maximize'); } catch (_) {}
              return;
            }
            __lastTbDown = __now;
            __lastTbDownX = __sx;
            __lastTbDownY = __sy;
            ipcRenderer.send('window-drag');
          } catch (_) {}
        };
        hot.addEventListener('mousedown', startNativeDrag);
        bar.addEventListener('mousedown', startNativeDrag);

        if (!isMac) { btns.appendChild(minBtn); btns.appendChild(maxBtn); btns.appendChild(closeBtn); }
        bar.appendChild(left);
        const dragStrip = document.createElement('div');
        dragStrip.id = 'fnos-tb-dragstrip';
        // v2.17.46：标题栏中部空白区不再用 -webkit-app-region:drag（drag 区的 mousedown 会被系统
        // move loop 接管、dblclick 不派发，v2.17.45 的 mousedown 时间戳双击判定因此失效——首次
        // mousedown 就 send('window-drag')，主进程 w.startDrag() 同步阻塞，第二次 mousedown 收不到）。
        // 改为普通可交互层：移动超 3px 才发起原生拖拽（纯点击/双击不被打断），dblclick 走 window-maximize。
        // v2.17.47：上一版漏了主进程实现——window-drag 里调用的 w.startDrag() 不是 BrowserWindow
        // 的 API，永远抛异常被 catch 吞掉，于是本层彻底不能拖（用户反馈：主程序和应用窗都拖不动）。
        // 现在拖动改为主进程 setPosition 跟随鼠标（win-drag-start/move/end）。
        dragStrip.style.cssText = 'flex:1;height:100%;min-width:20px;-webkit-app-region:no-drag;pointer-events:auto;cursor:default;';
        (function () {
          const W = window;
          W.__fnosDsDown = null;
          // v2.17.47：按住标题栏时把指针捕获到本层，鼠标甩出窗口/窗口追不上鼠标时仍持续收到
          // 移动事件（否则 Windows 停止投递 WM_MOUSEMOVE，拖动会中途卡住）。
          dragStrip.addEventListener('pointerdown', function (e) {
            try { dragStrip.setPointerCapture(e.pointerId); } catch (_) {}
          });
          dragStrip.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            W.__fnosDsDown = { x: (e.screenX || 0), y: (e.screenY || 0) };
            W.__fnosDsDrag = false;
            // v2.17.47：本层是 no-drag 交互层，原生 -webkit-app-region:drag 用不了，
            // 改由主进程真实拖动（main.js win-drag-start/win-drag-move/win-drag-end）。
            try { ipcRenderer.send('win-drag-start', { sx: (e.screenX || 0), sy: (e.screenY || 0) }); } catch (_) {}
          });
          dragStrip.addEventListener('dblclick', function (e) {
            W.__fnosDsDown = null; W.__fnosDsDrag = true;
            try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
            try { ipcRenderer.send('window-maximize'); } catch (_) {}
          });
          if (!W.__fnosDsHooked) {
            W.__fnosDsHooked = true; W.__fnosDsDrag = false;
            W.__fnosDsRaf = 0; W.__fnosDsPend = null;
            const __fwd = function (e) {
              if (!W.__fnosDsDown) return;
              if (e.buttons === 0) { W.__fnosDsDown = null; W.__fnosDsDrag = false; return; }
              try {
                if (Math.abs((e.screenX || 0) - W.__fnosDsDown.x) > 3 || Math.abs((e.screenY || 0) - W.__fnosDsDown.y) > 3) W.__fnosDsDrag = true;
                if (!W.__fnosDsDrag) return;
                // 每次移动都把最新屏幕坐标交给主进程（rAF 合并，60fps 上限）
                W.__fnosDsPend = { sx: (e.screenX || 0), sy: (e.screenY || 0) };
                if (!W.__fnosDsRaf) {
                  W.__fnosDsRaf = (W.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
                    W.__fnosDsRaf = 0;
                    const p = W.__fnosDsPend;
                    W.__fnosDsPend = null;
                    if (!p) return;
                    try { ipcRenderer.send('win-drag-move', p); } catch (_) {}
                  });
                }
              } catch (_) {}
            };
            W.addEventListener('mousemove', __fwd, true);
            W.addEventListener('pointermove', __fwd, true);
            const __end = function () {
              if (W.__fnosDsDown) { try { ipcRenderer.send('win-drag-end'); } catch (_) {} }
              W.__fnosDsDown = null; W.__fnosDsDrag = false; W.__fnosDsPend = null;
            };
            W.addEventListener('mouseup', __end, true);
            W.addEventListener('pointerup', __end, true);
            W.addEventListener('pointercancel', __end, true);
          }
        })();
        bar.appendChild(dragStrip);
        bar.appendChild(btns);
        __attachSkinLayers(bar);
        root().appendChild(bar);
    // v2.15.51：四角 R 角 + 修复飞牛主页底部裁切 + 滚动条顶部落到标题栏下方。
    // 1) 四角 R 角：body 加 clip-path:inset(0 round 20px)（标题栏保持长方形直角，仅 body 四角圆角），
    //    html 不加 clip-path——避免 v2.15.47 把标题栏顶部两角也裁成圆角的问题。
    // 2) 底部裁切根因：body transform 下移 34px 后，飞牛 fixed 侧边栏（inset-y-0=100vh）底部超出
    //    视口 34px 被裁。修复：主窗口加 height:calc(100vh-34px)（fixed 元素底部对齐视口）。
    // 3) 滚动条/截断根因：body overflow-y:auto 会传播到 viewport（CSS 规范：html overflow 为 visible 时
    //    body overflow 传播到 viewport），body 未成为滚动容器，滚动条仍嵌标题栏；body 固定高度+clip-path
    //    裁掉溢出内容导致截断。修复：应用窗口 html 加 overflow:hidden 阻止传播，body overflow-y:auto 内部
    //    滚动（滚动条落到 y=34 标题栏下方），同时消除截断。
    // 灰条根因（CDP 实测）：html 透明后，body 蓝灰渐变背景按 CSS 规范传播到 canvas，body 下移
    // 不影响 canvas 背景，导致标题栏区域露出灰条。修复：html 加透明 GIF background-image 阻止
    // body 背景传播（标题栏透出 Windows 桌面），body 背景保留防穿透。
    try {
      const __padStyle = document.createElement('style');
      __padStyle.id = 'fnos-tb-content-offset';
      const __argv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
      const __isLiveWin = __argv.indexOf('--fnos-live-window') >= 0; // v2.15.77: live window flag
      // v2.15.77: live window treated as app window. It carries neither --fnos-shell nor
      // --fnos-app-window, so the old condition dropped it into the __isSettings branch:
      // body got an opaque #05060a background and html lost the transparent-GIF guard,
      // producing a dark rectangle behind the transparent titlebar. As an app window it
      // gets html transparency (desktop shows through), margin:0 (keeps the 20px radius)
      // and the fixed-top compensation so only one titlebar layer remains.
      const __isAppWin = __argv.indexOf('--fnos-app-window') >= 0 || __isLiveWin;
      const __isSettings = (!__isAppWin && __argv.indexOf('--fnos-shell') < 0); // 设置窗口：无 --fnos-shell 也无 --fnos-app-window（不透明窗口，独立布局）
      const __gifBg = 'background-image:url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7") !important;background-color:transparent !important;';
      if (__isSettings) {
        // 设置窗口（settings.html，不透明窗口）：标题栏 bar 占顶部 34px。
        // v2.15.56：改用 body transform 下移 34px（而非 padding-top）——padding-top 无法约束 fixed 元素
        // 会钻到标题栏底下；transform 让全部内容（含 fixed）整体下移，标题栏独立顶部。
        // html 锁死滚动，body 单滚动（settings.css 配合）。
        // v2.18.5（用户要求「帮助页 / 偏好设置页 / 关于窗的 R 角与程序主页面一致」）：
        // 四角 clip-path 由 10px 改回 20px，与主窗口、应用窗口完全同一数值。
        // v2.18.0 曾为了与标题栏 bar 的 10px 同比例收到 10px，实测观感偏方，现按用户回归 20px。
        __padStyle.textContent = 'html{overflow:hidden !important;' + __gifBg + '}' +
          'html>body{transform:translateY(var(--fnos-bar-h, 34px)) !important;height:calc(100vh - var(--fnos-bar-h, 34px)) !important;min-height:0 !important;max-height:calc(100vh - var(--fnos-bar-h, 34px)) !important;box-sizing:border-box !important;overflow-y:auto !important;padding-top:0 !important;margin:0 !important;clip-path:inset(0 round 20px) !important;background:#05060a !important;}';
      } else if (__isAppWin) {
        // 应用窗口：body 下移 34px 给标题栏让位，内部滚动（滚动条落 y=34 下方），html 锁死滚动阻止传播。
        __padStyle.textContent = [
          'html{overflow:hidden !important;' + __gifBg + '}',
          // v2.15.76：应用窗口 body 的 margin 全方向归零。
          // 原只重置了 margin-top，页面 body 自带的 8px margin-bottom 会把 body 底边推出窗口，
          // 导致 clip-path 的 20px 底部圆角被裁到看不见（顶部两角正常、底部两角变直角）。
          // v2.15.78: min-height/max-height guard. Some app pages declare
          // body{min-height:100vh}; min-height wins over our height:calc(100vh-34px),
          // so the body box grows back to the full viewport and its bottom edge (and
          // therefore the 20px clip-path radius) lands below the window bottom -- the
          // top two corners look round while the bottom two are cut square.
          'html>body{transform:translateY(calc(var(--fnos-bar-h, 34px) / var(--fnos-f, 1))) !important;overflow-y:auto !important;height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;min-height:0 !important;max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;box-sizing:border-box !important;clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;padding-top:0 !important;margin:0 !important;}',
          // v3.0.12（用户反馈：飞牛音乐播放控制栏的提示气泡「下一首」盖住按钮）——
          // 根因：body 的 transform 下移 34px 会创建包含块，Semi Design 把 tooltip portal 到
          // document.body（.semi-portal 自身 position:absolute;top:0;left:0），其内部的 top/left
          // 是 JS 按 getBoundingClientRect（viewport 坐标）写入的；包含块变成 body 后原点从 0
          // 变成 34px，气泡整体下移 34px，正好从「按钮上方」落到「按钮身上」。
          // 修法：不动让位机制（改 padding/margin 会让 body 内 fixed 顶栏、全高侧栏钻回标题栏
          // 底下，v2.15.56 已踩过），只把 body 直接子级的 Semi 浮层容器的 absolute top 反向
          // 偏 34px，让它的原点重新落在 viewport 顶边 —— 气泡、下拉、弹窗一并对齐。
          'html>body>.semi-portal{top:calc(-1 * var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          // 全屏态 body 不再下移 34px（__fsBody 会写 transform:none），此时 portal 不该再补偿，
          // 否则气泡反而上移 34px。
          'html[data-fnos-fs="1"]>body>.semi-portal{top:0 !important;}',
          // v2.16.0: fixed-viewport SPA apps (Tailwind h-dvh / h-screen / min-h-dvh) size their
          // root to 100vh/dvh, ignoring the 34px titlebar. The body is already shrunk to
          // calc(100vh-34px), but a child at height:100vh still spans the full window, so its
          // bottom 34px overflows the body and is clipped (fnOS music: progress bar and the
          // bottom of "recently added" cut off, and the page's scrollbar-width:none hides the
          // scrollbar). Re-anchor viewport units to the visible area below the titlebar.
          'html>body .h-screen,html>body .h-dvh{height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          'html>body .min-h-screen,html>body .min-h-dvh{min-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          // v2.17.20: 上面只认 .h-screen/.h-dvh/.min-h-screen 这几个精确类名，而 Semi / Tailwind
          // 应用常用任意值写法（h-[100dvh]、h-[100vh]、min-h-[100vh]），命中不了就比 body 高出
          // 标题栏那 34px，撑出额外滚动条。这里按 class 子串补一层 max-height 兜底：只限上限，
          // 写了更大 min-height 的元素按 CSS 规则仍以 min-height 为准，不会被误裁。
          'html>body [class*="100vh"],html>body [class*="h-screen"],html>body [class*="h-dvh"]{max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          'html>body [style*="100vh"]{max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          // v2.17.20: webkit 侧把 body 自身滚动条轨道压到 0（是否启用由脚本按需挂
          // scrollbar-width，见 __ensureContentOffset），避免残留 1px 轨道。
          'html>body.fnos-no-body-scroll::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}'
        ].join('');
        // v2.15.92: auth pages (/signin, /oauth, /login) are centered cards with overflow:hidden.
        // Skip body shift + overflow-y:auto injection to avoid extra scrollbars.
        const __authPath = (typeof location !== 'undefined' && location.pathname) ? String(location.pathname) : '';
        if (__authPath.indexOf('/signin') >= 0 || __authPath.indexOf('/oauth') >= 0 || __authPath.indexOf('/login') >= 0) {
          // v2.17.22: 认证页（NAS 账号授权登录）原来只挂了个 clip-path，body 不下移也不限高，
          // 于是登录卡片按整窗居中、正落在标题栏下面，标题栏看起来「另一半」——和主程序/应用窗
          // 的默认标题栏对不上；body 又是整窗高，卡片一超出就冒出侧边/底部滚动条。
          // 现在与普通应用窗完全同一套几何：body 下移标题栏高度、高度扣掉标题栏、锁死溢出。
          __padStyle.textContent = [
            'html{overflow:hidden !important;' + __gifBg + '}',
            'html>body{transform:translateY(calc(var(--fnos-bar-h, 34px) / var(--fnos-f, 1))) !important;height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;min-height:0 !important;max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;box-sizing:border-box !important;overflow:hidden !important;overflow-x:hidden !important;padding:0 !important;margin:0 !important;clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;}',
            'html>body::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}'
          ].join('');
        }
      } else {
        // 主窗口（透明 + webview 飞牛桌面）：body 下移 34px 给标题栏让位（顶部透出桌面壁纸），
        // height:calc(100vh-34px) 让 webview 视口 = 窗口高度 - 34px；窗口高度已 +34px（main.js）补偿，
        // 使 webview 视口 = 原内容高度，飞牛监控面板底部完整显示、标题栏独立顶部不被 webview 覆盖。
        __padStyle.textContent = [
          'html{' + __gifBg + '--fnos-f:1;--ui-scale:.8;}',
          // v2.15.75：主窗口 body 底色由 transparent 改为深色 #05060a。
          // Windows 下内容区比例锁定是运行时逐帧校正，受整数像素约束具有 1px 级偏差；
          // 留白区域如果透明就会露出 Electron/DWM 底色形成灰条。
          // 深色兜底后，即使有 1px 偏差也与标题栏同色，不再看得出灰条。
          'html>body{transform:translateY(calc(var(--fnos-bar-h, 34px) / var(--fnos-f, 1))) !important;height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;box-sizing:border-box !important;clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;padding-top:0 !important;margin-top:0 !important;background:#05060a !important;}',
          // v2.17.0（DPI 方案 A）：飞牛桌面主页是远程 React SPA（cqfndesk），应用图标为 52px 位图，
          // 客户端无法改源码，只能注入覆盖：图标/卡片/文字/间距统一 x--ui-scale（0.8），图标 52->约 42px。
          // 选择器用 [class~="..."] 精确匹配 Tailwind token（规避 [ ] ! 转义），仅作用于主窗口主 frame。
          '[class~="size-[52px]"]{width:calc(52px * var(--ui-scale, 1)) !important;height:calc(52px * var(--ui-scale, 1)) !important;}' +
          '[class~="!h-[52px]"]{height:calc(52px * var(--ui-scale, 1)) !important;}' +
          '[class~="!w-[52px]"]{width:calc(52px * var(--ui-scale, 1)) !important;}' +
          '[class~="w-[144px]"]{width:calc(144px * var(--ui-scale, 1)) !important;}' +
          '[class~="h-[120px]"]{height:calc(120px * var(--ui-scale, 1)) !important;}' +
          '[class~="text-[14px]"]{font-size:calc(14px * var(--ui-scale, 1)) !important;}' +
          '[class~="leading-[18px]"]{line-height:calc(18px * var(--ui-scale, 1)) !important;}' +
          '[class~="gap-[10px]"]{gap:calc(10px * var(--ui-scale, 1)) !important;}' +
          '[class~="pt-[22px]"]{padding-top:calc(22px * var(--ui-scale, 1)) !important;}' +
          // v2.17.8：主窗口也会承载 Docker/第三方应用（appwin.open.fnos-domain-in-main 把
          // *.fnos.net 应用降级到主窗打开，日志实测 Next Terminal、MoonTV 都走这条路）。
          // 这时主窗里的页面是固定视口 SPA（Tailwind h-screen / h-dvh / min-h-dvh），它们把根节点
          // 撑到 100vh，无视已经下移的 34px 标题栏：根节点底部多出 34px 被 clip-path 裁掉，表现为
          // "页面显示不全"（内容底部/播放条/侧栏被切）。应用窗分支的 v2.16.0 补偿此前只覆盖
          // --fnos-app-window，主窗分支漏了，故在此补齐同一套规则，让 in-main 应用与外开应用窗
          // 得到完全一致的几何；同时补 overflow-y 让超出内容内部滚动而不是被硬裁。
          'html>body{overflow-y:auto !important;}' +
          'html>body .h-screen,html>body .h-dvh{height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}' +
          'html>body .min-h-screen,html>body .min-h-dvh{min-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}' +
          // v2.17.40（用户反馈：内嵌窗最大化后底部显示不出来）——主窗分支此前只覆盖 .h-screen/.h-dvh
          // 这两个精确类名，缺应用窗 v2.17.20 那套 [class*="100vh"] 子串兜底。飞牛桌面里的内嵌窗最大化
          // 时用任意值写法（h-[100vh]/h-[100dvh]）或 inline style 把容器撑到整个视口，而 body 已经下移
          // 34px，容器底部就超出 body 底边 34px 被 clip-path 裁掉（副标题/播放条/底栏被切一半）。
          // 补同两条 max-height 上限规则，让内嵌窗最大化后完整落在主程序窗口内容区内。
          'html>body [class*="100vh"],html>body [class*="100dvh"],html>body [class*="h-screen"],html>body [class*="h-dvh"],html>body [class*="dvh"]{max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}' +
          'html>body [style*="100vh"],html>body [style*="100dvh"],html>body [style*="dvh"]{max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}'
        ].join('');
      }
      (document.head || document.documentElement).appendChild(__padStyle);
      // v2.17.0（DPI 方案 A）：飞牛桌面应用网格的列/行/间距是 JS 直接写的 inline style
      // （repeat(auto-fill,100px)/110px/10px），CSS 选择器匹配不到（无 class/id），须用 JS 覆盖为
      // calc(Npx * var(--ui-scale)) 以跟随 --ui-scale。React 重渲染会重置 inline style，故用
      // MutationObserver 持续校正（已应用 calc 的跳过，避免死循环）。
      // 同时监听主进程 dpi-changed（切换显示器/改系统缩放时广播）：--ui-scale 是固定密度系数 0.8，
      // 不随 scaleFactor 累乘（PM-DPI 下 Chromium 已按 deviceScaleFactor 自动映射 CSS px，再乘 DPR
      // 会双重放大）；收到事件仅记录 scaleFactor 到 --ui-dpr 并触发一次网格重扫，保证切换后即时重排。
      const __fnosScaleGrid = (el) => {
        try {
          if (!el || el.nodeType !== 1) return;
          const _sg = el.style;
          if (_sg.display !== 'grid') return;
          const _gtc = String(_sg.gridTemplateColumns || '');
          if (_gtc.indexOf('100px') >= 0 && _gtc.indexOf('var(--ui-scale') < 0) {
            _sg.gridTemplateColumns = 'repeat(auto-fill, calc(100px * var(--ui-scale, 1)))';
            _sg.gridAutoRows = 'calc(110px * var(--ui-scale, 1))';
            _sg.gap = 'calc(10px * var(--ui-scale, 1))';
          }
        } catch (_) {}
      };
      const __fnosGridScan = () => {
        try {
          const _els = document.querySelectorAll('div[style*="grid"]');
          for (let _i = 0; _i < _els.length; _i++) __fnosScaleGrid(_els[_i]);
        } catch (_) {}
      };
      try {
        __fnosGridScan();
        try {
          const __fgsmo = new MutationObserver(() => { try { __fnosGridScan(); } catch (_) {} });
          __fgsmo.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch (_) {}
      } catch (_) {}
      try {
        ipcRenderer.on('dpi-changed', (_ev, _info) => {
          try {
            const _sf = (_info && Number(_info.scaleFactor)) || 1;
            try { document.documentElement.style.setProperty('--ui-dpr', String(_sf)); } catch (_) {}
            try { __fnosGridScan(); } catch (_) {}
          } catch (_) {}
        });
      } catch (_) {}
      // v2.16.1: unify app/settings window scrollbars to the fnOS video (os-scrollbar) look:
      // 8px, transparent track, 4px radius, semi-transparent thumb. App pages ship their own
      // scrollbars (fnOS music hides them via *{scrollbar-width:none}; 3rd-party apps like
      // 剪映 use a white track), so override here. The main window (fnOS desktop) is already
      // os-scrollbar and is left untouched to keep its .scrollbar-none/.os-scrollbar-hidden intact.
      // Thumb colour uses the theme var --semi-color-Scrollbar (dark=rgba(255,255,255,.12),
      // light=rgba(grey,.16)); 3rd-party apps without the var fall back to the dark value.
      if (__isAppWin || __isSettings) {
        try {
          const __scrollStyle = document.createElement('style');
          __scrollStyle.setAttribute('data-fnos-scrollbar', '1');
          // v2.17.21: 这里原本还有一行 *{scrollbar-width:auto !important;}，是给飞牛音乐「强制
          // 显示滚动条」用的，但它把应用自己的 *{scrollbar-width:none} 一起推翻了 —— 音乐页面
          // 用的是 Semi 自绘滚动条，于是原生条 + 自绘条并排成了两条（用户红框实测）。去掉这行，
          // 由「滚动条尺寸/配色」本身来统一外观：声明了 scrollbar-width 的应用保留自己的决定，
          // 没声明的（第三方白轨道如剪映）仍然吃到下面这套 8px 透明轨道 + 4px 圆角。
          __scrollStyle.textContent =
            '::-webkit-scrollbar{width:8px !important;height:8px !important;}' +
            '::-webkit-scrollbar-track{background:transparent !important;}' +
            '::-webkit-scrollbar-thumb{background:var(--semi-color-Scrollbar, rgba(255,255,255,.12)) !important;border-radius:4px !important;}' +
            '::-webkit-scrollbar-thumb:hover{background:var(--semi-color-Scrollbar-hover, rgba(255,255,255,.2)) !important;}' +
            '::-webkit-scrollbar-corner{background:transparent !important;}';
          (document.head || document.documentElement).appendChild(__scrollStyle);
        } catch (_) {}
      }
    } catch(_) {}
    // v2.15.52：应用网页自带 fixed 顶部标题栏落到内容区（UPS 电源管理等）修复。
    // 根因：body transform:translateY(34px) 创建 containing block，body 里 position:fixed 元素改以
    // body 为定位基准（而非 viewport），应用网页自己的 fixed 顶部标题栏（fixed top:0）被顶到 y=34
    // （内容区顶部），与 fnos-desktop bar（y=0~34）形成"两层标题栏"。修复：应用窗口里，把 body 里
    // fixed 且吸附顶部（top:0）且未同时贴底（bottom 非 0）的元素反向补偿 translateY(-34px)，使其
    // 回到 y=0，被 fnos-desktop bar（z-index 更高）覆盖，只保留一层标题栏。
    if (typeof process !== 'undefined' && Array.isArray(process.argv) && (process.argv.indexOf('--fnos-app-window') >= 0 || process.argv.indexOf('--fnos-live-window') >= 0)) {
      try {
        // v2.17.11: page-owned fixed top bar is pushed DOWN below the titlebar.
        // v2.15.52 used to lift it up and hide it under the bar (page body then ran
        // into y=0 and got covered), v2.17.9 stopped moving it at all. UPS-style pages
        // keep such a bar inside a transform/filter ancestor, so the body offset cannot
        // carry it and it stays at y=0 under the titlebar. Rule: if it still lands inside
        // the titlebar band, push it down by the bar height; skip bars already below.
        const __compFixedTop = (el) => {
          try {
            if (!el || el.nodeType !== 1) return;
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed') return;
            const __top = parseFloat(cs.top), __bot = parseFloat(cs.bottom);
            if (!isFinite(__top) || __top < 0 || __top > 40) return;
            if (__bot === 0) return;
            const r = el.getBoundingClientRect();
            const __h = Math.round(r.height);
            if (!__h || __h <= 0 || __h > 120) return;
            const bh = __barHeight();
            if (r.top >= bh - 2) return;
            const want = '0 ' + bh + 'px';
            if (el.style.getPropertyValue('translate') === want && el.style.getPropertyPriority('translate') === 'important') return;
            el.style.setProperty('translate', want, 'important');
          } catch (_) {}
        };
        const __scanFixedTop = () => {
          try { const all = document.querySelectorAll('body *'); for (let i = 0; i < all.length; i++) __compFixedTop(all[i]); } catch (_) {}
        };
        __scanFixedTop();
        // DOM 变化 / 窗口尺寸变化时合并重扫（300ms 节流）——顶栏高度随宽度断点变化，必须重算
        let __compT = 0;
        const __queueComp = () => {
          if (__compT) return;
          __compT = setTimeout(() => { __compT = 0; __scanFixedTop(); }, 300);
        };
        try {
          const __fmo = new MutationObserver(__queueComp);
          __fmo.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch (_) {}
        try { window.addEventListener('resize', __queueComp, { passive: true }); } catch (_) {}
        try { window.addEventListener('load', __queueComp, { once: true }); } catch (_) {}
      } catch (_) {}
    }

        // ---- 显隐：document 级鼠标 Y 判定（比 mouseenter 可靠：鼠标已在顶部区域、或元素层级
        //      被其它内容干扰时也能触发）。进入顶部 34px 显示，移出后延迟隐藏（常驻模式永不隐藏） ----
        let __inTop = false;
        // v2.24.12（用户反馈：自动隐藏后鼠标触顶立即弹出太灵敏）——触顶需停留 1.5s 才调出标题栏；
        // 停留期间移出顶部即取消，避免误弹。常驻模式（非自动隐藏）照旧立即显示。
        let __topShowTimer = null;
        const __cancelTopShow = () => { if (__topShowTimer) { try { clearTimeout(__topShowTimer); } catch (_) {} __topShowTimer = null; } };
        const __scheduleTopShow = () => {
          if (!AUTO_HIDE) { __cancelTopShow(); show(bar); return; }
          if (__topShowTimer) return;
          __topShowTimer = setTimeout(() => { __topShowTimer = null; try { show(bar); } catch (_) {} }, 1500);
        };
        document.addEventListener('mousemove', (ev) => {
          try {
            const inTop = (ev.clientY != null && ev.clientY <= 34);
            if (inTop && !__inTop) { __inTop = true; __scheduleTopShow(); }
            else if (!inTop && __inTop) { __inTop = false; __cancelTopShow(); scheduleHide(bar, 450); }
          } catch (_) {}
        }, true);
        // 元素级 hover 兜底（某些场景 mousemove target 为窗口按钮等不冒泡到 document 时）
        bar.addEventListener('mouseenter', () => { __cancelTopShow(); show(bar); });
        bar.addEventListener('mouseleave', () => scheduleHide(bar, 450));
        hot.addEventListener('mouseenter', () => { __inTop = true; __scheduleTopShow(); });
        hot.addEventListener('mouseleave', () => { __inTop = false; __cancelTopShow(); scheduleHide(bar, 450); });

        // ALT 键调出标题栏（自动隐藏模式下），2.2s 后收回
        window.addEventListener('keydown', (ev) => {
          try {
            if (ev.key === 'Alt' || ev.altKey) {
              show(bar);
              if (AUTO_HIDE) scheduleHide(bar, 2200);
            }
          } catch (_) {}
        }, true);

        // 初始状态：先应用材质/颜色样式，再按自动隐藏决定显隐
        applyStyle(bar);
        if (AUTO_HIDE) hide(bar); else show(bar);

        // ---- 防 SPA 重渲染清除：v2.10.0 r30（问题1 次因）全件检查+整件重建+解除防重入死锁 ----
        // 旧实现只查 bar+hotzone 两个 id：按钮子节点被 SPA 移除不触发重建；hotzone 缺而 bar 在时
        // disconnect+build() 撞 build() 防重入早退 → 拖动/按钮永久失效（自愈缺口实锤）。现全件
        // 检查（bar/hotzone/☰/—□✕），缺失即先清残留再整体重建——残留清掉后防重入早退不再拦。
        try {
          const __need = isMac ? ['fnos-titlebar', 'fnos-titlebar-hotzone', 'fnos-tb-menu'] : ['fnos-titlebar', 'fnos-titlebar-hotzone', 'fnos-tb-menu', 'fnos-tb-min', 'fnos-tb-max', 'fnos-tb-close'];
          const mo = new MutationObserver(() => {
            try {
              let __gone = false;
              for (let i = 0; i < __need.length; i++) { if (!document.getElementById(__need[i])) { __gone = true; break; } }
              if (!__gone) return;
              const __now = Date.now();
              if (window.__fnosTbHealAt && __now - window.__fnosTbHealAt < 700) return; // 防重建风暴
              window.__fnosTbHealAt = __now;
              mo.disconnect();
              try { const o = document.getElementById('fnos-titlebar'); if (o && o.parentNode) o.parentNode.removeChild(o); } catch (_) {}
              try { const o = document.getElementById('fnos-titlebar-hotzone'); if (o && o.parentNode) o.parentNode.removeChild(o); } catch (_) {}
              build();
            } catch (_) {}
          });
          mo.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch (_) {}

        try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.injected', autoHide: AUTO_HIDE, path: (location.pathname || '').slice(0, 50) }); } catch (_) {}
      } catch (e) {
        try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.build.ex', err: String((e && e.message) || e) }); } catch (_) {}
      }
    }

    // ============ v2.4.9 内嵌窗形态标题栏（用户反馈 8：桌面内嵌窗型自动适配） ============
    // 样式基准：fnOS 桌面内嵌窗（Lucky iframe 窗口）——纯黑底 34px，左侧应用 logo+标题，
    // 右侧 ↻ 刷新 / — 最小化 / □ 最大化 / ✕ 关闭 四钮，常驻不隐藏。（r15 硬规则：内嵌窗禁止剥离成跳出窗，移除 ↗）
    function buildEmbed() {
      try {
        if (document.getElementById('fnos-titlebar')) return;
        const root2 = root();
        // 顶部拖动热区（与普通标题栏同款）
        const hot = document.createElement('div');
        hot.id = 'fnos-titlebar-hotzone';
        hot.setAttribute('aria-hidden', 'true');
        hot.style.cssText = 'position:fixed;top:0;left:0;right:0;height:6px;z-index:2147483646;pointer-events:auto;background:transparent;-webkit-app-region:drag;user-select:none;';
        root2.appendChild(hot);
        const bar = document.createElement('div');
        bar.id = 'fnos-titlebar'; // 注意：id 必须是 fnos-titlebar（自愈全件检查与 build 防重入检测依赖）；r18 的 fnos-tb-bar 双赋值被覆盖=死代码，v2.10.0 r30 清理
        bar.setAttribute('data-fnos-tb', '1'); // v2.10.0 r30：补齐清扫豁免标记（与普通标题栏一致，KEEP [data-fnos-tb] 命中）
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:' + __skinHeight + 'px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;pointer-events:auto;background:rgba(18,22,30,0.30);border-radius:6px;-webkit-app-region:drag;user-select:none;';
        // 左：应用 logo + 标题
        const left = document.createElement('div');
        left.style.cssText = '-webkit-app-region:drag;pointer-events:auto;display:flex;align-items:center;gap:8px;height:34px;padding-left:' + (isMac ? '86px' : '12px') + ';overflow:hidden;';
        const logo = document.createElement('img');
        logo.id = 'fnos-embed-logo';
        logo.style.cssText = 'width:18px;height:18px;border-radius:4px;flex:0 0 auto;object-fit:cover;display:none;';
        const titleEl = document.createElement('span');
        titleEl.id = 'fnos-embed-title';
        titleEl.style.cssText = 'color:rgba(255,255,255,0.95);font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60vw;';
        left.appendChild(logo);
        left.appendChild(titleEl);
        // 右：↻ — □ ✕ 四钮（r15 硬规则移除 ↗ 跳出：内嵌窗绝不剥离 fnOS 框架转独立跳出窗）
        const btns = document.createElement('div');
        btns.style.cssText = '-webkit-app-region:drag;pointer-events:auto;display:flex;align-items:stretch;height:34px;margin-right:8px;';
        const mkBtn = (id, titleTxt, svg, hoverBg) => {
          const b = document.createElement('button');
          b.id = id;
          b.title = titleTxt;
          b.style.cssText = 'width:40px;height:34px;border:none;outline:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;-webkit-app-region:no-drag;flex:0 0 auto;';
          b.innerHTML = svg;
          const svgEl = b.querySelector('svg');
          if (svgEl) svgEl.style.cssText = 'display:block;pointer-events:none;flex-shrink:0;';
          b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
          b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
          return b;
        };
        const W = 'stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"';
        const reloadBtn = mkBtn('fnos-tb-reload', '刷新', '<svg width="13" height="13" viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6" ' + W + '/><path d="M13 2.5V5h-2.5" ' + W + '/></svg>', 'rgba(255,255,255,0.18)');
        const minBtn = mkBtn('fnos-tb-min', '最小化', '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M3 8H13" ' + W + '/></svg>', 'rgba(255,255,255,0.18)');
        const maxBtn = mkBtn('fnos-tb-max', '最大化/还原', '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2" ' + W + '/></svg>', 'rgba(255,255,255,0.18)');
        const closeBtn = mkBtn('fnos-tb-close', '关闭', '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 4L12 12M12 4L4 12" ' + W + '/></svg>', '#E81123');
        // 功能：↻ 刷新；—/□/✕ 走现成 window-minimize/maximize/close IPC（零新增 IPC）。
        // —/□/✕ 走现成 window-minimize/maximize/close IPC（零新增 IPC）
        reloadBtn.addEventListener('click', () => { try { location.reload(); } catch (_) {} });
        minBtn.addEventListener('click', () => { try { ipcRenderer.send('window-minimize'); } catch (_) {} });
        maxBtn.addEventListener('click', () => { try { ipcRenderer.send('window-maximize'); } catch (_) {} });
        closeBtn.addEventListener('click', () => { try { ipcRenderer.send('window-close'); } catch (_) {} });
        btns.appendChild(reloadBtn); if (!isMac) { btns.appendChild(minBtn); btns.appendChild(maxBtn); btns.appendChild(closeBtn); }
        bar.appendChild(left);
        const dragStrip = document.createElement('div');
        dragStrip.id = 'fnos-tb-dragstrip';
        // v2.17.46：标题栏中部空白区不再用 -webkit-app-region:drag（drag 区的 mousedown 会被系统
        // move loop 接管、dblclick 不派发，v2.17.45 的 mousedown 时间戳双击判定因此失效——首次
        // mousedown 就 send('window-drag')，主进程 w.startDrag() 同步阻塞，第二次 mousedown 收不到）。
        // 改为普通可交互层：移动超 3px 才发起原生拖拽（纯点击/双击不被打断），dblclick 走 window-maximize。
        // v2.17.47：上一版漏了主进程实现——window-drag 里调用的 w.startDrag() 不是 BrowserWindow
        // 的 API，永远抛异常被 catch 吞掉，于是本层彻底不能拖（用户反馈：主程序和应用窗都拖不动）。
        // 现在拖动改为主进程 setPosition 跟随鼠标（win-drag-start/move/end）。
        dragStrip.style.cssText = 'flex:1;height:100%;min-width:20px;-webkit-app-region:no-drag;pointer-events:auto;cursor:default;';
        (function () {
          const W = window;
          W.__fnosDsDown = null;
          // v2.17.47：按住标题栏时把指针捕获到本层，鼠标甩出窗口/窗口追不上鼠标时仍持续收到
          // 移动事件（否则 Windows 停止投递 WM_MOUSEMOVE，拖动会中途卡住）。
          dragStrip.addEventListener('pointerdown', function (e) {
            try { dragStrip.setPointerCapture(e.pointerId); } catch (_) {}
          });
          dragStrip.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            W.__fnosDsDown = { x: (e.screenX || 0), y: (e.screenY || 0) };
            W.__fnosDsDrag = false;
            // v2.17.47：本层是 no-drag 交互层，原生 -webkit-app-region:drag 用不了，
            // 改由主进程真实拖动（main.js win-drag-start/win-drag-move/win-drag-end）。
            try { ipcRenderer.send('win-drag-start', { sx: (e.screenX || 0), sy: (e.screenY || 0) }); } catch (_) {}
          });
          dragStrip.addEventListener('dblclick', function (e) {
            W.__fnosDsDown = null; W.__fnosDsDrag = true;
            try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
            try { ipcRenderer.send('window-maximize'); } catch (_) {}
          });
          if (!W.__fnosDsHooked) {
            W.__fnosDsHooked = true; W.__fnosDsDrag = false;
            W.__fnosDsRaf = 0; W.__fnosDsPend = null;
            const __fwd = function (e) {
              if (!W.__fnosDsDown) return;
              if (e.buttons === 0) { W.__fnosDsDown = null; W.__fnosDsDrag = false; return; }
              try {
                if (Math.abs((e.screenX || 0) - W.__fnosDsDown.x) > 3 || Math.abs((e.screenY || 0) - W.__fnosDsDown.y) > 3) W.__fnosDsDrag = true;
                if (!W.__fnosDsDrag) return;
                // 每次移动都把最新屏幕坐标交给主进程（rAF 合并，60fps 上限）
                W.__fnosDsPend = { sx: (e.screenX || 0), sy: (e.screenY || 0) };
                if (!W.__fnosDsRaf) {
                  W.__fnosDsRaf = (W.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
                    W.__fnosDsRaf = 0;
                    const p = W.__fnosDsPend;
                    W.__fnosDsPend = null;
                    if (!p) return;
                    try { ipcRenderer.send('win-drag-move', p); } catch (_) {}
                  });
                }
              } catch (_) {}
            };
            W.addEventListener('mousemove', __fwd, true);
            W.addEventListener('pointermove', __fwd, true);
            const __end = function () {
              if (W.__fnosDsDown) { try { ipcRenderer.send('win-drag-end'); } catch (_) {} }
              W.__fnosDsDown = null; W.__fnosDsDrag = false; W.__fnosDsPend = null;
            };
            W.addEventListener('mouseup', __end, true);
            W.addEventListener('pointerup', __end, true);
            W.addEventListener('pointercancel', __end, true);
          }
        })();
        bar.appendChild(dragStrip);
        bar.appendChild(btns);
        __attachSkinLayers(bar);
        root2.appendChild(bar);
        // 原生拖拽兜底（与普通标题栏同款）
        // v2.17.45：双击标题栏最大化/还原（drag region 上 dblclick 不触发，改用 mousedown
        // 时间/位置间隔自判双击）。
        let __lastTbDown2 = 0, __lastTbDownX2 = 0, __lastTbDownY2 = 0;
        const startNativeDrag = (ev) => {
          try {
            if (ev.button !== 0) return;
            const t = ev.target;
            if (t && t.closest && t.closest('#fnos-tb-dragstrip, button')) return;
            const __now = Date.now();
            const __sx = ev.screenX || 0, __sy = ev.screenY || 0;
            if (__now - __lastTbDown2 < 450 && Math.abs(__sx - __lastTbDownX2) < 8 && Math.abs(__sy - __lastTbDownY2) < 8) {
              __lastTbDown2 = 0;
              try { ipcRenderer.send('window-maximize'); } catch (_) {}
              return;
            }
            __lastTbDown2 = __now;
            __lastTbDownX2 = __sx;
            __lastTbDownY2 = __sy;
            ipcRenderer.send('window-drag');
          } catch (_) {}
        };
        hot.addEventListener('mousedown', startNativeDrag);
        bar.addEventListener('mousedown', startNativeDrag);
        // 标题/logo 同步：SPA 应用延迟设置 <title>/favicon，限量轮询自愈
        const syncMeta = () => {
          try {
            const t0 = document.title || '';
            if (t0 && t0 !== titleEl.textContent) titleEl.textContent = t0;
            let icon = '';
            try { const link = document.querySelector('link[rel*="icon"]'); if (link && link.href) icon = link.href; } catch (_) {}
            if (icon && logo.getAttribute('src') !== icon) { logo.src = icon; logo.style.display = 'block'; }
          } catch (_) {}
        };
        syncMeta();
        try {
          let __ticks = 0;
          const __iv = setInterval(() => { try { syncMeta(); if (++__ticks > 400) clearInterval(__iv); } catch (_) {} }, 1500);
        } catch (_) {}
        // 防 SPA 重渲染清除：v2.10.0 r30（问题1 次因）全件检查+整件重建+解除防重入死锁（与普通标题栏同款）
        try {
          const __need = isMac ? ['fnos-titlebar', 'fnos-titlebar-hotzone', 'fnos-tb-reload'] : ['fnos-titlebar', 'fnos-titlebar-hotzone', 'fnos-tb-reload', 'fnos-tb-min', 'fnos-tb-max', 'fnos-tb-close'];
          const mo = new MutationObserver(() => {
            try {
              let __gone = false;
              for (let i = 0; i < __need.length; i++) { if (!document.getElementById(__need[i])) { __gone = true; break; } }
              if (!__gone) return;
              const __now = Date.now();
              if (window.__fnosTbHealAt && __now - window.__fnosTbHealAt < 700) return; // 防重建风暴
              window.__fnosTbHealAt = __now;
              mo.disconnect();
              try { const o = document.getElementById('fnos-titlebar'); if (o && o.parentNode) o.parentNode.removeChild(o); } catch (_) {}
              try { const o = document.getElementById('fnos-titlebar-hotzone'); if (o && o.parentNode) o.parentNode.removeChild(o); } catch (_) {}
              buildEmbed();
            } catch (_) {}
          });
          mo.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch (_) {}
        try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.injected', style: 'embed', path: (location.pathname || '').slice(0, 50) }); } catch (_) {}
      } catch (e) {
        try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.embed.ex', err: String((e && e.message) || e) }); } catch (_) {}
      }
    }

    // ============ v2.0.0 左侧悬浮账号切换面板 ============
    function buildAccountSwitcher() {
      try {
        if (document.getElementById('fnos-account-switcher')) return;

        const panel = document.createElement('div');
        panel.id = 'fnos-account-switcher';
        panel.innerHTML = `
          <div id="fnos-acct-trigger" title="切换账号">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
          <div id="fnos-acct-dropdown" class="fnos-acct-hidden">
            <div class="fnos-acct-header">已登录账号</div>
            <div id="fnos-acct-list"></div>
            <div id="fnos-acct-add" class="fnos-acct-item">+ 登录其它账号</div>
          </div>
        `;

        // iOS27 液态玻璃风格
        const style = document.createElement('style');
        style.textContent = `
          #fnos-account-switcher {
            position: fixed; left: 8px; top: 50%; transform: translateY(-50%);
            z-index: 99999; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          }
          #fnos-acct-trigger {
            width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;
            background: rgba(255,255,255,0.10);
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 50%;
            color: rgba(255,255,255,0.72); cursor: pointer;
            box-shadow: 0 4px 16px rgba(0,0,0,0.25);
            user-select: none;
            transition: background 0.25s, color 0.25s, box-shadow 0.25s, transform 0.25s;
          }
          #fnos-acct-trigger:hover {
            background: rgba(255,255,255,0.18); color: #fff;
            transform: scale(1.06);
            box-shadow: 0 6px 20px rgba(0,0,0,0.35);
          }
          #fnos-acct-trigger:active { cursor: grabbing; }
          #fnos-acct-dropdown {
            position: absolute; left: 48px; top: 50%; transform: translateY(-50%);
            min-width: 200px; max-width: 280px;
            background: rgba(30, 27, 46, 0.85);
            backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2);
            padding: 8px 0;
            transition: opacity 0.2s, transform 0.2s;
          }
          .fnos-acct-hidden { opacity: 0 !important; pointer-events: none !important; }
          #fnos-account-switcher.acct-on-right #fnos-acct-dropdown { left: auto; right: 48px; }
          .fnos-acct-header {
            padding: 8px 16px 6px; font-size: 11px; color: rgba(255,255,255,0.4);
            text-transform: uppercase; letter-spacing: 0.5px;
          }
          .fnos-acct-item {
            padding: 8px 16px; cursor: pointer; font-size: 13px;
            color: rgba(255,255,255,0.8); display: flex; align-items: center; gap: 8px;
            transition: background 0.15s;
          }
          .fnos-acct-item:hover { background: rgba(255,255,255,0.08); }
          .fnos-acct-item.active { color: #60a5fa; }
          .fnos-acct-item .acct-dot {
            width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
          }
          .fnos-acct-item.active .acct-dot { background: #60a5fa; }
          .fnos-acct-item:not(.active) .acct-dot { background: rgba(255,255,255,0.2); }
          .fnos-acct-item .acct-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .fnos-acct-item .acct-remove {
            opacity: 0; font-size: 14px; color: rgba(255,255,255,0.3);
            transition: opacity 0.15s, color 0.15s; padding: 2px 4px;
          }
          .fnos-acct-item:hover .acct-remove { opacity: 1; }
          .fnos-acct-item .acct-remove:hover { color: #f87171; }
          #fnos-acct-add { color: rgba(255,255,255,0.5); border-top: 1px solid rgba(255,255,255,0.08); margin-top: 4px; padding-top: 10px; }
        `;

        // 事件绑定
        const trigger = panel.querySelector('#fnos-acct-trigger');
        const dropdown = panel.querySelector('#fnos-acct-dropdown');
        let hideTimer = null;

        function showDropdown() {
          clearTimeout(hideTimer);
          dropdown.classList.remove('fnos-acct-hidden');
          loadAccountList();
        }
        function hideDropdown() {
          hideTimer = setTimeout(() => dropdown.classList.add('fnos-acct-hidden'), 300);
        }

        // v2.24.12：可拖动圆形悬浮球（位置下次启动还原）
        // v3.0.23（用户反馈：启动后位置老变、经常掉到左下角拉不出来、贴边被裁掉一半）——
        //   ① fixed 在 body 被注入 transform 之后是以 body 为包含块：坐标系原点在 body 顶部、
        //      可用高度是 body 高度（视口 - 标题栏）。此前用 window.innerHeight 当上限，球能被
        //      放到 body 之外 34px，被窗口底部裁得只剩一条边 → 看起来"贴在角落拉不出来"；
        //   ② 拖动时把 getBoundingClientRect().top（屏幕坐标）当作 body 内坐标使用，每拖一次
        //      就往下漂 34px，越用越靠底；
        //   ③ 窗口 resize 时把夹紧后的绝对像素写回存储，反复抖动把位置一点点带歪。
        // 现在统一：body 内坐标 + 归一化比例持久化（同时同步主进程，换 origin 也记得住）。
        const ACCT_POS_KEY = 'fnos-acct-ball-pos';
        const ACCT_BALL = 40;
        const ACCT_EDGE = 6;   // 贴边也留 6px，不给窗口圆角/边框裁掉的机会
        function acctBox() {
          let w = window.innerWidth || 0;
          let h = window.innerHeight || 0;
          try {
            const br = document.body.getBoundingClientRect();
            if (br.height > 120) h = Math.round(br.height);
            if (br.width > 120) w = Math.round(br.width);
          } catch (_) {}
          return { w: Math.max(80, w), h: Math.max(80, h) };
        }
        function acctRange() {
          const box = acctBox();
          return {
            box: box,
            mx: Math.max(1, box.w - ACCT_BALL - ACCT_EDGE * 2),
            my: Math.max(1, box.h - ACCT_BALL - ACCT_EDGE * 2)
          };
        }
        function applyAcctSide() {
          try {
            const r = panel.getBoundingClientRect();
            panel.classList.toggle('acct-on-right', (r.left + r.width / 2) > window.innerWidth / 2);
          } catch (_) {}
        }
        function placeAcctBall(x, y) {
          const rg = acctRange();
          const nx = Math.max(ACCT_EDGE, Math.min(ACCT_EDGE + rg.mx, x));
          const ny = Math.max(ACCT_EDGE, Math.min(ACCT_EDGE + rg.my, y));
          panel.style.left = nx + 'px';
          panel.style.top = ny + 'px';
          panel.style.transform = 'none';
          applyAcctSide();
          return { x: nx, y: ny };
        }
        // 当前在 body 坐标系里的位置：优先读自己写的 style，避免屏幕坐标/transform 混算
        function acctCur() {
          let x = parseFloat(panel.style.left);
          let y = parseFloat(panel.style.top);
          if (!isFinite(x) || !isFinite(y)) {
            let lx = 0, ly = 0;
            try {
              const r = panel.getBoundingClientRect();
              const br = document.body.getBoundingClientRect();
              lx = r.left - br.left; ly = r.top - br.top;
            } catch (_) {}
            if (!isFinite(x)) x = lx;
            if (!isFinite(y)) y = ly;
          }
          return { x: x, y: y };
        }
        function acctSave() {
          try {
            const cur = acctCur();
            const rg = acctRange();
            const p = {
              x: cur.x, y: cur.y,
              fx: Math.max(0, Math.min(1, (cur.x - ACCT_EDGE) / rg.mx)),
              fy: Math.max(0, Math.min(1, (cur.y - ACCT_EDGE) / rg.my))
            };
            try { localStorage.setItem(ACCT_POS_KEY, JSON.stringify(p)); } catch (_) {}
            // 主进程按比例再存一份：不同 NAS 地址 / 不同分区的 localStorage 互不相通，
            // 只靠 localStorage 会出现"换个页面登录，球又回默认位置"的错觉
            try { ipcRenderer.send('ball:set-pos', { fx: p.fx, fy: p.fy }); } catch (_) {}
          } catch (_) {}
        }
        function acctRestore(fx, fy) {
          const rg = acctRange();
          return placeAcctBall(ACCT_EDGE + Math.max(0, Math.min(1, fx)) * rg.mx,
                               ACCT_EDGE + Math.max(0, Math.min(1, fy)) * rg.my);
        }
        function acctInitPos() {
          let fx = null, fy = null;
          try {
            const sp = ipcRenderer.sendSync('ball:get-pos');
            if (sp && typeof sp.fx === 'number' && typeof sp.fy === 'number') { fx = sp.fx; fy = sp.fy; }
          } catch (_) {}
          if (fx === null) {
            try {
              const saved = JSON.parse(localStorage.getItem(ACCT_POS_KEY) || 'null');
              if (saved && typeof saved.fx === 'number' && typeof saved.fy === 'number') {
                fx = saved.fx; fy = saved.fy;
              }
              // 旧版存的是绝对像素（{x,y}）：那些值多半是被上一版裁到窗口外/被 34px 偏移
              // 带歪的脏数据，直接沿用会把这个 bug 一直继承下去，所以不迁移 —— 首次升级
              // 统一回到默认位置一次，之后用户拖动的位置才会被记住。
            } catch (_) {}
          }
          if (fx === null) { fx = 1; fy = 0.5; }   // 默认贴右侧中部（左侧是应用列表，最容易被挡）
          acctRestore(fx, fy);
        }

        let acctDrag = null;
        let acctJustDragged = false;
        trigger.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          const cur = acctCur();
          acctDrag = { sx: e.clientX, sy: e.clientY, ox: cur.x, oy: cur.y, moved: false };
          e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
          if (!acctDrag) return;
          const dx = e.clientX - acctDrag.sx, dy = e.clientY - acctDrag.sy;
          if (!acctDrag.moved && (Math.abs(dx) + Math.abs(dy) < 4)) return;
          acctDrag.moved = true;
          dropdown.classList.add('fnos-acct-hidden');
          placeAcctBall(acctDrag.ox + dx, acctDrag.oy + dy);
        }, true);
        document.addEventListener('mouseup', () => {
          if (!acctDrag) return;
          const moved = acctDrag.moved;
          acctDrag = null;
          if (!moved) return;
          acctJustDragged = true;
          setTimeout(() => { acctJustDragged = false; }, 0);
          try {
            const cur = acctCur();
            const rg = acctRange();
            let nx = cur.x, ny = cur.y;
            // 靠近左右边缘吸附（吸附后仍留 ACCT_EDGE，只贴不藏），上下贴顶/贴底同理
            if (cur.x < 24) nx = ACCT_EDGE;
            else if (rg.box.w - (cur.x + ACCT_BALL) < 24) nx = ACCT_EDGE + rg.mx;
            if (cur.y < 24) ny = ACCT_EDGE;
            else if (rg.box.h - (cur.y + ACCT_BALL) < 24) ny = ACCT_EDGE + rg.my;
            placeAcctBall(nx, ny);
            acctSave();
          } catch (_) {}
        }, true);
        // 窗口尺寸变化：按比例跟随；不再把夹紧后的绝对值写回存储，避免反复抖动累积漂移
        let __acctBox = acctBox();
        window.addEventListener('resize', () => {
          try {
            const cur = acctCur();
            const mx0 = Math.max(1, __acctBox.w - ACCT_BALL - ACCT_EDGE * 2);
            const my0 = Math.max(1, __acctBox.h - ACCT_BALL - ACCT_EDGE * 2);
            const fx = (cur.x - ACCT_EDGE) / mx0;
            const fy = (cur.y - ACCT_EDGE) / my0;
            __acctBox = acctBox();
            acctRestore(fx, fy);
          } catch (_) {}
        });
        // 早期 body 高度可能还是 0，等布局有高度再放，避免球先闪到左上角
        if (acctBox().h >= 200) acctInitPos();
        else setTimeout(() => { try { acctInitPos(); } catch (_) {} }, 80);
        // 标题栏高度注入 / 界面缩放会让 body 最终高度晚一步确定，稳定后再校一次
        setTimeout(() => { try { acctInitPos(); } catch (_) {} }, 400);
        try { window.addEventListener('load', () => { setTimeout(() => { try { acctInitPos(); } catch (_) {} }, 120); }); } catch (_) {}

        trigger.addEventListener('mouseenter', () => { if (!acctDrag) showDropdown(); });
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          if (acctJustDragged) return;
          if (dropdown.classList.contains('fnos-acct-hidden')) showDropdown();
          else hideDropdown();
        });
        panel.addEventListener('mouseleave', hideDropdown);

        async function loadAccountList() {
          try {
            const listEl = panel.querySelector('#fnos-acct-list');
            // 通过 fnos 全局对象调用（preload 暴露的）
            let accounts = [];
            try {
              const res = await (window.fnApi ? window.fnApi.listAccounts() : ipcRenderer.invoke('account:list'));
              if (res && res.success) accounts = res.data || [];
            } catch (_) {}
            
            listEl.innerHTML = '';
            if (accounts.length === 0) {
              listEl.innerHTML = '<div style="padding:8px 16px;font-size:12px;color:rgba(255,255,255,0.3)">暂无已登录账号</div>';
              return;
            }
            accounts.forEach(acct => {
              const item = document.createElement('div');
              item.className = 'fnos-acct-item' + (acct.isActive ? ' active' : '');
              item.innerHTML = `
                <span class="acct-dot"></span>
                <span class="acct-label">${acct.label || acct.origin || '未知'}</span>
                <span class="acct-remove" title="移除账号">×</span>
              `;
              item.querySelector('.acct-label').addEventListener('click', () => {
                if (!acct.isActive) {
                  try {
                    if (window.fnApi) window.fnApi.switchAccount(acct.origin);
                    else ipcRenderer.invoke('account:switch', { origin: acct.origin });
                  } catch (_) {}
                  hideDropdown();
                }
              });
              item.querySelector('.acct-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('确定移除账号 ' + (acct.label || acct.origin) + '？')) {
                  try {
                    if (window.fnApi) window.fnApi.removeAccount(acct.id);
                    else ipcRenderer.invoke('account:remove', { accountId: acct.id });
                  } catch (_) {}
                  loadAccountList();
                }
              });
              listEl.appendChild(item);
            });
          } catch (_) {}
        }

        // 添加账号按钮
        panel.querySelector('#fnos-acct-add').addEventListener('click', () => {
          try {
            if (window.fnos) window.fnos.backToConnect && window.fnos.backToConnect();
            else ipcRenderer.invoke('auth:back-to-connect');
          } catch (_) {}
          hideDropdown();
        });

        document.body.appendChild(style);
        document.body.appendChild(panel);
        // v3.0.23：设置页「隐藏悬浮球」开关 —— 隐藏后完全让出那块区域
        try {
          window.__fnApplyBallHidden = function (h) {
            var shown = (h !== true);
            panel.style.display = shown ? '' : 'none';
            if (shown) { try { acctInitPos(); } catch (_) {} }
          };
          window.__fnApplyBallHidden(TB.hideAccountBall === true);
        } catch (_) {}
      } catch (_) {}
    }

    
    // v2.17.10：内容区让位强制保障 —— 标题栏底边 = 内容区上边沿。
    // build() 里靠 <style> 注入的 html>body{transform:translateY(34px)}，在部分应用页面会被
    // 页面自身的 html/body 样式（同特异性但后加载）或运行时内联样式压过，内容仍从窗口顶铺满，
    // 标题栏浮在内容画布顶部 34px 之上 —— 这就是规范禁止的「标题栏绘制在内容画布内部」
    // （UPS「状态监控/仪表盘」头部、飞牛桌面管理工具壁纸铺满窗口即此形态）。
    // 改用内联 !important 直设（优先级高于任何样式表）+ 变化自愈 + 兜底巡检，
    // 保证任何窗口形态下内容区上边沿都落在标题栏底边，标题栏区域独占、不被内容背景侵入。
    // v2.17.14: browser-style zoom for the main window.
    // Only the page content zooms; the titlebar keeps its pixel size because it carries
    // zoom:calc(1 / var(--fnos-f)) and its width carries calc(100vw * var(--fnos-f)).
    // __fnos-f tracks the live zoomFactor, so both stay pixel-identical at any zoom.
    // Ctrl + wheel / Ctrl + (+ - 0) are handled here because menu accelerators do not fire
    // on a frameless window with a hidden menu bar.
    const __setupZoomControls = () => {
      try {
        const __zv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
        const __isAppWin = __zv.indexOf('--fnos-app-window') >= 0 || __zv.indexOf('--fnos-live-window') >= 0;
        const __isShell = __zv.indexOf('--fnos-shell') >= 0 && !__isAppWin;
        if (!__isAppWin && !__isShell) return;
        if (typeof window === 'undefined' || window.top !== window) return;
        let wf = null;
        try { wf = require('electron').webFrame; } catch (_) {}
        if (!wf || typeof wf.setZoomFactor !== 'function') return;
        const ZMIN = 0.5, ZMAX = 2.5, ZSTEP = 1.1;
        const zclamp = (v) => Math.max(ZMIN, Math.min(ZMAX, Math.round(v * 1000) / 1000));
        // v2.17.20: 缩放比持久化。key 按窗口身份区分：主窗口固定 shell；应用/直播窗口用
        // origin+pathname（SPA 内部路由变化不影响，启动时算一次），不同应用互不覆盖。
        // v2.17.22: key 只取 pathname 的第一段。music 应用是真实导航（/music -> /music/login
        // -> /music/settings），旧写法把整段 path 拼进 key，一导航就变成新 key、查不到已存值，
        // 于是「启动时还原了、过一会又变大/变小」——实际是导航后重新按 1.0 起算。
        let zkey = 'shell';
        if (__isAppWin) {
          try {
            const seg = String(location.pathname || '').split('/').filter(Boolean)[0] || '';
            zkey = 'app:' + String(location.origin || '') + (seg ? '/' + seg : '');
          } catch (_) { zkey = 'app'; }
        }
        let __zTarget = 1;
        try {
          const zsaved = Number(ipcRenderer.sendSync('fnos:zoom-get', zkey)) || 0;
          if (zsaved > 0) __zTarget = zclamp(zsaved);
        } catch (_) {}
        const zsave = (v) => { try { ipcRenderer.send('fnos:zoom-set', { key: zkey, factor: v }); } catch (_) {} };
        let __zUserAt = 0;
        let __zFixAt = 0;
        try { if (Math.abs(__zTarget - 1) > 0.001) wf.setZoomFactor(__zTarget); } catch (_) {}
        const zsync = () => {
          try {
            const zf = wf.getZoomFactor() || 1;
            if (Math.abs(zf - __zTarget) > 0.001) {
              if (Date.now() - __zUserAt < 1500) {
                // 用户刚动过缩放：菜单「视图-放大/缩小」直接改 webContents，认下这个值
                __zTarget = zclamp(zf);
                zsave(__zTarget);
              } else {
                // v2.17.22: 页面自身或引擎把 zoom 重置了（音乐登录跳转后就会这样）。
                // 这里恢复到用户设定的值且不写盘——旧实现把它当新值存了进去，于是
                // 「过一会视图大小状态丢失」并被持久化成 1.0。400ms 节流，避免页面疯狂
                // 重置时我们跟着疯狂回写。
                if (Date.now() - __zFixAt > 400) {
                  __zFixAt = Date.now();
                  try { wf.setZoomFactor(__zTarget); } catch (_) {}
                }
              }
            }
            const cur = parseFloat(document.documentElement.style.getPropertyValue('--fnos-f')) || 1;
            if (Math.abs(cur - __zTarget) > 0.001) document.documentElement.style.setProperty('--fnos-f', String(__zTarget));
          } catch (_) {}
        };
        const zset = (f) => {
          __zTarget = zclamp(f);
          __zUserAt = Date.now();
          try { wf.setZoomFactor(__zTarget); } catch (_) {}
          zsave(__zTarget);
          zsync();
        };
        try {
          window.addEventListener('wheel', (e) => {
            if (!e.ctrlKey) return;
            try { e.preventDefault(); zset((wf.getZoomFactor() || 1) * (e.deltaY < 0 ? ZSTEP : 1 / ZSTEP)); } catch (_) {}
          }, { passive: false, capture: true });
        } catch (_) {}
        try {
          window.addEventListener('keydown', (e) => {
            if (!e.ctrlKey || e.altKey || e.metaKey) return;
            try {
              const k = e.key;
              if (k === '=' || k === '+' || k === 'Add') { e.preventDefault(); zset((wf.getZoomFactor() || 1) * ZSTEP); }
              else if (k === '-' || k === '_' || k === 'Subtract') { e.preventDefault(); zset((wf.getZoomFactor() || 1) / ZSTEP); }
              else if (k === '0') { e.preventDefault(); zset(1); }
            } catch (_) {}
          }, { capture: true });
        } catch (_) {}
        zsync();
        setInterval(zsync, 120);
      } catch (_) {}
    };

    const __ensureContentOffset = () => {
      try {
        const __app = (typeof process !== 'undefined' && Array.isArray(process.argv)) &&
          (process.argv.indexOf('--fnos-app-window') >= 0 || process.argv.indexOf('--fnos-live-window') >= 0);
        if (!__app) return;
        // v2.17.20: 页面是否自带滚动容器（决定 body 要不要自己出滚动条）。轻量扫描一次后缓存，
        // 上限 1500 个元素，只在应用窗口里跑。
        let __innerScroll = null;
        let __scanAt = 0;
        const __detectInnerScroll = () => {
          // 结果缓存 1.2s：MutationObserver 会高频调 apply，但首帧 React 还没挂载完，
          // 缓存太久会把 false 钉死，缓存太短又白扫。1.2s 兼顾两者。
          const now = Date.now();
          if (__innerScroll !== null && now - __scanAt < 1200) return __innerScroll;
          __scanAt = now;
          let hit = false;
          try {
            const b = document.body;
            if (b) {
              const els = b.querySelectorAll('*');
              const n = Math.min(els.length, 1500);
              for (let i = 0; i < n; i++) {
                const el = els[i];
                if (!el || el.clientHeight < 80) continue;
                if (el.scrollHeight <= el.clientHeight + 8) continue;
                const oy = getComputedStyle(el).overflowY;
                if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') { hit = true; break; }
              }
            }
          } catch (_) {}
          __innerScroll = hit;
          return hit;
        };
        const apply = () => {
          try {
            const b = document.body; if (!b) return;
            // 值未变就不写，避免 setProperty 触发 MutationObserver 形成自激循环
            const set = (k, v) => {
              if (b.style.getPropertyValue(k) !== v || b.style.getPropertyPriority(k) !== 'important') {
                b.style.setProperty(k, v, 'important');
              }
            };
            const bh = __barHeight();
            // 标题栏下移补偿：body 整体下移，内容不被标题栏遮挡
            // v2.17.41（用户反馈：应用按 F11 全屏后窗口上部留一条透明长方形）——这里的 inline
            // !important 在层叠里压过任何样式表 !important，全屏样式表的 transform:none 根本
            // 打不过它：全屏后 body 仍下移 34px、高度仍扣 34px，顶部 34px 没有任何内容，就透出
            // 下层主窗口的标题栏。全屏态一律写满铺值，退出后自动回到 34px 补偿。
            const __fsNow = (function () { try { return document.documentElement.getAttribute('data-fnos-fs') === '1'; } catch (_) { return false; } })();
            set('transform', __fsNow ? 'none' : 'translateY(calc(' + bh + 'px / var(--fnos-f, 1)))');
            set('height', __fsNow ? '100vh' : 'calc(100vh - ' + bh + 'px / var(--fnos-f, 1))');
            set('max-height', __fsNow ? '100vh' : 'calc(100vh - ' + bh + 'px / var(--fnos-f, 1))');
            set('min-height', '0');
            set('box-sizing', 'border-box');
            // v2.17.20: 双滚动条根因——音乐/影视这类 Semi / Tailwind 布局，左右面板各自就有
            // overflow-y:auto 的滚动容器，body 再出一条滚动条就成了并排两条（用户实测：
            // 飞牛音乐放大视图后左导航与主内容区各一条）。检测到内部已有可滚动容器时，只把
            // body 自己那条藏掉（scrollbar-width:none 只隐藏滚动条，滚轮/键盘滚动能力保留），
            // 没有内部滚动容器的普通长页面仍然保留 body 滚动条。
            // v2.17.21: body 只在「确实没有别人能滚」的时候才自己出滚动条。三种情况：
            //   a) 页面内部已有滚动容器（音乐/影视的左右面板）→ body 关掉，只剩内部那一条；
            //   b) body 内容本来就没溢出 → body 关掉（留着也是空轨道）；
            //   c) body 溢出且内部没有任何可滚容器 → 保留 body 滚动，避免长页面滚不动。
            const __hasInner = __detectInnerScroll();
            const __bodyOver = b.scrollHeight > b.clientHeight + 8;
            // v2.17.22: 认证页（NAS 账号授权登录）不论溢出与否都不出滚动条——登录卡片居中
            // 显示，滚动条只会让窗口右边/底部多一道灰边。
            const __isAuthPage = /\/(signin|oauth|login)(\/|$|\?)/i.test(String(location.pathname || ''));
            const __needBodyScroll = (!__isAuthPage) && (!__hasInner) && __bodyOver;
            if (__needBodyScroll) {
              set('overflow-y', 'auto');
              b.style.removeProperty('scrollbar-width');
            } else {
              set('overflow-y', 'hidden');
              set('scrollbar-width', 'none');
            }
            try { b.classList.toggle('fnos-no-body-scroll', !__needBodyScroll); } catch (_) {}
            set('margin', '0');
          } catch (_) {}
        };
        apply();
        // 页面脚本重置 body 内联样式时立即补回（apply 幂等，不会引发循环）
        try {
          const mo = new MutationObserver(() => { apply(); });
          mo.observe(document.body, { attributes: true, attributeFilter: ['style'] });
        } catch (_) {}
        // SPA 重建 body / 换根时的兜底巡检
        try {
          let __n = 0;
          const __iv = setInterval(() => { try { apply(); if (++__n > 300) clearInterval(__iv); } catch (_) {} }, 2000);
        } catch (_) {}
      } catch (_) {}
    };

    // v2.17.32：全屏态样式——全屏时让 body 回满、去掉 20px 圆角（不加这段时窗口虽已
    // setFullScreen，顶部仍被 36px 标题栏占住、body 少 34px 高、四角圆角还露桌面）。
    // v2.17.33：标题栏不再 display:none（那样全屏后退不出时它会永久消失、窗口无法拖动），
    // 改为"悬浮"：默认收起，鼠标移到窗口顶部 34px 内滑出，移开 450ms 自动收回 —— 复用
    // build() 里已有的 AUTO_HIDE 显隐链路，只是全屏态强制启用，不改用户设置。
    const __fsBarStyle = (hidden) => {
      try {
        const b = document.getElementById('fnos-titlebar');
        if (!b) return;
        if (hidden) {
          b.style.transform = 'translateY(-100%)';
          b.style.opacity = '0';
          b.style.pointerEvents = 'none';
        } else {
          b.style.transform = 'translateY(0)';
          b.style.opacity = '1';
          b.style.pointerEvents = 'auto';
        }
      } catch (_) {}
    };
    // v2.17.41：全屏态 / 退出态的 body inline 显式落值。__ensureContentOffset 会周期性用
    // inline !important 重写 body 几何，所以进/退全屏都必须把它一起对齐，否则会出现"全屏了
    // 但 body 还下移 34px"（顶部透明长条）或"退出了但 body 还写满 100vh"。
    const __fsBody = (on) => {
      try {
        const b = document.body; if (!b) return;
        if (on) {
          b.style.setProperty('transform', 'none', 'important');
          b.style.setProperty('height', '100vh', 'important');
          b.style.setProperty('max-height', '100vh', 'important');
          b.style.setProperty('min-height', '0', 'important');
        } else {
          b.style.removeProperty('transform');
          b.style.removeProperty('height');
          b.style.removeProperty('max-height');
          b.style.removeProperty('min-height');
        }
      } catch (_) {}
    };
    // v2.17.42（用户反馈：主程序 / 应用窗口 ESC 退出全屏后，标题栏的最小化、最大化、关闭
    // 三个按钮消失，点「视图 → 强制刷新」就恢复）——两条硬结论：
    //   1) 强制刷新能恢复 ⇒ 是运行时 DOM/几何状态坏了，重建标题栏就是有效解；
    //   2) v2.17.41 只在 getBoundingClientRect() 越界时才重建，可实测"按钮看不见"时 rect
    //      照样上报正常（被上层元素盖住、被 body 的 overflow 裁掉，都不改变 rect），于是重建
    //      从来没触发过 —— 这就是上一版"修了但没修好"的地方。
    // 现在把判据换成真实可点击性：elementFromPoint 打三个按钮中心点，命中的元素不在标题栏
    // 里就认定按钮已经不可用，直接重建。另加一条几何自纠：bar 的 zoom 是 calc()，部分
    // Chromium 版本对 calc 的 zoom 不生效，此时 width:calc(100vw * --fnos-f) 会让 bar 比窗口
    // 更宽、右侧按钮被 body 的 overflow 裁掉（现象正是"左边 ☰ 还在、右边三个按钮没了"）。
    let __fsRebuildAt = 0;
    const __fsProbe = () => {
      const out = {};
      try {
        out.vw = window.innerWidth; out.vh = window.innerHeight;
        try { out.f = getComputedStyle(document.documentElement).getPropertyValue("--fnos-f").trim() || ""; } catch (_) {}
        const bar = document.getElementById("fnos-titlebar");
        if (!bar) { out.bar = null; return out; }
        const rb = bar.getBoundingClientRect();
        out.bar = [Math.round(rb.left), Math.round(rb.top), Math.round(rb.width), Math.round(rb.height)].join(",");
        out.zoom = String(bar.style.zoom || "");
        const cs = getComputedStyle(bar);
        out.cs = [cs.display, cs.opacity, cs.visibility, cs.pointerEvents].join("|");
        out.btn = [];
        ["fnos-tb-menu", "fnos-tb-min", "fnos-tb-max", "fnos-tb-close"].forEach((id) => {
          const x = document.getElementById(id);
          if (!x) { out.btn.push(id + ":none"); return; }
          const r = x.getBoundingClientRect();
          let hit = "?";
          try {
            const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            hit = el ? ((el.tagName || "").toLowerCase() + (el.id ? "#" + el.id : "")) : "null";
          } catch (_) {}
          out.btn.push(id + ":" + [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",") + "@" + hit);
        });
      } catch (_) {}
      return out;
    };
    // 标题栏按钮是否真的可用：可见 + 尺寸合理 + 在视口内 + 中心点命中标题栏自身
    const __fsOk = () => {
      try {
        const bar = document.getElementById("fnos-titlebar");
        if (!bar) return false;
        const cs = getComputedStyle(bar);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        // 自动隐藏模式下 bar 平时就收起（translateY(-100%) + opacity:0），那是用户要的效果，
        // 不能当成故障；此时只校验 DOM 与尺寸，不做可见性判定。
        const __autoHideOn = (typeof AUTO_HIDE !== "undefined") && AUTO_HIDE;
        if (!__autoHideOn && parseFloat(cs.opacity) < 0.9) return false;
        const ids = EMBED ? ["fnos-tb-close"] : ["fnos-tb-min", "fnos-tb-max", "fnos-tb-close"];
        const vw = window.innerWidth;
        const rb = bar.getBoundingClientRect();
        for (let i = 0; i < ids.length; i++) {
          const x = document.getElementById(ids[i]);
          if (!x) return false;
          const r = x.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) return false;
          if (r.left < -1 || r.right > vw + 2) return false;
          if (r.top < rb.top - 3 || r.top > rb.top + rb.height + 3) return false;
          const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          if (!el) return false;
          if (!el.closest || !el.closest("#fnos-titlebar")) return false;
        }
        try { sessionStorage.removeItem("fnos-fs-reload"); } catch (_) {}
        return true;
      } catch (_) { return false; }
    };
    const __fsRebuild = (why) => {
      try {
        const now = Date.now();
        if (now - __fsRebuildAt < 700) return false;
        __fsRebuildAt = now;
        // 关键：先摘掉全屏态属性再重建。html[data-fnos-fs="1"] #fnos-titlebar{display:none !important} 这条规则按 id 命中，属性不清掉的话新 bar 一样被藏起来，重建等于白做 —— 这正是 v2.17.41
        // 重建兜底没生效的原因之一（用户点「视图 → 强制刷新」能好，因为刷新把属性一起清了）。
        try { document.documentElement.removeAttribute("data-fnos-fs"); } catch (_) {}
        window.__fnosFsOn = false;
        __fsBody(false);
        const bar = document.getElementById("fnos-titlebar");
        const hot = document.getElementById("fnos-titlebar-hotzone");
        try { if (hot && hot.parentNode) hot.parentNode.removeChild(hot); } catch (_) {}
        try { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); } catch (_) {}
        try { if (EMBED) buildEmbed(); else build(); } catch (_) {}
        try { ipcRenderer.send("fnos:media-log", { stage: "titlebar", ev: "fs-restore-rebuild", why: String(why || ""), detail: JSON.stringify(__fsProbe()) }); } catch (_) {}
        return true;
      } catch (_) { return false; }
    };
    const __fsRestoreUI = (rebuild) => {
      try {
        const b = document.getElementById("fnos-titlebar");
        if (b) {
          b.style.removeProperty("display");
          b.style.setProperty("display", "flex");
          b.style.removeProperty("visibility");
          b.style.setProperty("transform", "translateY(0)");
          b.style.setProperty("opacity", "1");
          b.style.setProperty("pointer-events", "auto");
          // 这里不写 width / zoom：主窗标题栏是 width:calc(100vw * --fnos-f)+zoom，应用窗标题栏
          // 是 left:0;right:0 没有 width，盲设会把应用窗标题栏布局搞坏。
        }
        const hz = document.getElementById("fnos-titlebar-hotzone");
        if (hz) {
          hz.style.removeProperty("display");
          hz.style.removeProperty("opacity");
          hz.style.setProperty("pointer-events", "auto");
        }
        const ds = document.getElementById("fnos-tb-dragstrip");
        if (ds) ds.style.removeProperty("display");
        const rc = document.getElementById("fnos-resize-cover");
        if (rc) { rc.style.setProperty("display", "none"); rc.style.setProperty("pointer-events", "none"); }
        ["fnos-tb-min", "fnos-tb-max", "fnos-tb-close"].forEach((id) => {
          const x = document.getElementById(id);
          if (!x) return;
          x.style.removeProperty("transform");
          const p = x.parentElement;
          if (p && p.style) { p.style.removeProperty("width"); }
        });
        if (!rebuild) return;
        try { if (document.visibilityState !== "visible") return; } catch (_) {}
        if (__fsOk()) { window.__fnosFsMiss = 0; return; }
        window.__fnosFsMiss = (window.__fnosFsMiss || 0) + 1;
        // 现场快照先落日志，再动手修：万一这一版还没修好，这份 params 能直接指出被谁盖住。
        try { ipcRenderer.send("fnos:media-log", { stage: "titlebar", ev: "tb-miss", n: window.__fnosFsMiss, detail: JSON.stringify(__fsProbe()) }); } catch (_) {}
        __fsRebuild("not-ok");
        // v2.17.42：重建两次仍然不可用，说明坏的不是标题栏 DOM 而是页面级残留（用户实测
        // 「点视图 → 强制刷新就恢复」）。这里替用户把这步做掉：先把残留属性/内联样式清干净，
        // 再给一次重建机会；只有连续 4 次失败（约覆盖 3 秒）才真的 reload，避免把正在
        // 播放视频 / 编辑中的页面无谓刷掉。
        if (window.__fnosFsMiss >= 2) {
          try { document.documentElement.removeAttribute("data-fnos-fs"); } catch (_) {}
          try { window.__fnosFsOn = false; } catch (_) {}
          __fsBody(false);
          __fsBarStyle(false);
        }
        if (window.__fnosFsMiss >= 4) {
          window.__fnosFsMiss = 0;
          // 同一次运行里最多自动刷一次（sessionStorage 标记，刷新后若已恢复正常会在
          // __fsOk() 成功分支里清掉），避免"判定本身失效 → 无限 reload"这种灾难。
          let __once = false;
          try { __once = sessionStorage.getItem("fnos-fs-reload") === "1"; } catch (_) { __once = true; }
          if (!__once) {
            try { sessionStorage.setItem("fnos-fs-reload", "1"); } catch (_) {}
            try { ipcRenderer.send("fnos:media-log", { stage: "titlebar", ev: "fs-hard-reload" }); } catch (_) {}
            setTimeout(() => { try { location.reload(); } catch (_) {} }, 260);
          }
        }
      } catch (_) {}
    };
    // v2.17.41：渲染层全屏状态自愈。transparent + frame:false 窗口在实测里丢过
    // leave-full-screen（日志 win=3/6/8 只有 ui enter、没有任何 ui leave），一旦丢失渲染层就
    // 带着全屏样式退出——用户看到的就是"标题栏不见 + 20px 圆角变直角 + 顶部透明长条"。
    // 这里不依赖主进程：仍认为在全屏、但视口已明显小于屏幕，连续两次即自行撤销。
    const __fsSelfHeal = () => {
      try {
        if (window.__fnosFsHeal) return;
        window.__fnosFsHeal = true;
        if (__isSubFrame) return;
        try {
          const mo = new MutationObserver(() => {
            try { if (document.documentElement.getAttribute('data-fnos-fs') === '1') window.__fnosFsAt = Date.now(); } catch (_) {}
          });
          mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-fnos-fs'] });
        } catch (_) {}
        let miss = 0;
        setInterval(() => {
          try {
            if (document.documentElement.getAttribute('data-fnos-fs') !== '1') { miss = 0; return; }
            if (Date.now() - (window.__fnosFsAt || 0) < 2600) { miss = 0; return; }
            const sw = (window.screen && window.screen.width) || 0;
            const sh = (window.screen && window.screen.height) || 0;
            if (!sw || !sh) return;
            const small = (window.innerWidth < sw - 28) || (window.innerHeight < sh - 28);
            if (!small) { miss = 0; return; }
            // v2.17.53：inner* 是 CSS 像素（受页面 zoom 影响），screen 是物理像素，有缩放时上面的
            // 比较恒成立，会把「仍在全屏」误判成「已退出全屏」。这里以主进程的真实全屏状态为准：
            // 主进程说还在全屏，就不许撤销全屏样式（撤销的结果就是标题栏冒出来、圆角变直角）。
            let __fsReal = 1;
            try { __fsReal = ipcRenderer.sendSync('win-fs-state'); } catch (_) { __fsReal = 1; }
            if (__fsReal === 1) { miss = 0; return; }
            miss++;
            if (miss < 2) return;
            miss = 0;
            window.__fnosFsOn = false;
            window.__fnosFsAt = 0;
            document.documentElement.removeAttribute('data-fnos-fs');
            __fsBarStyle(!!AUTO_HIDE);
            __fsBody(false);
            __fsRestoreUI(true);
            try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar', ev: 'fs-selfheal-off' }); } catch (_) {}
          } catch (_) {}
        }, 700);
      } catch (_) {}
    };
    const __setupFullscreen = () => {
      try {
        if (!document.getElementById('fnos-tb-fullscreen-style')) {
          const st = document.createElement('style');
          st.id = 'fnos-tb-fullscreen-style';
          st.textContent = [
            // v2.17.40（用户反馈：全屏画面透出下层桌面）——此前全屏态只有几何规则，而应用窗口的 body
            // 正常态本来透明（要透出桌面壁纸给标题栏看），全屏后页面根容器若不满铺（Lucky 这类固定尺寸
            // 登录页），透明区域就把下层主程序桌面/桌面图标/系统监控面板整个透出来。只在全屏态补不透明
            // 底色 + min-width:100vw：不碰 html（html 透明是圆角的铁律），正常窗口态的透明与 20px 圆角
            // 完全不受影响；background-image 不动，页面自带背景图仍优先。
            'html[data-fnos-fs="1"]>body{transform:none !important;height:100vh !important;min-height:0 !important;max-height:100vh !important;clip-path:none !important;border-radius:0 !important;padding-top:0 !important;margin-top:0 !important;min-width:100vw !important;background-color:#05060a !important;overflow-x:hidden !important;}',
            // v2.17.41（用户反馈：主程序 F11 全屏后底部一条黑色长方形；应用全屏内容也不满铺）——
            // 全屏时 body 已经是 100vh，但正常态给页面根容器打的 max-height:calc(100vh - 34px) 兜底
            // 依然生效，把内容压到 1046，底部 34px 露出 body 的 #05060a 底色，就成了那条黑条。
            // 全屏态必须把这些"扣掉标题栏 34px"的补偿全部放开。
            'html[data-fnos-fs="1"]>body .h-screen,html[data-fnos-fs="1"]>body .h-dvh,html[data-fnos-fs="1"]>body .min-h-screen,html[data-fnos-fs="1"]>body .min-h-dvh{height:100vh !important;min-height:100vh !important;max-height:100vh !important;}',
            'html[data-fnos-fs="1"]>body [class*="100vh"],html[data-fnos-fs="1"]>body [class*="100dvh"],html[data-fnos-fs="1"]>body [class*="h-screen"],html[data-fnos-fs="1"]>body [class*="h-dvh"],html[data-fnos-fs="1"]>body [class*="dvh"],html[data-fnos-fs="1"]>body [style*="100vh"],html[data-fnos-fs="1"]>body [style*="100dvh"],html[data-fnos-fs="1"]>body [style*="dvh"]{max-height:100vh !important;}',
            'html[data-fnos-fs="1"] #fnos-titlebar{z-index:2147483647 !important;}',
            // v2.17.36（用户要求）：删掉全屏时的"悬浮隐藏式标题栏"——全屏态标题栏与顶部热区
            // 一律 display:none，鼠标推到顶部也不会再滑出；退出全屏后自动恢复（选择器带 data-fnos-fs）
            'html[data-fnos-fs="1"] #fnos-titlebar,html[data-fnos-fs="1"] #fnos-titlebar-hotzone,html[data-fnos-fs="1"] #fnos-tb-dragstrip,html[data-fnos-fs="1"] #fnos-resize-cover{display:none !important;}',
            // v2.17.35：全屏态整个标题栏（含热区与子元素）强制 no-drag，禁止出现可拖动区
            'html[data-fnos-fs="1"] #fnos-titlebar,html[data-fnos-fs="1"] #fnos-titlebar *,html[data-fnos-fs="1"] #fnos-titlebar-hotzone{-webkit-app-region:no-drag !important;}'
          ].join('\n');
          (document.head || document.documentElement).appendChild(st);
        }
        if (!window.__fnosFsHooked) {
          window.__fnosFsHooked = true;
          window.__fnosFsOn = false;
          ipcRenderer.on('window:fullscreen-changed', (_e, d) => {
            try {
              if (__isSubFrame) return;
              if (d && d.fullscreen) {
                window.__fnosFsOn = true;
                window.__fnosFsAt = Date.now();
                document.documentElement.setAttribute('data-fnos-fs', '1');
                __fsBarStyle(true); // v2.17.36：进全屏即收起，且全屏态不再滑出（见样式表 display:none）
                __fsBody(true);
              } else {
                window.__fnosFsOn = false;
                window.__fnosFsAt = 0;
                document.documentElement.removeAttribute('data-fnos-fs');
                __fsBody(false);
                // 退出全屏：恢复成用户设置决定的状态（开了自动隐藏才收起，否则常驻）
                __fsBarStyle(!!AUTO_HIDE);
                __fsRestoreUI(false);
                // v2.17.41：刚退出全屏时渲染进程正被窗口尺寸变化占住，400ms / 1200ms 各复查一次
                setTimeout(() => { try { if (!window.__fnosFsOn) __fsRestoreUI(true); } catch (_) {} }, 400);
                setTimeout(() => { try { if (!window.__fnosFsOn) __fsRestoreUI(true); } catch (_) {} }, 1200);
                // v2.17.42：第三次复查 + 一条探针日志。窗口从全屏回到窗口态时 DWM/合成器要
                // 一两秒才把新帧铺稳，前两次可能都被旧帧误导，2400ms 这次才是终局判定。
                // 探针把 bar/按钮的真实 rect、zoom、computedStyle、elementFromPoint 命中元素
                // 一并写进主日志，万一还没修好，下一份日志能直接读出被谁盖住。
                setTimeout(() => { try { if (!window.__fnosFsOn) __fsRestoreUI(true); } catch (_) {} }, 2400);
                setTimeout(() => {
                  try {
                    if (window.__fnosFsOn) return;
                    ipcRenderer.send("fnos:media-log", { stage: "titlebar", ev: "tb-probe", detail: JSON.stringify(__fsProbe()) });
                  } catch (_) {}
                }, 2600);
              }
            } catch (_) {}
          });
          __fsSelfHeal();
        }
      } catch (_) {}
    };
    // v2.17.42（用户反馈：内嵌窗在主程序窗口内最大化后，右上角按钮全部失效；只要不动主程序
    // 全屏 / ESC 就正常）——webContents.send 是广播到该 webContents 下所有 frame 的，主窗口
    // 里的 appview iframe 也收到了 window:fullscreen-changed。它一旦在收到 fullscreen:true 之后
    // 被重建、或错过了 fullscreen:false，就会永久带着 data-fnos-fs 与全屏样式跑：自己的标题栏
    // 被 display:none 藏掉、按钮区被全屏态 layering 压住，最大化后就点不动。窗口级全屏只属于
    // top frame，子 frame 一律不参与。
    const __isSubFrame = (function () {
      try { return window.top !== window.self; } catch (_) { return true; }
    })();
    if (__isSubFrame) {
      try { document.documentElement.removeAttribute("data-fnos-fs"); } catch (_) {}
    }
    const start = () => { try { __setupFullscreen(); if (EMBED) { buildEmbed(); } else { build(); buildAccountSwitcher(); } __ensureContentOffset(); __setupZoomControls(); } catch (_) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) {
    try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.ex', err: String((e && e.message) || e) }); } catch (_) {}
  }
};
