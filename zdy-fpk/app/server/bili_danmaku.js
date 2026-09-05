#!/usr/bin/env node
// 直连 B站 弹幕下载器（JS 版，逻辑与 bili_danmaku.py 完全一致，绕开失效的弹弹play extcomment 代理）
// 用法: node bili_danmaku.js <番名> <集数> <输出xml> [聚合阈值]
// 依赖: 仅 Node 内置模块 (https / crypto / zlib / fs / path / url / process)
'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const UA = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' };
// WBI 混淆表（与 bili_danmaku.py 的 ENC 完全一致）
const ENC = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

// 登录态 Cookie：同目录 bili_cookie.txt（一行）。可绕过匿名 seg.so 概率性空响应风控；缺失则走匿名。
const SCRIPT_DIR = __dirname;
function _load_cookie() {
    const p = path.join(SCRIPT_DIR, 'bili_cookie.txt');
    try {
        const c = fs.readFileSync(p, 'utf8').trim();
        return c || null;
    } catch (e) {
        return null;
    }
}
// 登录态 Cookie：同目录 bili_cookie.txt（一行）。可绕过匿名 seg.so 概率性空响应风控；缺失则走匿名。
// 改为每次 run() 时按需加载（支持主进程内热更新），此处仅声明，初始匿名。
let COOKIE = null;
function _refresh_cookie() { COOKIE = _load_cookie(); }

// 真正校验 Cookie 是否有效（是否过期/失效）：调 nav 接口看 isLogin。
// 注意：仅判断 COOKIE 非空字符串无法识别“过期”——过期 Cookie 仍非空但 isLogin=false，
// 这会导致匿名限制（候选少/seg.so 被风控），是本机 vs 其他机器弹幕数量差异的根因之一。
// 每次 run() 都会调用本函数，避免依赖启动时的一次性判断。
let _cookie_verified = null; // { ok, uname, reason }
async function verify_cookie() {
    if (!COOKIE) {
        _cookie_verified = { ok: false, reason: 'missing' };
        return _cookie_verified;
    }
    try {
        const nav = await jget('https://api.bilibili.com/x/web-interface/nav');
        const data = (nav && nav.data) || {};
        const isLogin = !!data.isLogin;
        _cookie_verified = {
            ok: isLogin,
            uname: data.uname || null,
            reason: isLogin ? null : 'expired_or_invalid',
        };
    } catch (e) {
        _cookie_verified = { ok: false, reason: 'nav_request_failed', err: String(e && e.message ? e.message : e) };
    }
    return _cookie_verified;
}

// 明显非正片的标题关键词（reaction/二创/OP/ED/预告等）
// 注意：BAD_TITLE 只放「确定非正片」的强信号词。曾误放 '你们'/'为什么'/'算是'/'评' 等
// 中文虚词/单字，会误杀剧名本身含这些字眼的番（如《『你们先走我断后』…》标题即含「你们」，
// 导致所有搬运候选被过滤成 0）。已移除这类过宽词条；reaction/二创类仍保留英文与强信号词。
// [lc-469] 增补「解说/合集/速看」类强信号：一口气看完、解析、精讲、讲解 等——这些在视频区
// 兜底（电视剧/真人剧等不进官方番剧区的内容）常因 sim 高、弹幕多而被误选为正片源。
const BAD_TITLE = ['reaction', '反应', '杂谈', '吐槽', '解说', '盘点', '二创', 'mad', 'amv',
    '空降', '切片', '速看', '高能', 'op', 'ed',
    'ost', 'pv', '预告', '花絮', 'cos', '直播', '歌词', '致敬', '混剪', '剪辑',
    '有声轻小说', '广播剧', '有声书', '有声小说',
    '一口气看完', '一口气蹲坑', '看完这', '解析', '精讲', '讲解', '速览', '合集', '总集'];

// 标题/分P名里常见的非识别性填充词，做相似度比较时剔除
const _FILLER = ['高清', '1080p', '720p', '480p', '4k', '合集', '全集', '更新', '熟肉', '生肉',
    '字幕组', '官方', '独家', '番剧', '动画', '动漫', '国语', '日语', '中字', '双语',
    '无修', '无删减', '精校', '完结', '第', '话', '集', '全'];

// 剧名匹配阈值：优先完整剧名(SIM_HIGH)；失败则降低阈值到 SIM_LOW(名字相同即可)。
const SIM_HIGH = 0.90;
const SIM_LOW = 0.30;

// 视频区兜底接受阈值：低于 SIM_LOW 直接跳过。用户要求统一为 0.3。
const VIDEO_SIM_FLOOR = 0.30;

function _norm(t) {
    t = (t || '').toLowerCase();
    t = t.replace(/[\s\[\]【】()（）<>《》\-_~～.。,，!！?？:：/\\|'"'""'""…]/g, '');
    t = t.replace(/第\s*\d+\s*[话集話回季]/g, '');
    t = t.replace(/^\d+\s*季/g, '');
    for (const w of _FILLER) {
        t = t.split(w).join('');
    }
    return t;
}

// LCS 比值 = 2*LCS/(len a + len b)，与 difflib.SequenceMatcher.ratio() 等价（忽略 junk 启发）。
function _lcsRatio(a, b) {
    const memo = new Map();
    function lcs(i, j) {
        if (i === 0 || j === 0) return 0;
        const key = i + ',' + j;
        if (memo.has(key)) return memo.get(key);
        let v;
        if (a[i - 1] === b[j - 1]) v = 1 + lcs(i - 1, j - 1);
        else v = Math.max(lcs(i - 1, j), lcs(i, j - 1));
        memo.set(key, v);
        return v;
    }
    if (a.length === 0 && b.length === 0) return 0;
    return (2 * lcs(a.length, b.length)) / (a.length + b.length);
}

function title_sim(a, b) {
    a = _norm(a); b = _norm(b);
    if (!a || !b) return 0.0;
    if (a === b) return 1.0;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 0.92;
    return _lcsRatio(a, b);
}

// 从候选标题解析"第几季"：阿拉伯数字 / 中文数字 / 罗马数字 / 英文 Season。
// 无季标记返回 0（含义：未知季 / 通常即第1季，由 isSeasonHit 解释）。
const _CN_SEASON = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
const _ROMAN_SEASON = { 'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6, 'Ⅶ': 7, 'Ⅷ': 8, 'Ⅸ': 9, 'Ⅹ': 10 };
function parse_season_from_title(t) {
    if (!t) return 0;
    const s = String(t).replace(/<[^>]+>/g, '');
    let m = s.match(/第\s*([0-9]+)\s*[季部]/);
    if (m) { const v = parseInt(m[1], 10); if (v > 0) return v; }
    m = s.match(/第\s*([一二三四五六七八九十]+)\s*[季部]/);
    if (m && _CN_SEASON[m[1]]) { const v = _CN_SEASON[m[1]]; if (v > 0) return v; }
    m = s.match(/(?:^|[^A-Za-z0-9])([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])(?:[^A-Za-z0-9]|$)/);
    if (m && _ROMAN_SEASON[m[1]]) return _ROMAN_SEASON[m[1]];
    m = s.match(/[Ss]eason\s*([0-9]+)/);
    if (m) { const v = parseInt(m[1], 10); if (v > 0) return v; }
    m = s.match(/([0-9]+)(?:st|nd|rd|th)\s*[Ss]eason/);
    if (m) { const v = parseInt(m[1], 10); if (v > 0) return v; }
    return 0;
}

// season_num 来自 fnOS(0=未知)：
//   - 未提供 → 不启用季过滤（命中一切，保持旧行为）；
//   - 候选无季标记(candSeason=0) → 仅在目标为第1季时视为命中（无标记多指第1季）；
//   - 否则要求季数精确相等，根治跨季错配（如《无职转生》二/三季互串）。
function isSeasonHit(candSeason, season_num) {
    if (!season_num || season_num === 0) return true;
    if (candSeason === 0) return season_num === 1;
    return candSeason === season_num;
}

// 日志接收器：默认输出到 stderr；主进程可通过 setLogSink() 注入（如转发到 app.log）
let _logSink = null;
function setLogSink(fn) {
    _logSink = (typeof fn === 'function') ? fn : null;
}
function log(s) {
    const line = '[bili_danmaku] ' + String(s);
    if (_logSink) {
        try { _logSink(line); } catch (e) { /* 忽略 sink 异常，避免影响主流程 */ }
    } else {
        process.stderr.write(line + '\n');
    }
}

function parse_count(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return Math.trunc(v);
    let s = String(v).trim().replace(/,/g, '');
    if (s === '' || s === '--' || s === '无' || s === '—') return 0;
    try {
        let m = s.match(/([\d.]+)\s*亿/);
        if (m) return parseInt(parseFloat(m[1]) * 1e8, 10);
        m = s.match(/([\d.]+)\s*万/);
        if (m) return parseInt(parseFloat(m[1]) * 10000, 10);
        return parseInt(parseFloat(s), 10);
    } catch (e) {
        return 0;
    }
}

// ---- HTTP 请求（仅 Node 内置） ----
function request(urlStr, opts) {
    opts = opts || {};
    const binary = !!opts.binary;
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlStr); } catch (e) { return reject(e); }
        const lib = u.protocol === 'http:' ? http : https;
        const headers = Object.assign({}, UA, { 'Cache-Control': 'no-cache' });
        if (COOKIE) headers['Cookie'] = COOKIE;
        const req = lib.get(u, { headers }, (res) => {
            const code = res.statusCode || 0;
            // 跟随 GET 重定向（最多 5 跳）
            if ([301, 302, 303, 307, 308].indexOf(code) >= 0 && opts.redirects !== 0) {
                const loc = res.headers.location;
                res.resume();
                if (!loc) return reject(new Error('redirect without location'));
                const next = urlStr.startsWith('http') ? new URL(loc, u).toString() : loc;
                return resolve(request(next, Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 })));
            }
            if (code === 304) { res.resume(); return resolve(binary ? Buffer.alloc(0) : ''); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let buf = Buffer.concat(chunks);
                if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
                    try { buf = zlib.gunzipSync(buf); } catch (e) { /* 保留原样 */ }
                }
                resolve(binary ? buf : buf.toString('utf8'));
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    });
}

function fetch(url, binary) {
    return request(url, { binary: !!binary });
}

function fetch_seg(cid, seg) {
    const url = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=${seg}`;
    let last = Buffer.alloc(0);
    const doTry = (attempt) => {
        return fetch(url, true).then((raw) => {
            if (raw.length >= 20) return raw;
            // 短响应(<20字节) = 该段无弹幕 / 已到弹幕末尾，直接当结束处理，不再重试（避免无谓等待）
            last = raw;
            return raw;
        }).catch((e) => {
            log(`段${seg}下载失败(重试${attempt + 1}/3): ${e.message || e}`);
            if (attempt < 2) {
                return new Promise((r) => setTimeout(r, 2000)).then(() => doTry(attempt + 1));
            }
            return last;
        });
    };
    return doTry(0);
}

function jget(url) {
    return fetch(url, false).then((s) => JSON.parse(s));
}

// WBI 签名（与 Python 版逐行一致；mixin 计算后与 Python 一样未参与最终 w_rid，保留以对齐逻辑）
function wbi_sign(params) {
    // 返回 Promise<string>：已签名的 query 串（含 w_rid & wts）。
    // 复用全局 ENC 表作为 WBI mixin 排列（与 B站官方算法一致；imgKey/subKey 现各 32 字符）。
    return jget('https://api.bilibili.com/x/web-interface/nav').then((nav) => {
        const img = nav.data.wbi_img.img_url;
        const sub = nav.data.wbi_img.sub_url;
        const ik = img.split('/').pop().split('.')[0];
        const sk = sub.split('/').pop().split('.')[0];
        const mixinKey = ENC.map((i) => (ik + sk)[i]).join('').substring(0, 32);
        const signed = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
        const qs = Object.keys(signed).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(signed[k])}`).join('&');
        const w_rid = crypto.createHash('md5').update(qs + mixinKey).digest('hex');
        return `${qs}&w_rid=${w_rid}`;
    });
}

function _bangumi_cid(ep_id) {
    return jget(`https://api.bilibili.com/pgc/view/web/season?ep_id=${ep_id}`).then((sd) => {
        if (sd && sd.code === 0) {
            const eps = (sd.result && sd.result.episodes) || [];
            for (const e of eps) {
                if (e.ep_id === ep_id && e.cid) return e.cid;
            }
        }
        return null;
    }).catch((e) => {
        log('pgc请求失败: ' + (e.message || e));
        return null;
    });
}

function _select_ep(eps, ep_num) {
    if (ep_num && 1 <= ep_num && ep_num <= eps.length) {
        return eps[ep_num - 1];
    }
    let best = null, best_dm = -1;
    for (const ep of eps) {
        const dm = parse_count(ep.danmaku);
        if (dm > best_dm) { best_dm = dm; best = ep; }
    }
    return best;
}

// 番剧区搜索（B站正版番剧）。与 bili_danmaku.py search_bangumi 逻辑一致：
// 优先完整剧名(sim>=SIM_HIGH)；失败则降阈值到 SIM_LOW(0.3)；不做谐音/近似名兜底。
async function search_bangumi(title, ep_num, season_num) {
    const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(title)}&search_type=media_bangumi`;
    const d = await jget(url);
    if (!d || d.code !== 0) {
        log('番剧区搜索失败 code=' + (d && d.code));
        return [];
    }
    const cands = [];
    for (const it of (d.data.result || [])) {
        if (it && typeof it === 'object' && it.result_type === 'media_bangumi') {
            for (const anime of (it.data || [])) {
                const t = String(anime.title || '').replace(/<[^>]+>/g, '');
                if (t.indexOf('中配') >= 0) continue;
                const season = parse_season_from_title(t);
                cands.push([title_sim(title, t), t, anime, season]);
            }
        }
    }
    // 季数过滤启用时(season_num>0)，优先把"命中目标季"的候选排前面，
    // 避免被弹幕更多的其它季挤到 run 的 CAP 之外（run 最多取前 CAP 个候选拉取）。
    cands.sort((x, y) =>
        ((isSeasonHit(y[3], season_num) ? 0 : 1) - (isSeasonHit(x[3], season_num) ? 0 : 1)) ||
        (y[0] - x[0]) ||
        (parse_count(y[2].video_review || 0) - parse_count(x[2].video_review || 0)));
    log(`[番剧区] 命中候选 ${cands.length} 个, ep_num=${ep_num} season_num=${season_num || 0}`);
    for (let i = 0; i < Math.min(cands.length, 5); i++) {
        const [sim, t, anime, season] = cands[i];
        const eps = anime.eps || [];
        log(`[番剧区]   候选[${i}] sim=${sim.toFixed(2)} season=${season} 总集数=${eps.length} ${JSON.stringify(t)}`);
    }
    const results = [];
    for (const thr of [SIM_HIGH, SIM_LOW]) {
        for (const [sim, t, anime, season] of cands) {
            if (sim < thr) continue;
            const eps = anime.eps || [];
            if (!eps.length) continue;
            const ep = _select_ep(eps, ep_num);
            if (!ep) continue;
            const ep_id = ep.ep_id || ep.id;
            if (!ep_id) continue;
            const cid = await _bangumi_cid(ep_id);
            if (cid) {
                const info = { source: 'bangumi', season_id: anime.season_id, epid: ep_id, bvid: null, sim: sim, season_match: isSeasonHit(season, season_num) };
                log(`[番剧区] sim=${sim.toFixed(2)}(阈值${thr}) 候选: ${JSON.stringify(t)} season=${season}(命中=${info.season_match}) ep序号=${ep.index} cid=${cid}`);
                results.push([cid, t, info]);
            }
        }
    }
    if (!results.length) {
        log(`[番剧区] 无达到相似度阈值(${SIM_LOW})的候选，放弃匹配（已移除谐音兜底）`);
    }
    return results;
}

function _ep_in_title(t, ep_num) {
    if (!ep_num) return false;
    const s = String(t);
    if (new RegExp(`第\\s*0*${ep_num}\\s*[话集回話]`).test(s)) return true;
    if (new RegExp('\\d\\s*[~\\-–至]\\s*\\d').test(s)) return false;
    if (new RegExp(`(?:^|[^A-Za-z\\d])(?:e\\.?p\\.?\\s*|episode\\s*|#\\s*)\\s*0*${ep_num}(?!\\d)`, 'i').test(s)) return true;
    if (new RegExp(`(?<![\\d])0*${ep_num}(?![\\d])`).test(s)) return true;
    return false;
}

function _is_compilation_title(t) {
    const s = String(t);
    if (new RegExp('全\\s*\\d+\\s*[集话]').test(s)) return true;
    if (s.indexOf('合集') >= 0 || s.indexOf('总集') >= 0 || s.indexOf('全集') >= 0) return true;
    if (new RegExp('第\\s*\\d+\\s*[~\\-–至]\\s*\\d+\\s*[话集]').test(s)) return true;
    if (new RegExp('\\d+\\s*[~\\-–至]\\s*\\d+\\s*话').test(s)) return true;
    return false;
}

function parse_ep_from_title(title) {
    if (!title) return 0;
    let m = title.match(/第\s*(\d+)\s*[话集回話]/);
    if (m) return parseInt(m[1], 10);
    m = title.match(/(?<![A-Za-z])[Ee][Pp]?\s*(\d+)/);
    if (m) { const n = parseInt(m[1], 10); if (n <= 2010) return n; }
    m = title.match(/(?<![\d])(\d{1,4})(?![\d])\s*[话集回話]/);
    if (m) return parseInt(m[1], 10);
    m = title.match(/[\(（]\s*(\d{1,4})\s*[\)）]/);
    if (m) { const n = parseInt(m[1], 10); if (n <= 2010) return n; }
    m = title.match(/[\-_.\s]\s*(\d{1,4})\s*(?=[\-\]\)）\s]|$)/);
    if (m) { const n = parseInt(m[1], 10); if (n <= 2010) return n; }
    return 0;
}

function cid_from_bvid(bvid, ep_num, title_hint) {
    return jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`).then((d) => {
        if (!d || d.code !== 0 || !d.data) {
            log(`view请求失败 bvid=${bvid} code=${d && d.code}`);
            return null;
        }
        const data = d.data;
        const pages = data.pages || [];
        log(`[cid_from_bvid] bvid=${bvid} pages=${pages.length} ep_num=${ep_num} title_hint=${JSON.stringify(title_hint)}`);
        if (!pages.length) {
            const cid = data.cid;
            if (ep_num && _is_compilation_title(title_hint || '')) {
                log(`[cid_from_bvid] 单cid合集视频(标题含全集标记), 无法隔离第${ep_num}话, 跳过`);
                return null;
            }
            const ok = (ep_num === null || ep_num === undefined || _ep_in_title(title_hint || '', ep_num));
            log(`[cid_from_bvid] 单P: cid=${cid} 集数匹配=${ok}`);
            return ok ? cid : null;
        }
        if (pages.length === 1) {
            const cid = pages[0].cid;
            if (ep_num && _is_compilation_title(title_hint || '')) {
                log(`[cid_from_bvid] 单P合集视频(标题含全集标记), 无法隔离第${ep_num}话, 跳过`);
                return null;
            }
            const ok = (ep_num === null || ep_num === undefined || _ep_in_title(title_hint || '', ep_num));
            log(`[cid_from_bvid] 单P列表: cid=${cid} 集数匹配=${ok}`);
            return ok ? cid : null;
        }
        if (ep_num) {
            let best = null;
            for (let i = 0; i < pages.length; i++) {
                const part = pages[i].part || '';
                if (_ep_in_title(part, ep_num)) {
                    if (part.indexOf('先行') >= 0 || part.indexOf('预览') >= 0) {
                        if (best === null) best = pages[i].cid;
                        log(`[cid_from_bvid] 分P[${i}]=${JSON.stringify(part)} 命中但为先行/预览, 暂存兜底`);
                        continue;
                    }
                    log(`[cid_from_bvid] 分P[${i}]=${JSON.stringify(part)} 集数匹配 -> cid=${pages[i].cid}`);
                    return pages[i].cid;
                }
            }
            log(`[cid_from_bvid] 多P未精确匹配第${ep_num}话, 兜底 cid=${best}`);
            return best;
        }
        log(`[cid_from_bvid] 未指定集数, 取首P cid=${pages[0].cid}`);
        return pages[0].cid;
    }).catch((e) => {
        log('view请求失败: ' + (e.message || e));
        return null;
    });
}

// ── 官方番剧/国创（WBI 签名搜索 + pgc 取集 cid）──
// 说明：B站匿名 search/all/v2 的 media_bangumi 已返回 0，必须用 WBI 签名的
// wbi/search/type 才有机会拿到官方 PGC；且需要登录态 Cookie 才能真正返回结果
// （匿名时同样为空）。命中后走 pgc/view/web/season 取对应集官方 cid，
// 官方单集弹幕常几千~上万条（国创如《灵笼》单集可达 10 万+），远超 UP主 搬运。
// 无 Cookie / 无结果时自动回退 UP主。
// 番剧(season_type=1)与国创(season_type=4)在 B站 同属 media_bangumi 索引，靠 season_type 区分，
// 分别由 search_bangumi_wbi / search_guochuang_wbi 两个通道匹配，互不串区（见 _wbi_pgc_search）。
async function _get_pgc_episodes(season_id) {
    const apis = [
        `https://api.bilibili.com/pgc/view/web/season?season_id=${season_id}`,
        `https://api.bilibili.com/pgc/web/season/section?season_id=${season_id}`,
    ];
    for (const url of apis) {
        try {
            const d = await jget(url);
            if (d && d.code === 0 && d.result) {
                const eps = (d.result.main_section && d.result.main_section.episodes) || d.result.episodes || [];
                if (eps.length) return eps;
            }
        } catch (e) { /* 尝试下一个接口 */ }
    }
    return [];
}
function _pick_episode(eps, ep_num) {
    if (!eps || !eps.length) return null;
    if (ep_num && ep_num >= 1 && ep_num <= eps.length) return eps[ep_num - 1];
    if (ep_num) {
        for (const ep of eps) {
            const tt = (ep.title || '') + ' ' + (ep.long_title || '');
            if (_ep_in_title(tt, ep_num)) return ep;
        }
    }
    return eps[0];
}
// 通用 WBI PGC 搜索（番剧/国创共用）：签名搜索某 search_type，收集带 season_id 的 PGC 条目，
// 解析对应集官方 cid。seasonType 指定时只保留该内容类型（1=番剧, 4=国创，对应 WBI 条目的
// season_type 字段；注意不是 item.type 那个 'media_bangumi' 字符串）。
// 注意：官方 PGC 搜索必须登录态 Cookie —— 匿名时 WBI 接口直接 -412/返回空，本函数返回 []，
// 由上层 search_cid 自动回退到 UP主 视频区（国创/番剧 匿名均走此路）。
// 重要：WBI search/type 返回的是【扁平 PGC 条目数组】(每项直接带 season_id/title/season_type)，
// 不是 all/v2 的嵌套 {result_type,data} 结构——旧版按嵌套结构遍历导致官方匹配长期静默失效，已修正。
async function _wbi_pgc_search(title, ep_num, season_num, search_type, label, sourceName, seasonType) {
    if (!COOKIE) {
        log(`[${label}WBI] 无登录态 Cookie，跳过官方搜索（匿名 ${search_type} 返回 0）`);
        return [];
    }
    let signed;
    try {
        signed = await wbi_sign({ keyword: title, search_type });
    } catch (e) {
        log(`[${label}WBI] 签名失败: ` + (e.message || e));
        return [];
    }
    const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${signed}`;
    let d;
    try { d = await jget(url); } catch (e) { log(`[${label}WBI] 搜索请求失败: ` + (e.message || e)); return []; }
    if (!d || d.code !== 0 || !d.data || !d.data.result) {
        log(`[${label}WBI] 无结果 code=${d && d.code} (可能 Cookie 无权限/匿名)`);
        return [];
    }
    const cands = [];
    for (const item of d.data.result) {
        if (seasonType != null && item.season_type !== seasonType) continue;
        const season_id = item.season_id;
        if (!season_id) continue;
        const t = String(item.title || '').replace(/<[^>]+>/g, '');
        const sim = title_sim(title, t);
        const season = parse_season_from_title(t);
        const season_match = isSeasonHit(season, season_num);
        cands.push({ season_id, t, sim, season, season_match });
    }
    cands.sort((x, y) => ((y.season_match ? 0 : 1) - (x.season_match ? 0 : 1)) || (y.sim - x.sim));
    log(`[${label}WBI] 命中候选 ${cands.length} 个`);
    const results = [];
    const seen = new Set();
    for (const c of cands) {
        if (c.sim < SIM_LOW) continue;
        const eps = await _get_pgc_episodes(c.season_id);
        const ep = _pick_episode(eps, ep_num);
        if (!ep || !ep.cid) continue;
        if (seen.has(ep.cid)) continue;
        seen.add(ep.cid);
        const info = { source: sourceName, season_id: c.season_id, sim: c.sim, season_match: c.season_match };
        const epLabel = ep.long_title ? `${ep.title} ${ep.long_title}` : (ep.title || '');
        results.push([ep.cid, `${c.t}${epLabel ? ' (' + epLabel + ')' : ''}`, info]);
        if (results.length >= 3) break;
    }
    return results;
}

async function search_bangumi_wbi(title, ep_num, season_num) {
    // 番剧区（日番/引进番）：media_bangumi，仅取 season_type=1（番剧），与国创通道互斥避免串区
    return _wbi_pgc_search(title, ep_num, season_num, 'media_bangumi', '番剧区', 'bangumi', 1);
}

// ── 国创官方区（WBI 签名搜索 + pgc 取集 cid）──
// 国创(中国动画)在 B站 PGC 体系中与番剧【同属 media_bangumi 索引】，靠 season_type 区分
// （1=番剧, 4=国创），并非独立 search_type。故本函数直接搜 media_bangumi 并仅取 season_type=4
// （实测 media_ft 为影视分区、不含国创，不予采用）。与 search_bangumi_wbi 完全对称、互不重叠。
// 需登录态 Cookie 才有结果；匿名返回 0，自动回退 UP主 视频区（与番剧区行为一致）。
async function search_guochuang_wbi(title, ep_num, season_num) {
    return _wbi_pgc_search(title, ep_num, season_num, 'media_bangumi', '国创区', 'guochuang', 4);
}

async function search_video(title, ep_num, season_num) {
    // ── 内部：搜索 + 提取候选（复用逻辑）──
    async function _do_search(keyword, label) {
        const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&search_type=video`;
        const d = await jget(url);
        if (!d || d.code !== 0) return [];
        const pool = [];
        for (const it of (d.data.result || [])) {
            if (it && typeof it === 'object' && it.result_type === 'video') {
                for (const v of (it.data || [])) {
                    const t = String(v.title || '').replace(/<[^>]+>/g, '');
                    const bvid = v.bvid;
                    if (bvid) pool.push([t, bvid, parse_count(v.video_review)]);
                }
            }
        }
        if (!pool.length) return [];
        const filtered = pool.filter(([t]) => {
            const low = t.toLowerCase();
            return !BAD_TITLE.some((k) => low.indexOf(k) >= 0);
        });
        function kind_of(t) {
            if (ep_num && _ep_in_title(t, ep_num) && !_is_compilation_title(t)) return 0;
            if (_is_compilation_title(t)) return 2;
            return 1;
        }
        const scored = filtered.map(([t, bvid, vr]) => [title_sim(title, t), kind_of(t), t, bvid, vr, parse_season_from_title(t)]);
        scored.sort((x, y) => (x[1] - y[1]) || (y[4] - x[4]) || (y[0] - x[0]));
        log(`[视频区]${label ? ' (' + label + ')' : ''} 候选 ${scored.length} 个, keyword="${keyword}", ep_num=${ep_num} season_num=${season_num || 0}`);
        const tagmap = { 0: '[单集]', 1: '[不明]', 2: '[合集]' };
        for (let i = 0; i < Math.min(scored.length, 8); i++) {
            const [sim, kind, t, bvid, vr, season] = scored[i];
            log(`[视频区]   候选[${i}]${tagmap[kind] || '?'} sim=${sim.toFixed(2)} season=${season} 弹幕=${vr} ${JSON.stringify(t)}`);
        }
        // 解析 CID 并返回有效候选
        const results = [];
        for (const [sim, kind, t, bvid, vr, season] of scored) {
            if (sim < VIDEO_SIM_FLOOR) continue;
            const cid = await cid_from_bvid(bvid, ep_num, t);
            if (cid) {
                // [lc-469] 合集/解说类(kind=2 或命中 BAD_TITLE)标记 isCompilation：
                // 不参与「首选/聚合优选」，避免电视剧兜底时误选「一口气看完全集」之类。
                const isCompilation = (kind === 2) || BAD_TITLE.some((k) => t.toLowerCase().indexOf(k) >= 0);
                const info = { source: 'video', bvid: bvid, sim: sim, season_match: isSeasonHit(season, season_num), isCompilation };
                const tag = tagmap[kind] || '?';
                const mark = sim >= SIM_LOW ? '' : ' [兜底]';
                log(`[视频区]${label ? ' (' + label + ')' : ''} sim=${sim.toFixed(2)}${tag}${mark} 候选: ${JSON.stringify(t)} season=${season}(命中=${info.season_match}) cid=${cid}`);
                results.push([cid, t, info]);
            }
        }
        return results;
    }

    // ── 主搜索（按番名搜）──
    let results = await _do_search(title, '');

    // ── 二次搜索兜底：主搜索候选不足 3 个时，用"番名 第N话/第N集"再搜一轮 ──
    // 目的：找到单集上传源（单P 视频 cid 直接可用），这类源在纯番名搜索中排名靠后
    if (results.length < 3 && ep_num && ep_num > 0) {
        const epHints = [
            `${title} 第${ep_num}话`,
            `${title} 第${ep_num}集`,
            `${title} 第${ep_num}`,
        ];
        const seenCids = new Set(results.map(([cid]) => cid));
        for (const hint of epHints) {
            const extra = await _do_search(hint, `二次:${hint.slice(-8)}`);
            for (const cand of extra) {
                if (!seenCids.has(cand[0])) {
                    seenCids.add(cand[0]);
                    results.push(cand);
                }
            }
            if (results.length >= 6) break; // 够了就停
        }
        log(`[视频区] 二次搜索补充后共 ${results.length} 个候选`);
    }

    if (!results.length) {
        log(`[视频区] 无达到相似度阈值(${VIDEO_SIM_FLOOR})的候选，放弃匹配`);
    }
    return results;
}

async function search_cid(title, ep_num, season_num) {
    let t = title.replace(/\s*[\(（]\d{4}[\)）]\s*$/, '').trim();
    if (!t) return [];
    if (!ep_num || ep_num === 0) {
        const derived = parse_ep_from_title(t);
        if (derived) {
            log(`[search_cid] ep_num=0, 从标题解析到集数=${derived}: ${JSON.stringify(t)}`);
            ep_num = derived;
        } else {
            log(`[search_cid] ep_num=0 且标题无集数: ${JSON.stringify(t)}`);
        }
    }
    log(`[search_cid] 开始匹配: title=${JSON.stringify(t)} ep_num=${ep_num} season_num=${season_num || 0}`);
    // 优先：官方番剧（WBI 签名搜索，需 Cookie；命中即官方单集弹幕，量级远高于 UP主）
    const bangumiWbi = await search_bangumi_wbi(t, ep_num, season_num);
    if (bangumiWbi.length) {
        log(`[search_cid] 官方番剧(WBI)返回 ${bangumiWbi.length} 个候选`);
        return bangumiWbi;
    }
    // 国创官方区（WBI 签名搜索，需 Cookie；与番剧区对称，覆盖 media_ft / media_bangumi type=4）
    const guochuangWbi = await search_guochuang_wbi(t, ep_num, season_num);
    if (guochuangWbi.length) {
        log(`[search_cid] 国创官方(WBI)返回 ${guochuangWbi.length} 个候选`);
        return guochuangWbi;
    }
    const bangumi = await search_bangumi(t, ep_num, season_num);
    if (bangumi.length) {
        log(`[search_cid] 番剧区返回 ${bangumi.length} 个候选`);
        return bangumi;
    }
    log('番剧区无结果，回退到视频区(UP主搬运)');
    const video = await search_video(t, ep_num, season_num);
    if (video.length) {
        log(`[search_cid] 视频区返回 ${video.length} 个候选`);
        return video;
    }
    log('[search_cid] 番剧区/视频区均未匹配（已移除谐音/近似名兜底，不再猜测）');
    return [];
}

// 并发受限的 map（避免一次性打爆 B站接口，也避免顺序 await 太慢）
async function mapLimit(arr, limit, fn) {
    const out = new Array(arr.length);
    let i = 0;
    async function worker() {
        while (i < arr.length) {
            const idx = i++;
            out[idx] = await fn(arr[idx]);
        }
    }
    const n = Math.min(limit, arr.length);
    const ws = [];
    for (let k = 0; k < n; k++) ws.push(worker());
    await Promise.all(ws);
    return out;
}

// 并行批量拉取弹幕分片（每批 6 段、批内并发 4），显著快于原先逐段顺序 await。
// 命中「空响应(<20字节)」即判定到弹幕末尾并停止（与旧逻辑一致）。
async function try_fetch_danmaku(cid) {
    const all_d = [];
    const BATCH = 6;
    const MAX_SEG = 40;
    let seg = 1;
    while (seg <= MAX_SEG) {
        const nums = [];
        for (let k = 0; k < BATCH; k++) nums.push(seg + k);
        const raws = await mapLimit(nums, 4, (n) => fetch_seg(cid, n));
        let stop = false;
        for (const raw of raws) {
            if (!raw || raw.length < 20) { stop = true; break; }
            const dm = extract(raw);
            for (const d of dm) all_d.push(d);
        }
        if (stop) break;
        seg += BATCH;
    }
    return [all_d.length > 0, all_d];
}

function read_varint(buf, i) {
    let shift = 0, val = 0;
    while (true) {
        const x = buf[i]; i++;
        val |= (x & 0x7f) << shift;
        if (!(x & 0x80)) break;
        shift += 7;
    }
    return [val, i];
}

function parse(buf) {
    const out = []; let i = 0; const n = buf.length;
    while (i < n) {
        const [tag, ni] = read_varint(buf, i); i = ni;
        const f = tag >> 3, wt = tag & 7;
        if (wt === 2) {
            const [ln, li] = read_varint(buf, i); i = li;
            const dt = buf.slice(i, i + ln); i += ln;
            out.push([f, 2, dt]);
        } else if (wt === 0) {
            const [v, vi] = read_varint(buf, i); i = vi;
            out.push([f, 0, v]);
        } else if (wt === 5) {
            const dt = buf.slice(i, i + 4); i += 4;
            out.push([f, 5, dt]);
        } else if (wt === 1) {
            const dt = buf.slice(i, i + 8); i += 8;
            out.push([f, 1, dt]);
        } else {
            break;
        }
    }
    return out;
}

function extract(raw) {
    const top = parse(raw);
    const elems = top.filter((e) => e[0] === 1 && e[1] === 2).map((e) => e[2]);
    const res = [];
    for (const e of elems) {
        let pr = 0, con = null, mode = 1, col = 16777215;
        for (const [f, wt, v] of parse(e)) {
            if (f === 2 && wt === 0) pr = v;
            else if (f === 7 && wt === 2) { try { con = v.toString('utf8'); } catch (err) { con = null; } }
            else if (f === 3 && wt === 0) mode = v;
            else if (f === 5 && wt === 5) col = v.readUInt32LE(0);
        }
        if (con) res.push([pr, mode, col, con]);
    }
    return res;
}

function htmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _write_xml(out, dm) {
    const dir = path.dirname(out) || '.';
    fs.mkdirSync(dir, { recursive: true });
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<danmaku>'];
    for (const [pr, mode, col, con] of dm) {
        const t = (pr / 1000.0).toFixed(2);
        const p = `${t},${mode},25,${col},0,0,0`;
        lines.push(`<d p="${p}">${htmlEscape(con)}</d>`);
    }
    lines.push('</danmaku>');
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
}

function _load_block_types() {
    const p = path.join(SCRIPT_DIR, 'danmaku_block_types.json');
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(data)) return new Set(data.map((x) => String(x)));
    } catch (e) { /* ignore */ }
    return new Set();
}

function _filter_danmaku(dm, block_types) {
    if (!block_types || !block_types.size) return dm;
    const out = [];
    for (const [pr, mode, col, con] of dm) {
        const tags = new Set();
        if (mode === 1) tags.add('scroll');
        else if (mode === 4) tags.add('bottom');
        else if (mode === 5) tags.add('top');
        else if (mode === 6) tags.add('reverse');
        else if (mode === 7 || mode === 8) tags.add('advanced');
        if (col !== 16777215) tags.add('color');
        if ([...tags].some((x) => block_types.has(x))) continue;
        out.push([pr, mode, col, con]);
    }
    return out;
}

function _select_danmaku(fetched, agg_threshold, agg_time_limit, min_danmaku) {
    // ── 单源优选：季匹配优先；同季内排除「合集/解说」源，取弹幕最多者 ──
    // [lc-469] 合集源(isCompilation)不参与首选/聚合优选，避免电视剧兜底时误选
    // 「一口气看完全集」之类解说合集（弹幕多但非正片）。仅在确实无任何非合集候选时才兜底选用。
    function pick(pool) {
        if (!pool.length) return null;
        const valid = pool.filter((f) => f[4] <= agg_time_limit);
        const use = valid.length ? valid : pool;
        const nonComp = use.filter((f) => !(f[2] && f[2].isCompilation));
        const base = nonComp.length ? nonComp : use; // 全为合集才退而求其次
        let best = base[0];
        for (const f of base) if (f[3].length > best[3].length) best = f;
        return best;
    }
    const hit = fetched.filter((f) => f[2] && f[2].season_match);
    const chosen = pick(hit) || pick(fetched);
    if (!chosen) return [null, null, null, null, null, null, ''];

    // ── 单源已达阈值 → 直接返回 ──
    if (!agg_threshold || chosen[3].length >= agg_threshold) {
        return [chosen[3], chosen[0], chosen[1], chosen[2], chosen[2] && chosen[2].source, null, ''];
    }

    // ── 聚合：单源不足阈值时合并多源弹幕 ──
    // 策略：只从「季匹配」候选中聚合（不混入错季弹幕）；
    // 去重用时间窗口 ±AGG_DUP_SEC（同一窗口内相同文本视为重复，保留先出现的）。
    const AGG_DUP_SEC = 2; // 去重时间窗口（秒）
    const pool = hit.filter((f) => f !== chosen && !(f[2] && f[2].isCompilation)); // 仅季命中且非合集候选参与聚合

    if (pool.length === 0) {
        log(`[聚合] 首选 ${chosen[1]}(${chosen[3].length}条) 不足阈值${agg_threshold}, 无其他季匹配候选可聚合`);
        return [chosen[3], chosen[0], chosen[1], chosen[2], chosen[2] && chosen[2].source, null, ''];
    }

    // 时间窗口去重：bucket key = Math.floor(time / AGG_DUP_SEC)，同桶内同文本去重
    const buckets = new Map(); // bucketKey → Set<text>（已见文本）
    const merged = [];
    let src_count = 1;
    const src_titles = [(chosen[2] && chosen[2].bvid) || chosen[1]];

    function tryAdd(d) {
        // 注意：extract() 返回的弹幕是数组 [pr(毫秒), mode, col, con(文本)]，
        // 不是对象，必须用下标读取，不能用 d.time / d.text（否则恒为 undefined，
        // 导致所有弹幕落入同一("NaN")桶、文案同为 undefined，被去重成只剩 1 条）。
        const tSec = (d[0] || 0) / 1000.0; // pr 为毫秒，换算成秒
        const bk = String(Math.floor(tSec / AGG_DUP_SEC));
        const txt = d[3];
        const seen = buckets.get(bk);
        if (seen && seen.has(txt)) return false; // 窗口内重复
        if (!seen) { buckets.set(bk, new Set()); buckets.get(bk).add(txt); }
        else seen.add(txt);
        merged.push(d);
        return true;
    }

    // 注入首选源
    for (const d of chosen[3]) tryAdd(d);

    // 逐源追加（仅时间轴合理的候选）
    for (const cand of pool) {
        if (cand[4] > agg_time_limit) continue;
        let added = 0;
        for (const d of cand[3]) {
            if (tryAdd(d)) added++;
        }
        if (added > 0) {
            src_count++;
            src_titles.push((cand[2] && cand[2].bvid) || cand[1]);
        }
        if (merged.length >= agg_threshold) break;
    }

    merged.sort((a, b) => a.time - b.time);

    log(`[聚合] 首选 ${chosen[1]}(${chosen[3].length}条) 不足阈值${agg_threshold}, 从 ${pool.length} 个季匹配候选中合并 ${src_count - 1} 个额外源 → ${merged.length} 条(去重窗口±${AGG_DUP_SEC}s)`);
    return [merged, chosen[0], chosen[1], chosen[2], chosen[2] && chosen[2].source, src_count > 1 ? src_count : null, src_titles.join(' + ')];
}

// 核心入口：可被主进程 require 后调用，返回结果对象，不调用 process.exit（避免杀掉宿主进程）。
// 副作用：会把弹幕 XML 写到 out 路径（供 MPV / PotPlayer 读取）。
async function run(title, ep_num, out, agg_threshold, season_num) {
    _refresh_cookie();
    await verify_cookie();
    if (typeof ep_num === 'string') ep_num = parseInt(ep_num, 10);
    if (isNaN(ep_num)) ep_num = 0;
    if (typeof season_num === 'string') season_num = parseInt(season_num, 10);
    if (isNaN(season_num)) season_num = 0;
    if (typeof agg_threshold === 'string') agg_threshold = parseInt(agg_threshold, 10);
    if (isNaN(agg_threshold) || !agg_threshold) agg_threshold = 1500;
    const cv = _cookie_verified;
    let loginTag;
    if (!cv || !cv.ok) {
        if (!COOKIE) loginTag = ' [匿名] 无Cookie文件，弹幕数量受限';
        else if (cv && cv.reason === 'expired_or_invalid') loginTag = ' [登录态失效] Cookie已过期/无效，弹幕数量将受限（请从浏览器重新复制SESSDATA填回bili_cookie.txt）';
        else loginTag = ` [登录态检查失败] ${cv ? cv.reason : '未知'}`;
    } else {
        loginTag = ` [登录态已验证]${cv.uname ? ' (' + cv.uname + ')' : ''}`;
    }
    log(`番名=${title} 集数=${ep_num} 季数=${season_num || 0} 聚合阈值=${agg_threshold}${loginTag}`);

    const candidates = await search_cid(title, ep_num, season_num);
    if (!candidates.length) {
        log('未找到B站对应集（可能番名不匹配或网络受限）');
        return { ok: false, error: '未找到匹配的B站视频' };
    }

    // 候选弹幕时间轴上限（秒）：单个候选的弹幕时间轴 max_t 超过此值，则在聚合合并阶段跳过，
    // 且不作为「时长优先」的优选。原值 2200(≈37min) 本意是排除 12 集合集(时间轴动辄上万秒)。
    // 但很多搬运 UP 主为躲避版权，会在视频【尾部追加一大段空白/黑屏】，使单集文件时长被显著拉长；
    // 同时部分单集本身偏长（2 集合、45min 特别篇），其弹幕时间轴常逼近甚至超过 2200s。
    // 放宽到 4500(≈75min)：仍能干净排除 5+ 集合集(≥7000s)，但给「加长 / 带空白尾」的单集留足余量，
    // 避免它们被误判为长片而落选或无法参与合并。
    const AGG_TIME_LIMIT = 4500;
    const MIN_DANMAKU = 10;
    const CAP = 8;

    const fetched = [];
    for (let idx = 0; idx < Math.min(candidates.length, CAP); idx++) {
        const [cid, atitle, info] = candidates[idx];
        const label = (info && info.bvid) || atitle || `候选#${idx + 1}`;
        log(`[${idx + 1}/${candidates.length}] 尝试 cid=${cid} (${label})`);
        const [ok, all_d] = await try_fetch_danmaku(cid);
        if (ok && all_d.length) {
            let max_t = 0;
            for (const [pr] of all_d) if (pr > max_t) max_t = pr;
            max_t = max_t / 1000.0;
            fetched.push([cid, atitle, info, all_d, max_t]);
            log(`  -> ${all_d.length} 条弹幕, 时间轴 0~${max_t.toFixed(0)}s`);
        } else {
            log(`  ⚠️ 候选[${idx + 1}] ${label} 无弹幕数据，跳过`);
        }
    }

    if (!fetched.length) {
        const tried = candidates.map(([, atitle, info], i) => (info && info.bvid) || atitle || `#${i + 1}`).join(', ');
        log(`全部 ${candidates.length} 个候选均无弹幕数据: ${tried}`);
        return { ok: false, error: `已试${candidates.length}个候选均无弹幕数据(${tried})` };
    }

    const [final_dm, best_cid, best_atitle, best_info, source, agg_count, srcs] = _select_danmaku(fetched, agg_threshold, AGG_TIME_LIMIT, MIN_DANMAKU);
    const block_types = _load_block_types();
    let final = final_dm;
    if (block_types.size) {
        const before = final.length;
        final = _filter_danmaku(final, block_types);
        log(`弹幕屏蔽类型生效: 移除 ${before - final.length} 条 (类型=${[...block_types].sort().join(',')}), 剩余 ${final.length} 条`);
    }
    _write_xml(out, final);
    const result = {
        ok: true,
        bvid: best_info && best_info.bvid ? best_info.bvid : null,
        title: title,
        matched_title: best_atitle || title,
        sim: (best_info && typeof best_info.sim === 'number') ? best_info.sim : null,
        danmaku_count: final.length,
        source: source,
        cid: best_cid,
        // [lc-604] 番剧区(正版)没有 bvid, 只有 season_id/epid —— 透传给配置面板显示 ep_id 而非裸 cid
        season_id: (best_info && best_info.season_id) || null,
        epid: (best_info && best_info.epid) || null,
    };
    if (agg_count) result.aggregated_from = agg_count;
    result.cookie_status = (cv && cv.ok) ? 'valid' : ((cv && cv.reason === 'expired_or_invalid') ? 'expired' : 'missing');
    if (agg_count) {
        log(`✅ 最终输出(聚合 ${agg_count} 源): ${best_atitle} -> ${final.length} 条弹幕 (源: ${srcs}) -> ${out}`);
    } else {
        log(`✅ 最终输出: ${best_atitle} -> ${final.length} 条弹幕 (source=${source}) -> ${out}`);
    }
    return result;
}

// ===================== 候选搜索模式（供手动搜索 UI 展示候选列表）=====================
// 只搜索并返回候选视频列表（标题/bvid/弹幕数/来源/季），不拉取/聚合弹幕、不写 XML。
// 用于 MPV 侧「手动搜索 B站弹幕」时，先把候选列表展示给用户，由用户选定具体视频。
async function search_candidates(title, ep_num, season_num) {
    if (typeof ep_num === 'string') ep_num = parseInt(ep_num, 10);
    if (isNaN(ep_num)) ep_num = 0;
    if (typeof season_num === 'string') season_num = parseInt(season_num, 10);
    if (isNaN(season_num)) season_num = 0;
    let t = String(title || '').replace(/\s*[\(（]\d{4}[\)）]\s*$/, '').trim();
    if (!t) return { ok: false, error: '缺少番名' };

    _refresh_cookie();
    await verify_cookie();
    if (!ep_num || ep_num === 0) {
        const derived = parse_ep_from_title(t);
        if (derived) ep_num = derived;
    }
    log(`[候选搜索] 番名=${t} 集数=${ep_num} 季数=${season_num || 0}`);

    const candidates = await search_cid(t, ep_num, season_num);
    if (!candidates.length) {
        log('[候选搜索] 未找到任何候选');
        return { ok: true, candidates: [] };
    }
    // 整理为 UI 友好结构（含候选是否合集/解说，供前端优先置底或标记）
    const list = candidates.slice(0, 12).map(([cid, atitle, info], i) => ({
        index: i,
        cid: cid,
        bvid: (info && info.bvid) || null,
        title: atitle || '',
        source: (info && info.source) || 'unknown',
        season: (info && info.season_match) ? season_num : 0,
        is_compilation: !!(info && info.isCompilation),
        sim: (info && typeof info.sim === 'number') ? info.sim : null,
    }));
    // 按「非合集优先、相似度降序」排序，让正片候选排在前面（合集/解说沉底）
    list.sort((a, b) =>
        ((a.is_compilation ? 1 : 0) - (b.is_compilation ? 1 : 0)) ||
        ((b.sim || 0) - (a.sim || 0)));
    log(`[候选搜索] 返回 ${list.length} 个候选`);
    return { ok: true, candidates: list };
}

// 由用户选定的 bvid 直接拉取该视频弹幕（手动搜索模式：用户已明确选定视频）。
async function run_candidates(title, bvid, out, threshold) {
    if (!title || !bvid || !out) return { ok: false, error: '缺少 title/bvid/out 参数' };
    if (typeof threshold === 'string') threshold = parseInt(threshold, 10);
    if (isNaN(threshold) || !threshold) threshold = 1500;
    _refresh_cookie();
    await verify_cookie();
    log(`[候选拉取] 由 bvid=${bvid} 直接拉取弹幕 title=${title} out=${out}`);
    const cid = await cid_from_bvid(bvid, 0, title);
    if (!cid) return { ok: false, error: `无法解析 bvid=${bvid} 的 cid` };
    const [ok, all_d] = await try_fetch_danmaku(cid);
    if (!ok || !all_d.length) return { ok: false, error: `bvid=${bvid} 无弹幕数据` };
    const block_types = _load_block_types();
    let final = all_d;
    if (block_types.size) final = _filter_danmaku(final, block_types);
    _write_xml(out, final);
    const result = {
        ok: true,
        bvid: bvid,
        title: title,
        matched_title: title,
        sim: null,
        danmaku_count: final.length,
        source: 'video',
        cid: cid,
    };
    log(`✅ [候选拉取] ${title} -> ${final.length} 条弹幕 (bvid=${bvid}) -> ${out}`);
    return result;
}

// CLI 入口：解析 argv -> run -> 输出 BILI_RESULT 到 stdout -> 退出码。
// （历史用法：node bili_danmaku.js <番名> <集数> <输出xml> [聚合阈值]）
async function main() {
    if (process.argv.length < 4) {
        log('用法: bili_danmaku.js <番名> <集数> <输出xml> [聚合阈值] [季数]');
        process.exit(2);
    }
    const title = process.argv[2];
    const ep_num = process.argv[3];
    const out = process.argv[4];
    const agg_threshold = process.argv[5];
    const season_num = process.argv[6];
    try {
        const result = await run(title, ep_num, out, agg_threshold, season_num);
        process.stdout.write('BILI_RESULT:' + JSON.stringify(result) + '\n');
        process.exit(result.ok ? 0 : 1);
    } catch (e) {
        log('致命错误: ' + (e && e.stack ? e.stack : e));
        process.stdout.write('BILI_RESULT:' + JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }) + '\n');
        process.exit(1);
    }
}

// 内存版入口：不写 XML，直接把弹幕转成 ZDY 通用 JSON 数组返回。
// 返回 { ok, comments:[{time,mode,color,text}], matched_title, source, cid, bvid, danmaku_count }
async function runToMemory(title, ep_num, season_num, agg_threshold) {
    const os = require('os');
    const tmpOut = path.join(os.tmpdir(), 'zdy_bili_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.xml');
    try {
        const r = await run(title, ep_num, tmpOut, agg_threshold, season_num);
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'B站弹幕获取失败' };
        // 从写好的 XML 读回并解析为 comments（复用脚本自身的格式化，保证 time/mode/color 一致）
        let comments = [];
        try {
            const xml = fs.readFileSync(tmpOut, 'utf8');
            const re = /<d\s+p="([^"]+)">([\s\S]*?)<\/d>/g;
            let m;
            while ((m = re.exec(xml)) !== null) {
                const f = m[1].split(',');
                const time = parseFloat(f[0]);
                const mode = parseInt(f[1], 10);
                const color = parseInt(f[3], 10);
                let text = m[2];
                text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
                if (isFinite(time) && time >= 0 && text) comments.push({ time, mode, color, text });
            }
        } catch (e) { /* 读 XML 失败则返回空 */ }
        return {
            ok: true,
            comments: comments,
            matched_title: r.matched_title || title,
            source: r.source || 'bilibili',
            cid: r.cid || null,
            bvid: r.bvid || null,
            danmaku_count: r.danmaku_count || comments.length,
            cookie_status: r.cookie_status || null,
        };
    } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
    } finally {
        try { fs.unlinkSync(tmpOut); } catch (e) { /* ignore */ }
    }
}

module.exports = { run: run, runToMemory: runToMemory, search_candidates: search_candidates, run_candidates: run_candidates, setLogSink: setLogSink, _load_cookie: _load_cookie, search_guochuang_wbi: search_guochuang_wbi, search_bangumi_wbi: search_bangumi_wbi };

if (require.main === module) {
    main();
}
