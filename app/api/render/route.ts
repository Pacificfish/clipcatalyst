export const runtime = 'edge'
export const dynamic = 'force-dynamic'

function redirectToProxy(req: Request){
  const u = new URL(req.url)
  u.pathname = '/api/worker/proxy'
  return new Response(null, { status: 307, headers: { Location: u.toString(), 'x-redirect': 'render->worker-proxy' } })
}

export async function POST(req: Request) {
  return redirectToProxy(req)
}

export async function GET(req: Request) {
  return redirectToProxy(req)
}
