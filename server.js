import express from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import youtubedl from 'youtube-dl-exec';

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

const YTDL_OPTS = {
  noCheckCertificates: true,
  noWarnings: true,
  preferFreeFormats: true,
  addHeader: ['referer:youtube.com', 'user-agent:googlebot'],
};

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
  if (mode === 'mp3') return 'bestaudio/best';
  switch (quality) {
    case '2160':
      return 'bestvideo[height<=2160]+bestaudio/best[height<=2160]';
    case '1440':
      return 'bestvideo[height<=1440]+bestaudio/best[height<=1440]';
    case '1080':
      return 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
    case '720':
      return 'bestvideo[height<=720]+bestaudio/best[height<=720]';
    case '480':
      return 'bestvideo[height<=480]+bestaudio/best[height<=480]';
    case '360':
      return 'bestvideo[height<=360]+bestaudio/best[height<=360]';
    case 'best':
    default:
      return 'bestvideo+bestaudio/best';
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/info', async (req, res) => {
  const url = parseYoutubeUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: 'Link YouTube không hợp lệ.' });

  const t0 = Date.now();
  log('yt-dlp: lấy thông tin...', url);

  try {
    const info = await withTimeout(
      youtubedl(url, {
        ...YTDL_OPTS,
        dumpSingleJson: true,
        skipDownload: true,
      }),
      YTDL_TIMEOUT_MS,
      'Lấy thông tin',
    );

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
    const detail = err?.stderr || err?.message || String(err);
    log('yt-dlp LỖI:', detail);
    res.status(500).json({
      error: err.message?.includes('quá')
        ? err.message
        : 'Không lấy được thông tin video. Xem log terminal hoặc thử link khác.',
    });
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
  const opts = {
    ...YTDL_OPTS,
    output: outTemplate,
    noPlaylist: true,
  };

  if (formatId) {
    opts.format = formatId;
  } else if (mode === 'mp3') {
    opts.format = 'bestaudio/best';
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
    await withTimeout(youtubedl(url, opts), YTDL_TIMEOUT_MS * 3, 'Tải video');

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
    log('yt-dlp LỖI tải:', err?.stderr || err.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Tải thất bại. Video có thể bị giới hạn hoặc cần cập nhật yt-dlp.',
      });
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

const server = app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  log(`Tool Video sẵn sàng → ${shown}`);
  log('Dán link trên web — mỗi request sẽ hiện log ở đây');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`❌ Cổng ${PORT} đã bị chiếm! Chạy: npm run stop   rồi npm run dev`);
    process.exit(1);
  }
  log('❌ Lỗi server:', err.message);
  process.exit(1);
});
