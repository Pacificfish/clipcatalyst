import { NextRequest } from 'next/server'
import { S3Client, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export async function POST(req: NextRequest) {
  try {
    const { key, uploadId, parts } = await req.json()
    if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return new Response(JSON.stringify({ error: 'key, uploadId, parts[] are required' }), { status: 400 })
    }
    const Bucket = requiredEnv('S3_BUCKET')
    const region = requiredEnv('AWS_REGION')
    const s3 = new S3Client({ region })

    const comp = await s3.send(new CompleteMultipartUploadCommand({
      Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p: any) => ({ ETag: p.ETag, PartNumber: Number(p.PartNumber || p.partNumber) })) }
    }))

    // Generate a presigned GET URL to allow the worker to read the file
    const url = await getSignedUrl(s3, new (await import('@aws-sdk/client-s3')).GetObjectCommand({ Bucket, Key: key }), { expiresIn: 60 * 60 })

    return new Response(JSON.stringify({ key, file_url: url }), { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'complete failed' }), { status: 500 })
  }
}

