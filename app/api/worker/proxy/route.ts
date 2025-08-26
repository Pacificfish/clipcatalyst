import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest){
  try {
    const worker = process.env.RENDER_WORKER_URL
    if (!worker) return new Response(JSON.stringify({ error: 'RENDER_WORKER_URL not set' }), { status: 500 })

    // Choose path: default /render, allow override via ?path=
    const inUrl = new URL(req.url)
    const pathOverride = (inUrl.searchParams.get('path') || '').replace(/^\/+/, '')
    const workerPath = pathOverride ? `/${pathOverride}` : '/render'

    // Redirect the client directly to the worker with a short-lived signed token to avoid proxy timeouts
    const ts = Math.floor(Date.now()/1000)
    const secret = process.env.RENDER_WORKER_SECRET || ''
    let token = ''
    try {
      const crypto = await import('crypto')
      token = crypto.createHmac('sha256', secret).update(String(ts)).digest('hex')
    } catch {}
    const u = new URL(worker.replace(/\/$/, '') + workerPath)
    u.searchParams.set('t', token)
    u.searchParams.set('ts', String(ts))

    // 307 preserves method and body; browser will POST body directly to worker
    return new Response(null, {
      status: 307,
      headers: { Location: u.toString(), 'x-redirect': `proxy->worker${workerPath}` }
    })

    // Unreachable after redirect
    // eslint-disable-next-line no-unreachable
    return new Response(JSON.stringify({ error: 'unreachable' }), { status: 500 })
  } catch (e: any){
    return new Response(JSON.stringify({ error: e?.message || 'proxy error' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

