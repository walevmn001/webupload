'use strict';

/* ============================ Trang thai ============================ */
const AUTO_ID = 'auto';
const state = {
  services: [],
  selected: AUTO_ID,       // id dich vu dang chon, hoac 'auto'
  files: [],               // danh sach File nguoi dung chon
  history: [],             // lich su upload trong phien
  status: {},              // trang thai kiem tra dich vu: id -> 'ok' | 'fail' | 'checking'
  maxUpload: 0,            // tran an toan cua may chu (bytes)
  maxUploadText: '',
  uploading: false,
};

const $ = (sel) => document.querySelector(sel);

/* ============================ Tien ich ============================ */
function toast(message, type = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'all .3s ease';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

function humanSize(n) {
  if (n == null) return '?';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function serviceById(id) {
  return state.services.find((s) => s.id === id);
}

// Gioi han thuc te cho 1 lua chon (bytes)
function effectiveLimit(id) {
  if (id === AUTO_ID) return state.maxUpload;
  const s = serviceById(id);
  if (!s) return state.maxUpload;
  const sb = s.limitBytes == null ? Infinity : s.limitBytes;
  return Math.min(sb, state.maxUpload);
}

// Mo ta gioi han de hien thi
function effectiveLimitText(id) {
  if (id === AUTO_ID) return `theo dịch vụ, tối đa ${state.maxUploadText}`;
  const s = serviceById(id);
  if (!s) return state.maxUploadText;
  if (s.limitBytes == null) return `không giới hạn (máy chủ tối đa ${state.maxUploadText})`;
  if (s.limitBytes > state.maxUpload) return `${state.maxUploadText} (máy chủ giới hạn)`;
  return s.limit;
}

/* ============================ Theme ============================ */
function themeIcon(theme) {
  if (theme === 'dark') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.4 15.4A8.5 8.5 0 0 1 8.6 3.6 8.5 8.5 0 1 0 20.4 15.4Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
}

function updateThemeButton(theme) {
  const nextTheme = theme === 'dark' ? 'sáng' : 'tối';
  const label = `Chuyển sang giao diện ${nextTheme}`;
  $('#themeBtn').innerHTML = themeIcon(theme);
  $('#themeBtn').title = label;
  $('#themeBtn').setAttribute('aria-label', label);
}

function initTheme() {
  const saved = localStorage.getItem('fu-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeButton(saved);
  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('fu-theme', next);
    updateThemeButton(next);
  });
}

/* ============================ Tai dich vu ============================ */
async function loadServices() {
  try {
    const res = await fetch('/api/services');
    const data = await res.json();
    state.services = data.services || [];
    state.maxUpload = data.maxUpload || 0;
    state.maxUploadText = data.maxUploadText || '';

    // Dien vao select bao loi
    const sel = $('#reportService');
    sel.innerHTML = '<option value="">— Chọn —</option>' +
      state.services.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');

    renderDropdown();
    updateLimitBadge();
  } catch (e) {
    $('#ddMenu').innerHTML = '<div class="dd-opt"><div class="dd-opt-desc">Không tải được danh sách dịch vụ.</div></div>';
    toast('Không tải được danh sách dịch vụ', 'error');
  }
}

function statusDot(st) {
  return `<span class="dot ${st || ''}"></span>`;
}

function statusTitle(st) {
  return st === 'ok' ? 'Đang hoạt động' : st === 'fail' ? 'Không khả dụng' : st === 'checking' ? 'Đang kiểm tra' : 'Chưa kiểm tra';
}

function renderDropdown() {
  const autoStatus = Object.values(state.status).includes('ok') ? 'ok'
    : Object.keys(state.status).length ? 'fail' : '';

  // Dòng hiển thị của nút (option đang chọn)
  const cur = state.selected === AUTO_ID
    ? { name: '🔄 Tự động chọn', sub: 'thử lần lượt các dịch vụ khi bị lỗi / giới hạn', dot: autoStatus }
    : (() => { const s = serviceById(state.selected); return s ? { name: s.name, sub: `tối đa ${effectiveLimitText(s.id)}`, dot: state.status[s.id] } : { name: '—', sub: '' }; })();
  $('#ddCurrent').innerHTML = `${statusDot(cur.dot)}<span class="t">${escapeHtml(cur.name)}</span> <span class="s">· ${escapeHtml(cur.sub)}</span>`;

  // Danh sach option
  const autoOpt = `
    <div class="dd-opt ${state.selected === AUTO_ID ? 'active' : ''}" data-id="${AUTO_ID}" role="option">
      ${statusDot(autoStatus)}
      <div class="dd-opt-body">
        <div class="dd-opt-name">🔄 Tự động chọn</div>
        <div class="dd-opt-desc">Thử lần lượt các dịch vụ cho đến khi thành công (khuyến nghị khi bị giới hạn lượt tải)</div>
        <div class="dd-opt-meta"><span class="chip">Giới hạn: theo dịch vụ</span><span class="chip gray">Tối đa ${state.maxUploadText}</span></div>
      </div>
      ${state.selected === AUTO_ID ? '<span class="check">✓</span>' : ''}
    </div>`;

  const opts = state.services.map((s) => {
    const st = state.status[s.id] || '';
    return `
    <div class="dd-opt ${state.selected === s.id ? 'active' : ''}" data-id="${s.id}" role="option" title="${escapeHtml(statusTitle(st))}">
      ${statusDot(st)}
      <div class="dd-opt-body">
        <div class="dd-opt-name">${escapeHtml(s.name)}</div>
        <div class="dd-opt-desc">${escapeHtml(s.desc)}</div>
        <div class="dd-opt-meta">
          <span class="chip">Tối đa ${escapeHtml(s.limit)}</span>
          <span class="chip gray">${escapeHtml(s.expiry)}</span>
        </div>
      </div>
      ${state.selected === s.id ? '<span class="check">✓</span>' : ''}
    </div>`;
  }).join('');

  const menu = $('#ddMenu');
  menu.innerHTML = autoOpt + opts;
  menu.querySelectorAll('.dd-opt[data-id]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selected = el.dataset.id;
      closeDropdown();
      renderDropdown();
      updateLimitBadge();
    });
  });
}

function updateLimitBadge() {
  $('#limitBadge').textContent = 'Giới hạn mỗi lần up: ' + effectiveLimitText(state.selected);
  $('#limitHint').innerHTML = state.selected === AUTO_ID
    ? 'Hệ thống sẽ tự thử lần lượt các dịch vụ khi gặp lỗi hoặc bị giới hạn lượt tải.'
    : 'Giới hạn hiển thị là mức tối đa của dịch vụ đang chọn (hoặc giới hạn máy chủ nếu nhỏ hơn).';
}

function openDropdown() {
  $('#ddMenu').classList.remove('hidden');
  $('#ddToggle').setAttribute('aria-expanded', 'true');
  $('.upload-card').classList.add('dropdown-open');
}
function closeDropdown() {
  $('#ddMenu').classList.add('hidden');
  $('#ddToggle').setAttribute('aria-expanded', 'false');
  $('.upload-card').classList.remove('dropdown-open');
}

async function checkServices() {
  const btn = $('#checkServices');
  btn.disabled = true;
  state.services.forEach((s) => { state.status[s.id] = 'checking'; });
  renderDropdown();
  toast('Đang kiểm tra các dịch vụ (có thể mất ~20 giây)…', 'info', 5000);
  try {
    const res = await fetch('/api/services/check');
    const data = await res.json();
    (data.results || []).forEach((r) => { state.status[r.id] = r.ok ? 'ok' : 'fail'; });
    renderDropdown();
    const okCount = (data.results || []).filter((r) => r.ok).length;
    toast(`Kiểm tra xong: ${okCount}/${(data.results || []).length} dịch vụ hoạt động`, 'success');
  } catch (e) {
    toast('Không kiểm tra được: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ============================ Chon file ============================ */
function initDropzone() {
  const dz = $('#dropzone');
  const input = $('#fileInput');

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => addFiles(input.files));

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
}

function addFiles(fileList) {
  const limit = effectiveLimit(state.selected);
  for (const f of fileList) {
    if (f.size > limit) {
      toast(`"${f.name}" (${humanSize(f.size)}) vượt giới hạn ${humanSize(limit)} của lựa chọn hiện tại`, 'warn', 6500);
      continue;
    }
    if (!state.files.some((x) => x.name === f.name && x.size === f.size)) {
      state.files.push(f);
    }
  }
  renderFiles();
}

function renderFiles() {
  const list = $('#fileList');
  list.innerHTML = state.files.map((f, i) => `
    <div class="file-item">
      <span>📄</span>
      <span class="fname">${escapeHtml(f.name)}</span>
      <span class="fsize">${humanSize(f.size)}</span>
      <button class="rm" data-i="${i}" title="Xoá">✕</button>
    </div>`).join('');
  list.querySelectorAll('.rm').forEach((b) =>
    b.addEventListener('click', () => { state.files.splice(+b.dataset.i, 1); renderFiles(); }));

  $('#uploadBtn').disabled = state.files.length === 0 || state.uploading;
  $('#fileInput').value = '';
}

/* ============================ Upload ============================ */
function uploadOne(file, serviceId, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?service=' + encodeURIComponent(serviceId));
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch (_) { data = { ok: false, error: 'Phản hồi không hợp lệ' }; }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok) resolve(data);
      else reject(new Error(data.error || ('HTTP ' + xhr.status)));
    };
    xhr.onerror = () => reject(new Error('Lỗi kết nối tới máy chủ'));
    xhr.ontimeout = () => reject(new Error('Quá thời gian chờ'));
    xhr.timeout = 30 * 60 * 1000;
    xhr.send(file);
  });
}

// Thu tu thu cac dich vu khi o che do tu dong (uu tien dich vu da kiem tra "ok")
function autoOrder() {
  const preferred = ['gofile', 'filekiwi'];
  return state.services
    .map((s) => s.id)
    .sort((a, b) => {
      const ra = state.status[a] === 'fail' ? 2 : state.status[a] === 'ok' ? 0 : 1;
      const rb = state.status[b] === 'fail' ? 2 : state.status[b] === 'ok' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ia = preferred.indexOf(a); const ib = preferred.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
}

async function startUpload() {
  if (!state.files.length || state.uploading) return;

  closeDropdown();
  const auto = state.selected === AUTO_ID;
  const order = auto ? autoOrder() : [state.selected];
  if (!order.length) return toast('Chưa có dịch vụ khả dụng', 'warn');

  state.uploading = true;
  $('#ddToggle').disabled = true;
  $('#uploadBtn').disabled = true;
  $('#progressWrap').classList.remove('hidden');
  $('#resultSection').classList.remove('hidden');

  const results = [];

  for (let idx = 0; idx < state.files.length; idx++) {
    const file = state.files[idx];
    const base = (idx / state.files.length) * 100;
    const span = 100 / state.files.length;
    let done = false;
    const errors = [];

    for (const svcId of order) {
      const svcName = (serviceById(svcId) || {}).name || svcId;
      setProgress(base, `Đang tải "${file.name}" lên ${svcName}…`);
      try {
        const data = await uploadOne(file, svcId, (p) =>
          setProgress(base + p * span * 0.95, `Đang tải "${file.name}" lên ${svcName}… ${Math.round(p * 100)}%`));
        results.push(data);
        addHistory(data);
        renderResults(results);
        toast(`Tải lên thành công qua ${svcName}`, 'success');
        done = true;
        break;
      } catch (e) {
        errors.push(`${svcName}: ${e.message}`);
        if (!auto) {
          toast('Lỗi: ' + e.message, 'error', 6000);
          break;
        }
        toast(`${svcName} lỗi, thử dịch vụ khác…`, 'warn', 3000);
      }
    }

    if (!done) {
      const detail = errors.join(' | ');
      renderErrorItem(file, detail);
      sendAutoReport(file, detail);
      toast(`Không thể tải "${file.name}" lên bất kỳ dịch vụ nào`, 'error', 6000);
    }
  }

  setProgress(100, 'Hoàn tất');
  state.uploading = false;
  closeDropdown();
  $('#ddToggle').disabled = false;
  state.files = [];
  renderFiles();
  setTimeout(() => { $('#progressWrap').classList.add('hidden'); }, 900);
}

function setProgress(pct, label) {
  const p = Math.max(0, Math.min(100, pct));
  $('#progressFill').style.width = p + '%';
  $('#progressPct').textContent = Math.round(p) + '%';
  if (label) $('#progressLabel').textContent = label;
}

/* ============================ Ket qua ============================ */
function renderResults(list) {
  const wrap = $('#results');
  wrap.innerHTML = list.map((r) => `
    <div class="result-item">
      <div class="result-head">
        <div>
          <div class="result-name">📄 ${escapeHtml(r.filename)}</div>
          <div class="result-meta">Qua ${escapeHtml(r.serviceName)} · ${r.sizeText} · ${(r.elapsedMs / 1000).toFixed(1)}s</div>
        </div>
      </div>
      <div class="link-row">
        <input readonly value="${escapeHtml(r.url)}" />
        <button class="ghost-btn small" data-copy="${escapeHtml(r.url)}">📋 Copy</button>
      </div>
      <div class="result-actions">
        <a class="ghost-btn small" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">🔗 Mở link</a>
        ${r.directUrl ? `<a class="ghost-btn small" href="/api/download?url=${encodeURIComponent(r.directUrl)}&name=${encodeURIComponent(r.filename)}">⬇️ Tải trực tiếp</a>` : ''}
      </div>
      ${r.note ? `<div class="result-note">ℹ️ ${escapeHtml(r.note)}</div>` : ''}
    </div>`).join('');

  wrap.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy).then(
        () => toast('Đã copy link', 'success'),
        () => toast('Không copy được, hãy copy thủ công', 'warn')
      );
    }));
}

function renderErrorItem(file, detail) {
  const wrap = $('#results');
  const div = document.createElement('div');
  div.className = 'result-item';
  div.style.background = 'color-mix(in srgb, var(--danger) 8%, transparent)';
  div.innerHTML = `
    <div class="result-name">❌ ${escapeHtml(file.name)}</div>
    <div class="result-note" style="color:var(--danger)">${escapeHtml(detail)}</div>
    <div class="result-actions">
      <button class="ghost-btn small" data-report>🐞 Báo lỗi cho tôi</button>
    </div>`;
  div.querySelector('[data-report]').addEventListener('click', () => openReport(`Lỗi khi tải "${file.name}": ${detail}`));
  wrap.appendChild(div);
}

function addHistory(data) {
  state.history.unshift(data);
  renderHistory();
}

function renderHistory() {
  const el = $('#history');
  if (!state.history.length) {
    el.innerHTML = '<p class="muted">Chưa có file nào được tải lên trong phiên này.</p>';
    return;
  }
  el.innerHTML = state.history.map((h) => `
    <div class="hist-item">
      <span class="hname" title="${escapeHtml(h.filename)}">📄 ${escapeHtml(h.filename)}</span>
      <span class="muted">${escapeHtml(h.serviceName)} · ${h.sizeText}</span>
      <a href="${escapeHtml(h.url)}" target="_blank" rel="noopener">Mở</a>
    </div>`).join('');
}

/* ============================ Tai tu link ============================ */
function initDownload() {
  $('#dlBtn').addEventListener('click', () => {
    const url = $('#dlUrl').value.trim();
    if (!url) return toast('Hãy dán link cần tải', 'warn');
    const name = decodeURIComponent((url.split('/').pop() || 'download').split('?')[0]);
    const a = document.createElement('a');
    a.href = `/api/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`;
    a.click();
    toast('Đang bắt đầu tải xuống…', 'info');
  });
}

/* ============================ Bao loi ============================ */
function openReport(prefill) {
  $('#reportModal').classList.remove('hidden');
  $('#reportMessage').value = prefill || '';
  if (state.selected && state.selected !== AUTO_ID) $('#reportService').value = state.selected;
}

function initReport() {
  $('#reportBtn').addEventListener('click', () => openReport());
  $('#reportModal').querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => $('#reportModal').classList.add('hidden')));

  $('#reportSubmit').addEventListener('click', async () => {
    const message = $('#reportMessage').value.trim();
    if (!message) return toast('Hãy nhập nội dung báo lỗi', 'warn');
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          email: $('#reportEmail').value.trim(),
          service: $('#reportService').value,
          context: navigator.userAgent,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        toast(data.message || 'Đã gửi báo lỗi', 'success');
        $('#reportModal').classList.add('hidden');
      } else {
        toast(data.error || 'Gửi thất bại', 'error');
      }
    } catch (e) {
      toast('Không gửi được báo lỗi: ' + e.message, 'error');
    }
  });
}

// Tu dong gui bao cao khi that bai (khong lam phien nguoi dung)
function sendAutoReport(file, detail) {
  fetch('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Tự động: upload thất bại trên mọi dịch vụ',
      service: 'auto',
      context: `file=${file.name} size=${file.size} | ${detail}`,
    }),
  }).catch(() => {});
}

/* ============================ Khoi tao ============================ */
function init() {
  initTheme();
  initDropzone();
  initDownload();
  initReport();

  $('#uploadBtn').addEventListener('click', startUpload);
  $('#checkServices').addEventListener('click', checkServices);
  $('#clearFiles').addEventListener('click', () => { state.files = []; renderFiles(); });
  $('#clearResult').addEventListener('click', () => { $('#resultSection').classList.add('hidden'); $('#results').innerHTML = ''; });
  $('#clearHistory').addEventListener('click', () => { state.history = []; renderHistory(); });

  // Dropdown: mo/dong
  $('#ddToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('#ddMenu').classList.contains('hidden')) openDropdown(); else closeDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!$('#serviceDropdown').contains(e.target)) closeDropdown();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdown(); });

  loadServices();
}

document.addEventListener('DOMContentLoaded', init);
