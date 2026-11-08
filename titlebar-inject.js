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
    // v3.0.76（用户要求：删除深色模式，改为调透明度）——
    // pct = 用户看到的「透明度」百分比：0 = 深色实底，100 = 完全透明。
    // 统一写成一个变量 --fnos-ui-a（0~1 不透明度），各页把硬编码 .38 换成 var(--fnos-ui-a,.38)，
    // 于是拖动滑块时所有页面背景同步变化。
    function __applyUiAlpha(pct) {
      try {
        const p = (pct == null || !isFinite(Number(pct))) ? 62 : Math.max(0, Math.min(100, Number(pct)));
        const a = (100 - p) / 100;
        const el = document.documentElement;
        el.style.setProperty('--fnos-ui-a', String(Math.round(a * 1000) / 1000));
        el.classList.toggle('fnos-ui-transparent', p > 0);
      } catch (_) {}
    }
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

    // ================= v4.0.28：内嵌窗标题栏的 ↻ 刷新 / ↗ 新标签打开 一律隐藏 =================
    // 用户工单：主程序内打开的所有应用（内嵌窗、独立跳出窗）标题栏都不要这两个按钮。
    // 内嵌窗的这两个按钮不是我们画的，是飞牛前端自己挂上去的（WINDOW-TYPES.md 实测）：
    //   .trim-ui__app-layout--header → .flex.items-center 按钮组，排在 — □ ✕ 左边，
    //   id = iframe-btns-<应用路径签名>-refresh / -newwindow，
    //   title = "刷新页面" / "新标签页打开"，且要等 iframe 页加载完 1~6 秒才挂上。
    // 做法：一行 CSS 把它们从布局里摘掉（display:none 自动收回那 92px 宽度）。CSS 规则对之后
    // 动态插入的节点同样生效，不需要等按钮出现、不需要轮询找元素，也不会和飞牛的重渲染打架。
    // 选择器只认这两个 id 后缀 / 两个 title，☰ 与 — □ ✕ 一概不碰。
    try {
      if (!__SUB) {
        const __css28 = '[id^="iframe-btns-"][id$="-refresh"],[id^="iframe-btns-"][id$="-newwindow"],'
          + '[id^="iframe-btns-"][title="刷新页面"],[id^="iframe-btns-"][title="新标签页打开"]'
          + '{display:none !important;width:0 !important;min-width:0 !important;margin:0 !important;padding:0 !important;}';
        const __mk28 = () => {
          try {
            if (document.getElementById('fnos-hide-iframe-btns')) return;
            const st = document.createElement('style');
            st.id = 'fnos-hide-iframe-btns';
            st.textContent = __css28;
            (document.head || document.documentElement).appendChild(st);
          } catch (_) {}
        };
        __mk28();
        // 切换应用时 SPA 偶尔会把 head 整体重建，补一次（低频、只查 id）
        try {
          const __iv28 = setInterval(() => {
            try { if (!document.getElementById('fnos-hide-iframe-btns')) __mk28(); } catch (_) {}
          }, 3000);
          setTimeout(() => { try { clearInterval(__iv28); } catch (_) {} }, 120000);
        } catch (_) {}
      }
    } catch (_) {}

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

    // ---------------- v4.0.25：自家页面 / 第三方页面判定（亮模式配色异常根修） ----------------
    // 现象：Docker 应用（Next Terminal、qBittorrent、Lucky…）在暗模式显示正常、亮模式「黑底深字」。
    // 根因：壳把常量深色 #05060a 写进了页面 body（不随亮暗切换），而页面正文颜色跟着主题切换
    // ——暗模式深底+浅字恰好能读，亮模式深底+深字就读不出来。同时 matchMedia 桥 / colorScheme /
    // body[theme-*] 也被无条件压给第三方页，页面连"自己是亮还是暗"都判断不了。
    // 判定：以主进程下发的 nasOrigin 为界，只有同源前缀匹配的飞牛自家页面归壳管；其余 http(s)
    // 页面（含 *.fnos.net 下的 Docker 应用、100.x 直连应用）一律不碰，主题与底色交还页面自己。
    const __fnNasOrigin25 = String(window.__fnosNasOrigin || '');
    const __fnIsThirdParty25 = (() => {
      try {
        const href = String(location.href || '');
        if (!/^https?:/i.test(href)) return false;   // file:// = 自家页面（连接页/设置/关于/帮助）
        if (!__fnNasOrigin25) return false;          // 主进程没给基准 → 宁可不改，避免误伤自家页
        return href.indexOf(__fnNasOrigin25) !== 0;
      } catch (_) { return false; }
    })();
    const __fnLog25 = (stage, o) => { try { ipcRenderer.send('fnos:media-log', Object.assign({ stage: stage }, o)); } catch (_) {} };
    // 壳色常量：只用于自家页面 / 窗口垫底，第三方页面不再使用（见 __padStyle 与全屏样式）
    const __FN_SHELL_BG25 = '#05060a';

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
      // v4.0.25：第三方页面整段跳过——不装 matchMedia 桥（并掉页面自己的 prefers-color-scheme 真值）、
      // 不写 html colorScheme、不写/删 body[theme-dark|theme-light]、不重写 iframe 主题参数。
      // 只留一条"我们没动"的日志 + 页面原始底色探针（回归时用日志就能证明壳没碰它）。
      if (__fnIsThirdParty25) {
        // v4.0.30（Q1/Q3）：第三方页不再只记一条"我没动"。这里补「客户端真值 vs 页面实际看到的 mq」
        // 的对照，并在 3s 后复查一次——以后「应用没跟随亮/暗」不用再靠肉眼判断：
        //   mqMatch:true   → 页面层拿到主题 = 客户端选择，若观感仍不对，是该应用自己的主题开关（非客户端问题）
        //   mqMatch:false  → 客户端 themeSource 未生效，客户端侧继续查
        const __probeThirdParty30 = (when) => {
          try {
            const __b25 = document.body;
            const __mqDark = (() => { try { return !!(__origMQ && __origMQ('(prefers-color-scheme: dark)').matches); } catch (_) { return null; } })();
            __log({
              kind: 'skip', reason: 'third-party-page', when: when,
              href: String(location.href || '').slice(0, 140),
              clientDark: __sysDark,
              clientTheme: __sysDark ? 'dark' : 'light',
              mqDark: __mqDark,
              mqMatch: __mqDark === null ? null : (__mqDark === __sysDark),
              htmlBg: (() => { try { return getComputedStyle(document.documentElement).backgroundColor; } catch (_) { return ''; } })(),
              bodyBg: __b25 ? (() => { try { return getComputedStyle(__b25).backgroundColor; } catch (_) { return ''; } })() : '',
              pageColorScheme: String((document.documentElement && document.documentElement.style.colorScheme) || ''),
            });
          } catch (_) {}
        };
        __probeThirdParty30('load');
        try { setTimeout(() => __probeThirdParty30('after-3s'), 3000); } catch (_) {}
        return;
      }
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
      // v4.0.25：把"到底往这页写了什么"记下来（此前只有 mq-patched / store-respect29，
      // 出问题只能靠截图猜像素）
      try {
        __log({
          kind: 'apply', isNas: __isNas, thirdParty: false, dark: __isDark(),
          colorScheme: String((document.documentElement && document.documentElement.style.colorScheme) || ''),
          bodyAttr: document.body
            ? (document.body.getAttribute('theme-dark') !== null ? 'theme-dark'
              : (document.body.getAttribute('theme-light') !== null ? 'theme-light' : ''))
            : '',
          mqDark: __sysDark,
          href: String(location.href || '').slice(0, 140),
        });
      } catch (_) {}
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
    // v3.0.61（用户反馈：客户端内嵌 qBittorrent WebUI 时底部状态栏「两行文字叠印 / 糊在一起」，
    // 同页浏览器打开正常）——逐帧核对用户录屏实锤：qBittorrent v5.3.0 底栏是
    // #desktopFooterWrapper(position:absolute;bottom:0) > #desktopFooter > table(margin-left:auto)。
    // 5.x 底栏本身单行右对齐、不会折行，真正的问题是内嵌到飞牛桌面浏览器后：①底栏被文本选区
    // 高亮（Chromium ::selection 蓝底白字，连带图标蒙蓝）糊住；②详情面板末行溢出到底栏上时底栏
    // 没有不透明背景/层级兜底。这里注入一段【只命中 qBittorrent 专有 id】的样式：抬高底栏层级 +
    // 兜底不透明背景盖住任何溢出、禁折行、禁选区高亮。选择器只匹配
    // #desktopFooterWrapper/#desktopFooter/#transferInfo，其它页面/应用零影响。
    try {
      const __qbFixCss = [
        // v4.0.25：兜底值 #ffffff 会在深色主题下凭空画出一条白底栏（与整页割裂）。
        // 取不到 --color-background 就交还给页面自己的底色（transparent）。
        '#desktopFooterWrapper{z-index:2000 !important;background-color:var(--color-background,transparent) !important;-webkit-user-select:none !important;user-select:none !important;}',
        '#desktopFooter{background-color:var(--color-background,transparent) !important;white-space:nowrap !important;overflow:hidden !important;-webkit-user-select:none !important;user-select:none !important;}',
        '#desktopFooter table,#desktopFooter td{white-space:nowrap !important;}',
        '#transferInfo{white-space:nowrap !important;overflow:hidden !important;flex-wrap:nowrap !important;}',
        '#transferInfo,#transferInfo *{white-space:nowrap !important;}',
        '#desktopFooterWrapper::selection,#desktopFooterWrapper *::selection{background:transparent !important;color:inherit !important;}'
      ].join('');
      const __qbApply = () => {
        try {
          const host = document.head || document.documentElement;
          if (!host) return;
          let st = document.getElementById('fnos-qb-fix');
          if (!st) { st = document.createElement('style'); st.id = 'fnos-qb-fix'; }
          if (st.textContent !== __qbFixCss) st.textContent = __qbFixCss;
          if (!st.parentNode) host.appendChild(st);
        } catch (_) {}
      };
      __qbApply();
      if (document.readyState === 'loading') {
        try { document.addEventListener('DOMContentLoaded', __qbApply, { once: true }); } catch (_) {}
      }
    } catch (_) {}
    if (__SUB) return;

    // v1.58：标题栏样式状态。默认【不】自动隐藏（常驻）、透明材质。
    // v2.19.0：material = 'solid'（纯色）| 'frosted'（磨砂玻璃）；blur = 磨砂强度 0~40px
    // 标题栏皮肤状态（主进程 settings:get-titlebar / settings:titlebar-changed 下发）
    // v3.0.27：标题栏/皮肤链路日志（IIFE 顶层，供 __skinReloadSoon / titlebar-changed 使用）
    const __tbLog = function (stage, extra) {
      try { ipcRenderer.send('fnos:media-log', Object.assign({ stage: 'titlebar.' + stage, level: 'info' }, extra || {})); } catch (_) {}
    };
    let __skinState = { skinDir: '', skin: null };

  // v3.0.28（问题1）：CSP style-src 'self' 的页面（部分 NAS 应用 / 设置页）下，
  // __setCss(el, '...'); 会被浏览器判为 inline style 并【整条拒绝】
  // （控制台实证：src 指向 titlebar-inject.js，报 Applying inline style violates ... style-src 'self'），
  // 结果就是这些应用的标题栏与皮肤样式全部不生效 = 用户反馈的"有些应用标题栏皮肤加载失败"。
  // 处理：先试 cssText（一次写入、快）；若写了内容却一条样式都没落上，判定被 CSP 拦，
  // 之后逐属性走 CSSOM setProperty（CSSOM 不受 style-src 限制），首次命中记日志。
  let __cspBlocked28 = false;
  let __cspLogged28 = false;
  // ===== v4.0.24：点击穿透探测（工单：内嵌窗点 ✕ 关不掉） =====
  // 标题栏那条 40px 带（#fnos-titlebar / 顶部热区 / 中段拖拽条）盖在页面顶部，
  // 飞牛桌面内嵌窗的 ✕ 常常正好在带子边缘下面。这里把本层临时设为不吃事件，
  // 用 elementFromPoint 看「如果没有我，点到的是谁」；命中的是可交互控件就返回它，
  // 调用方在 mouseup（且整次没有发生拖动）时把这一次点击还给页面。
  function __tbPickUnderCtl(x, y) {
    try {
      const els = document.querySelectorAll('#fnos-titlebar, #fnos-titlebar-hotzone, #fnos-tb-dragstrip');
      const saved = [];
      for (let i = 0; i < els.length; i++) { saved.push(els[i].style.pointerEvents); els[i].style.pointerEvents = 'none'; }
      let el = null;
      try { el = document.elementFromPoint(x, y); } catch (_) { el = null; }
      for (let i = 0; i < els.length; i++) { els[i].style.pointerEvents = saved[i]; }
      if (!el) return null;
      if (el.tagName === 'IFRAME') {
        try {
          const r = el.getBoundingClientRect();
          const d = el.contentDocument;
          const inner = d && d.elementFromPoint(x - r.left, y - r.top);
          if (inner) el = inner;
        } catch (_) {}
      }
      return (el.closest && el.closest('button, [role="button"], a, [class*="close"], [id*="close"]')) || null;
    } catch (_) { return null; }
  }

  function __setCss(el, css) {
    try {
      if (!el || !css) return false;
      const __css = String(css);
      if (!__cspBlocked28) {
        try {
          el.style.cssText = __css; // v3.0.49：此处原为自调用 __setCss(el, __css) → 无限递归爆栈后才
        // 退化到逐属性设置，每次调用都白烧几千层栈帧（拖动/缩放时反复触发）。改成直接写 cssText；
        // 若 CSP 拦掉导致 el.style.length 为 0，下面的逻辑仍会自动切到逐属性，行为不变。
          if (el.style && el.style.length > 0) return true;
          if (/[a-z-]+\s*:/.test(__css)) {
            __cspBlocked28 = true;
            if (!__cspLogged28) {
              __cspLogged28 = true;
              try { __tbLog('titlebar.css.csp', { url: String(location.href || '').slice(0, 110), mode: 'perprop' }); } catch (_) {}
            }
          }
        } catch (_) { __cspBlocked28 = true; }
      }
      try {
        const __parts = __css.split(';');
        for (let __i = 0; __i < __parts.length; __i++) {
          const __p = __parts[__i];
          const __k = __p.indexOf(':');
          if (__k <= 0) continue;
          const __prop = __p.slice(0, __k).trim();
          const __val = __p.slice(__k + 1).trim();
          if (__prop && __val) { try { el.style.setProperty(__prop, __val); } catch (_) {} }
        }
      } catch (_) {}
      return !!(el.style && el.style.length > 0);
    } catch (_) {}
    return false;
  }


    // 标题栏有效高度（body 下移量），皮肤 titlebar.height 覆盖，默认 34
    let __skinHeight = 34;

    // 读皮肤素材文件 -> blob URL（避开 file:// 受 webSecurity 限制）
    const __skinAssetCache = new Map();
    // v4.0.31（用户问题 1）：切皮肤后旧皮肤的 blob URL 从不释放，缓存 Map 只增不减。
    // 每换一次皮肤、每开一个窗口都会新建 blob，旧的既占内存又占着视频解码资源。
    // 换皮肤时把「不属于当前皮肤目录」的条目全部 revoke 掉（当前皮肤正在用的不动，避免黑屏）。
    let __skinPrunedFor = '';
    function __pruneSkinAssets() {
      try {
        const dir = String((__skinState && __skinState.skinDir) || '');
        if (dir === __skinPrunedFor) return;
        __skinPrunedFor = dir;
        let n = 0;
        __skinAssetCache.forEach(function (u, k) {
          if (String(k).indexOf(dir + '|') !== 0) {
            try { URL.revokeObjectURL(u); } catch (_) {}
            __skinAssetCache.delete(k);
            n++;
          }
        });
        if (n) __tbLog('skin.asset.prune', { n: n, keep: dir.slice(-24) });
      } catch (_) {}
    }
    function __loadSkinAsset(skinDir, src) {
      // v3.0.28（问题1 日志加强）：皮肤素材读取链路此前没有任何记录，
      // 无法区分「没配置 / 文件不存在 / blob 失败 / 解码失败」，部分应用标题栏空条时无从排查。
      try {
        if (!__fs || !__path || !skinDir || !src) {
          __tbLog('skin.asset', { st: 'skip', src: String(src || '').slice(-28), hasFs: !!__fs, hasPath: !!__path, hasDir: !!skinDir });
          return null;
        }
        const p = __path.join(skinDir, String(src));
        if (!__fs.existsSync(p)) {
          __tbLog('skin.asset', { st: 'miss', src: String(src).slice(-28), file: String(p).slice(-44) });
          return null;
        }
        let __stamp = 0;
        try { __stamp = __fs.statSync(p).mtimeMs || 0; } catch (_) {}
        const __ck = p + '|' + __stamp;
        const __hit = __skinAssetCache.get(__ck);
        // v4.0.101（用户工单：appview/应用窗标题栏有 blob 却不渲染）：
        // 实测图层 backgroundImage 是 blob:…、尺寸/display 都对，屏幕却是灰的；而同一皮肤在别的窗口正常。
        // 说明是「复用了已失效的 blob URL」。静态底图（bg_alpha.*）一律不走缓存，每次重建 blob。
        const __noCache = /bg_alpha|bg\.(png|jpg|jpeg|webp|gif)$/i.test(String(src || ''));
        if (__hit && !__noCache) return __hit;
        const __t0 = Date.now();
        const buf = __fs.readFileSync(p);
        const ext = String(src).toLowerCase().split('.').pop();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm' }[ext] || 'application/octet-stream';
        // v4.0.102（实测定位）：同一图层把背景改成纯红色能立刻显示 → 图层没问题，
        // 是 blob 图片解不出来（blob 在部分窗口里 createObjectURL 后不渲染）。
        // 静态底图改用 data:URL（同步解码、无生命周期问题）。
        let __u;
        if (/^image\//i.test(mime)) {
          try { __u = 'data:' + mime + ';base64,' + Buffer.from(buf).toString('base64'); } catch (_) { __u = null; }
        }
        if (!__u) { const blob = new Blob([buf], { type: mime }); __u = URL.createObjectURL(blob); }
        if (!__noCache) __skinAssetCache.set(__ck, __u);
        __tbLog('skin.asset', { st: 'ok', src: String(src).slice(-28), size: buf.length, mime: mime, ms: Date.now() - __t0 });
        return __u;
      } catch (e) {
        __tbLog('skin.asset', { st: 'err', src: String(src || '').slice(-28), err: String((e && e.message) || e).slice(0, 80) });
        return null;
      }
    }

    // ===== v5.1.4（用户工单 10：测试皮标题栏文字过大 / 34px 内显示不全）=====
    // 根因（实测）：皮肤标题栏底图的比例由皮肤作者决定，测试皮 bg.jpg 是 2048×2048 的方图，
    // 文字「fnIOS NAS」直接画在图上。老实现一律 background-size:cover —— 1149×34 的条要"盖满"
    // 方图就得放大约 3.4 倍，只露出中间一条，图上的文字被裁掉上下、只剩笔画，看起来就是
    // "文字过大、34px 里显示不全"。修法：给 cover 设"缩放上限"，超过上限就降级成按高度铺满
    // （等价 contain），保证底图内的文字整条可见；比例接近标题栏的正常宽幅 banner 行为不变。
    const __TB_BG_MAX_ZOOM = 1.6;
    const __tbBgDims = new Map();
    function __tbBgFit(el, label) {
      try {
        if (!el) return;
        const raw = String((el.style && el.style.backgroundImage) || '');
        const m = /url\(["']?(.*?)["']?\)/.exec(raw);
        if (!m) return;
        const url = m[1];
        const key = url.length + ':' + url.slice(0, 96);
        const apply = function (iw, ih) {
          try {
            if (!el.isConnected) return;
            const w = el.clientWidth || el.offsetWidth || 0;
            const h = el.clientHeight || el.offsetHeight || 0;
            if (!iw || !ih || w < 8 || h < 8) return;
            const wantFit = String(el.__tbBgFitMode || '');
            const coverScale = Math.max(w / iw, h / ih);
            const containScale = Math.min(w / iw, h / ih);
            const zoom = containScale > 0 ? Math.round((coverScale / containScale) * 100) / 100 : 0;
            // 极端比例（方图塞进长条）：cover 只能露出中间一条 → 用「模糊铺底 + 居中完整图」两层，
            // 既不留白、又保证底图内容（文字）完整可见。
            const extreme = (wantFit !== 'cover' && wantFit !== 'contain' && zoom > __TB_BG_MAX_ZOOM);
            let mode = 'cover', size = 'cover';
            if (wantFit === 'contain') { mode = 'contain.manifest'; size = 'contain'; }
            else if (extreme) { mode = 'fill+contain'; size = 'cover'; }
            el.style.backgroundSize = size;
            el.style.backgroundPosition = 'center';
            // 子图层：fill（模糊铺满，inset 外扩避免模糊边缘透底）+ fit（完整内容，按高度）
            let fillEl = el.__tbFillEl, fitEl = el.__tbFitEl;
            if (!fillEl || !fillEl.isConnected) {
              fillEl = document.createElement('div');
              fillEl.setAttribute('data-fnos-tb-bgfill', '1');
              __setCss(fillEl, 'position:absolute;left:-24px;top:-24px;right:-24px;bottom:-24px;pointer-events:none;-webkit-app-region:no-drag;background-size:cover;background-position:center;background-repeat:no-repeat;filter:blur(14px) saturate(1.15);display:none;');
              el.appendChild(fillEl);
              el.__tbFillEl = fillEl;
            }
            if (!fitEl || !fitEl.isConnected) {
              fitEl = document.createElement('div');
              fitEl.setAttribute('data-fnos-tb-bgfit', '1');
              __setCss(fitEl, 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;-webkit-app-region:no-drag;background-size:auto 100%;background-position:center;background-repeat:no-repeat;display:none;');
              el.appendChild(fitEl);
              el.__tbFitEl = fitEl;
            }
            if (extreme) {
              try {
                fillEl.style.backgroundImage = raw;
                fillEl.style.display = 'block';
                fitEl.style.backgroundImage = 'url("' + url + '")';
                fitEl.style.display = 'block';
              } catch (_) {}
            } else {
              try { fillEl.style.display = 'none'; fitEl.style.display = 'none'; } catch (_) {}
            }
            const cur = [mode, zoom, w, h, iw, ih].join('|');
            if ((el.getAttribute('data-fnos-bgfit') || '') === cur) return;
            el.setAttribute('data-fnos-bgfit', cur);
            __tbLog('tb.bg.fit', { lb: String(label || ''), mode: mode, zoom: zoom, bar: w + 'x' + h, img: iw + 'x' + ih, size: size, layers: extreme ? 'fill+fit' : mode });
          } catch (_) {}
        };
        const hit = __tbBgDims.get(key);
        if (hit) { apply(hit[0], hit[1]); return; }
        const im = new Image();
        im.onload = function () {
          try { __tbBgDims.set(key, [im.naturalWidth, im.naturalHeight]); } catch (_) {}
          apply(im.naturalWidth || 1, im.naturalHeight || 1);
        };
        im.onerror = function () { try { __tbLog('tb.bg.fit.err', { lb: String(label || '') }); } catch (_) {} };
        im.src = url;
      } catch (_) {}
    }

    // 标题栏内文字字号上限：bar 高（皮肤 titlebar.height，20~80）→ 字号 ≤ barH*0.42（13px/34px≈0.38，
    // 留出行距余量），并允许 manifest 用 titlebar.fontSize 指定（同样被上限夹住）。
    function __tbTextMax(h) {
      const bh = Number(h) || 34;
      return Math.max(10, Math.min(20, Math.round(bh * 0.42 * 10) / 10));
    }
    function __tbFitTexts(bar) {
      try {
        const b = bar || document.getElementById('fnos-titlebar');
        if (!b) return;
        const bh = (b.getBoundingClientRect && b.getBoundingClientRect().height) || __skinHeight || 34;
        const max = __tbTextMax(bh);
        const manFs = Number(__skinState && __skinState.skin && __skinState.skin.titlebar && __skinState.skin.titlebar.fontSize);
        let n = 0;
        const els = b.querySelectorAll('#fnos-embed-title, .fnos-tb-title, [data-fnos-tb-text]');
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          try {
            const cur = parseFloat(getComputedStyle(el).fontSize) || 0;
            const want = el.__tbWantFont > 0 ? el.__tbWantFont : (isFinite(manFs) && manFs > 0 ? manFs : cur);
            const target = Math.max(9, Math.min(want, max));
            if (cur > target + 0.01) { el.style.setProperty('font-size', target + 'px', 'important'); n++; }
          } catch (_) {}
        }
        if (n) __tbLog('tb.text.fit', { barH: Math.round(bh), max: max, n: n, manFs: isFinite(manFs) ? manFs : 0 });
      } catch (_) {}
    }

    // 标题栏有效高度：皮肤 titlebar.height（20~80，默认 34）→ --fnos-bar-h（body 下移量）+ bar inline 高度
    function __applyTitlebarHeight() {
      try {
        const s = __skinState.skin;
        const h = s && s.titlebar ? Number(s.titlebar.height) : NaN;
        __skinHeight = (isFinite(h) && h >= 20 && h <= 80) ? Math.round(h) : 34;
        const bar = document.getElementById('fnos-titlebar');
        // v4.0.13（用户工单：tb.hit 实锤 barH=37 但 bodyTransform=35.3 → 内容顶部 1.7px 被压）——
        // --fnos-bar-h 必须等于 bar 实际 inline 高度（含主窗 +2px 盖接缝），不能只用 __skinHeight。
        // body transform / html padding-top 都用 calc(var(--fnos-bar-h) / var(--fnos-f))，
        // 值偏小导致让位不足，标题栏底边 > 内容区上边沿。
        const actualH = __skinHeight + (bar && bar.__tbIsMain ? 2 : 0);
        const el = document.documentElement;
        if (el && el.style) el.style.setProperty('--fnos-bar-h', actualH + 'px');
        if (bar) bar.style.height = actualH + 'px';
        // v5.1.4（工单 10）：bar 高度一变，底图缩放与文字字号都要重新夹一次
        try {
          __tbBgFit(bar.__bgLayer || document.getElementById('fnos-tb-bg'), 'bar');
          __tbFitTexts(bar);
        } catch (_) {}
      } catch (_) {}
    }

    // v3.0.24（用户反馈：皮肤包装完当场有效，关窗/退出程序后就不加载；设置页/帮助页/部分
    // 应用窗也不加载）——冷启动早期视频首帧未解析、图片未解码、层被页面重排清掉时，皮肤会应用
    // 失败；旧实现用「签名相同即返回」把失败状态永久固化，只有重新安装皮肤包（文件 mtime 变化）
    // 才会重试。这里做几次延迟补应用，冷启动后自动恢复。
    function __skinReloadSoon() {
      try {
        [0, 260, 900, 2200].forEach(function (ms) {
          setTimeout(function () {
            try {
              const b = document.getElementById('fnos-titlebar');
              if (!b) return;
              // v3.0.27：skinDir 为空说明 preload 阶段那次 sendSync 没拿到（冷启动实测
              // 109/121 次为空），旧实现只重画不重取，永远恢复不了。这里每次重试补拉一次。
              if (!__skinState.skinDir || !__skinState.skin) {
                try {
                  const r2 = ipcRenderer.sendSync('settings:get-titlebar');
                  if (r2 && typeof r2 === 'object') {
                    // v3.0.36：默认皮肤时 r2.skinDir='' / r2.skin=null，旧写法两个 if 都不进，
                    // 旧皮肤被"保住"，切默认后一次延迟重绘又把它画回来。改为按字段存在更新。
                    if (Object.prototype.hasOwnProperty.call(r2, 'skinDir')) __skinState.skinDir = String(r2.skinDir || '');
                    if (Object.prototype.hasOwnProperty.call(r2, 'skin')) __skinState.skin = (r2.skin && typeof r2.skin === 'object') ? r2.skin : null;
                    if (typeof r2.hideAccountBall === 'boolean') {
                      TB.hideAccountBall = r2.hideAccountBall;
                      try { if (window.__fnApplyBallHidden) window.__fnApplyBallHidden(r2.hideAccountBall); } catch (_) {}
                    }
                    __tbLog('skin.refetch', { ms: ms, hit: !!__skinState.skinDir, dir: String(__skinState.skinDir || '').slice(-24) });
                  }
                } catch (_) {}
              }
              __applyTitlebarHeight();
              applyStyle(b);
            } catch (_) {}
          }, ms);
        });
      } catch (_) {}
    }

    // 给标题栏挂背景层(z-index:-2) + 形状层(z-index:-1)子元素（绝对定位，不参与 flex）
    function __attachSkinLayers(bar) {
      try {
        if (!bar || bar.__shapeLayer) return;
        const bgLayer = document.createElement('div');
        bgLayer.id = 'fnos-tb-bg';
        __setCss(bgLayer, 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;-webkit-app-region:no-drag;z-index:-2;display:none;background-size:cover;background-position:center;background-repeat:no-repeat;overflow:hidden;border-radius:10px;clip-path:inset(0 round 10px);');
        const shapeLayer = document.createElement('div');
        shapeLayer.id = 'fnos-tb-shape';
        __setCss(shapeLayer, 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;-webkit-app-region:no-drag;z-index:-1;display:none;background-size:100% 100%;background-position:center;background-repeat:no-repeat;border-radius:10px;clip-path:inset(0 round 10px);');
        bar.appendChild(bgLayer);
        bar.appendChild(shapeLayer);
        bar.__bgLayer = bgLayer;
        bar.__shapeLayer = shapeLayer;
      } catch (_) {}
    }

    // 应用皮肤背景/形状到子元素；返回是否有皮肤背景接管（true = 背景层渲染，bar 自身透明）
    // v3.0.50（用户反馈：装 3.0.49 后标题栏四个角仍是直角，要求四角都是 10px R 角）：
    // 之前给 bgLayer / shapeLayer 用的是 border-radius:inherit，靠父元素圆角透传；而这两个层是
    // position:absolute + inset:0 + z-index:-2/-1 的整块矩形，inherit 在 CSSOM 逐条 setProperty
    // 的路径上并不可靠，一旦透传成 0 就按直角铺满，把 bar 的 10px 圆角整个盖掉。
    // 这版改成写死 10px + clip-path：clip-path 属于绘制期裁剪，背景图 / 渐变 / 视频 / img
    // 一律按圆角裁掉，既不依赖 inherit，也不依赖 getComputedStyle 的返回值。
    function __fixBarRadius(bar) {
      try {
        if (!bar) return;
        // v3.0.70：标题栏四角直角 = 0px；圆角保持原 10px（数值不变）
        // v3.0.74：新增 half（半圆角）= 上方左右两角 10px 圆角 + 下方左右两角直角
        //   border-radius / inset() 的四值顺序统一是 左上 右上 右下 左下
        // v4.0.39：五档 —— 半径 10/20/0，half 档为上两角圆、下两角直角
        const __sr = __tbCornerRadius(TB.barCorner);
        const __sh = __tbCornerIsHalf(TB.barCorner);
        const __R = __sh ? (__sr + 'px ' + __sr + 'px 0 0') : (__sr + 'px');
        const __C = __sh ? ('inset(0 round ' + __sr + 'px ' + __sr + 'px 0 0)') : ('inset(0 round ' + __sr + 'px)');
        try { bar.style.setProperty('border-radius', __R, 'important'); } catch (_) {}
        const bl = bar.__bgLayer;
        if (bl && bl.style) {
          try { bl.style.setProperty('border-radius', __R, 'important'); } catch (_) {}
          try { bl.style.setProperty('clip-path', __C, 'important'); } catch (_) {}
          try { bl.style.setProperty('-webkit-clip-path', __C, 'important'); } catch (_) {}
          try { bl.style.setProperty('overflow', 'hidden', 'important'); } catch (_) {}
        }
        const sl = bar.__shapeLayer;
        if (sl && sl.style) {
          try { sl.style.setProperty('border-radius', __R, 'important'); } catch (_) {}
          try { sl.style.setProperty('clip-path', __C, 'important'); } catch (_) {}
          try { sl.style.setProperty('-webkit-clip-path', __C, 'important'); } catch (_) {}
        }
      } catch (_) {}
    }

    // v4.0.31（用户问题 1）：只有「窗口真的可见」才值得解码视频皮肤。
    // visibilityState 在窗口最小化 / 被系统隐藏时会变 hidden；再来一次 focus / visibilitychange
    // 就把占位底色升级成视频。这样一次换肤不再让 50+ 个窗口一起解视频。
    let __skinLastBar = null;
    function __skinCanDecodeVideo() {
      try {
        if (document.hidden) return false;
        if (String(document.visibilityState || '') === 'hidden') return false;
        return true;
      } catch (_) { return true; }
    }
    function __skinResumeVideo(why) {
      try {
        if (!__skinCanDecodeVideo() || !__skinLastBar) return;
        const b = __skinLastBar;
        if (!b.__skinDeferredVideo) return;
        try { b.__skinSig = ''; } catch (_) {}   // 清签名 → 强制重建为真正的 <video>
        setTimeout(function () { try { __applySkinLayers(b); } catch (_) {} }, 260);
        __tbLog('skin.video.resume', { by: String(why || '') });
      } catch (_) {}
    }
    try {
      document.addEventListener('visibilitychange', function () { __skinResumeVideo('visibility'); });
      window.addEventListener('focus', function () { __skinResumeVideo('focus'); });
    } catch (_) {}

    function __applySkinLayers(bar) {
      try {
        if (!bar) return false;
        __skinLastBar = bar;
        __pruneSkinAssets();
        // v3.0.38（用户反馈：加载皮肤后标题栏四角变直角）—— bgLayer/shapeLayer 的
        // border-radius:inherit 在 CSP 页面走 CSSOM setProperty 时偶发不继承（computed 成 0），
        // 皮肤背景/视频以直角铺满、盖住 bar 的 10px 小 R 角。这里每次应用都显式同步 bar 的圆角。
        try {
          const __brRaw = (function () { try { return String(getComputedStyle(bar).borderTopLeftRadius || '').trim(); } catch (_) { return ''; } })();
          __fixBarRadius(bar);
          // 皮肤 / 背景层是异步挂载的，__applySkinLayers 先于它们跑完是常态；这里多档补刷，
          // 谁最后写样式都无所谓，圆角一定落在 bgLayer / shapeLayer 上。
          try {
            [0, 160, 500, 1200, 2600].forEach(function (ms) {
              setTimeout(function () { try { __fixBarRadius(bar); } catch (_) {} }, ms);
            });
          } catch (_) {}
          try {
            if (!bar.__fnosBrLog49) {
              bar.__fnosBrLog49 = true;
              const g = function (el) {
                try {
                  if (!el) return 'none';
                  const cs = getComputedStyle(el);
                  return String(cs.borderTopLeftRadius || '') + '/' + String(cs.clipPath || cs.webkitClipPath || '');
                } catch (_) { return 'err'; }
              };
              __tbLog('radius', { barRaw: __brRaw, bar: g(bar), bg: g(bar.__bgLayer), shape: g(bar.__shapeLayer),
                bgShown: !!(bar.__bgLayer && bar.__bgLayer.style.display !== 'none'),
                shShown: !!(bar.__shapeLayer && bar.__shapeLayer.style.display !== 'none') });
            }
          } catch (_) {}
        } catch (_) {}
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
        // v3.0.24：命中签名也要确认皮肤层还活着、视频真的出画面，否则重新应用（否则
        // 首次失败会被永久缓存，表现为「重启后皮肤不加载，重装皮肤包才恢复」）
        if (__sig && bar.__skinSig === __sig) {
          let __ok = !!(bgLayer && bgLayer.isConnected) && !!(shapeLayer && shapeLayer.isConnected);
          if (__ok && bar.__skinHasBg && bgLayer) {
            // 视频还在缓冲（readyState<1）时不要重建，否则会反复销毁正在加载的 video 元素；
            // 它在 DOM 里解码完成后会自己出画面，这里只负责把它们重新 play 起来。
            const __v = bgLayer.querySelector('video');
            if (__v && __v.paused) { try { __v.play().catch(function () {}); } catch (_) {} }
          }
          if (__ok) return !!bar.__skinHasBg;
        }
        if (bgLayer) { bgLayer.style.display = 'none'; bgLayer.style.backgroundImage = 'none'; bgLayer.style.backgroundColor = 'transparent'; bgLayer.innerHTML = ''; }
        if (shapeLayer) { shapeLayer.style.display = 'none'; shapeLayer.style.backgroundImage = 'none'; shapeLayer.innerHTML = ''; }
        let hasBg = false;
        if (bg && bg.type && bg.type !== 'none') {
          // v4.0.100（用户实测：应用窗里视频皮肤永远画不出首帧，静态图却正常）：
          // 应用窗（--fnos-app-window / appview）一律直接用静态图 bg_alpha.webp，
          // 不再尝试解码 bg.mp4——这些窗口里 code4 解码失败率极高，视频分支只会得到空图层。
          let __appWinStatic = false;
          try { __appWinStatic = (typeof process !== 'undefined' && Array.isArray(process.argv)
            && (process.argv.indexOf('--fnos-app-window') >= 0 || process.argv.indexOf('--fnos-embed-style') >= 0)); } catch (_) {}
          if (__appWinStatic) {
            try {
              const __sp = __loadSkinAsset(__skinState.skinDir, 'bg_alpha.webp');
              if (__sp && bgLayer) {
                bgLayer.style.backgroundImage = 'url(\'' + __sp + '\')';
                bgLayer.style.backgroundSize = 'cover';
                bgLayer.style.backgroundPosition = 'center';
                bgLayer.style.backgroundRepeat = 'no-repeat';
                bgLayer.style.backgroundColor = 'transparent';
                bgLayer.style.display = 'block';
                hasBg = true;
                __tbLog('skin.appwin.static', { to: 'bg_alpha.webp' });
                bg = { type: 'image', src: 'bg_alpha.webp' };
              }
            } catch (_) {}
          }
          if (bg.type === 'video' && bg.src) {
            const url = __loadSkinAsset(__skinState.skinDir, bg.src);
            if (url && bgLayer) {
              // v4.0.31（用户问题 1：磨砂/纯色下换皮肤要等很久）：视频皮肤此前不分窗口状态一律解码。
              // 一次换肤会在 50+ 个窗口（最小化 / 被遮住 / 后台）同时解一段背景视频，主线程、GPU、
              // 磁盘一起排队，正是「点完要等好几秒」的来源。现在后台窗口只铺一个底色占位，
              // 等窗口真正可见再补视频（下方 visibilitychange / focus 会触发重建）。
              if (!__skinCanDecodeVideo()) {
                // v4.0.94（用户工单：容器应用标题栏皮肤包加载不上）：后台/隐藏窗口原来只铺一层
                // 深色占位，等可见才解码视频；但部分窗口的 visibilitychange 不触发 → 一直是灰条。
                // 这里先用皮肤自带静态图 bg_alpha.webp 顶上去（同一画面），可见后再升级成视频。
                try {
                  // v4.0.96（用户工单：内嵌/appview 窗标题栏一直是蓝灰条）：
                  // 栏往往在「皮肤设置通过 IPC 下发」之前就建好了，此时 __skinState.skinDir 为空，
                  // __loadSkinAsset 返回空 → 退成深色占位，之后没人重刷。
                  // 这里先铺占位，同时轮询等 skinDir 到位后立刻补图（最多 ~4s）。
                  const __applyStatic = function (fb) {
                    try {
                      if (!fb || !bgLayer) return false;
                      bgLayer.style.backgroundImage = 'url(\'' + fb + '\')';
                      bgLayer.style.backgroundSize = 'cover';
                      bgLayer.style.backgroundPosition = 'center';
                      bgLayer.style.backgroundColor = 'transparent';
                      __tbLog('skin.static.retry-ok', { to: 'bg_alpha.webp' });
                      return true;
                    } catch (_) { return false; }
                  };
                  const __fb0 = __loadSkinAsset(__skinState.skinDir, 'bg_alpha.webp');
                  if (!__fb0) {
                    // v4.0.97（根因）：v4.0.96 只轮询 __skinState，但该值在 appview 窗里永远是空——
                    // 真正需要的是「重新用 sendSync 拉一次设置并重画」。__skinReloadSoon() 正是这套逻辑。
                    try { setTimeout(function () { try { __skinReloadSoon(); } catch (_) {} }, 400); } catch (_) {}
                    let __tries = 0;
                    const __tik = setInterval(function () {
                      try {
                        __tries++;
                        const d2 = String((__skinState && __skinState.skinDir) || '');
                        const f2 = d2 ? __loadSkinAsset(d2, 'bg_alpha.webp') : '';
                        if (f2 && __applyStatic(f2)) { clearInterval(__tik); return; }
                        if (__tries >= 13) clearInterval(__tik);
                      } catch (_) { try { clearInterval(__tik); } catch (_) {} }
                    }, 300);
                  }
                  if (__fb0) {
                    bgLayer.style.backgroundImage = 'url(\'' + __fb0 + '\')';
                    bgLayer.style.backgroundSize = 'cover';
                    bgLayer.style.backgroundPosition = 'center';
                    bgLayer.style.backgroundColor = 'transparent';
                    __tbLog('skin.defer.static', { to: 'bg_alpha.webp' });
                  } else {
                    bgLayer.style.backgroundColor = 'rgba(12,16,30,.94)';
                  }
                  bgLayer.style.display = 'block';
                } catch (_) {}
                bar.__skinDeferredVideo = true;
                hasBg = true;
                __tbLog('skin.video.defer', { src: String(bg.src).slice(-28), vis: String(document.visibilityState || ''), hidden: !!document.hidden });
              } else {
              bar.__skinDeferredVideo = false;
              const v = document.createElement('video');
              v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
              // v3.0.24：显式补齐属性 + preload，冷启动时首个 play() 常因文档未显示被挂起，
              // 出画面后再补一次，避免视频皮肤黑屏（图片皮肤不受影响）
              v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
              v.preload = 'auto';
              __setCss(v, 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;pointer-events:none;-webkit-app-region:no-drag;');
              // v3.0.28（问题1 日志加强）：video 解码是异步的，旧实现失败时毫无记录。
              // 同一皮肤在 53 个窗口里个别窗口黑屏，此前完全查不到是 codec、blob 还是 play 被拒。
              try {
                v.addEventListener('error', function () {
                  try {
                    const __er = v.error ? ('code' + v.error.code + ':' + String(v.error.message || '').slice(0, 40)) : 'unknown';
                    __tbLog('skin.video.error', { src: String(bg.src).slice(-28), er: __er, w: v.videoWidth, h: v.videoHeight, rs: v.readyState });
                    // v4.0.93（用户工单：容器应用标题栏皮肤包加载不上）：部分窗口里 bg.mp4 解码失败
                    // （code4 MEDIA_ERR_SRC_NOT_SUPPORTED），旧代码只记日志 → 标题栏变透明条。
                    // 皮肤 manifest 里自带静态图 bg_alpha.webp（同一画面），这里退化成静态图兜底。
                    try {
                      const __fb = __loadSkinAsset(__skinState.skinDir, 'bg_alpha.webp');
                      if (__fb) {
                        bgLayer.style.backgroundImage = 'url(\'' + __fb + '\')';
                        bgLayer.style.backgroundSize = 'cover';
                        bgLayer.style.backgroundPosition = 'center';
                        bgLayer.style.backgroundRepeat = 'no-repeat';
                        bgLayer.style.backgroundColor = 'transparent';
                        try { v.remove(); } catch (_) {}
                        __tbLog('skin.video.fallback', { to: 'bg_alpha.webp', win: !!bgLayer });
                      }
                    } catch (_) {}
                  } catch (_) {}
                });
                v.addEventListener('loadeddata', function () {
                  try { __tbLog('skin.video.ok', { src: String(bg.src).slice(-28), w: v.videoWidth, h: v.videoHeight, rs: v.readyState }); } catch (_) {}
                });
                v.addEventListener('stalled', function () {
                  try { __tbLog('skin.video.stalled', { src: String(bg.src).slice(-28), rs: v.readyState }); } catch (_) {}
                });
              } catch (_) {}
              v.src = url;
              bgLayer.appendChild(v);
              // v4.0.99（用户工单：皮肤"已应用"却不出画面）：日志显示 skin.applied kind=video
              // 但同窗有 code4 MEDIA_ERR_SRC_NOT_SUPPORTED —— video 元素挂着但永远没有首帧，
              // 图层就是空的。这里加看门狗：1.5s 内 readyState 仍 <2 就撤掉 video、换静态图。
              try {
                setTimeout(function () {
                  try {
                    if (!v.isConnected) return;
                    if (v.readyState >= 2) return;
                    const __wfb = __loadSkinAsset(__skinState.skinDir, 'bg_alpha.webp');
                    if (!__wfb) return;
                    bgLayer.style.backgroundImage = 'url(\'' + __wfb + '\')';
                    bgLayer.style.backgroundSize = 'cover';
                    bgLayer.style.backgroundPosition = 'center';
                    bgLayer.style.backgroundRepeat = 'no-repeat';
                    bgLayer.style.backgroundColor = 'transparent';
                    const __rs = v.readyState;
                    try { v.remove(); } catch (_) {}
                    __tbLog('skin.video.watchdog', { rs: __rs, to: 'bg_alpha.webp' });
                  } catch (_) {}
                }, 1500);
              } catch (_) {}
              bgLayer.style.display = 'block';
              // v3.0.24：视频首帧没出来之前铺一层深色底，避免标题栏变成「看不见的透明条」
              // （素材解码完成后 video 会整体盖住这层底色，不影响最终观感）
              try { bgLayer.style.backgroundColor = 'rgba(12,16,30,.94)'; } catch (_) {}
              try {
                const __tryPlay = function () { try { if (v.paused) v.play().catch(function () {}); } catch (_) {} };
                v.addEventListener('loadeddata', __tryPlay);
                v.addEventListener('canplay', __tryPlay);
                __tryPlay();
              } catch (_) {}
              hasBg = true;
              } // v4.0.31：闭合 __skinCanDecodeVideo() 的 else
            }
          } else if ((bg.type === 'image' || bg.type === 'gif') && bg.src) {
            const url = __loadSkinAsset(__skinState.skinDir, bg.src);
            if (url && bgLayer) {
              // v5.1.4（工单 10）：皮肤可显式声明 background.fit = cover|contain；缺省走智能缩放上限
              try { bgLayer.__tbBgFitMode = (bg.fit === 'contain' || bg.fit === 'cover') ? bg.fit : ''; } catch (_) {}
              bgLayer.style.backgroundImage = 'url("' + url + '")';
              bgLayer.style.backgroundSize = bg.size || 'cover';
              bgLayer.style.backgroundPosition = bg.position || 'center';
              bgLayer.style.backgroundRepeat = bg.repeat || 'no-repeat';
              // v3.0.28（问题1 日志加强）：CSS 背景图不会抛错，用 Image 探针确认能否解码
              try {
                const __im = new Image();
                __im.onload = function () { try { __tbLog('skin.img.ok', { src: String(bg.src).slice(-28), w: __im.naturalWidth, h: __im.naturalHeight }); } catch (_) {} };
                __im.onerror = function () { try { __tbLog('skin.img.error', { src: String(bg.src).slice(-28) }); } catch (_) {} };
                __im.src = url;
              } catch (_) {}
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
                  __setCss(im, 'position:absolute;top:0;height:100%;width:auto;pointer-events:none;-webkit-app-region:no-drag;' + (isRight ? 'right:0;' : 'left:0;'));
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
        // v4.0.98（用户工单：appview/内嵌窗标题栏始终是深色占位条）——
        // 实测日志证明素材能读到（bg.mp4 + bg_alpha.webp 都 st:ok），但最终图层没有背景图，
        // 说明中途被重建/清空了。这里在每次 applyStyle 末尾做一次强制兜底：
        // 图层存在、没视频、也没背景图 → 直接用已解析出的 skinDir 铺静态图。
        try {
          if (bgLayer && bgLayer.isConnected && !bgLayer.querySelector('video')) {
            const __hasImg98 = !!(bgLayer.style.backgroundImage && bgLayer.style.backgroundImage !== 'none');
            if (!__hasImg98 && __skinState && __skinState.skinDir) {
              const __u98 = __loadSkinAsset(__skinState.skinDir, 'bg_alpha.webp');
              if (__u98) {
                bgLayer.style.backgroundImage = 'url(\'' + __u98 + '\')';
                bgLayer.style.backgroundSize = 'cover';
                bgLayer.style.backgroundPosition = 'center';
                bgLayer.style.backgroundRepeat = 'no-repeat';
                bgLayer.style.backgroundColor = 'transparent';
                bgLayer.style.display = 'block';
                __tbLog('skin.static.enforce', { to: 'bg_alpha.webp', w: bgLayer.offsetWidth, h: bgLayer.offsetHeight });
              }
            }
          }
        } catch (_) {}
        // v4.0.31（用户问题 1）：补一条「应用完成」回执 —— 此前只有 asset / video.ok 等碎片，
        // 看不出一个窗口从收到新皮肤到真正画出来用了多久、是否被降级成占位色。
        try {
          __tbLog('skin.applied', {
            hasBg: hasBg, kind: String((bg && bg.type) || ''), deferred: !!bar.__skinDeferredVideo,
            hasShape: !!shape, dir: String(__skinState.skinDir || '').slice(-24),
          });
        } catch (_) {}
        // v3.0.24：把「这个窗口有没有套上皮肤」落进诊断日志，便于按窗口/页面排查
        try {
          ipcRenderer.send('fnos:media-log', {
            stage: 'titlebar.skin',
            hasBg: hasBg,
            kind: String((bg && bg.type) || ''),
            hasShape: !!shape,
            dir: String(__skinState.skinDir || ''),
            path: String(location.pathname || '').slice(0, 40),
            // v3.0.28（问题1 日志加强）：记录「应用后到底可不可见」，
            // 用于区分「配置没拿到」与「样式被 CSP 拦 / 被页面样式覆盖 / 层被移除」。
            barH: (function () { try { return Math.round(bar.getBoundingClientRect().height) || 0; } catch (_) { return 0; } })(),
            bgDisplay: (function () { try { return String(bgLayer ? getComputedStyle(bgLayer).display : ''); } catch (_) { return ''; } })(),
            bgConn: !!(bgLayer && bgLayer.isConnected),
            shapeConn: !!(shapeLayer && shapeLayer.isConnected),
            csp: !!__cspBlocked28,
            barRad: (function () { try { return getComputedStyle(bar).borderTopLeftRadius; } catch (_) { return ''; } })(),
            bgRad: (function () { try { return bgLayer ? getComputedStyle(bgLayer).borderTopLeftRadius : ''; } catch (_) { return ''; } })(),
          });
        } catch (_) {}
        // v5.1.4（工单 10）：底图铺完统一夹一次「缩放上限」+「文字字号」，并留证据
        try { __tbBgFit(bgLayer, 'apply'); __tbFitTexts(bar); } catch (_) {}
        return hasBg;
      } catch (_) { return false; }
    }

    // v4.0.39：圆角五档 —— round-small(10) / round-large(20) / half-small(上10下0) /
    // half-large(上20下0) / square(0)；窗口侧 half 语义为「上直角、下圆角」。
    const __tbCornerNorm = (v) => {
      if (v === 'round-small' || v === 'round-large' || v === 'half-small' || v === 'half-large' || v === 'square') return v;
      if (v === 'round') return 'round-large';
      if (v === 'half') return 'half-large';
      return 'round-large';
    };
    const __tbCornerRadius = (v) => {
      const n = __tbCornerNorm(v);
      if (n === 'square') return 0;
      return n.indexOf('small') >= 0 ? 10 : 20;
    };
    const __tbCornerIsHalf = (v) => __tbCornerNorm(v).indexOf('half') === 0;

    // v3.0.70：barCorner = 标题栏四角，winCorner = 窗口四角
    const TB = { autoHide: false, opacity: 0, color: '#3B82F6', material: 'solid', blur: 20, highlight: 55, hideAccountBall: false, barCorner: 'round-large', winCorner: 'round-large',
      // v3.0.78：磨砂/纯色两套视觉参数各自独立（互不共用），见用户方案第五节
      frostColor: '#ffffff', frostAlpha: 10, solidColor: '#101426', solidAlpha: 100, divider: true,
      // v4.0.31（用户需求 2）：账号悬浮球外观 —— follow 跟随标题栏，custom 单独设置
      ballAppearanceMode: 'follow', ballMaterial: 'solid', ballSolidColor: '#101426', ballSolidAlpha: 100,
      ballFrostColor: '#FFFFFF', ballFrostAlpha: 14 };
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
        // v3.0.78：磨砂/纯色两套参数（老配置缺字段时从共享的 opacity/color 折算，观感不断层）
        if (r.frostColor) TB.frostColor = String(r.frostColor);
        if (r.frostAlpha != null) TB.frostAlpha = Math.max(2, Math.min(35, Number(r.frostAlpha) || 10));
        if (r.solidColor) TB.solidColor = String(r.solidColor);
        if (r.solidAlpha != null) TB.solidAlpha = Math.max(90, Math.min(100, Number(r.solidAlpha) || 100));
        if (typeof r.divider === 'boolean') TB.divider = r.divider;
        if (r.skinDir) __skinState.skinDir = String(r.skinDir);
        if (r.skin && typeof r.skin === 'object') __skinState.skin = r.skin;
        // v3.0.23：悬浮球隐藏开关
        if (typeof r.hideAccountBall === 'boolean') TB.hideAccountBall = r.hideAccountBall;
        // v3.0.62：可选「透明界面」——给 html 挂 class + 写 --fnos-ui-a，由各页面 CSS 接管
        // v3.0.76：改由透明度百分比驱动；老配置只有布尔值时按 62 / 0 折算
        __applyUiAlpha(r.uiTransparentAlpha != null ? r.uiTransparentAlpha : (r.uiTransparent === false ? 0 : 62));
        // v3.0.70：标题栏四角 / 窗口四角（缺字段回落圆角，行为与老版本完全一致）
        // v3.0.74：round 圆角 / half 半圆角 / square 直角（缺字段回落圆角）
        TB.barCorner = __tbCornerNorm(r.barCorner);
        TB.winCorner = __tbCornerNorm(r.winCorner);
        // v4.0.31（用户需求 2）：悬浮球外观（跟随标题栏 / 单独设置）
        if (r.ballAppearanceMode === 'custom' || r.ballAppearanceMode === 'follow') TB.ballAppearanceMode = r.ballAppearanceMode;
        if (r.ballMaterial === 'frosted' || r.ballMaterial === 'solid') TB.ballMaterial = r.ballMaterial;
        if (r.ballSolidColor) TB.ballSolidColor = String(r.ballSolidColor);
        if (r.ballSolidAlpha != null) TB.ballSolidAlpha = Math.max(40, Math.min(100, Number(r.ballSolidAlpha) || 100));
        if (r.ballFrostColor) TB.ballFrostColor = String(r.ballFrostColor);
        if (r.ballFrostAlpha != null) TB.ballFrostAlpha = Math.max(2, Math.min(60, Number(r.ballFrostAlpha) || 14));
      }
    } catch (_) {}
    __applyTitlebarHeight();
    // v5.1.4（工单 10）：窗口宽度变化会改变底图的缩放比例，重新夹一次（限流 250ms）
    try {
      let __tbFitT = 0;
      window.addEventListener('resize', function () {
        try {
          const now = Date.now();
          if (now - __tbFitT < 250) return;
          __tbFitT = now;
          const b = document.getElementById('fnos-titlebar');
          __tbBgFit((b && b.__bgLayer) || b || document.getElementById('fnos-tb-bg'), 'resize');
          __tbFitTexts(b);
        } catch (_) {}
      }, { passive: true });
    } catch (_) {}
    // v4.0.31（用户需求 2）：首屏就把球的外观变量算好（球是延迟创建的，变量先到位不会闪一下默认色）
    __applyBallLook();
    let AUTO_HIDE = TB.autoHide;

    // v3.0.70（用户要求：直角 / 圆角二选一，标题栏与窗口分别设置）——
    // 窗口四角「直角」用一条更高优先级的规则，把下面各窗口分支写的 20px 圆角 clip-path 整段覆盖掉
    // （设置窗 / 第三方应用窗(xapp) / 应用窗 / 认证页 / 主窗口 五处裁剪一次覆盖）；
    // 「圆角」时规则内容清空，恢复原样——20px 数值与原有裁剪逻辑一字未改。
    function __applyWinCornerStyle() {
      try {
        let el = document.getElementById('fnos-win-corner');
        if (!el) {
          el = document.createElement('style');
          el.id = 'fnos-win-corner';
          (document.documentElement || document.head || document.body).appendChild(el);
        }
        // v3.0.74：half（半圆角）= 窗口上方左右两角直角 + 下方（标题栏下方另一端）左右两角 20px 圆角。
        // 半径仍走 calc(20px / var(--fnos-f,1)) 保持 DPI 缩放跟随，数值本身不变。
        // 四值顺序：左上 右上 右下 左下 -> 0 0 R R = 上直下圆
        // v4.0.39（用户工单：窗口四角选圆角后，标题栏上两角被强制变成 20px）：
        // 窗口裁剪的上两角改由【标题栏四角】决定（标题栏就是窗口最上沿），下两角由【窗口四角】决定。
        // 两套设置因此完全独立：改窗口圆角不再篡改标题栏上角，反之亦然。
        const __pw = (px) => 'calc(' + px + 'px / var(--fnos-f, 1))';
        // v4.0.57（用户工单：标题栏四角与窗口四角必须**完全独立**，互不影响）——
        // 旧实现（v4.0.39）把窗口裁剪的「上两角」直接取标题栏设置（__topR = barR），
        // 于是改标题栏圆角会篡改窗口顶部裁剪；同时 __botR 的 half 分支两端相同，
        // 窗口「半圆角」等于「圆角」，规格没落地。现在窗口四角**只**由 winCorner 决定：
        //   round-*  → 四角圆
        //   half-*   → 上两角直角 + 下两角圆（窗口自己在下方露出圆角）
        //   square   → 四角直角
        // 标题栏四角仍只由 barCorner 决定（见 __fixBarRadius），两套设置零耦合。
        const __winR = __tbCornerRadius(TB.winCorner);
        const __winHalf = __tbCornerIsHalf(TB.winCorner);
        // v4.0.108（用户工单：窗口四角选「圆角」后标题栏上两角被强制变成 20px）：
        // 旧逻辑 __topR 取自 winCorner，而 html 的 clip-path 会把整个页面（含标题栏）的上沿一起裁掉，
        // 于是标题栏自己的「四角」设置在视觉上被窗口设置覆盖。
        // 现在拆开：页面**上沿**由【标题栏四角】决定，**下沿**由【窗口四角】决定，两套设置零耦合。
        // v4.0.110（用户澄清：两套设置必须完全独立，标题栏设置不得影响窗口四角）：
        // 页面（= 窗口外形）四角**只**取【窗口四角】；标题栏自己的圆角由 __fixBarRadius 用
        // 【标题栏四角】独立绘制，二者互不写入对方。窗口选直角/半圆角时，页面顶部就是直角。
        const __topR = __winHalf ? 0 : __winR;
        const __botR = __winR;
        const __wr = __pw(__topR) + ' ' + __pw(__topR) + ' ' + __pw(__botR) + ' ' + __pw(__botR);
        // v4.0.11（用户工单：半圆角对 xapp 窗口不生效）——
        // xapp 分支把 clip-path 写在 html 上，原来 half 只覆盖 html:root>body，
        // html 的 20px 全圆角压过来 → xapp 窗永远全圆角。现在 half/round 都同时命中 html:root。
        el.textContent = ((__topR === 0 && __botR === 0)
          ? 'html:root,html:root>body{clip-path:none !important;-webkit-clip-path:none !important;border-radius:0 !important;}'
          : ('html:root,html:root>body{clip-path:inset(0 round ' + __wr + ') !important;'
             + '-webkit-clip-path:inset(0 round ' + __wr + ') !important;}'));
        try { console.log('[fnos-corner]', JSON.stringify({ bar: TB.barCorner, win: TB.winCorner, winHalf: __winHalf, topR: __topR, botR: __botR, clip: __wr })); } catch (_) {}
        try { ipcRenderer.send('fnos:media-log', { stage: 'corner.apply', barCorner: TB.barCorner, winCorner: TB.winCorner, half: __winHalf ? 1 : 0, topR: __topR, botR: __botR }); } catch (_) {}
      } catch (_) {}
    }

    // v4.0.8（用户工单排障）：标题栏诊断——每个窗口注入完成后上报一次「这套标题栏是什么、
    // 用了哪套设置、实际画在哪」。配合主进程 window.create（flags/bounds），可以对齐
    // 「应用窗 / 跳转窗 / 新标签窗的标题栏为什么和主程序不一致」到底是 flags 没传对、
    // 还是设置没生效、还是 bounds 给错，不再靠猜。
    function __tbDiag(style) {
      try {
        if (window.__fnosTbDiagSent) return;
        window.__fnosTbDiagSent = true;
        const argv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
        const __mode = (argv.indexOf('--fnos-shell') >= 0 && argv.indexOf('--fnos-app-window') < 0) ? 'main'
          : (argv.indexOf('--fnos-embed-style') >= 0 ? 'embed'
            : (argv.indexOf('--fnos-xapp') >= 0 ? 'xapp'
              : (argv.indexOf('--fnos-app-window') >= 0 || argv.indexOf('--fnos-live-window') >= 0 ? 'app' : 'settings')));
        const __bar = document.getElementById('fnos-titlebar');
        let __r = null;
        try { const b = __bar.getBoundingClientRect(); __r = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; } catch (_) {}
        ipcRenderer.send('fnos:media-log', {
          stage: 'titlebar.injected',
          style: style || 'standard',
          mode: __mode,
          barH: __barHeight(),
          barRect: __r,
          win: { w: (window.innerWidth | 0), h: (window.innerHeight | 0) },
          settings: {
            material: TB.material, opacity: TB.opacity, autoHide: TB.autoHide,
            barCorner: TB.barCorner, winCorner: TB.winCorner,
            frostColor: TB.frostColor, frostAlpha: TB.frostAlpha,
            solidColor: TB.solidColor, solidAlpha: TB.solidAlpha, divider: TB.divider,
          },
        });
      } catch (_) {}
    }

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
    // v4.0.7（用户纠正 v4.0.6 的误改）：内嵌窗标题栏保持「默认」——仍按 --fnos-embed-style 渲染
    // 「logo+标题+↻↗—□✕」。要统一的是「内嵌窗跳出来的窗口 / 新标签打开的窗口」，
    // 那些窗口没有这个参数，走 build()（☰ + — □ ✕，与主程序一致）。
    let EMBED = false;
    try { EMBED = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv.indexOf('--fnos-embed-style') >= 0 : false; } catch (_) {}

    // v4.0.18（用户工单「内嵌窗应用请用默认标题栏，我很需要那个新标签打开按钮」）：
    // 主窗（只有 --fnos-shell、没有 --fnos-app-window）不显示 ↻ 刷新 / ↗ 新标签打开——
    // 主窗刷新会把 fnOS 桌面整页重载；应用窗/跳转窗才需要这两个入口。
    let __isMainWin = false;
    try { const __a = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : []; __isMainWin = __a.indexOf('--fnos-shell') >= 0 && __a.indexOf('--fnos-app-window') < 0; } catch (_) {}

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

    // ================= v4.0.31（用户需求 2）：账号悬浮球外观 =================
    // follow（默认）= 直接吃标题栏当前材质 + 颜色 + 浓度，切换标题栏时球同步变；
    // custom = 用球自己的材质 / 颜色 / 浓度，标题栏怎么改都不影响球。
    // 结果写进 CSS 变量，由 #fnos-acct-trigger 的样式读取（球还没创建时也生效，创建后自动继承）。
    function __applyBallLook() {
      try {
        const follow = (TB.ballAppearanceMode !== 'custom');
        const mat = follow
          ? ((TB.material === 'frosted') ? 'frosted' : 'solid')
          : ((TB.ballMaterial === 'frosted') ? 'frosted' : 'solid');
        let color = '#101426';
        let alpha = 100;
        if (mat === 'frosted') {
          color = String(follow ? (TB.frostColor || '#ffffff') : (TB.ballFrostColor || '#FFFFFF'));
          alpha = Number(follow ? (TB.frostAlpha == null ? 10 : TB.frostAlpha) : (TB.ballFrostAlpha == null ? 14 : TB.ballFrostAlpha));
        } else {
          color = String(follow ? (TB.solidColor || TB.color || '#101426') : (TB.ballSolidColor || '#101426'));
          alpha = Number(follow ? (TB.solidAlpha == null ? 100 : TB.solidAlpha) : (TB.ballSolidAlpha == null ? 100 : TB.ballSolidAlpha));
        }
        if (!isFinite(alpha)) alpha = mat === 'frosted' ? 10 : 100;
        // 球只有 40px：磨砂沿用标题栏的浓透明度（>=35%）会糊成一坨，收敛到 0.55 上限
        let a = Math.max(0.02, Math.min(1, alpha / 100));
        if (mat === 'frosted') a = Math.min(a, 0.55);
        // 浅色底 + 足够不透明时图标转深色，避免白图标压白底看不见
        const ch = (function (hex) {
          let h = String(hex || '').replace('#', '').trim();
          if (h.length === 3) h = h.split('').map((c) => c + c).join('');
          const n = parseInt(h, 16);
          if (!isFinite(n) || h.length !== 6) return { r: 16, g: 20, b: 38 };
          return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        })(color);
        const lum = (0.2126 * ch.r + 0.7152 * ch.g + 0.0722 * ch.b) / 255;
        const light = (lum > 0.6 && a > 0.35);
        const root = document.documentElement;
        if (!root || !root.style) return;
        root.style.setProperty('--fn-ball-bg', hexToRgba(color, a));
        root.style.setProperty('--fn-ball-bg-hover', hexToRgba(color, Math.min(1, a + 0.08)));
        root.style.setProperty('--fn-ball-blur', mat === 'frosted' ? '18px' : '0px');
        root.style.setProperty('--fn-ball-border', light ? 'rgba(17,24,39,0.18)' : 'rgba(255,255,255,0.14)');
        root.style.setProperty('--fn-ball-fg', light ? 'rgba(17,24,39,0.82)' : 'rgba(255,255,255,0.72)');
        root.style.setProperty('--fn-ball-fg-hover', light ? '#111827' : '#fff');
      } catch (_) {}
    }



    // 根据设置计算标题栏背景/模糊并应用；同时调整图标配色

    // ================= v3.0.78：标题栏磨砂层 =================
    // Windows 上 Electron 原生 acrylic 与自定义 20px 圆角不可兼得（实测：非透明窗才出磨砂，
    // 而非透明窗的 SetWindowRgn / DWM 圆角都到不了 20px）。因此磨砂改为「自绘」：
    // 主进程抓取窗口背后的真实屏幕画面（titlebar-frost.js），这里做低分辨率放大 + blur，
    // 视觉上等价于「透出桌面且模糊」，同时透明窗 + 10px/20px/半圆角全部保持不变。
    let __frostGeom = null;   // { url, sw, sh, wx, wy }
    let __frostClip = null;   // 裁切容器（只裁磨砂层，不影响皮肤异形层）
    let __frostEl = null;     // 模糊层本体

    function __ensureFrostLayer(bar) {
      if (__frostClip && __frostClip.parentNode === bar && __frostEl) return __frostEl;
      if (!__frostClip) {
        __frostClip = document.createElement('div');
        __frostClip.id = 'fnos-tb-frost-clip';
        __frostClip.setAttribute('aria-hidden', 'true');
        __setCss(__frostClip, [
          'position:absolute', 'left:0', 'top:0', 'right:0', 'bottom:0',
          'overflow:hidden', 'pointer-events:none', 'z-index:0',
          'border-radius:inherit'
        ].join(';'));
        __frostEl = document.createElement('div');
        __frostEl.id = 'fnos-tb-frost';
        __frostEl.setAttribute('aria-hidden', 'true');
        __setCss(__frostEl, [
          'position:absolute', 'left:-72px', 'top:-72px', 'right:-72px', 'bottom:-72px',
          'pointer-events:none', 'background-repeat:no-repeat',
          'filter:blur(18px) saturate(150%)',
          'transform:translateZ(0)', 'will-change:background-position'
        ].join(';'));
        __frostClip.appendChild(__frostEl);
      }
      try { bar.insertBefore(__frostClip, bar.firstChild); } catch (_) {}
      __paintFrost(bar);
      return __frostEl;
    }

    function __dropFrostLayer(bar) {
      try {
        if (__frostClip && __frostClip.parentNode) __frostClip.parentNode.removeChild(__frostClip);
      } catch (_) {}
    }

    function __paintFrost(bar) {
      if (!__frostEl) return;
      const g = __frostGeom;
      if (!g || !g.url) {
        __frostEl.style.backgroundImage = 'none';
        __frostEl.__paintKey = '';
        return;
      }
      // 模糊层的坐标系原点在标题栏左上角 -72px 处；窗口左上角在屏幕上的逻辑坐标为 (wx, wy)
      // v3.0.78：磨砂层是不透明截图，会把 bar 自己的 tint 底色盖掉 →
      // 改成多重背景：第一层 linear-gradient = 染色，第二层 = 窗口背后的模糊截图
      const __fa = Math.max(0.02, Math.min(0.35, (TB.frostAlpha == null ? 10 : Number(TB.frostAlpha)) / 100));
      const __tint = hexToRgba(TB.frostColor || '#ffffff', __fa);
      // v3.0.80：只有「图 / 染色 / 尺寸」变了才重写 background-image。
      // 拖动时窗口每帧都在动，但图不变，只需改 background-position（纯合成层平移，GPU 直接搬）；
      // 若每帧重新赋 data URL，会触发重新解码整张图，反而把帧率拖死。
      const __pk = g.url + '|' + __tint + '|' + g.sw + 'x' + g.sh;
      if (__frostEl.__paintKey !== __pk) {
        __frostEl.__paintKey = __pk;
        __frostEl.style.backgroundImage = 'linear-gradient(' + __tint + ',' + __tint + '), url("' + g.url + '")';
        __frostEl.style.backgroundSize = '100% 100%, ' + g.sw + 'px ' + g.sh + 'px';
      }
      __frostEl.style.backgroundPosition = '0 0, ' + (72 - g.wx) + 'px ' + (72 - g.wy) + 'px';
    }

    // 主进程采样结果（titlebar-frost.js 每 0.24~1.1s 推一次）
    try {
      ipcRenderer.on('titlebar-frost-bg', (_e, d) => {
        try {
          if (!d || !d.url) return;
          __frostGeom = d;
          const bar0 = document.getElementById('fnos-titlebar');
          if (bar0 && TB.material === 'frosted') {
            // v4.0.11：抓屏成功后把兜底底色降回正常 frostAlpha，由磨砂层接管视觉
            try {
              const __fa = Math.max(0.02, Math.min(0.35, (TB.frostAlpha == null ? 10 : Number(TB.frostAlpha)) / 100));
              bar0.style.background = hexToRgba(TB.frostColor || '#ffffff', __fa);
            } catch (_) {}
            __paintFrost(bar0);
          }
        } catch (_) {}
      });
    } catch (_) {}

    // v3.0.80：拖动期间主进程挂起抓屏，只推窗口新位置；这里用同一张图平移取景框，
    // 所以拖动时磨砂背景仍然实时跟着窗口走，而不是冻在半路或一卡一卡。
    try {
      ipcRenderer.on('titlebar-frost-pos', (_e, d) => {
        try {
          if (!d || !__frostGeom) return;
          if (TB.material !== 'frosted') return;
          __frostGeom.wx = Number(d.x) || 0;
          __frostGeom.wy = Number(d.y) || 0;
          const bar0 = document.getElementById('fnos-titlebar');
          if (bar0) __paintFrost(bar0);
        } catch (_) {}
      });
    } catch (_) {}

    function applyStyle(bar) {
      try {
        if (!bar) return;
        // v4.0.31：标题栏外观每次变化都顺手重算球的外观（follow 模式下球就是标题栏的镜像）
        try { __applyBallLook(); } catch (_) {}
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
          // v4.0.4：换肤/取消皮肤时也保持 no-drag（系统 drag 区会吞掉点击并让整窗可拖）
          if (bar.__skinNoDrag) { bar.__skinNoDrag = false; try { bar.style.setProperty('-webkit-app-region', 'no-drag'); } catch (_) {} }
          // v2.15.14：默认深色渐变。旧默认 opacity=0 → 'transparent' 在深色壁纸下标题栏完全隐形。
          const a = TB.opacity / 100;
          // v2.19.0（用户要求）：磨砂玻璃材质。三层叠加做出"雾面玻璃"：
          //   1) 细噪点（SVG feTurbulence）—— 关键是它让磨砂"成立"：标题栏盖在 <webview> 等
          //      跨进程内容之上时，backdrop-filter 未必采样得到，但噪点+高光依然呈现雾面颗粒感
          //   2) 顶部白色高光渐变 —— 玻璃上沿的受光质感
          //   3) 底色 —— 用户颜色（磨砂下最低 10% alpha，太透会完全看不见材质）
          const frosted = TB.material === 'frosted';
          if (frosted) {
            // v3.0.78（用户方案）：磨砂 = 透出桌面 + 模糊 + 极淡染色 + 固定 1px 内高光。
            // 背景由 __frostEl（主进程抓屏 + blur）提供，这里只负责染色与高光，绝不再写 backdrop-filter。
            const __fa = Math.max(0.02, Math.min(0.35, (TB.frostAlpha == null ? 10 : Number(TB.frostAlpha)) / 100));
            // 内嵌 bar（webview / 应用窗页面里的标题栏 buildEmbed）收不到 titlebar-frost-bg：
            // 主进程抓屏只发给窗口自己的 webContents。这里回退为「淡色 + 模糊页面内容」，
            // 避免变成一层没有背景的半透明白雾。主窗仍走自绘磨砂。
            const __isEmbed = !!(bar && bar.querySelector && bar.querySelector('#fnos-embed-title'));
            if (__isEmbed) {
              __dropFrostLayer(bar);
              bar.style.background = hexToRgba(TB.frostColor || '#ffffff', __fa);
              const __fb = 'blur(14px) saturate(140%)';
              bar.style.backdropFilter = __fb;
              bar.style.webkitBackdropFilter = __fb;
              bar.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.06)';
              bar.style.borderBottom = '1px solid rgba(255,255,255,0.10)';
            } else {
              __ensureFrostLayer(bar);
              // v4.0.11：磨砂抓屏失败（frost.capture-fail）时 __frostGeom 为 null，磨砂层空白，
              // 标题栏只剩 frostAlpha(10%) 的极淡染色 → 几乎透明，透出页面自身顶栏，用户看到
              // "另一套标题栏"。抓屏未就绪时用不透明底色兜底，保证标题栏始终可辨识；
              // 抓屏成功后 __paintFrost 会叠加磨砂层，视觉恢复。
              // v4.0.16：兜底从 0.35 提到 0.80——桌面上是浅色文档时，35% 的 frostColor 叠上去
              // 几乎是白的，标题栏看起来"没生效"。抓屏失败属于异常态，宁可接近实色也要可辨识。
              const __faFallback = __frostGeom ? __fa : Math.max(__fa, 0.80);
              bar.style.background = hexToRgba(TB.frostColor || '#ffffff', __faFallback);
              bar.style.backdropFilter = 'none';
              bar.style.webkitBackdropFilter = 'none';
              bar.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.06)';
              bar.style.borderBottom = '1px solid rgba(255,255,255,0.10)';
              __paintFrost(bar);
            }
          } else {
            // v3.0.78（用户方案）：纯色 = 完全不透明，只有底色 + 一条分隔线，不要内高光。
            __dropFrostLayer(bar);
            const __sa = Math.max(0.90, Math.min(1, (TB.solidAlpha == null ? 100 : Number(TB.solidAlpha)) / 100));
            bar.style.background = hexToRgba(TB.solidColor || TB.color || '#101426', __sa);
            bar.style.backdropFilter = 'none';
            bar.style.webkitBackdropFilter = 'none';
            bar.style.boxShadow = 'none';
            bar.style.borderBottom = TB.divider === false ? 'none' : '1px solid rgba(0,0,0,0.06)';
          }
        }
        // v4.0.7（用户工单：偏好设置里「标题栏四角 / 窗口四角」要对所有应用窗口生效）——
        // 之前 barCorner 只在「皮肤」模式里被 __applySkinLayers 用上，非皮肤窗口的圆角是创建时
        // 写死的 10px，设置里切「直角 / 半圆角」时应用窗、跳转窗、新标签窗完全没反应。
        // 这里统一按 TB.barCorner 落值；窗口四角继续由 __applyWinCornerStyle()（#fnos-win-corner）负责。
        try {
          const __br = __tbCornerRadius(TB.barCorner);
          const __bHalf = __tbCornerIsHalf(TB.barCorner);
          bar.style.borderRadius = __bHalf ? (__br + 'px ' + __br + 'px 0 0') : (__br + 'px');
        } catch (_) {}
        // 底色较深时图标用白，较浅时图标用深色——保证对比
        // v2.15.14：opacity=0 默认走深色渐变 → 也用白图标
        // v2.19.0：磨砂玻璃底色偏深（用户色+白高光+噪点），图标一律用白
        // v3.0.78：磨砂底色由「tint 色 + 玻璃浓度」决定，按 tint 亮度判色（白 tint → 深图标）
        const __lum = (function (hex) {
          const h = String(hex || '#ffffff').replace('#', '');
          const r0 = parseInt(h.slice(0, 2), 16) || 0, g0 = parseInt(h.slice(2, 4), 16) || 0, b0 = parseInt(h.slice(4, 6), 16) || 0;
          return (0.299 * r0 + 0.587 * g0 + 0.114 * b0) / 255;
        })(TB.frostColor);
        const darkBg = (TB.material === 'frosted')
          ? (__lum < 0.55 || (TB.frostAlpha == null ? 10 : TB.frostAlpha) < 8)
          : (TB.opacity > 45 || TB.opacity <= 0.001);
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
    let __lastTbFp = '';
    try {
      ipcRenderer.on('settings:titlebar-changed', (_e, val) => {
        try {
          if (val && typeof val === 'object') {
            // v4.0.31（用户问题 1）：设置页拖滑块 / 连点皮肤会高频广播，同一份 payload 再应用一次
            // 毫无收益，却会重建皮肤层、重启视频解码（越点越慢的放大器之一）。这里做指纹去重。
            try {
              const __fp = JSON.stringify(val);
              if (__fp === __lastTbFp) return;
              __lastTbFp = __fp;
            } catch (_) {}
            if (typeof val.autoHide === 'boolean') { TB.autoHide = val.autoHide; AUTO_HIDE = val.autoHide; }
            if (val.opacity != null) TB.opacity = Math.max(0, Math.min(100, Number(val.opacity) || 0));
            if (val.color) TB.color = String(val.color);
            // v2.19.0：材质 / 磨砂强度（预览与保存都会走这里）
            if (val.material) TB.material = (val.material === 'frosted') ? 'frosted' : 'solid';
            if (val.blur != null) TB.blur = Math.max(0, Math.min(40, Number(val.blur) || 0));
            if (val.highlight != null) TB.highlight = Math.max(0, Math.min(100, Number(val.highlight)));
            // v3.0.78：磨砂/纯色两套参数实时刷新（拖动滑块即时预览）
            if (val.frostColor) TB.frostColor = String(val.frostColor);
            if (val.frostAlpha != null) TB.frostAlpha = Math.max(2, Math.min(35, Number(val.frostAlpha) || 10));
            if (val.solidColor) TB.solidColor = String(val.solidColor);
            if (val.solidAlpha != null) TB.solidAlpha = Math.max(90, Math.min(100, Number(val.solidAlpha) || 100));
            if (typeof val.divider === 'boolean') TB.divider = val.divider;
            // v4.0.31（用户需求 2）：悬浮球外观实时刷新
            let __ballChanged = false;
            if (val.ballAppearanceMode === 'custom' || val.ballAppearanceMode === 'follow') { __ballChanged = __ballChanged || TB.ballAppearanceMode !== val.ballAppearanceMode; TB.ballAppearanceMode = val.ballAppearanceMode; }
            if (val.ballMaterial === 'frosted' || val.ballMaterial === 'solid') { __ballChanged = __ballChanged || TB.ballMaterial !== val.ballMaterial; TB.ballMaterial = val.ballMaterial; }
            if (val.ballSolidColor) { __ballChanged = __ballChanged || TB.ballSolidColor !== String(val.ballSolidColor); TB.ballSolidColor = String(val.ballSolidColor); }
            if (val.ballSolidAlpha != null) TB.ballSolidAlpha = Math.max(40, Math.min(100, Number(val.ballSolidAlpha) || 100));
            if (val.ballFrostColor) { __ballChanged = __ballChanged || TB.ballFrostColor !== String(val.ballFrostColor); TB.ballFrostColor = String(val.ballFrostColor); }
            if (val.ballFrostAlpha != null) TB.ballFrostAlpha = Math.max(2, Math.min(60, Number(val.ballFrostAlpha) || 14));
            try { __applyBallLook(); } catch (_) {}
            const __skBefore = String(__skinState.skinDir || '');
            if (val.skinDir != null) __skinState.skinDir = String(val.skinDir);
            // v3.0.36：切回默认皮肤时主进程下发 skin:null；旧写法 `val.skin != null` 为 false 会
            // 直接跳过，已注入的皮肤层永远清不掉（点「默认」没反应的第二个原因）。改为「字段存在即更新」。
            if (Object.prototype.hasOwnProperty.call(val, 'skin')) __skinState.skin = (val.skin && typeof val.skin === 'object') ? val.skin : null;
            // v3.0.27：皮肤刚下发时页面可能尚未布局稳定，补跑一轮延迟应用
            try {
              if (String(__skinState.skinDir || '') !== __skBefore) {
                __tbLog('skin.changed', { from: __skBefore.slice(-24), to: String(__skinState.skinDir || '').slice(-24) });
                __skinReloadSoon();
              }
            } catch (_) {}
            // v3.0.23：悬浮球隐藏开关（设置页勾选后立即隐藏 / 显示，不需要重启）
            if (typeof val.hideAccountBall === 'boolean') {
              TB.hideAccountBall = val.hideAccountBall;
              try { if (window.__fnApplyBallHidden) window.__fnApplyBallHidden(val.hideAccountBall); } catch (_) {}
            }
            // v3.0.62：透明界面实时切换（无需重启）
            // v3.0.76：改按透明度百分比实时刷新（拖动滑块即时可见）
            if (val.uiTransparentAlpha != null && isFinite(Number(val.uiTransparentAlpha))) {
              __applyUiAlpha(val.uiTransparentAlpha);
            } else if (typeof val.uiTransparent === 'boolean') {
              __applyUiAlpha(val.uiTransparent ? 62 : 0);
            }
            // v3.0.70：标题栏四角 / 窗口四角实时切换（无需重启）
            let __cornerChanged = false;
            if (val.barCorner) { const __nv = __tbCornerNorm(val.barCorner); __cornerChanged = __cornerChanged || TB.barCorner !== __nv; TB.barCorner = __nv; }
            if (val.winCorner) { const __nv = __tbCornerNorm(val.winCorner); __cornerChanged = __cornerChanged || TB.winCorner !== __nv; TB.winCorner = __nv; }
            if (__cornerChanged) {
              try { __applyWinCornerStyle(); } catch (_) {}
              try { const __b = document.getElementById('fnos-titlebar'); if (__b) __fixBarRadius(__b); } catch (_) {}
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
        // v4.0.24：这里原来写 'auto'，把 CSS 里刚改好的 none 又覆盖回去了（实测 computed=auto）。
        // bar 自身不吃事件，只有 ☰ / — □ ✕ / 中段拖拽条 pointer-events:auto，
        // 保证被标题栏盖住的飞牛内嵌窗 ✕ 能一次点中。
        bar.style.pointerEvents = 'none';
        if (window.__fnosFsOn) return;
        // v2.15.43: 自动隐藏调出后 -webkit-app-region:drag 的拖拽区域可能因 transform 过渡失效，
        // 强制 no-drag→drag 重注册拖拽区域，恢复可拖动
        if (window.__fnosFsOn) {
          // v2.17.35：全屏态标题栏一律 no-drag。drag 区会让 Windows 把整屏窗口"拖出全屏"，
          // 而用户要求全屏只能由 ESC / 菜单「退出全屏」结束，所以全屏时不再注册拖拽区。
          bar.style.setProperty('-webkit-app-region', 'no-drag');
        } else if (AUTO_HIDE && !bar.__skinNoDrag) {
          // v4.0.4：自动隐藏调出时不再重新注册系统 drag 区。drag 区会让 Windows 接管 mousedown
          // （DOM 收不到事件 → 点击全被吞、按住却拖走窗口）。现在一律保持 no-drag，
          // 拖动由标题栏中部的 win-drag-* 通道负责。
          bar.style.setProperty('-webkit-app-region', 'no-drag');
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

    // ================= v4.0.10：贴顶 fixed 元素让位 =================
    // 背景（用户工单「标题栏压住内容区第一行」）：第三方应用窗（--fnos-xapp）的内容让位由
    // v3.0.46 的 html{padding-top:34px} 负责，几何与浏览器一致、底栏不再压内容。但
    // position:fixed 元素不参与 html 的 padding 布局——biliLive-tools 的顶栏、录制任务标签栏
    // 都是 fixed;top:0，仍停在视口 y=0，正好被 34px 标题栏盖住第一行。
    // 做法：只接管「自己贴视口顶边（top≈0）」的 fixed 元素，把它下移一个标题栏高度；
    // 原 top 只记一次（元素上 __fnosTopShift），标题栏高度 / 页面缩放(--fnos-f) / 全屏态变化时
    // 都按原值重算，不会叠加偏移；标题栏收起（全屏）时还原成作者原值。
    const __fixedZoom = () => {
      try {
        const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fnos-f'));
        return (isFinite(v) && v > 0.2 && v < 8) ? v : 1;
      } catch (_) { return 1; }
    };

    // 诊断用：只在「接管结果变化」时上报一次（v4.0.8 起的排障口径），避免刷日志
    let __shiftLogKey = '';

    const __shiftFixedTop = (h) => {
      try {
        const body = document.body;
        if (!body) return;
        const barPx = (typeof h === 'number' && isFinite(h) && h >= 0) ? h : __barHeight();
        const __fsOn = (function () { try { return document.documentElement.getAttribute('data-fnos-fs') === '1'; } catch (_) { return false; } })();
        // 标题栏占的是「设备 px」，fixed 的 top 是页面 CSS px，按缩放因子换算
        const shift = __fsOn ? 0 : Math.round((barPx / __fixedZoom()) * 100) / 100;
        const bar = document.getElementById('fnos-titlebar');
        // v4.0.11：收集元素时穿透 shadow DOM（组件库常见），querySelectorAll 不进 shadow root
        const __collect = (root, out, depth) => {
          try {
            const els = root.querySelectorAll('*');
            const n = Math.min(els.length, 4000);
            for (let i = 0; i < n; i++) {
              const el = els[i];
              if (!el || el.nodeType !== 1) continue;
              out.push(el);
              // 递归进 shadow root（最多 3 层，避免极端嵌套卡死）
              if (depth < 3 && el.shadowRoot) __collect(el.shadowRoot, out, depth + 1);
            }
          } catch (_) {}
        };
        const __all = [];
        __collect(body, __all, 0);
        const els = __all;
        const n = els.length;
        const __hit = [];
        for (let i = 0; i < n; i++) {
          const el = els[i];
          if (!el || el.nodeType !== 1) continue;
          if (bar && (el === bar || bar.contains(el))) continue;
          // 自己注入的节点（标题栏、顶部热区、resize 遮罩、磨砂层…）一律不动：热区必须留在窗口顶边
          const id = String(el.id || '');
          if (id.indexOf('fnos-') === 0) continue;
          try { if (el.hasAttribute && el.hasAttribute('data-fnos-tb')) continue; } catch (_) {}
          // 父级已在接管名单里就不再重复位移（fixed 后代跟着父级走，否则会叠加成双倍偏移）
          let __anc = el.parentElement, __nested = false;
          while (__anc && __anc !== body) {
            if (__anc.__fnosTopShift) { __nested = true; break; }
            __anc = __anc.parentElement;
          }
          if (__nested) continue;
          let os = el.__fnosTopShift;
          if (!os) {
            let cs = null;
            try { cs = getComputedStyle(el); } catch (_) {}
            if (!cs) continue;
            const __pos = cs.position;
            // v4.0.14：position:absolute;top:0 且相对视口定位（rectTop≈0）的元素同样被标题栏压住。
            // 实锤：Naive UI 的 n-layout--absolute-positioned 用 position:absolute;top:0，
            // 原来只认 fixed/sticky，漏了 absolute → band 显示 rectTop:0 未被接管。
            if (__pos !== 'fixed' && __pos !== 'sticky' && __pos !== 'absolute') continue;
            const raw = String(cs.top || '').trim();
            if (!raw || raw.indexOf('%') >= 0 || raw.indexOf('calc') >= 0) continue;
            const v = parseFloat(raw);
            if (!isFinite(v)) continue;
            if (__pos === 'fixed') {
              if (v < -barPx || v > barPx) continue;
              let rt = 0;
              try { rt = el.getBoundingClientRect().top; } catch (_) { rt = 0; }
              if (!(rt <= barPx + 2 && rt > -barPx)) continue;
            } else if (__pos === 'absolute') {
              // absolute：只接管 top≈0 且 rectTop≈0 的（相对视口定位的），
              // 有定位祖先的 absolute（rectTop>0）不动。
              // v4.0.15：只移大容器（rect.height > 80px），避免误移组件内部小组件
              // （n-base-selection__border / n-button__border 等 absolute;top:0 装饰元素）。
              if (v < -2 || v > 2) continue;
              let rt = 0, rh = 0;
              try { const r = el.getBoundingClientRect(); rt = r.top; rh = r.height; } catch (_) { rt = 0; rh = 0; }
              if (!(rt >= -2 && rt <= 2)) continue;
              if (rh < 80) continue; // 只移视口级大容器
            } else {
              // sticky：只接管 top≈0 的
              if (v < -2 || v > 2) continue;
            }
            os = el.__fnosTopShift = {
              v: v,
              inline: String((el.style && el.style.getPropertyValue('top')) || ''),
              pri: String((el.style && el.style.getPropertyPriority('top')) || ''),
            };
          }
          if (!el.style) continue;
          // 相对原值位移：原 top=0 → 34px，原 top=-1 → 33px，缩放/高度变化只重算绝对值
          const want = (shift > 0.25) ? (Math.round((os.v + shift) * 100) / 100 + 'px') : '';
          const cur = String(el.style.getPropertyValue('top') || '');
          const curPri = String(el.style.getPropertyPriority('top') || '');
          if (want) {
            // 值未变不写，避免触发 MutationObserver 自激
            if (cur !== want || curPri !== 'important') el.style.setProperty('top', want, 'important');
            // v4.0.15：absolute 大容器下移后约束 max-height，防止高度溢出视口导致内容截断
            if (__pos === 'absolute') {
              try {
                const __mh = 'calc(100vh - ' + shift + 'px)';
                if (el.style.getPropertyValue('max-height') !== __mh) el.style.setProperty('max-height', __mh, 'important');
              } catch (_) {}
            }
            if (__hit.length < 4) {
              let cls = '';
              try { cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 32); } catch (_) {}
              __hit.push(String(el.tagName || '').toLowerCase() + (id ? '#' + id.slice(0, 24) : '') + (cls ? '.' + cls : ''));
            }
          } else if (cur !== os.inline || curPri !== os.pri) {
            if (os.inline) el.style.setProperty('top', os.inline, os.pri || '');
            else el.style.removeProperty('top');
          }
        }
        const __key = shift + '#' + __hit.length + '#' + __hit.join(',');
        if (__key !== __shiftLogKey) {
          __shiftLogKey = __key;
          // v4.0.13：额外扫描「视觉上在标题栏带内但未被接管」的元素，定位压内容根因
          const __band = [];
          try {
            const __all2 = els;
            for (let i = 0; i < Math.min(__all2.length, 4000); i++) {
              const el = __all2[i];
              if (!el || el.nodeType !== 1) continue;
              if (bar && (el === bar || bar.contains(el))) continue;
              const id2 = String(el.id || '');
              if (id2.indexOf('fnos-') === 0) continue;
              let rt2 = 0;
              try { rt2 = el.getBoundingClientRect().top; } catch (_) { continue; }
              if (rt2 < -2 || rt2 > barPx) continue;
              let cs2 = null;
              try { cs2 = getComputedStyle(el); } catch (_) { continue; }
              if (cs2.display === 'none' || cs2.visibility === 'hidden') continue;
              let cls2 = '';
              try { cls2 = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 48); } catch (_) {}
              __band.push({
                tag: String(el.tagName || '').toLowerCase(),
                id: id2.slice(0, 32),
                cls: cls2,
                pos: cs2.position,
                top: String(cs2.top || '').slice(0, 16),
                rectTop: Math.round(rt2),
              });
              if (__band.length >= 8) break;
            }
          } catch (_) {}
          try {
            ipcRenderer.send('fnos:media-log', {
              stage: 'titlebar.fixed-top',
              shift: shift,
              barH: barPx,
              count: __hit.length,
              sample: __hit,
              band: __band,
            });
          } catch (_) {}
        }
      } catch (_) {}
    };

    // ================= v4.0.16：xapp 内容区不透明底色 =================
    // 背景（用户工单：新标签窗口整窗透明、桌面和后面的文档透出来）：
    // 独立弹窗是 transparent:true 的 BrowserWindow，而 xapp 分支的 CSS 只给 html 设了
    // background:transparent（为了让标题栏透出桌面），body 没设背景 → 整窗透明。
    // 内嵌窗（webview）有主窗的不透明底垫着，所以看不出问题。
    // 做法：给 body 补一个不透明底色（优先取页面自身背景色，取不到按深浅色主题兜底），
    // 标题栏区域（html，y=0~barH）仍保持透明，磨砂/透桌面不受影响。
    // v4.0.25（亮模式配色异常 P0-4）：补底色逻辑降级。
    // 旧逻辑会扫 body 前 40 个元素"抢"第一个不透明大块的颜色：抢到装饰块/遮罩层就整页涂错色，
    // 而且以 !important 写进 body，页面之后自己的主题切换再也盖不回来（亮模式下尤其明显）。
    // 现在只处理「html 与 body 都没画底色」这一种真空透明的情况：值用壳色常量、不加 !important，
    // 只在页面加载完成后补一次，页面自己有任何 background-color 就完全不碰。
    const __applyXappBodyBg = () => {
      try {
        const body = document.body;
        if (!body) return;
        if (String(document.readyState) !== 'complete') return;   // 页面还没画完 → 交给它自己
        const __tr25 = (c) => (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)');
        const htmlBg = (() => { try { return getComputedStyle(document.documentElement).backgroundColor; } catch (_) { return ''; } })();
        const bodyBg = (() => { try { return getComputedStyle(body).backgroundColor; } catch (_) { return ''; } })();
        if (!__tr25(htmlBg) || !__tr25(bodyBg)) return;              // 页面自己画了底色 → 不碰
        if (body.style.getPropertyValue('background-color')) return; // 已补过 → 不重复覆盖
        body.style.setProperty('background-color', __FN_SHELL_BG25);
        __fnLog25('titlebar.xapp-bg', {
          value: __FN_SHELL_BG25, from: 'shell-const', htmlBg: htmlBg, bodyBg: bodyBg,
          href: String(location.href || '').slice(0, 140),
        });
      } catch (_) {}
    };

    // 装上「一次性」重算链路：窗口缩放、DOM 增删（SPA 首帧/路由）、html 上的 --fnos-f /
    // --fnos-bar-h / 全屏属性变化都会触发，节流到 350ms 防抖 + 700ms 最小间隔。
    const __watchFixedTop = () => {
      try {
        if (!window.__fnosShiftWatch) {
          window.__fnosShiftWatch = true;
          let __t = 0, __last = 0;
          const __run = () => {
            const now = Date.now();
            // v4.0.11：原来 700ms 内直接 return 不补跑 → SPA 首帧/路由插入的 fixed 顶栏被永久跳过。
            // 改为延迟补跑，保证每次 bump 最终都会执行一次。
            if (now - __last < 700) {
              if (__t) clearTimeout(__t);
              __t = setTimeout(() => { __t = 0; __run(); }, 700 - (now - __last));
              return;
            }
            __last = now;
            try { __shiftFixedTop(Math.round(__barHeight())); } catch (_) {}
          };
          const __bump = () => {
            if (__t) clearTimeout(__t);
            __t = setTimeout(() => { __t = 0; __run(); }, 350);
          };
          try { window.addEventListener('resize', __bump, { passive: true }); } catch (_) {}
          try {
            // v4.0.11：补 attributes 监听——SPA 组件重渲染只改 class/style 不增删节点时
            // 原 childList-only 观察器完全收不到通知，fixed 顶栏漏接管。
            const mo = new MutationObserver(__bump);
            mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
          } catch (_) {}
          try {
            const mo2 = new MutationObserver(__bump);
            mo2.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-fnos-fs'] });
          } catch (_) {}
        }
        __shiftFixedTop(Math.round(__barHeight()));
      } catch (_) {}
    };

    function build() {
      try {
        if (document.getElementById('fnos-titlebar')) return;

        // 清理可能残留的旧沉浸黑条（v1.60~v1.61 引入，v1.62 移除：它是 no-drag 层会干扰拖动、且强制黑底）
        try { const old = document.getElementById('fnos-embed-topbar'); if (old) old.remove(); } catch (_) {}

        // ---- 顶部拖动热区：高 34px（与标题栏同高），始终存在、始终可拖动（含标题栏隐藏时） ----
        const hot = document.createElement('div');
        hot.id = 'fnos-titlebar-hotzone';
        hot.setAttribute('aria-hidden', 'true');
        __setCss(hot, [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'height:6px',
          'z-index:2147483646', 'pointer-events:auto', 'background:transparent', '-webkit-app-region:drag',
          'user-select:none'
        ].join(';'));
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
        // v4.0.11（用户工单：非主窗标题栏"形式和偏好设置里不一样"）——
        // 原来非主窗 __barBg 恒 transparent，等 applyStyle() 才落值；但磨砂抓屏失败时
        // applyStyle 也只给 10% 淡染色，标题栏几乎透明 → 透出页面自身顶栏，看起来是
        // "另一套标题栏"。现在 __barBg 直接按偏好设值：
        // 磨砂 → frostColor 35% 底（applyStyle 可再调）；纯色 → solidColor 90%+ 底。
        const __barBg = __isMainWin
          ? 'linear-gradient(180deg, rgb(6,9,21) 0%, rgb(3,6,16) 100%)'
          : (TB.material === 'frosted'
            ? hexToRgba(TB.frostColor || '#ffffff', Math.max(TB.frostAlpha == null ? 10 : TB.frostAlpha, 35) / 100)
            : hexToRgba(TB.solidColor || TB.color || '#101426', Math.max(TB.solidAlpha == null ? 100 : TB.solidAlpha, 90) / 100));
        // v2.15.71：主窗口标题栏高度 34->35px，标题栏本体向下侵入内容区 1px 盖住接缝，
        // 取代 v2.15.70 伪元素方案（伪元素在 Windows 高分 DPI 下仍会透细线）。
        // 仅主窗口生效，设置窗/应用窗保持 34px 不变。
        // v4.0.7（用户纠正）：盖接缝的 2px 只留给主窗。应用窗 / 跳转窗刻意保持
        // 「标题栏高度 = 内容让位高度」，标题栏绝不压住内容区第一行。
        bar.__tbIsMain = __isMainWin; // 皮肤高度联动：主窗视觉高度 = 有效高度 + 2px 盖接缝
        __setCss(bar, [
          'position:fixed', 'top:0', 'left:0', 'width:calc(100vw * var(--fnos-f, 1))', 'height:' + (__skinHeight + (__isMainWin ? 2 : 0)) + 'px',
          'z-index:2147483647', 'display:flex', 'align-items:center',
          'justify-content:space-between', 'box-sizing:border-box',
          // v4.0.24（工单：程序内内嵌窗点 ✕ 关不掉、点下去窗口会躲避）：
          // 整条标题栏不再吃事件，只有 ☰ / — □ ✕ / 中段拖拽条各自 pointer-events:auto。
          // 之前这里是 auto，标题栏 34px 高的图层盖在页面顶部，飞牛桌面内嵌窗的 ✕ 常常正好
          // 落在这条带的边缘 → mousedown 被本层吃掉 → 立刻 send('window-drag') 拖动整个原生窗
          // → 窗口位移、mouseup 不在 ✕ 上 → click 丢失。改成 none 后这类点击直接穿透到页面。
          'pointer-events:none',
          // v3.0.37（用户明确要求）：标题栏四角统一为 10px 小 R 角，即 v2.15.99 的原样设计。
          // v3.0.36 曾私自改成「上两角 20px + 下两角 0」，已按用户要求撤回。
          'border-radius:10px',
          'background:' + __barBg,
          // v2.15.74：主窗口底部 1px 同色实边，与 height 36px 配合把重叠 1px 加到 2px，
          // 吸收 Windows 高分 DPI 下窗口缩放产生的小数亚像素抗锯齿，根治间歇性灰线。
          // box-sizing:border-box 使内容盒仍为 35px，标题栏按钮/菜单垂直位置与 v2.15.73 完全一致。
          // v2.15.80: the 1px border-bottom was painted rgb(3,6,16), the same colour as the gradient tail, so it never read as a border but did form a hard 1px band where the bar meets the content - the dark line under the titlebar. Transparent keeps the box geometry identical (border-box, content box still 35px, buttons unmoved) while letting the bar gradient show through that 1px, so the edge is continuous and the seam is still covered.
          'border-bottom:none',
          // v4.0.4（用户工单「点最上排图标点不了，但按住能拖窗口」）——
          // 标题栏不再注册系统级 -webkit-app-region:drag：drag 区会把 mousedown 交给 Windows
          // 的移动循环，DOM 收不到任何事件（连日志都没有），表现为「点不动、但按住就把窗口拖走」。
          // 现在整条标题栏都是 no-drag，拖动只走自己的 win-drag-* 通道（中点条 + 顶部 6px 热区）。
          '-webkit-app-region:no-drag',
          'user-select:none',
          'transition:transform .16s ease,opacity .16s ease',
          // v2.17.15: every window type now cancels page zoom on the bar, so its
          // pixels stay identical while only the page content zooms.
          'zoom:calc(1 / var(--fnos-f, 1))'
        ].filter(Boolean).join(';'));

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
              __setCss(__rcEl, 'position:fixed;top:34px;left:0;right:0;height:0;background:#05060a;z-index:2147483645;pointer-events:none;display:none;');
              (document.documentElement || document.body).appendChild(__rcEl);
            }
            if (!window.__fnosResizeCover) {
              window.__fnosResizeCover = true;
              let __rcT = 0;
              const __rcBump = function () {
                const el = document.getElementById('fnos-resize-cover');
                // v3.0.47（用户反馈：拖动窗口掉帧）：display 是布局属性，每帧重复写 block 会让整页
                // 反复布局失效。已 block 就不再写，只刷新 260ms 的隐藏计时。
                if (el && el.style.display !== 'block') { try { el.style.display = 'block'; } catch (_) {} }
                if (__rcT) clearTimeout(__rcT);
                __rcT = setTimeout(function () {
                  __rcT = 0;
                  const e2 = document.getElementById('fnos-resize-cover');
                  if (e2) { try { e2.style.display = 'none'; } catch (_) {} }
                }, 260);
              };
              window.addEventListener('resize', __rcBump, { passive: true });
              // A window move fires no DOM event, but window.screenX/screenY follow it.
              // v3.0.47（用户反馈：拖动窗口掉帧）——原来这是一个永不停止的 rAF 常驻轮询：每帧读
              // window.screenX/screenY，窗口一移动就每帧 __rcBump()，等于拖动全程每帧切一次布局。
              // 现在只在「窗口正在移动」时逐帧跟随（防灰条需要逐帧遮罩），静止期降到 50ms 一次
              // （最坏 3 帧延迟，肉眼无感），静止时不再常驻 rAF。
              let __rcX = window.screenX, __rcY = window.screenY;
              let __rcMoving = false;
              const __rcSchedule = function () {
                if (__rcMoving) requestAnimationFrame(__rcWatch);
                else setTimeout(__rcWatch, 50);
              };
              const __rcWatch = function () {
                try {
                  if (window.screenX !== __rcX || window.screenY !== __rcY) {
                    __rcX = window.screenX;
                    __rcY = window.screenY;
                    __rcMoving = true;
                    __rcBump();
                  } else if (__rcMoving) {
                    __rcMoving = false;
                  }
                } catch (_) {}
                __rcSchedule();
              };
              __rcSchedule();
            }
          }
        } catch (_) {}

        // 左侧：☰ 菜单按钮（弹出原系统菜单栏全部内容）
        const left = document.createElement('div');
        __setCss(left, '-webkit-app-region:no-drag;pointer-events:auto;display:flex;align-items:center;height:34px;padding-left:' + (isMac ? '78px' : '6px') + ';margin-left:4px;');
        const menuBtn = document.createElement('button');
        menuBtn.id = 'fnos-tb-menu';
        menuBtn.title = '菜单（文件/下载/视图/工具/设置/帮助）';
        __setCss(menuBtn, 'width:46px;height:34px;border:none;outline:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;-webkit-app-region:no-drag;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85));');
        menuBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="rgba(255,255,255,0.95)" stroke-width="1.5" stroke-linecap="round"/></svg>';
        menuBtn.addEventListener('mouseenter', () => { menuBtn.style.background = 'rgba(255,255,255,0.12)'; });
        menuBtn.addEventListener('mouseleave', () => { menuBtn.style.background = 'transparent'; });
        menuBtn.addEventListener('click', () => {
          try {
            // v3.0.69：把按钮的 CSS 矩形一并上报，主进程用它算菜单锚点（不再靠"ready 时取光标 - 18"）
            let __ma = null;
            try {
              const __r = menuBtn.getBoundingClientRect();
              __ma = { left: Math.round(__r.left), bottom: Math.round(__r.bottom) };
            } catch (_) { __ma = null; }
            ipcRenderer.send('app-popup-menu', __ma);
            bar.__menuOpen = true;
            setTimeout(() => { bar.__menuOpen = false; scheduleHide(bar, 600); }, 1600);
          } catch (_) {}
        });
        left.appendChild(menuBtn);

        // 右侧：最小化/最大化/关闭——实心 Windows 风格，按钮可点击区域充足
        const btns = document.createElement('div');
        __setCss(btns, '-webkit-app-region:no-drag;pointer-events:auto;display:flex;align-items:stretch;height:34px;margin-right:8px;overflow:hidden;');

        const mkBtn = (id, svg, hoverBg, tip) => {
          const b = document.createElement('button');
          b.id = id;
          b.title = tip || (id === 'fnos-tb-min' ? '最小化' : id === 'fnos-tb-max' ? '最大化/还原' : '关闭');
          __setCss(b, [
            'width:46px', 'height:34px', 'border:none', 'outline:none',
            'background:transparent', 'color:#fff',
            'cursor:pointer', 'display:flex', 'align-items:center', 'justify-content:center',
            'padding:0', '-webkit-app-region:no-drag', 'flex:0 0 auto',
            'filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85))'
          ].join(';'));
          b.innerHTML = svg;
          // v2.0.3：确保SVG图标不受页面CSS影响
          const svgEl = b.querySelector('svg');
          if (svgEl) { __setCss(svgEl, 'display:block;pointer-events:none;flex-shrink:0;');; }
          b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
          b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
          return b;
        };

        // v4.0.28（用户工单「主程序内打开的所有应用，标题栏一律不要刷新 / 新标签打开」）：
        // 自绘栏只保留 ☰ + — □ ✕。↻ 刷新、↗ 新标签打开两钮连同事件一起删除，
        // 内嵌窗（B 段）与独立跳出窗（本段）都不再有这两个入口。
        // 历史：v4.0.18 加、v4.0.20 删、v4.0.21 恢复、v4.0.28 按用户定案再次删除（且不再恢复）。

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
        const __tbLog = (stage, o) => { try { ipcRenderer.send('fnos:media-log', Object.assign({ stage }, o)); } catch (_) {} };
        // v4.0.24（工单：内嵌窗点 ✕ 关不掉、点下去窗口会躲避）：
        // bar/hot 以前是「mousedown 立刻 send('window-drag')」——只要按下落在标题栏那条带上，
        // 原生窗口立刻跟手位移，mouseup 时鼠标已不在原按钮上，click 直接丢失。
        // 现在与 dragStrip 一样走「移动超过 4px 才拖」，纯点击不移动窗口。
        const startNativeDrag = (ev) => {
          try {
            if (ev.button !== 0) return;
            const t = ev.target;
            if (t && t.closest && t.closest('#fnos-tb-dragstrip, button, .fnos-tb-no-drag, #fnos-tb-min, #fnos-tb-max, #fnos-tb-close, #fnos-tb-menu')) return;
            // v4.0.24：这条带下面若是页面控件（内嵌窗 ✕ 等），按下不拖动，松手把点击还给它
            try {
              const __c0 = __tbPickUnderCtl(ev.clientX, ev.clientY);
              if (__c0) {
                const __up0 = () => {
                  try { window.removeEventListener('mouseup', __up0, true); } catch (_) {}
                  try {
                    __c0.click();
                    ipcRenderer.send('fnos:media-log', { stage: 'tb.passthrough.click', tag: __c0.tagName, cls: String(__c0.className || '').slice(0, 60) });
                  } catch (_) {}
                };
                window.addEventListener('mouseup', __up0, true);
                return;
              }
            } catch (_) {}
            const __now = Date.now();
            const __sx = ev.screenX || 0, __sy = ev.screenY || 0;
            const __trigger = (ev.currentTarget === hot) ? 'hot' : 'bar';
            if (__now - __lastTbDown < 450 && Math.abs(__sx - __lastTbDownX) < 8 && Math.abs(__sy - __lastTbDownY) < 8) {
              __lastTbDown = 0;
              __tbLog('tb.drag.dblclick', { trigger: __trigger, x: __sx, y: __sy });
              try { ipcRenderer.send('window-maximize'); } catch (_) {}
              return;
            }
            __lastTbDown = __now;
            __lastTbDownX = __sx;
            __lastTbDownY = __sy;
            let __started = false, __dx = 0, __dy = 0;
            const __t0 = __now;
            const __cleanup = () => {
              try { window.removeEventListener('mousemove', __onMove, true); window.removeEventListener('mouseup', __onUp, true); } catch (_) {}
            };
            const __onMove = (m) => {
              try {
                __dx = (m.screenX || 0) - __sx;
                __dy = (m.screenY || 0) - __sy;
                if (__started) return;
                if (Math.abs(__dx) >= 4 || Math.abs(__dy) >= 4) {
                  __started = true;
                  __tbLog('tb.drag.start', { trigger: __trigger, x: __sx, y: __sy, dx: __dx, dy: __dy });
                  ipcRenderer.send('window-drag');
                  __cleanup();
                }
              } catch (_) {}
            };
            const __onUp = () => {
              __tbLog('tb.drag.end', { trigger: __trigger, dx: __dx, dy: __dy, moved: __started, durMs: Date.now() - __t0 });
              __cleanup();
            };
            window.addEventListener('mousemove', __onMove, true);
            window.addEventListener('mouseup', __onUp, true);
          } catch (_) {}
        };
        hot.addEventListener('mousedown', startNativeDrag);
        bar.addEventListener('mousedown', startNativeDrag);

        if (!isMac) {
          // v4.0.28：不再追加 ↻ / ↗（见上）
          btns.appendChild(minBtn); btns.appendChild(maxBtn); btns.appendChild(closeBtn);
        }
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
        __setCss(dragStrip, 'flex:1;height:100%;min-width:20px;-webkit-app-region:no-drag;pointer-events:auto;cursor:default;');
        (function () {
          const W = window;
          W.__fnosDsDown = null;
          // v3.0.51（用户反馈：拖动窗口时边沿抖动）——
          // 拖动期间系统侧会把客户区尺寸重算成 1~3px 不同的值（日志实测：一次拖动 7 秒 205 条
          // resize，约每帧一条），页面根节点跟着每帧重排，肉眼就是「窗口边缘/圆角抖动 + 图标网格跳」。
          // 按下标题栏时记下当前客户区尺寸并把 <html> 钉死在这个尺寸（!important），松手解锁：
          // 拖动过程中系统再怎么报 1~3px 的尺寸变化，页面也不会重排。对布局的影响只有 ±1~3px。
          const __pinSize = function () {
            try {
              if (W.__fnosPin) return;
              const de = document.documentElement;
              W.__fnosPin = { w: de.clientWidth || W.innerWidth, h: de.clientHeight || W.innerHeight, pw: de.style.width, ph: de.style.height };
              de.style.setProperty('width', W.__fnosPin.w + 'px', 'important');
              de.style.setProperty('height', W.__fnosPin.h + 'px', 'important');
            } catch (_) {}
          };
          const __unpinSize = function () {
            try {
              if (!W.__fnosPin) return;
              const de = document.documentElement;
              if (W.__fnosPin.pw) de.style.setProperty('width', W.__fnosPin.pw); else de.style.removeProperty('width');
              if (W.__fnosPin.ph) de.style.setProperty('height', W.__fnosPin.ph); else de.style.removeProperty('height');
              W.__fnosPin = null;
            } catch (_) {}
          };
          // v2.17.47：按住标题栏时把指针捕获到本层，鼠标甩出窗口/窗口追不上鼠标时也能持续收到
          // 移动事件（否则 Windows 停止投递 WM_MOUSEMOVE，拖动会中途卡住）。
          // ---- v3.0.66 拖动重建（用户工单：拖动标题栏后点 × 点不中、窗口跟着鼠标一起跑）----
          // 旧实现的三个坑：① pointerdown 无条件 setPointerCapture，把后续指针事件全锁给拖动层；
          //   ② mousedown 立刻发 win-drag-start，主进程马上进入拖动态（最大化窗口会在首条 move 时
          //   unmaximize 并跳位）；③ 没有阈值，1px 抖动就算拖动，单击被吞成拖动。
          // 现在：按钮/控件按下直接放行（不捕获、不发拖动消息）；移动超过 4px 才进入拖动并迟发
          //   win-drag-start；指针捕获也在那一刻才开；松手 / 失焦 / 左键已抬起 立刻释放并复位；
          //   每条 move 都带上 buttons，主进程再验一次「左键确实按着」，杜绝状态残留导致窗口漂移。
          const __isCtl = function (t) {
            try { return !!(t && t.closest && t.closest('button,input,select,textarea,a[href],[data-fnos-no-drag]')); } catch (_) { return false; }
          };
          const __endDrag = function (reason) {
            // v4.0.3（用户工单「窗口区应用点不动，变成拖动区域」）——
            // v4.0.2 对 mouseup 也给了 120ms 宽限，结果「快速点一下标题栏」后 __fnosDsDown 残留：
            // 接着在内容区按下（没有新的 mousedown 重置它）再移动，就被当成上一次拖动的继续，
            // 于是应用图标点不动、整个窗口像拖动区。现在只对「激活窗口的 blur 噪声」宽限，
            // mouseup / pointerup / 其它来源一律立即生效。
            if ((reason === 'blur' || reason === 'cancel') && !W.__fnosDsDrag
              && W.__fnosDsDownAt && Date.now() - W.__fnosDsDownAt < 120) return;
            try {
              if (W.__fnosDsDrag) ipcRenderer.send('win-drag-end');
              else ipcRenderer.send('win-drag-arm-end');
            } catch (_) {}
            W.__fnosDsDown = null; W.__fnosDsDrag = false; W.__fnosDsPend = null; W.__fnosDsSrc = null;
            try { if (W.__fnosDsPid != null && dragStrip.releasePointerCapture) dragStrip.releasePointerCapture(W.__fnosDsPid); } catch (_) {}
            W.__fnosDsPid = null;
            __unpinSize(); // v3.0.51：松手解锁页面尺寸
          };
          dragStrip.addEventListener('pointerdown', function (e) {
            // v3.0.66：此处不再捕获指针——预捕获会把按钮的 click 抢走（工单⑤ setPointerCapture）
            try { if (e.pointerId != null) W.__fnosDsPid = e.pointerId; } catch (_) {}
          });
          // v4.0.24：松手时若这次按下落在页面控件上（没发生拖动），把点击还给页面
          dragStrip.addEventListener('mouseup', function () {
            const __c = W.__fnosDsCtl; W.__fnosDsCtl = null;
            if (__c && !W.__fnosDsDrag) {
              try { __c.click(); ipcRenderer.send('fnos:media-log', { stage: 'tb.passthrough.click', tag: __c.tagName, cls: String(__c.className || '').slice(0, 60) }); } catch (_) {}
            }
          });
          dragStrip.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            if (__isCtl(e.target)) return; // 工单①：点在按钮/控件上不启动拖动
            try {
              const __c0 = __tbPickUnderCtl(e.clientX, e.clientY);
              try { ipcRenderer.send('fnos:media-log', { stage: 'tb.pick', hit: !!__c0, tag: __c0 && __c0.tagName, cx: e.clientX, cy: e.clientY }); } catch (_) {}
              if (__c0) { W.__fnosDsCtl = __c0; W.__fnosDsDrag = false; return; }
            } catch (err) {
              try { ipcRenderer.send('fnos:media-log', { stage: 'tb.pick.err', err: String((err && err.message) || err) }); } catch (_) {}
            }
            W.__fnosDsDown = { x: (e.screenX || 0), y: (e.screenY || 0) };
            W.__fnosDsDrag = false;
            // v4.0.2：记下按下时刻。窗口从「未激活」被点激活时，头几帧的 buttons 可能是 0，
            // 旧逻辑据此把整次拖动直接作废（用户工单：第一次拖动肯定失败，再按一次才行）。
            W.__fnosDsDownAt = Date.now();
            // v4.0.3：标记这次按下来源于标题栏。__fwd 只认这个来源，内容区的按下永远不会变成拖动。
            W.__fnosDsSrc = 'tb';
            // v3.0.82：按下就通知主进程「准备拖」（只登记起点 + 挂起磨砂采样，不动窗口、
            // 不还原最大化）。越过阈值时 win-drag-start 直接沿用这个起点，起步没有死区。
            try { ipcRenderer.send('win-drag-arm', { sx: (e.screenX || 0), sy: (e.screenY || 0) }); } catch (_) {}
            // v3.0.66：win-drag-start 不再在这里发，改由 __fwd 判定超过 4px 阈值后迟发
          });
          dragStrip.addEventListener('dblclick', function (e) {
            W.__fnosDsDown = null; W.__fnosDsDrag = true;
            __unpinSize(); // v3.0.51：双击最大化前解除尺寸钉死
            try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
            try { ipcRenderer.send('window-maximize'); } catch (_) {}
          });
          if (!W.__fnosDsHooked) {
            W.__fnosDsHooked = true; W.__fnosDsDrag = false;
            W.__fnosDsRaf = 0; W.__fnosDsPend = null;
            const __fwd = function (e) {
              if (!W.__fnosDsDown) return;
              // v3.0.66：左键已经松开（pointerup 被吞过）——立刻复位，绝不继续拖动
              if (e.buttons === 0) {
                // v4.0.2：按下后 200ms 内不信 buttons —— 激活窗口的噪声帧是 0，
                // 旧逻辑在这里就把整次拖动作废，「第一次拖不动」就是这条打出来的。
                if (!W.__fnosDsDrag && Date.now() - (W.__fnosDsDownAt || 0) < 200) return;
                __endDrag('nobutton');
                return;
              }
              try {
                if (!W.__fnosDsDrag) {
                  // v4.0.3：只允许从标题栏发起拖动。没有标题栏按下标记（或已被内容区按下清掉）
                  // 就直接收摊，绝不让内容区的按下"续上"成拖动。
                  if (W.__fnosDsSrc !== 'tb') { __endDrag('notitlebar'); return; }
                  // v3.0.81：阈值 4px -> 2px。4px 死区偏大，用户感受到的是「刚按下那一下拖不动」；
                  // 2px 仍能区分单击（拖起来后立刻松开就是一次普通点击，不会误判）
                  if (Math.abs((e.screenX || 0) - W.__fnosDsDown.x) <= 2 && Math.abs((e.screenY || 0) - W.__fnosDsDown.y) <= 2) return;
                  W.__fnosDsDrag = true;
                  // v3.0.82：不再把基准改到「越过阈值这一刻」（那等于把已经发生的 2px 位移吞掉，
                  // 用户感受就是「拖了一下窗口还没动」）。继续用按下点，主进程按 arm 记录的窗口
                  // 位置 + 按下点算位移，窗口立刻跟手（最多跳 2px，符合直觉）。
                  try { ipcRenderer.send('win-drag-start', { sx: W.__fnosDsDown.x, sy: W.__fnosDsDown.y }); } catch (_) {}
                  // v3.0.66：捕获在真正开始拖动时才开；pointerId 缺失时用本帧事件兜底
                  try {
                    const __pid = (W.__fnosDsPid != null ? W.__fnosDsPid : e.pointerId);
                    if (__pid != null) { W.__fnosDsPid = __pid; if (dragStrip.setPointerCapture) dragStrip.setPointerCapture(__pid); }
                  } catch (_) {}
                  __pinSize(); // v3.0.51：拖动期间钉死页面尺寸，消掉每帧重排导致的边沿抖动
                  return;
                }
                // 每次移动都把最新屏幕坐标交给主进程（rAF 合并，60fps 上限）
                W.__fnosDsPend = { sx: (e.screenX || 0), sy: (e.screenY || 0), buttons: 1 };
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
            W.addEventListener('mouseup', function () { __endDrag('up'); }, true);
            W.addEventListener('pointerup', function () { __endDrag('up'); }, true);
            // v3.0.66：失焦 / 页面隐藏也要复位（拖动中切窗、锁屏、任务视图都会丢 pointerup）
            W.addEventListener('blur', function () { __endDrag('blur'); }, true);
            document.addEventListener('visibilitychange', function () { try { if (document.hidden) __endDrag('hidden'); } catch (_) {} }, true);
            W.addEventListener('pointercancel', function () { __endDrag('cancel'); }, true);
            // v4.0.3：拖动严格限制在标题栏内 —— 任何在标题栏之外按下的 mousedown，
            // 都把上一次残留的按下状态清掉（内容区的点击永远只是点击）。
            document.addEventListener('mousedown', function (e) {
              try {
                // v4.0.4：顶部命中诊断 —— 「点不动」时靠这条日志直接看出是谁在上面挡着。
                // 只在窗口顶部 150px 内记录，不刷屏。
                try {
                  const cy = (typeof e.clientY === 'number') ? e.clientY : -1;
                  if (cy >= 0 && cy <= 150 && typeof ipcRenderer.send === 'function') {
                    const el = (e.target && e.target.nodeType === 1) ? e.target : null;
                    const chain = [];
                    let n = el;
                    for (let i = 0; n && i < 4; i++) {
                      let cls = '';
                      try { if (typeof n.className === 'string' && n.className.trim()) cls = '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.'); } catch (_) {}
                      chain.push((n.tagName || '?').toLowerCase() + (n.id ? '#' + n.id : '') + cls);
                      n = n.parentElement;
                    }
                    const bEl = document.getElementById('fnos-titlebar');
                    const bR = bEl ? bEl.getBoundingClientRect() : null;
                    const hEl = document.getElementById('fnos-titlebar-hotzone');
                    const hR = hEl ? hEl.getBoundingClientRect() : null;
                    const sEl = document.getElementById('fnos-tb-dragstrip');
                    const sR = sEl ? sEl.getBoundingClientRect() : null;
                    ipcRenderer.send('tb-hit', {
                      cx: Math.round(e.clientX || 0), cy: Math.round(cy),
                      chain: chain.join(' < '),
                      barH: bR ? Math.round(bR.height) : -1,
                      barBottom: bR ? Math.round(bR.bottom) : -1,
                      hotH: hR ? Math.round(hR.height) : -1,
                      stripH: sR ? Math.round(sR.height) : -1,
                      bodyPadTop: (function () { try { return getComputedStyle(document.body).paddingTop; } catch (_) { return '?'; } })(),
                      bodyTransform: (function () { try { return getComputedStyle(document.body).transform; } catch (_) { return '?'; } })(),
                      htmlPadTop: (function () { try { return getComputedStyle(document.documentElement).paddingTop; } catch (_) { return '?'; } })(),
                      dpr: window.devicePixelRatio || 1,
                    });
                  }
                } catch (_) {}
                if (W.__fnosDsDrag || !W.__fnosDsDown) return;
                const t = e.target;
                if (t && t.closest && t.closest('#fnos-tb-dragstrip, #fnos-titlebar, #fnos-titlebar-hotzone')) return;
                __endDrag('other-area');
              } catch (_) {}
            }, true);
            // v3.0.77（电视直播窗拖不动）——鼠标落进 MPV 原生窗后松开，本层收不到 mouseup，
            // 主进程会按「光标连续静止」自行收尾并发这条消息；这里把拖动残留状态（尺寸钉死、
            // __fnosDs*）复位，否则下一次 resize 会带着旧的 clientWidth/Height 走。
            try {
              ipcRenderer.on('window-drag-cancelled', function () {
                try { __endDrag(); } catch (_) {}
              });
            } catch (_) {}
          }
        })();
        bar.appendChild(dragStrip);
        bar.appendChild(btns);
        __attachSkinLayers(bar);
        root().appendChild(bar);
        // v3.0.70：挂载后立刻按「标题栏四角」设置收口半径（直角=0px / 圆角=10px）
        try { __fixBarRadius(bar); } catch (_) {}
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
      // v5.0.1（用户要求：去掉底部横向滚动条与右侧纵向滚动条）——
      // 应用窗统一隐藏滚动条，滚轮/键盘滚动能力保留。
      try {
        if (!document.getElementById('fnos-hide-sb')) {
          const __sb = document.createElement('style');
          __sb.id = 'fnos-hide-sb';
          __sb.textContent = '::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}'
            + 'html,body,*{scrollbar-width:none !important;-ms-overflow-style:none !important;}';
          (document.head || document.documentElement).appendChild(__sb);
        }
      } catch (_) {}
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
      // v4.0.76：音乐窗用系统原生标题栏（--fnos-native-frame），不再注入自绘栏
      const __isNativeFrame76 = __argv.indexOf('--fnos-native-frame') >= 0;
      const __isSettings = (!__isAppWin && __argv.indexOf('--fnos-shell') < 0); // 设置窗口：无 --fnos-shell 也无 --fnos-app-window（不透明窗口，独立布局）
      // ===== v5.1.17（mac 用户工单：拖动窗口就出现白块）根修 =====
      // 根因：macOS 上本项目 13 处 BrowserWindow 全都是「不透明窗」（transparent:false +
      // backgroundColor:#14121b）——窗口本身没有 alpha，但页面里还留着两处透明：
      //   ① html 的「透明 GIF 守卫」（本意是 Windows 上让标题栏透出桌面壁纸）→ 顶部标题栏
      //      预留条（34px）整条是 alpha=0，什么都没画；
      //   ② body 的壳色是半透明 / 四角 clip-path 之外也是 alpha=0。
      // 静止时这两处由窗口服务器的窗口底色 #14121b 兜底，看起来正常；一旦窗口被拖动
      // （原生拖动 + 主进程 setBounds 逐帧移动），窗口内容重新合成，未绘制区只能由窗口服务器
      // 补默认底色——mac 上补出来的是白色，于是「拖一下就白、停止拖动后仍在」（只有重启窗口
      // 才重新出一次完整页面）。CDP 实测（改前，拖动中截图）：顶部预留条 0~30 设备像素
      // 100% alpha=0（a_min=0/a_mean=0），四角像素 (0,0,0,0)，全帧 alpha=0 占 4.88%。
      // 修法：mac 上把 html/body 全部改成实色 #14121b，页面里不再存在任何 alpha=0 的像素；
      // Windows 一行不动（仍透明 + 磨砂自绘，透出桌面壁纸的效果完全保留）。
      const __MAC_SOLID_BG = '#14121b';
      const __gifBg = isMac
        ? ('background-color:' + __MAC_SOLID_BG + ' !important;background-image:none !important;')
        : 'background-image:url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7") !important;background-color:transparent !important;';
      // v5.1.17：mac 上「透明界面」滑块无法真的透明（窗口本身不透明），留着只会把 body 写回
      // 半透明 → 又给白块留出 alpha 通道。mac 一律用实色。
      const __solidOnMac = isMac ? ('background:' + __MAC_SOLID_BG + ' !important;') : 'background:transparent !important;';
      // v4.0.25：壳色只给自家页面。第三方/Docker 应用页绝不写 body 底色——
      // 「暗模式正常、亮模式黑底深字」就是这条 !important 深色常量造成的。
      const __shellBgCss25 = __fnIsThirdParty25 ? '' : ('background:' + (isMac ? __MAC_SOLID_BG : __FN_SHELL_BG25) + ' !important;');
      if (__isSettings) {
        // 设置窗口（settings.html，不透明窗口）：标题栏 bar 占顶部 34px。
        // v2.15.56：改用 body transform 下移 34px（而非 padding-top）——padding-top 无法约束 fixed 元素
        // 会钻到标题栏底下；transform 让全部内容（含 fixed）整体下移，标题栏独立顶部。
        // html 锁死滚动，body 单滚动（settings.css 配合）。
        // v2.18.5（用户要求「帮助页 / 偏好设置页 / 关于窗的 R 角与程序主页面一致」）：
        // 四角 clip-path 由 10px 改回 20px，与主窗口、应用窗口完全同一数值。
        // v2.18.0 曾为了与标题栏 bar 的 10px 同比例收到 10px，实测观感偏方，现按用户回归 20px。
        __padStyle.textContent = 'html{overflow:hidden !important;' + __gifBg + '}' +
          'html>body{transform:translateY(var(--fnos-bar-h, 34px)) !important;height:calc(100vh - var(--fnos-bar-h, 34px)) !important;min-height:0 !important;max-height:calc(100vh - var(--fnos-bar-h, 34px)) !important;box-sizing:border-box !important;overflow-y:auto !important;padding-top:0 !important;margin:0 !important;clip-path:inset(0 round 20px) !important;' + __shellBgCss25 + '}' +
          (__fnIsThirdParty25 || isMac ? '' : 'html.fnos-ui-transparent>body{background:rgba(5,6,10,var(--fnos-ui-a,.38)) !important;}');
      } else if (__isAppWin && /\/music(\/|\?|$)/i.test(String(location.href || ''))) {
        // v4.0.79（用户：播放条被裁+偏大）：播放条是 position:absolute bottom:0（相对 body padding box）。
        // 用 padding-top+border-box 让 body 总高 = 视口高，padding box 底 = 视口底 → 播放条贴底完整可见。
        // 不用 transform/margin/height（任一改动都会让播放条错位）。自绘栏在 build() 入口跳过。
        __padStyle.textContent = [
          // v5.1.17：mac 上实色（见 __MAC_SOLID_BG 注释），Windows 保持透明
          'html{overflow:hidden !important;background:' + (isMac ? __MAC_SOLID_BG : 'transparent') + ' !important;}',
          'html>body{padding-top:var(--fnos-bar-h, 34px) !important;height:100vh !important;',
          '  box-sizing:border-box !important;overflow:hidden !important;margin:0 !important;}',
          // v4.0.82（用户工单：播放条仍被底部裁 18px）：body 让位 34px 后，#root 仍按 100vh=800 排，
          // 实际区域变成 34..834，底部 34px 溢出视口 → 悬浮播放条下半截被裁。
          // 让 #root / music-app-layout 也扣掉标题栏高度，整页正好落在 34..800。
          '#root{height:calc(100vh - var(--fnos-bar-h, 34px)) !important;min-height:0 !important;}',
          '.music-app-layout{height:100% !important;min-height:0 !important;}',
          // v4.0.83（用户要求）：播放条整体缩到 80%，底边对齐、水平居中
          '.music-player-glass{transform:scale(.8) !important;transform-origin:bottom center !important;}',
          // v4.0.86（用户要求）：保留应用窗 20px 圆角，只把音乐页自带 body 背景去掉（透明），
          // 圆角处露出的是窗口自身的深色底（v4.0.84 已设 #14121b），因此不会再有灰边/壁纸。
          // v4.0.89（用户要求：音乐窗四角都要圆）：用户「窗口四角」选的是**大半圆角**，
          // 其定义是「上两角直角 + 下两角圆」——所以上面两角天生是方的。
          // 音乐窗这里用更高优先级强制四角 20px（html:root:root 压过圆角模块的 html:root）。
          'html:root:root{clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;'
            + '-webkit-clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;' + __solidOnMac + '}',
          'html:root:root>body{clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;' + __solidOnMac + '}',
          'html>body{' + __solidOnMac + '}',
        ].join('');
      } else if (__isAppWin && __argv.indexOf('--fnos-xapp') >= 0) {
        // v4.0.73（用户工单：飞牛音乐底部播放条/列表底部被裁）：
        // 音乐 App 的播放条是 position:fixed bottom:0，而下面 __isAppWin 分支给 body 加了
        // transform（创建包含块）→ fixed 后代改为相对 body 定位，整体下移 41px 被窗口下沿裁掉。
        // 这里让音乐 App 复用第三方分支的「html padding-top 让位 + body height:100%」策略：
        // 不做 transform，fixed 继续相对 viewport 定位，几何与浏览器一致。
        // v3.0.46（网友反馈：Docker/qBittorrent 等第三方应用在客户端里底部状态栏压住"信息"面板
        // 的字段、整页显示不正常；浏览器打开正常）：
        // 第三方应用的布局依赖 position:fixed 顶/底栏与真实 100vh。下面 __isAppWin 分支用
        // body transform 让位，会创建包含块（fixed 后代改为相对 body 定位 → 底栏整体偏移 34px），
        // 同时把 body 高度压成 calc(100vh-34px)（硬编码 100vh 的容器比可视区高 34px）→ 底栏
        // 恰好压住内容最后一行。这里不做 transform、不改 body 高度：改用 html padding-top 让位，
        // fixed 继续相对 viewport 定位，body 高度 = 可视区 - 标题栏，与浏览器里的几何一致。
        __padStyle.textContent = [
          'html{overflow:hidden !important;height:100% !important;box-sizing:border-box !important;padding-top:calc(var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;' + __gifBg + '}',
          'html>body{height:100% !important;min-height:0 !important;max-height:100% !important;box-sizing:border-box !important;overflow-y:auto !important;padding-top:0 !important;margin:0 !important;}',
          'html>body .h-screen,html>body .h-dvh{height:calc(100% - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          'html>body .min-h-screen,html>body .min-h-dvh{min-height:calc(100% - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          'html>body [class*="100vh"],html>body [class*="h-screen"],html>body [class*="h-dvh"]{max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          'html>body [style*="100vh"]{max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          // v4.0.90（用户工单：qBittorrent 底部状态栏不固定、滚侧栏时跟着走）：
          // qBittorrent WebUI 的 #desktop 用 100vh 铺满，html 让位 34px 后它比可视区高 34px，
          // #desktopFooter 被顶出视口 → 状态栏错位。这里把根容器压到可视区高度，底栏重新贴底。
          'html>body>#desktop{height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          'html>body>#desktop>#desktopFooter{flex:0 0 auto !important;}',
          // v4.0.91（用户对比浏览器后定位）：浏览器里 body 是 overflow:hidden（应用自己管滚动），
          // 我们第三方分支给 body 设了 overflow-y:auto → 滚侧栏时整个 body 一起滚，底部状态栏跟着走。
          // 用 :has() 只在「页面根就是 #desktop」时关掉 body 滚动，不影响其它第三方应用。
          'html:has(>body>#desktop)>body{overflow:hidden !important;}',
          // v4.0.103（用户工单：MoonTV 这类 fixed 全屏页顶部被标题栏压住）：
          // 首层是 Tailwind 的 .fixed.inset-0，position:fixed 不吃 html 的 padding-top，
          // 内容整体顶到 0 被我们的 34px 标题栏盖住。这里把这类固定层整体下移 34px 并扣掉高度，
          // 等价于「给它一个真实的短视口」，fixed 布局内部仍按整块区域排。
          // v4.0.104：实测 MoonTV 的 .fixed.inset-0 在 MAIN 里面，不是 body 直接子元素，
          // v4.0.103 的 `html>body>div` 选择器匹配不到 → 改成后代选择器。
          'html>body div.fixed.inset-0{top:calc(var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;'
            + 'height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}',
          // v4.0.92（用户截图：底栏压住详情面板最后几行）：qBittorrent 的 #desktopFooter 是
          // absolute 定位、不占布局，而 #pageWrapper 按 100% 撑满 → 面板底部被底栏盖住。
          // 这里让 #pageWrapper 扣掉「头部 60px + 底栏 28px」，内容区正好停在底栏上方。
          'html>body>#desktop>#pageWrapper{height:calc(100% - 60px - 28px) !important;}',
          // v4.0.11 CSS 兜底：Tailwind / 组件库常见的 fixed/sticky/absolute 贴顶类名，JS 接管前先让位
          // v4.0.14：补充 .absolute.top-0 / [class*="absolute-positioned"]（Naive UI n-layout--absolute-positioned）
          // v4.0.17（用户工单「新标签窗侧边栏少 4 项、直播观看页信息不全」根修）：
          //   v4.0.14 的 [class*="absolute-positioned"] 子串匹配把 Naive UI 的
          //   .n-layout-footer--absolute-positioned / .n-layout-sider--absolute-positioned /
          //   .n-layout-header--absolute-positioned 一并命中，给「底部」footer 强塞 top:34px，
          //   footer 的 bottom:0 失效 → 底部菜单（登出/日志/关于/设置）被顶到侧栏顶部，
          //   正好盖住主菜单的 直播录制/看板/视频处理/工具 四项（截图实锤：压制下面直接是登出）。
          //   改成 [class~="n-layout--absolute-positioned"] 精确 token 匹配，只动布局根节点本身。
          'html>body .fixed.top-0,html>body .sticky.top-0,html>body .absolute.top-0,html>body [class*="fixed"][class*="top-0"],html>body [class*="sticky"][class*="top-0"],html>body [class~="n-layout--absolute-positioned"]{top:calc(var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}'
        ].join('');
        // v4.0.11：页面自身 CSS 的 !important 规则可能覆盖 <style> 里的 html{padding-top}。
        // 用 inline style !important 兜底（inline !important > stylesheet !important），保证让位一定生效。
        try {
          const __htmlEl = document.documentElement;
          const __padVal = 'calc(var(--fnos-bar-h, 34px) / var(--fnos-f, 1))';
          if (__htmlEl && __htmlEl.style.getPropertyValue('padding-top') !== __padVal) {
            __htmlEl.style.setProperty('padding-top', __padVal, 'important');
          }
        } catch (_) {}
        // 诊断 + 兜底：检查 html 实际 paddingTop，若被页面 CSS 压成 0 则改用 body transform 让位
        try {
          setTimeout(() => {
            try {
              const __pt = getComputedStyle(document.documentElement).paddingTop;
              const __bt = document.body ? getComputedStyle(document.body).marginTop : 'n/a';
              ipcRenderer.send('fnos:media-log', {
                stage: 'titlebar.padding-check',
                htmlPadTop: __pt,
                bodyMarginTop: __bt,
                barH: __barHeight(),
              });
              // 兜底：html padding-top 被页面 CSS 压成 0 → 改用 body transform 让位
              // （v3.0.46 从 transform 改成 padding 是为了修底栏压内容，但若 padding 根本没生效，
              //   transform 是唯一能保证让位的手段；fixed 元素随 transform 一起下移，正好不压内容）
              // v4.0.80（用户工单：飞牛音乐播放条消失 + 整页下移）：
              // /music 走的是「body padding-top 让位、绝不 transform」的专用分支；
              // 但 html padding-top 恒为 0 → 这里又会兜底加 transform，两个偏移叠加（34+41=75px），
              // 页面 absolute 图层被整体下移且高度仍 100vh → 底部播放条被挤出视口。
              // 音乐页明确跳过这个兜底。
              const __isMusic80 = /\/music(\/|\?|$)/i.test(String(location.href || ''));
              if (!__isMusic80 && __pt === '0px' && document.body && !document.body.__fnosTransformFallback) {
                document.body.__fnosTransformFallback = true;
                const __barH2 = __barHeight();
                document.body.style.setProperty('transform', 'translateY(calc(' + __barH2 + 'px / var(--fnos-f, 1)))', 'important');
                document.body.style.setProperty('height', 'calc(100vh - ' + __barH2 + 'px / var(--fnos-f, 1))', 'important');
                document.body.style.setProperty('max-height', 'calc(100vh - ' + __barH2 + 'px / var(--fnos-f, 1))', 'important');
                document.body.style.setProperty('min-height', '0', 'important');
                ipcRenderer.send('fnos:media-log', {
                  stage: 'titlebar.transform-fallback',
                  reason: 'html-padding-zero',
                  barH: __barH2,
                });
              }
            } catch (_) {}
          }, 200);
        } catch (_) {}
        // v4.0.10（用户工单「标题栏压住内容区第一行」的直接原因）：
        // v3.0.46 为了修好第三方应用「底栏压内容」把让位方式换成了 html{padding-top:34px}，
        // 但 position:fixed 元素不参与 html 的 padding 布局——biliLive-tools 的顶栏、
        // 录制任务标签栏都是 fixed;top:0，仍停在视口 y=0，正好被 34px 的标题栏盖住。
        // 这里补一遍「贴顶 fixed 元素整体下移标题栏高度」，只动 top 落在标题栏带内的元素，
        // 原值记在元素上以便还原，窗口缩放/标题栏高度变化可重算。
        try { __watchFixedTop(); } catch (_) {}
        // v4.0.16：给 body 补不透明底色，修新标签窗整窗透明透出桌面。
        // v4.0.25：只在页面加载完成后补一次（旧版 0/500/1800 三次 + 扫元素抢色，见函数注释）
        try { setTimeout(__applyXappBodyBg, 1800); } catch (_) {}
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
          // v4.0.25：壳色只在本页是飞牛自家页面时才写（__shellBgCss25 在第三方页为空串）。
          // Docker/第三方应用会走 fnos-domain-in-main 直接加载进主窗，body 就是它自己的 body，
          // 以前的 background:#05060a !important 等于把第三方页刷成深底 → 亮模式黑底深字。
          'html>body{transform:translateY(calc(var(--fnos-bar-h, 34px) / var(--fnos-f, 1))) !important;height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;box-sizing:border-box !important;clip-path:inset(0 round calc(20px / var(--fnos-f, 1))) !important;padding-top:0 !important;margin-top:0 !important;' + __shellBgCss25 + '}',
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
          'html>body [style*="100vh"],html>body [style*="100dvh"],html>body [style*="dvh"]{max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}' +
          // v3.0.60（用户反馈：Docker 应用内嵌浏览器打开 qBittorrent 等第三方 WebUI 时底部状态栏被裁）——
          // 内嵌浏览器用 iframe 承载第三方 WebUI（如 qBittorrent :8085），cqfndesk 用 JS 把 iframe/容器高度
          // 撑到 window.innerHeight（含标题栏的整窗高），而 body 已下移标题栏高度，iframe 底部溢出 body 底边
          // 被裁（状态栏露一半/几成）。inline height 是具体 px 值，[style*="100vh"] 兜不到，故补 iframe 及
          // 其父容器的 max-height 上限，让承载 WebUI 的 iframe 完整落在主窗内容区内。
          'html>body iframe{max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}' +
          'html>body div:has(iframe){max-height:calc(100vh - var(--fnos-bar-h, 34px) / var(--fnos-f, 1)) !important;}'
        ].join('');
      }
      (document.head || document.documentElement).appendChild(__padStyle);
      // v4.0.25：把「本次给这页写了什么底色」记下来——下次同类问题一行日志即可定位，
      // 不用再靠截图采样像素（原日志只有 theme.normalize 的"打了补丁"，没有"改了什么"）。
      try {
        __fnLog25('shell.bg.write', {
          branch: __isSettings ? 'settings'
            : (__argv.indexOf('--fnos-xapp') >= 0 ? 'xapp' : (__isAppWin ? 'app' : 'shell')),
          value: __shellBgCss25 ? __FN_SHELL_BG25 : '',
          thirdParty: __fnIsThirdParty25,
          nasOrigin: __fnNasOrigin25.slice(0, 60),
          htmlBg: (() => { try { return getComputedStyle(document.documentElement).backgroundColor; } catch (_) { return ''; } })(),
          bodyBg: (() => { try { return document.body ? getComputedStyle(document.body).backgroundColor : ''; } catch (_) { return ''; } })(),
          href: String(location.href || '').slice(0, 140),
        });
      } catch (_) {}
      // v3.0.70：窗口四角直角/圆角（必须在 __padStyle 之后落，保证覆盖生效）
      __applyWinCornerStyle();
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
          __topShowTimer = setTimeout(() => { __topShowTimer = null; try { show(bar); } catch (_) {} }, 0); // v4.0.106：用户要求去掉 1.5s 延时，推到顶部立即出现
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
        __skinReloadSoon(); // v3.0.24：冷启动补应用（视频首帧/图片解码未就绪时首轮会失败）
        __tbDiag('standard');
        if (AUTO_HIDE) hide(bar); else show(bar);

        // ---- 防 SPA 重渲染清除：v2.10.0 r30（问题1 次因）全件检查+整件重建+解除防重入死锁 ----
        // 旧实现只查 bar+hotzone 两个 id：按钮子节点被 SPA 移除不触发重建；hotzone 缺而 bar 在时
        // disconnect+build() 撞 build() 防重入早退 → 拖动/按钮永久失效（自愈缺口实锤）。现全件
        // 检查（bar/hotzone/☰/—□✕），缺失即先清残留再整体重建——残留清掉后防重入早退不再拦。
        try {
          // v4.0.28：↻ / ↗ 已删除，自愈清单不能再要求它们存在——否则这俩 id 永远查不到，
          // MutationObserver 会把「按钮缺失」当真，DOM 一变就整件重建（重建风暴 + 标题栏闪）。
          // 现在主窗/应用窗的清单一致：☰ + — □ ✕。
          const __need = isMac ? ['fnos-titlebar', 'fnos-titlebar-hotzone', 'fnos-tb-menu']
            : ['fnos-titlebar', 'fnos-titlebar-hotzone', 'fnos-tb-menu', 'fnos-tb-min', 'fnos-tb-max', 'fnos-tb-close'];
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
        // v4.0.95（用户工单：内嵌 appview 窗 ①标题栏不套皮肤 ②内容顶部被压住）：
        // 内嵌窗原来只是盖一条半透明栏，既没有皮肤、也不给页面让位。这里补两件事：
        //   a) 页面整体下移 34px（html padding-top），顶栏不再压内容；
        //   b) 标题栏铺皮肤静态图（与独立窗同一素材 bg_alpha.webp）。
        try {
          const st = document.createElement('style');
          st.id = 'fnos-embed-offset';
          st.textContent = 'html{padding-top:' + __skinHeight + 'px !important;box-sizing:border-box !important;}'
            + 'html>body{height:calc(100% - ' + __skinHeight + 'px) !important;box-sizing:border-box !important;}';
          (document.head || document.documentElement).appendChild(st);
        } catch (_) {}
        const root2 = root();
        // 顶部拖动热区（与普通标题栏同款）
        const hot = document.createElement('div');
        hot.id = 'fnos-titlebar-hotzone';
        hot.setAttribute('aria-hidden', 'true');
        __setCss(hot, 'position:fixed;top:0;left:0;right:0;height:6px;z-index:2147483646;pointer-events:auto;background:transparent;-webkit-app-region:drag;user-select:none;');
        root2.appendChild(hot);
        const bar = document.createElement('div');
        bar.id = 'fnos-titlebar'; // 注意：id 必须是 fnos-titlebar（自愈全件检查与 build 防重入检测依赖）；r18 的 fnos-tb-bar 双赋值被覆盖=死代码，v2.10.0 r30 清理
        bar.setAttribute('data-fnos-tb', '1'); // v2.10.0 r30：补齐清扫豁免标记（与普通标题栏一致，KEEP [data-fnos-tb] 命中）
        // v4.0.24：同主标题栏——整条 bar 不吃事件，只有子元素（logo/标题/四钮）auto，
        // 避免盖住内嵌窗自己的 ✕ 把点击吃掉。
        __setCss(bar, 'position:fixed;top:0;left:0;right:0;height:' + __skinHeight + 'px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;pointer-events:none;background:rgba(18,22,30,0.30);border-radius:6px;-webkit-app-region:no-drag;user-select:none;');
        // v4.0.95：内嵌标题栏也铺皮肤（静态图，避免视频解码问题）
        try {
          const __sk = (__skinState && __skinState.skin && __skinState.skin.titlebar) || null;
          if (__sk && __skinState.skinDir) {
            const __img = __loadSkinAsset(__skinState.skinDir, 'bg_alpha.webp');
            if (__img) {
              bar.style.backgroundImage = 'url(\'' + __img + '\')';
              bar.style.backgroundSize = 'cover';
              bar.style.backgroundPosition = 'center';
              bar.style.backgroundColor = 'transparent';
              // v5.1.4（工单 10）：内嵌窗底图同样走「缩放上限」，避免方形素材被放大裁掉文字
              try { bar.__tbBgFitMode = (__sk.background && __sk.background.fit === 'contain') ? 'contain' : ''; __tbBgFit(bar, 'embed'); } catch (_) {}
              __tbLog('embed.skin.static', { to: 'bg_alpha.webp' });
            }
          }
        } catch (_) {}
        // 左：应用 logo + 标题
        const left = document.createElement('div');
        __setCss(left, '-webkit-app-region:no-drag;pointer-events:auto;display:flex;align-items:center;gap:8px;height:34px;padding-left:' + (isMac ? '78px' : '12px') + ';overflow:hidden;');
        const logo = document.createElement('img');
        logo.id = 'fnos-embed-logo';
        __setCss(logo, 'width:18px;height:18px;border-radius:4px;flex:0 0 auto;object-fit:cover;display:none;');
        const titleEl = document.createElement('span');
        titleEl.id = 'fnos-embed-title';
        titleEl.setAttribute('data-fnos-tb-text', '1');
        // v5.1.4（工单 10）：字号不再写死 13px，而是「不超过 bar 高的 42%」（13px/34px≈0.38），
        // 皮肤 titlebar.fontSize 可覆盖（同样被上限夹住），保证任何 bar 高度下都完整显示。
        __setCss(titleEl, 'color:rgba(255,255,255,0.95);font-size:' + __tbTextMax(__skinHeight) + 'px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60vw;line-height:1.1;');
        left.appendChild(logo);
        left.appendChild(titleEl);
        // v4.0.44（内嵌窗改用自绘栏后，标题不能空着）——
        // 页面自带表头被主进程 insertCSS 隐藏（appwin.embed-bar），标题文字要从它身上读：
        // 优先 appview 表头标题 → URL 的 anchor → document.title。表头是 display:none 但仍在 DOM 里，
        // textContent 可读；SPA 路由切换后标题会变，前 6 秒补采几次即可（之后交给导航事件重建）。
        (function () {
          const __syncTitle = () => {
            try {
              if (!titleEl.isConnected) return;
              let t = '';
              try {
                const h = document.querySelector('[class*="app-layout--header-title"]');
                if (h) t = String(h.textContent || '').trim();
              } catch (_) {}
              if (!t) {
                try {
                  const m = /[?&]anchor=([^&]+)/.exec(String(location.href || ''));
                  if (m) { try { t = decodeURIComponent(m[1]); } catch (_) { t = m[1]; } }
                } catch (_) {}
              }
              if (!t) t = String(document.title || '').trim();
              if (t && titleEl.textContent !== t) titleEl.textContent = t;
            } catch (_) {}
          };
          __syncTitle();
          try { [400, 1200, 2500, 4000, 6000].forEach((ms) => setTimeout(__syncTitle, ms)); } catch (_) {}
        })();
        // 右：— □ ✕ 三钮（r15 硬规则移除 ↗ 跳出：内嵌窗绝不剥离 fnOS 框架转独立跳出窗）
        // v4.0.28（用户工单）：↻ 刷新也一并移除，内嵌窗自绘栏只剩 — □ ✕。
        const btns = document.createElement('div');
        __setCss(btns, '-webkit-app-region:no-drag;pointer-events:auto;display:flex;align-items:stretch;height:34px;margin-right:8px;');
        const mkBtn = (id, titleTxt, svg, hoverBg) => {
          const b = document.createElement('button');
          b.id = id;
          b.title = titleTxt;
          __setCss(b, 'width:40px;height:34px;border:none;outline:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;-webkit-app-region:no-drag;flex:0 0 auto;');
          b.innerHTML = svg;
          const svgEl = b.querySelector('svg');
          if (svgEl) __setCss(svgEl, 'display:block;pointer-events:none;flex-shrink:0;');;
          b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
          b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
          return b;
        };
        const W = 'stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"';
        const minBtn = mkBtn('fnos-tb-min', '最小化', '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M3 8H13" ' + W + '/></svg>', 'rgba(255,255,255,0.18)');
        const maxBtn = mkBtn('fnos-tb-max', '最大化/还原', '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2" ' + W + '/></svg>', 'rgba(255,255,255,0.18)');
        const closeBtn = mkBtn('fnos-tb-close', '关闭', '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 4L12 12M12 4L4 12" ' + W + '/></svg>', '#E81123');
        // —/□/✕ 走现成 window-minimize/maximize/close IPC（零新增 IPC）
        minBtn.addEventListener('click', () => { try { ipcRenderer.send('window-minimize'); } catch (_) {} });
        maxBtn.addEventListener('click', () => { try { ipcRenderer.send('window-maximize'); } catch (_) {} });
        closeBtn.addEventListener('click', () => { try { ipcRenderer.send('window-close'); } catch (_) {} });
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
        __setCss(dragStrip, 'flex:1;height:100%;min-width:20px;-webkit-app-region:no-drag;pointer-events:auto;cursor:default;');
        (function () {
          const W = window;
          W.__fnosDsDown = null;
          // v3.0.51（用户反馈：拖动窗口时边沿抖动）——
          // 拖动期间系统侧会把客户区尺寸重算成 1~3px 不同的值（日志实测：一次拖动 7 秒 205 条
          // resize，约每帧一条），页面根节点跟着每帧重排，肉眼就是「窗口边缘/圆角抖动 + 图标网格跳」。
          // 按下标题栏时记下当前客户区尺寸并把 <html> 钉死在这个尺寸（!important），松手解锁：
          // 拖动过程中系统再怎么报 1~3px 的尺寸变化，页面也不会重排。对布局的影响只有 ±1~3px。
          const __pinSize = function () {
            try {
              if (W.__fnosPin) return;
              const de = document.documentElement;
              W.__fnosPin = { w: de.clientWidth || W.innerWidth, h: de.clientHeight || W.innerHeight, pw: de.style.width, ph: de.style.height };
              de.style.setProperty('width', W.__fnosPin.w + 'px', 'important');
              de.style.setProperty('height', W.__fnosPin.h + 'px', 'important');
            } catch (_) {}
          };
          const __unpinSize = function () {
            try {
              if (!W.__fnosPin) return;
              const de = document.documentElement;
              if (W.__fnosPin.pw) de.style.setProperty('width', W.__fnosPin.pw); else de.style.removeProperty('width');
              if (W.__fnosPin.ph) de.style.setProperty('height', W.__fnosPin.ph); else de.style.removeProperty('height');
              W.__fnosPin = null;
            } catch (_) {}
          };
          // v2.17.47：按住标题栏时把指针捕获到本层，鼠标甩出窗口/窗口追不上鼠标时也能持续收到
          // 移动事件（否则 Windows 停止投递 WM_MOUSEMOVE，拖动会中途卡住）。
          // ---- v3.0.66 拖动重建（用户工单：拖动标题栏后点 × 点不中、窗口跟着鼠标一起跑）----
          // 旧实现的三个坑：① pointerdown 无条件 setPointerCapture，把后续指针事件全锁给拖动层；
          //   ② mousedown 立刻发 win-drag-start，主进程马上进入拖动态（最大化窗口会在首条 move 时
          //   unmaximize 并跳位）；③ 没有阈值，1px 抖动就算拖动，单击被吞成拖动。
          // 现在：按钮/控件按下直接放行（不捕获、不发拖动消息）；移动超过 4px 才进入拖动并迟发
          //   win-drag-start；指针捕获也在那一刻才开；松手 / 失焦 / 左键已抬起 立刻释放并复位；
          //   每条 move 都带上 buttons，主进程再验一次「左键确实按着」，杜绝状态残留导致窗口漂移。
          const __isCtl = function (t) {
            try { return !!(t && t.closest && t.closest('button,input,select,textarea,a[href],[data-fnos-no-drag]')); } catch (_) { return false; }
          };
          const __endDrag = function (reason) {
            // v4.0.3（用户工单「窗口区应用点不动，变成拖动区域」）——
            // v4.0.2 对 mouseup 也给了 120ms 宽限，结果「快速点一下标题栏」后 __fnosDsDown 残留：
            // 接着在内容区按下（没有新的 mousedown 重置它）再移动，就被当成上一次拖动的继续，
            // 于是应用图标点不动、整个窗口像拖动区。现在只对「激活窗口的 blur 噪声」宽限，
            // mouseup / pointerup / 其它来源一律立即生效。
            if ((reason === 'blur' || reason === 'cancel') && !W.__fnosDsDrag
              && W.__fnosDsDownAt && Date.now() - W.__fnosDsDownAt < 120) return;
            try {
              if (W.__fnosDsDrag) ipcRenderer.send('win-drag-end');
              else ipcRenderer.send('win-drag-arm-end');
            } catch (_) {}
            W.__fnosDsDown = null; W.__fnosDsDrag = false; W.__fnosDsPend = null; W.__fnosDsSrc = null;
            try { if (W.__fnosDsPid != null && dragStrip.releasePointerCapture) dragStrip.releasePointerCapture(W.__fnosDsPid); } catch (_) {}
            W.__fnosDsPid = null;
            __unpinSize(); // v3.0.51：松手解锁页面尺寸
          };
          dragStrip.addEventListener('pointerdown', function (e) {
            // v3.0.66：此处不再捕获指针——预捕获会把按钮的 click 抢走（工单⑤ setPointerCapture）
            try { if (e.pointerId != null) W.__fnosDsPid = e.pointerId; } catch (_) {}
          });
          // v4.0.24：松手时若这次按下落在页面控件上（没发生拖动），把点击还给页面
          dragStrip.addEventListener('mouseup', function () {
            const __c = W.__fnosDsCtl; W.__fnosDsCtl = null;
            if (__c && !W.__fnosDsDrag) {
              try { __c.click(); ipcRenderer.send('fnos:media-log', { stage: 'tb.passthrough.click', tag: __c.tagName, cls: String(__c.className || '').slice(0, 60) }); } catch (_) {}
            }
          });
          dragStrip.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            if (__isCtl(e.target)) return; // 工单①：点在按钮/控件上不启动拖动
            try {
              const __c0 = __tbPickUnderCtl(e.clientX, e.clientY);
              try { ipcRenderer.send('fnos:media-log', { stage: 'tb.pick', hit: !!__c0, tag: __c0 && __c0.tagName, cx: e.clientX, cy: e.clientY }); } catch (_) {}
              if (__c0) { W.__fnosDsCtl = __c0; W.__fnosDsDrag = false; return; }
            } catch (err) {
              try { ipcRenderer.send('fnos:media-log', { stage: 'tb.pick.err', err: String((err && err.message) || err) }); } catch (_) {}
            }
            W.__fnosDsDown = { x: (e.screenX || 0), y: (e.screenY || 0) };
            W.__fnosDsDrag = false;
            // v4.0.2：记下按下时刻。窗口从「未激活」被点激活时，头几帧的 buttons 可能是 0，
            // 旧逻辑据此把整次拖动直接作废（用户工单：第一次拖动肯定失败，再按一次才行）。
            W.__fnosDsDownAt = Date.now();
            // v4.0.3：标记这次按下来源于标题栏。__fwd 只认这个来源，内容区的按下永远不会变成拖动。
            W.__fnosDsSrc = 'tb';
            // v3.0.82：按下就通知主进程「准备拖」（只登记起点 + 挂起磨砂采样，不动窗口、
            // 不还原最大化）。越过阈值时 win-drag-start 直接沿用这个起点，起步没有死区。
            try { ipcRenderer.send('win-drag-arm', { sx: (e.screenX || 0), sy: (e.screenY || 0) }); } catch (_) {}
            // v3.0.66：win-drag-start 不再在这里发，改由 __fwd 判定超过 4px 阈值后迟发
          });
          dragStrip.addEventListener('dblclick', function (e) {
            W.__fnosDsDown = null; W.__fnosDsDrag = true;
            __unpinSize(); // v3.0.51：双击最大化前解除尺寸钉死
            try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
            try { ipcRenderer.send('window-maximize'); } catch (_) {}
          });
          if (!W.__fnosDsHooked) {
            W.__fnosDsHooked = true; W.__fnosDsDrag = false;
            W.__fnosDsRaf = 0; W.__fnosDsPend = null;
            const __fwd = function (e) {
              if (!W.__fnosDsDown) return;
              // v3.0.66：左键已经松开（pointerup 被吞过）——立刻复位，绝不继续拖动
              if (e.buttons === 0) {
                // v4.0.2：按下后 200ms 内不信 buttons —— 激活窗口的噪声帧是 0，
                // 旧逻辑在这里就把整次拖动作废，「第一次拖不动」就是这条打出来的。
                if (!W.__fnosDsDrag && Date.now() - (W.__fnosDsDownAt || 0) < 200) return;
                __endDrag('nobutton');
                return;
              }
              try {
                if (!W.__fnosDsDrag) {
                  // v4.0.3：只允许从标题栏发起拖动。没有标题栏按下标记（或已被内容区按下清掉）
                  // 就直接收摊，绝不让内容区的按下"续上"成拖动。
                  if (W.__fnosDsSrc !== 'tb') { __endDrag('notitlebar'); return; }
                  // v3.0.81：阈值 4px -> 2px。4px 死区偏大，用户感受到的是「刚按下那一下拖不动」；
                  // 2px 仍能区分单击（拖起来后立刻松开就是一次普通点击，不会误判）
                  if (Math.abs((e.screenX || 0) - W.__fnosDsDown.x) <= 2 && Math.abs((e.screenY || 0) - W.__fnosDsDown.y) <= 2) return;
                  W.__fnosDsDrag = true;
                  // v3.0.82：不再把基准改到「越过阈值这一刻」（那等于把已经发生的 2px 位移吞掉，
                  // 用户感受就是「拖了一下窗口还没动」）。继续用按下点，主进程按 arm 记录的窗口
                  // 位置 + 按下点算位移，窗口立刻跟手（最多跳 2px，符合直觉）。
                  try { ipcRenderer.send('win-drag-start', { sx: W.__fnosDsDown.x, sy: W.__fnosDsDown.y }); } catch (_) {}
                  // v3.0.66：捕获在真正开始拖动时才开；pointerId 缺失时用本帧事件兜底
                  try {
                    const __pid = (W.__fnosDsPid != null ? W.__fnosDsPid : e.pointerId);
                    if (__pid != null) { W.__fnosDsPid = __pid; if (dragStrip.setPointerCapture) dragStrip.setPointerCapture(__pid); }
                  } catch (_) {}
                  __pinSize(); // v3.0.51：拖动期间钉死页面尺寸，消掉每帧重排导致的边沿抖动
                  return;
                }
                // 每次移动都把最新屏幕坐标交给主进程（rAF 合并，60fps 上限）
                W.__fnosDsPend = { sx: (e.screenX || 0), sy: (e.screenY || 0), buttons: 1 };
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
            W.addEventListener('mouseup', function () { __endDrag('up'); }, true);
            W.addEventListener('pointerup', function () { __endDrag('up'); }, true);
            // v3.0.66：失焦 / 页面隐藏也要复位（拖动中切窗、锁屏、任务视图都会丢 pointerup）
            W.addEventListener('blur', function () { __endDrag('blur'); }, true);
            document.addEventListener('visibilitychange', function () { try { if (document.hidden) __endDrag('hidden'); } catch (_) {} }, true);
            W.addEventListener('pointercancel', function () { __endDrag('cancel'); }, true);
            // v4.0.3：拖动严格限制在标题栏内 —— 任何在标题栏之外按下的 mousedown，
            // 都把上一次残留的按下状态清掉（内容区的点击永远只是点击）。
            document.addEventListener('mousedown', function (e) {
              try {
                // v4.0.4：顶部命中诊断 —— 「点不动」时靠这条日志直接看出是谁在上面挡着。
                // 只在窗口顶部 150px 内记录，不刷屏。
                try {
                  const cy = (typeof e.clientY === 'number') ? e.clientY : -1;
                  if (cy >= 0 && cy <= 150 && typeof ipcRenderer.send === 'function') {
                    const el = (e.target && e.target.nodeType === 1) ? e.target : null;
                    const chain = [];
                    let n = el;
                    for (let i = 0; n && i < 4; i++) {
                      let cls = '';
                      try { if (typeof n.className === 'string' && n.className.trim()) cls = '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.'); } catch (_) {}
                      chain.push((n.tagName || '?').toLowerCase() + (n.id ? '#' + n.id : '') + cls);
                      n = n.parentElement;
                    }
                    const bEl = document.getElementById('fnos-titlebar');
                    const bR = bEl ? bEl.getBoundingClientRect() : null;
                    const hEl = document.getElementById('fnos-titlebar-hotzone');
                    const hR = hEl ? hEl.getBoundingClientRect() : null;
                    const sEl = document.getElementById('fnos-tb-dragstrip');
                    const sR = sEl ? sEl.getBoundingClientRect() : null;
                    ipcRenderer.send('tb-hit', {
                      cx: Math.round(e.clientX || 0), cy: Math.round(cy),
                      chain: chain.join(' < '),
                      barH: bR ? Math.round(bR.height) : -1,
                      barBottom: bR ? Math.round(bR.bottom) : -1,
                      hotH: hR ? Math.round(hR.height) : -1,
                      stripH: sR ? Math.round(sR.height) : -1,
                      bodyPadTop: (function () { try { return getComputedStyle(document.body).paddingTop; } catch (_) { return '?'; } })(),
                      bodyTransform: (function () { try { return getComputedStyle(document.body).transform; } catch (_) { return '?'; } })(),
                      htmlPadTop: (function () { try { return getComputedStyle(document.documentElement).paddingTop; } catch (_) { return '?'; } })(),
                      dpr: window.devicePixelRatio || 1,
                    });
                  }
                } catch (_) {}
                if (W.__fnosDsDrag || !W.__fnosDsDown) return;
                const t = e.target;
                if (t && t.closest && t.closest('#fnos-tb-dragstrip, #fnos-titlebar, #fnos-titlebar-hotzone')) return;
                __endDrag('other-area');
              } catch (_) {}
            }, true);
            // v3.0.77（电视直播窗拖不动）——鼠标落进 MPV 原生窗后松开，本层收不到 mouseup，
            // 主进程会按「光标连续静止」自行收尾并发这条消息；这里把拖动残留状态（尺寸钉死、
            // __fnosDs*）复位，否则下一次 resize 会带着旧的 clientWidth/Height 走。
            try {
              ipcRenderer.on('window-drag-cancelled', function () {
                try { __endDrag(); } catch (_) {}
              });
            } catch (_) {}
          }
        })();
        bar.appendChild(dragStrip);
        bar.appendChild(btns);
        __attachSkinLayers(bar);
        root2.appendChild(bar);
        // v3.0.24（用户反馈：皮肤只主程序加载，打开一些应用时不加载）——内嵌窗标题栏
        // 原来从未调用 applyStyle，皮肤/牛角/图标配色永远套不上，这里补上。
        try { applyStyle(bar); } catch (_) {}
        try { __skinReloadSoon(); } catch (_) {}
        __tbDiag('embed');
        // 原生拖拽兜底（与普通标题栏同款）
        // v2.17.45：双击标题栏最大化/还原（drag region 上 dblclick 不触发，改用 mousedown
        // 时间/位置间隔自判双击）。
        let __lastTbDown2 = 0, __lastTbDownX2 = 0, __lastTbDownY2 = 0;
        // v4.0.24：内嵌窗标题栏同样改成阈值拖拽（按下不动不移动窗口），见普通标题栏同款注释。
        const __tbLog2 = (stage, o) => { try { ipcRenderer.send('fnos:media-log', Object.assign({ stage }, o)); } catch (_) {} };
        const startNativeDrag = (ev) => {
          try {
            if (ev.button !== 0) return;
            const t = ev.target;
            if (t && t.closest && t.closest('#fnos-tb-dragstrip, button, .fnos-tb-no-drag, #fnos-tb-min, #fnos-tb-max, #fnos-tb-close, #fnos-tb-menu')) return;
            // v4.0.24：这条带下面若是页面控件（内嵌窗 ✕ 等），按下不拖动，松手把点击还给它
            try {
              const __c0 = __tbPickUnderCtl(ev.clientX, ev.clientY);
              if (__c0) {
                const __up0 = () => {
                  try { window.removeEventListener('mouseup', __up0, true); } catch (_) {}
                  try {
                    __c0.click();
                    ipcRenderer.send('fnos:media-log', { stage: 'tb.passthrough.click', tag: __c0.tagName, cls: String(__c0.className || '').slice(0, 60) });
                  } catch (_) {}
                };
                window.addEventListener('mouseup', __up0, true);
                return;
              }
            } catch (_) {}
            const __now = Date.now();
            const __sx = ev.screenX || 0, __sy = ev.screenY || 0;
            const __trigger = (ev.currentTarget === hot) ? 'hot' : 'bar';
            if (__now - __lastTbDown2 < 450 && Math.abs(__sx - __lastTbDownX2) < 8 && Math.abs(__sy - __lastTbDownY2) < 8) {
              __lastTbDown2 = 0;
              __tbLog2('tb.drag.dblclick', { trigger: __trigger, x: __sx, y: __sy });
              try { ipcRenderer.send('window-maximize'); } catch (_) {}
              return;
            }
            __lastTbDown2 = __now;
            __lastTbDownX2 = __sx;
            __lastTbDownY2 = __sy;
            let __started = false, __dx = 0, __dy = 0;
            const __t0 = __now;
            const __cleanup = () => {
              try { window.removeEventListener('mousemove', __onMove, true); window.removeEventListener('mouseup', __onUp, true); } catch (_) {}
            };
            const __onMove = (m) => {
              try {
                __dx = (m.screenX || 0) - __sx;
                __dy = (m.screenY || 0) - __sy;
                if (__started) return;
                if (Math.abs(__dx) >= 4 || Math.abs(__dy) >= 4) {
                  __started = true;
                  __tbLog2('tb.drag.start', { trigger: __trigger, x: __sx, y: __sy, dx: __dx, dy: __dy });
                  ipcRenderer.send('window-drag');
                  __cleanup();
                }
              } catch (_) {}
            };
            const __onUp = () => {
              __tbLog2('tb.drag.end', { trigger: __trigger, dx: __dx, dy: __dy, moved: __started, durMs: Date.now() - __t0 });
              __cleanup();
            };
            window.addEventListener('mousemove', __onMove, true);
            window.addEventListener('mouseup', __onUp, true);
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
          // v4.0.28：内嵌窗自绘栏已无 ↻，清单同步去掉（原因同普通标题栏：查不到就会被当成
          // 缺失 → 反复重建）。
          const __need = isMac ? ['fnos-titlebar', 'fnos-titlebar-hotzone'] : ['fnos-titlebar', 'fnos-titlebar-hotzone', 'fnos-tb-min', 'fnos-tb-max', 'fnos-tb-close'];
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
            /* v4.0.31（用户需求 2）：外观改为变量驱动 —— 跟随标题栏材质/颜色/浓度，或用户单独设置 */
            background: var(--fn-ball-bg, rgba(255,255,255,0.10));
            backdrop-filter: blur(var(--fn-ball-blur, 20px)); -webkit-backdrop-filter: blur(var(--fn-ball-blur, 20px));
            border: 1px solid var(--fn-ball-border, rgba(255,255,255,0.14));
            border-radius: 50%;
            color: var(--fn-ball-fg, rgba(255,255,255,0.72)); cursor: pointer;
            box-shadow: 0 4px 16px rgba(0,0,0,0.25);
            user-select: none;
            transition: background 0.25s, color 0.25s, box-shadow 0.25s, transform 0.25s;
          }
          #fnos-acct-trigger:hover {
            background: var(--fn-ball-bg-hover, rgba(255,255,255,0.18));
            color: var(--fn-ball-fg-hover, #fff);
            transform: scale(1.06);
            box-shadow: 0 6px 20px rgba(0,0,0,0.35);
          }
          #fnos-acct-trigger:active { cursor: grabbing; }
          #fnos-acct-dropdown {
            position: absolute; left: 40px; top: 50%; transform: translateY(-50%);
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
          #fnos-account-switcher.acct-on-right #fnos-acct-dropdown { left: auto; right: 40px; }
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
          // v3.0.45：先清掉旧定时，避免连续 mouseleave 叠加出更早的隐藏时刻。
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => dropdown.classList.add('fnos-acct-hidden'), 400);
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
        // v3.0.26：悬浮球诊断日志（走 fnos:media-log -> logger.js 落盘），定位位置乱跑/隐藏失效
        const __ballLog = function (stage, extra) {
          try { ipcRenderer.send('fnos:media-log', Object.assign({ stage: 'ball.' + stage, level: 'info' }, extra || {})); } catch (_) {}
        };
        const ACCT_BALL = 40;
        const ACCT_EDGE = 6;   // 贴边也留 6px，不给窗口圆角/边框裁掉的机会
        function acctBox() {
          let w = window.innerWidth || 0;
          // v3.0.26：body 被 translateY(标题栏高) 下移，球 top 是 body 内坐标；body 未布局时
          // 用 window.innerHeight 兜底会把球放到 body 之外 34px，被窗口底部裁掉（'贴底/左下角
          // 拉不出来'根因之一）。兜底高度减去标题栏高，保证球任何时刻都不越出可视区。
          let h = Math.max(0, (window.innerHeight || 0) - (__skinHeight || 34));
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
            const box = acctBox();
            // v3.0.26：布局未稳定时不落盘，否则会把「极小可用区算出的假比例」写成持久位置，
            // 之后每次启动都恢复到左下角/贴底。
            if (box.w < 200 || box.h < 200) { __ballLog('save.skip', { w: box.w, h: box.h }); return; }
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
            __ballLog('save', { fx: p.fx, fy: p.fy, x: Math.round(cur.x), y: Math.round(cur.y), w: box.w, h: box.h });
          } catch (_) {}
        }
        function acctRestore(fx, fy) {
          const rg = acctRange();
          return placeAcctBall(ACCT_EDGE + Math.max(0, Math.min(1, fx)) * rg.mx,
                               ACCT_EDGE + Math.max(0, Math.min(1, fy)) * rg.my);
        }
        function acctInitPos() {
          let fx = null, fy = null, srcPos = 'none';
          try {
            const sp = ipcRenderer.sendSync('ball:get-pos');
            if (sp && typeof sp.fx === 'number' && typeof sp.fy === 'number') { fx = sp.fx; fy = sp.fy; srcPos = 'main'; }
          } catch (_) {}
          if (fx === null) {
            try {
              const saved = JSON.parse(localStorage.getItem(ACCT_POS_KEY) || 'null');
              if (saved && typeof saved.fx === 'number' && typeof saved.fy === 'number') {
                fx = saved.fx; fy = saved.fy; srcPos = 'local';
              }
              // 旧版存的是绝对像素（{x,y}）：那些值多半是被上一版裁到窗口外/被 34px 偏移
              // 带歪的脏数据，直接沿用会把这个 bug 一直继承下去，所以不迁移 —— 首次升级
              // 统一回到默认位置一次，之后用户拖动的位置才会被记住。
            } catch (_) {}
          }
          if (fx === null) { fx = 1; fy = 0.5; srcPos = 'default'; }   // 默认贴右侧中部（左侧是应用列表，最容易被挡）
          // v3.0.26：恢复前再校验比例合法，脏数据直接回默认
          if (!Number.isFinite(Number(fx)) || !Number.isFinite(Number(fy))) { fx = 1; fy = 0.5; srcPos = 'default-fix'; }
          fx = Math.max(0, Math.min(1, Number(fx))); fy = Math.max(0, Math.min(1, Number(fy)));
          const __box = acctBox();
          __ballLog('init', { fx: fx, fy: fy, src: srcPos, w: __box.w, h: __box.h, hidden: TB.hideAccountBall === true });
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
        // v3.0.47：resize 日志限流时间戳（拖动/缩放时 resize 每帧触发，每帧一条日志会让主进程
        // 同步写盘，直接把事件循环堵住）
        let __ballLastResizeLog = 0;
        window.addEventListener('resize', () => {
          try {
            const oldBox = __acctBox;
            const newBox = acctBox();
            // v3.0.26：旧 box 未稳定（<200）时反推比例会把 fy 放大到 1（贴底），
            // 直接改用持久化比例重新恢复，杜绝左下角漂移。
            if (oldBox.w < 200 || oldBox.h < 200) {
              __acctBox = newBox;
              acctInitPos();
              __ballLog('resize.reinit', { w: newBox.w, h: newBox.h });
              return;
            }
            const cur = acctCur();
            const mx0 = Math.max(1, oldBox.w - ACCT_BALL - ACCT_EDGE * 2);
            const my0 = Math.max(1, oldBox.h - ACCT_BALL - ACCT_EDGE * 2);
            const fx = Math.max(0, Math.min(1, (cur.x - ACCT_EDGE) / mx0));
            const fy = Math.max(0, Math.min(1, (cur.y - ACCT_EDGE) / my0));
            __acctBox = newBox;
            acctRestore(fx, fy);
            // v3.0.47（掉帧）：日志限流到 ≥500ms 一条，拖动/缩放不再每帧写盘；末尾一条仍会记录
            const __nowRL = Date.now();
            if (__nowRL - __ballLastResizeLog > 500) {
              __ballLastResizeLog = __nowRL;
              __ballLog('resize', { fx: fx, fy: fy, ow: oldBox.w, oh: oldBox.h, nw: newBox.w, nh: newBox.h });
            }
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
        // v3.0.45（网友反馈：鼠标移向账号项，弹出面板就消失）：
        //   账号球 40px、面板 left:48px，中间有 8px 空隙。鼠标穿过空隙会触发容器 mouseleave，
        //   旧代码只启动 300ms 隐藏定时、进入面板后不清除，定时到点面板照旧消失。
        //   修法：面板贴到 40px 消除空隙 + 容器 mouseenter 时清定时 + 隐藏延迟提到 400ms 兜底。
        panel.addEventListener('mouseenter', () => { clearTimeout(hideTimer); });
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
              // v3.0.28：CSP 页面下 innerHTML 里的 style 属性同样会被拒，改为 DOM 构造
              try {
                listEl.textContent = '';
                const __empty28 = document.createElement('div');
                __setCss(__empty28, 'padding:8px 16px;font-size:12px;color:rgba(255,255,255,0.3);');
                __empty28.textContent = '暂无已登录账号';
                listEl.appendChild(__empty28);
              } catch (_) {}
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
            __ballLog('hidden.apply', { hide: h === true, shown: shown });
            if (shown) { try { acctInitPos(); } catch (_) {} }
          };
          __ballLog('hidden.init', { hide: TB.hideAccountBall === true });
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
        // v3.0.52（用户反馈：客户端内打开的 qBittorrent/Docker 应用，标题栏正下方是一条透明横带，
        // 能看穿到桌面图标）：v3.0.46 把第三方应用窗（--fnos-xapp）的让位改成
        // html{padding-top:34px}（fixed 继续相对 viewport，几何与浏览器一致），但本函数的 inline
        // !important 仍然给 body 写 translateY(34px) + 压高度 —— 两处叠加成"双让位"：
        //   · 标题栏 34px 之下又多出 34px 没有任何元素绘制的空白（窗口 transparent:true，
        //     html 背景又被 v3.0.46 的 __gifBg 置成透明）→ 直接透出下层主窗的桌面/图标；
        //   · 内容整体再下移 34px，底部少了 34px。
        // xapp 窗口的 body 几何一律交给 v3.0.46 的样式表，这里只清历史残留。
        const __xapp52 = (function () {
          try { return (process.argv || []).indexOf('--fnos-xapp') >= 0; } catch (_) { return false; }
        })();
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
            if (__xapp52) {
              // v3.0.52：第三方应用窗（--fnos-xapp）的让位由 v3.0.46 的 html padding-top 负责，
              // body 不能再写 transform/高度，否则标题栏下方多出 34px 透明带。这里仅在检测到
              // 旧内联残留时清理一次（无条件 removeProperty 会每次都触发 mutation → 自激）。
              try {
                const __stale = ['transform', 'height', 'max-height', 'min-height'];
                for (let __i = 0; __i < __stale.length; __i++) {
                  if (b.style.getPropertyValue(__stale[__i])) b.style.removeProperty(__stale[__i]);
                }
              } catch (_) {}
              return;
            }
            // v4.0.81：音乐页跳过整套 body 几何补偿（transform/height），
            // 与浏览器保持一致的满铺布局；它的让位由 /music 专用 CSS（body padding-top）负责。
            // 这里还要把之前可能写进去的 inline transform/height 清掉，否则残留值会继续把页面推下去。
            if (/\/music(\/|\?|$)/i.test(String(location.href || ''))) {
              try {
                const __b81 = document.body;
                ['transform', 'height', 'max-height', 'min-height', 'box-sizing', 'overflow-y'].forEach((k) => {
                  try { __b81.style.removeProperty(k); } catch (_) {}
                });
              } catch (_) {}
              return;
            }
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
        // v3.0.52：第三方应用窗（--fnos-xapp）的让位挂在 html 的 padding-top 上（v3.0.46），
        // 进全屏必须一起摘掉、退出再还回去，否则全屏后顶部仍留 34px 透明带（透出下层桌面）。
        const __xappFs = (function () {
          try { return (process.argv || []).indexOf('--fnos-xapp') >= 0; } catch (_) { return false; }
        })();
        if (__xappFs) {
          const de = document.documentElement;
          if (on) {
            de.style.setProperty('padding-top', '0px', 'important');
            de.style.setProperty('clip-path', 'none', 'important');
          } else {
            de.style.removeProperty('padding-top');
            de.style.removeProperty('clip-path');
          }
        }
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
            'html[data-fnos-fs="1"]>body{transform:none !important;height:100vh !important;min-height:0 !important;max-height:100vh !important;clip-path:none !important;border-radius:0 !important;padding-top:0 !important;margin-top:0 !important;min-width:100vw !important;' + (__fnIsThirdParty25 ? '' : 'background-color:' + __FN_SHELL_BG25 + ' !important;') + 'overflow-x:hidden !important;}',
            // v3.0.52：第三方应用窗（--fnos-xapp）的让位挂在 html 的 padding-top 上（v3.0.46），
            // 全屏时必须一起放开，否则顶部仍留 34px 透明带（透出下层桌面）。只动 padding/clip-path，
            // 不给 html 补底色 —— html 透明是标题栏与 20px 圆角的铁律。
            'html[data-fnos-fs="1"]{padding-top:0 !important;clip-path:none !important;}',
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
    // v3.0.54 → v3.0.55 → v3.0.56（用户反馈：桌面右侧"系统组件"面板在客户端里不显示，只剩右上角
    // 一条 CPU/内存 胶囊；强制刷新后完整面板会出来一下又收回去，浏览器打开正常。v3.0.54 的
    // "加载后点一次展开箭头"没解决；v3.0.55 改成"持续清掉 fndesk 写进面板的 inline bottom"，
    // 面板是出来了，但底部开始疯狂抖动 —— 抖动正是 v3.0.55 自己造成的，这一版要去掉它。）
    // 定性与证据（新日志 + 两段录屏逐帧对照）：
    //   1) 面板本体是飞牛原生 desktopWidget（组件 s0e），展开/收起由 Z1e 的 open state 决定，
    //      四张卡片被 `e &&`（isAdmin）包着，收起态连 DOM 都不渲染 —— 纯 CSS 补不回来。
    //   2) v3.0.54 的探针在加载后 1.6s 抓到 syswidget.already-open {w:334,h:1037}，说明那一刻
    //      isAdmin 与 open 都成立、面板完整展开，面板是"之后"才被压掉的。
    //   3) 压它的是 NAS 的 fndesk.js：fndesk_initAutoBottom() 用两个过宽的选择器
    //      querySelector('.box-border.flex.max-h-full') 与
    //      querySelector('.absolute.overflow-hidden.rounded-2xl')（全文件各只出现这一次，都函数内）
    //      恰好命中本面板的内层容器与外层容器，随后往面板外层写 inline bottom
    //      （= innerHeight - min(h, innerHeight-60) - 30），并把 ResizeObserver 挂在内层上，
    //      内层高度一变就再写一遍。面板本来 top:17 + bottom:17 撑满右侧，被改成大 bottom 后
    //      top 仍是 17，高度塌成几十像素，再被 overflow-hidden 一裁，就只剩顶部那条胶囊。
    //   4) v3.0.55 抖动的原因：我们删 bottom → 高度变 → fndesk 的 ResizeObserver 触发 → 又写 →
    //      我们又删 …… 高频反馈环，表现为面板底边上下狂跳。
    // 本版做法（从根上让 fndesk 碰不到面板，而不是跟它抢）：
    //   A. 往 <head> 最前面插一个隐藏"诱饵"：外层 class 就是 absolute overflow-hidden rounded-2xl、
    //      内层 class 就是 box-border flex max-h-full。document.querySelector 返回文档顺序第一个，
    //      head 永远在 body 之前，所以 fndesk 的 e / t 都会锁到诱饵上 —— 它写 bottom 写到诱饵、
    //      ResizeObserver 盯的也是诱饵（尺寸恒为 0，永不触发），真实面板完全不再被碰。
    //      诱饵零尺寸、visibility:hidden，不影响布局。
    //   B. 删掉 v3.0.55 的持续清理（它才是抖动源）。只在早期做两次一次性清理（t0 / +3s），
    //      处理诱饵生效前可能已被写进去的脏值；之后再不清，绝不会和 fndesk 来回抢。
    //   C. 保留 40 秒窗口内的自动展开（确实收起时才点一次自带箭头，等价手点），过后不再干预。
    //   D. 新增只读探针 syswidget.probe（1s / 4s / 10s 各一次），记录面板外层的 inline bottom 与
    //      高度 —— 只读不改，用来确认诱饵是否真的把 fndesk 挡在外面。
    const __findSysWidgetPanel = () => {
      let nodes;
      try { nodes = document.querySelectorAll('div[class*="right-[14px]"][class*="top-[17px]"]'); } catch (_) { return null; }
      for (let k = 0; k < nodes.length; k++) {
        const el = nodes[k];
        const cls = String(el.className || '');
        if (cls.indexOf('overflow-hidden') >= 0 && cls.indexOf('rounded-2xl') >= 0) return el;
      }
      return null;
    };
    const __sysWidgetLog = (ev, d) => {
      try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar', ev: ev, detail: JSON.stringify(d || {}) }); } catch (_) {}
    };
    // A + B + D
    const __decoyFndeskAutoBottom = () => {
      try {
        if (EMBED || __isSubFrame) return;
        const DECOY_ID = 'fnos-client-fndesk-decoy';
        const __ensure = () => {
          try {
            if (document.getElementById(DECOY_ID)) return true;
            // 插到 documentElement 最前（排在 head 之前）——querySelector 按文档序遍历，
            // 这样诱饵必定排在 body 里真实面板之前；不去动 head 内部，避免页面重建 head 时被清掉。
            const host = document.documentElement;
            if (!host) return false;
            const d = document.createElement('div');
            d.id = DECOY_ID;
            d.setAttribute('aria-hidden', 'true');
            // 抢 fndesk 的 querySelector('.absolute.overflow-hidden.rounded-2xl')
            d.className = 'absolute overflow-hidden rounded-2xl';
            d.style.cssText = 'position:absolute!important;left:-99999px!important;top:0!important;' +
              'width:0!important;height:0!important;overflow:hidden!important;' +
              'visibility:hidden!important;pointer-events:none!important;';
            // 抢 fndesk 的 querySelector('.box-border.flex.max-h-full')
            const inner = document.createElement('div');
            inner.className = 'box-border flex max-h-full';
            inner.style.cssText = 'width:0!important;height:0!important;overflow:hidden!important;';
            d.appendChild(inner);
            host.insertBefore(d, host.firstChild);
            return true;
          } catch (_) { return false; }
        };
        if (!__ensure()) setTimeout(__ensure, 300);
        // 只删面板外层自己的 inline bottom，绝不动其他样式。
        const __clearOnce = (tag) => {
          try {
            const p = __findSysWidgetPanel();
            if (!p || !p.style) return;
            const b = p.style.bottom;
            if (!b) return;
            p.style.removeProperty('bottom');
            __sysWidgetLog('syswidget.clear-bottom.once', { tag: tag, removed: b });
          } catch (_) {}
        };
        __clearOnce('t0');
        setTimeout(() => __clearOnce('t3'), 3000);
        // 只读探针：不改任何东西，只回报面板外层当前的 inline bottom / 高度。
        const __probe = (tag) => {
          try {
            const p = __findSysWidgetPanel();
            const decoy = !!document.getElementById(DECOY_ID);
            if (!p) { __sysWidgetLog('syswidget.probe', { tag: tag, panel: 0, decoy: decoy ? 1 : 0 }); return; }
            const r = p.getBoundingClientRect();
            __sysWidgetLog('syswidget.probe', {
              tag: tag, panel: 1, decoy: decoy ? 1 : 0,
              inlineBottom: (p.style && p.style.bottom) || '',
              w: Math.round(r.width), h: Math.round(r.height)
            });
          } catch (_) {}
        };
        setTimeout(() => __probe('1s'), 1000);
        setTimeout(() => __probe('4s'), 4000);
        setTimeout(() => __probe('10s'), 10000);
        // 诱饵是被插进 head 的，正常不会丢；万一被页面重建清掉，低频补一次即可（补 DOM 不会引起抖动）。
        let guard = 0;
        const t = setInterval(() => {
          guard++;
          try { __ensure(); } catch (_) {}
          if (guard >= 10) { try { clearInterval(t); } catch (_) {} }
        }, 2000);
        __sysWidgetLog('syswidget.decoy', { ok: 1, inHead: !!(document.head && document.getElementById(DECOY_ID)) });
      } catch (_) {}
    };
    // C. 40 秒窗口内，面板确实是收起态才点一次自带展开箭头；窗口过后不再干预。
    const __guardSysWidget = () => {
      try {
        if (EMBED || __isSubFrame) return;
        const t0 = Date.now();
        const AUTO_WINDOW = 40000;
        let clicks = 0, lastClick = 0, gaveUp = false;
        const __maybeOpen = (p, w, h) => {
          try {
            if (gaveUp || clicks >= 3) return;
            if (Date.now() - t0 > AUTO_WINDOW) return;
            // 加载中途会出现"宽 20px、高很长"的塌陷中间态，等它稳定再做判断。
            if (!(w > 100 && h < 120)) return;
            if (Date.now() - lastClick < 5000) return;
            const inner = p.firstElementChild;
            let btn = null;
            if (inner) {
              for (let k = 0; k < inner.children.length; k++) {
                const c = inner.children[k];
                if (String(c.className || '').indexOf('cursor-pointer') >= 0) { btn = c; break; }
              }
            }
            if (!btn) {
              gaveUp = true;
              // kids 数量能反推 isAdmin 分支：非管理员时组件只渲染那条胶囊，不会出现箭头。
              __sysWidgetLog('syswidget.giveup', { why: 'nobtn', w: w, h: h, kids: inner ? inner.children.length : -1 });
              return;
            }
            lastClick = Date.now();
            clicks++;
            btn.click();
            __sysWidgetLog('syswidget.autoopen', { w: w, h: h, kids: inner ? inner.children.length : -1, n: clicks });
          } catch (_) {}
        };
        const __tick = () => {
          try {
            const p = __findSysWidgetPanel();
            if (!p) return;
            const r = p.getBoundingClientRect();
            const w = Math.round(r.width), h = Math.round(r.height);
            if (h > 120) {
              if (!window.__swOpenLogged) { window.__swOpenLogged = 1; __sysWidgetLog('syswidget.open-ok', { w: w, h: h }); }
            } else {
              __maybeOpen(p, w, h);
            }
          } catch (_) {}
        };
        setTimeout(__tick, 1200);
        // 只在自动展开窗口期内巡检，窗口过后彻底停手，不和页面上的任何东西抢。
        const t = setInterval(() => {
          if (Date.now() - t0 > AUTO_WINDOW + 5000) { try { clearInterval(t); } catch (_) {} return; }
          __tick();
        }, 1500);
      } catch (_) {}
    };
    // v4.0.37（用户对比截图：客户端里 qBittorrent 表头上方多出一条空白，浏览器没有）：
    // qB 的 dynamicTable 把固定表头写成 sticky，并用**内联 !important** 写 top:<body 视口偏移>px。
    // 我们的让位是 html padding-top（body 下移 34px），qB 读到的偏移就多出 34px，表头被顶下去
    // 形成空档。样式表 !important 打不过内联 !important，只能在运行时改写内联值并持续看守。
    const __fixSticky37 = () => {
      try {
        if (typeof process === 'undefined' || !Array.isArray(process.argv)) return;
        if (process.argv.indexOf('--fnos-xapp') < 0) return;
        const list = document.querySelectorAll('#torrentsTableFixedHeaderDiv,.dynamicTableFixedHeaderDiv');
        for (let i = 0; i < list.length; i++) {
          const el = list[i];
          const cur = el.style.getPropertyValue('top');
          if (cur && parseFloat(cur) !== 0) el.style.setProperty('top', '0px', 'important');
        }
      } catch (_) {}
    };
    // v4.0.38：qBittorrent 的配色方案存在服务端 clientdata（qbt_color_scheme）。页面在 load
    // 早期就调用 ColorScheme.update()，那时 clientdata 还没回来，只能按 prefers-color-scheme
    // 兜底；之后值到了却不再重算 → 界面上表现为"选了浅色/深色不生效"。
    // 注入脚本本身跑在隔离世界，读不到页面的 window.qBittorrent，所以这里往页面插入一段
    // <script>，让看守代码在【主世界】运行（qB 的 CSP 允许 inline script）。
    const __watchQbTheme38 = () => {
      try {
        if (typeof process === 'undefined' || !Array.isArray(process.argv)) return;
        if (process.argv.indexOf('--fnos-xapp') < 0) return;
        if (document.getElementById('fn-qb-theme-watch')) return;
        const s = document.createElement('script');
        s.id = 'fn-qb-theme-watch';
        s.textContent = "(function(){try{if(window.__fnQbThemeWatch)return;window.__fnQbThemeWatch=1;" +
          "var last='__init__';" +
          "function apply(){try{var q=window.qBittorrent;if(!q||!q.ClientData||!q.ColorScheme)return;" +
          "var v=q.ClientData.get('color_scheme');if(typeof v==='undefined')return;" +
          "if(v===last)return;last=v;q.ColorScheme.update();}catch(e){}}" +
          // 事件驱动：点「保存」后 qB 只更新了内存里的 clientdata，不再重算主题 → 这里补一次
          "document.addEventListener('click',function(e){" +
          "try{var t=e.target;var b=t&&t.closest?t.closest('button,input[type=button],a'):null;" +
          "if(!b)return;var txt=(b.value||b.textContent||'').trim();" +
          "if(!/^(保存|Save)$/i.test(txt))return;" +
          "setTimeout(apply,150);setTimeout(apply,800);setTimeout(apply,2000);}catch(e){}},true);" +
          // 首次进入 + 低频兜底
          "apply();setTimeout(apply,400);setTimeout(apply,1500);setInterval(apply,2500);" +
          "}catch(e){}})();";
        (document.head || document.documentElement).appendChild(s);
      } catch (_) {}
    };

    let __sticky37Obs = false;
    const __watchSticky37 = () => {
      if (__sticky37Obs) return;
      __sticky37Obs = true;
      __fixSticky37();
      try {
        const mo37 = new MutationObserver(() => __fixSticky37());
        mo37.observe(document.documentElement || document, { subtree: true, attributes: true, attributeFilter: ['style'] });
      } catch (_) {}
      let n37 = 0;
      const t37 = setInterval(() => { __fixSticky37(); if (++n37 > 20) clearInterval(t37); }, 500);
    };

    // ================= v4.0.45：主窗页内应用窗统一自绘标题栏 =================
    // 用户定案（2026-11-05）：「程序内打开的所有应用，标题栏一律用自绘标题栏」。
    // 背景：客户端主窗里飞牛桌面打开的应用窗（.trim-ui__app-layout--window）的拖动与
    // — □ ✕ 原本全由飞牛前端 bundle 的 DDe 钩子处理（header 上 mousedown → document
    // mousemove，用 clientX/clientY 改 left/top，并把 top 夹在「视口高-55」）。这套逻辑
    // 在高 DPI + RDP 会话下表现为「拖动反向 / 点窗控逐次下移、最后贴底拖不回来」。
    // 那是第三方代码，改不动，索性整条接管：
    //   ① 隐藏页面自带的 44px 表头（用样式表按 data 属性隐藏，React 重渲染也不会丢）；
    //   ② 注入 36px 自绘栏：应用图标 + 应用名 + — □ ✕（与主程序/应用窗同款手感）；
    //   ③ 拖动自己算：只用 clientX/clientY 增量写 **body 坐标**的 left/top，
    //      **绝不用 screenX/screenY**（那正是之前反向的根源），夹取用 body.clientWidth/Height；
    //   ④ 窗控**代理到飞牛原生按钮**（表头 display:none 仍可 click），让它内部的
    //      activeWindows / 托盘 / 最大化 class 状态保持一致，不出现两套状态打架。
    function __watchInPageWindows() {
      try {
        if (EMBED || !__isMainWin) return; // 只管主窗的飞牛桌面；应用窗/内嵌窗走各自分支
        if (window.__fnosIwInstalled) { try { window.__fnosIwRescan && window.__fnosIwRescan(); } catch (_) {} return; }
        window.__fnosIwInstalled = 1;

        const BAR_H = 36;
        const WIN_SEL = '[class*="app-layout--window"]';
        const HDR_SEL = '[class*="app-layout--header"]';
        const MARK = 'data-fnos-iw';

        try {
          if (!document.getElementById('fnos-iw-css')) {
            const st = document.createElement('style');
            st.id = 'fnos-iw-css';
            // v4.0.72：用 visibility 而不是 display:none —— 保留原生表头占位高度，
            // 否则应用按 100vh 算的布局会整体超出一截（飞牛音乐底部播放条被裁掉一半就是这原因）
            st.textContent = '[' + MARK + '-hdr="1"]{visibility:hidden!important}'
              + '[' + MARK + '="bar"]{box-sizing:border-box}'
              + '[' + MARK + '="bar"] .fnos-iw-ico:hover{background:rgba(127,127,127,0.18)}'
              + '[' + MARK + '="bar"] .fnos-iw-ico-close:hover{background:#E81123!important;color:#fff!important}';
            (document.head || document.documentElement).appendChild(st);
          }
        } catch (_) {}

        const __barBg = (hdr) => {
          try {
            const bg = getComputedStyle(hdr).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
          } catch (_) {}
          try {
            const dark = document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
            return dark ? 'rgba(37,40,46,0.96)' : 'rgba(255,255,255,0.96)';
          } catch (_) { return 'rgba(255,255,255,0.96)'; }
        };
        const __barFg = (hdr) => {
          try { const c = getComputedStyle(hdr).color; if (c) return c; } catch (_) {}
          return 'inherit';
        };

        // v4.0.46：统一的「可视区夹取」。拖动与窗口出现时共用同一套边界，口径一致：
        //   能整窗放下（宽/高 ≤ 可视区）→ 整窗不越界；
        //   放不下 → 至少留 120px 宽 + 44px（标题栏）在可视区内，保证窗控按钮够得到。
        // 实测动机：飞牛把 Docker 窗摆到 left=253/宽 1100（右缘 1353 > 视口 1246），
        // 右上角 — □ ✕ 直接落在视口外，用户点不到。
        const __clampPos = (win, rawL, rawT) => {
          let L = Math.round(rawL), T = Math.round(rawT);
          try {
            const vw = document.body.clientWidth || window.innerWidth;
            const vh = document.body.clientHeight || window.innerHeight;
            const w = win.offsetWidth || 0, h = win.offsetHeight || 0;
            if (w && w <= vw) L = Math.max(0, Math.min(L, vw - w));
            else if (w) L = Math.max(-(w - 120), Math.min(L, vw - 120));
            if (h && h <= vh) T = Math.max(0, Math.min(T, vh - h));
            else if (h) T = Math.max(0, Math.min(T, vh - 44));
          } catch (_) {}
          return { L, T };
        };
        const __clampInView = (win) => {
          try {
            if (!win || win.getAttribute(MARK) !== '1') return false;
            const curL = parseFloat(win.style.left);
            const curT = parseFloat(win.style.top);
            const L0 = isFinite(curL) ? curL : (win.offsetLeft || 0);
            const T0 = isFinite(curT) ? curT : (win.offsetTop || 0);
            const { L, T } = __clampPos(win, L0, T0);
            if (L === Math.round(L0) && T === Math.round(T0)) return false;
            win.style.left = L + 'px';
            win.style.top = T + 'px';
            try { ipcRenderer.send('fnos:media-log', { stage: 'inpage.clamp', from: Math.round(L0) + ',' + Math.round(T0), to: L + ',' + T }); } catch (_) {}
            return true;
          } catch (_) { return false; }
        };

        const __mkIco = (kind) => {
          const s = document.createElement('span');
          s.className = 'fnos-iw-ico fnos-iw-ico-' + kind;
          s.style.cssText = 'display:flex;align-items:center;justify-content:center;width:44px;height:100%;flex:0 0 auto;cursor:pointer;color:inherit;';
          if (kind === 'min') s.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M3 8H13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
          else if (kind === 'max') s.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16"><rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
          else s.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
          s.setAttribute('role', 'button');
          s.title = kind === 'min' ? '最小化' : kind === 'max' ? '最大化/还原' : '关闭';
          return s;
        };

        function __buildBar(win, hdr) {
          const bar = document.createElement('div');
          bar.setAttribute(MARK, 'bar');
          bar.style.cssText = 'height:' + BAR_H + 'px;flex:0 0 ' + BAR_H + 'px;display:flex;align-items:center;'
            + 'justify-content:space-between;padding:0;user-select:none;cursor:default;'
            + 'background:' + __barBg(hdr) + ';color:' + __barFg(hdr) + ';';

          const left = document.createElement('div');
          left.style.cssText = 'display:flex;align-items:center;gap:8px;overflow:hidden;flex:1 1 auto;min-width:0;padding-left:12px;pointer-events:none;';
          try {
            const im0 = hdr.querySelector('img');
            if (im0 && im0.getAttribute('src')) {
              const im = document.createElement('img');
              im.src = im0.getAttribute('src');
              im.style.cssText = 'width:16px;height:16px;flex:0 0 auto;border-radius:4px;display:block;';
              left.appendChild(im);
            }
          } catch (_) {}
          const title = document.createElement('span');
          title.style.cssText = 'font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          const tt = hdr.querySelector('[class*="app-layout--header-title"]');
          title.textContent = String((tt && tt.textContent) || '').trim() || String(document.title || '');
          left.appendChild(title);
          bar.appendChild(left);

          const right = document.createElement('div');
          right.style.cssText = 'display:flex;align-items:stretch;height:100%;flex:0 0 auto;';
          const minB = __mkIco('min'), maxB = __mkIco('max'), closeB = __mkIco('close');
          // v4.0.68（用户工单：自绘栏要把原生标题栏的按钮补回来）：
          // 不再逐个应用硬编码，而是**镜像原 header 里的全部可点击控件**（刷新/新窗口/搜索/下载/最小化/最大化/关闭…），
          // 克隆其 DOM（图标风格一致）并把点击代理到原生元素，行为与原生完全一致。
          // 镜像到 ≥1 个控件时就不再画我们自己的 min/max/close（避免重复）；镜像不到才回退。
          let __mirrored = 0;
          try {
            const __all = [...hdr.querySelectorAll('.cursor-pointer')];
            // 只取最外层按钮，避免图标内部被重复计数
            const __tops = __all.filter((el) => !__all.some((o) => o !== el && o.contains(el)));
            __tops.forEach((src) => {
              try {
                if (src.closest('[' + MARK + ']')) return;
                const r = src.getBoundingClientRect();
                const wpx = Math.min(Math.max(Math.round(r.width) || 32, 22), 46);
                const c = src.cloneNode(true);
                c.setAttribute(MARK, 'mirror');
                c.style.cssText = 'display:flex;align-items:center;justify-content:center;width:' + wpx + 'px;'
                  + 'height:100%;flex:0 0 auto;cursor:pointer;background:transparent;border:0;padding:0;';
                c.addEventListener('click', (e) => {
                  e.stopPropagation();
                  try { src.click(); } catch (_) {}
                });
                right.appendChild(c);
                __mirrored++;
              } catch (_) {}
            });
          } catch (_) {}
          if (!__mirrored) {
            // 回退：镜像不到时按原生能力画 min/max/close（v4.0.67 逻辑）
            const __hasNative = (cls) => { try { return !!hdr.querySelector('.' + cls); } catch (_) { return false; } };
            if (__hasNative('app-layout-header-minimize')) right.appendChild(minB);
            if (__hasNative('app-layout-header-maximize')) right.appendChild(maxB);
            if (__hasNative('app-layout-header-close')) right.appendChild(closeB);
          }
          bar.appendChild(right);

          const __native = (cls) => {
            try { const el = hdr.querySelector('.' + cls); if (el) { el.click(); return true; } } catch (_) {}
            return false;
          };
          minB.addEventListener('click', (e) => { e.stopPropagation(); __native('app-layout-header-minimize'); });
          maxB.addEventListener('click', (e) => { e.stopPropagation(); __native('app-layout-header-maximize'); });
          closeB.addEventListener('click', (e) => { e.stopPropagation(); __native('app-layout-header-close'); });

          // —— 自绘拖动（v4.0.45 核心）——
          bar.addEventListener('pointerdown', (e) => {
            try {
              if (e.button !== 0) return;
              if (e.target && e.target.closest && e.target.closest('[role="button"]')) return;
              e.preventDefault(); e.stopPropagation();
              const left0 = parseFloat(win.style.left) || 0;
              const top0 = parseFloat(win.style.top) || 0;
              const sx = e.clientX, sy = e.clientY;
              let cx = sx, cy = sy;
              try { bar.setPointerCapture(e.pointerId); } catch (_) {}
              let moved = false;
              const onMove = (ev) => {
                cx = ev.clientX; cy = ev.clientY;
                const dx = cx - sx, dy = cy - sy;
                if (!moved && Math.abs(dx) <= 2 && Math.abs(dy) <= 2) return;
                moved = true;
                // v4.0.46：与「窗口出现时」共用同一套夹取口径（整窗放得下就整窗不越界）
                const p = __clampPos(win, left0 + dx, top0 + dy);
                win.style.left = p.L + 'px';
                win.style.top = p.T + 'px';
              };
              const onUp = () => {
                try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
                bar.removeEventListener('pointermove', onMove);
                bar.removeEventListener('pointerup', onUp);
                bar.removeEventListener('pointercancel', onUp);
                if (!moved) return;
                // 松手后把光标最终位置回灌给飞牛（它自己的拖动会重读 rect 同步内部基准），
                // 否则之后窗口 resize 时它按旧基准把窗口拽回原位。
                try {
                  hdr.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy, button: 0 }));
                  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy, button: 0 }));
                } catch (_) {}
              };
              bar.addEventListener('pointermove', onMove);
              bar.addEventListener('pointerup', onUp);
              bar.addEventListener('pointercancel', onUp);
            } catch (_) {}
          });
          bar.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); __native('app-layout-header-maximize'); });

          return bar;
        }

        function __attach(win) {
          try {
            if (!win || win.getAttribute(MARK) === '1') return;
            const hdr = win.querySelector(':scope > ' + HDR_SEL) || win.querySelector(HDR_SEL);
            if (!hdr) return;
            win.setAttribute(MARK, '1');
            hdr.setAttribute(MARK + '-hdr', '1');
            const bar = __buildBar(win, hdr);
            // v4.0.72：覆盖式而非插入式——栏不占布局空间，应用（音乐/影视）的 100vh 布局保持原样
            try {
              const __hdrH = Math.round(hdr.getBoundingClientRect().height) || 44;
              bar.style.position = 'absolute';
              bar.style.top = '0';
              bar.style.left = '0';
              bar.style.right = '0';
              bar.style.height = __hdrH + 'px';
              bar.style.zIndex = '2147483000';
              const __pos = getComputedStyle(win).position;
              if (__pos === 'static') win.style.position = 'relative';
              win.appendChild(bar);
            } catch (_) {
              win.insertBefore(bar, win.firstChild);
            }
            // v4.0.71（用户工单：飞牛音乐底部播放条缺失，只有拖动标题栏才出现）：
            // 自绘栏是"后插"进窗口的第一个子节点，窗口变矮了 36px；而很多应用（音乐/影视等）
            // 的底部播放条是绝对定位、按加载时的容器尺寸算的，插入后不会自动重算 →
            // 底部被顶出可视区。这里在插入后的几个时机主动派发 resize，逼页面重排一次；
            // 同时给窗口根节点打一个属性，应用若监听 MutationObserver 也能感知。
            try {
              const __forceReflow = () => {
                try { window.dispatchEvent(new Event('resize')); } catch (_) {}
                try { document.dispatchEvent(new Event('resize')); } catch (_) {}
                try {
                  win.querySelectorAll('iframe').forEach((f) => {
                    try { f.contentWindow && f.contentWindow.dispatchEvent(new Event('resize')); } catch (_) {}
                  });
                } catch (_) {}
              };
              [0, 60, 220, 700].forEach((ms) => setTimeout(__forceReflow, ms));
            } catch (_) {}
            try { ipcRenderer.send('fnos:media-log', { stage: 'inpage.bar', title: String(bar.textContent || '').slice(0, 24) }); } catch (_) {}
            // v4.0.46：窗口出现时若被摆到可视区外（飞牛的默认摆放会这样），夹回可视区。
            // 打开动画/布局要几帧才稳定，分两档补夹（只越界才动）。
            try {
              [120, 500, 1200].forEach((ms) => setTimeout(() => { if (win.isConnected) __clampInView(win); }, ms));
            } catch (_) {}
          } catch (_) {}
        }

        const __rescan = () => {
          try {
            document.querySelectorAll(WIN_SEL).forEach((w) => {
              if (w.getAttribute(MARK) === '1') {
                if (!w.querySelector(':scope > [' + MARK + '="bar"]')) { w.removeAttribute(MARK); __attach(w); }
              } else __attach(w);
            });
          } catch (_) {}
        };
        window.__fnosIwRescan = __rescan;

        let __pend = false;
        const __mo = new MutationObserver(() => {
          if (__pend) return;
          __pend = true;
          requestAnimationFrame(() => { __pend = false; __rescan(); });
        });
        try { __mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
        __rescan();
        // 主题切换后重上色（表头背景/前景变了，我们的栏要跟）
        try {
          setInterval(() => {
            try {
              document.querySelectorAll('[' + MARK + '="bar"]').forEach((b) => {
                const w = b.parentElement;
                const hdr = w && w.querySelector(HDR_SEL);
                if (!hdr) return;
                const bg = __barBg(hdr), fg = __barFg(hdr);
                if (b.style.background !== bg) b.style.background = bg;
                if (b.style.color !== fg) b.style.color = fg;
              });
            } catch (_) {}
          }, 2000);
        } catch (_) {}
      } catch (_) {}
    }

    // ================= v4.0.48：保持登录（覆盖三层：主窗 / 页内应用 / 独立应用窗） =================
    // 飞牛前端用 localStorage 的 os-keep-login + fnos-Secret 决定「重启后认不认这个登录」。
    // 这里按全局开关把它钉死：开 → 强制 '1' 并把票据留在 localStorage；
    // 关 → 置 '0' 并把票据挪进 sessionStorage（本次会话有效，退出即失效）。
    function __applyKeepLogin() {
      try {
        let on = true;
        try {
          const r = ipcRenderer.sendSync('settings:get-keep-login');
          on = !!(r && r.keepLogin !== false);
        } catch (_) {}
        const apply = () => {
          try {
            const ls = window.localStorage, ss = window.sessionStorage;
            if (!ls) return;
            if (on) {
              if (ls.getItem('os-keep-login') !== '1') ls.setItem('os-keep-login', '1');
              // 票据只在 sessionStorage 里时搬到 localStorage（飞牛取消勾选时就是这么放的）
              if (!ls.getItem('fnos-Secret') && ss && ss.getItem('fnos-Secret')) {
                ls.setItem('fnos-Secret', ss.getItem('fnos-Secret'));
                ss.removeItem('fnos-Secret');
              }
            } else {
              if (ls.getItem('os-keep-login') !== '0') ls.setItem('os-keep-login', '0');
              if (ss && ls.getItem('fnos-Secret')) {
                ss.setItem('fnos-Secret', ls.getItem('fnos-Secret'));
                ls.removeItem('fnos-Secret');
              }
            }
          } catch (_) {}
        };
        apply();
        // v4.0.50：登录态现场上报（用户要求——出问题时把日志发来即可定位）
        // 只报「有没有」，绝不带票据内容。
        const report = (tag) => {
          try {
            let hasSecret = false, keep = null, secretLen = 0;
            try {
              const v = window.localStorage.getItem('fnos-Secret');
              hasSecret = !!v;
              secretLen = v ? String(v).length : 0;
              keep = window.localStorage.getItem('os-keep-login');
            } catch (_) {}
            ipcRenderer.send('fnos:media-log', {
              stage: 'login.flag',
              tag: tag,
              want: on ? 1 : 0,
              keepFlag: keep,
              hasTicket: hasSecret ? 1 : 0,
              ticketLen: secretLen,
              href: String(location.href || '').slice(0, 80),
              partition: String((location.protocol + location.host) || '').slice(0, 60),
            });
          } catch (_) {}
        };
        report('apply');
        [600, 2000, 5000].forEach((ms) => setTimeout(apply, ms)); // SPA 路由切换后可能重写
        [2500, 6000].forEach((ms) => setTimeout(() => report('settle' + ms), ms));
        try {
          ipcRenderer.on('settings:keep-login-changed', (e, d) => { on = !!(d && d.keepLogin); apply(); });
        } catch (_) {}
      } catch (_) {}
    }

    const start = () => { try { __applyKeepLogin(); __setupFullscreen(); if (EMBED) { buildEmbed(); } else { build(); buildAccountSwitcher(); } __ensureContentOffset(); __setupZoomControls(); __decoyFndeskAutoBottom(); __guardSysWidget(); __watchSticky37(); __watchQbTheme38(); __watchInPageWindows(); } catch (_) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) {
    try { ipcRenderer.send('fnos:media-log', { stage: 'titlebar.ex', err: String((e && e.message) || e) }); } catch (_) {}
  }
};
