import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get('content-type') || 'application/octet-stream'
    const rawName = req.headers.get('x-filename') || `upload-${Date.now()}`
    // Sanitize filename
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const key = `uploads/${Date.now()}-${safeName}`
    const body = req.body
    if (!body) return NextResponse.json({ error: 'missing body' }, { status: 400 })

    const { url } = await put(key, body as any, { access: 'public', contentType })
    return NextResponse.json({ url, key })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'blob upload failed' }, { status: 500 })
  }
}

