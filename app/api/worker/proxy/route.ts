import { NextRequest } from 'next/server'

export const runtime = 'edge'

export async function POST(req: NextRequest){
  try {
    const worker = process.env.RENDER_WORKER_URL
    if (!worker) return new Response(JSON.stringify({ error: 'RENDER_WORKER_URL not set' }), { status: 500 })
    const body = await req.text()
    const res = await fetch(worker.replace(/\/$/, '') + '/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const txt = await res.text()
    return new Response(txt, { status: res.status, headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' } })
  } catch (e: any){
    return new Response(JSON.stringify({ error: e?.message || 'proxy error' }), { status: 500 })
  }
}

