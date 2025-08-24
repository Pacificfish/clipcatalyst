export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || 'unknown'
  const msg = process.env.VERCEL_GIT_COMMIT_MESSAGE || ''
  const branch = process.env.VERCEL_GIT_COMMIT_REF || ''
  const date = new Date().toISOString()
  return new Response(JSON.stringify({ sha, msg, branch, date }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  })
}
