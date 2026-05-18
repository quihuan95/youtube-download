# Deploy Tool Video (miễn phí)

Tool cần **Node.js + FFmpeg + yt-dlp** và thời gian xử lý **vài phút** mỗi lần tải. Không deploy được lên Vercel / Netlify (chỉ static/serverless).

## So sánh nhanh

| Nền tảng | Free | Phù hợp tải video? | Độ khó |
|----------|------|-------------------|--------|
| **Fly.io** | Có (giới hạn/tháng) | Khá ổn | Trung bình |
| **Oracle Cloud VPS** | Always Free | Rất tốt | Khó hơn |
| **Render** | Có | Kém (timeout ~30s) | Dễ |
| **aaPanel (VPS)** | VPS trả phí/free | **Rất tốt** | Dễ (nếu đã quen panel) |
| Vercel / Netlify | — | Không dùng được | — |

**Khuyến nghị:** **aaPanel / VPS** (ổn định nhất) · Fly.io (không cần VPS) · Oracle free VPS.

---

## Chuẩn bị chung

1. Đẩy code lên **GitHub** (repo public hoặc private).
2. Cài **Docker Desktop** (nếu test local): `docker build -t tool-video .` rồi `docker run -p 3000:3000 tool-video`.
3. Chỉ dùng tool với nội dung bạn có quyền tải.

---

## Cách 1: aaPanel (VPS + panel) — rất phù hợp

Nếu bạn đã có **VPS** (VN, Singapore, …) cài **aaPanel** thì đây là cách **ổn định nhất**: không bị timeout 30s như Render, RAM/CPU tùy gói VPS.

### Yêu cầu VPS

- Ubuntu 20/22 hoặc Debian (aaPanel hỗ trợ)
- Tối thiểu **1 GB RAM** (tải 720p/1080p nên **2 GB**)
- Mở port **80, 443** (và 8888 panel nếu cần)

### Bước 1 — Cài thêm trên aaPanel

1. **App Store** → cài **Nginx** (thường đã có).
2. **App Store** → cài **PM2 Manager** (hoặc **Node.js** version **18+** / **22**).
3. **Terminal** (SSH hoặc terminal trong panel):

```bash
# FFmpeg (bắt buộc)
apt update && apt install -y ffmpeg

ffmpeg -version   # phải thấy version
```

### Bước 2 — Đưa code lên server

**Cách A — Git (khuyên dùng):**

```bash
cd /www/wwwroot
git clone https://github.com/<user>/tool-video.git
cd tool-video
npm install
npm run build:css
```

**Cách B — Nén zip upload** qua **Files** trong aaPanel → giải nén vào `/www/wwwroot/tool-video` → Terminal:

```bash
cd /www/wwwroot/tool-video
npm install
npm run build:css
```

### Bước 3 — Chạy bằng PM2

Trong thư mục project:

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # làm theo lệnh in ra để tự chạy khi reboot
```

App chạy nội bộ tại `http://127.0.0.1:3008` (đổi `PORT` trong `ecosystem.config.cjs` nếu cần).

Kiểm tra: `curl http://127.0.0.1:3008/api/health`

### Bước 4 — Website + domain (Nginx reverse proxy)

1. aaPanel → **Website** → **Add site**
2. Domain: `tool.example.com` (hoặc dùng IP tạm)
3. Root: có thể để mặc định (không serve static từ đây)
4. Vào site → **Config** (hoặc **Reverse proxy**) → thêm:

```nginx
location / {
    proxy_pass http://127.0.0.1:3008;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;
    proxy_connect_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 100m;
}
```

`proxy_read_timeout 600s` — **quan trọng** để tải video dài không bị Nginx cắt giữa chừng.

5. **SSL** → Let's Encrypt → bật HTTPS.

Mở `https://tool.example.com` → dùng như local.

### Bước 5 — Firewall

- aaPanel **Security** / **Firewall**: mở **80, 443**
- **Không** cần mở port 3008 ra internet (chỉ Nginx proxy localhost)

### Docker trên aaPanel (tuỳ chọn)

aaPanel có **Docker** → build image từ `Dockerfile` → map `-p 127.0.0.1:3008:3000` → Nginx proxy như trên.

### Lỗi thường gặp trên aaPanel

| Lỗi | Xử lý |
|-----|--------|
| 502 Bad Gateway | `pm2 status` — app có chạy? `pm2 logs tool-video` |
| Tải giữa chừng bị ngắt | Tăng `proxy_read_timeout` trong Nginx |
| yt-dlp lỗi | `pm2 logs` — thử `npm update youtube-dl-exec` trên server |
| Hết RAM | VPS 2GB+ hoặc hạn chế tải 720p |

---

## Cách 2: Fly.io (không cần VPS)

### Bước 1 — Cài Fly CLI

Windows (PowerShell):

```powershell
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

Hoặc: https://fly.io/docs/hands-on/install-flyctl/

### Bước 2 — Đăng ký & đăng nhập

```powershell
fly auth signup
fly auth login
```

### Bước 3 — Deploy từ thư mục project

```powershell
cd d:\Code\minh\tool-video
fly launch --no-deploy
```

- Chọn region **Singapore (sin)** gần VN.
- Khi hỏi tạo Postgres/Redis → **No**.
- File `fly.toml` đã có sẵn.

Đổi tên app (nếu cần) trong `fly.toml`: `app = 'ten-app-cua-ban'`.

```powershell
fly deploy
```

### Bước 4 — Mở web

```powershell
fly open
```

URL dạng: `https://tool-video.fly.dev`

### Lệnh hữu ích

```powershell
fly logs          # xem log (giống terminal local)
fly status
fly scale memory 1024   # đủ RAM cho FFmpeg (nếu báo OOM)
```

**Lưu ý Fly free:** máy có thể **tắt khi không dùng** → lần mở đầu chờ ~10–30s. Tải video tốn RAM; `fly.toml` đã set 1GB.

---

## Cách 3: Render.com (dễ, hạn chế)

**Bắt buộc Runtime: Docker** (đọc `Dockerfile`) — **không** chọn Native Node.

Lỗi `API rate limit exceeded` (GitHub): Dockerfile cài yt-dlp qua `pip`, bỏ qua tải GitHub khi `npm install`.

### Lỗi YouTube: "Sign in to confirm you're not a bot"

YouTube **chặn IP datacenter** (Render, AWS, Fly…). Cách xử lý:

**Cách A — Cookies (giữ Render):**

1. Trên máy bạn, đăng nhập YouTube trên Chrome.
2. Cài extension **Get cookies.txt LOCALLY** → export `youtube.com` → file `.txt`.
3. Render → Service → **Environment** → **Add Secret**:
   - Key: `YOUTUBE_COOKIES`
   - Value: dán **toàn bộ** nội dung file cookies (định dạng Netscape).
4. Redeploy.

**Cách B — VPS / aaPanel (khuyên dùng):** IP thường ít bị chặn hơn Render free.

**Cách C — Chỉ dùng local:** `npm run dev` trên máy nhà (IP residential).

1. Vào https://render.com → đăng ký (GitHub).
2. **New +** → **Blueprint** hoặc **Web Service**.
3. Connect repo GitHub → chọn repo `tool-video`.
4. **Runtime: Docker** (Render đọc `Dockerfile`).
5. Region: **Singapore**.
6. Plan: **Free** → Create.
7. Push code mới → **Manual Deploy** (hoặc auto deploy từ GitHub).

Sau khi deploy, mở URL `https://xxx.onrender.com`.

Nếu vẫn lỗi GitHub khi build: thêm env `GITHUB_TOKEN` (Personal Access Token, quyền read).

**Hạn chế free Render:**

- HTTP **timeout ~30 giây** → tải MP3/video dài dễ lỗi giữa chừng.
- Máy **sleep** sau ~15 phút không truy cập → cold start chậm.

Phù hợp thử UI + lấy thông tin video; **không ổn** cho tải file lớn.

---

## Cách 4: Oracle Cloud — VPS free vĩnh viễn

Phù hợp nhất nếu bạn cần tải video ổn định, không bị timeout PaaS.

1. Đăng ký https://www.oracle.com/cloud/free/
2. Tạo VM **Ubuntu 22.04** (Always Free: ARM Ampere 4 OCPU / 24GB RAM).
3. Mở firewall: port **3000** (hoặc 80 + Nginx).
4. SSH vào máy:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git
sudo systemctl enable docker --now

git clone https://github.com/<user>/tool-video.git
cd tool-video
docker build -t tool-video .
docker run -d --name tool-video --restart unless-stopped -p 3000:3000 tool-video
```

5. Truy cập: `http://<IP-public>:3000`

**HTTPS (tuỳ chọn):** cài Caddy/Nginx + domain trỏ về IP.

---

## Biến môi trường

| Biến | Mặc định | Mô tả |
|------|----------|--------|
| `PORT` | `3000` (cloud) / `3008` (local) | Cổng HTTP |
| `HOST` | `0.0.0.0` | Bắt buộc trên Docker/cloud |

---

## Sửa lỗi thường gặp

| Triệu chứng | Cách xử lý |
|-------------|------------|
| Build Docker lỗi | Chạy `docker build -t tool-video .` local xem log |
| 502 / timeout khi tải | Dùng Fly 1GB RAM hoặc VPS; tránh Render free cho file lớn |
| yt-dlp lỗi | Xem `fly logs` / log Render; YouTube đôi khi chặn IP datacenter |
| OOM killed | `fly scale memory 1024` hoặc VPS lớn hơn |

---

## Test local trước khi deploy

```powershell
docker build -t tool-video .
docker run --rm -p 3000:3000 tool-video
```

Mở http://localhost:3000
