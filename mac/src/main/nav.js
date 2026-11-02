'use strict';
/** 地址处理：连接串规范化、HTTPS 探测、导航白名单、URL 重写、直播基址解析 */

function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) return { ok: false, error: '请输入服务器地址' };
  s = s.replace(/^\/+/, '');
  if (!/^https?:\/\//i.test(s)) {
    // 用户常填 192.168.31.101 或 192.168.31.101:5666
    s = 'http://' + s;
  }
  let u;
  try { u = new URL(s); } catch (_) { return { ok: false, error: '地址格式不正确' }; }
  if (!u.hostname) return { ok: false, error: '地址格式不正确' };
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '仅支持 http / https' };
  // 仅保留 origin（NAS 入口始终是根路径，带路径会 404）
  return { ok: true, url: u.origin, host: u.hostname, port: u.port || (u.protocol === 'https:' ? '443' : '80') };
}

function originOf(urlStr) {
  try {
    const u = new URL(String(urlStr));
    return u.origin;
  } catch (_) { return ''; }
}

function originKey(urlStr) {
  try {
    const u = new URL(String(urlStr));
    return u.origin + (u.pathname || '/').replace(/\/+$/, '');
  } catch (_) { return String(urlStr || ''); }
}

function hostOf(urlStr) {
  try { return new URL(String(urlStr)).hostname.toLowerCase(); } catch (_) { return ''; }
}

/** 已知服务器主机集合（含 accounts / history / server） */
function knownHosts(settings) {
  const s = settings || {};
  const list = [];
  const push = (u) => { const h = hostOf(u); if (h) list.push(h); };
  push(s.server);
  if (Array.isArray(s.accounts)) s.accounts.forEach((a) => push(a && (a.origin || a.server)));
  if (Array.isArray(s.history)) s.history.forEach((h) => push(h && (h.href || h.url)));
  return Array.from(new Set(list));
}

function hostMatches(host, hosts) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  for (const k of hosts) {
    if (h === k) return true;
    // 允许 NAS 域名与其子域（DDNS 场景）
    if (h.endsWith('.' + k)) return true;
    // IP 直连允许同网段？不做，避免过宽
  }
  return false;
}

/** URL 重写映射：外网访问时把内网 origin 换成公网 */
function applyUrlMappings(urlStr, mappings) {
  const u = String(urlStr || '');
  const list = Array.isArray(mappings) ? mappings : [];
  for (const r of list) {
    if (!r || !r.match || !r.replace) continue;
    if (u.startsWith(r.match)) return r.replace + u.slice(r.match.length);
  }
  return u;
}

/** 直播基址：自定义优先，否则当前服务器 origin */
function resolveIptvBase(settings) {
  const s = settings || {};
  const custom = s.iptv && s.iptv.iptvBaseUrl ? String(s.iptv.iptvBaseUrl).replace(/\/+$/, '') : '';
  if (custom) return custom;
  return originOf(s.server || s.origin || '');
}

/** 三条订阅线路 → FPK/直播服务基址 */
function lineBaseOrigin(settings, line) {
  const s = settings || {};
  const origin = originOf(s.server || s.origin || '');
  if (!origin) return '';
  const custom = s.iptv && s.iptv.iptvBaseUrl ? String(s.iptv.iptvBaseUrl).replace(/\/+$/, '') : '';
  if (custom) {
    if (line === 'ipv6') return custom.replace(/^(https?):\/\//, '$1://[::1]').replace('[::1]', '');
    return custom;
  }
  return origin;
}

/** 从 NAS 地址里取出应用 id（/app/<id> 或 /appview?anchor=<id>） */
function appIdOf(urlStr) {
  try {
    const u = new URL(String(urlStr));
    const m = /^\/app\/([^/?#]+)/i.exec(u.pathname || '');
    if (m) return decodeURIComponent(m[1]);
    const anchor = u.searchParams.get('anchor') || u.searchParams.get('app');
    if (anchor) return decodeURIComponent(anchor);
    const seg = String(u.pathname || '').split('/').filter(Boolean);
    return seg.length ? decodeURIComponent(seg[seg.length - 1]) : '';
  } catch (_) { return ''; }
}

/** 导航白名单：只允许已知 NAS 主机与内置页面 */
function isAllowedNavigation(urlStr, settings) {
  const u = String(urlStr || '');
  if (!u) return false;
  if (/^(about|file|chrome-extension|devtools):/i.test(u)) return true;
  if (/^https?:/i.test(u)) {
    const hosts = knownHosts(settings);
    const h = hostOf(u);
    if (!h) return false;
    if (!hosts.length) return true;   // 尚未连接过服务器时不拦
    return hostMatches(h, hosts);
  }
  return false;
}

module.exports = {
  normalizeServer, originOf, originKey, hostOf, knownHosts, hostMatches,
  applyUrlMappings, resolveIptvBase, lineBaseOrigin, appIdOf, isAllowedNavigation,
};
