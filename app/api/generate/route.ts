import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { htmlToText } from '@/lib/htmlToText'
import crypto from 'crypto'

export const runtime = 'nodejs' // ensure Node runtime
export const dynamic = 'force-dynamic'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'

type Payload = {
  mode: 'Paste' | 'URL'
  source_text?: string
  source_url?: string
  language?: string
  tone?: string
  topic?: string
  email?: string
  project_id?: string
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
    // CORS
    const headers = { 'Access-Control-Allow-Origin': '*' }

    // Validate env
    for (const [k, v] of Object.entries({
      OPENAI_API_KEY,
      ELEVENLABS_API_KEY,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    })) {
      if (!v) return NextResponse.json({ error: `Missing ${k}` }, { status: 500, headers })
    }

    const body = (await req.json()) as Payload
    const { mode, source_text, source_url } = body
    const language = body.language ?? 'English'
    const tone = body.tone ?? 'Informative'
    const topic = body.topic ?? ''
    const email = (body.email ?? 'anon').toLowerCase()
    const projectId = body.project_id || Math.random().toString(36).slice(2, 10)

    if (!mode || (mode === 'Paste' && !source_text) || (mode === 'URL' && !source_url)) {
      return NextResponse.json(
        { error: 'Provide mode=Paste with source_text OR mode=URL with source_url.' },
        { status: 400, headers }
      )
    }

    // 1) Get plain text
    let plain = source_text || ''
    if (mode === 'URL') {
      const r = await fetch(source_url!, { redirect: 'follow' })
      if (!r.ok) return NextResponse.json({ error: `Fetch URL failed: ${r.status}` }, { status: 400, headers })
      plain = htmlToText(await r.text())
    }

    // 2) OpenAI → script & captions (JSON-only)
    const systemPrompt = `
You are a short-form video writer.
Return ONLY valid JSON exactly in this schema:
{
  "script": "string (<= 900 chars)",
  "captions": [{"time":"00:00","text":"string"}],
  "language": "string"
}
Constraints:
- Use the requested language and tone.
- Script 30–60s, high retention.
- Captions 1–3s each, covering the full script.
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

    const oaRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })

    if (!oaRes.ok) {
      const err = await oaRes.text().catch(() => '')
      return NextResponse.json({ error: 'OpenAI error', details: err }, { status: 502, headers })
    }

    const oa = await oaRes.json()
    const content: string = oa?.choices?.[0]?.message?.content || ''
    const jsonText = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)
    let parsed: { script: string; captions: { time: string; text: string }[] }
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      return NextResponse.json({ error: 'Model did not return valid JSON', content }, { status: 502, headers })
    }

    const script = String(parsed.script || '').slice(0, 2000)
    const captions = Array.isArray(parsed.captions) ? parsed.captions : []
    if (!script || captions.length === 0) {
      return NextResponse.json({ error: 'Missing script or captions' }, { status: 422, headers })
    }

    // 3) ElevenLabs → MP3
    const elBody = {
      text: script,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }
    const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(elBody),
    })
    if (!elRes.ok) {
      const err = await elRes.text().catch(() => '')
      return NextResponse.json({ error: 'ElevenLabs error', details: err }, { status: 502, headers })
    }
    const audioBuf = Buffer.from(await elRes.arrayBuffer())

    // 4) Build CSV
    const lines = ['time,text']
    for (const row of captions) {
      const t = String(row.time || '').replace(/\r?\n/g, ' ').trim()
      const txt = String(row.text || '').replace(/"/g, '""').replace(/\r?\n/g, ' ').trim()
      lines.push(`${t},"${txt}"`)
    }
    const csv = lines.join('\n')

    // 5) Upload to Supabase (public bucket: clips)
    const safeId = crypto.createHash('sha256').update(email).digest('hex').slice(0, 12)
    const base = `${safeId}/${projectId}`
    const mp3Path = `${base}/voiceover.mp3`
    const csvPath = `${base}/captions.csv`

    const up1 = await supabaseAdmin.storage.from('clips').upload(mp3Path, audioBuf, {
      contentType: 'audio/mpeg',
      upsert: true,
    })
    if (up1.error) return NextResponse.json({ error: 'Store MP3 failed', details: up1.error.message }, { status: 502, headers })

    const up2 = await supabaseAdmin.storage.from('clips').upload(csvPath, new Blob([csv], { type: 'text/csv' }), {
      upsert: true,
      contentType: 'text/csv',
    })
    if (up2.error) return NextResponse.json({ error: 'Store CSV failed', details: up2.error.message }, { status: 502, headers })

    const mp3Pub = supabaseAdmin.storage.from('clips').getPublicUrl(mp3Path).data.publicUrl
    const csvPub = supabaseAdmin.storage.from('clips').getPublicUrl(csvPath).data.publicUrl

    // Optional: insert project row (if you already created the table & RLS policies)
    // await supabaseAdmin.from('projects').insert({
    //   user_id: null, // if you pass a user, set it
    //   title: 'New Clip',
    //   mode,
    //   source_text: mode === 'Paste' ? plain : null,
    //   source_url: mode === 'URL' ? source_url : null,
    //   mp3_url: mp3Pub,
    //   csv_url: csvPub,
    //   status: 'ready'
    // })

    return NextResponse.json({ mp3_url: mp3Pub, csv_url: csvPub, project_id: projectId }, { headers })
  } catch (e: any) {
    return NextResponse.json({ error: 'Server error', details: String(e?.message || e) }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
}