import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'
import crypto from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const headers = { 'Access-Control-Allow-Origin': '*' }

    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })

const supabaseAdmin = getSupabaseAdmin()
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
    if (userErr || !userData?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
    const user = userData.user
    const email = (user.email || '').toLowerCase()

    const safeId = crypto.createHash('sha256').update(email).digest('hex').slice(0, 12)

    const { data: entries, error: listErr } = await supabaseAdmin.storage.from('clips').list(safeId, { limit: 1000, sortBy: { column: 'updated_at', order: 'desc' } })
    if (listErr) return NextResponse.json({ error: 'List failed', details: listErr.message }, { status: 500, headers })

    const folders = (entries || []).filter((e: any) => !e?.metadata || typeof e?.metadata?.size !== 'number')

    let projects: any[] = []
    try {
      const { data: rows, error: qErr } = await supabaseAdmin
        .from('projects')
        .select('id,title,mp3_url,csv_url,thumb_url,created_at,updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
      if (!qErr && Array.isArray(rows)) projects = rows
    } catch {}

    // Always merge storage-derived folders so newly generated projects appear
    const existingIds = new Set(projects.map((p: any) => p.id))
    const derived = await Promise.all(
      folders.map(async (f: any) => {
        const projectId = String(f.name)
        const base = `${safeId}/${projectId}`
        let mp3 = supabaseAdmin.storage.from('clips').getPublicUrl(`${base}/voiceover.mp3`).data.publicUrl
        let csv = supabaseAdmin.storage.from('clips').getPublicUrl(`${base}/captions.csv`).data.publicUrl
        let thumb = supabaseAdmin.storage.from('clips').getPublicUrl(`${base}/thumb.svg`).data.publicUrl
        try { const s = await supabaseAdmin.storage.from('clips').createSignedUrl(`${base}/voiceover.mp3`, 604800); if (s.data?.signedUrl) mp3 = s.data.signedUrl } catch {}
        try { const s = await supabaseAdmin.storage.from('clips').createSignedUrl(`${base}/captions.csv`, 604800); if (s.data?.signedUrl) csv = s.data.signedUrl } catch {}
        try { const s = await supabaseAdmin.storage.from('clips').createSignedUrl(`${base}/thumb.svg`, 604800); if (s.data?.signedUrl) thumb = s.data.signedUrl } catch {}
        return { id: projectId, title: projectId, mp3_url: mp3, csv_url: csv, thumb_url: thumb, updated_at: (f as any)?.updated_at || null }
      })
    )
    for (const d of derived) {
      if (!existingIds.has(d.id)) projects.push(d)
    }

    // Sort by updated_at desc when possible
    projects.sort((a: any, b: any) => {
      const ta = a?.updated_at ? new Date(a.updated_at).getTime() : 0
      const tb = b?.updated_at ? new Date(b.updated_at).getTime() : 0
      return tb - ta
    })

    // Replace URLs with signed URLs to avoid 400s on private buckets
    for (const p of projects){
      try {
        const base = `${safeId}/${p.id}`
        const s1 = await supabaseAdmin.storage.from('clips').createSignedUrl(`${base}/voiceover.mp3`, 604800)
        const s2 = await supabaseAdmin.storage.from('clips').createSignedUrl(`${base}/captions.csv`, 604800)
        const s3 = await supabaseAdmin.storage.from('clips').createSignedUrl(`${base}/thumb.svg`, 604800)
        p.mp3_url = s1.data?.signedUrl || p.mp3_url
        p.csv_url = s2.data?.signedUrl || p.csv_url
        p.thumb_url = s3.data?.signedUrl || p.thumb_url
      } catch {}
    }

    return NextResponse.json({ projects }, { headers })
  } catch (e: any) {
    return NextResponse.json({ error: 'Server error', details: String(e?.message || e) }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
}
