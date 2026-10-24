// titlebar-inject.js — 统一的无边框自定义标题栏注入
// 被 preload.js / settings-preload.js / live-preload.js 复用，保证所有窗口标题栏一致。
// 功能：顶部拖动热区、☰ 菜单、最小化/最大化/关闭（实心按钮）、自动隐藏（默认关闭）、
//       ALT 键调出、设置实时更新、SPA 重渲染自愈。
// 用法（preload 内）：require('./titlebar-inject')({ ipcRenderer })
'use strict';

module.exports = function injectTitleBar(ctx) {
  let ipcRenderer = ctx && ctx.ipcRenderer;
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
    const TB = { autoHide: false, opacity: 0, color: '#3B82F6' };
    try {
      const r = ipcRenderer.sendSync('settings:get-titlebar');
      if (r && typeof r === 'object') {
        if (typeof r.autoHide === 'boolean') TB.autoHide = r.autoHide;
        if (r.opacity != null) TB.opacity = Math.max(0, Math.min(100, Number(r.opacity) || 0));
        if (r.color) TB.color = String(r.color);
      }
    } catch (_) {}
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
        {
          // v2.15.14：默认深色渐变。旧默认 opacity=0 → 'transparent' 在深色壁纸下标题栏完全隐形。
          const a = TB.opacity / 100;
          if (a > 0.001) {
            bar.style.background = hexToRgba(TB.color, a);
            bar.style.backdropFilter = 'none';
            bar.style.webkitBackdropFilter = 'none';
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
          }
        }
        // 底色较深时图标用白，较浅时图标用深色——保证对比
        // v2.15.14：opacity=0 默认走深色渐变 → 也用白图标
        const darkBg = (TB.opacity > 45 || TB.opacity <= 0.001);
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
        if (window.__fnosFsOn) return; // v2.17.36：全屏态不出标题栏（只有 ESC 能退出全屏）
        if (bar.__hideTimer) { clearTimeout(bar.__hideTimer); bar.__hideTimer = null; }
        bar.style.transform = 'translateY(0)';
        bar.style.opacity = '1';
        bar.style.pointerEvents = 'auto';
        // v2.15.43: 自动隐藏调出后 -webkit-app-region:drag 的拖拽区域可能因 transform 过渡失效，
        // 强制 no-drag→drag 重注册拖拽区域，恢复可拖动
        if (window.__fnosFsOn) {
          // v2.17.35：全屏态标题栏一律 no-drag。drag 区会让 Windows 把整屏窗口"拖出全屏"，
          // 而用户要求全屏只能由 ESC / 菜单「退出全屏」结束，所以全屏时不再注册拖拽区。
          bar.style.setProperty('-webkit-app-region', 'no-drag');
        } else if (AUTO_HIDE) {
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
        bar.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'width:calc(100vw * var(--fnos-f, 1))', 'height:' + (__isMainWin ? '36px' : '34px'),
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
        bar.addEventListener('dblclick', (ev) => {
          if (ev.target === bar || ev.target === hot) { try { ipcRenderer.send('window-maximize'); } catch (_) {} }
        });

        // v1.62：原生拖拽兜底。-webkit-app-region:drag 在置顶嵌入 mpv 存在时可能失灵，
        // 这里在顶部热区/标题栏空白处左键 mousedown 主动调 startDrag；点按钮/☰ 时 target
        // 命中按钮（no-drag 区）不触发，避免影响点击。
        const startNativeDrag = (ev) => {
          try {
            if (ev.button !== 0) return;
            const t = ev.target;
            if (t && t.closest && t.closest('button, .fnos-tb-no-drag, #fnos-tb-min, #fnos-tb-max, #fnos-tb-close, #fnos-tb-menu')) return;
            ipcRenderer.send('window-drag');
          } catch (_) {}
        };
        hot.addEventListener('mousedown', startNativeDrag);
        bar.addEventListener('mousedown', startNativeDrag);

        if (!isMac) { btns.appendChild(minBtn); btns.appendChild(maxBtn); btns.appendChild(closeBtn); }
        bar.appendChild(left);
        const dragStrip = document.createElement('div');
        dragStrip.id = 'fnos-tb-dragstrip';
        dragStrip.style.cssText = 'flex:1;height:34px;min-width:20px;-webkit-app-region:drag;pointer-events:none;cursor:default;';
        dragStrip.addEventListener('pointerdown', (e) => { try { e.preventDefault(); ipcRenderer.send('window-drag'); } catch (_) {} });
        bar.appendChild(dragStrip);
        bar.appendChild(btns);
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
        __padStyle.textContent = 'html{overflow:hidden !important;}' +
          'html>body{transform:translateY(34px) !important;height:calc(100vh - 34px) !important;box-sizing:border-box !important;overflow-y:auto !important;padding-top:0 !important;clip-path:inset(0 round 20px) !important;background:#05060a !important;}';
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
          'html>body{transform:translateY(calc(34px / var(--fnos-f, 1))) !important;overflow-y:auto !important;height:calc(100vh - 34px / var(--fnos-f, 1)) !important;min-height:0 !important;max-height:calc(100vh - 34px / var(--fnos-f, 1)) !important;box-sizing:border-box !important;clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;padding-top:0 !important;margin:0 !important;}',
          // v2.16.0: fixed-viewport SPA apps (Tailwind h-dvh / h-screen / min-h-dvh) size their
          // root to 100vh/dvh, ignoring the 34px titlebar. The body is already shrunk to
          // calc(100vh-34px), but a child at height:100vh still spans the full window, so its
          // bottom 34px overflows the body and is clipped (fnOS music: progress bar and the
          // bottom of "recently added" cut off, and the page's scrollbar-width:none hides the
          // scrollbar). Re-anchor viewport units to the visible area below the titlebar.
          'html>body .h-screen,html>body .h-dvh{height:calc(100vh - 34px / var(--fnos-f, 1)) !important;}',
          'html>body .min-h-screen,html>body .min-h-dvh{min-height:calc(100vh - 34px / var(--fnos-f, 1)) !important;}',
          // v2.17.20: 上面只认 .h-screen/.h-dvh/.min-h-screen 这几个精确类名，而 Semi / Tailwind
          // 应用常用任意值写法（h-[100dvh]、h-[100vh]、min-h-[100vh]），命中不了就比 body 高出
          // 标题栏那 34px，撑出额外滚动条。这里按 class 子串补一层 max-height 兜底：只限上限，
          // 写了更大 min-height 的元素按 CSS 规则仍以 min-height 为准，不会被误裁。
          'html>body [class*="100vh"],html>body [class*="h-screen"],html>body [class*="h-dvh"]{max-height:calc(100vh - 34px / var(--fnos-f, 1)) !important;}',
          'html>body [style*="100vh"]{max-height:calc(100vh - 34px / var(--fnos-f, 1)) !important;}',
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
            'html>body{transform:translateY(calc(34px / var(--fnos-f, 1))) !important;height:calc(100vh - 34px / var(--fnos-f, 1)) !important;min-height:0 !important;max-height:calc(100vh - 34px / var(--fnos-f, 1)) !important;box-sizing:border-box !important;overflow:hidden !important;overflow-x:hidden !important;padding:0 !important;margin:0 !important;clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;}',
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
          'html>body{transform:translateY(calc(34px / var(--fnos-f, 1))) !important;height:calc(100vh - 34px / var(--fnos-f, 1)) !important;box-sizing:border-box !important;clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;padding-top:0 !important;margin-top:0 !important;background:#05060a !important;}',
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
          'html>body .h-screen,html>body .h-dvh{height:calc(100vh - 34px / var(--fnos-f, 1)) !important;}' +
          'html>body .min-h-screen,html>body .min-h-dvh{min-height:calc(100vh - 34px / var(--fnos-f, 1)) !important;}' +
          // v2.17.40（用户反馈：内嵌窗最大化后底部显示不出来）——主窗分支此前只覆盖 .h-screen/.h-dvh
          // 这两个精确类名，缺应用窗 v2.17.20 那套 [class*="100vh"] 子串兜底。飞牛桌面里的内嵌窗最大化
          // 时用任意值写法（h-[100vh]/h-[100dvh]）或 inline style 把容器撑到整个视口，而 body 已经下移
          // 34px，容器底部就超出 body 底边 34px 被 clip-path 裁掉（副标题/播放条/底栏被切一半）。
          // 补同两条 max-height 上限规则，让内嵌窗最大化后完整落在主程序窗口内容区内。
          'html>body [class*="100vh"],html>body [class*="100dvh"],html>body [class*="h-screen"],html>body [class*="h-dvh"],html>body [class*="dvh"]{max-height:calc(100vh - 34px / var(--fnos-f, 1)) !important;}' +
          'html>body [style*="100vh"],html>body [style*="100dvh"],html>body [style*="dvh"]{max-height:calc(100vh - 34px / var(--fnos-f, 1)) !important;}'
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
        document.addEventListener('mousemove', (ev) => {
          try {
            const inTop = (ev.clientY != null && ev.clientY <= 34);
            if (inTop && !__inTop) { __inTop = true; show(bar); }
            else if (!inTop && __inTop) { __inTop = false; scheduleHide(bar, 450); }
          } catch (_) {}
        }, true);
        // 元素级 hover 兜底（某些场景 mousemove target 为窗口按钮等不冒泡到 document 时）
        bar.addEventListener('mouseenter', () => show(bar));
        bar.addEventListener('mouseleave', () => scheduleHide(bar, 450));
        hot.addEventListener('mouseenter', () => show(bar));
        hot.addEventListener('mouseleave', () => scheduleHide(bar, 450));

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
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:34px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;pointer-events:auto;background:rgba(18,22,30,0.30);border-radius:6px;-webkit-app-region:drag;user-select:none;';
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
        dragStrip.style.cssText = 'flex:1;height:34px;min-width:20px;-webkit-app-region:drag;pointer-events:none;cursor:default;';
        dragStrip.addEventListener('pointerdown', (e) => { try { e.preventDefault(); ipcRenderer.send('window-drag'); } catch (_) {} });
        bar.appendChild(dragStrip);
        bar.appendChild(btns);
        root2.appendChild(bar);
        // 原生拖拽兜底（与普通标题栏同款）
        const startNativeDrag = (ev) => {
          try {
            if (ev.button !== 0) return;
            const t = ev.target;
            if (t && t.closest && t.closest('button')) return;
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
            position: fixed; left: 0; top: 50%; transform: translateY(-50%);
            z-index: 99999; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          }
          #fnos-acct-trigger {
            width: 24px; height: 48px; display: flex; align-items: center; justify-content: center;
            background: rgba(255,255,255,0.08);
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 0 12px 12px 0;
            color: rgba(255,255,255,0.7); cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          }
          #fnos-acct-trigger:hover {
            width: 32px; background: rgba(255,255,255,0.15); color: #fff;
          }
          #fnos-acct-dropdown {
            position: absolute; left: 32px; top: 50%; transform: translateY(-50%);
            min-width: 200px; max-width: 280px;
            background: rgba(30, 27, 46, 0.85);
            backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2);
            padding: 8px 0;
            transition: opacity 0.2s, transform 0.2s;
          }
          .fnos-acct-hidden { opacity: 0 !important; pointer-events: none !important; transform: translateY(-50%) translateX(-8px) !important; }
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

        trigger.addEventListener('mouseenter', showDropdown);
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
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
            set('transform', 'translateY(calc(' + bh + 'px / var(--fnos-f, 1)))');
            set('height', 'calc(100vh - ' + bh + 'px / var(--fnos-f, 1))');
            set('max-height', 'calc(100vh - ' + bh + 'px / var(--fnos-f, 1))');
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
              if (d && d.fullscreen) {
                window.__fnosFsOn = true;
                document.documentElement.setAttribute('data-fnos-fs', '1');
                __fsBarStyle(true); // v2.17.36：进全屏即收起，且全屏态不再滑出（见样式表 display:none）
              } else {
                window.__fnosFsOn = false;
                document.documentElement.removeAttribute('data-fnos-fs');
                // 退出全屏：恢复成用户设置决定的状态（开了自动隐藏才收起，否则常驻）
                __fsBarStyle(!!AUTO_HIDE);
              }
            } catch (_) {}
          });
        }
      } catch (_) {}
    };
    const start = () => { try { __setupFullscreen(); if (EMBED) { buildEmbed(); } else { build(); buildAccountSwitcher(); } __ensureContentOffset(); __setupZoomControls(); } catch (_) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) {
    try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.ex', err: String((e && e.message) || e) }); } catch (_) {}
  }
};
