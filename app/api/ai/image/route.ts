import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  } })
}

export async function POST(req: Request) {
  const headers = { 'Access-Control-Allow-Origin': '*' }
  try {
    const { prompt, aspect_ratio = '9:16', project_id } = await req.json().catch(() => ({ })) as { prompt?: string, aspect_ratio?: '9:16'|'1:1'|'16:9', project_id?: string }
    if (!prompt || !prompt.trim()) return NextResponse.json({ error: 'prompt is required' }, { status: 400, headers })

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
    if (!OPENAI_API_KEY) return NextResponse.json({ error: 'Missing OPENAI_API_KEY' }, { status: 500, headers })

    const supabase = getSupabaseAdmin()

    // Auth (Bearer JWT from Supabase)
    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
    const { data: userData, error: userErr } = await supabase.auth.getUser(token)
    if (userErr || !userData?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
    const user = userData.user

    // Map aspect ratio to supported image size
    const size = aspect_ratio === '9:16' ? '1024x1792' : aspect_ratio === '16:9' ? '1792x1024' : '1024x1024'

    // Call OpenAI Images (gpt-image-1) requesting base64 payload to avoid expiring CDN URLs
    const resp = await fetch('https://api.openai.com/v1/images', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: prompt.trim(),
        size,
        response_format: 'b64_json'
      })
    })
    if (!resp.ok){
      const txt = await resp.text().catch(() => '')
      return NextResponse.json({ error: 'OpenAI image error', details: txt }, { status: 502, headers })
    }
    const json = await resp.json().catch(() => null) as any
    const b64 = json?.data?.[0]?.b64_json || ''
    if (!b64) return NextResponse.json({ error: 'No image returned' }, { status: 502, headers })

    const bytes = Buffer.from(b64, 'base64')

    // Store in Supabase Storage for stable hosting
    const email = (user.email || '').toLowerCase()
    const safeId = require('crypto').createHash('sha256').update(email).digest('hex').slice(0, 12)
    const base = `${safeId}/${project_id || `ai-${Date.now()}`}`
    const name = `bg-${Date.now()}.png`
    const objPath = `${base}/${name}`

    const up = await supabase.storage.from('clips').upload(objPath, new Blob([bytes], { type: 'image/png' }), { upsert: true, contentType: 'image/png' })
    if (up.error) return NextResponse.json({ error: 'Upload failed', details: up.error.message }, { status: 502, headers })

    const publicUrl = supabase.storage.from('clips').getPublicUrl(objPath).data.publicUrl

    return NextResponse.json({ image_url: publicUrl, path: objPath, size }, { status: 200, headers })
  } catch (e: any) {
    return NextResponse.json({ error: 'Server error', details: String(e?.message || e) }, { status: 500, headers })
  }
}
