import { NextRequest } from 'next/server'

// Lightweight keyword extraction from title/transcript to improve Pexels relevance
function extractKeywords(input: string, max = 12): string[] {
  if (!input) return []
  const stop = new Set([
    'the','a','an','and','or','but','so','because','of','in','on','for','to','from','with','about','as','at','by','into','like','through','after','over','between','out','against','during','without','before','under','around','among',
    'is','are','was','were','be','being','been','am','do','does','did','have','has','had','will','would','can','could','should','may','might','must',
    'i','you','he','she','it','we','they','them','my','your','his','her','its','our','their','me','us'
  ])
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !stop.has(w) && w.length > 2 && w.length < 32)
  const freq = new Map<string, number>()
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1)
  const ranked = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).map(([w]) => w)
  // Also include some two-word phrases to increase specificity
  const phrases: string[] = []
  for (let i = 0; i < words.length - 1 && phrases.length < 6; i++) {
    const a = words[i], b = words[i + 1]
    if (a && b && a !== b && !stop.has(a) && !stop.has(b)) phrases.push(`${a} ${b}`)
  }
  const combined = [...ranked.slice(0, max), ...phrases]
  // Deduplicate while preserving order
  const seen = new Set<string>()
  return combined.filter(k => (k = k.trim()) && !seen.has(k) && seen.add(k))
}

function dedupeBy<T>(items: T[], keyFn: (t: T) => string | number): T[] {
  const seen = new Set<string | number>()
  const out: T[] = []
  for (const it of items) {
    const k = keyFn(it)
    if (k == null) continue
    if (!seen.has(k)) { seen.add(k); out.push(it) }
  }
  return out
}

function pickBestVideoFile(video: any): { url: string, width: number, height: number } | null {
  const files: any[] = Array.isArray(video?.video_files) ? video.video_files : []
  if (files.length === 0) return null
  // Prefer vertical 1080x1920-ish, else tallest portrait, else highest resolution
  const portrait = files.filter(f => f?.width && f?.height && f.height > f.width)
  const exact = portrait.find(f => (f.width === 1080 && f.height === 1920) || (f.width >= 900 && f.height >= 1600))
  const bestPortrait = exact || portrait.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
  const best = bestPortrait || files.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
  if (!best) return null
  return { url: best.link || best.file, width: best.width, height: best.height }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as {
      keywords?: string[]
      title?: string
      transcript?: string
      type?: 'video' | 'image' | 'both'
      orientation?: 'portrait' | 'landscape' | 'square'
      max?: number
    }

    const provided = Array.isArray(body.keywords) ? body.keywords.filter(Boolean) : []
    const derived = extractKeywords(`${body.title || ''} ${body.transcript || ''}`, 12)
    // Merge and rank: keep provided terms first, then derived
    const merged = dedupeBy(
      [...provided, ...derived],
      (s) => (s || '').toLowerCase()
    ).slice(0, 16)

    const PEXELS_API_KEY = process.env.PEXELS_API_KEY || ''
    const wantType = body.type || 'both'
    const orientation = body.orientation || 'portrait'
    const perPage = Math.min(Math.max(body.max ?? 8, 1), 15)

    if (!PEXELS_API_KEY || merged.length === 0) {
      return new Response(JSON.stringify({ videos: [], photos: [], used_queries: [] }), { status: 200 })
    }

    // Build up to 3 focused queries to increase relevance
    const queryPhrases: string[] = []
    if (merged.length >= 2) queryPhrases.push(`${merged[0]} ${merged[1]}`)
    if (merged.length >= 4) queryPhrases.push(`${merged[2]} ${merged[3]}`)
    // Fallback single-word terms
    queryPhrases.push(merged[0])
    const used_queries: string[] = []

    const headers = { Authorization: PEXELS_API_KEY }

    const videos: { url: string, width: number, height: number, id: number }[] = []
    const photos: { url: string, width: number, height: number, id: number }[] = []

    // Helper to fetch safely
    async function safeJson(url: string): Promise<any | null> {
      const r = await fetch(url, { headers })
      if (!r.ok) return null
      return r.json().catch(() => null)
    }

    // Query videos
    if (wantType === 'video' || wantType === 'both') {
      for (const q of queryPhrases) {
        const enc = encodeURIComponent(q)
        const url = `https://api.pexels.com/videos/search?query=${enc}&orientation=${orientation}&size=medium&per_page=${perPage}`
        const data = await safeJson(url)
        if (data?.videos?.length) {
          used_queries.push(q)
          for (const v of data.videos) {
            const f = pickBestVideoFile(v)
            if (f?.url) videos.push({ url: f.url, width: f.width, height: f.height, id: v?.id })
          }
        }
      }
    }

    // Query photos
    if (wantType === 'image' || wantType === 'both') {
      for (const q of queryPhrases) {
        const enc = encodeURIComponent(q)
        const url = `https://api.pexels.com/v1/search?query=${enc}&orientation=${orientation}&per_page=${perPage}`
        const data = await safeJson(url)
        if (data?.photos?.length) {
          if (!used_queries.includes(q)) used_queries.push(q)
          for (const p of data.photos) {
            const src = p?.src?.large2x || p?.src?.large || p?.src?.original || p?.url
            if (src) photos.push({ url: src, width: p?.width, height: p?.height, id: p?.id })
          }
        }
      }
    }

    const out = {
      videos: dedupeBy(videos, v => v.id || v.url),
      photos: dedupeBy(photos, p => p.id || p.url),
      used_queries
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return new Response(JSON.stringify({ videos: [], photos: [], error: e?.message || 'media failed' }), { status: 200 })
  }
}

