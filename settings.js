/* global fnosSettings */
// 设置页：启动密码 + 快捷键自定义
(() => {
  const $ = (id) => document.getElementById(id);

  // 玻璃自定义下拉：统一处理 open/选中/取值，并暴露 value/disable 兼容旧调用
  function bindGlassSelect(el, onChange) {
    if (!el) return null;
    const valueEl = el.querySelector('.glass-select-value');
    const options = Array.from(el.querySelectorAll('.glass-select-option'));
    const api = {
      get value() { return el.getAttribute('data-value') || ''; },
      set value(v) {
        const val = String(v);
        el.setAttribute('data-value', val);
        const opt = options.find((o) => o.getAttribute('data-value') === val);
        if (valueEl) valueEl.textContent = opt ? opt.textContent : (options[0]?.textContent || '');
        options.forEach((o) => o.classList.toggle('selected', o.getAttribute('data-value') === val));
      },
      set disabled(v) {
        if (v) { el.setAttribute('aria-disabled', 'true'); el.style.opacity = '.5'; el.style.pointerEvents = 'none'; }
        else { el.removeAttribute('aria-disabled'); el.style.opacity = ''; el.style.pointerEvents = ''; }
      },
      addEventListener(_type, fn) { el._changeFn = fn; },
    };
    options.forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        api.value = opt.getAttribute('data-value');
        el.classList.remove('open');
        if (typeof el._changeFn === 'function') el._changeFn({ target: api });
        if (typeof onChange === 'function') onChange(api.value);
      });
    });
    const toggle = (e) => {
      if (el.getAttribute('aria-disabled') === 'true') return;
      e.stopPropagation();
      document.querySelectorAll('.glass-select.open').forEach((s) => { if (s !== el) s.classList.remove('open'); });
      el.classList.toggle('open');
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
      else if (e.key === 'Escape') el.classList.remove('open');
    });
    document.addEventListener('click', () => el.classList.remove('open'));
    api.value = el.getAttribute('data-value') || options[0]?.getAttribute('data-value') || '';
    return api;
  }

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

  // v1.16.1：无操作自动锁定
  const autoLockSel = bindGlassSelect(document.querySelector('[data-select="auto-lock"]'));
  const autoLockHint = $('auto-lock-hint');

  const DEFAULTS = { lockApp: 'Ctrl+Alt+L', hideAll: 'Ctrl+Alt+H' };

  function updateAutoLockHint(hasPwd, mins) {
    if (!autoLockHint) return;
    if (!hasPwd) {
      autoLockHint.textContent = '请先设置启动密码后再开启自动锁定。';
      autoLockSel && (autoLockSel.disabled = true);
      return;
    }
    autoLockSel && (autoLockSel.disabled = false);
    if (!mins || mins <= 0) {
      autoLockHint.textContent = '已关闭。';
    } else {
      autoLockHint.textContent = `已开启：键鼠无操作 ${mins} 分钟后自动锁定，恢复时需输入启动密码。`;
    }
  }

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
        if (autoLockSel) updateAutoLockHint(!!info?.hasPassword, Number(autoLockSel.value) || 0);
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

  // --------- 主题色 ---------
  const accentDot = document.getElementById('accent-dot');
  if (accentDot) {
    accentDot.addEventListener('input', async () => {
      await fnosSettings.setAccentColor(accentDot.value);
    });
  }

  btnClose.addEventListener('click', () => fnosSettings.close());

  // --------- 直播与播放（v1.18.0：本地代理与外部播放器路径已移除） ---------
  const iptvBaseUrl = document.getElementById('iptv-baseurl');
  const iptvLine = bindGlassSelect(document.querySelector('[data-select="iptv-line"]'));
  const iptvEpgUrl = document.getElementById('iptv-epgurl');
  const iptvCacheSeconds = document.getElementById('iptv-cacheseconds');
  const iptvSave = document.getElementById('iptv-save');
  const iptvError = document.getElementById('iptv-error');

  async function loadLiveConfig() {
    try {
      const info = await fnosSettings.getSettings();
      if (iptvBaseUrl) iptvBaseUrl.value = info?.iptv?.iptvBaseUrl || '';
      if (iptvLine) iptvLine.value = info?.iptv?.iptvLine || 'inner';
      if (iptvEpgUrl) iptvEpgUrl.value = info?.iptv?.iptvEpgUrl || '';
      if (iptvCacheSeconds) iptvCacheSeconds.value = info?.iptv?.iptvCacheSeconds != null ? info.iptv.iptvCacheSeconds : 30;
    } catch (err) {
      showError(iptvError, err?.message || '加载直播设置失败');
    }
  }

  if (iptvSave) {
    iptvSave.addEventListener('click', async () => {
      iptvSave.disabled = true;
      iptvSave.textContent = '保 存 中';
      showError(iptvError, '');
      try {
        // v1.23.0：保存基地址、线路、EPG 地址、缓冲秒数
        await fnosSettings.iptvSetConfig({
          iptvBaseUrl: iptvBaseUrl ? iptvBaseUrl.value.trim() : '',
          iptvLine: iptvLine ? iptvLine.value : 'inner',
          iptvEpgUrl: iptvEpgUrl ? iptvEpgUrl.value.trim() : '',
          iptvCacheSeconds: iptvCacheSeconds ? Number(iptvCacheSeconds.value) || 0 : 30,
        });
        iptvSave.textContent = '已 保 存';
        setTimeout(() => { iptvSave.textContent = '保存直播设置'; }, 1400);
      } catch (err) {
        showError(iptvError, err?.message || '保存失败');
      } finally {
        iptvSave.disabled = false;
        if (iptvSave.textContent === '保 存 中') iptvSave.textContent = '保存直播设置';
      }
    });
  }

  // --------- 兼容性播放器（MPV）v1.25.0 ---------
  const vlcEnabled = document.getElementById('vlc-enabled');
  const vlcEnabledLabel = document.getElementById('vlc-enabled-label');
  const vlcHw = bindGlassSelect(document.querySelector('[data-select="vlc-hw"]'));
  const vlcCache = bindGlassSelect(document.querySelector('[data-select="vlc-cache"]'));
  const vlcSave = document.getElementById('vlc-save');
  const vlcError = document.getElementById('vlc-error');
  const vlcRuntime = document.getElementById('vlc-runtime');

  function refreshVlcRuntime() {
    if (!vlcRuntime) return;
    try {
      fnosSettings.vlcRuntime().then((rt) => {
        try {
          const hwLabel = { auto: '自动', d3d11va: 'D3D11VA', dxva2: 'DXVA2', no: '软解' }[rt.hwDecode] || rt.hwDecode;
          const cacheLabel = { standard: '均衡 32MB/60s', smooth: '流畅 128MB/120s', unlimited: '超大 512MB/300s' }[rt.cacheLevel] || rt.cacheLevel;
          let html = '';
          if (rt.available) {
            html = '<div style="color:#4ade80">● MPV 播放器已就绪，应用内嵌入播放</div>' +
              '<div style="opacity:.8;margin-top:4px">网页遇到 HEVC/10bit/4K/MKV 等无法解码的视频时，将自动在视频区调用 MPV 直接播放（无需跳出窗口）。</div>';
          } else {
            html = '<div style="color:#f87171">● MPV 播放器不可用：' + (rt.reason || '未知原因') + '</div>' +
              '<div style="opacity:.8;margin-top:4px">特殊编码视频仍只能依赖网页内核，可能无法播放。</div>';
          }
          html += '<div style="margin-top:6px;opacity:.85">硬件解码：' + hwLabel + ' ｜ 网络缓存：' + cacheLabel + '</div>';
          vlcRuntime.innerHTML = html;
        } catch (_) {}
      }).catch(() => { if (vlcRuntime) vlcRuntime.textContent = 'MPV 状态检测失败'; });
    } catch (_) {}
  }

  async function loadVlcConfig() {
    try {
      const info = await fnosSettings.getSettings();
      const v = info?.mpv || info?.vlc || {};
      if (vlcEnabled) {
        vlcEnabled.checked = v.enabled !== false;
        if (vlcEnabledLabel) vlcEnabledLabel.textContent = vlcEnabled.checked ? '已启用' : '已关闭';
      }
      if (vlcHw) vlcHw.value = v.hwDecode || 'auto';
      if (vlcCache) vlcCache.value = v.cacheLevel || 'smooth';
      refreshVlcRuntime();
    } catch (err) {
      showError(vlcError, err?.message || '加载播放器设置失败');
    }
  }

  if (vlcEnabled) {
    vlcEnabled.addEventListener('change', () => {
      if (vlcEnabledLabel) vlcEnabledLabel.textContent = vlcEnabled.checked ? '已启用' : '已关闭';
    });
  }

  if (vlcSave) {
    vlcSave.addEventListener('click', async () => {
      vlcSave.disabled = true;
      vlcSave.textContent = '保 存 中';
      showError(vlcError, '');
      try {
        const res = await fnosSettings.setVlc({
          enabled: vlcEnabled ? !!vlcEnabled.checked : true,
          hwDecode: vlcHw ? vlcHw.value : 'auto',
          cacheLevel: vlcCache ? vlcCache.value : 'smooth',
        });
        if (res && res.ok) {
          vlcSave.textContent = '已保存';
          refreshVlcRuntime();
          setTimeout(() => { vlcSave.textContent = '保存播放器设置'; }, 1800);
        } else {
          showError(vlcError, (res && res.error) || '保存失败');
        }
      } catch (err) {
        showError(vlcError, err?.message || '保存失败');
      } finally {
        vlcSave.disabled = false;
      }
    });
  }

  // --------- 自动锁定时长（v1.16.1） ---------
  if (autoLockSel) {
    autoLockSel.addEventListener('change', async () => {
      try {
        const mins = Number(autoLockSel.value) || 0;
        const res = await fnosSettings.setAutoLock(mins);
        if (res && res.ok) {
          updateAutoLockHint(true, mins);
        } else {
          if (autoLockHint) autoLockHint.textContent = (res && res.error) || '保存失败';
        }
      } catch (err) {
        if (autoLockHint) autoLockHint.textContent = err?.message || '保存失败';
      }
    });
  }

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
      setPwdStatus(!!info?.hasPassword);
      hkLock.value = info?.shortcuts?.lockApp || '';
      hkHide.value = info?.shortcuts?.hideAll || '';
      const rewrites = info?.urlRewrites || [];
      if (rewrites.length === 0) rwTpl();
      else rewrites.forEach((r) => rwTpl(r.match || '', r.replace || ''));
      optAutohide.checked = !!info?.autoHideMenuBar;
      if (autoLockSel) {
        const mins = Number(info?.autoLockMinutes) || 0;
        autoLockSel.value = String(mins);
        updateAutoLockHint(!!info?.hasPassword, mins);
      }
      loadLiveConfig();
      loadVlcConfig();
    } catch (err) {
      showError(hkError, err?.message || '加载设置失败');
    }
  })();
})();
