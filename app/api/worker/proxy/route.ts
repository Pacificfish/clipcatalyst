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

    // (Note: following code path was used before streaming proxy; left for reference)
    // If you ever switch back from redirect to fetch, restore this section accordingly.
    // const workerRes = await fetch(workerUrl, { method: 'POST', headers, body })
    // if (!workerRes.ok) { ... }

    // Unreachable after redirect
    return new Response(JSON.stringify({ error: 'unreachable' }), { status: 500 })
  } catch (e: any){
    return new Response(JSON.stringify({ error: e?.message || 'proxy error' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

