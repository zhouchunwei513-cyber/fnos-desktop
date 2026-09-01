/* FNOS 对话框（contextIsolation 下运行）—— 极简：仅标题 + 按钮 */
const api = window.fnosDialog;

const $ = (id) => document.getElementById(id);

let dialogOptions = { buttons: ['确定'], defaultId: 0, cancelId: 0 };

function respond(buttonIndex) {
  if (!api) return;
  api.respond({ buttonIndex, checkboxChecked: false });
}

function applyOptions(opts) {
  dialogOptions = Object.assign({ buttons: ['确定'], defaultId: 0, cancelId: 0 }, opts || {});

  // 标题
  $('dlg-title').textContent = dialogOptions.title || 'FNOS';

  // 正文消息（普通提示文本，自动换行完整显示）
  const msgWrap = $('dlg-message');
  if (dialogOptions.message) {
    msgWrap.hidden = false;
    msgWrap.textContent = dialogOptions.message;
  } else {
    msgWrap.hidden = true;
    msgWrap.textContent = '';
  }

  // 技术细节（仅错误堆栈场景）
  const detailWrap = $('dlg-detail');
  if (dialogOptions.detail) {
    detailWrap.hidden = false;
    $('dlg-detail-text').textContent = dialogOptions.detail;
  } else {
    detailWrap.hidden = true;
  }

  // 按钮
  const foot = $('dlg-buttons');
  foot.innerHTML = '';
  const buttons = dialogOptions.buttons || ['确定'];
  const defaultId = typeof dialogOptions.defaultId === 'number' ? dialogOptions.defaultId : 0;

  buttons.forEach((label, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    if (i === defaultId) b.classList.add('btn-primary');
    if (/退出|删除|不保存|discard|delete|exit/i.test(label)) b.classList.add('btn-danger');
    b.addEventListener('click', () => respond(i));
    foot.appendChild(b);
  });

  // 聚焦默认按钮
  requestAnimationFrame(() => {
    const def = foot.querySelector('.btn-primary') || foot.querySelector('button');
    if (def) { try { def.focus(); } catch (_) {} }
  });

  // 上报真实尺寸后再通知主进程显示
  requestAnimationFrame(() => {
    try {
      const f = document.querySelector('.dialog-frame');
      const h = Math.ceil(f.getBoundingClientRect().height) + 40;
      const w = Math.ceil(f.getBoundingClientRect().width) + 40;
      if (api && api.resize) api.resize({ width: w, height: h });
    } catch (_) {}
    if (api && api.ready) api.ready();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    const cancelId = typeof dialogOptions.cancelId === 'number'
      ? dialogOptions.cancelId
      : (dialogOptions.buttons.length - 1);
    respond(cancelId);
  } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'TEXTAREA') return;
    const defaultId = typeof dialogOptions.defaultId === 'number'
      ? dialogOptions.defaultId
      : 0;
    respond(defaultId);
  }
});

window.addEventListener('DOMContentLoaded', () => {
  if (api && api.readOptions) {
    try {
      const opts = api.readOptions();
      applyOptions(opts);
    } catch (e) {
      applyOptions({});
    }
  } else {
    applyOptions({});
  }
});
