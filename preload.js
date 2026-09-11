'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 点播断流重新取流函数：由下方 installEmbeddedMpv IIFE 在同一隔离世界内赋值。
// 关键：不能把函数写进 contextBridge 暴露的对象（window.fnos.xxx.fn = ...）——
// contextIsolation 下暴露对象是冻结代理，运行时改写其属性会抛错并被 catch 吞掉，
// 导致主进程永远拿不到刷新函数（重新签名恒为 null）。这里用模块级变量 + 闭包活引用，
// 暴露的 __refreshMpvMedia 始终读取该变量的最新值。
let __mpvRefreshFn = null;

// 安全地暴露给登录页/渲染页面使用。
contextBridge.exposeInMainWorld('fnos', {
  connect: (server) => ipcRenderer.invoke('auth:connect', { server }),
  loadLastServer: () => ipcRenderer.invoke('auth:load-history'),
  backToConnect: () => ipcRenderer.invoke('auth:back-to-connect'),
  removeHistory: (partition) => ipcRenderer.invoke('auth:remove-history', { partition }),
  platform: process.platform,
  version: '1.38.0',

  mpvPlay: (url, meta) => ipcRenderer.invoke('mpv:play', { url, title: (meta && meta.title) || '', isLive: !!(meta && meta.isLive) }),
  mpvEmbed: (payload) => ipcRenderer.invoke('mpv:embed', payload || {}),
  mpvClose: () => ipcRenderer.invoke('mpv:embed-close'),
  // 点播播放中途断流（飞牛签名链接约 10 分钟失效）时，由主进程经 executeJavaScript 回调：
  // 读取隔离世界内注册的刷新函数，重新走 play/info→media/range，返回新鲜签名地址。
  __refreshMpvMedia: () => {
    try { return Promise.resolve(typeof __mpvRefreshFn === 'function' ? __mpvRefreshFn() : null); }
    catch (e) { return Promise.resolve(null); }
  },
});

// ============================================================================
// 飞牛影视“点开即看”：网页 <video> 解不了（HEVC/10bit/4K/MKV）时，按参考客户端 fntv
// 的链路解析真实视频直链：
//   itemGuid(路由) → GET /v/api/v1/stream/list/<itemGuid>
//                 → Data.VideoStreams[0].MediaGUID
//                 → GET /v/api/v1/media/range/<mediaGUID>（带 Cookie + Authorization）
// 交给主进程在应用内嵌入 MPV 播放（--wid 覆盖视频区，不弹外部窗口）。网页能播的不动。
// 全程通过 fnMediaLog 上报结构化日志，便于诊断。
// ============================================================================
(function installEmbeddedMpv() {
  try {
    const log = (stage, extra) => {
      try { ipcRenderer.send('fnos:media-log', { stage, t: Date.now(), url: location.href, ...(extra || {}) }); } catch (_) {}
    };

    // v1.47.0 性能守卫：视频接管只在【飞牛影视/视频播放页】才有意义。
    // 文件管理、相册、设置、第三方大型 FPK 应用等窗口此前也会无条件 hook
    // fetch/XHR 并启动 subtree MutationObserver（任意 DOM 变更都全量
    // querySelectorAll('video')），在文件列表/重前端应用里造成持续 CPU 占用、卡顿。
    // 这里按路由判断：非视频页直接跳过整套拦截，进入视频页后（SPA 导航）再惰性启动。
    const VIDEO_PATH_RE = /\/v\/(?:video|movie|tv(?:\/episode|\/season)?|folder|media|live)\//i;
    let __installed = false;           // MutationObserver（DOM 监听）是否已惰性安装
    let __onVideoActivity = null;      // 网络钩子命中播放接口时的回调（惰性安装 DOM 监听）
    function isVideoRoute() {
      try {
        const p = location.pathname || '';
        if (VIDEO_PATH_RE.test(p)) return true;
        if (/\/v\/live\//.test(p)) return true;
        // 播放页可能带 media_guid / itemGuid 查询参数
        const sp = new URLSearchParams(location.search || '');
        if (sp.get('media_guid') || sp.get('itemGuid') || sp.get('item_guid')) return true;
        return false;
      } catch (_) { return false; }
    }

    // ---- fNOS API 签名（与参考客户端 fntv 完全一致：MD5(key_url_nonce_ts_md5(body)_secret)）----
    // 允许通过环境变量覆盖，避免将签名凭据硬编码在客户端脚本中（默认值仅为兼容旧版本回退）
    const FN_API_KEY = process.env.FN_API_KEY || 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
    const FN_API_SECRET = process.env.FN_API_SECRET || '16CCEB3D-AB42-077D-36A1-F355324E4237';
    // 纯 JS MD5（不依赖 Node 模块，sandbox preload 也可用），标准 RFC1321 实现
    function md5Hex(inputStr) {
      function toUtf8Bytes(str) {
        const out = [];
        for (let i = 0; i < str.length; i++) {
          let c = str.charCodeAt(i);
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
          else if (c >= 0xd800 && c <= 0xdbff) {
            const c2 = str.charCodeAt(++i);
            c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
            out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
          } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        return out;
      }
      const bytes = toUtf8Bytes(String(inputStr));
      const origLen = bytes.length;
      // 填充：0x80 + 0...0 + 64位长度（小端，低32位即可）
      bytes.push(0x80);
      while (bytes.length % 64 !== 56) bytes.push(0);
      const bitLenLo = (origLen * 8) >>> 0;
      const bitLenHi = Math.floor(origLen / 0x20000000);
      for (let i = 0; i < 4; i++) bytes.push((bitLenLo >>> (i * 8)) & 0xff);
      for (let i = 0; i < 4; i++) bytes.push((bitLenHi >>> (i * 8)) & 0xff);

      function toInt32(off) { return (bytes[off]) | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24); }
      const K = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
      const S = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22, 5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20, 4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23, 6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
      function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
      function add32(a, b) { return (a + b) & 0xffffffff; }
      let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
      for (let base = 0; base < bytes.length; base += 64) {
        const M = new Array(16);
        for (let j = 0; j < 16; j++) M[j] = toInt32(base + j * 4);
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
          let F, g;
          if (i < 16) { F = (B & C) | (~B & D); g = i; }
          else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
          else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * i) % 16; }
          F = add32(add32(F, A), add32(K[i], M[g]));
          A = D; D = C; C = B;
          B = add32(B, rotl(F, S[i]));
        }
        a0 = add32(a0, A); b0 = add32(b0, B); c0 = add32(c0, C); d0 = add32(d0, D);
      }
      function hexWord(w) {
        let h = '';
        for (let i = 0; i < 4; i++) { const b = (w >>> (i * 8)) & 0xff; h += ((b >> 4) & 0x0f).toString(16) + (b & 0x0f).toString(16); }
        return h;
      }
      return hexWord(a0) + hexWord(b0) + hexWord(c0) + hexWord(d0);
    }
    function randDigits() { return String(Math.floor(Math.random() * 900000) + 100000); }
    // apiPath: 形如 '/v/api/v1/play/info'；dataObj: POST body 对象（GET 传 undefined）
    function genAuthx(apiPath, dataObj) {
      try {
        const nonce = randDigits();
        const timestamp = Date.now(); // 毫秒，与 fntv TS 端一致
        const bodyStr = dataObj ? JSON.stringify(dataObj) : '';
        const signStr = [FN_API_KEY, apiPath, nonce, String(timestamp), md5Hex(bodyStr), FN_API_SECRET].join('_');
        return `nonce=${nonce}&timestamp=${timestamp}&sign=${md5Hex(signStr)}`;
      } catch (_) { return ''; }
    }

    const state = {
      token: '',
      itemGuid: '',      // 当前播放项 GUID（路由 / 接口推断）
      mediaGuid: '',     // 当前视频流 MediaGUID
      liveStreamUrl: '', // 网页内直播/流媒体实际播放地址（.m3u8/.flv/.../wp/m3u8 等），用于无 itemGuid 的直播页
      playLink: '',      // 飞牛直播转码网关要求的 Play-Link 头值（hls.js/flv.js 透传给 mpv）
      mediaTitle: '',    // 从飞牛业务接口/页面提取到的真实片名（force-media-title / 字幕 / 弹幕匹配用）
      baseOrigin: location.origin,
      handled: false,
      resolving: false,
      lastTitle: ''
    };

    // 飞牛业务 API（取信息/上报类，绝不是可播放流）。直播真流要么是跨域运营商 m3u8，
    // 要么是 /wp/ 转码网关；/v/api/v1/play/record（播放记录上报）这类曾被误当成播放代理。
    function isFnosApiUrl(u) {
      if (!u || typeof u !== 'string') return false;
      if (/\/v\/api\//i.test(u)) return true;
      if (/\/api\/v\d+\//i.test(u)) return true;
      try {
        if (location.origin && u.indexOf(location.origin) === 0 && /\/(api|v\/api)\//i.test(u)) return true;
      } catch (_) {}
      return false;
    }
    // 严格的"播放代理"判定：/play/<段>，且 <段> 必须同时含数字与字母、长度≥8（真实流 ID/token），
    // 以此排除 /play/record、/play/info、/play/list 等纯单词业务接口。
    const STRICT_PLAY_PROXY_RE = /\/play\/(?=[^/?#]*[0-9])(?=[^/?#]*[a-zA-Z])[0-9a-zA-Z._-]{8,}(?:[?/]|$)/i;
    // 判断是否为可直接交给 mpv 的流媒体直链（HLS/FLV/MP4/fnos play 代理/转码网关等）
    function isPlayableStreamUrl(u) {
      if (!u || typeof u !== 'string') return false;
      if (/^blob:/i.test(u)) return false;       // MSE blob 无法直接给 mpv
      if (/^data:/i.test(u)) return false;
      if (isFnosApiUrl(u)) {
        // 飞牛 API 中只有媒体流代理可播；其余（play/record 等上报/信息接口）一律不是流
        return /\/v\/api\/v1\/(media\/range|stream)\b/i.test(u);
      }
      if (/\.m3u8(\?|$)/i.test(u)) return true;
      if (/\.flv(\?|$)/i.test(u)) return true;
      if (STRICT_PLAY_PROXY_RE.test(u)) return true;   // 真播放代理 /play/<长ID>
      // 飞牛影视网页内直播转码网关：${origin}/wp/m3u8?originalUrl=... 与 /wp/flv、/wp/download
      if (/\/wp\/(m3u8|flv|download|live|stream)\b/i.test(u)) return true;
      // 注意：不要匹配裸 .ts —— 那是 HLS 分片（如 IPTV 源 *.hls.ts），不能单独交给 mpv 播放
      if (/\.(mp4|mkv|aac|mpd)(\?|$)/i.test(u)) return true;
      return false;
    }
    // 清单打分：.m3u8/.flv 最高，wp 转码网关次之，严格 play 代理再次，模糊关键词最低。
    // 用于在 performance 资源里挑选"最像直播清单"的地址（避免被时间更新的业务接口挤掉）。
    function manifestScore(u) {
      if (!u) return 0;
      if (/\.m3u8(\?|$)/i.test(u)) return 100;
      if (/\.flv(\?|$)/i.test(u)) return 95;
      if (/\/wp\/(m3u8|flv|live|stream)\b/i.test(u)) return 80;
      if (/\.mpd(\?|$)/i.test(u)) return 70;
      if (STRICT_PLAY_PROXY_RE.test(u)) return 60;
      if (/[?&/](m3u8|hls|playlist|manifest)([?&=/_-]|$)/i.test(u)) return 40;
      if (/[?&/]live([?&=/_-]|$)/i.test(u)) return 20;
      return 0;
    }
    // 是否为"清单/整流"地址（用于从 performance 资源里识别直播清单；明确排除 .ts/.aac 分片与飞牛业务 API）
    function isManifestUrl(u) {
      if (!u || typeof u !== 'string') return false;
      if (/^blob:|^data:|^about:|^chrome/i.test(u)) return false;
      if (/\.ts(\?|$)/i.test(u) || /\.hls\.ts/i.test(u)) return false;      // HLS 视频分片
      if (/\.aac(\?|$)/i.test(u) || /\.m4s(\?|$)/i.test(u)) return false;    // 音频/分片
      if (isFnosApiUrl(u)) return false;   // 直播清单不走飞牛业务 API（play/record 等）
      return manifestScore(u) > 0;
    }
    function rememberStreamUrl(u) {
      try {
        // 绝不把飞牛业务 API（如 /v/api/v1/play/record 播放记录上报）记成直播流
        if (u && !isFnosApiUrl(u) && (isManifestUrl(u) || isPlayableStreamUrl(u))) {
          state.liveStreamUrl = u;
        }
      } catch (_) {}
    }

    // 兜底扫描：hls.js 可能在 Worker 线程发请求（主页面 fetch/XHR hook 抓不到），
    // 用 Performance Resource Timing 直接读取本页已加载过的所有网络资源，按打分挑出直播清单。
    // 对运营商 IPTV 这类"直连源"直播尤其有效（清单/分片都真实加载过）。
    function scanResourceEntries() {
      try {
        const entries = (window.performance && performance.getEntriesByType)
          ? performance.getEntriesByType('resource') : [];
        let best = '';
        let bestScore = 0;
        let bestStart = -1;
        for (const e of entries) {
          const u = e.name || '';
          const score = manifestScore(u);
          if (score <= 0) continue;
          if (isFnosApiUrl(u)) continue;                 // 排除 play/record 等业务接口
          if (/\.ts(\?|$)/i.test(u) || /\.hls\.ts/i.test(u)) continue;  // 排除分片
          const st = (e.startTime || 0) + (e.fetchStart || 0);
          // 分数高者胜；同分取发起时间最新（切台/重连后旧清单作废）
          if (score > bestScore || (score === bestScore && st > bestStart)) {
            bestScore = score; bestStart = st; best = u;
          }
        }
        if (best) {
          // 高分清单（.m3u8/.flv/wp 网关）总是覆盖；低分仅在当前无有效流时采纳
          const curScore = manifestScore(state.liveStreamUrl);
          if (bestScore >= 80 || !state.liveStreamUrl || isFnosApiUrl(state.liveStreamUrl) || curScore < bestScore) {
            state.liveStreamUrl = best;
          }
          return best;
        }
      } catch (_) {}
      return '';
    }
    // 飞牛直播 m3u8/flv 请求依赖 Play-Link 头（hls.js reqOptions.headers['Play-Link']）；
    // 网页用 fetch/XHR 发起清单/分片请求时一并捕获，交给 mpv 透传，否则转码网关 401/403。
    function rememberPlayLink(headersLike) {
      try {
        if (!headersLike) return;
        const get = typeof headersLike.get === 'function' ? (n) => headersLike.get(n) : null;
        const pl = get ? get('Play-Link') : (headersLike['Play-Link'] || headersLike['play-link'] || headersLike['playLink']);
        if (pl && typeof pl === 'string' && pl.length > 4) state.playLink = pl;
      } catch (_) {}
    }

    // ---------- 从路由推断 itemGuid / mediaGuid ----------
    // 飞牛 SPA 路由（新版）：/v/video/<itemGuid>?media_guid=<mediaGuid>
    // 兼容旧版：/v/movie/<guid>、/v/tv/<guid>、/v/tv/episode/<guid>、/v/tv/season/<guid>、/v/folder/<guid>
    function guidFromPath() {
      try {
        const m = location.pathname.match(/\/v\/(?:video|movie|tv(?:\/episode|\/season)?|folder|media)\/([0-9a-fA-F]{6,})/i);
        return m ? m[1] : '';
      } catch (_) { return ''; }
    }

    // 新版播放页 URL 直接带 media_guid（真实视频流 GUID），优先使用
    function mediaGuidFromQuery() {
      try {
        const sp = new URLSearchParams(location.search || '');
        const mg = sp.get('media_guid') || sp.get('mediaGuid') || '';
        return /^[0-9a-fA-F]{6,}$/.test(mg) ? mg : '';
      } catch (_) { return ''; }
    }

    function readTokenFromStorage() {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) || '';
          const v = localStorage.getItem(k) || '';
          if (/token|auth|jwt|session/i.test(k) && /^[A-Za-z0-9._-]{20,}$/.test(v)) { state.token = v; return; }
          try {
            const o = JSON.parse(v);
            const t = o && (o.token || o.access_token || o.accessToken || (o.data && o.data.token));
            if (t && typeof t === 'string' && t.length > 20) { state.token = t; return; }
          } catch (_) {}
        }
      } catch (_) {}
    }

    // 记录各种飞牛接口里出现的 GUID（多来源兜底）
    function rememberFromUrl(url) {
      try {
        if (!url) return;
        let m = url.match(/\/v\/api\/v1\/stream\/list\/([0-9a-fA-F-]{6,})/);
        if (m) { state.itemGuid = m[1]; return; }
        m = url.match(/\/v\/api\/v1\/stream(?:\?|\/)?/) || url.match(/MediaGUID=([0-9a-fA-F-]{6,})/);
        // POST /v/api/v1/stream 的 body 在 init 里，这里不处理
      } catch (_) {}
    }

    function captureAuth(headersLike) {
      try {
        if (!headersLike) return;
        const get = typeof headersLike.get === 'function' ? (n) => headersLike.get(n) : null;
        const auth = get ? get('Authorization') : (headersLike['Authorization'] || headersLike['authorization']);
        if (auth && typeof auth === 'string') state.token = auth.replace(/^Bearer\s+/i, '').trim();
      } catch (_) {}
    }

    function extractMediaGuid(json) {
      try {
        if (!json) return '';
        // fNOS 外层 {code,msg,data}；兼容直接返回 data
        const d = json.Data || json.data || json;
        // 1) play/info 直接返回 media_guid（snake_case）
        if (d && (d.media_guid || d.MediaGUID)) return d.media_guid || d.MediaGUID;
        // 2) stream/list 返回 video_streams[].media_guid（snake_case，参考客户端字段）
        const vs = d && (d.video_streams || d.VideoStreams);
        if (Array.isArray(vs) && vs.length) {
          for (const s of vs) {
            if (!s) continue;
            const mg = s.media_guid || s.MediaGUID || (s.guid && s.codec_type === 'video' ? s.media_guid : '');
            if (mg) return mg;
          }
          // 兜底：第一项的 media_guid
          if (vs[0] && (vs[0].media_guid || vs[0].MediaGUID)) return vs[0].media_guid || vs[0].MediaGUID;
        }
        // 3) PascalCase 兜底
        if (d && d.MediaGUID) return d.MediaGUID;
      } catch (_) {}
      return '';
    }

    // 从飞牛业务接口 JSON 里尽力提取真实片名（点播 play/info、stream/list、media 详情、直播频道信息）。
    // 页面 document.title 常固定为"飞牛影视"，而这些接口的 data 里通常带 name/title 字段。
    function extractMediaTitle(json) {
      try {
        if (!json || typeof json !== 'object') return '';
        const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        const good = (s) => {
          const t = norm(s);
          if (t.length < 2 || t.length > 80) return false;
          if (/^(飞牛影视|飞牛|fnos|FNOS|登录|首页|加载中|loading|null|undefined)$/i.test(t)) return false;
          // 对白/字幕碎片过滤：媒体详情响应里常嵌套剧集/相关推荐/片段数组，其 title 可能是
          // 一句对白（如“你希望那样吗”）。片名几乎不含句读标点或句末语气词/疑问词。
          if (/[?？!！。，、；：“”"''…—]/.test(t)) return false;
          if (/[吗呢吧啊呀嘛哦哩么]+$/.test(t)) return false;
          // 纯数字/纯哈希/URL 片段
          if (/^[0-9a-fA-F-]{8,}$/.test(t)) return false;
          return true;
        };
        // 收集候选：键名含 name/title（排除 guid/url 等无关键），值为非空字符串
        const KEY_RE = /(^|_)(name|title|showname|seriesname|videoname|media_name|media_title|display_name|episode_name|channel_name|program_name)$/i;
        const hits = [];
        // 关键：只从“非数组上下文”的浅层对象取主片名。
        // 数组里（相关推荐/剧集列表/片段/演员）的 name/title 不是当前媒体的片名，必须跳过。
        const walk = (obj, depth, inArray) => {
          if (!obj || typeof obj !== 'object' || depth > 3) return;
          if (Array.isArray(obj)) { for (const it of obj) walk(it, depth + 1, true); return; }
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === 'string') {
              if (!inArray && KEY_RE.test(k) && good(v)) hits.push({ key: k, val: norm(v), depth });
            } else if (v && typeof v === 'object') {
              walk(v, depth + 1, inArray);
            }
          }
        };
        const d = (json.Data || json.data) ? (json.Data || json.data) : json;
        walk(d, 0, false);
        if (!hits.length) return '';
        // 优先级：精确键名 > 包含 media/video/series/episode > 其它；取最靠前的高优先级候选
        const score = (k) => {
          if (/^(name|title|showname|display_name)$/i.test(k)) return 5;
          if (/media_(name|title)|video_name|series_?name|episode_?name|video_?title/i.test(k)) return 4;
          if (/channel_?name|program_?name|live/i.test(k)) return 3;
          return 2;
        };
        hits.sort((a, b) => (score(b.key) - score(a.key)) || (a.depth - b.depth));
        return hits[0].val;
      } catch (_) { return ''; }
    }

    // 记住从接口响应里抓到的片名（去站点后缀后存入 state，供 embed payload 使用）
    function rememberMediaTitle(json) {
      try {
        const t = extractMediaTitle(json);
        if (t) {
          state.mediaTitle = t.replace(/\s*[-_|–—·]\s*(飞牛影视|飞牛|fnos|FNOS).*$/i, '').trim() || t;
        }
      } catch (_) {}
    }

    function hookFetch() {
      const origFetch = window.fetch;
      if (!origFetch || origFetch.__mpvHooked) return;
      const wrapped = function (input, init) {
        let url = '';
        try {
          if (typeof input === 'string') url = input;
          else if (input && input.url) url = input.url;
          // 仅对同源（本机 fNOS 服务）请求捕获鉴权信息，避免被劫持/跨域请求导致 token 泄露给攻击者服务器
          if (state.baseOrigin && String(url).indexOf(state.baseOrigin) === 0) {
            captureAuth((init && init.headers) || (input && input.headers));
            rememberPlayLink((init && init.headers) || (input && input.headers));
          }
          rememberFromUrl(url);
          rememberStreamUrl(url);
        } catch (_) {}
        const p = origFetch.apply(this, arguments);
        try {
          // 命中飞牛播放/媒体接口：标记视频活动，惰性安装 MutationObserver（文件管理/FPK 不触发）。
          if (isPlayableStreamUrl(url) || /\/v\/api\/v1\/(stream|play|live|tv|media|detail|item)|\/wp\/(m3u8|flv|live|download)|\/live\//i.test(url)) {
            try { if (typeof __onVideoActivity === 'function') __onVideoActivity(); } catch (_) {}
          }
          // 直播/流媒体直链：捕获响应里可能返回的真实播放地址（部分接口返回 JSON {url}/{data:{url}}）
          if (isPlayableStreamUrl(url) || /\/v\/api\/v1\/(stream|play|live|tv)|\/wp\/(m3u8|flv|live)|\/live\//i.test(url)) {
            // v1.51.0 性能保护：只缓冲小型 JSON 响应；跳过二进制流/超大响应（避免把列表/流响应体读入内存造成卡顿）
            p.then(r => {
              try {
                const ct = String(r.headers && r.headers.get && r.headers.get('content-type') || '');
                const len = parseInt(r.headers && r.headers.get && (r.headers.get('content-length') || '0'), 10) || 0;
                if (!/json/i.test(ct)) return Promise.resolve(null);
                if (len > 262144) return Promise.resolve(null); // >256KB 不读
                return r.clone().text().then(t => (t && t.length <= 262144) ? t : null);
              } catch (_) { return Promise.resolve(null); }
            }).then(txt => {
              if (!txt) return;
              try {
                const j = JSON.parse(txt);
                const d = j && (j.data || j.Data) ? (j.data || j.Data) : j;
                // 直播接口返回的真实流地址 / play-link：多字段兜底
                const cand = (d && (d.url || d.play_url || d.playUrl || d.stream_url || d.address || d.play_link || d.playLink || d.m3u8_url || d.m3u8Url || d.original_url || d.originalUrl))
                  || (j && (j.url || j.play_url || j.play_link));
                if (cand && isPlayableStreamUrl(cand)) { state.liveStreamUrl = cand; log('stream.liveurl', { u: String(cand).slice(0, 120) }); }
                if (d && (d.play_link || d.playLink) && typeof (d.play_link || d.playLink) === 'string') { state.playLink = d.play_link || d.playLink; }
                rememberMediaTitle(j);
              } catch (_) {}
            }).catch(() => {});
          }
          if (/\/v\/api\/v1\/(stream\/list|stream|play\/info|play\/quality|media|detail|item|live|tv|channel)\b/.test(url)) {
            // v1.51.0：同样只缓冲小型 JSON，避免列表/大响应被全量读入内存
            p.then(r => {
              try {
                const ct = String(r.headers && r.headers.get && r.headers.get('content-type') || '');
                const len = parseInt(r.headers && r.headers.get && (r.headers.get('content-length') || '0'), 10) || 0;
                if (!/json/i.test(ct)) return Promise.resolve(null);
                if (len > 262144) return Promise.resolve(null);
                return r.clone().text().then(t => (t && t.length <= 262144) ? t : null);
              } catch (_) { return Promise.resolve(null); }
            }).then(txt => {
              if (!txt) return;
              try {
                const j = JSON.parse(txt);
                const mg = extractMediaGuid(j);
                if (mg) { state.mediaGuid = mg; log('stream.guid', { itemGuid: state.itemGuid, mediaGuid: mg }); }
                rememberMediaTitle(j);
              } catch (_) {}
            }).catch(() => {});
          }
        } catch (_) {}
        return p;
      };
      wrapped.__mpvHooked = true;
      window.fetch = wrapped;
    }

    function hookXHR() {
      const XO = window.XMLHttpRequest;
      if (!XO || XO.__mpvHooked) return;
      const open = XO.prototype.open;
      const send = XO.prototype.send;
      const setH = XO.prototype.setRequestHeader;
      XO.prototype.open = function (m, u) { this.__mpvUrl = u; return open.apply(this, arguments); };
      XO.prototype.setRequestHeader = function (k, v) {
        try {
          if (/^authorization$/i.test(k) && v) state.token = String(v).replace(/^Bearer\s+/i, '').trim();
          if (/^play-link$/i.test(k) && v) state.playLink = String(v);
        } catch (_) {}
        return setH.apply(this, arguments);
      };
      XO.prototype.send = function () {
        try {
          const url = this.__mpvUrl || '';
          rememberFromUrl(url);
          rememberStreamUrl(url);
          // 命中播放/媒体接口：惰性安装 MutationObserver（文件管理/FPK 页不会命中，零 DOM 开销）。
          if (/\/v\/api\/v1\/(stream|play|live|tv|media|detail|item|channel)|\/wp\/(m3u8|flv|live|download)/i.test(url)) {
            try { if (typeof __onVideoActivity === 'function') __onVideoActivity(); } catch (_) {}
          }
          if (/\/v\/api\/v1\/(stream\/list|stream|play\/info|play\/quality|media|detail|item|live|tv|channel)\b/.test(url)) {
            this.addEventListener('load', () => {
              try {
                const j = JSON.parse(this.responseText);
                const mg = extractMediaGuid(j);
                if (mg) { state.mediaGuid = mg; log('stream.guid.xhr', { itemGuid: state.itemGuid, mediaGuid: mg }); }
                rememberMediaTitle(j);
              } catch (_) {}
            });
          }
        } catch (_) {}
        return send.apply(this, arguments);
      };
      XO.__mpvHooked = true;
    }

    // 主动 POST play/info（参考客户端主链路）：body {item_guid}，返回 data.media_guid
    // fNOS 网关要求 Authx 签名头（与 fntv signMd5 完全一致：签名 url 用 pathname+search）
    async function fetchPlayInfo(itemGuid) {
      // 与 fntv request() 对齐：POST body 注入独立 nonce 防重放，再对含 nonce 的 body 签名
      const body = { item_guid: itemGuid, nonce: randDigits() };
      const apiPath = '/v/api/v1/play/info';
      try {
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authx': genAuthx(apiPath, body) };
        if (state.token) headers['Authorization'] = state.token;
        const r = await fetch(state.baseOrigin + apiPath, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(body)
        });
        if (!r.ok) { log('playinfo.http', { itemGuid, status: r.status }); return ''; }
        const j = await r.json();
        const mg = extractMediaGuid(j);
        log('playinfo.resp', { itemGuid, got: !!mg, code: j && j.code, msg: j && j.msg });
        return mg;
      } catch (e) { log('playinfo.err', { itemGuid, err: String(e && e.message || e) }); return ''; }
    }

    async function fetchStreamList(itemGuid) {
      const apiPath = '/v/api/v1/stream/list/' + itemGuid; // 与 fntv signMd5 一致，用未编码 path
      try {
        const headers = { 'Accept': 'application/json', 'Authx': genAuthx(apiPath, undefined) };
        if (state.token) headers['Authorization'] = state.token;
        const r = await fetch(state.baseOrigin + apiPath, {
          credentials: 'include',
          headers
        });
        if (!r.ok) { log('streamlist.http', { itemGuid, status: r.status }); return ''; }
        const j = await r.json();
        const mg = extractMediaGuid(j);
        log('streamlist.resp', { itemGuid, got: !!mg, code: j && j.code, msg: j && j.msg });
        return mg;
      } catch (e) { log('streamlist.err', { itemGuid, err: String(e && e.message || e) }); return ''; }
    }

    // 直播页诊断：列出 performance 里所有疑似流/清单的资源，便于定位取流形态
    function dumpLiveDiagnostics() {
      try {
        const entries = (window.performance && performance.getEntriesByType)
          ? performance.getEntriesByType('resource') : [];
        const hits = [];
        for (const e of entries) {
          const u = e.name || '';
          if (/\.m3u8|\.flv|\.hls\.ts|\/PLTV\/|chinamobile|\/wp\/(m3u8|flv)|\/play\/|[?&](originalUrl|playUrl|url)=/i.test(u)
              && !/\.png|\.jpg|\.jpeg|\.css|\.woff|\.svg|\.ico|\.js(\?|$)/i.test(u)) {
            hits.push(u.slice(0, 150));
          }
        }
        // 去重 + 最多 12 条
        const uniq = Array.from(new Set(hits)).slice(-12);
        const vs = Array.from(document.querySelectorAll('video')).map(v => ((v && (v.currentSrc || v.src)) || '').slice(0, 80));
        log('live.diag', {
          path: location.pathname,
          captured: state.liveStreamUrl ? state.liveStreamUrl.slice(0, 120) : '',
          resources: uniq,
          videoSrc: vs,
          hasPlayLink: !!state.playLink,
        });
      } catch (e) { log('live.diag.err', { err: String(e && e.message || e) }); }
    }

    async function resolveDirectUrl() {
      const isLivePage = /\/v\/live\//.test(location.pathname);
      // 直播页(/v/live/<id>)：IPTV 直播 hls.js 直连运营商源（如 chinamobile .hls.ts/.m3u8），
      // 或走 /wp/m3u8 转码。video.src 是 blob、无 media_guid/itemGuid 接口。
      // hls.js 可能在 Worker 发请求（hook 抓不到），这里先扫 performance 资源兜底，再看已捕获地址。
      if (isLivePage) {
        scanResourceEntries();
        if (state.liveStreamUrl && (isManifestUrl(state.liveStreamUrl) || isPlayableStreamUrl(state.liveStreamUrl))) {
          log('resolve.livepage.hook', { u: state.liveStreamUrl.slice(0, 140), hasPlayLink: !!state.playLink });
          return { url: state.liveStreamUrl, source: 'live-page-hook' };
        }
        dumpLiveDiagnostics();
      }
      // 0) 新版播放页 URL 直接带 media_guid（真实视频流 GUID）——最高优先
      const qmg = mediaGuidFromQuery();
      if (qmg) {
        state.mediaGuid = qmg;
        return { url: state.baseOrigin + '/v/api/v1/media/range/' + qmg, mediaGuid: qmg, source: 'query' };
      }
      // 1) 接口拦截到的 mediaGuid
      if (state.mediaGuid) {
        return { url: state.baseOrigin + '/v/api/v1/media/range/' + state.mediaGuid, mediaGuid: state.mediaGuid, source: 'hook' };
      }
      // 2) 路由推断 itemGuid（直播页的 /v/live/<id> 不是 itemGuid，guidFromPath 也不匹配，天然跳过）
      const item = state.itemGuid || guidFromPath();
      if (item) {
        state.itemGuid = item;
        // 2a) POST play/info（参考客户端主链路，浏览器会自动带 Authx/Cookie）
        try {
          const mg = await fetchPlayInfo(item);
          if (mg) { state.mediaGuid = mg; return { url: state.baseOrigin + '/v/api/v1/media/range/' + mg, mediaGuid: mg, source: 'playinfo' }; }
        } catch (e) { log('playinfo.err', { itemGuid: item, err: String(e && e.message || e) }); }
        // 2b) GET stream/list
        try {
          const mg = await fetchStreamList(item);
          if (mg) { state.mediaGuid = mg; return { url: state.baseOrigin + '/v/api/v1/media/range/' + mg, mediaGuid: mg, source: 'streamlist' }; }
        } catch (e) { log('streamlist.err', { itemGuid: item, err: String(e && e.message || e) }); }
      }
      // 3) 网页内直播/流媒体（无 itemGuid 路由，如飞牛影视内的电视直播 4K）：
      //    直接使用网页 <video> 当前播放地址，或 hook 捕获到的流地址（.m3u8/.flv//play/..）。
      try {
        const vs = Array.from(document.querySelectorAll('video'));
        for (const v of vs) {
          const s = (v && (v.currentSrc || v.src)) || '';
          if (s && isPlayableStreamUrl(s)) { log('resolve.livevideo', { u: s.slice(0, 120) }); return { url: s, source: 'video-src' }; }
        }
      } catch (_) {}
      // 4) 直播页：清单可能刚发起/在 Worker 线程，再扫一次资源并给一次短延迟重试
      if (isLivePage) {
        const found = scanResourceEntries();
        if (state.liveStreamUrl && (isManifestUrl(state.liveStreamUrl) || isPlayableStreamUrl(state.liveStreamUrl))) {
          log('resolve.livehook.scan', { u: state.liveStreamUrl.slice(0, 140) });
          return { url: state.liveStreamUrl, source: 'live-resource-scan' };
        }
        await new Promise(r => setTimeout(r, 900));
        scanResourceEntries();
        if (state.liveStreamUrl && (isManifestUrl(state.liveStreamUrl) || isPlayableStreamUrl(state.liveStreamUrl))) {
          log('resolve.livehook.retry', { u: state.liveStreamUrl.slice(0, 140) });
          return { url: state.liveStreamUrl, source: 'live-resource-scan-retry' };
        }
      }
      if (state.liveStreamUrl) { log('resolve.livehook', { u: state.liveStreamUrl.slice(0, 120) }); return { url: state.liveStreamUrl, source: 'live-hook' }; }
      log('resolve.fail', { itemGuid: state.itemGuid, path: location.pathname, hasToken: !!state.token, qmg: !!qmg });
      return null;
    }

    // 点播播放中途断流（飞牛 media/range 是时效签名链接，约 10 分钟后续传 4xx）时，
    // 由主进程通过 window.fnos.__refreshMpvMedia() 回调：强制重新走 play/info 取新的 mediaGuid，
    // 返回一条新鲜签名地址；直播则复用 resolveDirectUrl（m3u8/分片天然刷新）。
    async function refreshMpvMedia() {
      try {
        readTokenFromStorage();
        const isLivePage = /\/v\/live\//.test(location.pathname);
        if (!state.itemGuid) state.itemGuid = guidFromPath();
        const item = state.itemGuid || guidFromPath();
        if (item && !isLivePage) {
          state.itemGuid = item;
          let mg = '';
          try { mg = await fetchPlayInfo(item); } catch (e) { log('refresh.playinfo.err', { err: String(e && e.message || e) }); }
          if (!mg) { try { mg = await fetchStreamList(item); } catch (e) { log('refresh.streamlist.err', { err: String(e && e.message || e) }); } }
          if (mg) {
            state.mediaGuid = mg;
            const url = state.baseOrigin + '/v/api/v1/media/range/' + mg;
            log('refresh.media', { itemGuid: item, mediaGuid: mg });
            return { url, mediaGuid: mg, itemGuid: item, token: state.token, playLink: state.playLink || '', origin: state.baseOrigin, isLive: false };
          }
        }
        // 直播 / 兜底：重新解析当前直链
        const direct = await resolveDirectUrl();
        if (direct && direct.url) {
          const live = isLivePage || /\.(m3u8|flv)(\?|$)/i.test(direct.url) || /\/play\//i.test(direct.url);
          log('refresh.media.resolved', { source: direct.source, isLive: live });
          return { url: direct.url, mediaGuid: direct.mediaGuid || '', itemGuid: state.itemGuid || '', token: state.token, playLink: state.playLink || '', origin: state.baseOrigin, isLive: live };
        }
        log('refresh.media.fail', { itemGuid: state.itemGuid });
        return null;
      } catch (e) { log('refresh.media.ex', { err: String(e && e.message || e) }); return null; }
    }

    function getMainVideo() {
      return Array.from(document.querySelectorAll('video'))
        .filter(x => { const r = x.getBoundingClientRect(); return r.width > 200 && r.height > 120; })
        .sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return (rb.width * rb.height) - (ra.width * ra.height); })[0] || null;
    }
    function _normRect(r) {
      if (!r || r.width < 160 || r.height < 100) return null;
      return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)),
        width: Math.round(r.width), height: Math.round(r.height) };
    }
    // v1.58：找到网页播放器的【容器】（紧贴 video 的播放区外壳）。接管后 video 被
    // display:none，但该容器仍在页面上、位置即播放区，用它定位 MPV 才能"内嵌在播放器内"
    // 而不是铺满整窗；向上遍历时排除几乎覆盖整窗的页面布局列（剧集列表/侧栏应保留可见）。
    function findPlayerBox(v) {
      try {
        const el = v || getMainVideo();
        if (!el) return null;
        const vr = el.getBoundingClientRect();
        if (!vr || vr.width < 160 || vr.height < 100) return null;
        let node = el.parentElement;
        let depth = 0;
        let best = el;
        while (node && depth < 6 && node !== document.documentElement) {
          const r = node.getBoundingClientRect();
          const cs = window.getComputedStyle(node);
          const coversVideo = r && r.width >= vr.width * 0.9 && r.height >= vr.height * 0.9;
          const nearFull = r && (r.width >= window.innerWidth * 0.85 && r.height >= window.innerHeight * 0.85);
          if (coversVideo && cs.display !== 'none' && cs.visibility !== 'hidden') {
            if (node === document.body || nearFull) break; // 到整页层就停（主播放页有侧栏/列表）
            best = node;
            node = node.parentElement; depth++;
          } else break;
        }
        return best;
      } catch (_) { return null; }
    }
    // 悬浮透明标题栏高度：MPV 铺满播放弹窗时顶部预留，避免盖住标题栏按钮/拖动用热区
    var TITLE_RESERVE = 34;
    // 兜底矩形：留出顶部悬浮标题栏的客户区（用于纯播放器弹窗里播放器容器检测失败时，
    // 让 MPV 铺满播放区而不是不启动；带侧栏/列表的主播放页因能测到容器不会走到这里）
    function _fallbackRect() {
      try {
        var y = TITLE_RESERVE;
        var h = window.innerHeight - TITLE_RESERVE;
        if (h < 200) { y = 0; h = window.innerHeight; }
        return { x: 0, y: y, width: window.innerWidth, height: h };
      } catch (_) { return null; }
    }
    function getMainVideoRect(v) {
      try {
        // 接管后（video 被隐藏）：优先用播放器容器实测矩形（内嵌在播放器区）
        if (state.handled && state.playerBox) {
          const br = _normRect(state.playerBox.getBoundingClientRect());
          if (br && br.width >= 120 && br.height >= 120) return br;
          if (state.cachedRect) return state.cachedRect;
        }
        const el = v || getMainVideo();
        if (el) {
          // 网页 video 正常显示时：测 video 自身
          if (!(el.offsetParent === null || el.style.display === 'none')) {
            const rect = _normRect(el.getBoundingClientRect());
            if (rect && rect.width >= 120 && rect.height >= 120) { state.cachedRect = rect; return rect; }
          }
        }
        // video 已隐藏或测不到：优先缓存，最后回退客户区（纯播放器弹窗铺满）
        return state.cachedRect || _fallbackRect();
      } catch (_) { return state.cachedRect || _fallbackRect(); }
    }

    // v1.57：只把网页播放器容器背景置黑（解决 MPV 与播放器接缝处露灰），
    // 绝不碰整页/列表/导航；关闭时由 restorePlayerContainers() 还原。
    function darkenPlayerContainers(v) {
      try {
        const el = v || getMainVideo();
        if (!el) return;
        let node = el.parentElement;
        let depth = 0;
        const touched = [];
        while (node && depth < 4 && node !== document.body && node !== document.documentElement) {
          const cs = window.getComputedStyle(node);
          if (cs && cs.position !== 'static' && node.getBoundingClientRect) {
            const r = node.getBoundingClientRect();
            // 仅当容器基本覆盖视频区（播放器外壳）才置黑，避免误伤布局列/侧栏
            const vr = el.getBoundingClientRect();
            if (r.width >= vr.width * 0.9 && r.height >= vr.height * 0.9 && r.width < window.innerWidth * 0.99) {
              node.__mpvPrevBg = node.style.background || node.style.backgroundColor || '';
              node.style.background = '#000';
              node.style.backgroundColor = '#000';
              touched.push(node);
            }
          }
          node = node.parentElement;
          depth++;
        }
        window.__mpvDarkened = (window.__mpvDarkened || []).concat(touched);
      } catch (_) {}
    }
    function restorePlayerContainers() {
      try {
        const list = window.__mpvDarkened || [];
        list.forEach(n => { try { n.style.background = n.__mpvPrevBg || ''; n.style.backgroundColor = n.__mpvPrevBg || ''; } catch (_) {} });
        window.__mpvDarkened = [];
        const b = document.getElementById('fnos-embed-black');
        if (b) b.remove();
      } catch (_) {}
    }

    let lastRectKey = '';
    function reportRect() {
      try {
        if (!state.handled) return; // 仅在已接管后跟随，避免干扰
        const rect = getMainVideoRect();
        if (!rect) return;
        const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
        if (key !== lastRectKey) { lastRectKey = key; ipcRenderer.send('mpv:embed-rect', rect); }
      } catch (_) {}
    }
    function startRectLoop() {
      if (startRectLoop._on) return; startRectLoop._on = true;
      setInterval(reportRect, 500);
      window.addEventListener('resize', reportRect);
      try {
        const mo2 = new MutationObserver(() => reportRect());
        mo2.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
      } catch (_) {}
    }

    // 智能提取真实媒体名：播放页 document.title 常是固定的"飞牛影视"，需要从页面
    // 标题节点/og 标签/直播间信息里找真正的影片/频道名，供 mpv force-media-title 与字幕/弹幕匹配。
    function pickMediaTitle(isLive) {
      const clean = (s) => String(s || '')
        .replace(/\s+/g, ' ').trim()
        .replace(/\s*[-_|–—·]\s*(飞牛影视|飞牛|fnos|FNOS).*$/i, '')
        .trim();
      const isGood = (s) => {
        if (!s) return false;
        const t = clean(s);
        if (t.length < 2 || t.length > 80) return false;
        if (/^(飞牛影视|飞牛|fnos|FNOS|登录|首页|加载中|loading)$/i.test(t)) return false;
        return true;
      };
      // 0) 最高优先：从飞牛业务接口（play/info、stream/list、media 详情、直播频道）响应里抓到的真实片名
      if (isGood(state.mediaTitle)) return clean(state.mediaTitle);
      // 1) Open Graph / meta 标题
      try {
        const og = document.querySelector('meta[property="og:title"],meta[name="twitter:title"],meta[itemprop="name"]');
        const v = og && (og.getAttribute('content') || og.getAttribute('value'));
        if (isGood(v)) return clean(v);
      } catch (_) {}
      // 2) 直播页：常见频道名容器（兼容不同站点 class 命名）
      if (isLive) {
        try {
          const liveSel = ['.channel-name', '.live-title', '.room-name', '.player-title',
            '[class*="channel"] [class*="name"]', '[class*="live"] [class*="title"]',
            '[class*="channel-name"]', '[class*="channelName"]', 'h1'];
          for (const sel of liveSel) {
            const el = document.querySelector(sel);
            const t = el && (el.getAttribute('title') || el.getAttribute('aria-label') || el.innerText || el.textContent);
            if (isGood(t)) return clean(t);
          }
        } catch (_) {}
      }
      // 3) 点播：详情/播放页主标题节点
      try {
        const sels = ['h1.detail-title', 'h1.video-title', 'h1.play-title', '.detail-title',
          '.video-info .title', '.player-title', '[class*="detail"] h1', '[class*="player"] h1',
          '[class*="videoTitle"]', '[class*="video-title"]', '[class*="mediaTitle"]', '[class*="media-title"]',
          '[class*="title"][class*="main"]', '[class*="title"][class*="name"]', 'h1'];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          const t = el && (el.getAttribute('title') || el.getAttribute('aria-label') || el.innerText || el.textContent);
          if (isGood(t)) return clean(t);
        }
      } catch (_) {}
      // 3.5) 兜底扫描：在 <video>/播放器容器附近找最短的可见标题文本节点（排除按钮/菜单文案）
      try {
        const BAD = /^(播放|暂停|全屏|音量|选集|详情|更多|登录|首页|返回|下一集|上一集|倍速|弹幕|设置|缓存|下载|收藏|分享|清晰度|秒)$/;
        const cand = [];
        document.querySelectorAll('h1,h2,h3,[class*="title"],[class*="name"],[class*="Title"],[class*="Name"]').forEach(el => {
          try {
            const t = (el.getAttribute('title') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!isGood(t)) return;
            if (BAD.test(t)) return;
            // 只取单行短文本（标题），排除长段落/列表容器
            const single = t.split('\n')[0].trim();
            if (single.length < 2 || single.length > 60) return;
            const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            const visible = !rect || (rect.width > 0 && rect.height > 0);
            if (visible) cand.push(single);
          } catch (_) {}
        });
        if (cand.length) {
          // 取出现的、最短且非站点名的候选（标题通常比导航文案更像片名）
          cand.sort((a, b) => a.length - b.length);
          for (const c of cand) { if (isGood(c) && !/飞牛|fnos/i.test(c)) return clean(c); }
          return clean(cand[0]);
        }
      } catch (_) {}
      // 4) 回退：document.title（去掉站点后缀），再不行才用兜底名
      const dt = clean(document.title);
      if (isGood(dt)) return dt;
      return isLive ? '直播频道' : '飞牛影视';
    }

    async function triggerEmbed(v, reason) {
      if (state.handled || state.resolving) return;
      // v1.58：在接管前先用【可见的 video】定位播放器容器并缓存，接管后 video 会被隐藏，
      // 之后用该容器实测矩形定位 MPV，保证"内嵌在播放器区"而不是铺满整窗（列表/侧栏保留）。
      try {
        const mainV = v || getMainVideo();
        if (mainV) {
          const box = findPlayerBox(mainV);
          if (box) { state.playerBox = box; state.cachedRect = _normRect(box.getBoundingClientRect()) || state.cachedRect; }
        }
      } catch (_) {}
      // 视频区坐标：优先播放器容器/video；拿不到时才用铺满内容区的兜底矩形
      let rect = getMainVideoRect(v);
      if (!rect) {
        rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
        log('embed.fallbackrect', { reason: reason || '' });
      } else {
        log('embed.rect', { rect: JSON.stringify(rect), reason: reason || '', hasBox: !!state.playerBox });
      }
      state.resolving = true;
      startRectLoop();
      readTokenFromStorage();
      if (!state.itemGuid) state.itemGuid = guidFromPath();
      log('embed.start', { reason: reason || 'video-error', itemGuid: state.itemGuid, path: location.pathname, hasToken: !!state.token });
      const direct = await resolveDirectUrl();
      state.resolving = false;
      if (!direct || !direct.url) {
        log('embed.nourl', { itemGuid: state.itemGuid });
        return; // 拿不到直链则不接管（网页可能本就能播）
      }
      state.handled = true;
      // 接管成功：暂停并隐藏网页 <video>，避免与 MPV 画面重叠造成"画面抖动/双画面"。
      // 恢复由 mpv:embed-closed 时统一处理。
      try {
        const all = document.querySelectorAll('video');
        all.forEach(v => {
          try {
            if (v && !v.paused) v.pause();
            v.__mpvPrevDisplay = v.style.display;
            v.style.display = 'none';
          } catch (_) {}
        });
      } catch (_) {}
      // v1.57：【不再注入全屏黑层】。此前的全屏 #fnos-embed-black 会盖住剧集列表、
      // 侧边栏，甚至返回主页后残留导致整页全黑。沉浸黑改由原生 MPV 窗口自身的黑底
      // 提供（MPV 覆盖到的区域即为纯黑，含视频上下的黑边）；网页其余部分保持原样可见。
      // 这里仅把网页播放器所在的【容器】背景置黑（在容器上打标记、关闭时还原），
      // 解决 MPV 与播放器容器接缝处的灰色背景，不影响列表/导航/主页。
      try { darkenPlayerContainers(v); } catch (_) {}
      const wpLive = /\/wp\/(m3u8|flv|live)/i.test(direct.url);
      const isLiveNow = /\/v\/live\//.test(location.pathname) || wpLive || /\.(m3u8|flv)(\?|$)/i.test(direct.url) || /\/play\//i.test(direct.url);
      const payload = {
        url: direct.url,
        mediaGuid: direct.mediaGuid,
        itemGuid: state.itemGuid,
        token: state.token,
        playLink: state.playLink || '',
        origin: state.baseOrigin,
        title: pickMediaTitle(isLiveNow),
        isLive: isLiveNow,
        scope: 'movie',
        source: direct.source,
        rect
      };
      log('embed.invoke', { source: direct.source, url: direct.url.slice(0, 96) });
      try {
        await ipcRenderer.invoke('mpv:embed', payload);
        // 首次接管时飞牛详情/playinfo 接口可能尚未返回，片名先取到兜底名。
        // 接管后轮询重查，一旦拿到真实片名即实时推送给 MPV 更新标题/字幕/弹幕匹配。
        state.lastTitle = payload.title;
        scheduleTitleRefresh(isLiveNow);
      }
      catch (e) { state.handled = false; log('embed.invoke.err', { err: String(e && e.message || e) }); }
    }

    // 片名异步就绪后实时更新（解决 MKV 首次打开标题栏/状态栏显示"飞牛影视"）
    function scheduleTitleRefresh(isLive) {
      let tries = 0;
      const tick = () => {
        if (!state.handled) return;          // 已退出接管则停止
        tries++;
        try {
          const t = pickMediaTitle(isLive);
          const valid = t && !/^(飞牛影视|飞牛nas|直播频道|fnos)$/i.test(String(t).trim()) && String(t).trim().length >= 2;
          if (valid && t !== state.lastTitle) {
            state.lastTitle = t;
            log('embed.title.update', { title: t });
            ipcRenderer.invoke('mpv:update-title', { title: t }).catch(() => {});
          }
        } catch (_) {}
        if (tries < 8) setTimeout(tick, 1000);
      };
      setTimeout(tick, 900);
    }

    function restoreVideoDisplay() {
      try {
        state.playerBox = null; state.cachedRect = null; lastRectKey = '';
        document.querySelectorAll('video').forEach(v => {
          try {
            if (typeof v.__mpvPrevDisplay !== 'undefined') { v.style.display = v.__mpvPrevDisplay; v.__mpvPrevDisplay = undefined; }
            else { v.style.display = ''; }
          } catch (_) {}
        });
      } catch (_) {}
    }

    function isUnsupported(v) {
      try {
        if (v.error && v.error.code === 4) return true;   // MEDIA_ERR_SRC_NOT_SUPPORTED（HEVC/10bit/MKV 常见）
        if (v.networkState === 3 && v.readyState === 0) return true; // NETWORK_NO_SOURCE
      } catch (_) {}
      return false;
    }

    function watch(v) {
      try {
        if (!v || v.__mpvWatched) return;
        v.__mpvWatched = true;
        const fail = () => { if (isUnsupported(v)) triggerEmbed(v, 'error'); };
        v.addEventListener('error', fail, true);
        v.addEventListener('stalled', () => {
          if (v.readyState === 0 && v.networkState !== 0) setTimeout(fail, 800);
        }, true);
        // v1.48.0：惰性 observer 可能在 <video> 已经报错之后才安装（MKV/HEVC 等浏览器不支持的格式，
        // error 事件在 watch 注册前就已派发）。绑定后立即补判一次当前状态，避免错过自动接管。
        try { if (isUnsupported(v)) { triggerEmbed(v, 'error-late'); return; } } catch (_) {}
        // 起播后长时间无画面（有 src 但一直没有视频尺寸/进度）才判定为不支持。
        // 关键：播放页 URL 自带 media_guid 且网页正在缓冲（readyState 增长中）时不接管，
        // 避免把"正在加载/可正常播放"的普通视频误判为失败而双开 MPV 造成画面抖动。
        setTimeout(() => {
          try {
            if (state.handled) return;
            const qmg = mediaGuidFromQuery();
            // 有 media_guid 通常是转码/MP4 可播流，除非明确 error(4)，否则不自动接管
            if (qmg && !(v.error && v.error.code === 4)) { log('embed.skip.stuck.hasMediaGuid', {}); return; }
            if (v.src && (v.readyState === 0 || v.readyState === 1) && v.videoWidth === 0) {
              triggerEmbed(v, 'stuck');
            }
          } catch (_) {}
        }, 9000);
      } catch (_) {}
    }
    function scan() { try { document.querySelectorAll('video').forEach(watch); } catch (_) {} }

    // MutationObserver 高频回调节流：文件列表/重前端应用 DOM 变更极频繁，
    // 若每次变更都全量 scan() 会持续占满主线程。用 rAF + 时间窗合并，最多每 400ms 扫一次，
    // 且仅在视频页才扫描 <video>。
    let __scanQueued = false;
    let __lastScanAt = 0;
    function scheduleScan() {
      if (__scanQueued) return;
      __scanQueued = true;
      const delay = Math.max(0, 400 - (Date.now() - __lastScanAt));
      setTimeout(() => {
        __scanQueued = false;
        __lastScanAt = Date.now();
        try { if (isVideoRoute() && !state.handled) scan(); } catch (_) {}
      }, delay);
    }

    const boot = () => {
      // v1.47.0 性能策略：
      //  - fetch/XHR 钩子始终安装（极轻量：仅在请求发生时做字符串匹配，无 DOM 查询、无定时器），
      //    保证飞牛影视播放页无论什么路由都能被接管，零回归风险。
      //  - 真正的性能大头是 subtree MutationObserver + 全量 querySelectorAll('video')。
      //    它改为【惰性安装】：只有当 fetch/XHR 命中飞牛播放接口（/v/api/v1/... stream/media/play、
      //    wp 转码网关等），或页面确实出现 <video> 时才启动；文件管理、相册、设置、第三方大型 FPK
      //    应用不会触发这些接口，因而永不启动 MutationObserver，彻底消除列表/重前端应用卡顿。
      try {
        readTokenFromStorage();
        state.itemGuid = guidFromPath();
        try { __mpvRefreshFn = refreshMpvMedia; } catch (_) {}
        try { hookFetch(); } catch (_) {}
        try { hookXHR(); } catch (_) {}
        // 标记“视频活动”：由网络钩子命中播放接口时调用，惰性安装 DOM 监听。
        __onVideoActivity = () => { installDomObserver(); };
        // 页面若已存在 video（极少见的非接口驱动场景），也惰性启动。
        try {
          const wrapHistory = (name) => {
            const orig = history[name];
            if (typeof orig !== 'function' || orig.__mpvWrapped) return;
            history[name] = function () {
              const r = orig.apply(this, arguments);
              try { state.itemGuid = guidFromPath(); state.handled = false; state.mediaGuid = ''; } catch (_) {}
              return r;
            };
            history[name].__mpvWrapped = true;
          };
          wrapHistory('pushState');
          wrapHistory('replaceState');
          window.addEventListener('popstate', () => { try { state.itemGuid = guidFromPath(); state.handled = false; state.mediaGuid = ''; } catch (_) {} });
        } catch (_) {}
        // 启动时若已在播放页（DOMContentLoaded 后），尝试一次性轻量探测 video
        if (isVideoRoute()) installDomObserver();
        // v1.50.0：兜底捕获"无播放接口驱动"的视频（如飞牛本地 MKV/HEVC 文件，浏览器原生
        // 不支持、走文件流直链，可能不经过 /v/api/... 接口，导致 MutationObserver 永不安装、
        // <video> 的 error 事件无人监听而无法自动接管）。
        // v1.50.0 性能修正：v1.49 的 probe 只要页面存在任意 <video> 就安装 subtree
        // MutationObserver，而 FNDESK 等重前端 FPK 应用首页常有装饰/背景 <video>，
        // 导致 observer 在非视频应用里持续跑（每次 DOM 变更全量 querySelectorAll('video')），
        // 是"FNDESK 卡顿"的元凶。现加三重门控：
        //   1) 必须是视频/播放/直播路由（isVideoRoute 或直播 /play/ 页），文件管理/相册/
        //      桌面等普通应用一律不装；
        //   2) 存在"主播放视频"（可见且宽>320 高>180，排除小装饰视频）；
        //   3) getElementsByTagName 实时集合 O(1) 判断有无，仅命中时才读 rect。
        // 非视频页 probe 每次只做一次 path 字符串匹配 + 一次 O(1) length 判断，开销可忽略。
        const __isPlayLikeRoute = () => {
          try {
            if (isVideoRoute()) return true;
            const p = location.pathname || '';
            // 直播独立窗口 / 播放页（:34500/play/xxx.m3u8 等）
            if (/\/play\//.test(p) || /\.(m3u8|flv)(\?|$)/i.test(p)) return true;
            return false;
          } catch (_) { return false; }
        };
        // v1.52.0：文档级 capture 阶段 error 监听——媒体 error 不冒泡但可在捕获阶段拦截。
        // MKV/HEVC 原生不支持时 <video> 触发 error(code=4)，即使 MutationObserver 因视频
        // 尚未布局/尺寸不足而没安装，这里也能直接捕获并自动接管。单监听器、零 DOM 扫描，
        // 非播放路由直接 return，对 FNDESK/文件管理等应用零开销。
        window.addEventListener('error', (ev) => {
          try {
            if (!__isPlayLikeRoute()) return;
            const t = ev && ev.target;
            if (t && t.tagName === 'VIDEO') {
              installDomObserver();
              const v = getMainVideo() || t;
              log('video.error.global', { path: location.pathname, code: (t.error && t.error.code) || 0 });
              triggerEmbed(v, 'error-global');
            }
          } catch (_) {}
        }, true);
        const __videoProbe = setInterval(() => {
          try {
            // v1.52.0：已接管 MPV 后，仅在【导航离开播放/直播路由】时关闭嵌入 MPV。
            // 注意：接管后网页 <video> 会被我们隐藏(coverVideo)，不能再用"视频消失"判断，
            // 否则会把刚启动的 mpv 立刻关掉（v1.50/v1.51 的回归）。
            if (state.handled && !__isPlayLikeRoute()) {
              state.handled = false;
              try { ipcRenderer.send('mpv:embed-close'); } catch (_) {}
              try { restoreVideoDisplay(); restorePlayerContainers(); } catch (_) {}
              log('embed.autoclose', { path: location.pathname });
            }
            // v1.52.0：播放/直播路由只要出现 <video>（无论是否已布局、尺寸大小）就安装
            // observer，绑定 error/stalled 监听。MKV 文件刚打开时 video 可能还没尺寸，
            // 之前要求"可见且>320x180"导致漏装、无法自动接管。视频路由本身数量有限，开销安全。
            if (__isPlayLikeRoute() && document.getElementsByTagName('video').length > 0) {
              installDomObserver();
            }
          } catch (_) {}
        }, 1000);
        if (__videoProbe.unref) __videoProbe.unref();
        // 菜单/快捷键强制接管：不依赖 DOM 监听是否安装，始终响应（即使页面无 <video> 也按路由解析直链）
        window.addEventListener('fnos:mpv-embed', () => {
          try {
            installDomObserver();
            state.handled = false; state.resolving = false;
            state.itemGuid = state.itemGuid || guidFromPath();
            readTokenFromStorage();
            const v = getMainVideo();
            log('embed.menu', { path: location.pathname, itemGuid: state.itemGuid, hasVideo: !!v });
            triggerEmbed(v, 'menu');
          } catch (_) {}
        });
        ipcRenderer.on('mpv:embed-closed', () => { try { state.handled = false; state.mediaGuid = ''; restoreVideoDisplay(); restorePlayerContainers(); log('embed.closed', {}); } catch (_) {} });
        log('preload.boot', { path: location.pathname });
      } catch (_) {}
    };

    // 惰性安装 MutationObserver + 首次 scan（仅检测到视频活动时执行一次）
    function installDomObserver() {
      if (__installed) return;
      __installed = true;
      try {
        scan();
        const mo = new MutationObserver(() => { scheduleScan(); const g = guidFromPath(); if (g && g !== state.itemGuid) { state.itemGuid = g; state.handled = false; state.mediaGuid = ''; } });
        mo.observe(document.documentElement || document, { childList: true, subtree: true });
        // 路由变化（SPA）重置：pushState/replaceState 已在 boot 中统一包裹，这里不重复包裹。
      } catch (_) {}
      log('dom.observer.installed', { path: location.pathname });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    // v1.50.0：运行期卡顿诊断（所有窗口轻量开启，零 DOM 扫描、无定时器轮询）。
    // 用 PerformanceObserver 监听 longtask（主线程单次阻塞 >120ms），上报到诊断日志，
    // 便于判断 FNDESK 等应用卡顿是"页面自身主线程长任务"还是"客户端/mpv 侧"造成。
    // PerformanceObserver 回调只在真有长任务时触发，空闲时零开销。
    try {
      if (typeof PerformanceObserver !== 'undefined') {
        let __ltCount = 0;
        const __po = new PerformanceObserver((list) => {
          try {
            for (const en of list.getEntries()) {
              __ltCount++;
              // 只上报 >200ms 的明显卡顿，并限流（最多前 20 条），避免日志刷爆
              if (en.duration > 200 && __ltCount <= 20) {
                log('app.longtask', { ms: Math.round(en.duration), path: (location.pathname || '').slice(0, 60), n: __ltCount });
              }
            }
          } catch (_) {}
        });
        try { __po.observe({ entryTypes: ['longtask'] }); } catch (_) {}
      }
    } catch (_) {}
  } catch (e) {
    try { ipcRenderer.send('fnos:media-log', { stage: 'preload.ex', err: String(e && e.message || e) }); } catch (_) {}
  }
})();

// ============================================================================
// v1.48.0：无边框窗口自定义标题栏（与参考客户端 fntv-electron 一致）
// 主窗口 frame:false，这里在页面顶部注入一条可拖拽标题栏 + 最小化/最大化/关闭按钮。
// 仅在飞牛远程网页（http/https）注入；本地 login/settings 页面不注入（它们自带或无需）。
// 采用透明背景 + 半透明按钮，避免遮挡飞牛自身顶部导航的观感；拖拽区可移动窗口。
// ============================================================================
try { require('./titlebar-inject')({ ipcRenderer }); } catch (e) { try { console.error('[titlebar] inject failed:', e && e.stack || e); } catch (_) {} }
