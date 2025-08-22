/** @type {import('next').NextConfig} */
const path = require('path')

let extraIncludes = []
try {
  const ffmpegPath = require('ffmpeg-static')
  if (ffmpegPath) extraIncludes.push(path.relative(process.cwd(), ffmpegPath))
} catch {}
try {
  const ffprobe = require('ffprobe-static')
  if (ffprobe?.path) extraIncludes.push(path.relative(process.cwd(), ffprobe.path))
} catch {}

module.exports = {
  experimental: {
    outputFileTracingIncludes: {
      'app/api/render/route.ts': [
        'node_modules/ffmpeg-static/**',
        'node_modules/ffprobe-static/**',
        'node_modules/@ffmpeg-installer/**',
        'node_modules/@ffprobe-installer/**',
        ...extraIncludes,
      ],
      'lib/renderVideo.ts': [
        'node_modules/ffmpeg-static/**',
        'node_modules/ffprobe-static/**',
        'node_modules/@ffmpeg-installer/**',
        'node_modules/@ffprobe-installer/**',
        ...extraIncludes,
      ],
    },
  },
}

