'use strict';

/**
 * 地址规范化与安全白名单。
 * 规则（与 Windows 版对齐）：
 *  - 用户可只填 IP / 域名 / IP:端口，缺 scheme 时补 http://
 *  - 裸 443/8443 端口访问 http 时自动尝试 https（见 preferHttps）
 *  - 任何 webview 导航只允许 http(s)，且 host 必须属于已保存的服务器（含子域）
 */

const { URL } = require('url');

const HTTPS_PREFER_PORTS = [443, 8443];

function normalizeServer(input) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, reason: 'empty' };
  raw = raw.replace(/^\/+/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return { ok: false, reason: 'invalid' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (!u.hostname) return { ok: false, reason: 'host' };
  // 去尾斜杠，保留 base path（NAS 可能挂在子路径）
  let p = u.pathname.replace(/\/+$/, '');
  const url = u.protocol + '//' + u.host + p;
  return { ok: true, url, protocol: u.protocol.replace(':', ''), host: u.host, hostname: u.hostname, port: u.port, path: p };
}

/** 裸 443/8443 且当前是 http → 建议改 https */
function preferHttps(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return null;
    const port = u.port || '80';
    if (HTTPS_PREFER_PORTS.indexOf(Number(port)) < 0) return null;
    u.protocol = 'https:';
    return u.toString().replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
}

/** 由服务器地址派生站名，如 192.168.31.101 → 192.168.31.101，nas.local → nas */
function serverLabel(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
    const first = h.split('.')[0];
    return first || h;
  } catch (_) {
    return String(url || '');
  }
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch (_) { return ''; }
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}

/** 收集所有已保存服务器的 hostname（含 www 变体） */
function allowedHostnames(servers) {
  const out = new Set();
  for (const s of servers || []) {
    const hn = hostnameOf(s && s.url ? s.url : s);
    if (hn) out.add(hn);
  }
  return out;
}

/** target 是否属于 allowed 中的某个主机（自身或子域） */
function hostMatches(hostname, allowed) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  for (const a of allowed) {
    if (h === a) return true;
    if (h.endsWith('.' + a)) return true;
  }
  return false;
}

function isInternalUrl(url) {
  return /^(file:|devtools:|about:|chrome:|data:|blob:)/i.test(String(url || ''));
}

/**
 * @param {string} target
 * @param {Array} servers
 * @param {{allowInternal?:boolean}} opt
 */
function isAllowedNavigation(target, servers, opt) {
  const options = opt || {};
  const s = String(target || '');
  if (!s) return false;
  if (isInternalUrl(s)) return !!options.allowInternal;
  if (!/^https?:\/\//i.test(s)) return false;
  const allowed = allowedHostnames(servers);
  if (!allowed.size) return false;
  return hostMatches(hostnameOf(s), allowed);
}

function joinPath(base, p) {
  const b = String(base || '').replace(/\/+$/, '');
  const q = String(p || '');
  if (!q) return b;
  if (/^https?:\/\//i.test(q)) return q;
  return b + (q.charAt(0) === '/' ? q : '/' + q);
}

module.exports = {
  normalizeServer,
  preferHttps,
  serverLabel,
  hostOf,
  hostnameOf,
  allowedHostnames,
  hostMatches,
  isAllowedNavigation,
  isInternalUrl,
  joinPath,
  HTTPS_PREFER_PORTS
};
