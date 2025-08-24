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
    const { url, kind = 'auto', project_id } = await req.json().catch(() => ({ })) as { url?: string, kind?: 'auto'|'image'|'video', project_id?: string }
    if (!url) return NextResponse.json({ error: 'url is required' }, { status: 400, headers })

    const supabase = getSupabaseAdmin()

    // Auth
    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
    const { data: userData, error: userErr } = await supabase.auth.getUser(token)
    if (userErr || !userData?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
    const user = userData.user

    // Fetch the external asset
    const r = await fetch(url, { redirect: 'follow' })
    if (!r.ok) { const txt = await r.text().catch(()=>''); return NextResponse.json({ error: 'Fetch failed', details: txt, status: r.status }, { status: 400, headers }) }
    const ct = String(r.headers.get('content-type') || '').toLowerCase()
    const buf = Buffer.from(await r.arrayBuffer())

    let ext = 'bin'
    let storeCT = 'application/octet-stream'
    const detectKind = kind === 'auto' ? (ct.startsWith('image/') ? 'image' : ct.startsWith('video/') ? 'video' : 'bin') : kind
    if (detectKind === 'image') { ext = 'png'; storeCT = ct || 'image/png' }
    else if (detectKind === 'video') { ext = 'mp4'; storeCT = ct || 'video/mp4' }

    const email = (user.email || '').toLowerCase()
    const safeId = require('crypto').createHash('sha256').update(email).digest('hex').slice(0, 12)
    const base = `${safeId}/${project_id || `ai-${Date.now()}`}`
    const name = `bg-${Date.now()}.${ext}`
    const objPath = `${base}/${name}`

    const up = await supabase.storage.from('clips').upload(objPath, new Blob([buf], { type: storeCT }), { upsert: true, contentType: storeCT })
    if (up.error) return NextResponse.json({ error: 'Upload failed', details: up.error.message }, { status: 502, headers })

    const publicUrl = supabase.storage.from('clips').getPublicUrl(objPath).data.publicUrl

    return NextResponse.json({ url: publicUrl, path: objPath, content_type: storeCT }, { status: 200, headers })
  } catch (e: any) {
    return NextResponse.json({ error: 'Server error', details: String(e?.message || e) }, { status: 500, headers })
  }
}
