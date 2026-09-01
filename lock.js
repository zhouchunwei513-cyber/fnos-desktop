/* global fnosLock */
// 锁屏页面：解锁 / 首次设置 / 修改密码
// v1.10.4: 启动锁定时只显示密码输入框 + 解锁按钮
(() => {
  const $ = (id) => document.getElementById(id);

  const unlockForm = $('unlock-form');
  const setupForm = $('setup-form');
  const unlockPwd = $('unlock-pwd');
  const oldPwd = $('old-pwd');
  const newPwd = $('new-pwd');
  const confirmPwd = $('confirm-pwd');
  const unlockError = $('unlock-error');
  const setupError = $('setup-error');
  const togglePwd = $('toggle-pwd');
  const setupTitle = $('setup-title');
  const cancelBtn = $('setup-cancel');
  let initialMode = 'unlock';

  function showError(el, msg) {
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg; el.hidden = false;
  }

  function showUnlock(mode /* 'unlock' | 'setup' | 'change' */) {
    if (mode === 'setup') {
      // 首次设置
      if (setupTitle) setupTitle.textContent = '设置启动密码';
      unlockForm.hidden = true;
      setupForm.hidden = false;
      oldPwd.parentElement.style.display = 'none';
      setTimeout(() => newPwd.focus(), 50);
    } else if (mode === 'change') {
      if (setupTitle) setupTitle.textContent = '修改启动密码';
      unlockForm.hidden = true;
      setupForm.hidden = false;
      oldPwd.parentElement.style.display = '';
      setTimeout(() => oldPwd.focus(), 50);
    } else {
      // 极简锁屏：只显示密码输入框 + 解锁按钮
      unlockForm.hidden = false;
      setupForm.hidden = true;
      setTimeout(() => unlockPwd.focus(), 50);
    }
  }

  function showPwdVisible(visible) {
    [unlockPwd, oldPwd, newPwd, confirmPwd].forEach((el) => {
      if (el) el.type = visible ? 'text' : 'password';
    });
  }

  let pwdVisible = false;
  togglePwd?.addEventListener('click', () => {
    pwdVisible = !pwdVisible;
    showPwdVisible(pwdVisible);
  });

  unlockForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = unlockPwd.value || '';
    if (!pwd) { showError(unlockError, '请输入启动密码'); return; }
    showError(unlockError, '');
    const btn = $('unlock-btn');
    if (btn) { btn.disabled = true; btn.querySelector('.btn-label').textContent = '验 证 中'; }
    try {
      const res = await fnosLock.verify(pwd);
      if (res && res.ok) {
        // 主进程会关闭锁屏窗口并恢复界面
        return;
      }
      showError(unlockError, (res && res.error) || '密码不正确');
      unlockPwd.select();
    } catch (err) {
      showError(unlockError, err?.message || '验证失败，请重试');
    } finally {
      if (btn) { btn.disabled = false; btn.querySelector('.btn-label').textContent = '解 锁'; }
    }
  });

  setupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldV = oldPwd.value || '';
    const newV = newPwd.value || '';
    const confirmV = confirmPwd.value || '';

    if (newV.length > 0 && newV.length < 4) {
      showError(setupError, '新密码至少 4 位'); return;
    }
    if (newV !== confirmV) {
      showError(setupError, '两次输入的新密码不一致'); return;
    }
    showError(setupError, '');
    try {
      const res = await fnosLock.setPassword({ oldPassword: oldV, newPassword: newV });
      if (res && res.ok) {
        // 设置成功
        if (newV === '') {
          // 已取消密码 —— 若处于锁屏态，直接解锁
          if (initialMode === 'change' || initialMode === 'unlock') {
            try { await fnosLock.verify(''); } catch (_) {}
            return;
          }
        }
        if (initialMode === 'setup' || initialMode === 'change') {
          if (newV) {
            showUnlock('unlock');
            unlockPwd.value = '';
          }
        } else {
          showUnlock('unlock');
          unlockPwd.value = '';
        }
      } else {
        showError(setupError, (res && res.error) || '保存失败');
      }
    } catch (err) {
      showError(setupError, err?.message || '保存失败');
    }
  });

  cancelBtn?.addEventListener('click', async () => {
    // 取消修改密码：回到解锁页
    setupForm.hidden = true; unlockForm.hidden = false;
    oldPwd.value = newPwd.value = confirmPwd.value = '';
    showError(setupError, '');
    setTimeout(() => unlockPwd.focus(), 30);
  });

  // 阻止拖拽 / F5 / 右键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) e.preventDefault();
    if (e.key === 'Escape') e.preventDefault();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // 初始化
  (async () => {
    try {
      const info = await fnosLock.getInfo();
      initialMode = info?.mode || 'unlock';
      showUnlock(initialMode);
    } catch (err) {
      showUnlock('unlock');
    }
  })();
})();
