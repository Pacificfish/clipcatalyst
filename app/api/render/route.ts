export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function POST() {
  return new Response(
    JSON.stringify({ error: 'This route has been removed. Use /api/worker/proxy instead.' }),
    { status: 410, headers: { 'Content-Type': 'application/json' } }
  )
}

export async function GET() {
  return new Response('This route has been removed. Use /api/worker/proxy instead.', { status: 410 })
}
