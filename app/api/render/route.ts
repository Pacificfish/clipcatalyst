import { NextRequest } from 'next/server'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const worker = process.env.RENDER_WORKER_URL
    if (!worker) return new Response(JSON.stringify({ error: 'RENDER_WORKER_URL not set' }), { status: 500 })
    const body = await req.text()
    const res = await fetch(worker.replace(/\/$/, '') + '/render', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shared-secret': process.env.RENDER_WORKER_SECRET || ''
      },
      body,
    })

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      const ct = res.headers.get('content-type') || ''
      return new Response(
        JSON.stringify({ error: 'worker error', status: res.status, contentType: ct, body: txt.slice(0, 2000) }),
        { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-proxy': 'render-proxy' } }
      )
    }

    const headers = new Headers()
    const ct = res.headers.get('content-type') || undefined
    const cd = res.headers.get('content-disposition') || undefined
    const cl = res.headers.get('content-length') || undefined
    if (ct) headers.set('Content-Type', ct)
    if (cd) headers.set('Content-Disposition', cd)
    if (cl) headers.set('Content-Length', cl)
    headers.set('Cache-Control', 'no-store')
    headers.set('x-proxy', 'render-proxy')
    return new Response(res.body, { status: res.status, headers })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Render proxy failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}
