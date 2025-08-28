import { NextRequest } from 'next/server'
import { S3Client, UploadPartCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export async function POST(req: NextRequest) {
  try {
    const { key, uploadId, partNumber } = await req.json()
    if (!key || !uploadId || !partNumber) {
      return new Response(JSON.stringify({ error: 'key, uploadId, partNumber are required' }), { status: 400 })
    }
    const Bucket = requiredEnv('S3_BUCKET')
    const region = requiredEnv('AWS_REGION')
    const s3 = new S3Client({ region })
    const cmd = new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: Number(partNumber) })
    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 * 10 })
    return new Response(JSON.stringify({ url }), { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'sign failed' }), { status: 500 })
  }
}

