export const runtime = 'edge'
export const dynamic = 'force-dynamic'

function redirectToProxy(req: Request){
  const u = new URL(req.url)
  u.pathname = '/api/worker/proxy'
  const res = Response.redirect(u.toString(), 307)
  res.headers.set('x-redirect', 'render->worker-proxy')
  return res
}

export async function POST(req: Request) {
  return redirectToProxy(req)
}

export async function GET(req: Request) {
  return redirectToProxy(req)
}
