'use strict';

const input = document.getElementById('server-input');
const form = document.getElementById('login-form');
const connectBtn = document.getElementById('connect-btn');
const errorBox = document.getElementById('error');
const dropdown = document.getElementById('dropdown');
const dropdownBtn = document.getElementById('dropdown-btn');

const API = window.fnos;

let state = {
  history: [],
  server: '',
  origin: '',
  activeIndex: -1,
  open: false
};

function showError(msg) {
  if (!errorBox) return;
  if (!msg) { errorBox.textContent = ''; errorBox.classList.remove('show'); return; }
  errorBox.textContent = String(msg);
  errorBox.classList.add('show');
}

function setLoading(loading) {
  if (!connectBtn) return;
  connectBtn.disabled = !!loading;
  connectBtn.innerHTML = loading
    ? '<span class="spinner" aria-label="连接中"></span>'
    : '<span class="btn-label">登 录</span>';
}

function displayValue(h) {
  if (!h) return '';
  if (h.serverInput) return h.serverInput;
  if (h.isFnId && h.fnId) return h.fnId;
  if (h.label) {
    // label 可能形如 "FN ID: abc"
    if (h.label.startsWith('FN ID:')) return h.label.replace(/^FN ID:\s*/i, '');
    return h.label;
  }
  return h.origin || '';
}

function findActiveIndex() {
  const cur = (input.value || '').trim().toLowerCase();
  if (!cur) return -1;
  return state.history.findIndex((h) => {
    const candidates = [
      (h.serverInput || ''),
      (h.label || ''),
      (h.fnId || ''),
      (h.origin || ''),
      (h.href || ''),
    ].map((s) => String(s).toLowerCase());
    return candidates.some((v) => v === cur || v.startsWith(cur));
  });
}

function iconFor(h) {
  if (h.isFnId) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 14.8 7.2 16.9l.9-5.4L4.2 7.7l5.4-.8z"/></svg>';
  }
  const isDomain = (h.origin || '').replace(/^https?:\/\//, '').split('/')[0];
  const host = isDomain || '';
  const looksLikeIp = /^(\d{1,3}\.){3}\d{1,3}/.test(host) || host === 'localhost';
  if (!looksLikeIp) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M7 7h.01M10 7h.01"/></svg>';
}

function typeLabel(h) {
  if (h.isFnId) return 'FN ID · 远程访问';
  return h.origin || '';
}

function renderDropdown() {
  if (!dropdown) return;
  const items = (state.history || []).slice(0, 8);
  if (!items.length) { dropdown.hidden = true; dropdown.innerHTML = ''; state.open = false; return; }
  const idx = findActiveIndex();
  state.activeIndex = idx;
  dropdown.innerHTML = items.map((h, i) => {
    const active = i === idx ? 'active' : '';
    const value = displayValue(h);
    const sub = typeLabel(h);
    return `<div class="dd-item ${active}" data-partition="${escapeHtml(h.partition || '')}" data-index="${i}">
      <span class="icon">${iconFor(h)}</span>
      <span class="meta">
        <span class="title">${escapeHtml(value)}</span>
        <span class="sub">${escapeHtml(sub)}</span>
      </span>
      <button type="button" class="del" data-del="${escapeHtml(h.partition || '')}" aria-label="删除此历史" title="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button>
    </div>`;
  }).join('');
  dropdown.hidden = false;
  state.open = true;
}

function hideDropdown() {
  if (dropdown) { dropdown.hidden = true; dropdown.innerHTML = ''; }
  state.open = false;
  state.activeIndex = -1;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function fillFromHistory(item) {
  if (!item) return;
  input.value = displayValue(item);
  hideDropdown();
  input.focus();
  input.select();
}

async function removeHistory(partition) {
  try {
    const res = await API.removeHistory(partition);
    if (res && res.ok && Array.isArray(res.history)) {
      state.history = res.history;
      if (state.open) renderDropdown();
    }
  } catch (_) {}
}

dropdown && dropdown.addEventListener('mousedown', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.preventDefault();
    e.stopPropagation();
    removeHistory(del.getAttribute('data-del'));
    return;
  }
  const item = e.target.closest('.dd-item');
  if (item) {
    e.preventDefault();
    const i = parseInt(item.getAttribute('data-index'), 10);
    if (!Number.isNaN(i) && state.history[i]) fillFromHistory(state.history[i]);
  }
});

dropdownBtn && dropdownBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (state.open) hideDropdown();
  else { renderDropdown(); input.focus(); }
});

input && input.addEventListener('focus', () => {
  showError('');
  if (state.history.length) renderDropdown();
});
input && input.addEventListener('input', () => {
  showError('');
  if (state.history.length) renderDropdown(); else hideDropdown();
});
input && input.addEventListener('blur', () => {
  setTimeout(() => hideDropdown(), 160);
});
input && input.addEventListener('keydown', (e) => {
  if (!state.open) return;
  if (e.key === 'Escape') { hideDropdown(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const list = state.history.slice(0, 8);
    if (!list.length) return;
    state.activeIndex = (state.activeIndex + 1) % list.length;
    const it = list[state.activeIndex];
    if (it) input.value = displayValue(it);
    renderDropdown();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const list = state.history.slice(0, 8);
    if (!list.length) return;
    state.activeIndex = state.activeIndex <= 0 ? list.length - 1 : state.activeIndex - 1;
    const it = list[state.activeIndex];
    if (it) input.value = displayValue(it);
    renderDropdown();
  } else if (e.key === 'Enter') {
    if (state.activeIndex >= 0 && state.history[state.activeIndex]) {
      e.preventDefault();
      fillFromHistory(state.history[state.activeIndex]);
      // 立即提交
      handleSubmit(e);
    }
  }
});

async function handleSubmit(e) {
  if (e) e.preventDefault();
  const server = (input.value || '').trim();
  if (!server) { showError('请输入服务器地址或 FN ID'); input.focus(); return; }
  setLoading(true);
  showError('');
  try {
    const res = await API.connect(server);
    if (!res || !res.ok) {
      setLoading(false);
      showError((res && res.error) || '连接失败，请检查地址');
    }
    // 成功时主进程会切换页面，loading 保留也没关系
  } catch (err) {
    setLoading(false);
    showError(err && err.message ? err.message : '连接失败，请稍后重试');
  }
}

form && form.addEventListener('submit', handleSubmit);

async function init() {
  try {
    const data = await API.loadLastServer();
    if (data) {
      state.server = data.server || '';
      state.origin = data.origin || '';
      state.history = Array.isArray(data.history) ? data.history : [];
      if (state.server) input.value = state.server;
    }
  } catch (_) {}
  input.focus();
  input.select();
}

init();
