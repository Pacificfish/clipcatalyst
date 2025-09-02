FROM node:20-slim

# Install ffmpeg and ffprobe
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Copy only the worker package manifests from the repo root context
COPY worker/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy only the worker sources
COPY worker/. .

ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe
ENV UV_THREADPOOL_SIZE=8

EXPOSE 8080
CMD ["node", "server.js"]

