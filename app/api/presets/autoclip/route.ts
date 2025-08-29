import { NextRequest } from 'next/server'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export async function POST(req: NextRequest) {
  try {
    const { source_type, source_url, language, auto_render = true, preset = 'tiktok_v1' } = await req.json()
    if (source_type !== 'upload' || !source_url) {
      return new Response(JSON.stringify({ error: 'Provide source_type="upload" and source_url' }), { status: 400 })
    }

    const WORKER = requiredEnv('RENDER_WORKER_URL')
    const SECRET = requiredEnv('RENDER_WORKER_SECRET')

    // Ask worker to suggest highlights and prepare captions/audio
    const r1 = await fetch(`${WORKER.replace(/\/$/, '')}/suggest_highlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shared-Secret': SECRET },
      body: JSON.stringify({ video_url: source_url, language, target_clip_count: 3 })
    })
    const j1 = await r1.json().catch(()=>null)
    if (!r1.ok) {
      return new Response(JSON.stringify({ error: j1?.error || 'worker suggest_highlights failed' }), { status: 502 })
    }

    const segments = Array.isArray(j1?.segments) ? j1.segments : []
    if (!segments.length) {
      return new Response(JSON.stringify({ error: 'no segments suggested' }), { status: 502 })
    }

    if (!auto_render) {
      return new Response(JSON.stringify({ segments, mp3_url: j1?.mp3_url || null, csv_text: j1?.csv_text || '', word_csv_text: j1?.word_csv_text || '' }), { status: 200 })
    }

    // Trigger batch render on worker
    const r2 = await fetch(`${WORKER.replace(/\/$/, '')}/render_batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shared-Secret': SECRET },
      body: JSON.stringify({
        // Prefer mp3_url if worker provided one; else let worker extract audio from video_url
        mp3_url: j1?.mp3_url || '',
        video_url: source_url,
        csv_text: j1?.csv_text || '',
        word_csv_text: j1?.word_csv_text || '',
        segments,
        preset
      })
    })
    const j2 = await r2.json().catch(()=>null)
    if (!r2.ok) {
      return new Response(JSON.stringify({ error: j2?.error || 'worker render_batch failed', segments }), { status: 502 })
    }

    return new Response(JSON.stringify({ segments, clips: Array.isArray(j2?.clips) ? j2.clips : [] }), { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'autoclip failed' }), { status: 500 })
  }
}

