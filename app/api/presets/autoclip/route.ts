import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Very simple YouTube transcript fetcher via alternate endpoints or youtubetranscript API
// For production, consider using official Data API or a hosted transcript service.

type Payload = {
  youtube_url: string
  max_clips?: number
  target_seconds?: number
}

function parseYouTubeId(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v')
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null
  } catch {}
  return null
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10)
      return Number.isFinite(code) ? String.fromCharCode(code) : _
    })
}

async function fetchTranscript(videoId: string): Promise<Array<{ start: number; dur: number; text: string }>> {
  // 1) Try the unofficial transcript endpoint first (JSON)
  try {
    const r = await fetch(`https://youtubetranscript.com/?server_vid2=${encodeURIComponent(videoId)}`)
    if (r.ok) {
      const json: any = await r.json().catch(() => null)
      if (Array.isArray(json?.transcript)) {
        return json.transcript.map((row: any) => ({ start: Math.floor(Number(row.start) * 1000), dur: Math.floor(Number(row.dur) * 1000), text: String(row.text || '') }))
      }
    }
  } catch {}

  // 2) Fallback to YouTube timedtext (try JSON3, VTT, then XML) for a broader set of English locales
  const langCodes = ['en', 'en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN']

  // Helpers to parse JSON3 and VTT
  const parseJson3 = (j: any) => {
    const out: Array<{ start: number; dur: number; text: string }> = []
    if (!j || !Array.isArray(j.events)) return out
    for (const ev of j.events){
      const s = Math.max(0, Math.floor(Number(ev.tStartMs || ev.tstartms || 0)))
      const d = Math.max(0, Math.floor(Number(ev.dDurationMs || ev.dDurationms || ev.d || 0)))
      let txt = ''
      if (Array.isArray(ev.segs)){
        for (const seg of ev.segs){
          const t = (seg && typeof seg.utf8 === 'string') ? seg.utf8 : ''
          txt += t
        }
      }
      txt = (txt || '').replace(/\s+/g, ' ').trim()
      if (d > 0 && txt){ out.push({ start: s, dur: d, text: txt }) }
    }
    return out
  }
  const timeToMs = (h: number, m: number, s: number, ms: number) => (((h*60 + m)*60) + s) * 1000 + ms
  const parseVtt = (vtt: string) => {
    const out: Array<{ start: number; dur: number; text: string }> = []
    // Split by cues; basic parser
    const lines = String(vtt || '').replace(/\r/g,'').split('\n')
    let i=0
    while (i < lines.length){
      const l = lines[i].trim()
      if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(l)){
        const m = l.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/)
        if (m){
          const sMs = timeToMs(Number(m[1]),Number(m[2]),Number(m[3]),Number(m[4]))
          const eMs = timeToMs(Number(m[5]),Number(m[6]),Number(m[7]),Number(m[8]))
          let text = ''
          i++
          while (i < lines.length && lines[i].trim() && !/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(lines[i])){
            text += (text ? ' ' : '') + lines[i].trim()
            i++
          }
          text = text.replace(/<[^>]+>/g,'').trim()
          const dur = Math.max(0, eMs - sMs)
          if (dur > 0 && text) out.push({ start: sMs, dur: dur, text })
          continue
        }
      }
      i++
    }
    return out
  }

  // Try JSON3, VTT, then XML; manual first then ASR
  for (const lang of langCodes){
    for (const base of [
      (fmt: string, kind: string) => `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(videoId)}${kind}${fmt}`,
      (fmt: string, kind: string) => `https://video.google.com/timedtext?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(videoId)}${kind}${fmt}`,
    ]){
      for (const kind of ['', '&kind=asr']){
        // JSON3
        try {
          const url = base('&fmt=json3', kind)
          const rj = await fetch(url)
          if (rj.ok){
            const jj: any = await rj.json().catch(()=>null)
            const parsed = parseJson3(jj)
            if (parsed.length) return parsed
          }
        } catch {}
        // VTT
        try {
          const url = base('&fmt=vtt', kind)
          const rv = await fetch(url)
          if (rv.ok){
            const vtt = await rv.text()
            const parsed = parseVtt(vtt)
            if (parsed.length) return parsed
          }
        } catch {}
        // XML
        try {
          const url = base('', kind)
          const rr = await fetch(url)
          if (rr.ok){
            const xml = await rr.text()
            if (xml && xml.includes('<transcript')){
              const out: Array<{ start: number; dur: number; text: string }> = []
              const re = /<text[^>]*start=\"([^\"]+)\"[^>]*dur=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/text>/g
              let m: RegExpExecArray | null
              while ((m = re.exec(xml))){
                const start = Math.floor(Number(m[1]) * 1000)
                const dur = Math.floor(Number(m[2]) * 1000)
                const raw = m[3].replace(/\n/g, ' ').replace(/\r/g, ' ')
                const text = decodeHtmlEntities(raw)
                if (Number.isFinite(start) && Number.isFinite(dur) && text.trim()){
                  out.push({ start, dur, text: text.trim() })
                }
              }
              if (out.length) return out
            }
          }
        } catch {}
      }
    }
  }

  return []
}

function scoreSegments(lines: Array<{ start: number; dur: number; text: string }>, windowMs: number): Array<{ start: number; end: number; text: string; score: number }>{
  const out: Array<{ start: number; end: number; text: string; score: number }> = []
  if (!lines.length) return out
  // Sliding window by sentence chunks, naive scoring by length and punctuation
  let i = 0
  while (i < lines.length){
    const s0 = lines[i].start
    const limit = s0 + windowMs
    let text = ''
    let end = s0
    let score = 0
    let j = i
    for (; j < lines.length; j++){
      const l = lines[j]
      if (l.start > limit) break
      text += (text ? ' ' : '') + l.text
      end = Math.max(end, l.start + l.dur)
      // Simple heuristics: more characters and punctuation => higher score
      score += l.text.length
      if (/[.!?]/.test(l.text)) score += 20
      if (/\b(you|we|this|that|because|so|but)\b/i.test(l.text)) score += 5
    }
    out.push({ start: s0, end, text: text.trim(), score })
    // Advance roughly half-window to allow overlap search
    const nextStart = s0 + Math.floor(windowMs/2)
    while (i < lines.length && lines[i].start < nextStart) i++
  }
  return out
}

export async function POST(req: Request){
  try {
    const headers = { 'Access-Control-Allow-Origin': '*' }

    const authHeader = req.headers.get('authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })

    const body = (await req.json()) as Payload
    const videoId = parseYouTubeId(String(body.youtube_url || ''))
    if (!videoId) return NextResponse.json({ error: 'Invalid YouTube URL' }, { status: 400, headers })

    const maxClips = Math.min(10, Math.max(1, Number(body.max_clips || 3)))
    const targetSec = Math.min(120, Math.max(8, Number(body.target_seconds || 30)))
    const windowMs = targetSec * 1000

    const lines = await fetchTranscript(videoId)
    if (!lines.length) return NextResponse.json({ error: 'Transcript not available for this video' }, { status: 404, headers })

    const scored = scoreSegments(lines, windowMs)
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, maxClips).map(s => ({ start: s.start, end: s.end, text: s.text }))

    return NextResponse.json({ segments: top }, { headers })
  } catch (e: any) {
    return NextResponse.json({ error: 'Server error', details: String(e?.message || e) }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
}

