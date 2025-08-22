import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KEYS = [
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'PEXELS_API_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_DEV_SUB_EMAILS',
]

export async function GET() {
  const present = Object.fromEntries(
    KEYS.map((k) => [k, Boolean(process.env[k] && String(process.env[k]).length > 0)])
  ) as Record<string, boolean>

  return NextResponse.json({
    ok: true,
    node: process.version,
    region: process.env.VERCEL_REGION || process.env.FLY_REGION || process.env.AWS_REGION || 'unknown',
    present,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
