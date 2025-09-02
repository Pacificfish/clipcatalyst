'use client'

import { useState, useRef } from 'react'

export default function AutoClipPage() {
  const [videoUrl, setVideoUrl] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [targetCount, setTargetCount] = useState(3)
  const [minMs, setMinMs] = useState(18000)
  const [maxMs, setMaxMs] = useState(30000)
  const [language, setLanguage] = useState('')
  const [bgUrl, setBgUrl] = useState('')
  const [bypass, setBypass] = useState('')
  const [out, setOut] = useState('(nothing yet)')
  const [busy, setBusy] = useState(false)
  const [uiError, setUiError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function uploadAndRun() {
    try {
      setBusy(true)
      setUiError('')
      setOut('Uploading file...')
      const f = fileRef.current?.files?.[0]
      if (!f) { setUiError('Pick a file to upload'); setBusy(false); return }
      const fd = new FormData()
      fd.set('file', f)
      const up = await fetch('/api/upload-video', { method: 'POST', body: fd })
      const uj = await up.json()
      if (!up.ok) { setUiError(uj?.error || 'Upload failed'); setOut(JSON.stringify(uj,null,2)); setBusy(false); return }
      const url = uj?.url as string
      if (!url) { setUiError('Upload did not return a URL'); setBusy(false); return }
      setVideoUrl(url)
      await run(url, '')
    } catch (e:any) {
      setUiError(e?.message || 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function run(videoUrlOverride?: string, youtubeUrlOverride?: string) {
    try {
      setBusy(true)
      setUiError('')
      setOut('Running...')
      const body: any = {
        target_clip_count: Math.max(1, Number(targetCount || 3)),
        min_ms: Math.max(1000, Number(minMs || 18000)),
        max_ms: Math.max(2000, Number(maxMs || 30000)),
        language: language.trim() || undefined,
        bg_url: bgUrl.trim() || undefined,
        // Optional: include bypass token if not configured server-side
        bypass: bypass.trim() || undefined,
      }
      const v = (videoUrlOverride ?? videoUrl).trim()
      const y = (youtubeUrlOverride ?? youtubeUrl).trim()
      if (y) body.youtube_url = y
      else if (v) body.video_url = v
      else { setUiError('Provide a YouTube URL or upload a video'); setBusy(false); return }

      const headers: Record<string,string> = { 'Content-Type': 'application/json' }
      if (process.env.NEXT_PUBLIC_VERCEL_BYPASS) headers['x-vercel-protection-bypass'] = String(process.env.NEXT_PUBLIC_VERCEL_BYPASS)
      // Start async job via site API (it proxies to worker)
      const start = await fetch('/api/auto-clip', { method: 'POST', headers, body: JSON.stringify(body) })
      const stxt = await start.text()
      let sjson: any = null
      try { sjson = JSON.parse(stxt) } catch {}
      if (!start.ok) {
        setOut(`Status: ${start.status}\n\n${stxt}`)
        return
      }
      const jobId: string = sjson?.job_id || ''
      if (!jobId) {
        // Backward compatibility: if server returned final JSON result directly
        if (sjson && sjson.error === 'no_audio_stream') {
          setUiError('This video appears to have no audio track. Auto Clip requires audio to transcribe and find highlights. Please try a different file (with audio) or a YouTube link that contains audio.')
        }
        setOut(JSON.stringify(sjson ?? stxt, null, 2))
        return
      }
      // Poll status until completed or error
      setOut(`Job started: ${jobId}\nPolling...`)
      for (let i=0;i<900;i++) { // up to ~45 minutes @3s
        await new Promise(r=>setTimeout(r, 3000))
        const sr = await fetch(`/api/auto-clip?job_id=${encodeURIComponent(jobId)}`, { cache: 'no-store' })
        const t = await sr.text()
        let j: any = null; try { j = JSON.parse(t) } catch {}
        if (!sr.ok) { setOut(`Status: ${sr.status}\n\n${t}`); break }
        if (j?.status === 'completed') { setOut(JSON.stringify(j.result, null, 2)); break }
        if (j?.status === 'error') { setUiError(j?.error || 'Auto clip failed'); setOut(JSON.stringify(j, null, 2)); break }
        setOut(prev => `Job ${jobId} • ${j?.status || 'pending'} • updated ${new Date(j?.updatedAt||Date.now()).toLocaleTimeString()}`)
      }
    } catch (e: any) {
      setUiError(e?.message || 'Something went wrong')
      setOut('Error: ' + (e?.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="container py-10 space-y-6">
      <h1 className="text-3xl font-bold">Auto Clip Tester</h1>
      <p className="text-white/70">Provide a direct .mp4 URL or a YouTube link. This calls a server route that forwards to the worker.</p>

      {uiError && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          {uiError}
        </div>
      )}

      <div className="grid gap-4 max-w-3xl">
        <div className="p-3 rounded-lg bg-white/5 ring-1 ring-white/10">
          <div className="font-semibold mb-2">Upload a video (recommended)</div>
          <input ref={fileRef} type="file" accept="video/*" className="block w-full" />
          <div className="mt-2 flex gap-2">
            <button className="btn-primary" onClick={uploadAndRun} disabled={busy}>{busy ? 'Uploading…' : 'Upload & Auto Clip'}</button>
          </div>
          <div className="text-xs text-white/60 mt-1">We’ll upload to secure storage and process server-side. Works reliably without YouTube.</div>
        </div>
        <div>
          <label className="block font-semibold mb-1">Or use a YouTube URL</label>
          <input className="w-full input" placeholder="https://www.youtube.com/watch?v=..." value={youtubeUrl} onChange={e=>setYoutubeUrl(e.target.value)} />
          <div className="text-xs text-white/60 mt-1">YouTube support is beta and may fail; if it does, please upload the video instead.</div>
        </div>
        <div>
          <label className="block font-semibold mb-1">Direct video URL (.mp4)</label>
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
          <button className="btn-primary" onClick={()=>run()} disabled={busy || (!youtubeUrl && !videoUrl)}>{busy ? 'Running…' : 'Run Auto Clip'}</button>
        </div>
      </div>

      <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
        <div className="text-sm font-semibold mb-2">Result</div>
        <pre className="whitespace-pre-wrap break-words text-xs">{out}</pre>
      </div>
    </main>
  )
}
