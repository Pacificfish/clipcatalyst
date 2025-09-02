import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

async function tryPost(url: string, body: any, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  return res
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const {
      video_url,
      target_clip_count,
      min_ms,
      max_ms,
      language,
      bg_url,
      bg_urls,
      bypass: bypassFromClient,
    } = body || {}

    if ((!video_url || typeof video_url !== 'string') && !(typeof body.youtube_url === 'string' && body.youtube_url.trim())) {
      return NextResponse.json({ error: 'video_url or youtube_url is required' }, { status: 400 })
    }

    // Prefer explicit RENDER_WORKER_URL to avoid drift with other envs
    const WORKER_BASE_URL = (
      process.env.RENDER_WORKER_URL ||
      process.env.WORKER_BASE_URL ||
      process.env.NEXT_PUBLIC_WORKER_BASE_URL ||
      'https://clipcatalyst-worker.fly.dev'
    ).replace(/\/$/, '')

    // Optional Vercel Deployment Protection bypass (harmless on non-Vercel hosts)
    const BYPASS = process.env.VERCEL_PROTECTION_BYPASS || process.env.VERCEL_BYPASS_TOKEN || bypassFromClient || ''

    const payload = { video_url, youtube_url: (body.youtube_url || undefined), target_clip_count, min_ms, max_ms, language, bg_url, bg_urls }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (BYPASS) headers['x-vercel-protection-bypass'] = BYPASS
    const SECRET = process.env.RENDER_WORKER_SECRET || ''
    if (SECRET) headers['x-shared-secret'] = SECRET

    // Use async start endpoints so we don't block and hit timeouts.
    const startCandidates = [
      `${WORKER_BASE_URL}/auto_clip_start`,
      `${WORKER_BASE_URL}/auto_clip_start_public`,
      `${WORKER_BASE_URL}/api/auto_clip_start_public`,
    ]

    let resp: Response | null = null
    let lastErrText = ''
    for (const u of startCandidates) {
      try {
        const r = await fetch(u, { method: 'POST', headers, body: JSON.stringify(payload), cache: 'no-store' })
        if (r.status === 404 || r.status === 403) {
          lastErrText = await r.text().catch(() => '')
          continue
        }
        resp = r; break
      } catch (e: any) {
        lastErrText = String(e?.message || e)
      }
    }

    if (!resp) {
      return NextResponse.json({ error: 'worker_unreachable', details: lastErrText || 'all candidates returned 404/403' }, { status: 502 })
    }

    const text = await resp.text().catch(() => '')
    return new NextResponse(text, { status: resp.status, headers: { 'Content-Type': 'application/json' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'proxy failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  try {
    const jobId = req.nextUrl.searchParams.get('job_id') || ''
    if (!jobId) return NextResponse.json({ error: 'job_id required' }, { status: 400 })

    const WORKER_BASE_URL = (
      process.env.RENDER_WORKER_URL ||
      process.env.WORKER_BASE_URL ||
      process.env.NEXT_PUBLIC_WORKER_BASE_URL ||
      'https://clipcatalyst-worker.fly.dev'
    ).replace(/\/$/, '')

    const r = await fetch(`${WORKER_BASE_URL}/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' })
    const txt = await r.text().catch(() => '')
    return new NextResponse(txt, { status: r.status, headers: { 'Content-Type': 'application/json' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'status failed' }, { status: 500 })
  }
}
