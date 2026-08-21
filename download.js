// 通过 download-preload.js 暴露的 window.fnosDownload 与主进程通信
(function () {
  const api = window.fnosDownload || {};
  const titleEl = document.getElementById('title');
  const subEl = document.getElementById('sub');
  const fillEl = document.getElementById('fill');
  const pctEl = document.getElementById('pct');
  const sizeEl = document.getElementById('size');
  const speedEl = document.getElementById('speed');
  const statusEl = document.getElementById('status');
  const cancelBtn = document.getElementById('cancel-btn');
  const closeBtn = document.getElementById('close-btn');
  const openBtn = document.getElementById('open-btn');
  const card = document.getElementById('card');

  let savePath = '';

  const onStart = (data) => {
    titleEl.textContent = data.filename || '正在下载…';
    subEl.textContent = data.savePath || '';
    sizeEl.textContent = `0 / ${data.totalText || '—'}`;
    savePath = data.savePath || '';
  };

  const fmtSpeed = (bps) => {
    if (!bps || bps <= 0) return '0 KB/s';
    if (bps > 1024 * 1024) return (bps / 1024 / 1024).toFixed(2) + ' MB/s';
    return (bps / 1024).toFixed(1) + ' KB/s';
  };

  const onProgress = (data) => {
    fillEl.style.width = `${data.pct || 0}%`;
    pctEl.textContent = `${data.pct || 0}%`;
    if (speedEl) speedEl.textContent = fmtSpeed(data.speedBps);
    const totalMB = data.totalBytes > 0 ? (data.totalBytes / 1024 / 1024).toFixed(2) : '—';
    sizeEl.textContent = `${data.receivedText || '0 MB'} / 共 ${totalMB} MB`;
  };

  const onDone = (data) => {
    card.classList.add('done');
    fillEl.style.width = '100%';
    if (data.state === 'completed') {
      titleEl.textContent = '下载完成';
      statusEl.innerHTML = '<span style="color:#7cf0b0;font-weight:800;">✓ 已保存</span>';
      cancelBtn.hidden = true;
      openBtn.hidden = false;
      closeBtn.hidden = false;
    } else if (data.state === 'cancelled') {
      titleEl.textContent = '已取消下载';
      statusEl.innerHTML = '<span style="color:#ffb3c2;font-weight:800;">已取消</span>';
      cancelBtn.hidden = true;
      closeBtn.hidden = false;
    } else {
      titleEl.textContent = '下载中断';
      statusEl.innerHTML = '<span style="color:#ffd28a;font-weight:800;">已中断</span>';
      cancelBtn.hidden = true;
      closeBtn.hidden = false;
    }
  };

  if (api.onStart) api.onStart(onStart);
  if (api.onProgress) api.onProgress(onProgress);
  if (api.onDone) api.onDone(onDone);

  cancelBtn.addEventListener('click', () => api.cancel && api.cancel());
  closeBtn.addEventListener('click', () => api.close && api.close());
  openBtn.addEventListener('click', () => api.openFolder && api.openFolder());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!closeBtn.hidden) api.close && api.close();
      else if (!cancelBtn.hidden) api.cancel && api.cancel();
    }
  });
})();
