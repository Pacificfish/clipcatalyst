import { NextRequest } from 'next/server'
import { S3Client, CreateMultipartUploadCommand } from '@aws-sdk/client-s3'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export async function POST(req: NextRequest) {
  try {
    const { filename, contentType } = await req.json()
    if (!filename || !contentType) {
      return new Response(JSON.stringify({ error: 'filename and contentType are required' }), { status: 400 })
    }
    const Bucket = requiredEnv('S3_BUCKET')
    const region = requiredEnv('AWS_REGION')
    const s3 = new S3Client({ region })

    const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`
    const res = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType, ACL: 'private' }))
    if (!res.UploadId) return new Response(JSON.stringify({ error: 'Failed to initiate upload' }), { status: 500 })

    return new Response(JSON.stringify({ uploadId: res.UploadId, key }), { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'init failed' }), { status: 500 })
  }
}

