# --- Build CSS (Tailwind) ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV YOUTUBE_DL_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tailwind.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build:css

# --- Runtime (Node + FFmpeg + yt-dlp từ apt, không tải qua GitHub API) ---
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg yt-dlp ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV YOUTUBE_DL_SKIP_DOWNLOAD=1
ENV YT_DLP_PATH=/usr/bin/yt-dlp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.js ./
COPY --from=builder /app/public ./public

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
