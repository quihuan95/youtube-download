const $ = (id) => document.getElementById(id);

/** Rỗng = gọi API cùng domain (deploy Nginx/aaPanel/AWS). Khác domain thì set trong index.html */
const API_BASE = (window.API_BASE || '').replace(/\/$/, '');
/** URL hiển thị = địa chỉ trên thanh trình duyệt (Render, VPS, local…) */
const appOrigin = window.location.origin;
const apiOrigin = API_BASE || appOrigin;

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

const state = {
  url: '',
  title: '',
  duration: 0,
  mode: 'video',
  videoFormats: [],
  audioFormats: [],
  fetching: false,
};

const els = {
  url: $('url'),
  btnInfo: $('btnInfo'),
  urlError: $('urlError'),
  serverStatus: $('serverStatus'),
  previewSection: $('previewSection'),
  optionsSection: $('optionsSection'),
  thumbnail: $('thumbnail'),
  videoTitle: $('videoTitle'),
  videoMeta: $('videoMeta'),
  durationHint: $('durationHint'),
  qualityBlock: $('qualityBlock'),
  quality: $('quality'),
  formatIdBlock: $('formatIdBlock'),
  formatId: $('formatId'),
  trimEnabled: $('trimEnabled'),
  trimFields: $('trimFields'),
  startTime: $('startTime'),
  endTime: $('endTime'),
  btnDownload: $('btnDownload'),
  progressBox: $('progressBox'),
  progressBar: $('progressBar'),
  progressLabel: $('progressLabel'),
  progressPct: $('progressPct'),
  downloadError: $('downloadError'),
  fetchStatus: $('fetchStatus'),
};

const FETCH_TIMEOUT_MS = 120_000;

const YT_RE = /(?:youtube\.com|youtu\.be)/i;
let autoFetchTimer = null;

function isYoutubeUrl(s) {
  return YT_RE.test(s || '');
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(el) {
  el.classList.add('hidden');
}

function setFetchStatus(msg) {
  if (!msg) {
    els.fetchStatus.classList.add('hidden');
    els.fetchStatus.textContent = '';
    return;
  }
  els.fetchStatus.textContent = msg;
  els.fetchStatus.classList.remove('hidden');
}

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Quá ${timeoutMs / 1000}s không phản hồi. Kiểm tra server tại ${apiOrigin}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  if (loading) {
    btn.dataset.prev = btn.textContent;
    btn.textContent = label || 'Đang xử lý...';
  } else {
    btn.textContent = btn.dataset.prev || btn.textContent;
  }
}

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (location.protocol === 'file:') {
      throw new Error(
        `Bạn đang mở file HTML trực tiếp. Mở qua server: ${appOrigin}`,
      );
    }
    throw new Error(
      `Không kết nối được API tại ${appOrigin}. Kiểm tra server đang chạy.`,
    );
  }
}

async function checkServer() {
  try {
    const res = await fetch(apiUrl('/api/health'));
    if (!res.ok) throw new Error();
    els.serverStatus.textContent = `● Server sẵn sàng · ${appOrigin}`;
    els.serverStatus.className = 'mt-3 text-xs text-emerald-500/90';
  } catch {
    els.serverStatus.textContent = `● Chưa kết nối API · ${appOrigin}`;
    els.serverStatus.className = 'mt-3 text-xs text-amber-400';
  }
}

function updateModeButtons() {
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    const isActive = btn.dataset.mode === state.mode;
    btn.classList.toggle('btn-primary', isActive);
    btn.classList.toggle('btn-secondary', !isActive);
  });
  els.qualityBlock.classList.toggle('hidden', state.mode === 'mp3');
  populateFormatSelect();
}

function populateFormatSelect() {
  const formats = state.mode === 'mp3' ? state.audioFormats : state.videoFormats;
  els.formatId.innerHTML = '<option value="">Mặc định theo chất lượng</option>';
  formats.forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    els.formatId.appendChild(opt);
  });
  els.formatIdBlock.classList.toggle('hidden', formats.length === 0);
}

function scheduleAutoFetch() {
  clearTimeout(autoFetchTimer);
  const url = els.url.value.trim();
  if (!isYoutubeUrl(url)) return;

  autoFetchTimer = setTimeout(() => {
    if (els.url.value.trim() === url) fetchInfo();
  }, 400);
}

async function fetchInfo() {
  hideError(els.urlError);
  const url = els.url.value.trim();
  if (!url) {
    showError(els.urlError, 'Vui lòng dán link YouTube.');
    return;
  }
  if (!isYoutubeUrl(url)) {
    showError(els.urlError, 'Link phải từ youtube.com hoặc youtu.be');
    return;
  }

  if (state.fetching) return;
  state.fetching = true;
  setLoading(els.btnInfo, true, 'Đang lấy...');
  setFetchStatus('Đang gọi server → yt-dlp lấy metadata (thường 5–30 giây, xem log terminal)...');
  els.url.classList.add('ring-2', 'ring-accent/30');

  try {
    const res = await fetchWithTimeout(apiUrl('/api/info'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await parseJsonResponse(res);
    if (!res.ok) throw new Error(data.error || 'Lỗi không xác định');

    state.url = url;
    state.title = data.title;
    state.duration = data.duration;
    state.videoFormats = data.videoFormats || [];
    state.audioFormats = data.audioFormats || [];

    els.thumbnail.src = data.thumbnail;
    els.thumbnail.alt = data.title;
    els.videoTitle.textContent = data.title;
    els.videoMeta.textContent = [data.uploader, data.durationText].filter(Boolean).join(' · ');
    els.durationHint.textContent = `Thời lượng: ${data.durationText} — nhập mốc cắt trong khoảng này`;

    els.previewSection.classList.remove('hidden');
    els.optionsSection.classList.remove('hidden');
    populateFormatSelect();
    hideError(els.downloadError);
    els.previewSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setFetchStatus('');
  } catch (err) {
    showError(els.urlError, err.message);
    els.previewSection.classList.add('hidden');
    els.optionsSection.classList.add('hidden');
    setFetchStatus('');
  } finally {
    state.fetching = false;
    els.url.classList.remove('ring-2', 'ring-accent/30');
    setLoading(els.btnInfo, false);
    els.btnInfo.textContent = 'Lấy thông tin';
  }
}

function animateProgress() {
  els.progressBox.classList.remove('hidden');
  els.progressBar.style.width = '0%';
  els.progressPct.textContent = '';
  els.progressLabel.textContent = 'Đang tải và xử lý...';

  let pct = 0;
  const timer = setInterval(() => {
    pct = Math.min(pct + Math.random() * 8, 92);
    els.progressBar.style.width = `${pct}%`;
  }, 400);

  return () => {
    clearInterval(timer);
    els.progressBar.style.width = '100%';
    els.progressPct.textContent = '100%';
    els.progressLabel.textContent = 'Hoàn tất!';
    setTimeout(() => els.progressBox.classList.add('hidden'), 1200);
  };
}

async function download() {
  hideError(els.downloadError);
  if (!state.url) {
    showError(els.downloadError, 'Hãy lấy thông tin video trước (dán link và đợi vài giây).');
    return;
  }

  const body = {
    url: state.url,
    title: state.title,
    mode: state.mode,
    quality: els.quality.value,
    formatId: els.formatId.value || undefined,
  };

  if (els.trimEnabled.checked) {
    body.start = els.startTime.value.trim();
    body.end = els.endTime.value.trim();
    if (!body.start || !body.end) {
      showError(els.downloadError, 'Nhập đầy đủ thời gian bắt đầu và kết thúc.');
      return;
    }
  }

  setLoading(els.btnDownload, true, 'Đang tải...');
  const stopProgress = animateProgress();

  try {
    setFetchStatus('Đang tải file — có thể vài phút, xem log terminal...');
    const res = await fetchWithTimeout(
      apiUrl('/api/download'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      600_000,
    );

    if (!res.ok) {
      const err = await parseJsonResponse(res);
      throw new Error(err.error || `Lỗi ${res.status}`);
    }

    const blob = await res.blob();
    const ext = state.mode === 'mp3' ? 'mp3' : 'mp4';
    const safeName = (state.title || 'video').replace(/[<>:"/\\|?*]/g, '').slice(0, 80);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    showError(els.downloadError, err.message);
    els.progressBox.classList.add('hidden');
  } finally {
    setFetchStatus('');
    stopProgress();
    setLoading(els.btnDownload, false);
    els.btnDownload.textContent = 'Tải xuống';
  }
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    updateModeButtons();
  });
});

els.trimEnabled.addEventListener('change', () => {
  const on = els.trimEnabled.checked;
  els.trimFields.classList.toggle('opacity-40', !on);
  els.trimFields.classList.toggle('pointer-events-none', !on);
  els.startTime.disabled = !on;
  els.endTime.disabled = !on;
});

els.btnInfo.addEventListener('click', fetchInfo);
els.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    fetchInfo();
  }
});
els.url.addEventListener('input', scheduleAutoFetch);
els.url.addEventListener('paste', () => {
  setTimeout(scheduleAutoFetch, 50);
});
els.btnDownload.addEventListener('click', download);

updateModeButtons();
checkServer();
