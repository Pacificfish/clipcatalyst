import express from 'express'
import cors from 'cors'
import { spawn } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const PORT = Number(process.env.PORT || 3009)
const PUBLIC_BASE = String(process.env.PUBLIC_BASE || '').replace(/\/$/, '')
const downloadsDir = path.join(process.cwd(), 'downloads')
try { fs.mkdirSync(downloadsDir, { recursive: true }) } catch {}

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))
app.get('/healthz', (_req, res) => res.send('ok'))
app.get('/diag', (_req, res) => {
  res.json({
    port: PORT,
    public_base: PUBLIC_BASE,
    downloadsDir,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch
  })
})

// Serve completed files at /files/*
app.use('/files', express.static(downloadsDir, { fallthrough: false }))

function runYtDlpToFile(youtubeUrl, outPath) {
  return new Promise((resolve) => {
    const format = process.env.FORMAT || "bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/best"
    const args = [
      '--ignore-config','--no-playlist','--no-continue','--no-part','--no-call-home',
      '--merge-output-format','mp4',
      '--cookies-from-browser','chrome',
      '-f', format,
      '-o', outPath,
      youtubeUrl
    ]
    const proc = spawn('yt-dlp', args, { stdio: ['ignore','pipe','pipe'] })
    proc.stdout.on('data', d => process.stdout.write(d))
    proc.stderr.on('data', d => process.stderr.write(d))
    proc.on('error', (e) => resolve({ ok: false, code: -1, error: String(e?.message || e) }))
    proc.on('exit', (code) => resolve({ ok: code === 0, code }))
  })
}

app.post('/download_youtube', async (req, res) => {
  try {
    const youtube_url = String((req.body && req.body.youtube_url) || '').trim()
    if (!youtube_url) return res.status(400).json({ error: 'youtube_url is required' })

    const tmpOut = path.join(os.tmpdir(), `${crypto.randomUUID()}.mp4`)
    const r = await runYtDlpToFile(youtube_url, tmpOut)
    if (!r.ok) return res.status(502).json({ error: 'yt-dlp failed', details: String(r.error || r.code || 'unknown') })

    const fileName = `${Date.now()}-${crypto.randomUUID()}.mp4`
    const finalPath = path.join(downloadsDir, fileName)
    try { fs.renameSync(tmpOut, finalPath) } catch (e) {
      try { fs.copyFileSync(tmpOut, finalPath) } catch {}
      try { fs.unlinkSync(tmpOut) } catch {}
    }

    const base = PUBLIC_BASE || `http://localhost:${PORT}`
    const url = `${base}/files/${fileName}`
    return res.json({ url })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

app.listen(PORT, () => {
  console.log(`Local downloader listening on http://localhost:${PORT}`)
  if (PUBLIC_BASE) console.log(`Public base set to ${PUBLIC_BASE}`)
  console.log('POST /download_youtube { "youtube_url": "https://www.youtube.com/watch?v=..." }')
})

