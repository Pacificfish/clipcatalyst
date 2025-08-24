import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest){
  try {
    const worker = process.env.RENDER_WORKER_URL
    if (!worker) return new Response(JSON.stringify({ error: 'RENDER_WORKER_URL not set' }), { status: 500 })

    // Redirect the client directly to the worker with a short-lived signed token to avoid proxy timeouts
    const ts = Math.floor(Date.now()/1000)
    const secret = process.env.RENDER_WORKER_SECRET || ''
    let token = ''
    try {
      const crypto = await import('crypto')
      token = crypto.createHmac('sha256', secret).update(String(ts)).digest('hex')
    } catch {}
    const u = new URL(worker.replace(/\/$/, '') + '/render')
    u.searchParams.set('t', token)
    u.searchParams.set('ts', String(ts))

    // 307 preserves method and body; browser will POST body directly to worker
    return new Response(null, {
      status: 307,
      headers: { Location: u.toString(), 'x-redirect': 'proxy->worker' }
    })

    // If worker returned an error, unwrap the body for easier debugging
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      const ct = res.headers.get('content-type') || ''
      return new Response(
        JSON.stringify({ error: 'worker error', status: res.status, contentType: ct, body: txt.slice(0, 2000) }),
        { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-proxy': 'worker-proxy' } }
      )
    }

    const headers = new Headers()
    const ct = res.headers.get('content-type') || ''
    const cd = res.headers.get('content-disposition') || ''
    const cl = res.headers.get('content-length') || ''
    if (ct) headers.set('Content-Type', ct as string)
    if (cd) headers.set('Content-Disposition', cd as string)
    if (cl) headers.set('Content-Length', cl as string)
    headers.set('Cache-Control', 'no-store')
    headers.set('x-proxy', 'worker-proxy')
    return new Response(res.body, { status: res.status, headers })
  } catch (e: any){
    return new Response(JSON.stringify({ error: e?.message || 'proxy error' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

