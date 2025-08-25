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

    const { mp3_url, csv_url, bg_urls = [], bg_url = '', preset = 'tiktok_v1', title } = req.body || {};
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
      const SHIFT_MS = -80 // show slightly earlier to match perceived audio
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
      return ev
    }
    function msToAss(ms){const h=String(Math.floor(ms/3600000)).padStart(1,'0');const m=String(Math.floor((ms%3600000)/60000)).padStart(2,'0');const s=String(Math.floor((ms%60000)/1000)).padStart(2,'0');const cs=String(Math.floor((ms%1000)/10)).padStart(2,'0');return `${h}:${m}:${s}.${cs}`}
    // Build "one word at a time" ASS where each word pops in/out
    function buildWordAss(events){
      const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Word, Inter, 46, &H00FFFFFF, &H000000FF, &H00000000, &H7F000000, -1, 0, 0, 0, 100, 100, 0, 0, 1, 8, 0, 2, 80, 80, 220, 1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
      const outLines = []
      for (const ev of events){
        const text = String(ev.text||'').replace(/\\s+/g,' ').trim()
        if (!text) continue
        const words = text.split(' ').filter(Boolean)
        const hasExact = Number.isFinite(ev.start) && Number.isFinite(ev.end) && ev.end > ev.start
        if (words.length === 1 && hasExact){
          // Exact word timing from CSV (start,end in ms)
          const st = msToAss(ev.start)
          const en = msToAss(ev.end)
          // No extra fade/animation so display matches exact audio window
          const tag = `{\\an2\\bord8}`
          outLines.push(`Dialogue: 0,${st},${en},Word,,0,0,0,,${tag}${words[0]}`)
          continue
        }
        // Fallback: distribute words across the event interval
        const total = Math.max(400, ev.end - ev.start)
        const per = Math.max(100, Math.floor(total / Math.max(1, words.length)))
        for (let i=0;i<words.length;i++){
          const ws = ev.start + i*per
          const we = (i===words.length-1) ? ev.end : Math.min(ev.end, ws + per)
          const st = msToAss(ws)
          const wordDur = Math.max(80, Math.min(we - ws, Math.floor(per * 0.75)))
          const en = msToAss(ws + wordDur)
          const tag = `{\\an2\\bord8\\fad(40,80)\\fscx55\\fscy55\\t(0,90,\\fscx125\\fscy125)\\t(90,180,\\fscx100\\fscy100)}`
          outLines.push(`Dialogue: 0,${st},${en},Word,,0,0,0,,${tag}${words[i]}`)
        }
      }
      return header + outLines.join('\n') + '\n'
    }
    const csvText = fs.readFileSync(csvPath,'utf8')
    const eventsArr = csvToEvents(csvText)
    const lastEndMs = eventsArr.length ? Math.max(...eventsArr.map(e=>e.end)) : 0
    const derivedSeconds = Math.ceil((lastEndMs||0)/1000)
    const finalSeconds = Math.max(outSeconds, derivedSeconds)
    const assPath = path.join(tmp,'subs.ass')
    fs.writeFileSync(assPath, buildWordAss(eventsArr),'utf8')

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
    cmd.complexFilter([`[0:v]${vf}[v]`])

    cmd.outputOptions([
      '-map','[v]',
      '-map','1:a',
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
      res.json({ url, key });
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

app.listen(8080, () => console.log('worker listening on :8080'));

