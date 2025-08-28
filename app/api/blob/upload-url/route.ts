import { NextRequest } from 'next/server'

export async function POST(_req: NextRequest) {
  // Not used when client uploads via @vercel/blob/client.
  // Kept as a placeholder to avoid 404s if called.
  return new Response(JSON.stringify({ error: 'upload-url not configured; client should use @vercel/blob/client upload() directly' }), { status: 501 })
}

