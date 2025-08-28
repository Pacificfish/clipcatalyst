import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ffmpegLib from 'fluent-ffmpeg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { spawnSync } from 'child_process';

const app = express();
app.use(express.json({ limit: '20mb' }));

// CORS: allow browser to POST cross-origin from Vercel site to this worker
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Reflect requested headers if present; otherwise allow common ones
  const reqHeaders = req.headers['access-control-request-headers'];
  res.setHeader(
    'Access-Control-Allow-Headers',
    reqHeaders ? String(reqHeaders) : 'Content-Type, X-Shared-Secret'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

function firstRunnable(candidates = []){
  for (const p of candidates){
    if (!p) continue;
    try { const r = spawnSync(p, ['-version'], { stdio: 'ignore' }); if (!r.error) return p } catch {}
  }
  return ''
}

async function resolveFfmpeg(){
  const env = process.env.FFMPEG_PATH
  let candidates = [env, '/usr/bin/ffmpeg']
  try {
    const mod = (await import('@ffmpeg-installer/ffmpeg')).default
    if (mod?.path) candidates.push(mod.path)
  } catch {}
  candidates.push('ffmpeg')
  const p = firstRunnable(candidates)
  if (!p) throw new Error('Cannot find ffmpeg')
  return p
}

async function resolveFfprobe(){
  const env = process.env.FFPROBE_PATH
  let candidates = [env, '/usr/bin/ffprobe']
  try {
    const mod = (await import('@ffprobe-installer/ffprobe')).default
    if (mod?.path) candidates.push(mod.path)
  } catch {}
  candidates.push('ffprobe')
  const p = firstRunnable(candidates)
  if (!p) throw new Error('Cannot find ffprobe')
  return p
}

let ffmpegPath = ''
let ffprobePath = ''
try { ffmpegPath = await resolveFfmpeg() } catch {}
try { ffprobePath = await resolveFfprobe() } catch {}
if (ffmpegPath) ffmpegLib.setFfmpegPath(ffmpegPath)
if (ffprobePath) ffmpegLib.setFfprobePath(ffprobePath)

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

app.get('/healthz', (_, res) => res.send('ok'));
app.get('/diag', (req, res) => {
  const out = {
    ffmpegPath,
    ffprobePath,
    ffmpegRunnable: Boolean(firstRunnable([ffmpegPath])),
    ffprobeRunnable: Boolean(firstRunnable([ffprobePath])),
    env: { FFMPEG_PATH: process.env.FFMPEG_PATH || '', FFPROBE_PATH: process.env.FFPROBE_PATH || '' }
  }
  res.json(out)
});

app.post('/render', async (req, res) => {
  try {
    const required = process.env.SHARED_SECRET
    const token = req.query && (req.query.token || req.query.t)
    const ts = req.query && (req.query.ts || req.query.time)
    let ok = false
    if (required){
      if (req.header('x-shared-secret') === required) ok = true
      else if (token && ts){
        try {
          const now = Math.floor(Date.now()/1000)
          const tnum = parseInt(String(ts),10)
          if (Math.abs(now - tnum) < 600){
            const cryptoNode = await import('crypto')
            const h = cryptoNode.createHmac('sha256', required).update(String(ts)).digest('hex')
            if (h === token) ok = true
          }
        } catch {}
      }
      if (!ok) return res.status(403).json({ error: 'forbidden' })
    }

    const { mp3_url, csv_url, word_csv_url = '', bg_urls = [], bg_url = '', preset = 'tiktok_v1', title, start_ms = null, end_ms = null } = req.body || {};
    const clipStartMs = Number.isFinite(Number(start_ms)) ? Math.max(0, Math.floor(Number(start_ms))) : null
    const clipEndMs = Number.isFinite(Number(end_ms)) ? Math.max(0, Math.floor(Number(end_ms))) : null
    const bgCandidates = []
    if (bg_url) bgCandidates.push(bg_url)
    if (Array.isArray(bg_urls)) bgCandidates.push(...bg_urls)
    if (!mp3_url || !csv_url) return res.status(400).json({ error: 'mp3_url and csv_url are required' });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
    const audioPath = path.join(tmp, `${crypto.randomUUID()}.mp3`);
    const csvPath = path.join(tmp, `${crypto.randomUUID()}.csv`);
    const outPath = path.join(tmp, `${crypto.randomUUID()}.mp4`);

    const [mp3, csv] = await Promise.all([fetch(mp3_url), fetch(csv_url)]);
    if (!mp3.ok || !csv.ok) return res.status(400).json({ error: 'Failed to fetch inputs' });
    fs.writeFileSync(audioPath, Buffer.from(await mp3.arrayBuffer()));
    fs.writeFileSync(csvPath, Buffer.from(await csv.arrayBuffer()));

    // Probe audio duration so we can match video length
    const audioSeconds = await new Promise((resolve)=>{
      try {
        ffmpegLib.ffprobe(audioPath, (err, data)=>{
          if (err) return resolve(0)
          const s = (data && data.format && data.format.duration) ? Number(data.format.duration) : 0
          resolve(Math.max(0, Math.floor(s)))
        })
      } catch { resolve(0) }
    })
    const outSeconds = Math.max(1, audioSeconds || 0)

    // Optional first background asset (video or image)
    let bgPath = ''
    let bgKind = 'none' // 'video' | 'image' | 'none'
    if (bgCandidates.length){
      try {
        const rbg = await fetch(bgCandidates[0])
        if (rbg.ok){
          const ct = String(rbg.headers.get('content-type') || '').toLowerCase()
          const buf = Buffer.from(await rbg.arrayBuffer())
          if (ct.startsWith('image/')){
            bgPath = path.join(tmp, `${crypto.randomUUID()}.png`)
            fs.writeFileSync(bgPath, buf)
            bgKind = 'image'
          } else {
            bgPath = path.join(tmp, `${crypto.randomUUID()}.mp4`)
            fs.writeFileSync(bgPath, buf)
            bgKind = 'video'
          }
        }
      } catch {}
    }

    // Build ASS captions from CSV
    function parseCsvLine(line){
      const parts=[];let cur='';let inQ=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){inQ=!inQ;continue}if(ch===','&&!inQ){parts.push(cur);cur='';continue}cur+=ch}parts.push(cur);return parts}
    function hmsToMs(t){const seg=String(t).trim();const pts=seg.split(':').map(Number);if(pts.some(x=>Number.isNaN(x)))return null;let h=0,m=0,s=0;if(pts.length===2){[m,s]=pts}else if(pts.length===3){[h,m,s]=pts}else return null;return((h*60+m)*60+s)*1000}
    function csvToEvents(text){
      const raw = String(text)
      const lines = raw.trim().split(/\r?\n/).filter(Boolean)
      if (lines.length===0) return []
      const header = lines[0].toLowerCase()
      const body = (header.includes('time')||header.includes('start')||header.includes('text')) ? lines.slice(1) : lines
      const ev = []
      const SHIFT_MS = 0
      if (header.includes('start') && header.includes('end')){
        // Fast path: parse start,end,text per line; robust to quotes/commas
        const rows = body
        for (const line of rows){
          const m = line.match(/^\s*(\d+)\s*[,\t]\s*(\d+)\s*[,\t]\s*(.*)\s*$/)
          if (!m) continue
          let st = Number(m[1]||0)
          let en = Number(m[2]||0)
          let tx = m[3]||''
          if (tx.startsWith('"') && tx.endsWith('"')) tx = tx.slice(1,-1).replace(/""/g,'"')
          st = Math.max(0, st + SHIFT_MS)
          if (!(en>st)) en = st + 1
          ev.push({ start: st, end: en, text: tx.trim() })
        }
        // Snap to remove gaps and ensure monotonicity
        ev.sort((a,b)=>a.start-b.start)
        for (let i=1;i<ev.length;i++){
          if (ev[i].start > ev[i-1].end) ev[i].start = ev[i-1].end
          if (ev[i].end <= ev[i].start) ev[i].end = ev[i].start + 1
        }
        return ev
      }
      // Fallback: HH:MM text lines
      const rows = body.map(parseCsvLine).filter(r=>r.length>=2)
      const times = rows.map(r=>hmsToMs(r[0]))
      for (let i=0;i<rows.length;i++){
        const t = times[i]
        if (t==null) continue
        const next = times[i+1]
        const end = next!=null?Math.max(t+500,next):t+1500
        const tx = (rows[i].slice(1).join(',')||'').trim()
        ev.push({ start:t, end, text:tx })
      }
      // Snap to remove gaps across events
      ev.sort((a,b)=>a.start-b.start)
      for (let i=1;i<ev.length;i++){
        if (ev[i].start > ev[i-1].end) ev[i].start = ev[i-1].end
        if (ev[i].end <= ev[i].start) ev[i].end = ev[i].start + 1
      }
      return ev
    }
    function msToAss(ms){const h=String(Math.floor(ms/3600000)).padStart(1,'0');const m=String(Math.floor((ms%3600000)/60000)).padStart(2,'0');const s=String(Math.floor((ms%60000)/1000)).padStart(2,'0');const cs=String(Math.floor((ms%1000)/10)).padStart(2,'0');return `${h}:${m}:${s}.${cs}`}
    // Parse simple start,end,text CSV intended for per-word timings
    function parseStartEndCsv(text){
      const lines = String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
      const out=[]
      for (const line of lines){
        const m = line.match(/^\s*(\d+)\s*[,\t]\s*(\d+)\s*[,\t]\s*(.*)\s*$/)
        if (!m) continue
        const st = Number(m[1]||0)
        const en = Number(m[2]||0)
        let tx = m[3]||''
        if (tx.startsWith('"') && tx.endsWith('"')) tx = tx.slice(1,-1).replace(/""/g,'"')
        if (Number.isFinite(st) && Number.isFinite(en) && en>st) out.push({ start: st, end: en, text: tx.trim() })
      }
      return out
    }

    function clipEvents(events, start, end){
      if (!Array.isArray(events) || !events.length) return []
      const s = Math.max(0, Math.floor(start||0))
      const e = Math.max(s+1, Math.floor(end||0))
      const out = []
      for (const ev of events){
        const st = Math.max(ev.start, s)
        const en = Math.min(ev.end, e)
        if (en <= st) continue
        out.push({ start: st - s, end: en - s, text: ev.text })
      }
      return out
    }
    function clipWordTimes(words, start, end){
      if (!Array.isArray(words) || !words.length) return null
      const s = Math.max(0, Math.floor(start||0))
      const e = Math.max(s+1, Math.floor(end||0))
      const out = []
      for (const w of words){
        const st = Math.max(w.start, s)
        const en = Math.min(w.end, e)
        if (en <= st) continue
        out.push({ start: st - s, end: en - s, text: w.text })
      }
      return out.length ? out : null
    }

    // Build ASS with per-word animations; exactWords optional for perfect sync
    function buildWordAss(events, SPEED, opts = {}){
      const { exactWords = null, shiftMs = 0 } = opts
      const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Word, Inter, 46, &H00FFFFFF, &H000000FF, &H00000000, &H7F000000, -1, 0, 0, 0, 100, 100, 0, 0, 1, 8, 0, 2, 80, 80, 220, 1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
      const outLines = []

      // If exact per-word timings provided, render those with pop animation
      if (Array.isArray(exactWords) && exactWords.length){
        let prevEnd = 0
        for (let i=0;i<exactWords.length;i++){
          const w = exactWords[i]
          const rawS = Math.max(0, Math.floor(w.start + shiftMs))
          const rawE = Math.max(0, Math.floor(w.end + shiftMs))
          // Enforce increasing, non-overlapping times
          const s = Math.max(prevEnd, rawS)
          let e = Math.max(s+1, rawE)
          // Prevent overlap with next word if its (shifted) start is earlier
          const next = exactWords[i+1]
          if (next){
            const ns = Math.max(prevEnd, Math.floor(next.start + shiftMs))
            if (ns > s) e = Math.min(e, ns)
          }
          const dur = Math.max(1, e - s)
          const st = msToAss(s)
          const en = msToAss(e)
          const t1 = Math.max(1, Math.floor(dur * 0.35))
          const t2 = Math.max(t1+1, Math.floor(dur * 0.7))
          const tag = `{\\an2\\bord8\\shad0\\fscx60\\fscy60\\t(0,${t1},\\fscx128\\fscy128)\\t(${t1},${t2},\\fscx100\\fscy100)}`
          outLines.push(`Dialogue: 0,${st},${en},Word,,0,0,0,,${tag}${w.text}`)
          prevEnd = e
        }
        return header + outLines.join('\n') + '\n'
      }

      // Fallback: derive per-word times from event windows; one word visible at a time with pop
      for (const ev of events){
        let cursor = Math.max(0, ev.start)
        const text = String(ev.text||'').replace(/\\s+/g,' ').trim()
        if (!text) continue
        const words = text.split(' ').filter(Boolean)
        const hasExact = Number.isFinite(ev.start) && Number.isFinite(ev.end) && ev.end > ev.start
        if (words.length === 1 && hasExact){
          // Single word: fill the window scaled by SPEED
          let s = ev.start + shiftMs
          s = Math.max(0, Math.floor(s))
          const baseDur = Math.max(20, ev.end - ev.start)
          let dur = Math.max(20, Math.floor(baseDur * SPEED))
          if (s + dur > ev.end) dur = Math.max(20, ev.end - s)
          const e = s + dur
          const st = msToAss(s)
          const en = msToAss(e)
          const t1 = Math.max(1, Math.floor(dur * 0.35))
          const t2 = Math.max(t1+1, Math.floor(dur * 0.7))
          const tag = `{\\an2\\bord8\\shad0\\fscx60\\fscy60\\t(0,${t1},\\fscx128\\fscy128)\\t(${t1},${t2},\\fscx100\\fscy100)}`
          outLines.push(`Dialogue: 0,${st},${en},Word,,0,0,0,,${tag}${text}`)
          continue
        }
        const total = Math.max(1, ev.end - ev.start)
        for (let i=0;i<words.length;i++){
          let ws = Math.max(cursor, ev.start)
          ws = Math.max(0, Math.floor(ws + (i===0?shiftMs:0)))
          if (ws >= ev.end) break
          const remaining = Math.max(1, ev.end - ws)
          const remainingWords = words.length - i
          const base = Math.floor(remaining / remainingWords)
          let dur = Math.max(20, Math.floor(base * SPEED))
          const minLeft = (remainingWords-1) * 20
          if (dur > remaining - minLeft) dur = Math.max(20, remaining - minLeft)
          if (i === words.length - 1) dur = remaining
          if (!(dur > 0)) dur = 1
          const st = msToAss(ws)
          const en = msToAss(ws + dur)
          const t1 = Math.max(1, Math.floor(dur * 0.35))
          const t2 = Math.max(t1+1, Math.floor(dur * 0.7))
          const tag = `{\\an2\\bord8\\shad0\\fscx60\\fscy60\\t(0,${t1},\\fscx128\\fscy128)\\t(${t1},${t2},\\fscx100\\fscy100)}`
          outLines.push(`Dialogue: 0,${st},${en},Word,,0,0,0,,${tag}${words[i]}`)
          cursor = ws + dur
        }
      }
      return header + outLines.join('\n') + '\n'
    }
    const csvText = fs.readFileSync(csvPath,'utf8')
    const allEvents = csvToEvents(csvText)

    // Optional exact per-word CSV
    let exactWords = null
    if (word_csv_url){
      try {
        const wr = await fetch(word_csv_url)
        if (wr.ok){
          const wtext = await wr.text()
          const parsed = parseStartEndCsv(wtext)
          if (parsed && parsed.length) exactWords = parsed
        }
      } catch {}
    }

    let eventsArr = allEvents
    let clipDurMs = null
    if (clipStartMs!=null && clipEndMs!=null && clipEndMs > clipStartMs){
      eventsArr = clipEvents(allEvents, clipStartMs, clipEndMs)
      exactWords = clipWordTimes(exactWords, clipStartMs, clipEndMs)
      clipDurMs = clipEndMs - clipStartMs
    }

    const lastEndMs = eventsArr.length ? Math.max(...eventsArr.map(e=>e.end)) : 0
    const derivedSeconds = Math.ceil((lastEndMs||0)/1000)
    let finalSeconds = Math.max(outSeconds, derivedSeconds)
    if (clipDurMs!=null){ finalSeconds = Math.ceil(Math.max(1, clipDurMs)/1000) }
    const timingScaleRaw = Number((req.body && req.body.timing_scale) || process.env.CAPTION_TIMING_SCALE || 1)
    const timingScale = Number.isFinite(timingScaleRaw) ? Math.max(0.1, Math.min(3, timingScaleRaw)) : 1
    const shiftMsRaw = Number((req.body && req.body.shift_ms) || process.env.CAPTION_SHIFT_MS || 0)
    let shiftMs = Number.isFinite(shiftMsRaw) ? Math.max(-1000, Math.min(1000, Math.floor(shiftMsRaw))) : 0
    // Shift captions so the clip starts at 0
    if (clipDurMs!=null){ shiftMs += 0 }
    const assPath = path.join(tmp,'subs.ass')
    fs.writeFileSync(assPath, buildWordAss(eventsArr, timingScale, { exactWords, shiftMs }),'utf8')

    const cmd = ffmpegLib();
    if (bgPath){
      if (bgKind === 'video') {
        cmd.input(bgPath).inputOptions(['-stream_loop','-1'])
      } else if (bgKind === 'image') {
        // Loop a single image as video background
        cmd.input(bgPath).inputOptions(['-loop','1'])
      }
    } else {
      cmd.input(`color=c=#0b0b0f:s=1080x1920:r=30:d=${finalSeconds}`).inputFormat('lavfi')
    }
    cmd.input(audioPath)

    const assEsc = assPath.replace(/:/g,'\\:').replace(/'/g,"\\'")
    const vf = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#0b0b0f,format=yuv420p,ass='${assEsc}'`

    const filters = []
    filters.push(`[0:v]${vf}[v]`)
    let audioMap = '1:a'
    if (clipDurMs!=null && clipStartMs!=null){
      const startSec = (clipStartMs/1000).toFixed(3)
      const durSec = (clipDurMs/1000).toFixed(3)
      filters.push(`[1:a]atrim=start=${startSec}:duration=${durSec},asetpts=PTS-STARTPTS[a]`)
      audioMap = '[a]'
    }
    cmd.complexFilter(filters)

    cmd.outputOptions([
      '-map','[v]',
      '-map', audioMap,
      '-c:v','libx264','-preset','medium','-crf','20',
      '-pix_fmt','yuv420p',
      '-c:a','aac','-b:a','192k',
      '-t', String(finalSeconds)
    ])

    await new Promise((resolve, reject) => {
      cmd.on('start', c => console.log('ffmpeg:', c));
      cmd.on('stderr', l => console.error(l));
      cmd.on('end', resolve);
      cmd.on('error', reject);
      cmd.save(outPath);
    });

    const hasS3 = Boolean(process.env.S3_BUCKET && process.env.AWS_REGION && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI))

    if (hasS3){
      const bucket = process.env.S3_BUCKET;
      const key = `renders/${Date.now()}-${path.basename(outPath)}`;
      const body = fs.readFileSync(outPath);
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: 'video/mp4', ACL: 'public-read'
      }));
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      const url = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
      res.json({ url, key, start_ms: clipStartMs, end_ms: clipEndMs, seconds: finalSeconds });
    } else {
      // Stream the MP4 directly if S3 is not configured
      const stat = fs.statSync(outPath)
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store'
      })
      const rs = fs.createReadStream(outPath)
      rs.pipe(res)
      rs.on('close', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || 'Render failed' });
  }
});

// Transcribe via AssemblyAI with local audio upload (works for most YouTube URLs)
app.post('/transcribe_assembly', async (req, res) => {
  try {
    const required = process.env.SHARED_SECRET
    if (required && req.header('x-shared-secret') !== required) return res.status(403).json({ error: 'forbidden' })

    const { youtube_url, language } = req.body || {}
    if (!youtube_url || typeof youtube_url !== 'string') return res.status(400).json({ error: 'youtube_url is required' })
    const API = process.env.ASSEMBLYAI_API_KEY || ''
    if (!API) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not set' })

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-'))
    const audioPath = path.join(tmp, `${crypto.randomUUID()}.mp3`)

    // 1) Download bestaudio from YouTube
    try {
      const ytdl = (await import('ytdl-core')).default
      const ytStream = ytdl(youtube_url, { quality: 'highestaudio', filter: 'audioonly', highWaterMark: 1<<25 })
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(audioPath)
        ytStream.on('error', reject)
        ws.on('error', reject)
        ws.on('finish', resolve)
        ytStream.pipe(ws)
      })
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      return res.status(400).json({ error: 'Failed to download audio', details: String(e?.message || e) })
    }

    // 2) Upload to AssemblyAI (streaming)
    let uploadUrl = ''
    try {
      const rs = fs.createReadStream(audioPath)
      const up = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { 'Authorization': API },
        body: rs,
      })
      if (!up.ok){
        const txt = await up.text().catch(()=> '')
        throw new Error(`upload failed: ${up.status} ${txt}`)
      }
      const uj = await up.json().catch(()=>null)
      uploadUrl = uj?.upload_url || uj?.uploadUrl || ''
      if (!uploadUrl) throw new Error('no upload_url returned')
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      return res.status(502).json({ error: 'AssemblyAI upload failed', details: String(e?.message || e) })
    }

    // 3) Create transcript and poll
    let transcriptId = ''
    try {
      const cr = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: { 'Authorization': API, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_url: uploadUrl,
          language_code: (typeof language === 'string' && language.length >= 2) ? language : undefined,
          punctuate: true,
          auto_highlights: false,
          speaker_labels: false,
          filter_profanity: false,
          format_text: true,
        })
      })
      if (!cr.ok){
        const txt = await cr.text().catch(()=> '')
        throw new Error(`create failed: ${cr.status} ${txt}`)
      }
      const cj = await cr.json().catch(()=>null)
      transcriptId = cj?.id || ''
      if (!transcriptId) throw new Error('no transcript id')
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      return res.status(502).json({ error: 'AssemblyAI create failed', details: String(e?.message || e) })
    }

    const started = Date.now()
    let status = ''
    let result = null
    while (Date.now() - started < 180000){ // up to 3 minutes
      await new Promise(r=>setTimeout(r, 3000))
      const st = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers: { 'Authorization': API } })
      if (!st.ok) continue
      const js = await st.json().catch(()=>null)
      status = js?.status || ''
      if (status === 'completed'){ result = js; break }
      if (status === 'error'){ try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(502).json({ error: 'AssemblyAI error', details: js?.error || 'unknown' }) }
    }

    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

    if (!result) return res.status(504).json({ error: 'transcription timeout' })

    const words = Array.isArray(result?.words) ? result.words : []
    const lines = []
    if (words.length){
      let curStart = Math.max(0, Math.floor(Number(words[0].start||0)))
      let curEnd = curStart
      let buf = ''
      for (const w of words){
        const ws = Math.max(0, Math.floor(Number(w.start||0)))
        const we = Math.max(ws+1, Math.floor(Number(w.end||ws+1)))
        const t = String(w.text||w.word||'').trim()
        if (!t) continue
        const tooLong = (we - curStart) > 3500
        const punct = /[.!?]$/.test(t)
        if (tooLong || punct){
          const lineText = (buf ? buf + ' ' : '') + t
          curEnd = we
          lines.push({ start: curStart, dur: Math.max(1, curEnd - curStart), text: lineText.trim() })
          curStart = we
          curEnd = we
          buf = ''
        } else {
          buf = buf ? (buf + ' ' + t) : t
          curEnd = we
        }
      }
      if (buf){ lines.push({ start: curStart, dur: Math.max(1, curEnd - curStart), text: buf.trim() }) }
    } else if (result?.text){
      const text = String(result.text||'').trim()
      const chunks = text.split(/(?<=[.!?])\s+/)
      let t0 = 0
      for (const s of chunks.filter(Boolean)){
        const st = t0; const dur = 1500; t0 += dur
        lines.push({ start: st, dur, text: s })
      }
    }

    if (!lines.length) return res.status(502).json({ error: 'no transcript lines' })

    res.json({ lines })
  } catch (e) {
    res.status(500).json({ error: e?.message || 'transcribe failed' })
  }
})

// Suggest highlights from an uploaded video URL: transcribe and propose ~3 segments
app.post('/suggest_highlights', async (req, res) => {
  try {
    const required = process.env.SHARED_SECRET
    if (required && req.header('x-shared-secret') !== required) return res.status(403).json({ error: 'forbidden' })

    const { video_url, language, target_clip_count = 3, min_ms = 18000, max_ms = 30000 } = req.body || {}
    if (!video_url || typeof video_url !== 'string') return res.status(400).json({ error: 'video_url is required' })

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-'))
    const vidPath = path.join(tmp, `${crypto.randomUUID()}.mp4`)
    const mp3Path = path.join(tmp, `${crypto.randomUUID()}.mp3`)

    // Download the uploaded video
    const rv = await fetch(video_url)
    if (!rv.ok) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(400).json({ error: 'failed to fetch video_url' }) }
    fs.writeFileSync(vidPath, Buffer.from(await rv.arrayBuffer()))

    // Extract audio to MP3
    await new Promise((resolve, reject) => {
      try {
        const cmd = ffmpegLib()
        cmd.input(vidPath)
        cmd.outputOptions(['-vn','-c:a','libmp3lame','-b:a','192k'])
        cmd.on('end', resolve)
        cmd.on('error', reject)
        cmd.save(mp3Path)
      } catch (e) { reject(e) }
    })

    // Transcribe with AssemblyAI by uploading the extracted audio
    const API = process.env.ASSEMBLYAI_API_KEY || ''
    if (!API) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not set' }) }

    let uploadUrl = ''
    try {
      const rs = fs.createReadStream(mp3Path)
      const up = await fetch('https://api.assemblyai.com/v2/upload', { method: 'POST', headers: { 'Authorization': API }, body: rs })
      if (!up.ok){ const txt = await up.text().catch(()=> ''); throw new Error(`upload failed: ${up.status} ${txt}`) }
      const uj = await up.json().catch(()=>null)
      uploadUrl = uj?.upload_url || uj?.uploadUrl || ''
      if (!uploadUrl) throw new Error('no upload_url returned')
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      return res.status(502).json({ error: 'AssemblyAI upload failed', details: String(e?.message || e) })
    }

    // Create transcript and poll
    let transcriptId = ''
    try {
      const cr = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST', headers: { 'Authorization': API, 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_url: uploadUrl, language_code: (typeof language === 'string' && language.length >= 2) ? language : undefined, punctuate: true, format_text: true })
      })
      if (!cr.ok){ const txt = await cr.text().catch(()=> ''); throw new Error(`create failed: ${cr.status} ${txt}`) }
      const cj = await cr.json().catch(()=>null)
      transcriptId = cj?.id || ''
      if (!transcriptId) throw new Error('no transcript id')
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      return res.status(502).json({ error: 'AssemblyAI create failed', details: String(e?.message || e) })
    }

    const started = Date.now()
    let status = ''
    let result = null
    while (Date.now() - started < 180000){
      await new Promise(r=>setTimeout(r, 3000))
      const st = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers: { 'Authorization': API } })
      if (!st.ok) continue
      const js = await st.json().catch(()=>null)
      status = js?.status || ''
      if (status === 'completed'){ result = js; break }
      if (status === 'error'){ try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(502).json({ error: 'AssemblyAI error', details: js?.error || 'unknown' }) }
    }

    // Build words and lines
    const words = Array.isArray(result?.words) ? result.words.map((w)=>({ start: Math.max(0, Math.floor(Number(w.start||0))), end: Math.max(1, Math.floor(Number(w.end||0))), text: String(w.text||w.word||'').trim() })) : []
    const lines = []
    if (words.length){
      let curStart = words[0].start
      let curEnd = curStart
      let buf = ''
      for (const w of words){
        const t = w.text
        if (!t) continue
        const tooLong = (w.end - curStart) > 3500
        const punct = /[.!?]$/.test(t)
        if (tooLong || punct){
          const lineText = (buf ? buf + ' ' : '') + t
          curEnd = w.end
          lines.push({ start: curStart, dur: Math.max(1, curEnd - curStart), text: lineText.trim() })
          curStart = w.end
          curEnd = w.end
          buf = ''
        } else {
          buf = buf ? (buf + ' ' + t) : t
          curEnd = w.end
        }
      }
      if (buf){ lines.push({ start: curStart, dur: Math.max(1, curEnd - curStart), text: buf.trim() }) }
    } else if (result?.text){
      const text = String(result.text||'').trim()
      const chunks = text.split(/(?<=[.!?])\s+/)
      let t0 = 0
      for (const s of chunks.filter(Boolean)){
        const st = t0; const dur = 1500; t0 += dur
        lines.push({ start: st, dur, text: s })
      }
    }

    // Choose ~3 segments within [min_ms, max_ms]
    function chooseSegmentsFromLines(linesArr){
      const out = []
      let cursor = 0
      let i = 0
      while (i < linesArr.length && out.length < Number(target_clip_count||3)){
        const segStart = Math.max(cursor, linesArr[i].start)
        let segEnd = segStart
        let j = i
        while (j < linesArr.length){
          const nextEnd = Math.max(segEnd, linesArr[j].start + linesArr[j].dur)
          const dur = nextEnd - segStart
          if (dur >= min_ms && dur <= max_ms){ segEnd = nextEnd; j++; break }
          if (dur > max_ms){ break }
          segEnd = nextEnd; j++
        }
        if (segEnd <= segStart){ i++; cursor = segStart; continue }
        out.push({ start_ms: segStart, end_ms: segEnd })
        i = j
        cursor = segEnd
      }
      return out
    }

    const segments = chooseSegmentsFromLines(lines)

    // Build CSV texts
    const csv_text = lines.map(l=>`${l.start},${l.start + l.dur},"${(l.text||'').replace(/"/g,'""')}"`).join('\n')
    const word_csv_text = words.map(w=>`${w.start},${w.end},"${(w.text||'').replace(/"/g,'""')}"`).join('\n')

    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

    return res.json({ mp3_url: '', video_url, segments, csv_text, word_csv_text })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e?.message || 'suggest_highlights failed' })
  }
})

// Batch render multiple TikTok-ready clips
app.post('/render_batch', async (req, res) => {
  try {
    const required = process.env.SHARED_SECRET
    const token = req.query && (req.query.token || req.query.t)
    const ts = req.query && (req.query.ts || req.query.time)
    let ok = false
    if (required){
      if (req.header('x-shared-secret') === required) ok = true
      else if (token && ts){
        try {
          const now = Math.floor(Date.now()/1000)
          const tnum = parseInt(String(ts),10)
          if (Math.abs(now - tnum) < 600){
            const cryptoNode = await import('crypto')
            const h = cryptoNode.createHmac('sha256', required).update(String(ts)).digest('hex')
            if (h === token) ok = true
          }
        } catch {}
      }
      if (!ok) return res.status(403).json({ error: 'forbidden' })
    }

    const { mp3_url, video_url = '', youtube_url = '', csv_url, csv_text = '', word_csv_url = '', word_csv_text = '', segments = [], bg_urls = [], bg_url = '', preset = 'tiktok_v1' } = req.body || {}
    if (!Array.isArray(segments) || segments.length === 0) return res.status(400).json({ error: 'segments array required' })

    const hasS3 = Boolean(process.env.S3_BUCKET && process.env.AWS_REGION && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI))

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-batch-'))
    const audioPath = path.join(tmp, `${crypto.randomUUID()}.mp3`)
    const csvPath = path.join(tmp, `${crypto.randomUUID()}.csv`)

    // Load audio: prefer mp3_url; else if video_url provided, extract; else try YouTube
    if (mp3_url){
      const r = await fetch(mp3_url)
      if (!r.ok){ try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(400).json({ error: 'Failed to fetch mp3_url' }) }
      fs.writeFileSync(audioPath, Buffer.from(await r.arrayBuffer()))
    } else if (video_url){
      const rv = await fetch(String(video_url))
      if (!rv.ok){ try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(400).json({ error: 'Failed to fetch video_url' }) }
      const vidPath = path.join(tmp, `${crypto.randomUUID()}.mp4`)
      fs.writeFileSync(vidPath, Buffer.from(await rv.arrayBuffer()))
      await new Promise((resolve, reject) => {
        try {
          const cmd = ffmpegLib()
          cmd.input(vidPath)
          cmd.outputOptions(['-vn','-c:a','libmp3lame','-b:a','192k'])
          cmd.on('end', resolve)
          cmd.on('error', reject)
          cmd.save(audioPath)
        } catch (e) { reject(e) }
      })
    } else if (youtube_url){
      try {
        const ytdl = (await import('ytdl-core')).default
        const ytStream = ytdl(String(youtube_url), { quality: 'highestaudio', filter: 'audioonly', highWaterMark: 1<<25 })
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(audioPath)
          ytStream.on('error', reject)
          ws.on('error', reject)
          ws.on('finish', resolve)
          ytStream.pipe(ws)
        })
      } catch (e) {
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
        return res.status(400).json({ error: 'Failed to download audio from youtube_url', details: String(e?.message || e) })
      }
    } else {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      return res.status(400).json({ error: 'Provide mp3_url or video_url or youtube_url' })
    }

    // Load captions CSV text: prefer csv_text, else csv_url if provided
    let csvText = ''
    if (csv_text){ csvText = String(csv_text) }
    else if (csv_url){
      const rc = await fetch(csv_url)
      if (!rc.ok){ try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(400).json({ error: 'Failed to fetch csv_url' }) }
      csvText = await rc.text()
    }
    if (csvText){ fs.writeFileSync(csvPath, csvText, 'utf8') }

    // Parse global events and optional word timings once
    function parseCsvLine(line){
      const parts=[];let cur='';let inQ=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){inQ=!inQ;continue}if(ch===','&&!inQ){parts.push(cur);cur='';continue}cur+=ch}parts.push(cur);return parts}
    function hmsToMs(t){const seg=String(t).trim();const pts=seg.split(':').map(Number);if(pts.some(x=>Number.isNaN(x)))return null;let h=0,m=0,s=0;if(pts.length===2){[m,s]=pts}else if(pts.length===3){[h,m,s]=pts}else return null;return((h*60+m)*60+s)*1000}
    function csvToEvents(text){
      const raw = String(text)
      const lines = raw.trim().split(/\r?\n/).filter(Boolean)
      if (lines.length===0) return []
      const header = lines[0].toLowerCase()
      const body = (header.includes('time')||header.includes('start')||header.includes('text')) ? lines.slice(1) : lines
      const ev = []
      const SHIFT_MS = 0
      if (header.includes('start') && header.includes('end')){
        const rows = body
        for (const line of rows){
          const m = line.match(/^\s*(\d+)\s*[,\t]\s*(\d+)\s*[,\t]\s*(.*)\s*$/)
          if (!m) continue
          let st = Number(m[1]||0)
          let en = Number(m[2]||0)
          let tx = m[3]||''
          if (tx.startsWith('"') && tx.endsWith('"')) tx = tx.slice(1,-1).replace(/""/g,'"')
          st = Math.max(0, st + SHIFT_MS)
          if (!(en>st)) en = st + 1
          ev.push({ start: st, end: en, text: tx.trim() })
        }
        ev.sort((a,b)=>a.start-b.start)
        for (let i=1;i<ev.length;i++){
          if (ev[i].start > ev[i-1].end) ev[i].start = ev[i-1].end
          if (ev[i].end <= ev[i].start) ev[i].end = ev[i].start + 1
        }
        return ev
      }
      const rows = body.map(parseCsvLine).filter(r=>r.length>=2)
      const times = rows.map(r=>hmsToMs(r[0]))
      /* reuse ev */
      for (let i=0;i<rows.length;i++){
        const t = times[i]
        if (t==null) continue
        const next = times[i+1]
        const end = next!=null?Math.max(t+500,next):t+1500
        const tx = (rows[i].slice(1).join(',')||'').trim()
        ev.push({ start:t, end, text:tx })
      }
      ev.sort((a,b)=>a.start-b.start)
      for (let i=1;i<ev.length;i++){
        if (ev[i].start > ev[i-1].end) ev[i].start = ev[i-1].end
        if (ev[i].end <= ev[i].start) ev[i].end = ev[i].start + 1
      }
      return ev
    }
    const allEvents = csvText ? csvToEvents(csvText) : []

    function parseStartEndCsv(text){
      const lines = String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
      const out=[]
      for (const line of lines){
        const m = line.match(/^\s*(\d+)\s*[,\t]\s*(\d+)\s*[,\t]\s*(.*)\s*$/)
        if (!m) continue
        const st = Number(m[1]||0)
        const en = Number(m[2]||0)
        let tx = m[3]||''
        if (tx.startsWith('"') && tx.endsWith('"')) tx = tx.slice(1,-1).replace(/""/g,'"')
        if (Number.isFinite(st) && Number.isFinite(en) && en>st) out.push({ start: st, end: en, text: tx.trim() })
      }
      return out
    }
    let allWords = null
    if (word_csv_url){
      try { const wr = await fetch(word_csv_url); if (wr.ok){ const wtext = await wr.text(); const parsed = parseStartEndCsv(wtext); if (parsed && parsed.length) allWords = parsed } } catch {}
    }

    function clipEvents(events, start, end){
      if (!Array.isArray(events) || !events.length) return []
      const s = Math.max(0, Math.floor(start||0))
      const e = Math.max(s+1, Math.floor(end||0))
      const out = []
      for (const ev of events){
        const st = Math.max(ev.start, s)
        const en = Math.min(ev.end, e)
        if (en <= st) continue
        out.push({ start: st - s, end: en - s, text: ev.text })
      }
      return out
    }
    function clipWordTimes(words, start, end){
      if (!Array.isArray(words) || !words.length) return null
      const s = Math.max(0, Math.floor(start||0))
      const e = Math.max(s+1, Math.floor(end||0))
      const out = []
      for (const w of words){
        const st = Math.max(w.start, s)
        const en = Math.min(w.end, e)
        if (en <= st) continue
        out.push({ start: st - s, end: en - s, text: w.text })
      }
      return out.length ? out : null
    }

    // Prepare optional background asset
    const bgCandidates = []
    if (bg_url) bgCandidates.push(bg_url)
    if (Array.isArray(bg_urls)) bgCandidates.push(...bg_urls)
    let bgPath = ''
    let bgKind = 'none'
    if (bgCandidates.length){
      try {
        const rbg = await fetch(bgCandidates[0])
        if (rbg.ok){
          const ct = String(rbg.headers.get('content-type') || '').toLowerCase()
          const buf = Buffer.from(await rbg.arrayBuffer())
          if (ct.startsWith('image/')){ bgPath = path.join(tmp, `${crypto.randomUUID()}.png`); fs.writeFileSync(bgPath, buf); bgKind = 'image' }
          else { bgPath = path.join(tmp, `${crypto.randomUUID()}.mp4`); fs.writeFileSync(bgPath, buf); bgKind = 'video' }
        }
      } catch {}
    }

    const bucket = process.env.S3_BUCKET
    const region = process.env.AWS_REGION

    const outputs = []
    for (const seg of segments){
      const sMs = Math.max(0, Math.floor(Number(seg?.start_ms||0)))
      const eMs = Math.max(sMs+1, Math.floor(Number(seg?.end_ms||0)))
      let segEvents = clipEvents(allEvents, sMs, eMs)
      const segWords = clipWordTimes(allWords, sMs, eMs)
      // If no global events provided, synthesize a single event from provided text
      if ((!allEvents || allEvents.length===0) && (!segEvents || segEvents.length===0)){
        const txt = String(seg?.text || '').trim()
        if (txt) segEvents = [{ start: 0, end: eMs - sMs, text: txt }]
        else segEvents = []
      }
      const finalSeconds = Math.ceil((eMs - sMs)/1000)

      const assHeader = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Word, Inter, 46, &H00FFFFFF, &H000000FF, &H00000000, &H7F000000, -1, 0, 0, 0, 100, 100, 0, 0, 1, 8, 0, 2, 80, 80, 220, 1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
      function msToAss(ms){const h=String(Math.floor(ms/3600000)).padStart(1,'0');const m=String(Math.floor((ms%3600000)/60000)).padStart(2,'0');const s=String(Math.floor((ms%60000)/1000)).padStart(2,'0');const cs=String(Math.floor((ms%1000)/10)).padStart(2,'0');return `${h}:${m}:${s}.${cs}`}
      const outLines = []
      if (Array.isArray(segWords) && segWords.length){
        let prevEnd = 0
        for (let i=0;i<segWords.length;i++){
          const w = segWords[i]
          const s = Math.max(prevEnd, Math.floor(w.start))
          let e = Math.max(s+1, Math.floor(w.end))
          const next = segWords[i+1]; if (next){ const ns = Math.max(prevEnd, Math.floor(next.start)); if (ns > s) e = Math.min(e, ns) }
          const dur = Math.max(1, e - s)
          const st = msToAss(s); const en = msToAss(e)
          const t1 = Math.max(1, Math.floor(dur * 0.35)); const t2 = Math.max(t1+1, Math.floor(dur * 0.7))
          const tag = `{\\an2\\bord8\\shad0\\fscx60\\fscy60\\t(0,${t1},\\fscx128\\fscy128)\\t(${t1},${t2},\\fscx100\\fscy100)}`
          outLines.push(`Dialogue: 0,${st},${en},Word,,0,0,0,,${tag}${w.text}`)
          prevEnd = e
        }
      } else {
        for (const ev of segEvents){
          const text = String(ev.text||'').replace(/\s+/g,' ').trim(); if (!text) continue
          const words = text.split(' ').filter(Boolean)
          let cursor = ev.start
          for (let i=0;i<words.length;i++){
            const ws = Math.max(0, Math.floor(cursor))
            if (ws >= ev.end) break
            const remaining = Math.max(1, ev.end - ws)
            const remainingWords = words.length - i
            const base = Math.floor(remaining / remainingWords)
            const dur = Math.max(20, base)
            const st = msToAss(ws); const en = msToAss(ws+dur)
            const t1 = Math.max(1, Math.floor(dur*0.35)); const t2 = Math.max(t1+1, Math.floor(dur*0.7))
            const tag = `{\\an2\\bord8\\shad0\\fscx60\\fscy60\\t(0,${t1},\\fscx128\\fscy128)\\t(${t1},${t2},\\fscx100\\fscy100)}`
            outLines.push(`Dialogue: 0,${st},${en},Word,,0,0,0,,${tag}${words[i]}`)
            cursor = ws + dur
          }
        }
      }
      const assPath = path.join(tmp, `${crypto.randomUUID()}.ass`)
      fs.writeFileSync(assPath, assHeader + outLines.join('\n') + '\n','utf8')

      const outPath = path.join(tmp, `${crypto.randomUUID()}.mp4`)
      const cmd = ffmpegLib()
      if (bgPath){ if (bgKind==='video') cmd.input(bgPath).inputOptions(['-stream_loop','-1']); else if (bgKind==='image') cmd.input(bgPath).inputOptions(['-loop','1']) }
      else { cmd.input(`color=c=#0b0b0f:s=1080x1920:r=30:d=${finalSeconds}`).inputFormat('lavfi') }
      cmd.input(audioPath)

      const assEsc = assPath.replace(/:/g,'\\:').replace(/'/g,"\\'")
      const vf = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#0b0b0f,format=yuv420p,ass='${assEsc}'`
      const startSec = (sMs/1000).toFixed(3)
      const durSec = ((eMs - sMs)/1000).toFixed(3)
      cmd.complexFilter([
        `[0:v]${vf}[v]`,
        `[1:a]atrim=start=${startSec}:duration=${durSec},asetpts=PTS-STARTPTS[a]`
      ])
      cmd.outputOptions([
        '-map','[v]','-map','[a]',
        '-c:v','libx264','-preset','medium','-crf','20',
        '-pix_fmt','yuv420p','-c:a','aac','-b:a','192k',
        '-t', String(finalSeconds)
      ])

      await new Promise((resolve, reject) => { cmd.on('end', resolve); cmd.on('error', reject); cmd.save(outPath) })
      const body = fs.readFileSync(outPath)
      const key = `renders/${Date.now()}-${crypto.randomUUID()}.mp4`
      let url = ''
      if (bucket && hasS3){
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'video/mp4', ACL: 'public-read' }))
        url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`
      }
      outputs.push({ url, key, start_ms: sMs, end_ms: eMs, seconds: finalSeconds, title: seg?.title || null })
    }

    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    // If no storage was configured, at least return keys (empty url). Client can request downloads per-clip via a streaming endpoint in the future.
    res.json({ clips: outputs })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e?.message || 'batch render failed' })
  }
})

const PORT = Number(process.env.PORT || 8080)
app.listen(PORT, '0.0.0.0', () => console.log(`worker listening on :${PORT}`));

