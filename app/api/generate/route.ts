import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'
import { htmlToText } from '@/lib/htmlToText'
import crypto from 'crypto'
import { getAllowanceForPlan, currentPeriodStart } from '@/lib/credits'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'

type Payload = {
  mode: 'Paste' | 'URL'
  title: string
  source_text?: string
  source_url?: string
  language?: string
  tone?: string
  topic?: string
  email?: string
  project_id?: string
  auto_ai_bg?: boolean
}

type GenJSON = {
  script: string
  captions: { time: string; text: string }[]
  language?: string
  keywords?: string[]
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}

export async function POST(req: Request) {
  try {
    const headers = { 'Access-Control-Allow-Origin': '*' }

    for (const [k, v] of Object.entries({
      OPENAI_API_KEY,
      ELEVENLABS_API_KEY,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    })) {
      if (!v) return NextResponse.json({ error: `Missing ${k}` }, { status: 500, headers })
    }

    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
const supabaseAdmin = getSupabaseAdmin()
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
    if (userErr || !userData?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
    const user = userData.user
    const plan = String((user.user_metadata as any)?.plan || '').toLowerCase()
    const email = (user.email || '').toLowerCase()
    const devOverride = (process.env.NEXT_PUBLIC_DEV_SUB_EMAILS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      .includes(email)
    const hasSubscription = devOverride || ['beginner', 'pro', 'agency'].includes(plan)
    if (!hasSubscription) return NextResponse.json({ error: 'Subscription required' }, { status: 403, headers })

    const effectivePlan = (devOverride ? 'pro' : plan) as string
    const allowance = getAllowanceForPlan(effectivePlan)
    const period = currentPeriodStart()
    let used = 0
    if (allowance.monthly !== 'unlimited') {
      const { data: usageRow, error: usageErr } = await supabaseAdmin
        .from('usage_credits')
        .select('used_credits')
        .eq('user_id', user.id)
        .eq('period_start', period)
        .maybeSingle()
      if (usageErr && usageErr.code !== 'PGRST116') {
        return NextResponse.json({ error: 'Usage read failed', details: usageErr.message }, { status: 500, headers })
      }
      used = Number(usageRow?.used_credits || 0)
      if (used >= allowance.monthly) {
        return NextResponse.json({ error: 'Out of credits for this period' }, { status: 402, headers })
      }
    }

    const body = (await req.json()) as Payload
    const { mode, source_text, source_url } = body
    const title = String(body.title || '').trim()
    const language = body.language ?? 'English'
    const tone = body.tone ?? 'Informative'
    const topic = body.topic ?? ''
    const projectId = body.project_id || Math.random().toString(36).slice(2, 10)

    if (!title) return NextResponse.json({ error: 'Title is required' }, { status: 400, headers })

    if (!mode || (mode === 'Paste' && !source_text) || (mode === 'URL' && !source_url)) {
      return NextResponse.json({ error: 'Provide mode=Paste with source_text OR mode=URL with source_url.' }, { status: 400, headers })
    }

    let plain = source_text || ''
    if (mode === 'URL') {
      const r = await fetch(source_url!, { redirect: 'follow' })
      if (!r.ok) return NextResponse.json({ error: `Fetch URL failed: ${r.status}` }, { status: 400, headers })
      plain = htmlToText(await r.text())
    }

    const systemPrompt = `
You are a short-form video writer and editor.
Return ONLY valid JSON exactly in this schema:
{
  "script": "string (<= 900 chars)",
  "captions": [{"time":"00:00","text":"string"}],
  "language": "string",
  "keywords": ["short", "relevant", "nouns"]
}
Constraints:
- Use the requested language and tone.
- Script 30–60s, high retention.
- Captions 1–3s each, covering the full script.
- Keywords: 4–8 short search terms for b‑roll selection.
- Output must be valid JSON. No prose, no code fences, no extra keys.
`.trim()

    const userPrompt = `
SOURCE TEXT:
${plain}

LANGUAGE: ${language}
TONE: ${tone}
TOPIC (optional): ${topic}

Write a compelling 30–60s script and matching time-coded captions for vertical video.
Return ONLY JSON per the schema.
`.trim()

    // Call OpenAI with a reasonable timeout and bubble up real error details
    const controller = new AbortController()
    const to = setTimeout(() => controller.abort(), 40_000)
    const oaRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message || e) } as any))
    clearTimeout(to)
    if (!oaRes.ok) {
      const errText = await (oaRes as any).text().catch(() => '')
      const status = (oaRes as any).status || 500
      const hint = status === 401 ? 'Invalid OpenAI API key' : status === 429 ? 'Rate limited or quota exceeded' : undefined
      console.error('OpenAI error', { status, errText })
      return NextResponse.json({ error: 'OpenAI error', details: errText, status, hint }, { status: 502, headers })
    }
    const oa = await (oaRes as any).json()
    const content: string = oa?.choices?.[0]?.message?.content || ''
    const jsonText = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)
    let parsed: GenJSON
    try { parsed = JSON.parse(jsonText) } catch { return NextResponse.json({ error: 'Model did not return valid JSON', content }, { status: 502, headers }) }

    const script = String(parsed.script || '').slice(0, 2000)
    const captions = Array.isArray(parsed.captions) ? parsed.captions : []
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.filter(Boolean).slice(0, 10) : []
    if (!script || captions.length === 0) return NextResponse.json({ error: 'Missing script or captions' }, { status: 422, headers })

    const elBody = { text: script, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }
    const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`, { method: 'POST', headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(elBody) })
    if (!elRes.ok) { const err = await elRes.text().catch(() => ''); return NextResponse.json({ error: 'ElevenLabs error', details: err }, { status: 502, headers }) }
    const audioBuf = Buffer.from(await elRes.arrayBuffer())

    // Build a basic time,text CSV as fallback
    const lines = ['time,text']
    for (const row of captions) {
      const t = String(row.time || '').replace(/\r?\n/g, ' ').trim()
      const txt = String(row.text || '').replace(/\"/g, '""').replace(/\r?\n/g, ' ').trim()
      lines.push(`${t},\"${txt}\"`)
    }
    let csv = lines.join('\n')

    // Try word-accurate timings via Whisper (word granularity)
    try {
      const fd = new FormData()
      // Node runtime provides File, Blob via undici
      const file = new File([audioBuf], 'voiceover.mp3', { type: 'audio/mpeg' })
      fd.set('file', file)
      fd.set('model', 'whisper-1')
      fd.set('response_format', 'verbose_json')
      fd.append('timestamp_granularities[]', 'word')
      const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: fd,
      })
      if (tr.ok) {
        const tj: any = await tr.json().catch(() => null)
        type W = { s: number, e: number, t: string }
        const wordsOut: W[] = []
        const pushWord = (sSec: any, eSec: any, raw: any) => {
          const s = Math.max(0, Math.round(Number(sSec || 0) * 1000))
          let e = Math.round(Number(eSec || 0) * 1000)
          if (!Number.isFinite(e) || e <= s) e = s + 1
          const text = String(raw || '').trim()
          if (text) wordsOut.push({ s, e, t: text })
        }
        if (Array.isArray(tj?.words) && tj.words.length) {
          for (const w of tj.words) pushWord(w?.start, w?.end, w?.word ?? w?.text)
        } else if (Array.isArray(tj?.segments) && tj.segments.length) {
          // Prefer segment.words if present; else evenly split the segment by whitespace tokens
          for (const seg of tj.segments) {
            const segStart = Number(seg?.start || 0)
            const segEnd = Number(seg?.end || 0)
            if (Array.isArray(seg?.words) && tj.segments) {
              if (Array.isArray(seg?.words) && seg.words.length) {
                for (const w of seg.words) pushWord(w?.start ?? segStart, w?.end ?? segEnd, w?.word ?? w?.text)
              }
            } else {
              const t = String(seg?.text || '').trim()
              const toks = t.split(/\s+/).filter(Boolean)
              const dur = Math.max(0, segEnd - segStart)
              const per = toks.length ? dur / Math.max(1, toks.length) : 0
              for (let i=0;i<toks.length;i++) {
                const s = segStart + i*per
                const e = i === toks.length-1 ? segEnd : s + per
                pushWord(s, e, toks[i])
              }
            }
          }
        }
        // Remove any delays between words: snap each start to previous end (monotonic, no gaps)
        wordsOut.sort((a,b)=>a.s-b.s)
        for (let i=1;i<wordsOut.length;i++){
          if (wordsOut[i].s > wordsOut[i-1].e) wordsOut[i].s = wordsOut[i-1].e
          if (wordsOut[i].e <= wordsOut[i].s) wordsOut[i].e = wordsOut[i].s + 1
        }
        if (wordsOut.length){
          const wlines = ['start,end,text']
          for (const w of wordsOut){
            const safe = w.t.replace(/\\\"/g,'""')
            wlines.push(`${w.s},${w.e},\\"${safe}\\"`)
          }
          csv = wlines.join('\n')
        }
      }
    } catch {}

    const safeId = crypto.createHash('sha256').update(email).digest('hex').slice(0, 12)
    const base = `${safeId}/${projectId}`
    const mp3Path = `${base}/voiceover.mp3`
    const csvPath = `${base}/captions.csv`

    const up1 = await supabaseAdmin.storage.from('clips').upload(mp3Path, audioBuf, { contentType: 'audio/mpeg', upsert: true })
    if (up1.error) return NextResponse.json({ error: 'Store MP3 failed', details: up1.error.message }, { status: 502, headers })

    const up2 = await supabaseAdmin.storage.from('clips').upload(csvPath, new Blob([csv], { type: 'text/csv' }), { upsert: true, contentType: 'text/csv' })
    if (up2.error) return NextResponse.json({ error: 'Store CSV failed', details: up2.error.message }, { status: 502, headers })

    const mp3Pub = supabaseAdmin.storage.from('clips').getPublicUrl(mp3Path).data.publicUrl
    const csvPub = supabaseAdmin.storage.from('clips').getPublicUrl(csvPath).data.publicUrl

    // Optionally generate an AI background image relevant to the prompt/keywords
    let bgImagePub: string | null = null
    const wantAutoBg = body.auto_ai_bg !== false
    if (wantAutoBg && OPENAI_API_KEY) {
      try {
        const bgPrompt = [
          `Vertical cinematic background, 9:16, cohesive with: ${title}`,
          keywords.length ? `Themes: ${keywords.join(', ')}` : '',
          'High-contrast, soft gradients, abstract or subtle scene, no text, no watermark.'
        ].filter(Boolean).join('. ')
        const imgRes = await fetch('https://api.openai.com/v1/images', {
          method: 'POST',
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-image-1', prompt: bgPrompt, size: '1024x1792', response_format: 'b64_json' })
        })
        if (imgRes.ok){
          const j = await imgRes.json().catch(()=>null) as any
          const b64 = j?.data?.[0]?.b64_json
          if (b64){
            const bytes = Buffer.from(b64, 'base64')
            const bgPath = `${base}/bg-${Date.now()}.png`
            const upB = await supabaseAdmin.storage.from('clips').upload(bgPath, new Blob([bytes], { type: 'image/png' }), { upsert: true, contentType: 'image/png' })
            if (!upB.error){
              bgImagePub = supabaseAdmin.storage.from('clips').getPublicUrl(bgPath).data.publicUrl
            }
          }
        } else {
          try { console.warn('AI bg image gen failed:', await imgRes.text()) } catch {}
        }
      } catch {}
    }

    let thumbPub: string | null = null
    try {
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const wrapped = esc(title).slice(0, 140)
      const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">\n  <defs>\n    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">\n      <stop offset="0%" stop-color="#0ea5e9"/>\n      <stop offset="100%" stop-color="#7c3aed"/>\n    </linearGradient>\n  </defs>\n  <rect width="1280" height="720" fill="url(#g)"/>\n  <rect x="60" y="60" width="1160" height="600" rx="24" fill="rgba(0,0,0,0.35)"/>\n  <text x="100" y="200" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="56" font-weight="700" fill="#ffffff">${wrapped}</text>\n</svg>`
      const thumbPath = `${base}/thumb.svg`
      const upT = await supabaseAdmin.storage.from('clips').upload(thumbPath, new Blob([svg], { type: 'image/svg+xml' }), { upsert: true, contentType: 'image/svg+xml' })
      if (!upT.error) thumbPub = supabaseAdmin.storage.from('clips').getPublicUrl(thumbPath).data.publicUrl
    } catch {}

    if (allowance.monthly !== 'unlimited') {
      const { error: upErr } = await supabaseAdmin
        .from('usage_credits')
        .upsert({ user_id: user.id, period_start: period, used_credits: used + 1 }, { onConflict: 'user_id,period_start' })
      if (upErr) return NextResponse.json({ error: 'Usage update failed', details: upErr.message }, { status: 500, headers })
    }

    // Ensure the project is saved/updated so it appears in the grid immediately
    const nowIso = new Date().toISOString()
    const up = await supabaseAdmin
      .from('projects')
      .upsert({
        id: projectId,
        user_id: user.id,
        title,
        mode,
        source_text: mode === 'Paste' ? plain : null,
        source_url: mode === 'URL' ? source_url : null,
        mp3_url: mp3Pub,
        csv_url: csvPub,
        thumb_url: thumbPub,
        created_at: nowIso,
        updated_at: nowIso,
        keywords,
      }, { onConflict: 'id' })

    const project_saved = !up.error

    return NextResponse.json({ mp3_url: mp3Pub, csv_url: csvPub, project_id: projectId, keywords, bg_image_url: bgImagePub, project_saved, project_error: up.error?.message || null }, { headers })
  } catch (e: any) {
    return NextResponse.json({ error: 'Server error', details: String(e?.message || e) }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
}
