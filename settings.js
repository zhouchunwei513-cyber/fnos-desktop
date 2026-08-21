/* global fnosSettings */
// 设置页：启动密码 + 快捷键自定义
(() => {
  const $ = (id) => document.getElementById(id);

  const pwdForm = $('pwd-form');
  const oldPwd = $('old-pwd');
  const newPwd = $('new-pwd');
  const confirmPwd = $('confirm-pwd');
  const pwdError = $('pwd-error');
  const pwdStatus = $('pwd-status');
  const pwdCancel = $('pwd-cancel');

  const hkLock = $('hk-lock');
  const hkHide = $('hk-hide');
  const hkError = $('hk-error');
  const hkSave = $('hk-save');
  const hkReset = $('hk-reset');
  const btnClose = $('btn-close');

  const versionLine = $('version-line');
  const aboutVersion = $('about-version');

  const DEFAULTS = { lockApp: 'Ctrl+Alt+L', hideAll: 'Ctrl+Alt+H' };

  function showError(el, msg) {
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg; el.hidden = false;
  }

  function setPwdStatus(has) {
    if (has) {
      pwdStatus.classList.remove('off');
      pwdStatus.innerHTML = '<span class="dot-ok"></span><span>当前已设置启动密码</span>';
      oldPwd.placeholder = '当前密码';
      $('old-wrap').style.display = '';
    } else {
      pwdStatus.classList.add('off');
      pwdStatus.innerHTML = '<span class="dot-ok"></span><span>当前未设置启动密码</span>';
      oldPwd.placeholder = '当前未设置，留空即可';
      $('old-wrap').style.display = 'none';
    }
  }

  // --------- 快捷键捕获 ---------
  const SPECIAL = {
    Control: 'Ctrl', Meta: 'Meta', Command: 'Command', Alt: 'Alt', Shift: 'Shift',
  };
  const NICE_KEY = {
    ' ': 'Space', '+': 'Plus', '-': 'Minus', ',': 'Comma', '.': 'Period',
    '/': 'Slash', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
    '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };

  function eventToAccelerator(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    let key = e.key;
    if (!key) return '';
    if (SPECIAL[key]) return ''; // 单独按修饰键不完成
    if (/^F\d{1,2}$/.test(key)) {
      parts.push(key);
    } else if (/^[a-zA-Z]$/.test(key)) {
      parts.push(key.toUpperCase());
    } else if (/^[0-9]$/.test(key)) {
      parts.push(key);
    } else if (NICE_KEY[key]) {
      parts.push(NICE_KEY[key]);
    } else {
      return '';
    }
    return parts.join('+');
  }

  function bindHotkeyInput(input) {
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { input.blur(); input.classList.remove('recording'); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        input.value = '';
        input.classList.remove('recording');
        return;
      }
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        // 必须带修饰键（避免和网页输入冲突）
        return;
      }
      const acc = eventToAccelerator(e);
      if (acc) {
        input.value = acc;
        input.classList.remove('recording');
        showError(hkError, '');
      }
    });
    input.addEventListener('focus', () => {
      input.classList.add('recording');
      input.placeholder = '按下组合键（Esc 取消）';
    });
    input.addEventListener('blur', () => {
      input.classList.remove('recording');
      input.placeholder = '点击此处并按下组合键';
    });
    input.addEventListener('click', () => input.focus());
  }

  bindHotkeyInput(hkLock);
  bindHotkeyInput(hkHide);

  document.querySelectorAll('.hotkey-clear').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = $(btn.dataset.target);
      if (t) t.value = '';
      showError(hkError, '');
    });
  });

  // --------- 密码保存 ---------
  pwdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldV = oldPwd.value || '';
    const newV = newPwd.value || '';
    const confirmV = confirmPwd.value || '';
    if (newV && newV.length < 4) { showError(pwdError, '新密码至少 4 位'); return; }
    if (newV !== confirmV) { showError(pwdError, '两次输入的新密码不一致'); return; }
    showError(pwdError, '');
    const btn = $('pwd-save');
    btn.disabled = true; btn.textContent = '保 存 中';
    try {
      const res = await fnosSettings.setPassword({ oldPassword: oldV, newPassword: newV });
      if (res && res.ok) {
        oldPwd.value = newPwd.value = confirmPwd.value = '';
        const info = await fnosSettings.getSettings();
        setPwdStatus(!!info?.hasPassword);
        btn.textContent = '已 保 存';
        setTimeout(() => { btn.textContent = '保存密码'; }, 1400);
      } else {
        showError(pwdError, (res && res.error) || '保存失败');
      }
    } catch (err) {
      showError(pwdError, err?.message || '保存失败');
    } finally {
      btn.disabled = false;
      if (btn.textContent === '保 存 中') btn.textContent = '保存密码';
    }
  });

  pwdCancel.addEventListener('click', () => {
    oldPwd.value = newPwd.value = confirmPwd.value = '';
    showError(pwdError, '');
  });

  // --------- 快捷键保存 ---------
  hkSave.addEventListener('click', async () => {
    const lockAcc = (hkLock.value || '').trim();
    const hideAcc = (hkHide.value || '').trim();
    if (lockAcc && hideAcc && lockAcc === hideAcc) {
      showError(hkError, '两个快捷键不能相同'); return;
    }
    showError(hkError, '');
    hkSave.disabled = true; hkSave.textContent = '保 存 中';
    try {
      const res = await fnosSettings.setShortcuts({ lockApp: lockAcc, hideAll: hideAcc });
      if (res && res.ok) {
        hkSave.textContent = '已 保 存';
        setTimeout(() => { hkSave.textContent = '保存快捷键'; }, 1400);
      } else {
        showError(hkError, (res && res.error) || '保存失败');
      }
    } catch (err) {
      showError(hkError, err?.message || '保存失败');
    } finally {
      hkSave.disabled = false;
      if (hkSave.textContent === '保 存 中') hkSave.textContent = '保存快捷键';
    }
  });

  hkReset.addEventListener('click', () => {
    hkLock.value = DEFAULTS.lockApp;
    hkHide.value = DEFAULTS.hideAll;
    showError(hkError, '');
  });

  // --------- URL 重写 ---------
  const rwList = document.getElementById('rewrite-list');
  const rwAdd = document.getElementById('rw-add');
  const rwSave = document.getElementById('rw-save');
  const rwError = document.getElementById('rw-error');
  const rwTpl = (m = '', r = '') => {
    const row = document.createElement('div');
    row.className = 'rewrite-row';
    row.innerHTML = `
      <div class="input-wrap glass-input"><input class="rw-match" placeholder="内网端口或路径，例如 5667 或 /movie/" value="${m.replace(/"/g,'&quot;')}" spellcheck="false"/></div>
      <div class="rewrite-arrow">→</div>
      <div class="input-wrap glass-input"><input class="rw-replace" placeholder="外网完整地址，例如 https://nas.example.com:5667/" value="${r.replace(/"/g,'&quot;')}" spellcheck="false"/></div>
      <button type="button" class="rewrite-del" title="删除">×</button>`;
    row.querySelector('.rewrite-del').addEventListener('click', () => row.remove());
    rwList.appendChild(row);
  };
  rwAdd.addEventListener('click', () => rwTpl());
  rwSave.addEventListener('click', async () => {
    const rows = [...rwList.querySelectorAll('.rewrite-row')];
    const list = [];
    for (const row of rows) {
      const m = row.querySelector('.rw-match').value.trim();
      const r = row.querySelector('.rw-replace').value.trim();
      if (!m && !r) continue;
      if (!m || !r) { showError(rwError, '规则的左右两侧都要填'); return; }
      try { new URL(r); } catch { showError(rwError, `右侧不是有效的完整地址：${r}`); return; }
      list.push({ match: m, replace: r });
    }
    rwSave.disabled = true; rwSave.textContent = '保 存 中';
    try {
      const res = await fnosSettings.setUrlRewrites(list);
      if (res && res.ok) {
        rwSave.textContent = '已 保 存';
        setTimeout(() => { rwSave.textContent = '保存规则'; }, 1400);
      } else {
        showError(rwError, (res && res.error) || '保存失败');
      }
    } catch (err) {
      showError(rwError, err?.message || '保存失败');
    } finally {
      rwSave.disabled = false;
      if (rwSave.textContent === '保 存 中') rwSave.textContent = '保存规则';
    }
  });

  // --------- 界面开关 ---------
  const optAutohide = document.getElementById('opt-autohide');
  const optSave = document.getElementById('opt-save');
  optSave.addEventListener('click', async () => {
    optSave.disabled = true; optSave.textContent = '保 存 中';
    try {
      const res = await fnosSettings.setUIOptions({ autoHideMenuBar: !!optAutohide.checked });
      if (res && res.ok) {
        optSave.textContent = '已 保 存（重启后完全生效）';
        setTimeout(() => { optSave.textContent = '保存界面设置'; }, 1800);
      }
    } finally {
      optSave.disabled = false;
      if (optSave.textContent === '保 存 中') optSave.textContent = '保存界面设置';
    }
  });

  // --------- 玻璃标题栏 ---------
  const optGlassTitle = document.getElementById('opt-glass-title');
  if (optGlassTitle) {
    optGlassTitle.addEventListener('change', async () => {
      try {
        await fnosSettings.setUIOptions({ glassTitleBar: !!optGlassTitle.checked });
      } catch {}
    });
  }

  // --------- 主题色 ---------
  const accentDot = document.getElementById('accent-dot');
  if (accentDot) {
    accentDot.addEventListener('input', async () => {
      await fnosSettings.setAccentColor(accentDot.value);
    });
  }

  btnClose.addEventListener('click', () => fnosSettings.close());

  // F5/Esc/右键阻断
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) e.preventDefault();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // 初始化
  (async () => {
    try {
      const info = await fnosSettings.getSettings();
      versionLine.textContent = `v${info?.version || ''}`;
      aboutVersion.textContent = `v${info?.version || ''}`;
      setPwdStatus(!!info?.hasPassword);
      hkLock.value = info?.shortcuts?.lockApp || '';
      hkHide.value = info?.shortcuts?.hideAll || '';
      const rewrites = info?.urlRewrites || [];
      if (rewrites.length === 0) rwTpl();
      else rewrites.forEach((r) => rwTpl(r.match || '', r.replace || ''));
      optAutohide.checked = !!info?.autoHideMenuBar;
    } catch (err) {
      showError(hkError, err?.message || '加载设置失败');
    }
  })();
})();
