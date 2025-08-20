import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import crypto from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const headers = { 'Access-Control-Allow-Origin': '*' }

    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })

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

    if (projects.length === 0) {
      projects = await Promise.all(
        folders.map(async (f: any) => {
          const projectId = String(f.name)
          const base = `${safeId}/${projectId}`
          const mp3 = supabaseAdmin.storage.from('clips').getPublicUrl(`${base}/voiceover.mp3`).data.publicUrl
          const csv = supabaseAdmin.storage.from('clips').getPublicUrl(`${base}/captions.csv`).data.publicUrl
          const thumb = supabaseAdmin.storage.from('clips').getPublicUrl(`${base}/thumb.svg`).data.publicUrl
          return { id: projectId, title: projectId, mp3_url: mp3, csv_url: csv, thumb_url: thumb, updated_at: (f as any)?.updated_at || null }
        })
      )
    }

    return NextResponse.json({ projects }, { headers })
  } catch (e: any) {
    return NextResponse.json({ error: 'Server error', details: String(e?.message || e) }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
}
