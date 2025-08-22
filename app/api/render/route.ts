import { NextRequest } from 'next/server'
import { writeFile, mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { renderVideo } from '@/lib/renderVideo'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { mp3_url, csv_url, bg_url, bg_urls, music_url, preset, title, logo_url } = body || {}
    if (!mp3_url || !csv_url) {
      return new Response(JSON.stringify({ error: 'mp3_url and csv_url are required' }), { status: 400 })
    }

    const tmpBase = await mkdtemp(path.join(tmpdir(), 'render-'))
    const audioPath = path.join(tmpBase, `${randomUUID()}.mp3`)
    const csvPath = path.join(tmpBase, `${randomUUID()}.csv`)
    const outPath = path.join(tmpBase, `${randomUUID()}.mp4`)
    const musicPath = music_url ? path.join(tmpBase, `${randomUUID()}.mp3`) : null
    const logoPath = logo_url ? path.join(tmpBase, `${randomUUID()}.png`) : null
    const bgList: string[] = []

    const bgFetches = Array.isArray(bg_urls) ? bg_urls : (bg_url ? [bg_url] : [])
    const [mp3Res, csvRes, musRes, logoRes, ...bgRes] = await Promise.all([
      fetch(mp3_url),
      fetch(csv_url),
      music_url ? fetch(music_url) : Promise.resolve(null as any),
      logo_url ? fetch(logo_url) : Promise.resolve(null as any),
      ...bgFetches.map((u: string) => fetch(u))
    ] as any)
    if (!mp3Res.ok || !csvRes.ok) {
      return new Response(JSON.stringify({ error: 'Failed to fetch inputs' }), { status: 400 })
    }
    const [mp3Buf, csvBuf, musBuf, logoBuf, ...bgBufs] = await Promise.all([
      mp3Res.arrayBuffer(),
      csvRes.arrayBuffer(),
      musRes ? musRes.arrayBuffer() : Promise.resolve(null),
      logoRes ? logoRes.arrayBuffer() : Promise.resolve(null),
      ...(Array.isArray(bgRes) ? bgRes.map((r: any) => r.arrayBuffer()) : [])
    ] as any)
    await writeFile(audioPath, Buffer.from(mp3Buf))
    await writeFile(csvPath, Buffer.from(csvBuf))
    if (musicPath && musBuf) await writeFile(musicPath, Buffer.from(musBuf as ArrayBuffer))
    if (logoPath && logoBuf) await writeFile(logoPath, Buffer.from(logoBuf as ArrayBuffer))

    if (Array.isArray(bgBufs) && bgBufs.length) {
      for (const ab of bgBufs) {
        const p = path.join(tmpBase, `${randomUUID()}.mp4`)
        await writeFile(p, Buffer.from(ab as ArrayBuffer))
        bgList.push(p)
      }
    }

    // Run render in-process to ensure ffmpeg-static is available in the bundled function
    try {
      await renderVideo({
        audio: audioPath,
        captions: csvPath,
        out: outPath,
        bgs: bgList,
        music: musicPath || undefined,
        preset: preset || undefined,
        title: title || undefined,
        logo: logoPath || undefined,
        noSubs: true, // keep disabled for stability; can enable later
      })
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || 'Render failed' }), { status: 500 })
    }

    const buf = await readFile(outPath)
    const filename = `clip-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`
    const ab = new ArrayBuffer(buf.byteLength)
    new Uint8Array(ab).set(buf)
    return new Response(ab, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Render failed' }), { status: 500 })
  }
}
