import express from 'express';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import youtubedlExec from 'youtube-dl-exec';

function resolveYtDlpPath() {
  const candidates = [];
  if (process.env.YT_DLP_PATH) candidates.push(process.env.YT_DLP_PATH);
  candidates.push('/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp');
  candidates.push(youtubedlExec.constants.YOUTUBE_DL_PATH);

  try {
    const cmd = process.platform === 'win32' ? 'where yt-dlp' : 'command -v yt-dlp';
    const found = execSync(cmd, { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (found) candidates.unshift(found);
  } catch {
    /* not on PATH */
  }

  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return process.env.YT_DLP_PATH || youtubedlExec.constants.YOUTUBE_DL_PATH;
}

const ytDlpPath = resolveYtDlpPath();
const youtubedl = youtubedlExec.create(ytDlpPath);

const app = express();
const PORT = Number(process.env.PORT) || 3008;
const HOST = process.env.HOST || '0.0.0.0';
const TMP_DIR = join(process.cwd(), 'tmp');

if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

app.use(express.json());

const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
app.use((req, res, next) => {
  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) log('→', req.method, req.path);
  next();
});
app.use(express.static('public'));

const COOKIES_RUNTIME_PATH = join(TMP_DIR, 'youtube-cookies.txt');

function normalizeCookiesText(raw) {
  let s = raw.trim();
  if (s.includes('\\n') && !s.includes('\n')) {
    s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  return s;
}

function validateCookiesContent(content) {
  if (!content.includes('.youtube.com')) {
    return 'cookies thiếu domain .youtube.com';
  }
  const dataLines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  if (dataLines.length === 0) return 'cookies không có dòng dữ liệu';
  if (!dataLines[0].includes('\t')) {
    return 'cookies sai định dạng (mất TAB) — export lại Netscape hoặc dùng YOUTUBE_COOKIES_B64';
  }
  return null;
}

function initCookiesFile() {
  if (process.env.YOUTUBE_COOKIES_PATH && existsSync(process.env.YOUTUBE_COOKIES_PATH)) {
    return process.env.YOUTUBE_COOKIES_PATH;
  }
  const configPath = join(process.cwd(), 'config', 'cookies.txt');
  if (existsSync(configPath)) return configPath;

  let raw = '';
  if (process.env.YOUTUBE_COOKIES_B64?.trim()) {
    try {
      raw = Buffer.from(process.env.YOUTUBE_COOKIES_B64.trim(), 'base64').toString('utf8');
    } catch {
      log('WARN: YOUTUBE_COOKIES_B64 không decode được (base64 sai)');
    }
  } else if (process.env.YOUTUBE_COOKIES?.trim()) {
    raw = process.env.YOUTUBE_COOKIES;
  }

  if (!raw) return null;

  const normalized = normalizeCookiesText(raw);
  const invalid = validateCookiesContent(normalized);
  if (invalid) {
    log('WARN: cookies —', invalid);
    return null;
  }

  writeFileSync(COOKIES_RUNTIME_PATH, normalized, 'utf8');
  return COOKIES_RUNTIME_PATH;
}

const cookiesFile = initCookiesFile();

function getYtDlpVersion() {
  try {
    return execSync(`"${ytDlpPath}" --version`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function getYtDlpOpts(extra = {}) {
  const opts = {
    noCheckCertificates: true,
    noWarnings: true,
    preferFreeFormats: true,
    ...extra,
  };
  if (cookiesFile && existsSync(cookiesFile)) {
    opts.cookies = cookiesFile;
    opts.extractorArgs = 'youtube:player_client=web,ios,tv_embedded';
  } else {
    opts.extractorArgs = 'youtube:player_client=android_sdkless,web,tv_embedded,mweb';
  }
  return opts;
}

/** Lấy metadata — không chọn chất lượng, không preferFreeFormats (tránh lỗi format khi chỉ bấm "Lấy thông tin") */
const INFO_PLAYER_CLIENTS = [
  'youtube:player_client=android_sdkless,web,tv_embedded,mweb',
  'youtube:player_client=web,ios,tv_embedded',
  'youtube:player_client=mweb,web',
  null,
];

async function fetchVideoInfo(url) {
  const base = {
    dumpSingleJson: true,
    skipDownload: true,
    noCheckCertificates: true,
    noWarnings: true,
    noPlaylist: true,
  };
  if (cookiesFile && existsSync(cookiesFile)) base.cookies = cookiesFile;

  let lastErr;
  for (let i = 0; i < INFO_PLAYER_CLIENTS.length; i++) {
    const client = INFO_PLAYER_CLIENTS[i];
    const opts = { ...base };
    if (client) opts.extractorArgs = client;
    try {
      return await youtubedl(url, opts);
    } catch (err) {
      lastErr = err;
      const detail = extractYtDlpDetail(err);
      const retryable = /format is not available|not a bot|sign in to confirm|unable to extract/i.test(detail);
      if (!retryable || i === INFO_PLAYER_CLIENTS.length - 1) throw err;
      log('yt-dlp info: thử client khác...', client || 'mặc định');
    }
  }
  throw lastErr;
}

function extractYtDlpDetail(err) {
  if (err?.code === 'ENOENT' || /ENOENT/i.test(err?.message || '')) {
    const target = err?.path || ytDlpPath || 'yt-dlp / cookies';
    return `ENOENT — không tìm thấy: ${target}. Kiểm tra yt-dlp đã cài (Docker rebuild) hoặc cookies (YOUTUBE_COOKIES_B64).`;
  }
  const chunks = [err?.stderr, err?.stdout, err?.message];
  if (err && typeof err === 'object') {
    for (const key of ['stderr', 'stdout', 'status', 'signal', 'code']) {
      if (err[key] != null) chunks.push(String(err[key]));
    }
  }
  const text = chunks
    .filter((c) => c && String(c).trim() && String(c).trim() !== 'Error')
    .join('\n')
    .trim();
  if (text) return text.slice(0, 800);
  return 'yt-dlp thất bại (không có stderr — kiểm tra cookies / phiên bản yt-dlp)';
}

function formatYtError(err, phase = 'download') {
  const detail = extractYtDlpDetail(err);
  if (/Requested format is not available|format is not available/i.test(detail)) {
    if (phase === 'info') {
      return 'YouTube không trả metadata từ server (Render). Không liên quan chất lượng bạn chọn — thử chạy local (npm run dev) hoặc VPS.';
    }
    return 'Chất lượng/format này không có cho video. Chọn "Tốt nhất" hoặc thử lại.';
  }
  if (/sign in to confirm|not a bot|confirm you.?re not/i.test(detail)) {
    return cookiesFile
      ? 'YouTube vẫn chặn dù đã có cookies — export cookies mới hoặc dùng YOUTUBE_COOKIES_B64.'
      : 'YouTube chặn IP server (Render). Thêm YOUTUBE_COOKIES hoặc deploy VPS. Xem DEPLOY.md';
  }
  if (/cookies|netscape/i.test(detail)) {
    return 'File cookies lỗi. Dùng YOUTUBE_COOKIES_B64 (base64) trên Render. Xem DEPLOY.md';
  }
  if (err?.message?.includes('quá')) return err.message;
  const firstLine = detail.split('\n').find((l) => l.trim()) || detail;
  return firstLine.slice(0, 300);
}

const YTDL_TIMEOUT_MS = 120_000;

function log(...args) {
  const t = new Date().toLocaleTimeString('vi-VN');
  console.log(`[${t}]`, ...args);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} quá ${ms / 1000}s — thử link khác hoặc chạy lại.`)), ms);
    }),
  ]);
}

function parseYoutubeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  const match = s.match(
    /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i,
  );
  if (match) return `https://www.youtube.com/watch?v=${match[1]}`;

  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^(www\.|m\.)?youtube\.com$/i.test(u.hostname) && !/^youtu\.be$/i.test(u.hostname)) {
      return null;
    }
    if (u.hostname === 'youtu.be' && u.pathname.length > 1) {
      return `https://www.youtube.com/watch?v=${u.pathname.slice(1).split('/')[0]}`;
    }
    return u.href;
  } catch {
    return null;
  }
}

function parseTimeToSeconds(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function formatLabel(f) {
  const h = f.height ? `${f.height}p` : null;
  const ext = f.ext || '';
  const note = f.format_note || '';
  const fps = f.fps ? `${f.fps}fps` : '';
  return [h, note, fps, ext].filter(Boolean).join(' · ') || f.format_id;
}

function pickFormats(formats, type) {
  const list = formats || [];
  if (type === 'audio') {
    return list
      .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))
      .slice(0, 8)
      .map((f) => ({
        id: f.format_id,
        label: `${f.abr || '?'}kbps · ${f.ext}`,
        ext: f.ext,
      }));
  }
  const video = list
    .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
    .sort((a, b) => b.height - a.height || (b.fps || 0) - (a.fps || 0));

  const seen = new Set();
  const unique = [];
  for (const f of video) {
    const key = `${f.height}-${f.ext}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      id: f.format_id,
      label: formatLabel(f),
      height: f.height,
      ext: f.ext,
    });
  }
  return unique.slice(0, 12);
}

function qualityToFormatString(quality, mode) {
  const fb = '/bestvideo*+bestaudio/bestvideo+bestaudio/best';
  if (mode === 'mp3') return 'bestaudio*/bestaudio/best';
  switch (quality) {
    case '2160':
      return `bestvideo[height<=2160]+bestaudio/best[height<=2160]${fb}`;
    case '1440':
      return `bestvideo[height<=1440]+bestaudio/best[height<=1440]${fb}`;
    case '1080':
      return `bestvideo[height<=1080]+bestaudio/best[height<=1080]${fb}`;
    case '720':
      return `bestvideo[height<=720]+bestaudio/best[height<=720]${fb}`;
    case '480':
      return `bestvideo[height<=480]+bestaudio/best[height<=480]${fb}`;
    case '360':
      return `bestvideo[height<=360]+bestaudio/best[height<=360]${fb}`;
    case 'best':
    default:
      return `bestvideo*+bestaudio/bestvideo+bestaudio/best`;
  }
}

function isFormatUnavailableError(err) {
  return /Requested format is not available|format is not available/i.test(extractYtDlpDetail(err));
}

async function runYtDlp(url, opts, { mode = 'video' } = {}) {
  try {
    return await youtubedl(url, opts);
  } catch (err) {
    if (!isFormatUnavailableError(err)) throw err;
    log('yt-dlp: format không khả dụng, thử fallback best...');
    const fallback = { ...opts };
    if (mode === 'mp3') {
      fallback.format = 'bestaudio/best';
    } else {
      fallback.format = 'best';
      fallback.mergeOutputFormat = 'mp4';
    }
    return youtubedl(url, fallback);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    cookies: Boolean(cookiesFile),
    ytDlp: getYtDlpVersion(),
  });
});

app.post('/api/info', async (req, res) => {
  const url = parseYoutubeUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: 'Link YouTube không hợp lệ.' });

  const t0 = Date.now();
  log('yt-dlp: lấy thông tin...', url);

  try {
    const info = await withTimeout(fetchVideoInfo(url), YTDL_TIMEOUT_MS, 'Lấy thông tin');

    const duration = info.duration || 0;
    const videoFormats = pickFormats(info.formats, 'video');
    const audioFormats = pickFormats(info.formats, 'audio');

    log(`yt-dlp: xong (${((Date.now() - t0) / 1000).toFixed(1)}s) —`, info.title);

    res.json({
      id: info.id,
      title: info.title,
      thumbnail: info.thumbnail,
      duration,
      durationText: formatDuration(duration),
      uploader: info.uploader || info.channel,
      videoFormats,
      audioFormats,
    });
  } catch (err) {
    log('yt-dlp LỖI:', extractYtDlpDetail(err));
    res.status(500).json({ error: formatYtError(err, 'info') });
  }
});

app.post('/api/download', async (req, res) => {
  const url = parseYoutubeUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: 'Link YouTube không hợp lệ.' });

  const mode = req.body?.mode === 'mp3' ? 'mp3' : 'video';
  const quality = req.body?.quality || 'best';
  const formatId = req.body?.formatId;
  const startSec = parseTimeToSeconds(req.body?.start);
  const endSec = parseTimeToSeconds(req.body?.end);

  if (startSec !== null && endSec !== null && endSec <= startSec) {
    return res.status(400).json({ error: 'Thời gian kết thúc phải lớn hơn thời gian bắt đầu.' });
  }

  const id = randomUUID();
  const outTemplate = join(TMP_DIR, `${id}.%(ext)s`);
  const opts = getYtDlpOpts({
    output: outTemplate,
    noPlaylist: true,
  });

  if (formatId) {
    opts.format =
      mode === 'mp3'
        ? `${formatId}/bestaudio/best`
        : `${formatId}+bestaudio/bestvideo*+bestaudio/best`;
  } else if (mode === 'mp3') {
    opts.format = 'bestaudio*/bestaudio/best';
    opts.extractAudio = true;
    opts.audioFormat = 'mp3';
    opts.audioQuality = '0';
  } else {
    opts.format = qualityToFormatString(quality, mode);
    opts.mergeOutputFormat = 'mp4';
  }

  if (startSec !== null && endSec !== null) {
    opts.downloadSections = `*${startSec}-${endSec}`;
    opts.forceKeyframesAtCuts = true;
  } else if (startSec !== null || endSec !== null) {
    return res.status(400).json({ error: 'Nhập cả thời gian bắt đầu và kết thúc để cắt video.' });
  }

  const t0 = Date.now();
  log('yt-dlp: đang tải...', url, mode, quality);

  try {
    await withTimeout(runYtDlp(url, opts, { mode }), YTDL_TIMEOUT_MS * 3, 'Tải video');

    const { readdirSync } = await import('fs');
    const files = readdirSync(TMP_DIR).filter((f) => f.startsWith(id));
    if (!files.length) {
      return res.status(500).json({ error: 'Tải xong nhưng không tìm thấy file.' });
    }

    const fileName = files[0];
    const filePath = join(TMP_DIR, fileName);
    const ext = mode === 'mp3' ? 'mp3' : fileName.split('.').pop() || 'mp4';
    const safeTitle = (req.body?.title || 'video')
      .replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF.-]/gi, '')
      .slice(0, 80)
      .trim() || 'video';
    const downloadName = `${safeTitle}.${ext}`;

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    res.setHeader('Content-Type', mode === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    const { createReadStream } = await import('fs');
    const readStream = createReadStream(filePath);

    readStream.on('close', () => {
      try {
        unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    });

    log(`yt-dlp: tải xong (${((Date.now() - t0) / 1000).toFixed(1)}s) — gửi file`);
    await pipeline(readStream, res);
  } catch (err) {
    log('yt-dlp LỖI tải:', extractYtDlpDetail(err));
    if (!res.headersSent) {
      res.status(500).json({ error: formatYtError(err) });
    }
  }
});

function formatDuration(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getPublicUrl() {
  const fromEnv =
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_URL ||
    (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : '');
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (HOST === '0.0.0.0' || HOST === '::') return `http://localhost:${PORT}`;
  return `http://${HOST}:${PORT}`;
}

if (!existsSync(ytDlpPath)) {
  log('❌ ENOENT — không tìm thấy yt-dlp tại:', ytDlpPath);
  log('Local: npm install (không set YOUTUBE_DL_SKIP_DOWNLOAD). Render: rebuild Docker image.');
  process.exit(1);
}

const server = app.listen(PORT, HOST, () => {
  const publicUrl = getPublicUrl();
  log(`Tool Video sẵn sàng → ${publicUrl}`);
  if (publicUrl.includes('localhost')) {
    log(`(Nội bộ: ${HOST}:${PORT} — Render/Fly dùng biến RENDER_EXTERNAL_URL / PUBLIC_URL)`);
  }
  log('yt-dlp:', ytDlpPath, getYtDlpVersion() ? `v${getYtDlpVersion()}` : '');
  if (cookiesFile) {
    const lines = readFileSync(cookiesFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    log('cookies: có —', lines.length, 'dòng');
  } else {
    log('cookies: không — YouTube có thể chặn IP Render');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`❌ Cổng ${PORT} đã bị chiếm! Chạy: npm run stop   rồi npm run dev`);
    process.exit(1);
  }
  log('❌ Lỗi server:', err.message);
  process.exit(1);
});
