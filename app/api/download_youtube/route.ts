import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { youtube_url } = await req.json()
    if (!youtube_url || typeof youtube_url !== 'string') {
      return NextResponse.json({ error: 'youtube_url is required' }, { status: 400 })
    }

    const WORKER_URL = process.env.RENDER_WORKER_URL || ''
    const WORKER_SECRET = process.env.RENDER_WORKER_SECRET || ''
    if (!WORKER_URL) {
      return NextResponse.json({ error: 'RENDER_WORKER_URL not set on website' }, { status: 500 })
    }

    const r = await fetch(`${WORKER_URL.replace(/\/$/, '')}/download_youtube`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WORKER_SECRET ? { 'x-shared-secret': WORKER_SECRET } : {}),
      },
      body: JSON.stringify({ youtube_url }),
    })

    const text = await r.text()
    let data: any = null
    try { data = JSON.parse(text) } catch { /* may be binary if streaming */ }

    if (!r.ok) {
      return NextResponse.json({ error: 'worker_error', details: data?.error || text || r.statusText }, { status: r.status })
    }

    // If worker streams MP4 (when no storage configured), proxying binary is more involved.
    // In our setup, Blob is configured, so worker returns JSON with { url, key }.
    if (data && typeof data === 'object' && data.url) {
      return NextResponse.json(data)
    }

    return NextResponse.json({ error: 'unexpected_response', details: data || text }, { status: 502 })
  } catch (e: any) {
    return NextResponse.json({ error: 'proxy_failed', details: String(e?.message || e) }, { status: 500 })
  }
}

