/* global fnosSettings */
// 设置页：启动密码 + 快捷键自定义
(() => {
  const $ = (id) => document.getElementById(id);
  const clampInt = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  };

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

  // v2.0.0：开机自启动 DOM
  const autostartToggle = $('autostart-toggle');
  const autostartText = $('autostart-text');
  const autostartHint = $('autostart-hint');

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

  // v2.1.11：快捷方式打开应用后主程序后台化方式
  const shortcutHideSel = bindGlassSelect(document.querySelector('[data-select="shortcut-hide-mode"]'));

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
  // v1.69.0：完整 HTML 转义（原实现只转义双引号，地址含 & < > 等字符时会把
  // value 属性截断/渲染错乱，截图里"外网地址末尾乱码 ʂ"即由此类字符污染导致）
  const escAttr = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  // 只保留可打印 ASCII（URL 合法字符），过滤控制符与不可见/异常 Unicode（乱码来源）
  const cleanUrlInput = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '');
  const rwTpl = (m = '', r = '') => {
    const row = document.createElement('div');
    row.className = 'rewrite-row';
    row.innerHTML = `
      <div class="input-wrap glass-input"><input class="rw-match" placeholder="内网端口或路径，例如 5667 或 /movie/" value="${escAttr(cleanUrlInput(m))}" spellcheck="false"/></div>
      <div class="rewrite-arrow">→</div>
      <div class="input-wrap glass-input"><input class="rw-replace" placeholder="外网完整地址，例如 https://nas.example.com:5667/" value="${escAttr(cleanUrlInput(r))}" spellcheck="false"/></div>
      <button type="button" class="rewrite-del" title="删除">×</button>`;
    row.querySelector('.rewrite-del').addEventListener('click', () => row.remove());
    rwList.appendChild(row);
  };
  rwAdd.addEventListener('click', () => rwTpl());
  rwSave.addEventListener('click', async () => {
    const rows = [...rwList.querySelectorAll('.rewrite-row')];
    const list = [];
    for (const row of rows) {
      const m = cleanUrlInput(row.querySelector('.rw-match').value).trim();
      const r = cleanUrlInput(row.querySelector('.rw-replace').value).trim();
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
  // v1.48.0：窗口已改为无边框 + 自定义标题栏，无系统菜单栏，"自动隐藏菜单栏"选项已移除。
  // v1.52.0：标题栏自动隐藏开关
  const optTbAutoHide = document.getElementById('opt-titlebar-autohide');
  const optTbLabel = document.getElementById('opt-titlebar-autohide-label');
  const syncTbLabel = () => { if (optTbLabel) optTbLabel.textContent = optTbAutoHide && optTbAutoHide.checked ? '已开启（悬停顶部/按ALT调出）' : '已关闭（标题栏常驻）'; };
  if (optTbAutoHide) {
    optTbAutoHide.addEventListener('change', syncTbLabel);
  }

  // v1.58：标题栏材质 / 不透明度 / 磨砂程度 / 颜色
  // v2.17.24：磨砂材质修复（真毛玻璃 + 滑块生效）、颜色改为标准取色器（拾色面板/十六进制/Alpha）
  // v2.19.0：material = 纯色/磨砂玻璃，blur = 磨砂强度
  const tbState = { opacity: 0, color: '#3B82F6', material: 'solid', blur: 20, highlight: 55 };
  const tbOpacity = document.getElementById('tb-opacity');
  const tbOpacityVal = document.getElementById('tb-opacity-val');
  const tbColorInput = document.getElementById('tb-color-input');
  const tbColorHex = document.getElementById('tb-color-hex');
  const tbColorPreview = document.getElementById('tb-color-preview');
  const tbAlpha = document.getElementById('tb-alpha');
  const tbAlphaVal = document.getElementById('tb-alpha-val');
  const tbColorHint = document.getElementById('tb-color-hint');
  // v2.19.0：材质按钮组 / 磨砂强度
  const tbMatGroup = document.querySelector('[data-tb-material]');
  const tbMaterialHint = document.getElementById('tb-material-hint');
  const tbBlur = document.getElementById('tb-blur');
  const tbBlurVal = document.getElementById('tb-blur-val');
  const tbBlurRow = document.getElementById('tb-blur-row');
  // v2.19.2：磨砂高光强度
  const tbHl = document.getElementById('tb-hl');
  const tbHlVal = document.getElementById('tb-hl-val');
  const tbHlRow = document.getElementById('tb-hl-row');

  // #RGB / #RRGGBB / #RRGGBBAA 都收，统一归一成 #RRGGBB（Alpha 交给不透明度滑块，避免两个口径打架）
  const hexOk = (h) => /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(String(h || '').trim());
  const hexNorm6 = (h) => {
    let t = String(h || '').trim();
    if (t.charAt(0) !== '#') t = '#' + t;
    if (!hexOk(t)) return '';
    let body = t.slice(1);
    if (body.length === 3) body = body.split('').map((c) => c + c).join('');
    if (body.length === 8) body = body.slice(0, 6);
    return '#' + body.toUpperCase();
  };

  // 任何一项改动都立刻广播到所有窗口做实时预览（不落盘；点「保存界面设置」才持久化）
  let tbPreviewTimer = null;
  const tbPreview = () => {
    if (tbPreviewTimer) return;
    tbPreviewTimer = setTimeout(() => {
      tbPreviewTimer = null;
      try {
        fnosSettings.previewTitleBar({
          titleBarOpacity: tbState.opacity,
          titleBarColor: tbState.color,
          titleBarMaterial: tbState.material,
          titleBarBlur: tbState.blur,
          titleBarHighlight: tbState.highlight,
        });
      } catch (_) {}
    }, 40);
  };

  const syncTbMaterialBtns = () => {
    if (tbColorHint) tbColorHint.textContent = '标题栏底色';
    // v2.19.0：材质按钮选中态 + 磨砂强度行的启用状态
    if (tbMatGroup) {
      tbMatGroup.querySelectorAll('.tb-mat-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-material') === tbState.material);
      });
    }
    if (tbMaterialHint) {
      tbMaterialHint.textContent = tbState.material === 'frosted'
        ? '磨砂玻璃：模糊下层内容并叠加细噪点，透出背景质感（Win11 毛玻璃观感）'
        : '纯色：标题栏为单一底色块；想透出背景质感请选「磨砂玻璃」';
    }
    const off = tbState.material !== 'frosted';
    if (tbBlurRow) tbBlurRow.classList.toggle('is-off', off);
    if (tbBlur) tbBlur.disabled = off;
    if (tbBlurVal) tbBlurVal.textContent = tbState.blur + 'px';
    if (tbHlRow) tbHlRow.classList.toggle('is-off', off);
    if (tbHl) tbHl.disabled = off;
    if (tbHlVal) tbHlVal.textContent = String(tbState.highlight);
  };
  const syncTbSliders = () => {
    if (tbOpacity) tbOpacity.value = String(tbState.opacity);
    if (tbOpacityVal) tbOpacityVal.textContent = tbState.opacity + '%';
    // 颜色区的 Alpha 与「标题栏不透明度」是同一个值，双向联动
    if (tbAlpha) tbAlpha.value = String(tbState.opacity);
    if (tbAlphaVal) tbAlphaVal.textContent = tbState.opacity + '%';

  };
  const syncTbColor = () => {
    if (tbColorInput) tbColorInput.value = tbState.color;
    if (tbColorHex && document.activeElement !== tbColorHex) tbColorHex.value = tbState.color;
    if (tbColorPreview) tbColorPreview.style.background = tbState.color;
  };
  const setTbColor = (c) => {
    const n = hexNorm6(c);
    if (!n) return false;
    tbState.color = n;
    syncTbColor();
    return true;
  };
  const setTbOpacity = (v) => { tbState.opacity = clampInt(v, 0, 100, 0); syncTbSliders(); };
  // v2.19.0：材质 / 磨砂强度
  const setTbMaterial = (m) => { tbState.material = (m === 'frosted') ? 'frosted' : 'solid'; syncTbMaterialBtns(); };
  const setTbBlur = (v) => {
    tbState.blur = clampInt(v, 0, 40, 20);
    if (tbBlur) tbBlur.value = String(tbState.blur);
    if (tbBlurVal) tbBlurVal.textContent = tbState.blur + 'px';
  };
  const setTbHighlight = (v) => {
    tbState.highlight = clampInt(v, 0, 100, 55);
    if (tbHl) tbHl.value = String(tbState.highlight);
    if (tbHlVal) tbHlVal.textContent = String(tbState.highlight);
  };

  if (tbOpacity) tbOpacity.addEventListener('input', () => { setTbOpacity(tbOpacity.value); tbPreview(); });
  if (tbAlpha) tbAlpha.addEventListener('input', () => { setTbOpacity(tbAlpha.value); tbPreview(); });
  if (tbColorInput) tbColorInput.addEventListener('input', () => { if (setTbColor(tbColorInput.value)) tbPreview(); });
  if (tbColorHex) {
    tbColorHex.addEventListener('input', () => { if (setTbColor(tbColorHex.value)) tbPreview(); });
    tbColorHex.addEventListener('blur', () => { if (!hexOk(tbColorHex.value)) tbColorHex.value = tbState.color; });
  }
  // v2.19.0：材质切换 / 磨砂强度拖动 → 立即预览
  if (tbMatGroup) {
    tbMatGroup.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.tb-mat-btn') : null;
      if (!btn) return;
      setTbMaterial(btn.getAttribute('data-material'));
      tbPreview();
    });
  }
  if (tbBlur) tbBlur.addEventListener('input', () => { setTbBlur(tbBlur.value); tbPreview(); });
  if (tbHl) tbHl.addEventListener('input', () => { setTbHighlight(tbHl.value); tbPreview(); });

  // 载入当前设置填充界面
  fnosSettings.getSettings().then((info) => {
    try {
      if (!info) return;
      if (optTbAutoHide) { optTbAutoHide.checked = info.titleBarAutoHide === true; syncTbLabel(); }
      tbState.opacity = clampInt(info.titleBarOpacity, 0, 100, 0);
      tbState.color = hexNorm6(info.titleBarColor) || '#3B82F6';
      tbState.material = info.titleBarMaterial === 'frosted' ? 'frosted' : 'solid';
      tbState.blur = clampInt(info.titleBarBlur, 0, 40, 20);
      if (tbBlur) tbBlur.value = String(tbState.blur);
      tbState.highlight = clampInt(info.titleBarHighlight, 0, 100, 55);
      if (tbHl) tbHl.value = String(tbState.highlight);
      syncTbMaterialBtns(); syncTbSliders(); syncTbColor();
    } catch (_) {}
  }).catch(() => {});
  const optSave = document.getElementById('opt-save');
  if (optSave) {
    optSave.addEventListener('click', async () => {
      optSave.disabled = true; optSave.textContent = '保 存 中';
      try {
        const res = await fnosSettings.setUIOptions({
          titleBarAutoHide: !!(optTbAutoHide && optTbAutoHide.checked),
          titleBarOpacity: tbState.opacity,
          titleBarColor: tbState.color,
          titleBarMaterial: tbState.material,
          titleBarBlur: tbState.blur,
          titleBarHighlight: tbState.highlight,
        });
        if (res && res.ok) {
          optSave.textContent = '已 保 存（即时生效）';
          setTimeout(() => { optSave.textContent = '保存界面设置'; }, 1800);
        }
      } finally {
        optSave.disabled = false;
        if (optSave.textContent === '保 存 中') optSave.textContent = '保存界面设置';
      }
    });
  }

  // v1.59：界面主题色选项已移除（标题栏颜色独立可配），不再设置 accentColor
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

  // v2.11.0 r31：电视直播播放器桌面快捷方式（保留 ID __fnos.live__，主进程三链直达直播窗，
  // 复用 create-desktop-shortcut IPC 的独立创建分支；结果反馈与应用列表快捷方式同约定：
  // 成功按钮态反馈、失败弹窗）
  const iptvShortcut = document.getElementById('iptv-shortcut');
  if (iptvShortcut) {
    iptvShortcut.addEventListener('click', async () => {
      if (!window.fnosSettings || !window.fnosSettings.createDesktopShortcut) {
        showError(iptvError, '创建快捷方式功能不可用');
        return;
      }
      iptvShortcut.disabled = true;
      iptvShortcut.textContent = '创 建 中';
      showError(iptvError, '');
      try {
        const result = await window.fnosSettings.createDesktopShortcut({
          appId: '__fnos.live__',
          appName: '电视直播',
          iconPath: '',
          nasAddress: '',
        });
        if (result && result.success) {
          iptvShortcut.textContent = '✓ 桌面快捷方式已生成';
        } else {
          iptvShortcut.textContent = '创建桌面快捷方式';
          const msg = (result && result.msg) || '未知错误';
          showError(iptvError, '创建失败：' + msg);
          alert('创建失败：' + msg);
        }
      } catch (err) {
        iptvShortcut.textContent = '创建桌面快捷方式';
        showError(iptvError, '创建失败：' + (err?.message || '未知错误'));
        alert('创建失败：' + (err?.message || '未知错误'));
      }
      setTimeout(() => { iptvShortcut.disabled = false; iptvShortcut.textContent = '创建桌面快捷方式'; }, 3000);
    });
  }

  // --------- 兼容性播放器（MPV）v1.25.0 ---------
  const vlcEnabled = document.getElementById('vlc-enabled');
  const vlcEnabledLabel = document.getElementById('vlc-enabled-label');
  // v2.20.0：默认用 MPV 播放（所有视频直接交给 MPV）
  const vlcAlways = document.getElementById('vlc-always');
  const vlcAlwaysLabel = document.getElementById('vlc-always-label');
  const vlcFallbackRow = document.getElementById('vlc-fallback-row');
  const vlcFallbackSub = document.getElementById('vlc-fallback-sub');
  const vlcHw = bindGlassSelect(document.querySelector('[data-select="vlc-hw"]'));
  const vlcCache = bindGlassSelect(document.querySelector('[data-select="vlc-cache"]'));
  // v2.21.0：自定义内核 / 附加参数 / 配置来源 / 低功耗预设 / 字幕样式
  const vlcExe = document.getElementById('vlc-exe');
  const vlcExeBrowse = document.getElementById('vlc-exe-browse');
  const vlcArgs = document.getElementById('vlc-args');
  const vlcConfig = bindGlassSelect(document.querySelector('[data-select="vlc-config"]'));
  const vlcPerf = bindGlassSelect(document.querySelector('[data-select="vlc-perf"]'));
  const vlcSubPos = document.getElementById('vlc-sub-pos');
  const vlcSubSize = document.getElementById('vlc-sub-size');
  const vlcSubScale = document.getElementById('vlc-sub-scale');
  // v2.22.0：本地续播
  const vlcResume = document.getElementById('vlc-resume');
  const vlcResumeLabel = document.getElementById('vlc-resume-label');
  const vlcClearProgress = document.getElementById('vlc-clear-progress');
  const vlcProgressCount = document.getElementById('vlc-progress-count');
  const vlcNum = (el) => {
    if (!el) return null;
    const raw = String(el.value == null ? '' : el.value).trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
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
          const always = rt.alwaysUse === true;
          if (rt.available) {
            html = '<div style="color:#4ade80">● MPV 播放器已就绪，应用内嵌入播放' + (always ? '（默认播放器）' : '（兜底播放器）') + '</div>' +
              '<div style="opacity:.8;margin-top:4px">' + (always
                ? '当前为默认播放模式：飞牛影视的所有视频都直接交给 MPV 播放，剧集支持上一集 / 下一集与自动连播。'
                : '当前为兜底模式：仅当网页内核无法解码（HEVC/10bit/4K/MKV 等）时自动切换到 MPV。') + '</div>';
          } else {
            html = '<div style="color:#f87171">● MPV 播放器不可用：' + (rt.reason || '未知原因') + '</div>' +
              '<div style="opacity:.8;margin-top:4px">特殊编码视频仍只能依赖网页内核，可能无法播放。</div>';
          }
          if (rt.custom) {
            html += '<div style="margin-top:6px;color:#60a5fa">● 当前使用自定义 MPV 内核：' + (rt.source || '') + '</div>';
          } else if (rt.customMissing) {
            html += '<div style="margin-top:6px;color:#fbbf24">● 自定义内核路径无效，已回退内置内核</div>';
          }
          html += '<div style="margin-top:6px;opacity:.85">硬件解码：' + hwLabel + ' ｜ 网络缓存：' + cacheLabel +
            ((rt.subStyle && (rt.subStyle.pos != null || rt.subStyle.size != null || rt.subStyle.scale != null))
              ? (' ｜ 字幕：位置 ' + (rt.subStyle.pos != null ? rt.subStyle.pos : '默认') +
                 ' / 字号 ' + (rt.subStyle.size != null ? rt.subStyle.size : '默认') +
                 ' / 缩放 ' + (rt.subStyle.scale != null ? rt.subStyle.scale : '默认'))
              : '') + '</div>';
          // v2.22.0：续播状态 + 已记多少条
          html += '<div style="margin-top:6px;opacity:.85">本地续播：' + (rt.resume === false ? '已关闭' : '已开启') +
            (typeof rt.progressCount === 'number' ? ('（已记录 ' + rt.progressCount + ' 条播放进度）') : '') + '</div>';
          vlcRuntime.innerHTML = html;
          if (vlcProgressCount) {
            vlcProgressCount.textContent = (typeof rt.progressCount === 'number' && rt.progressCount > 0)
              ? ('当前已记录 ' + rt.progressCount + ' 条。') : '当前没有记录。';
          }
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
      if (vlcAlways) {
        vlcAlways.checked = v.alwaysUse === true;
        if (vlcAlwaysLabel) vlcAlwaysLabel.textContent = vlcAlways.checked ? '已开启' : '已关闭';
      }
      syncVlcAlways();
      if (vlcHw) vlcHw.value = v.hwDecode || 'auto';
      if (vlcCache) vlcCache.value = v.cacheLevel || 'smooth';
      // v2.21.0
      if (vlcExe) vlcExe.value = v.exePath || '';
      if (vlcArgs) vlcArgs.value = v.extraArgs || '';
      if (vlcConfig) vlcConfig.value = (v.configMode === 'own') ? 'own' : 'builtin';
      if (vlcPerf) vlcPerf.value = (v.perfPreset === true) ? 'on' : (v.perfPreset === false ? 'off' : 'auto');
      const ss = (v.subStyle && typeof v.subStyle === 'object') ? v.subStyle : {};
      if (vlcSubPos) vlcSubPos.value = (typeof ss.pos === 'number') ? String(ss.pos) : '';
      if (vlcSubSize) vlcSubSize.value = (typeof ss.size === 'number') ? String(ss.size) : '';
      if (vlcSubScale) vlcSubScale.value = (typeof ss.scale === 'number') ? String(ss.scale) : '';
      // v2.22.0：续播开关（默认开）
      if (vlcResume) {
        vlcResume.checked = v.resume !== false;
        if (vlcResumeLabel) vlcResumeLabel.textContent = vlcResume.checked ? '已开启' : '已关闭';
      }
      refreshVlcRuntime();
    } catch (err) {
      showError(vlcError, err?.message || '加载播放器设置失败');
    }
  }

  // 默认用 MPV 时，兜底开关不再生效 → 置灰 + 说明
  function syncVlcAlways() {
    const always = !!(vlcAlways && vlcAlways.checked);
    if (vlcFallbackRow) {
      vlcFallbackRow.style.opacity = always ? '0.45' : '';
    }
    if (vlcEnabled) vlcEnabled.disabled = always;
    // 被接管时勾选框是禁用空框，文案同步为「已停用」避免与状态自相矛盾
    if (vlcEnabledLabel) vlcEnabledLabel.textContent = always
      ? '已停用'
      : (vlcEnabled && vlcEnabled.checked ? '已启用' : '已关闭');
    if (vlcFallbackSub) {
      vlcFallbackSub.textContent = always
        ? '已由「默认用 MPV 播放」接管，本项不再生效'
        : '网页内核无法解码（HEVC/10bit/4K/MKV 等）时自动切到 MPV；开启「默认用 MPV 播放」后本项不再生效';
    }
  }

  if (vlcAlways) {
    vlcAlways.addEventListener('change', () => {
      if (vlcAlwaysLabel) vlcAlwaysLabel.textContent = vlcAlways.checked ? '已开启' : '已关闭';
      syncVlcAlways();
    });
  }

  if (vlcEnabled) {
    vlcEnabled.addEventListener('change', () => {
      if (vlcEnabledLabel) vlcEnabledLabel.textContent = vlcEnabled.checked ? '已启用' : '已关闭';
    });
  }

  // v2.22.0：续播开关文案
  if (vlcResume) {
    vlcResume.addEventListener('change', () => {
      if (vlcResumeLabel) vlcResumeLabel.textContent = vlcResume.checked ? '已开启' : '已关闭';
    });
  }

  // v2.22.0：清除本机播放记录
  if (vlcClearProgress) {
    vlcClearProgress.addEventListener('click', async () => {
      const ask = window.confirm('清除本机记录的所有播放进度？清除后各剧集下次将从头发起播放。');
      if (!ask) return;
      vlcClearProgress.disabled = true;
      try {
        const r = await fnosSettings.clearProgress();
        if (r && r.ok) {
          showError(vlcError, '');
          if (vlcProgressCount) vlcProgressCount.textContent = '已清除 ' + (r.cleared || 0) + ' 条记录。';
          refreshVlcRuntime();
        } else {
          showError(vlcError, (r && r.error) || '清除失败');
        }
      } catch (err) {
        showError(vlcError, err?.message || '清除失败');
      } finally {
        vlcClearProgress.disabled = false;
      }
    });
  }

  // v2.21.0：选择自定义 MPV 内核（mpv.exe）
  if (vlcExeBrowse) {
    vlcExeBrowse.addEventListener('click', async () => {
      try {
        const r = await fnosSettings.pickMpvExe();
        if (r && r.ok && r.path) {
          if (vlcExe) vlcExe.value = r.path;
        } else if (r && r.error) {
          showError(vlcError, r.error);
        }
      } catch (err) {
        showError(vlcError, err?.message || '选择文件失败');
      }
    });
  }

  if (vlcSave) {
    vlcSave.addEventListener('click', async () => {
      vlcSave.disabled = true;
      vlcSave.textContent = '保 存 中';
      showError(vlcError, '');
      try {
        const alwaysOn = vlcAlways ? !!vlcAlways.checked : false;
        const res = await fnosSettings.setVlc({
          // v2.20.0：默认用 MPV 播放时，兜底开关不再生效，enabled 一律视为开启
          enabled: alwaysOn ? true : (vlcEnabled ? !!vlcEnabled.checked : true),
          alwaysUse: alwaysOn,
          hwDecode: vlcHw ? vlcHw.value : 'auto',
          cacheLevel: vlcCache ? vlcCache.value : 'smooth',
          // v2.21.0：自定义内核 / 附加参数 / 配置来源 / 低功耗预设 / 字幕样式
          exePath: vlcExe ? String(vlcExe.value || '').trim() : '',
          extraArgs: vlcArgs ? String(vlcArgs.value || '').trim() : '',
          configMode: (vlcConfig && vlcConfig.value === 'own') ? 'own' : 'builtin',
          perfPreset: (vlcPerf ? vlcPerf.value : 'auto') === 'on' ? true
            : ((vlcPerf ? vlcPerf.value : 'auto') === 'off' ? false : null),
          subStyle: { pos: vlcNum(vlcSubPos), size: vlcNum(vlcSubSize), scale: vlcNum(vlcSubScale) },
          // v2.22.0：本地续播
          resume: vlcResume ? !!vlcResume.checked : true,
        });
        if (res && res.ok) {
          if (res.warning) showError(vlcError, res.warning);
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

  // v2.1.11：快捷方式打开应用后主程序后台化方式（tray 隐藏到托盘 / minimize 最小化到任务栏）
  if (shortcutHideSel) {
    shortcutHideSel.addEventListener('change', async () => {
      try {
        const mode = shortcutHideSel.value === 'minimize' ? 'minimize' : 'tray';
        const res = await fnosSettings.setShortcutHideMode(mode);
        const statusEl = document.getElementById('app-action-status');
        if (res && res.ok) {
          if (statusEl) statusEl.textContent = '已保存：打开应用后主程序' + (mode === 'minimize' ? '最小化到任务栏' : '隐藏到托盘');
        } else {
          shortcutHideSel.value = mode === 'minimize' ? 'tray' : 'minimize'; // 回滚
          if (statusEl) statusEl.textContent = '保存失败: ' + ((res && res.error) || '未知错误');
        }
      } catch (err) {
        const statusEl = document.getElementById('app-action-status');
        if (statusEl) statusEl.textContent = '保存失败: ' + (err?.message || '未知错误');
      }
    });
  }

  // v2.0.0：开机自启动开关（v2.4.0 需求 2.2/2.5-3）：经 set-auto-launch({ enable }) 写注册表
  // （HKCU Run，开机命令不带应用 ID，禁用打包工具自启能力）；autostart-text 文字按需求固定不动，
  // 状态反馈写 autostart-hint。开关状态持久化于主进程 settings JSON（autoLaunch 字段）。
  if (autostartToggle) {
    autostartToggle.addEventListener('change', async () => {
      const enabled = autostartToggle.checked;
      if (autostartHint) { autostartHint.textContent = enabled ? '开启中...' : '关闭中...'; autostartHint.style.color = '#f0b429'; }
      try {
        const res = await fnosSettings.setAutoLaunch(enabled);
        if (res && res.success) {
          if (autostartHint) {
            autostartHint.textContent = res.msg || (enabled ? '已开启开机自启' : '已关闭开机自启');
            autostartHint.style.color = '#4ade80';
          }
        } else {
          autostartToggle.checked = !enabled; // 回滚
          if (autostartHint) {
            autostartHint.textContent = res?.msg || '操作失败';
            autostartHint.style.color = '#f87171';
          }
        }
      } catch (err) {
        autostartToggle.checked = !enabled;
        if (autostartHint) {
          autostartHint.textContent = err?.message || '操作失败';
          autostartHint.style.color = '#f87171';
        }
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
      if (autoLockSel) {
        const mins = Number(info?.autoLockMinutes) || 0;
        autoLockSel.value = String(mins);
        updateAutoLockHint(!!info?.hasPassword, mins);
      }
      // v2.1.11：加载快捷方式后台化方式
      if (shortcutHideSel) {
        shortcutHideSel.value = info?.shortcutHideMode === 'minimize' ? 'minimize' : 'tray';
      }
      loadLiveConfig();
      loadVlcConfig();
      // v2.0.0：加载开机自启动状态（v2.4.0 需求 2.2：autostart-text 文字按需求固定不动，
      // 状态反馈写 autostart-hint）
      if (autostartToggle && fnosSettings.getAutoStart) {
        try {
          const res = await fnosSettings.getAutoStart();
          if (res && res.success) {
            autostartToggle.checked = !!res.data;
            if (autostartHint) {
              autostartHint.textContent = res.data ? '已开启开机自启' : '未开启开机自启';
              autostartHint.style.color = res.data ? '#4ade80' : '#f0b429';
            }
          } else {
            if (autostartHint) {
              autostartHint.textContent = res?.msg || '无法获取自启状态';
              autostartHint.style.color = '#f0b429';
            }
          }
        } catch (err) {
          if (autostartHint) {
            autostartHint.textContent = err?.message || '加载失败';
            autostartHint.style.color = '#f0b429';
          }
        }
      }
      // v2.0.0：加载账号管理
      loadAccountManager();
    } catch (err) {
      showError(hkError, err?.message || '加载设置失败');
    }
  })();

  // ============ v2.0.0 多账号管理 ============
  async function loadAccountManager() {
    const listEl = document.getElementById('account-list');
    const loadingEl = document.getElementById('account-loading');
    const addBtn = document.getElementById('account-add-btn');
    if (!listEl) return;

    async function refreshAccounts() {
      try {
        let accounts = [];
        try {
          const res = await fnosSettings.listAccounts();
          if (res && res.success) accounts = res.data || [];
        } catch (_) {
          try {
            const res = await fnosSettings._ipcInvoke && fnosSettings._ipcInvoke('account:list');
            if (res && res.success) accounts = res.data || [];
          } catch (_) {}
        }

        listEl.innerHTML = '';
        if (!accounts.length) {
          listEl.innerHTML = '<div class="account-empty">暂无已登录账号，请先连接 NAS 服务器</div>';
          return;
        }

        accounts.forEach(acct => {
          const item = document.createElement('div');
          item.className = 'account-item' + (acct.isActive ? ' active' : '');
          item.innerHTML = `
            <span class="acct-status" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${acct.isActive ? '#4ade80' : 'rgba(255,255,255,0.2)'}"></span>
            <div class="acct-info">
              <div class="acct-name">${acct.label || acct.origin || '未知账号'}${acct.isActive ? ' <span style="font-size:11px;color:#4ade80">(当前)</span>' : ''}</div>
              <div class="acct-addr">${acct.origin || ''}</div>
            </div>
            <div class="acct-actions">
              ${!acct.isActive ? '<button class="acct-btn primary" data-action="switch">切换</button>' : ''}
              <button class="acct-btn danger" data-action="remove">移除</button>
            </div>
          `;

          const switchBtn = item.querySelector('[data-action="switch"]');
          if (switchBtn) {
            switchBtn.addEventListener('click', async () => {
              try {
                const res = await fnosSettings.switchAccount(acct.origin);
                if (res && res.success) {
                  refreshAccounts();
                } else {
                  alert('切换失败: ' + (res?.msg || '未知错误'));
                }
              } catch (e) { alert('切换失败: ' + e.message); }
            });
          }

          item.querySelector('[data-action="remove"]').addEventListener('click', async () => {
            if (!confirm('确定移除账号 "' + (acct.label || acct.origin) + '"？\n这将清除该账号的登录状态。')) return;
            try {
              const res = await fnosSettings.removeAccount(acct.id);
              if (res && res.success) {
                refreshAccounts();
              } else {
                alert('移除失败: ' + (res?.msg || '未知错误'));
              }
            } catch (e) { alert('移除失败: ' + e.message); }
          });

          listEl.appendChild(item);
        });
      } catch (_) {
        listEl.innerHTML = '<div class="account-empty">加载失败</div>';
      }
    }

    if (addBtn) {
      addBtn.addEventListener('click', () => {
        try { fnosSettings.backToConnect(); } catch (_) {}
      });
    }

    refreshAccounts();
  }

  // v2.1.10：应用快捷方式创建
  const appListEl = document.getElementById('app-list');
  const appListLoading = document.getElementById('app-list-loading');
  const appListEmpty = document.getElementById('app-list-empty');
  const appActionStatus = document.getElementById('app-action-status');
  async function loadAppList() {
    try {
      if (!window.fnosSettings || !window.fnosSettings.getInstalledApps) {
        if (appListLoading) appListLoading.textContent = '应用快捷方式创建功能不可用';
        return;
      }
      const res = await window.fnosSettings.getInstalledApps();
      if (appListLoading) appListLoading.style.display = 'none';
      if (!res.success || !res.data || !res.data.length) {
        if (appListEmpty) appListEmpty.style.display = 'block';
        return;
      }
      if (appListEmpty) appListEmpty.style.display = 'none';
      appListEl.innerHTML = '';
      appListEl.style.display = 'grid';
      res.data.forEach((app) => {
        const card = document.createElement('div');
        card.className = 'app-card';
        const iconSrc = app.iconPath ? ('file://' + app.iconPath) : '';
        card.innerHTML = 
          (iconSrc ? '<img class="app-card-icon" src="' + iconSrc + '" onerror="this.style.display=\'none\'" />' : '<div class="app-card-icon"></div>') +
          '<div class="app-card-info">' +
            '<div class="app-card-name">' + (app.appName || app.appId || '未命名') + '</div>' +
            '<div class="app-card-addr">' + (app.nasAddress || '') + '</div>' +
          '</div>' +
          '<div class="app-card-actions">' +
            '<button class="app-card-btn shortcut-btn" data-app-id="' + app.appId + '" title="创建桌面快捷方式">创建快捷方式</button>' +
          '</div>';
        appListEl.appendChild(card);
      });
      // 绑定事件
      appListEl.querySelectorAll('.shortcut-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const appId = btn.dataset.appId;
          const appData = res.data.find(a => a.appId === appId);
          if (!appData) return;
          btn.disabled = true;
          btn.textContent = '创建中...';
          try {
            const result = await window.fnosSettings.createDesktopShortcut({
              appId: appData.appId,
              appName: appData.appName || appData.appId,
              iconPath: appData.iconPath || '',
              nasAddress: appData.nasAddress || '',
            });
            // 需求 2.1：结果反馈弹窗——成功固定文案"桌面快捷方式已生成"；
            // 失败弹出主进程分类错误信息（权限不足 / 桌面路径不存在 / 其他）
            if (result.success) {
              btn.textContent = '✓ 已创建';
              btn.classList.add('success');
              if (appActionStatus) appActionStatus.textContent = '已创建快捷方式: ' + (appData.appName || appData.appId);
              // v2.5.4 r20：去掉创建成功提示框（用户要求；按钮状态与状态栏反馈保留）
            } else {
              btn.textContent = '创建失败';
              if (appActionStatus) appActionStatus.textContent = '创建失败: ' + (result.msg || '未知错误');
              alert('创建失败：' + (result.msg || '未知错误'));
            }
          } catch (e) {
            btn.textContent = '创建失败';
            if (appActionStatus) appActionStatus.textContent = '创建失败: ' + e.message;
            alert('创建失败：' + e.message);
          }
          setTimeout(() => { btn.disabled = false; btn.textContent = '创建快捷方式'; btn.classList.remove('success'); }, 3000);
        });
      });
    } catch (e) {
      if (appListLoading) appListLoading.textContent = '加载失败: ' + e.message;
    }
  }
  loadAppList();

  // ---- v2.1.17: FPK 图标管理器 API 配置 ----
  const fpkEnabled = document.getElementById('fpk-enabled');
  const fpkHost = document.getElementById('fpk-host');
  const fpkPort = document.getElementById('fpk-port');
  const fpkStatus = document.getElementById('fpk-status');
  const fpkSave = document.getElementById('fpk-save');
  const fpkTest = document.getElementById('fpk-test');
  // 加载 FPK 配置
  (async () => {
    try {
      const s = await fnosSettings.getSettings();
      if (s.fpkApi && fpkEnabled) {
        fpkEnabled.checked = !!s.fpkApi.enabled;
        fpkHost.value = s.fpkApi.host || '';
        fpkPort.value = s.fpkApi.port || 18080;
      }
    } catch (_) {}
  })();
  fpkTest?.addEventListener('click', async () => {
    // 先临时保存当前输入值用于测试
    await fnosSettings.setFpkApi({ enabled: fpkEnabled.checked, host: fpkHost.value.trim(), port: Number(fpkPort.value) || 18080 });
    fpkStatus.textContent = '正在测试连接...';
    fpkStatus.style.color = '#94a3b8';
    const result = await fnosSettings.testFpkApi();
    if (result.ok) {
      fpkStatus.textContent = `连接成功！FPK 版本: ${result.version}`;
      fpkStatus.style.color = '#4ade80';
    } else {
      fpkStatus.textContent = `连接失败: ${result.error}`;
      fpkStatus.style.color = '#f87171';
    }
  });
  fpkSave?.addEventListener('click', async () => {
    const host = fpkHost.value.trim();
    if (!host) {
      fpkStatus.textContent = '请填写 FPK 服务地址';
      fpkStatus.style.color = '#f87171';
      return;
    }
    await fnosSettings.setFpkApi({
      enabled: fpkEnabled.checked,
      host: host,
      port: Number(fpkPort.value) || 18080,
    });
    fpkStatus.textContent = '配置已保存';
    fpkStatus.style.color = '#4ade80';
  });
})();
