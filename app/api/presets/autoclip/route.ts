import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Very simple YouTube transcript fetcher via alternate endpoints or youtubetranscript API
// For production, consider using official Data API or a hosted transcript service.

type Payload = {
  youtube_url: string
  max_clips?: number
  target_seconds?: number
  language?: string // BCP-47, e.g., 'en', 'es', 'fr'
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

// Helper parsers used throughout
function parseJson3(j: any){
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
function timeToMs(h: number, m: number, s: number, ms: number){ return (((h*60 + m)*60) + s) * 1000 + ms }
function parseVtt(vtt: string){
  const out: Array<{ start: number; dur: number; text: string }> = []
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

type Attempt = { url: string; ok: boolean; status?: number; bytes?: number; error?: string }

async function fetchTranscript(videoId: string, preferredLang: string | undefined, attempts: Attempt[]): Promise<Array<{ start: number; dur: number; text: string }>> {
  // Helper: fetch with UA and timeout
  const safeGet = async (url: string) => {
    const controller = new AbortController()
    const to = setTimeout(()=>controller.abort(), 8000)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClipCatalyst/1.0; +https://example.com)' },
        signal: controller.signal,
      })
      try {
        const text = await res.clone().text()
        attempts.push({ url, ok: res.ok, status: res.status, bytes: text.length })
      } catch {
        attempts.push({ url, ok: res.ok, status: res.status })
      }
      return res
    } finally {
      clearTimeout(to)
    }
  }

  // 0) Try listing available tracks and fetching directly from the listed entries
  try {
    const listUrls = [
      `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`,
      `https://video.google.com/timedtext?type=list&v=${encodeURIComponent(videoId)}`,
    ]
    const tracks: { lang_code: string, name?: string, kind?: string }[] = []
    for (const u of listUrls){
      try {
        const rs = await safeGet(u)
        if (rs.ok){
          const xml = await rs.text()
          // Extract <track .../> elements
          const re = /<track\b([^>]+?)\/>/g
          let m: RegExpExecArray | null
          while ((m = re.exec(xml))){
            const attrs = m[1]
            const get = (k: string) => {
              const mm = attrs.match(new RegExp(k+"=\"([^\"]*)\""))
              return mm ? mm[1] : ''
            }
            const lang_code = get('lang_code') || get('lang') || ''
            const name = get('name') || ''
            const kind = get('kind') || ''
            if (lang_code){ tracks.push({ lang_code, name: name || undefined, kind: kind || undefined }) }
          }
        }
      } catch (e: any) { attempts.push({ url: u, ok: false, error: String(e?.message || e) }) }
    }
    if (tracks.length){
      // Sort: preferredLang first, then English, then others; manual before asr
      const pref = (t: any) => (preferredLang && t.lang_code.toLowerCase().startsWith(preferredLang.toLowerCase())) ? 0 : (t.lang_code.toLowerCase().startsWith('en') ? 1 : 2)
      tracks.sort((a,b)=>{
        const pa = pref(a), pb = pref(b)
        if (pa!==pb) return pa-pb
        const ka = a.kind === 'asr' ? 1 : 0
        const kb = b.kind === 'asr' ? 1 : 0
        return ka - kb
      })
      for (const t of tracks){
        for (const base of [
          (fmt: string, kind: string) => `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(t.lang_code)}&v=${encodeURIComponent(videoId)}${kind}${fmt}${t.name?`&name=${encodeURIComponent(t.name)}`:''}`,
          (fmt: string, kind: string) => `https://video.google.com/timedtext?lang=${encodeURIComponent(t.lang_code)}&v=${encodeURIComponent(videoId)}${kind}${fmt}${t.name?`&name=${encodeURIComponent(t.name)}`:''}`,
        ]){
          for (const kind of [t.kind==='asr'?'&kind=asr':'', '&kind=asr', '']){
            // JSON3
            try {
              const rj = await safeGet(base('&fmt=json3', kind))
              if (rj.ok){
                const jj: any = await rj.json().catch(()=>null)
                const parsed = parseJson3(jj)
                if (parsed.length) return parsed
              }
            } catch (e: any) { attempts.push({ url: base('&fmt=json3', kind), ok: false, error: String(e?.message || e) }) }
            // VTT
            try {
              const rv = await safeGet(base('&fmt=vtt', kind))
              if (rv.ok){
                const vtt = await rv.text()
                const parsed = parseVtt(vtt)
                if (parsed.length) return parsed
              }
            } catch (e: any) { attempts.push({ url: base('&fmt=vtt', kind), ok: false, error: String(e?.message || e) }) }
            // XML
            try {
              const rr = await safeGet(base('', kind))
              if (rr.ok){
                const xml = await rr.text()
                if (xml && xml.includes('<transcript')){
                  const out: Array<{ start: number; dur: number; text: string }> = []
                  const reT = /<text[^>]*start=\"([^\"]+)\"[^>]*dur=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/text>/g
                  let mm: RegExpExecArray | null
                  while ((mm = reT.exec(xml))){
                    const start = Math.floor(Number(mm[1]) * 1000)
                    const dur = Math.floor(Number(mm[2]) * 1000)
                    const raw = mm[3].replace(/\n/g, ' ').replace(/\r/g, ' ')
                    const text = decodeHtmlEntities(raw)
                    if (Number.isFinite(start) && Number.isFinite(dur) && text.trim()){
                      out.push({ start, dur, text: text.trim() })
                    }
                  }
                  if (out.length) return out
                }
              }
            } catch (e: any) { attempts.push({ url: base('', kind), ok: false, error: String(e?.message || e) }) }
          }
        }
      }
    }
  } catch (e: any) { attempts.push({ url: 'list-tracks', ok: false, error: String(e?.message || e) }) }

  // 1) Try the unofficial transcript endpoint first (JSON)
  try {
    for (const url of [
      `https://youtubetranscript.com/?server_vid2=${encodeURIComponent(videoId)}`,
      `https://youtubetranscript.com/?server_vid=${encodeURIComponent(videoId)}`,
      `https://youtubetranscript.com/?video_id=${encodeURIComponent(videoId)}`,
    ]){
      try {
        const r = await safeGet(url)
        if (r.ok){
          const json: any = await r.json().catch(()=>null)
          if (Array.isArray(json?.transcript)){
            return json.transcript.map((row: any) => ({ start: Math.floor(Number(row.start) * 1000), dur: Math.floor(Number(row.dur) * 1000), text: String(row.text || '') }))
          }
        }
      } catch (e: any) { attempts.push({ url, ok: false, error: String(e?.message || e) }) }
    }
  } catch (e: any) { attempts.push({ url: 'youtubetranscript.com', ok: false, error: String(e?.message || e) }) }

  // 2) Fallback to YouTube timedtext (try JSON3, VTT, then XML) for a broader set of English locales
  const baseLangs = ['en', 'en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN', 'es', 'es-419', 'fr', 'de', 'pt', 'pt-BR', 'ru', 'hi', 'ja', 'ko', 'zh-Hans', 'zh-Hant']
  const langCodes = preferredLang && !baseLangs.includes(preferredLang) ? [preferredLang, ...baseLangs] : (preferredLang ? [preferredLang, ...baseLangs] : baseLangs)

  // Helpers defined above: parseJson3, parseVtt, timeToMs

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
          const rj = await safeGet(url)
          if (rj.ok){
            const jj: any = await rj.json().catch(()=>null)
            const parsed = parseJson3(jj)
            if (parsed.length) return parsed
          }
        } catch {}
        // VTT
        try {
          const url = base('&fmt=vtt', kind)
          const rv = await safeGet(url)
          if (rv.ok){
            const vtt = await rv.text()
            const parsed = parseVtt(vtt)
            if (parsed.length) return parsed
          }
        } catch {}
        // XML
        try {
          const url = base('', kind)
          const rr = await safeGet(url)
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

async function transcribeWithAssemblyAI(youtubeUrl: string, preferredLang: string | undefined, attempts: Attempt[]): Promise<Array<{ start: number; dur: number; text: string }>> {
  const API = process.env.ASSEMBLYAI_API_KEY || ''
  if (!API) return []
  try {
    const createRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'Authorization': API, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_url: youtubeUrl,
        language_code: preferredLang && preferredLang.length >= 2 ? preferredLang : undefined,
        punctuate: true,
        auto_highlights: false,
        speaker_labels: false,
        filter_profanity: false,
      })
    })
    const created: any = await createRes.json().catch(()=>null)
    attempts.push({ url: 'assemblyai:create', ok: createRes.ok, status: createRes.status })
    if (!createRes.ok || !created?.id) return []
    const id = created.id
    const started = Date.now()
    while (Date.now() - started < 120000) { // up to 2 minutes
      await new Promise(r=>setTimeout(r, 3000))
      const st = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: { 'Authorization': API } })
      attempts.push({ url: `assemblyai:status:${id}`, ok: st.ok, status: st.status })
      if (!st.ok) continue
      const js: any = await st.json().catch(()=>null)
      if (js?.status === 'completed'){
        const words: any[] = Array.isArray(js.words) ? js.words : []
        if (words.length){
          // Group words into ~3s lines or until punctuation
          const out: Array<{ start: number; dur: number; text: string }> = []
          let curStart = Math.max(0, Math.floor(Number(words[0].start||0)))
          let curEnd = curStart
          let buf = ''
          for (const w of words){
            const ws = Math.max(0, Math.floor(Number(w.start||0)))
            const we = Math.max(ws+1, Math.floor(Number(w.end||ws+1)))
            const t = String(w.text||w.word||'').trim()
            if (!t) continue
            // Flush if line gets too long in time or punctuation triggers a boundary
            const tooLong = (we - curStart) > 3500
            const punct = /[.!?]$/.test(t)
            if (tooLong || punct){
              const lineText = (buf ? buf + ' ' : '') + t
              curEnd = we
              out.push({ start: curStart, dur: Math.max(1, curEnd - curStart), text: lineText.trim() })
              // reset
              curStart = we
              curEnd = we
              buf = ''
            } else {
              buf = buf ? (buf + ' ' + t) : t
              curEnd = we
            }
          }
          if (buf){
            out.push({ start: curStart, dur: Math.max(1, curEnd - curStart), text: buf.trim() })
          }
          return out
        }
        // No words array; fallback to text with utterances
        const text = String(js.text||'').trim()
        if (text){
          const chunks = text.split(/(?<=[.!?])\s+/)
          const approxDur = 1500
          let t0 = 0
          return chunks.filter(Boolean).map((s: string)=>{ const st = t0; t0 += approxDur; return { start: st, dur: approxDur, text: s } })
        }
        return []
      }
      if (js?.status === 'error'){
        attempts.push({ url: `assemblyai:error:${id}`, ok: false, error: String(js?.error || 'transcription failed') })
        return []
      }
    }
    attempts.push({ url: `assemblyai:timeout:${id}`, ok: false, error: 'timeout' })
  } catch (e: any) {
    attempts.push({ url: 'assemblyai', ok: false, error: String(e?.message || e) })
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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
}

export async function OPTIONS() {
  // Handle CORS preflight gracefully in all environments (no body for 204)
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function HEAD() {
  // Health/HEAD check without noise
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function GET() {
  // Return a friendly message instead of 405 to avoid console noise from bots/prefetchers
  return NextResponse.json({ ok: true, message: 'Use POST to suggest highlights. This endpoint is healthy.' }, { status: 200, headers: corsHeaders })
}

export async function POST(req: Request){
  try {
    const headers = corsHeaders

    // Gracefully no-op if body is missing (e.g., speculative prefetch)
    const ctype = String(req.headers.get('content-type') || '').toLowerCase()
    let body: Payload | null = null
    if (ctype.includes('application/json')){
      try { body = await req.json() } catch { body = null }
    }
    if (!body || !body.youtube_url){
      return new Response(null, { status: 204, headers })
    }

    const authHeader = req.headers.get('authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })

    const videoId = parseYouTubeId(String(body.youtube_url || ''))
    if (!videoId) return NextResponse.json({ error: 'Invalid YouTube URL' }, { status: 400, headers })

    const maxClips = Math.min(10, Math.max(1, Number(body.max_clips || 3)))
    const targetSec = Math.min(120, Math.max(8, Number(body.target_seconds || 30)))
    const windowMs = targetSec * 1000

    const preferredLang = (String(body.language || '').trim()) || undefined
    const attempts: Attempt[] = []
    let lines = await fetchTranscript(videoId, preferredLang, attempts)
    if (!lines.length){
      // Fallback A: try AssemblyAI with page URL
      const fullUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
      const fallbackA = await transcribeWithAssemblyAI(fullUrl, preferredLang, attempts)
      if (fallbackA.length) lines = fallbackA
    }
    if (!lines.length){
      // Fallback B: call worker to download audio and upload to AssemblyAI
      try {
        const WORKER = (process.env.RENDER_WORKER_URL || '').replace(/\/$/, '')
        const SECRET = process.env.RENDER_WORKER_SECRET || process.env.SHARED_SECRET || ''
        if (WORKER){
          const wr = await fetch(`${WORKER}/transcribe_assembly`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(SECRET ? { 'x-shared-secret': SECRET } : {}) },
            body: JSON.stringify({ youtube_url: `https://www.youtube.com/watch?v=${videoId}`, language: preferredLang })
          })
          attempts.push({ url: `${WORKER}/transcribe_assembly`, ok: wr.ok, status: wr.status })
          if (wr.ok){
            const j: any = await wr.json().catch(()=>null)
            const arr: any[] = Array.isArray(j?.lines) ? j.lines : []
            if (arr.length){
              lines = arr.map(v => ({ start: Math.max(0, Math.floor(Number(v.start||0))), dur: Math.max(1, Math.floor(Number(v.dur||0))), text: String(v.text||'').trim() })).filter(x => x.text)
            }
          } else {
            try { attempts.push({ url: 'worker:transcribe_assembly:error', ok: false, status: wr.status, error: await wr.text() }) } catch {}
          }
        }
      } catch (e: any) {
        attempts.push({ url: 'worker:transcribe_assembly', ok: false, error: String(e?.message || e) })
      }
    }
    if (!lines.length) return NextResponse.json({ error: 'Transcript not available for this video', attempts }, { status: 404, headers })

    const scored = scoreSegments(lines, windowMs)
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, maxClips).map(s => ({ start: s.start, end: s.end, text: s.text }))

    return NextResponse.json({ segments: top }, { headers })
  } catch (e: any) {
    return NextResponse.json({ error: 'Server error', details: String(e?.message || e) }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
}

