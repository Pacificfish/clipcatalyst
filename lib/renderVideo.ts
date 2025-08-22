import fs from 'fs'
import os from 'os'
import path from 'path'
import ffmpegLib from 'fluent-ffmpeg'

const ffmpeg = ffmpegLib

// Resolve ffmpeg binary path robustly for serverless using optional requires
try {
  const candidates: string[] = []
  try {
    const mod = (eval('require'))('@ffmpeg-installer/ffmpeg')
    if (mod?.path) candidates.push(mod.path)
  } catch {}
  try {
    const p = (eval('require'))('ffmpeg-static')
    if (p && typeof p === 'string') candidates.push(p as string)
  } catch {}
  // Common serverless locations
  candidates.push(
    '/var/task/node_modules/@ffmpeg-installer/linux-x64/ffmpeg',
    '/var/task/node_modules/ffmpeg-static/ffmpeg',
    require('path').join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
  )
  for (const p of candidates) {
    if (p && require('fs').existsSync(p)) {
      // eslint-disable-next-line no-console
      console.log('[render] using ffmpeg at', p)
      ffmpeg.setFfmpegPath(p)
      break
    }
  }
} catch {}

// Resolve ffprobe path with optional requires
try {
  const probeCandidates: string[] = []
  try {
    const mod = (eval('require'))('@ffprobe-installer/ffprobe')
    if (mod?.path) probeCandidates.push(mod.path)
  } catch {}
  try {
    const st = (eval('require'))('ffprobe-static')
    if (st?.path) probeCandidates.push(st.path)
  } catch {}
  // Common serverless locations
  probeCandidates.push(
    '/var/task/node_modules/@ffprobe-installer/linux-x64/ffprobe',
    require('path').join(process.cwd(), 'node_modules', '@ffprobe-installer', 'linux-x64', 'ffprobe'),
    require('path').join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe'),
    '/var/task/node_modules/ffprobe-static/bin/linux/x64/ffprobe'
  )
  for (const p of probeCandidates) {
    if (p && require('fs').existsSync(p)) {
      // eslint-disable-next-line no-console
      console.log('[render] using ffprobe at', p)
      ffmpeg.setFfprobePath(p)
      break
    }
  }
} catch {}

function parseCsv(line: string){
  const parts: string[] = []
  let cur = ''
  let inQ = false
  for (let i=0;i<line.length;i++){
    const ch = line[i]
    if (ch === '"'){ inQ = !inQ; continue }
    if (ch === ',' && !inQ){ parts.push(cur); cur=''; continue }
    cur += ch
  }
  parts.push(cur)
  return parts
}

function hmsToMs(t: string){
  const seg = String(t).trim()
  const pts = seg.split(':').map(Number)
  if (pts.some(x => Number.isNaN(x))) return null
  let h=0,m=0,s=0
  if (pts.length === 2){ [m,s] = pts }
  else if (pts.length === 3){ [h,m,s] = pts }
  else return null
  return ((h*60+m)*60+s)*1000
}

function csvToEvents(csvText: string){
  const lines = csvText.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return [] as {start:number,end:number,text:string}[]
  const header = lines[0].toLowerCase()
  const body = header.includes('time') || header.includes('start') || header.includes('text') ? lines.slice(1) : lines
  const rows = body.map(parseCsv).filter(r => r.length>=2)
  const events: {start:number,end:number,text:string}[] = []
  if (header.includes('start') && header.includes('end')){
    for (const r of rows){
      const start = Number(r[0]) || 0
      const end = Number(r[1]) || Math.max(500, start+1500)
      const text = (r.slice(2).join(',') || '').trim()
      events.push({ start, end, text })
    }
    return events
  }
  const times = rows.map(r => hmsToMs(r[0]))
  for (let i=0;i<rows.length;i++){
    const t = times[i]
    if (t==null) continue
    const next = times[i+1]
    const end = next!=null ? Math.max(t+500, next) : t+1500
    const text = (rows[i].slice(1).join(',') || '').trim()
    events.push({ start: t, end, text })
  }
  return events
}

function msToAssTime(ms: number){
  const h = Math.floor(ms/3600000).toString().padStart(1,'0')
  const m = Math.floor((ms%3600000)/60000).toString().padStart(2,'0')
  const s = Math.floor((ms%60000)/1000).toString().padStart(2,'0')
  const cs = Math.floor((ms%1000)/10).toString().padStart(2,'0')
  return `${h}:${m}:${s}.${cs}`
}

function buildAss(events: {start:number,end:number,text:string}[], preset?: string){
  const isTikTok = preset === 'tiktok_v1'
  const header = `[
Script Info]
; TikTok-style bold captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTok, Inter, ${isTikTok ? 84 : 72}, \u0026H00FFFFFF, \u0026H000000FF, \u0026H00101010, \u0026H7F000000, -1, 0, 0, 0, 100, 100, 0, 0, 1, ${isTikTok ? 8 : 6}, ${isTikTok ? 2 : 0}, 2, 80, 80, ${isTikTok ? 140 : 160}, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const lines = events.map(e => {
    const start = msToAssTime(e.start)
    const end = msToAssTime(Math.max(e.end, e.start+500))
    const txt = e.text.replace(/\s+/g,' ').split(' ').map(w => `{\\bord6}\\b1${w}\\b0`).join(' ')
    return `Dialogue: 0,${start},${end},TikTok,,0,0,0,,{\\an2}${txt}`
  }).join('\n')
  return header + lines + '\n'
}

async function getAudioDurationMs(audioPath: string): Promise<number>{
  return new Promise((resolve) => {
    try {
      ffmpeg.ffprobe(audioPath, (err: any, data: any) => {
        if (err) return resolve(0)
        const s = data?.format?.duration || 0
        resolve(Math.max(0, Math.floor(s*1000)))
      })
    } catch { resolve(0) }
  })
}

export async function renderVideo(opts: { audio: string, captions: string, out: string, bgs?: string[], music?: string, preset?: string, title?: string, logo?: string, noSubs?: boolean }){
  const { audio, captions, out, bgs, music, preset, title, logo, noSubs } = opts
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'))
  const assPath = path.join(tmp, 'subs.ass')
  const csvText = fs.readFileSync(captions, 'utf8')
  const events = csvToEvents(csvText)
  const ass = buildAss(events, preset)
  fs.writeFileSync(assPath, ass, 'utf8')

  const cmd = ffmpeg()
  let videoInput: string
  let totalSec = 0
  const bgCount = Array.isArray(bgs) ? bgs.length : 0
  if (bgCount){
    for (const bg of bgs!) cmd.input(bg)
    videoInput = '[vout]'
  } else {
    const durMs = await getAudioDurationMs(audio)
    const last = events.length ? events[events.length - 1] : undefined
    const totalMs = Math.max(durMs, (last?.end || 5000))
    totalSec = Math.max(1, Math.ceil(totalMs/1000))
    cmd.input(`color=c=#0b0b0f:s=1080x1920:r=30:d=${totalSec}`).inputFormat('lavfi')
    videoInput = '[0:v]'
  }
  cmd.input(audio)
  if (music) cmd.input(music)
  const haveLogo = Boolean(logo)

  const chains: { filter: string, outputs?: string[] }[] = []
  let lastLabel: string | null = null
  if (bgCount){
    const processed = (bgs || []).map((_, i) => {
      const src = `${i}:v`
      const outL = `bg${i}p`
      chains.push({ filter: `[${src}]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#0b0b0f,fps=30,format=yuv420p[${outL}]`, outputs: [outL] })
      return outL
    })
    if (!totalSec){
      const durMs = await getAudioDurationMs(audio)
      totalSec = Math.max(1, Math.ceil(Math.max(durMs, 5000)/1000))
    }
    const N = processed.length
    const seg = Math.max(1.5, totalSec / Math.max(1, N))
    const trimmed = processed.map(lab => {
      const o = `${lab}t`
      chains.push({ filter: `[${lab}]trim=duration=${seg},setpts=PTS-STARTPTS[${o}]`, outputs: [o] })
      return o
    })
    if (trimmed.length){
      const inputs = trimmed.map(l => `[${l}]`).join('')
      chains.push({ filter: `${inputs}concat=n=${trimmed.length}:v=1:a=0[vcat]`, outputs: ['vcat'] })
      lastLabel = 'vcat'
    }
  }

  const assEsc = assPath.replace(/:/g,'\\:').replace(/'/g,"\\'")
  const progress = `drawbox=x=0:y=24:w='(1080*t)/${totalSec || 1}':h=${preset==='tiktok_v1'?12:8}:color=white@0.9:t=fill`
  const baseLabel = lastLabel ? `[${lastLabel}]` : `${videoInput}`
  const finalLabel = 'v'
  const grade = preset==='tiktok_v1' ? `eq=contrast=1.06:brightness=0.02:saturation=1.15,vignette=PI/8:0.5` : `null`
  const titleDraw = (preset==='tiktok_v1' && title) ? `,drawbox=x=60:y=120:w=960:h=200:color=black@0.35:t=fill:enable='lt(t,1.5)',drawtext=text='${String(title).replace(/:/g,"\\:").replace(/'/g,"\\'")}':fontcolor=white:fontsize=72:line_spacing=10:x=(w-text_w)/2:y=150:enable='lt(t,1.5)'` : ''
  const logoFilter = haveLogo ? `;movie='${String(logo).replace(/:/g, "\\:").replace(/'/g, "\\'")}',scale=200:-1[wm];[${finalLabel}][wm]overlay=W-w-40:H-h-40:enable='gte(t,0)'[${finalLabel}]` : ''
  const subsPart = noSubs ? '' : `,ass='${assEsc}'`
  chains.push({ filter: `${baseLabel}pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#0b0b0f,${grade}${subsPart},${progress}${titleDraw}[${finalLabel}]${logoFilter}`, outputs: [finalLabel] })

  const audioIndex = bgCount ? bgCount : 1
  const musicIndex = music ? (audioIndex + 1) : null
  if (musicIndex != null){
    chains.push({ filter: `[${audioIndex}:a]volume=1.0[a1]` })
    chains.push({ filter: `[${musicIndex}:a]volume=0.18[a2]` })
    chains.push({ filter: `[a1][a2]amix=inputs=2:duration=shortest[aout]`, outputs: ['aout'] })
  }

  const filters = chains.map(c => c.filter)
  cmd.complexFilter(filters)

  cmd.outputOptions([
    '-map', '[v]',
    ...(music ? ['-map', '[aout]'] : ['-map', `${audioIndex}:a`]),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-threads', '1',
    '-shortest'
  ])

  await new Promise<void>((resolve, reject) => {
    cmd.on('start', (c: string) => console.log('ffmpeg:', c))
    cmd.on('stderr', (line: string) => console.error(line))
    cmd.on('end', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} ; resolve() })
    cmd.on('error', (err: any) => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}; reject(err) })
    cmd.save(out)
  })
}

