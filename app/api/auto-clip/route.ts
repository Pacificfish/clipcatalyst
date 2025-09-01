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
    const headers: Record<string, string> = {}
    if (BYPASS) headers['x-vercel-protection-bypass'] = BYPASS
    const SECRET = process.env.RENDER_WORKER_SECRET || ''
    if (SECRET) headers['x-shared-secret'] = SECRET

    // Try common worker paths in order:
    // 1) /api/auto_clip_public (Vercel serverless exported app)
    // 2) /auto_clip_public (plain Express on a VM)
    // 3) /auto_clip (older naming)
    const candidates = [
      `${WORKER_BASE_URL}/api/auto_clip_public`,
      `${WORKER_BASE_URL}/auto_clip_public`,
      `${WORKER_BASE_URL}/auto_clip`,
    ]

    let forward: Response | null = null
    let lastErrText = ''
    for (const u of candidates) {
      try {
        const r = await tryPost(u, payload, headers)
        if (r.status === 404 || r.status === 403) {
          lastErrText = await r.text().catch(() => '')
          // try next candidate on 404/403
          continue
        }
        forward = r; break
      } catch (e: any) {
        lastErrText = String(e?.message || e)
      }
    }

    if (!forward) {
      return NextResponse.json({ error: 'worker_unreachable', details: lastErrText || 'all candidates returned 404' }, { status: 502 })
    }

    const text = await forward.text().catch(() => '')
    const ct = forward.headers.get('content-type') || ''
    const init: ResponseInit = { status: forward.status, headers: {} }
    if (ct.includes('application/json')) {
      return new NextResponse(text, { ...init, headers: { 'Content-Type': 'application/json' } })
    }
    return new NextResponse(text, init)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'proxy failed' }, { status: 500 })
  }
}
