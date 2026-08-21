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
    } catch (err) {
      showError(hkError, err?.message || '加载设置失败');
    }
  })();
})();
