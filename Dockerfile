FROM node:20-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg python3 python3-pip python3-venv curl \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages -U "yt-dlp[default]"

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev


FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg python3 python3-pip python3-venv tini \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages -U "yt-dlp[default]"

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    MAX_ACTIVE_DOWNLOADS=2 \
    MAX_FILE_MB=200 \
    MAX_DOWNLOAD_DURATION=1800 \
    NSFW_ENABLED=false \
    AI_PUBLIC_FALLBACK=false

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

EXPOSE 5000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--max-old-space-size=512", "index.js"]
