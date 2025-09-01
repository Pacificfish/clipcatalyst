'use client'

import { useState } from 'react'

export default function AutoClipPage() {
  const [videoUrl, setVideoUrl] = useState('')
  const [targetCount, setTargetCount] = useState(3)
  const [minMs, setMinMs] = useState(18000)
  const [maxMs, setMaxMs] = useState(30000)
  const [language, setLanguage] = useState('')
  const [bgUrl, setBgUrl] = useState('')
  const [bypass, setBypass] = useState('')
  const [out, setOut] = useState('(nothing yet)')
  const [busy, setBusy] = useState(false)

  async function run() {
    try {
      setBusy(true)
      setOut('Running...')
      const r = await fetch('/api/auto-clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url: videoUrl.trim(),
          target_clip_count: Math.max(1, Number(targetCount || 3)),
          min_ms: Math.max(1000, Number(minMs || 18000)),
          max_ms: Math.max(2000, Number(maxMs || 30000)),
          language: language.trim() || undefined,
          bg_url: bgUrl.trim() || undefined,
          // Optional: include bypass token if not configured server-side
          bypass: bypass.trim() || undefined,
        })
      })
      const txt = await r.text()
      try {
        setOut(JSON.stringify(JSON.parse(txt), null, 2))
      } catch {
        setOut(`Status: ${r.status}\n\n${txt}`)
      }
    } catch (e: any) {
      setOut('Error: ' + (e?.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="container py-10 space-y-6">
      <h1 className="text-3xl font-bold">Auto Clip Tester</h1>
      <p className="text-white/70">Provide a direct .mp4 URL to generate multiple clips. This calls a server route that forwards to the worker.</p>

      <div className="grid gap-4 max-w-3xl">
        <div>
          <label className="block font-semibold mb-1">Video URL (.mp4)</label>
          <input className="w-full input" placeholder="https://example.com/video.mp4" value={videoUrl} onChange={e=>setVideoUrl(e.target.value)} />
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          <div>
            <label className="block font-semibold mb-1">Target clips</label>
            <input type="number" className="w-full input" min={1} value={targetCount} onChange={e=>setTargetCount(Number(e.target.value))} />
          </div>
          <div>
            <label className="block font-semibold mb-1">Min ms</label>
            <input type="number" className="w-full input" min={1000} value={minMs} onChange={e=>setMinMs(Number(e.target.value))} />
          </div>
          <div>
            <label className="block font-semibold mb-1">Max ms</label>
            <input type="number" className="w-full input" min={2000} value={maxMs} onChange={e=>setMaxMs(Number(e.target.value))} />
          </div>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="block font-semibold mb-1">Language (optional)</label>
            <input className="w-full input" placeholder="en" value={language} onChange={e=>setLanguage(e.target.value)} />
          </div>
          <div>
            <label className="block font-semibold mb-1">Background URL (optional)</label>
            <input className="w-full input" placeholder="https://example.com/background.mp4" value={bgUrl} onChange={e=>setBgUrl(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="block font-semibold mb-1">Bypass token (optional if set server-side)</label>
          <input className="w-full input" placeholder="x-vercel-protection-bypass token" value={bypass} onChange={e=>setBypass(e.target.value)} />
        </div>
        <div>
          <button className="btn-primary" onClick={run} disabled={busy || !videoUrl}>{busy ? 'Running…' : 'Run Auto Clip'}</button>
        </div>
      </div>

      <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
        <div className="text-sm font-semibold mb-2">Result</div>
        <pre className="whitespace-pre-wrap break-words text-xs">{out}</pre>
      </div>
    </main>
  )
}
