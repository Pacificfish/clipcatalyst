import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN || ''
    if (!token) return NextResponse.json({ error: 'Blob token not configured' }, { status: 500 })

    const ctype = req.headers.get('content-type') || ''
    if (!ctype.includes('multipart/form-data')) {
      return NextResponse.json({ error: 'Send multipart/form-data with field "file"' }, { status: 400 })
    }
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'Missing file' }, { status: 400 })

    const { put } = await import('@vercel/blob')
    const arrayBuf = await file.arrayBuffer()
    const ext = (file.name && file.name.split('.').pop()) || 'mp4'
    const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { url } = await put(key, Buffer.from(arrayBuf), {
      access: 'public',
      token,
      contentType: file.type || 'application/octet-stream'
    })

    return NextResponse.json({ url, key, name: file.name, size: file.size, type: file.type || '' }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'upload failed' }, { status: 500 })
  }
}
