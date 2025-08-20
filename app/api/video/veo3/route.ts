import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const { prompt, duration, aspect_ratio } = body || {}

    if (!prompt || !duration || !aspect_ratio) {
      return NextResponse.json({ error: 'Missing prompt, duration or aspect_ratio' }, { status: 400 })
    }

    const key = process.env.VEO3_API_KEY
    if (!key) {
      return NextResponse.json({
        message: 'Veo3 is not configured yet. Set VEO3_API_KEY and enable NEXT_PUBLIC_ENABLE_VEO3=1 to use this feature.',
      })
    }

    // Placeholder: integrate with Veo3 provider here. For now, return accepted.
    return NextResponse.json({ message: 'Veo3 job accepted. Implement provider integration.' })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Unexpected error' }, { status: 500 })
  }
}

