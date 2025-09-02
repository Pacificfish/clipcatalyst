import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ffmpegLib from 'fluent-ffmpeg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { spawn, spawnSync } from 'child_process';

const app = express();
app.use(express.json({ limit: '20mb' }));

// Simple in-memory job store for async operations
const jobs = new Map(); // id -> { id, status: 'queued'|'running'|'completed'|'error', createdAt, updatedAt, result: any, error: string|null }
function newJobId(){ return crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)) }
function setJob(id, patch){ const cur = jobs.get(id) || { id, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), result: null, error: null }; const next = { ...cur, ...patch, updatedAt: Date.now() }; jobs.set(id, next); return next }

async function runAutoClipJob(params){
  const port = Number(process.env.PORT || 8080)
  const url = `http://127.0.0.1:${port}/auto_clip`
  const headers = { 'Content-Type': 'application/json' }
  if (process.env.SHARED_SECRET) headers['X-Shared-Secret'] = process.env.SHARED_SECRET
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(params||{}) })
  const txt = await r.text().catch(()=> '')
  let parsed = null
  try { parsed = JSON.parse(txt) } catch {}
  if (!r.ok){ throw new Error((parsed && (parsed.error || parsed.details)) || txt || `auto_clip failed ${r.status}`) }
  if (parsed==null) throw new Error('auto_clip returned non-JSON')
  return parsed
}

const runningOnVercel = !!process.env.VERCEL;

// On Vercel, ensure writeable CWD (use /tmp)
if (runningOnVercel) {
  try { process.chdir('/tmp') } catch {}
}

// On Vercel, this function is mounted at /api; strip the /api prefix so routes like 
// /api/diag hit our /diag handler.
if (runningOnVercel) {
  app.use((req, _res, next) => {
    if (req.url && req.url.startsWith('/api/')){
      req.url = req.url.slice(4) || '/'
    }
    next()
  })
}

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

async function resolveYtDlp(){
  const env = process.env.YT_DLP_PATH
  const candidates = [env, '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp']
  for (const p of candidates){
    if (!p) continue
    try {
      const r = spawnSync(p, ['--version'], { stdio: 'ignore' })
      if (!r.error && (r.status === 0 || typeof r.status === 'undefined')) return p
    } catch {}
  }
  // On Vercel, try downloading a static yt-dlp binary to /tmp on cold start
  if (runningOnVercel){
    try {
      const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
      const binPath = '/tmp/yt-dlp'
      if (!fs.existsSync(binPath)){
        const r = await fetch(url)
        if (r.ok){
          const buf = Buffer.from(await r.arrayBuffer())
          fs.writeFileSync(binPath, buf)
          try { fs.chmodSync(binPath, 0o755) } catch {}
        }
      }
      const t = spawnSync(binPath, ['--version'], { stdio: 'ignore' })
      if (!t.error && (t.status === 0 || typeof t.status === 'undefined')) return binPath
    } catch {}
  }
  return ''
}

let ffmpegPath = ''
let ffprobePath = ''
let ytDlpPath = ''
try { ffmpegPath = await resolveFfmpeg() } catch {}
try { ffprobePath = await resolveFfprobe() } catch {}
try { ytDlpPath = await resolveYtDlp() } catch {}
if (ffmpegPath) ffmpegLib.setFfmpegPath(ffmpegPath)
if (ffprobePath) ffmpegLib.setFfprobePath(ffprobePath)

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

// Path to store admin-uploaded YouTube cookies (Netscape format)
const COOKIES_STORE_PATH = process.env.YT_COOKIES_PATH || '/app/youtube_cookies.txt'

function ensureNetscapeHeader(text){
  const t = String(text || '').trim()
  if (!t) return '# Netscape HTTP Cookie File\n'
  const firstLine = t.split(/\r?\n/)[0]
  if (/^#\s*(Netscape|HTTP)\s+Cookie\s+File/i.test(firstLine)) return t + (t.endsWith('\n') ? '' : '\n')
  return `# Netscape HTTP Cookie File\n${t}${t.endsWith('\n') ? '' : '\n'}`
}

// Admin: upload cookies for YouTube (requires X-Shared-Secret)
app.post('/admin/youtube_cookies', async (req, res) => {
  try {
    const required = process.env.SHARED_SECRET
    if (required && req.header('x-shared-secret') !== required) return res.status(403).json({ error: 'forbidden' })

    const { cookies_txt_base64 = '', cookies_txt = '' } = req.body || {}
    let buf = null
    if (typeof cookies_txt_base64 === 'string' && cookies_txt_base64.trim()) {
      try { buf = Buffer.from(cookies_txt_base64.trim(), 'base64') } catch {}
    }
    if (!buf && typeof cookies_txt === 'string' && cookies_txt.trim()) {
      buf = Buffer.from(cookies_txt, 'utf8')
    }
    if (!buf || !buf.length) return res.status(400).json({ error: 'no_cookies_provided' })

    // Normalize potential UTF-16 to UTF-8 and ensure Netscape header
    function normalizeCookiesBuffer(raw){
      try {
        if (!raw || !raw.length) return Buffer.from('')
        if (raw.length>=2 && raw[0]===0xFF && raw[1]===0xFE){
          const td = new TextDecoder('utf-16le'); const s = td.decode(raw.slice(2)); return Buffer.from(ensureNetscapeHeader(s), 'utf8')
        }
        if (raw.length>=2 && raw[0]===0xFE && raw[1]===0xFF){
          const le = Buffer.allocUnsafe(raw.length - 2)
          for (let j=2, k=0; j+1<raw.length; j+=2, k+=2){ le[k] = raw[j+1]; le[k+1] = raw[j] }
          const td = new TextDecoder('utf-16le'); const s = td.decode(le); return Buffer.from(ensureNetscapeHeader(s), 'utf8')
        }
        let nul = 0; for (let i=0;i<raw.length;i++){ if (raw[i]===0) nul++ }
        if (nul > raw.length/4){ const td = new TextDecoder('utf-16le'); const s = td.decode(raw); return Buffer.from(ensureNetscapeHeader(s), 'utf8') }
        // assume utf-8 text
        const asText = raw.toString('utf8')
        return Buffer.from(ensureNetscapeHeader(asText), 'utf8')
      } catch { return raw }
    }
    const norm = normalizeCookiesBuffer(buf)
    try { fs.writeFileSync(COOKIES_STORE_PATH, norm) } catch (e) { return res.status(500).json({ error: 'write_failed', details: String(e?.message || e) }) }
    return res.json({ ok: true, bytes: norm.length, path: COOKIES_STORE_PATH })
  } catch (e) { return res.status(500).json({ error: String(e?.message || e) }) }
})

// Admin: status of stored cookies (requires X-Shared-Secret)
app.get('/admin/youtube_cookies', async (req, res) => {
  try {
    const required = process.env.SHARED_SECRET
    if (required && req.header('x-shared-secret') !== required) return res.status(403).json({ error: 'forbidden' })
    let exists = false; let size = 0
    try { const st = fs.statSync(COOKIES_STORE_PATH); exists = st.isFile(); size = st.size } catch {}
    return res.json({ exists, size, path: COOKIES_STORE_PATH })
  } catch (e) { return res.status(500).json({ error: String(e?.message || e) }) }
})

app.get('/healthz', (_, res) => res.send('ok'));
app.get('/diag', (req, res) => {
  const ytRunnable = (()=>{ try { if (!ytDlpPath) return false; const r = spawnSync(ytDlpPath, ['--version'], { stdio: 'ignore' }); return !r.error && (r.status === 0 || typeof r.status === 'undefined'); } catch { return false } })()
  const ytVersion = (()=>{ try { if (!ytDlpPath) return ''; const r = spawnSync(ytDlpPath, ['--version'], { stdio: ['ignore','pipe','ignore'] }); return (r.stdout ? String(r.stdout.toString()).trim() : '') } catch { return '' } })()
  const out = {
    ffmpegPath,
    ffprobePath,
    ytDlpPath,
    ffmpegRunnable: Boolean(firstRunnable([ffmpegPath])),
    ffprobeRunnable: Boolean(firstRunnable([ffprobePath])),
    ytDlpRunnable: ytRunnable,
    ytDlpVersion: ytVersion,
    hasBlob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    hasS3: Boolean(process.env.S3_BUCKET && process.env.AWS_REGION),
    runningOnVercel,
    env: {
      FFMPEG_PATH: process.env.FFMPEG_PATH || '',
      FFPROBE_PATH: process.env.FFPROBE_PATH || '',
      YT_DLP_PATH: process.env.YT_DLP_PATH || '',
      DEBUG_YT_DLP: process.env.DEBUG_YT_DLP || '',
      AWS_REGION: process.env.AWS_REGION || '',
      S3_BUCKET: process.env.S3_BUCKET || '',
      VERCEL: process.env.VERCEL || ''
    }
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
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN || ''

    if (blobToken){
      try {
        const { put } = await import('@vercel/blob')
        const body = fs.readFileSync(outPath)
        const key = `renders/${Date.now()}-${path.basename(outPath)}`
        const { url } = await put(key, body, { access: 'public', contentType: 'video/mp4', token: blobToken })
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
        return res.json({ url, key, start_ms: clipStartMs, end_ms: clipEndMs, seconds: finalSeconds })
      } catch (e) {
        console.warn('Blob upload failed, falling back:', e?.message || e)
      }
    }

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
      const ytdl = (await import('@distube/ytdl-core')).default
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

    // Choose top-K 60s segments using word density scoring (fallback to lines)
    function chooseTopKSegments(wordsArr, linesArr, windowMs = 60000, k = 3){
      const lastEnd = Math.max(
        wordsArr.length ? wordsArr[wordsArr.length-1].end : 0,
        linesArr.length ? (linesArr[linesArr.length-1].start + linesArr[linesArr.length-1].dur) : 0
      )
      const duration = Math.max(windowMs, lastEnd)
      const step = Math.max(3000, Math.floor(windowMs/12))
      function scoreWindow(s, e){
        if (wordsArr.length){
          const ws = wordsArr.filter(w => w.start < e && w.end > s)
          const count = ws.length
          const punct = ws.filter(w => /[!?]$/.test(w.text)).length
          let gap = 0
          const sorted = ws.slice().sort((a,b)=>a.start-b.start)
          for (let i=1;i<sorted.length;i++){
            const g = sorted[i].start - sorted[i-1].end
            if (g > 800) gap += g
          }
          const density = count / ((e - s)/1000)
          return density + 0.7*punct - 0.0005*gap
        } else {
          const ls = linesArr.filter(l => (l.start < e) && (l.start + l.dur > s))
          return ls.length
        }
      }
      const candidates = []
      for (let t=0; t + windowMs <= duration; t += step){ candidates.push({ s: t, e: t+windowMs, score: scoreWindow(t,t+windowMs) }) }
      candidates.sort((a,b)=> b.score - a.score)
      const chosen = []
      for (const c of candidates){ if (chosen.length>=k) break; if (chosen.some(x=> !(c.e <= x.s || c.s >= x.e))) continue; chosen.push({ start_ms: c.s, end_ms: c.e }) }
      return chosen
    }

    const segments = chooseTopKSegments(words, lines, 60000, Number(target_clip_count||3))

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
// Download a YouTube video and make it available (Blob/S3/stream)
// Body: { youtube_url: string }
// Returns: { url, key, title?, length_seconds? } when storage configured, else streams MP4

// Convenience GET handler to support direct links: forwards to POST internally
app.get('/download_youtube', async (req, res) => {
  try {
    // Validate auth (shared-secret via header, or signed token via t+ts)
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
    const youtube_url = String((req.query && (req.query.youtube_url || req.query.u)) || '').trim()
    if (!youtube_url) return res.status(400).json({ error: 'youtube_url is required' })
    const cookies_txt_base64 = String((req.query && (req.query.cookies_txt_base64 || req.query.cookies || '')) || '').trim()
    const force_client = String((req.query && (req.query.force_client || '')) || '').trim().toLowerCase()
    const force_ipv4 = /^(1|true|yes)$/i.test(String((req.query && (req.query.force_ipv4 || '')) || ''))
    const base = process.env.DOWNLOADER_BASE_URL || ''
    const url = base ? `${base.replace(/\/$/,'')}/download_youtube` : `http://127.0.0.1:${Number(process.env.PORT || 8080)}/download_youtube`
    const body = { youtube_url }
    if (cookies_txt_base64) Object.assign(body, { cookies_txt_base64 })
    if (force_client) Object.assign(body, { force_client })
    if (force_ipv4) Object.assign(body, { force_ipv4: true })
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(req.header('x-shared-secret') ? { 'X-Shared-Secret': req.header('x-shared-secret') } : {}) }, body: JSON.stringify(body) })
    const txt = await r.text().catch(()=> '')
    res.status(r.status)
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('application/json')) res.set('Content-Type','application/json')
    return res.send(txt)
  } catch (e) {
    return res.status(500).json({ error: 'GET forward failed', details: String(e?.message || e) })
  }
})

app.post('/download_youtube', async (req, res) => {
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

    const youtube_url = String((req.body && req.body.youtube_url) || '').trim()
    if (!youtube_url) return res.status(400).json({ error: 'youtube_url is required' })

    // If running on Vercel and a downstream downloader base is configured, proxy the request
    if (process.env.DOWNLOADER_BASE_URL){
      try {
        const base = String(process.env.DOWNLOADER_BASE_URL||'').replace(/\/$/,'')
        const url = `${base}/download_youtube`
        const body = { youtube_url, cookies_txt_base64: String((req.body && req.body.cookies_txt_base64) || ''), force_client: String((req.body && req.body.force_client) || '').trim().toLowerCase(), force_ipv4: Boolean(req.body && req.body.force_ipv4) }
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(req.header('x-shared-secret') ? { 'X-Shared-Secret': req.header('x-shared-secret') } : {}) }, body: JSON.stringify(body) })
        const txt = await r.text().catch(()=> '')
        res.status(r.status)
        const ct = r.headers.get('content-type') || ''
        if (ct.includes('application/json')) res.set('Content-Type','application/json')
        return res.send(txt)
      } catch (e) {
        return res.status(502).json({ error: 'proxy to downloader failed', details: String(e?.message || e) })
      }
    }

    // Option C: Third-party downloader vendor integration
    // Configure via env:
    // - YTDL_VENDOR_URL_TEMPLATE (e.g., "https://api.vendor.com/download?url={url}") OR
    // - YTDL_VENDOR_BASE_URL (used as `${base}/download`)
    // - YTDL_VENDOR_METHOD (GET or POST, default POST)
    // - YTDL_VENDOR_KEY (API key, optional)
    // - YTDL_VENDOR_AUTH_HEADER (header name for API key, default "X-API-Key")
    try {
      const tmpl = String(process.env.YTDL_VENDOR_URL_TEMPLATE||'').trim()
      const base = String(process.env.YTDL_VENDOR_BASE_URL||'').replace(/\/$/,'')
      const method = String(process.env.YTDL_VENDOR_METHOD||'POST').toUpperCase()
      const apiKey = String(process.env.YTDL_VENDOR_KEY||'')
      const authHeader = String(process.env.YTDL_VENDOR_AUTH_HEADER||'X-API-Key')
      let vendorUrl = ''
      let vendorReqInit = { method: method, headers: { 'Content-Type': 'application/json' } }
      if (apiKey) vendorReqInit.headers[authHeader] = apiKey
      if (tmpl){
        vendorUrl = tmpl.replace('{url}', encodeURIComponent(youtube_url))
        if (method === 'GET') { vendorReqInit = { method, headers: vendorReqInit.headers } }
        else vendorReqInit.body = JSON.stringify({ youtube_url })
      } else if (base){
        vendorUrl = `${base}/download`
        if (method === 'GET') {
          const u = new URL(vendorUrl)
          u.searchParams.set('youtube_url', youtube_url)
          vendorUrl = u.toString()
          vendorReqInit = { method, headers: vendorReqInit.headers }
        } else {
          vendorReqInit.body = JSON.stringify({ youtube_url })
        }
      }
      if (vendorUrl){
        const vr = await fetch(vendorUrl, vendorReqInit)
        const vtxt = await vr.text().catch(()=> '')
        let vjson = null
        try { vjson = JSON.parse(vtxt) } catch {}
        if (!vr.ok){
          // Surface vendor error for debugging
          return res.status(vr.status || 502).json({ error: 'vendor_failed', details: vjson?.error || vtxt || String(vr.status) })
        }
        const downloadUrl = vjson?.url || vjson?.download_url || vjson?.result?.url || ''
        if (downloadUrl){
          return res.json({ url: String(downloadUrl), key: null, title: vjson?.title || null, length_seconds: Number(vjson?.length_seconds||0)||undefined })
        }
        // If vendor returns a file (stream), just forward headers/body
        const ct = vr.headers.get('content-type') || ''
        if (!ct.includes('application/json')){
          res.status(200)
          if (ct) res.set('Content-Type', ct)
          return res.send(vtxt)
        }
        // No usable URL in vendor JSON; fall through to self-hosted methods
      }
    } catch (e) {
      // If vendor integration fails for any reason, continue with built-in methods
      console.warn('Vendor downloader integration failed:', e?.message || e)
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'))
    const outPath = path.join(tmp, `${crypto.randomUUID()}.mp4`)

    const ytdl = (await import('@distube/ytdl-core')).default
    // Sanitize URL to avoid extra params like &t=, and add realistic headers to avoid bot checks
    let videoId = ''
    try { videoId = ytdl.getURLVideoID(youtube_url) } catch {}
    const cleanUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : youtube_url

    // Accept cookies from multiple sources (priority: request body cookies_txt_base64 > env YT_COOKIES_B64 > env YT_COOKIES header-string)
    const cookiesTxtBase64 = String((req.body && req.body.cookies_txt_base64) || '').trim()
    const cookieHdrEnv = (process.env.YT_COOKIES || '').trim()
    const cookieB64Env = (process.env.YT_COOKIES_B64 || '').trim()
    // Maintain consent cookie for header-string path
    const hasConsent = /(?:^|;\s*)CONSENT=/.test(cookieHdrEnv)
    const combinedCookieHdr = (cookieHdrEnv ? cookieHdrEnv : '') + (hasConsent ? '' : (cookieHdrEnv ? '; ' : '') + 'CONSENT=YES+1')

    const REQ = { requestOptions: { headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'max-age=0',
      'dnt': '1',
      'upgrade-insecure-requests': '1',
      // Client hints + fetch metadata to better mimic browser requests
      'sec-ch-ua': '"Chromium";v="126", "Not;A=Brand";v="24", "Google Chrome";v="126"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'referer': 'https://www.youtube.com/',
      'origin': 'https://www.youtube.com',
      ...(combinedCookieHdr ? { cookie: combinedCookieHdr } : {})
    } } }
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    let title = ''
    let length_seconds = 0
    let downloaded = false
    let ytDlpLastErr = ''
    let ytdlCoreErr = ''

    const disableYtdlCore = /^(1|true|yes)$/i.test(String(process.env.DISABLE_YTDL_CORE||''))
    const forceClient = String((req.body && req.body.force_client) || '').trim().toLowerCase() // e.g., 'ios' or 'android'
    const forceIpv4 = /^(1|true|yes)$/i.test(String((req.body && req.body.force_ipv4) || process.env.YT_DLP_FORCE_IPV4 || ''))

    // Primary path: ytdl-core (unless disabled)
    if (!disableYtdlCore){
      try {
        const info = await ytdl.getInfo(cleanUrl, REQ)
        title = info?.videoDetails?.title || ''
        length_seconds = Number(info?.videoDetails?.lengthSeconds || 0) || 0

        const avFormats = ytdl.filterFormats(info.formats, 'videoandaudio') || []
        let fmt = avFormats.filter(f => String(f.container||'').toLowerCase()==='mp4')
          .sort((a,b)=> (Number(b.width||0) - Number(a.width||0)) || (Number(b.bitrate||0) - Number(a.bitrate||0)))[0]
        if (!fmt) fmt = avFormats.sort((a,b)=> (Number(b.width||0) - Number(a.bitrate||0)))[0]

        if (fmt && fmt.itag){
          await new Promise((resolve, reject) => {
            const stream = ytdl(cleanUrl, { quality: fmt.itag, highWaterMark: 1<<25, ...REQ })
            const ws = fs.createWriteStream(outPath)
            stream.on('error', reject)
            ws.on('error', reject)
            ws.on('finish', resolve)
            stream.pipe(ws)
          })
          downloaded = true
        } else {
          const vPath = path.join(tmp, `${crypto.randomUUID()}.video`)
          const aPath = path.join(tmp, `${crypto.randomUUID()}.audio`)
          await new Promise((resolve, reject) => {
            const vs = ytdl(cleanUrl, { quality: 'highestvideo', filter: 'videoonly', highWaterMark: 1<<25, ...REQ })
            const ws = fs.createWriteStream(vPath)
            let done = false
            const finish = ()=> { if (!done){ done = true; resolve(undefined) } }
            vs.on('error', reject)
            ws.on('error', reject)
            ws.on('finish', finish)
            vs.pipe(ws)
          })
          await new Promise((resolve, reject) => {
            const as = ytdl(cleanUrl, { quality: 'highestaudio', filter: 'audioonly', highWaterMark: 1<<25, ...REQ })
            const ws = fs.createWriteStream(aPath)
            let done = false
            const finish = ()=> { if (!done){ done = true; resolve(undefined) } }
            as.on('error', reject)
            ws.on('error', reject)
            ws.on('finish', finish)
            as.pipe(ws)
          })
          await new Promise((resolve, reject) => {
            try {
              const cmd = ffmpegLib()
              cmd.input(vPath)
              cmd.input(aPath)
              cmd.outputOptions(['-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k'])
              cmd.on('end', resolve)
              cmd.on('error', reject)
              cmd.save(outPath)
            } catch (e) { reject(e) }
          })
          downloaded = true
        }
      } catch (e) {
        ytdlCoreErr = String(e?.message || e)
        console.warn('ytdl-core path failed, will try yt-dlp fallback:', e?.message || e)
      }
    }

    // Fallback path: yt-dlp (static binary)
    if (!downloaded && !runningOnVercel){
      try {
        const ytBin = ytDlpPath || '/usr/local/bin/yt-dlp'

        // Helper to run yt-dlp and capture output while echoing to logs
        async function runYtDlp(args){
          return await new Promise((resolve) => {
            const proc = spawn(ytBin, args, { stdio: ['ignore','pipe','pipe'] })
            let out = ''
            let err = ''
            proc.stdout.on('data', (d)=>{ const s = d.toString(); out += s; process.stdout.write(s) })
            proc.stderr.on('data', (d)=>{ const s = d.toString(); err += s; process.stderr.write(s) })
            proc.on('error', (e)=> resolve({ ok:false, code: -1, out, err, error: e }))
            proc.on('exit', (code)=> resolve({ ok: code===0, code: code||0, out, err, error: null }))
          })
        }

        // Build cookies file if provided
        // Helper: normalize cookies buffer to UTF-8 Netscape format
        function normalizeCookiesBuffer(buf){
          try {
            if (!buf || !buf.length) return Buffer.from('')
            // UTF-16 BOM LE
            if (buf.length>=2 && buf[0]===0xFF && buf[1]===0xFE){
              const td = new TextDecoder('utf-16le')
              const s = td.decode(buf.slice(2))
              return Buffer.from(s, 'utf8')
            }
            // UTF-16 BOM BE
            if (buf.length>=2 && buf[0]===0xFE && buf[1]===0xFF){
              const le = Buffer.allocUnsafe(buf.length - 2)
              for (let j=2, k=0; j+1<buf.length; j+=2, k+=2){ le[k] = buf[j+1]; le[k+1] = buf[j] }
              const td = new TextDecoder('utf-16le')
              const s = td.decode(le)
              return Buffer.from(s, 'utf8')
            }
            // Heuristic: lots of NUL bytes implies UTF-16LE without BOM
            let nul = 0; for (let i=0;i<buf.length;i++){ if (buf[i]===0) nul++ }
            if (nul > buf.length/4){
              const td = new TextDecoder('utf-16le')
              const s = td.decode(buf)
              return Buffer.from(s, 'utf8')
            }
            return buf
          } catch { return buf }
        }

    let cookieFile = ''
    // Prefer stored admin cookies if present when none are provided inline
    try { if (fs.existsSync(COOKIES_STORE_PATH) && !cookiesTxtBase64 && !cookieB64Env && !combinedCookieHdr) cookieFile = COOKIES_STORE_PATH } catch {}
    if (cookiesTxtBase64){
      try {
        const ckTmp = path.join(tmp, 'cookies.txt')
        const raw = Buffer.from(cookiesTxtBase64, 'base64')
        const norm = normalizeCookiesBuffer(raw)
        fs.writeFileSync(ckTmp, norm)
        cookieFile = ckTmp
      } catch {}
    } else if (cookieB64Env){
      try {
        const ckTmp = path.join(tmp, 'cookies.txt')
        const raw = Buffer.from(cookieB64Env, 'base64')
        const norm = normalizeCookiesBuffer(raw)
        fs.writeFileSync(ckTmp, norm)
        cookieFile = ckTmp
      } catch {}
    } else if (combinedCookieHdr){
      try {
        const ckTmp = path.join(tmp, 'cookies.txt')
        const nowExp = 2147483647 // far future
        const pairs = String(combinedCookieHdr).split(/;\s*/).map(s=>s.trim()).filter(Boolean)
        const lines = ['# Netscape HTTP Cookie File']
        for (const pair of pairs){
          const eq = pair.indexOf('='); if (eq <= 0) continue
          const name = pair.slice(0, eq).trim()
          const value = pair.slice(eq+1).trim()
          const domain = '.youtube.com'
          const includeSub = 'TRUE'
          const pathCookie = '/'
          const secure = 'FALSE'
          lines.push([domain, includeSub, pathCookie, secure, String(nowExp), name, value].join('\t'))
        }
        fs.writeFileSync(ckTmp, lines.join('\n'), 'utf8')
        cookieFile = ckTmp
      } catch {}
    }

        // Common args
        const maxHraw = Number(process.env.YT_DLP_MAX_HEIGHT || 720)
        const maxH = Number.isFinite(maxHraw) && maxHraw >= 240 ? Math.min(2160, Math.floor(maxHraw)) : 720
        const format = `bv*[ext=mp4][height<=${maxH}]+ba[ext=m4a]/b[ext=mp4][height<=${maxH}]/best`
        const baseArgs = [
          '--ignore-config', '--no-call-home', '--no-playlist', '--no-continue', '--no-part',
          '--retries','10','--fragment-retries','10','--retry-sleep','1:3', '--socket-timeout','15',
          ...(forceIpv4 ? ['--force-ipv4'] : []),
          '--add-header', `User-Agent: ${ua}`, '--add-header', 'Accept-Language: en-US,en;q=0.9', '--add-header', 'Referer: https://www.youtube.com/'
        ]

        const attempts = []
        // Attempt 1: with cookies if present
        const args1 = [...baseArgs]
        if (cookieFile) args1.push('--cookies', cookieFile)
        if (forceClient === 'ios') args1.push('--extractor-args', 'youtube:player_client=ios')
        else if (forceClient === 'android') args1.push('--extractor-args', 'youtube:player_client=android')
        else args1.push('--extractor-args', 'youtube:player_client=web_safari-17.4')
        args1.push('-f', format, '--merge-output-format','mp4','-o', outPath, cleanUrl)
        attempts.push({ name: 'cookies+default', args: args1 })

        // Attempt 2: no cookies, prefer safer clients
        const args2 = [...baseArgs, '--extractor-args', 'youtube:player_client=web_safari-17.4,tv_embedded,android']
        args2.push('-f', format, '--merge-output-format','mp4','-o', outPath, cleanUrl)
        attempts.push({ name: 'nocookies+clients', args: args2 })

        // Attempt 3: last resort - iOS client only (sometimes bypasses checks)
        const args3 = [...baseArgs, '--extractor-args', 'youtube:player_client=ios']
        args3.push('-f', format, '--merge-output-format','mp4','-o', outPath, cleanUrl)
        attempts.push({ name: 'ios-client', args: args3 })

        let ok = false
        let lastErr = ''
        for (const at of attempts){
          console.log(`yt-dlp attempt: ${at.name}`)
          const r = await runYtDlp(at.args)
          if (r.ok){ ok = true; break }
          lastErr = (r.err || r.out || '').slice(-2000)
          ytDlpLastErr = lastErr
          // If cookies explicitly invalid, drop them for next attempts automatically
          if (/cookies are no longer valid|Sign in to confirm you.?re not a bot/i.test(r.err || r.out || '')){
            // ensure next attempts don't try cookies
            for (const a of attempts){
              const i = a.args.indexOf('--cookies'); if (i>=0){ a.args.splice(i, 2) }
            }
          }
        }
        if (!ok){ throw new Error(lastErr || 'yt-dlp failed') }
        downloaded = true
      } catch (e) {
        console.warn('yt-dlp fallback failed:', e?.message || e)
      }
    }

    if (!downloaded){
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      const debugYt = String(process.env.DEBUG_YT_DLP||'') === '1' || String(process.env.NODE_ENV||'') !== 'production'
      const parts = []
      if (ytdlCoreErr) parts.push(`ytdl-core: ${ytdlCoreErr}`)
      if (ytDlpLastErr) parts.push(`yt-dlp: ${ytDlpLastErr}`)
      if (runningOnVercel) parts.push('yt-dlp fallback disabled on Vercel')
      const details = parts.join('\n\n') || undefined
      const body = debugYt && details ? { error: 'youtube download failed', details } : { error: 'youtube download failed' }
      return res.status(502).json(body)
    }

    // Upload or stream
    const hasS3 = Boolean(process.env.S3_BUCKET && process.env.AWS_REGION && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI))
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN || ''
    const key = `renders/${Date.now()}-${crypto.randomUUID()}.mp4`

    if (blobToken){
      try {
        const { put } = await import('@vercel/blob')
        const body = fs.readFileSync(outPath)
        const up = await put(key, body, { access: 'public', contentType: 'video/mp4', token: blobToken })
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
        return res.json({ url: up.url, key, title, length_seconds })
      } catch (e) {
        console.warn('Blob upload failed, falling back:', e?.message || e)
      }
    }

    if (hasS3){
      const bucket = process.env.S3_BUCKET
      const body = fs.readFileSync(outPath)
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'video/mp4', ACL: 'public-read' }))
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      const url = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`
      return res.json({ url, key, title, length_seconds })
    }

    // Stream file if no storage configured
    const stat = fs.statSync(outPath)
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size), 'Cache-Control': 'no-store' })
    const rs = fs.createReadStream(outPath)
    rs.pipe(res)
    rs.on('close', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e?.message || 'download_youtube failed' })
  }
})

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

    const { mp3_url, video_url = '', csv_url, csv_text = '', word_csv_url = '', word_csv_text = '', segments = [], bg_urls = [], bg_url = '', preset = 'tiktok_v1' } = req.body || {}
    if (!Array.isArray(segments) || segments.length === 0) return res.status(400).json({ error: 'segments array required' })

    const hasS3 = Boolean(process.env.S3_BUCKET && process.env.AWS_REGION && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI))

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-batch-'))
    const audioPath = path.join(tmp, `${crypto.randomUUID()}.mp3`)
    const csvPath = path.join(tmp, `${crypto.randomUUID()}.csv`)

    // Load audio: prefer mp3_url; else if video_url provided, extract; disallow external links (YouTube) to enforce uploads
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
    } else {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      return res.status(400).json({ error: 'Provide video_url (uploaded) or mp3_url' })
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
      let url = ''
      let key = `renders/${Date.now()}-${crypto.randomUUID()}.mp4`
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN || ''
      if (blobToken){
        try {
          const { put } = await import('@vercel/blob')
          const up = await put(key, body, { access: 'public', contentType: 'video/mp4', token: blobToken })
          url = up.url
        } catch (e) { console.warn('Blob upload failed:', e?.message || e) }
      }
      if (!url && bucket && hasS3){
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

// Auto clipper: transcribe uploaded video, choose segments, render clips
// Public endpoint: forwards to auto_clip with server-side secret when request originates from allowed origins
// Async job starter (public): returns 202 with job_id and processes in background
app.post('/auto_clip_start_public', async (req, res) => {
  try {
    // Same allowlist logic as /auto_clip_public
    const bypass = req.header('x-vercel-protection-bypass') || req.header('x-vercel-protection-bypass-secret') || ''
    const origin = String(req.headers.origin || '').toLowerCase()
    const allowed = (() => {
      if (bypass) return true
      if (!origin) return false
      try {
        const u = new URL(origin)
        const h = u.host || ''
        if (h === 'clipcatalyst.net') return true
        if (h.endsWith('.vercel.app')) return true
      } catch {}
      return false
    })()
    if (!allowed) return res.status(403).json({ error: 'forbidden' })

    const params = req.body || {}
    const id = newJobId()
    setJob(id, { id, status: 'queued', result: null, error: null })
    // kick off background processing
    ;(async ()=>{
      try {
        setJob(id, { status: 'running' })
        const result = await runAutoClipJob(params)
        setJob(id, { status: 'completed', result })
      } catch (e) {
        setJob(id, { status: 'error', error: String(e?.message || e) })
      }
    })()

    res.status(202).json({ job_id: id })
  } catch (e) {
    res.status(500).json({ error: e?.message || 'start failed' })
  }
})

// Async job starter (private): requires shared secret
app.post('/auto_clip_start', async (req, res) => {
  try {
    const required = process.env.SHARED_SECRET
    if (required && req.header('x-shared-secret') !== required) return res.status(403).json({ error: 'forbidden' })
    const params = req.body || {}
    const id = newJobId()
    setJob(id, { id, status: 'queued', result: null, error: null })
    ;(async ()=>{
      try {
        setJob(id, { status: 'running' })
        const result = await runAutoClipJob(params)
        setJob(id, { status: 'completed', result })
      } catch (e) {
        setJob(id, { status: 'error', error: String(e?.message || e) })
      }
    })()
    res.status(202).json({ job_id: id })
  } catch (e) { res.status(500).json({ error: e?.message || 'start failed' }) }
})

// Job status
app.get('/jobs/:id', async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim()
    if (!id) return res.status(400).json({ error: 'missing id' })
    const j = jobs.get(id)
    if (!j) return res.status(404).json({ error: 'not_found' })
    const { status, result, error, createdAt, updatedAt } = j
    res.json({ id, status, error, result, createdAt, updatedAt })
  } catch (e) { res.status(500).json({ error: e?.message || 'status failed' }) }
})

app.post('/auto_clip_public', async (req, res) => {
  try {
    // Allow if caller includes Vercel bypass header OR Origin is allowed
    const bypass = req.header('x-vercel-protection-bypass') || req.header('x-vercel-protection-bypass-secret') || ''
    const origin = String(req.headers.origin || '').toLowerCase()
    const host = String(req.headers.host || '').toLowerCase()
    const allowed = (() => {
      if (bypass) return true
      if (!origin) return false
      try {
        // Allow your production site and Vercel preview domains
        const u = new URL(origin)
        const h = u.host || ''
        if (h === 'clipcatalyst.net') return true
        if (h.endsWith('.vercel.app')) return true
      } catch {}
      return false
    })()
    if (!allowed) return res.status(403).json({ error: 'forbidden' })

    const base = process.env.DOWNLOADER_BASE_URL || ''
    const url = (runningOnVercel && base) ? `${base.replace(/\/$/,'')}/auto_clip` : `http://127.0.0.1:${Number(process.env.PORT || 8080)}/auto_clip`
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Inject server-side secret for the forward
        ...(process.env.SHARED_SECRET ? { 'X-Shared-Secret': process.env.SHARED_SECRET } : {})
      },
      body: JSON.stringify(req.body || {})
    })
    const txt = await r.text().catch(()=> '')
    res.status(r.status)
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('application/json')) res.set('Content-Type','application/json')
    return res.send(txt)
  } catch (e) {
    return res.status(500).json({ error: 'forward failed', details: String(e?.message || e) })
  }
})

app.post('/auto_clip', async (req, res) => {
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

    let { video_url, youtube_url, language, target_clip_count = 3, min_ms = 18000, max_ms = 30000, bg_urls = [], bg_url = '' } = req.body || {}

    // If a YouTube URL is provided, resolve it to a downloadable MP4 via our downloader
    if (!video_url && typeof youtube_url === 'string' && youtube_url.trim()) {
      try {
        const base = process.env.DOWNLOADER_BASE_URL || ''
        const dlUrl = base
          ? `${base.replace(/\/$/, '')}/download_youtube`
          : `http://127.0.0.1:${Number(process.env.PORT || 8080)}/download_youtube`
        const r = await fetch(dlUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.SHARED_SECRET ? { 'X-Shared-Secret': process.env.SHARED_SECRET } : {}),
          },
          body: JSON.stringify({ youtube_url })
        })
        const j = await r.json().catch(()=>null)
        if (!r.ok || !j?.url) return res.status(r.status || 502).json({ error: 'youtube_download_failed', details: j?.details || j?.error || 'no url' })
        video_url = String(j.url)
      } catch (e) {
        return res.status(502).json({ error: 'youtube_download_failed', details: String(e?.message || e) })
      }
    }

    if (!video_url || typeof video_url !== 'string') return res.status(400).json({ error: 'video_url is required' })

    const API = process.env.ASSEMBLYAI_API_KEY || ''
    if (!API) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not set' })

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclip-'))
    const vidPath = path.join(tmp, `${crypto.randomUUID()}.mp4`)
    const mp3Path = path.join(tmp, `${crypto.randomUUID()}.mp3`)

    // Download the uploaded video
    const rv = await fetch(video_url)
    if (!rv.ok) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(400).json({ error: 'failed to fetch video_url' }) }
    fs.writeFileSync(vidPath, Buffer.from(await rv.arrayBuffer()))

    // Probe input to ensure an audio stream exists (fail fast with friendly error)
    const hasAudioStream = await new Promise((resolve) => {
      try {
        ffmpegLib.ffprobe(vidPath, (_err, data) => {
          try {
            const streams = Array.isArray(data?.streams) ? data.streams : []
            resolve(streams.some((s) => String(s?.codec_type||'').toLowerCase() === 'audio'))
          } catch { resolve(false) }
        })
      } catch { resolve(false) }
    })
    if (!hasAudioStream) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(400).json({ error: 'no_audio_stream', details: 'The input video contains no audio track; cannot transcribe.' }) }

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

    // Upload to AssemblyAI
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
    while (Date.now() - started < 180000){ // up to ~3 minutes
      await new Promise(r=>setTimeout(r, 3000))
      const st = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers: { 'Authorization': API } })
      if (!st.ok) continue
      const js = await st.json().catch(()=>null)
      status = js?.status || ''
      if (status === 'completed'){ result = js; break }
      if (status === 'error'){ try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(502).json({ error: 'AssemblyAI error', details: js?.error || 'unknown' }) }
    }

    if (!result){ try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(504).json({ error: 'transcription timeout' }) }

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

    // Scoring-based selection: pick top-K non-overlapping 60s windows
    function chooseTopKSegments(wordsArr, linesArr, windowMs = 60000, k = 3){
      const lastEnd = Math.max(
        wordsArr.length ? wordsArr[wordsArr.length-1].end : 0,
        linesArr.length ? (linesArr[linesArr.length-1].start + linesArr[linesArr.length-1].dur) : 0
      )
      const duration = Math.max(windowMs, lastEnd)
      const step = Math.max(3000, Math.floor(windowMs/12)) // ~12 steps per window

      function scoreWindow(s, e){
        // Use words for density/pauses; fall back to line count
        if (wordsArr.length){
          const ws = wordsArr.filter(w => w.start < e && w.end > s)
          const count = ws.length
          const punct = ws.filter(w => /[!?]$/.test(w.text)).length
          // Gap penalty: sum of gaps > 800ms
          let gap = 0
          const sorted = ws.slice().sort((a,b)=>a.start-b.start)
          for (let i=1;i<sorted.length;i++){
            const g = sorted[i].start - sorted[i-1].end
            if (g > 800) gap += g
          }
          const density = count / ((e - s)/1000)
          return density + 0.7*punct - 0.0005*gap
        } else {
          // Fallback: number of lines that overlap
          const ls = linesArr.filter(l => (l.start < e) && (l.start + l.dur > s))
          return ls.length
        }
      }

      const candidates = []
      for (let t=0; t + windowMs <= duration; t += step){
        const s = t
        const e = t + windowMs
        candidates.push({ s, e, score: scoreWindow(s,e) })
      }
      candidates.sort((a,b)=> b.score - a.score)

      const chosen = []
      for (const c of candidates){
        if (chosen.length >= k) break
        if (chosen.some(x => !(c.e <= x.s || c.s >= x.e))) continue // overlap
        chosen.push({ start_ms: c.s, end_ms: c.e, score: c.score })
      }

      // If we picked fewer than k due to overlap, greedily add next best non-overlapping
      if (chosen.length < k){
        for (const c of candidates){
          if (chosen.length >= k) break
          if (chosen.some(x => !(c.e <= x.s || c.s >= x.e))) continue
          chosen.push({ start_ms: c.s, end_ms: c.e, score: c.score })
        }
      }
      return chosen.map(x => ({ start_ms: x.start_ms, end_ms: x.end_ms }))
    }

    // Force 60s windows by default, otherwise respect provided min/max
    const wantExactMinute = true
    const segments = wantExactMinute
      ? chooseTopKSegments(words, lines, 60000, Number(target_clip_count||3))
      : (function fallback(){
          const out = []
          let cursor = 0
          let i = 0
          while (i < lines.length && out.length < Number(target_clip_count||3)){
            const segStart = Math.max(cursor, lines[i].start)
            let segEnd = segStart
            let j = i
            while (j < lines.length){
              const nextEnd = Math.max(segEnd, lines[j].start + lines[j].dur)
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
        })()
    if (!segments.length){ try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; return res.status(502).json({ error: 'no segments chosen' }) }

    // Build CSV texts (global) for reuse in rendering
    const csv_text = lines.map(l=>`${l.start},${l.start + l.dur},"${(l.text||'').replace(/"/g,'""')}"`).join('\n')
    const word_csv_text = words.map(w=>`${w.start},${w.end},"${(w.text||'').replace(/"/g,'""')}"`).join('\n')

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

    // Helpers replicated from render_batch
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
    const allEvents = parseStartEndCsv(csv_text)
    const allWords = parseStartEndCsv(word_csv_text)

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

    const bucket = process.env.S3_BUCKET
    const region = process.env.AWS_REGION
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN || ''
    const outputs = []

    for (const seg of segments){
      const sMs = Math.max(0, Math.floor(Number(seg?.start_ms||0)))
      const eMs = Math.max(sMs+1, Math.floor(Number(seg?.end_ms||0)))
      let segEvents = clipEvents(allEvents, sMs, eMs)
      const segWords = clipWordTimes(allWords, sMs, eMs)
      if ((!allEvents || allEvents.length===0) && (!segEvents || segEvents.length===0)){
        // synthesize
        const txt = lines.map(l=> l.start >= sMs && (l.start + l.dur) <= eMs ? l.text : '').filter(Boolean).join(' ')
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
      cmd.input(vidPath)

      const assEsc = assPath.replace(/:/g,'\\:').replace(/'/g,"\\'")
      const startSec = (sMs/1000).toFixed(3)
      const durSec = ((eMs - sMs)/1000).toFixed(3)
      // Build a connected filtergraph: compose background + trimmed foreground, then apply subtitles
      const filters = [
        // Ensure 1080x1920 background
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,setpts=PTS-STARTPTS[bg]`,
        // Trim and scale foreground (source video)
        `[1:v]trim=start=${startSec}:duration=${durSec},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,setsar=1[fg]`,
        // Overlay centered, stop at shortest
        `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[base]`,
        // Subtitles and format
        `[base]format=yuv420p,ass='${assEsc}'[v]`,
        // Trim audio to the same window
        `[1:a]atrim=start=${startSec}:duration=${durSec},asetpts=PTS-STARTPTS[a]`
      ]
      cmd.complexFilter(filters)
      cmd.outputOptions([
        '-map','[v]','-map','[a]',
        '-c:v','libx264','-preset','medium','-crf','20',
        '-pix_fmt','yuv420p','-c:a','aac','-b:a','192k',
        '-t', String(finalSeconds)
      ])

      await new Promise((resolve, reject) => { cmd.on('end', resolve); cmd.on('error', reject); cmd.save(outPath) })
      const body = fs.readFileSync(outPath)
      let url = ''
      let key = `renders/${Date.now()}-${crypto.randomUUID()}.mp4`
      if (blobToken){
        try { const { put } = await import('@vercel/blob'); const up = await put(key, body, { access: 'public', contentType: 'video/mp4', token: blobToken }); url = up.url } catch (e) { console.warn('Blob upload failed:', e?.message || e) }
      }
      if (!url && bucket && region){
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'video/mp4', ACL: 'public-read' }))
        url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`
      }
      outputs.push({ url, key, start_ms: sMs, end_ms: eMs, seconds: finalSeconds })
    }

    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    return res.json({ clips: outputs })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e?.message || 'auto_clip failed' })
  }
})

const PORT = Number(process.env.PORT || 8080)
if (!runningOnVercel) {
  app.listen(PORT, '0.0.0.0', () => console.log(`worker listening on :${PORT}`));
}
export default app;

