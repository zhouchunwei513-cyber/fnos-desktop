'use strict';

/**
 * 检查更新（macOS）
 *
 * 说明：macOS 自动更新依赖 Squirrel.Mac + 代码签名，未签名/未公证的应用无法静默安装。
 * 因此这里采用「检查 + 引导下载」模式，与 Windows 版的检查更新功能对齐：
 *   1. 读 GitHub Releases（只认 tag 前缀 mac-v 的发布）
 *   2. 比对版本，有新版则在原生对话框里展示更新说明
 *   3. 用户确认后打开浏览器下载 dmg / zip，由用户拖入"应用程序"完成升级
 */

const path = require('path');
const { app, net, shell, dialog, BrowserWindow } = require('electron');
const store = require('./store');
const logger = require('./logger');

const TAG_PREFIX = 'mac-v';

function repoInfo() {
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    const r = pkg.repository || {};
    let url = typeof r === 'string' ? r : (r.url || '');
    url = String(url).replace(/^git\+/, '').replace(/\.git$/, '');
    const m = url.match(/github\.com[/:]([^/]+)\/([^/?#]+)/i);
    if (m) return { owner: m[1], repo: m[2] };
  } catch (_) {}
  return null;
}

function parseVersion(v) {
  const s = String(v || '').replace(/^mac-v|^v/i, '').trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  if (x.major !== y.major) return x.major > y.major ? 1 : -1;
  if (x.minor !== y.minor) return x.minor > y.minor ? 1 : -1;
  if (x.patch !== y.patch) return x.patch > y.patch ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

function apiGet(url) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: 'follow' });
    } catch (e) {
      reject(e);
      return;
    }
    req.setHeader('User-Agent', 'FNOS-mac/' + app.getVersion());
    req.setHeader('Accept', 'application/vnd.github+json');
    const chunks = [];
    let status = 0;
    req.on('response', (res) => {
      status = res.statusCode;
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (status >= 200 && status < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad json')); }
        } else {
          reject(new Error('HTTP ' + status));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function pickMacAsset(release) {
  const assets = (release && release.assets) || [];
  // 优先 dmg，其次 arm64 zip
  const dmg = assets.find((a) => /\.dmg$/i.test(a.name) && /arm64/i.test(a.name));
  const anyDmg = assets.find((a) => /\.dmg$/i.test(a.name));
  const zip = assets.find((a) => /\.zip$/i.test(a.name));
  const hit = dmg || anyDmg || zip;
  if (hit) return { name: hit.name, url: hit.browser_download_url, size: hit.size };
  return null;
}

function isMacRelease(rel) {
  if (!rel || rel.draft) return false;
  const tag = String(rel.tag_name || '');
  if (!tag.toLowerCase().startsWith(TAG_PREFIX)) return false;
  return !!parseVersion(tag);
}

async function fetchLatest() {
  const info = repoInfo();
  if (!info) throw new Error('未配置仓库地址');
  const rels = await apiGet('https://api.github.com/repos/' + info.owner + '/' + info.repo + '/releases?per_page=50');
  if (!Array.isArray(rels)) throw new Error('响应异常');
  const macs = rels.filter(isMacRelease);
  if (!macs.length) return null;
  macs.sort((a, b) => compareVersion(b.tag_name, a.tag_name));
  const top = macs[0];
  const asset = pickMacAsset(top);
  return {
    tag: top.tag_name,
    version: String(top.tag_name).replace(/^mac-v/i, ''),
    name: top.name || top.tag_name,
    notes: (top.body || '').slice(0, 1500),
    publishedAt: top.published_at,
    htmlUrl: top.html_url,
    asset
  };
}

function anchorWindow() {
  const { getMainWindow, getSettingsWindow } = require('./windows');
  return getSettingsWindow() || getMainWindow() || null;
}

async function check(opts) {
  const options = opts || {};
  const silent = !!options.silent;
  const current = app.getVersion();
  let latest = null;
  try {
    latest = await fetchLatest();
  } catch (e) {
    logger.warn('update', 'check failed: ' + (e && e.message));
    if (!silent) {
      await dialog.showMessageBox(anchorWindow(), {
        type: 'warning',
        message: '无法检查更新',
        detail: '请确认网络可以访问 GitHub。\n' + (e && e.message ? e.message : ''),
        buttons: ['好'],
        defaultId: 0
      });
    }
    return { ok: false, error: String(e && e.message) };
  }

  store.set('update.lastCheckAt', Date.now());

  if (!latest) {
    if (!silent) {
      await dialog.showMessageBox(anchorWindow(), {
        type: 'info',
        message: '暂时没有可用的 macOS 版本',
        detail: '当前版本 ' + current + '。仓库中还没有发布 mac 版本。',
        buttons: ['好'],
        defaultId: 0
      });
    }
    return { ok: true, hasUpdate: false, latest: null };
  }

  const cmp = compareVersion(latest.version, current);
  if (cmp <= 0) {
    if (!silent) {
      await dialog.showMessageBox(anchorWindow(), {
        type: 'info',
        message: '已是最新版本',
        detail: '当前版本 ' + current + '（最新 ' + latest.version + '）',
        buttons: ['好'],
        defaultId: 0
      });
    }
    return { ok: true, hasUpdate: false, latest };
  }

  const skip = store.get().update.skipVersion;
  if (silent && skip && skip === latest.version) {
    return { ok: true, hasUpdate: true, skipped: true, latest };
  }

  const detailLines = [];
  detailLines.push('当前版本：' + current);
  detailLines.push('最新版本：' + latest.version + '（' + latest.tag + '）');
  if (latest.asset) detailLines.push('安装包：' + latest.asset.name);
  detailLines.push('');
  detailLines.push('更新说明：');
  detailLines.push(latest.notes || '（无）');
  detailLines.push('');
  detailLines.push('macOS 版为免签名分发：下载 dmg 后拖入"应用程序"覆盖旧版即可；若提示"已损坏"，请在终端执行 xattr -dr com.apple.quarantine /Applications/FNOS.app');

  const { response } = await dialog.showMessageBox(anchorWindow(), {
    type: 'info',
    message: '发现新版本 ' + latest.version,
    detail: detailLines.join('\n'),
    buttons: ['立即下载', '稍后提醒', '跳过此版本'],
    defaultId: 0,
    cancelId: 1
  });

  if (response === 0) {
    const target = (latest.asset && latest.asset.url) || latest.htmlUrl;
    if (target) shell.openExternal(target).catch(() => {});
  } else if (response === 2) {
    store.set('update.skipVersion', latest.version);
  }

  return { ok: true, hasUpdate: true, latest };
}

function scheduleDailyCheck() {
  // 启动后 8 秒检查一次（静默）；此后每 12 小时一次
  setTimeout(() => { check({ silent: true }).catch(() => {}); }, 8000);
  setInterval(() => { check({ silent: true }).catch(() => {}); }, 12 * 3600 * 1000);
}

module.exports = { check, fetchLatest, compareVersion, parseVersion, repoInfo, scheduleDailyCheck };
