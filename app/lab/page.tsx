'use client';

import { useEffect, useState } from 'react';
import Nav from '@/components/Nav';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';

type GenerateResult = {
  mp3_url?: string;
  csv_url?: string;
  project_id?: string;
  keywords?: string[];
  error?: string;
  details?: string;
};

export default function LabPage() {
  const [session, setSession] = useState<any>(null);
  const [mode, setMode] = useState<'Paste' | 'URL'>('Paste');
  const [source, setSource] = useState('');
  const [language, setLanguage] = useState('English');
  const [tone, setTone] = useState('Informative');
  const [topic, setTopic] = useState('');
  const [title, setTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [autoBroll, setAutoBroll] = useState(true);
  const [musicUrl, setMusicUrl] = useState('');
  const [useTikTokPreset, setUseTikTokPreset] = useState(true);
  const [logoUrl, setLogoUrl] = useState('');
  const [bgUrlManual, setBgUrlManual] = useState('');
  // Source dropdown state
  const [sourceType, setSourceType] = useState<'paste' | 'article' | 'youtube' | 'upload'>('paste');
  const [initialUploadUrl, setInitialUploadUrl] = useState<string>('');
  const [ytLastUrl, setYtLastUrl] = useState<string>('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Fetch usage to show remaining credits
  useEffect(() => {
    async function loadUsage() {
      if (!session?.access_token) return;
      try {
        const res = await fetch('/api/usage', {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        const data = await res.json();
        const el = document.getElementById('credits-indicator');
        const inline = document.getElementById('credits-inline');
        if (!res.ok || data.error) {
          if (el) el.textContent = '';
          if (inline) inline.textContent = '';
        } else if (data.monthly === 'unlimited') {
          if (el) el.textContent = 'Credits: unlimited';
          if (inline) inline.textContent = 'unlimited';
        } else {
          const msg = `Credits: ${data.remaining} of ${data.monthly} left`;
          if (el) el.textContent = msg;
          if (inline) inline.textContent = `${data.remaining}/${data.monthly}`;
        }
      } catch {}
    }
    loadUsage();
    function onVis() {
      if (document.visibilityState === 'visible') loadUsage();
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [session?.access_token]);

  if (!session) {
    return (
      <>
        <Nav />
        <main className="container py-16">
          <div className="card p-6">Please sign in to use the Lab.</div>
        </main>
      </>
    );
  }

  const email = session?.user?.email || 'anon@example.com';
  const plan = String(session?.user?.user_metadata?.plan || '').toLowerCase();
  const devOverride = (process.env.NEXT_PUBLIC_DEV_SUB_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes((email || '').toLowerCase());
  const hasSubscription = devOverride || ['beginner', 'pro', 'agency'].includes(plan);
  if (!hasSubscription) {
    return (
      <>
        <Nav />
        <main className="container py-16">
          <div className="card p-6 space-y-3">
            <div className="font-semibold">Subscription required</div>
            <p className="text-white/70 text-sm">
              Your account does not have an active plan. Choose a plan to unlock the Lab.
            </p>
            <div>
              <Link className="btn-primary" href="/pricing">
                View pricing
              </Link>
            </div>
          </div>
        </main>
      </>
    );
  }

  async function handleGenerate() {
    setIsLoading(true);
    setError(null);
    setResult(null);
    try {
      const body: any = { mode, language, tone, topic, email, title: title.trim(), project_id: `lab-${Date.now()}` };
      if (mode === 'Paste') body.source_text = source.trim();
      if (mode === 'URL') body.source_url = source.trim();

      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const data: GenerateResult = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setResult(data);

      try {
        const res2 = await fetch('/api/usage', {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        const data2 = await res2.json();
        const el = document.getElementById('credits-indicator');
        const inline = document.getElementById('credits-inline');
        if (!res2.ok || data2.error) {
          if (el) el.textContent = '';
          if (inline) inline.textContent = '';
        } else if (data2.monthly === 'unlimited') {
          if (el) el.textContent = 'Credits: unlimited';
          if (inline) inline.textContent = 'unlimited';
        } else {
          const msg = `Credits: ${data2.remaining} of ${data2.monthly} left`;
          if (el) el.textContent = msg;
          if (inline) inline.textContent = `${data2.remaining}/${data2.monthly}`;
        }
      } catch {}
    } catch (e: any) {
      setError(e?.message || 'Something went wrong.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRender() {
    if (!result?.mp3_url || !result?.csv_url) return;
    try {
      setIsRendering(true);

      let bg_urls: string[] | undefined;
      if (autoBroll) {
        try {
          const kw = (result.keywords && result.keywords.length ? result.keywords : title.split(/\s+/).slice(0,6)).slice(0,8);
          const r = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, transcript: (mode === 'Paste' ? source : topic), keywords: kw, type: 'video', orientation: 'portrait', max: 8 }) });
          if (r.ok) {
            const data = await r.json();
            const vids: string[] = Array.isArray(data?.videos) ? data.videos.map((v: any) => v?.url).filter(Boolean) : [];
            bg_urls = vids.slice(0, 4); // use up to 4 clips
          }
        } catch {}
      }

      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mp3_url: result.mp3_url, csv_url: result.csv_url, ...(bgUrlManual.trim() ? { bg_url: bgUrlManual.trim() } : (bg_urls && bg_urls.length ? { bg_urls } : {})), ...(musicUrl.trim() ? { music_url: musicUrl.trim() } : {}), preset: useTikTokPreset ? 'tiktok_v1' : undefined, title, ...(logoUrl.trim() ? { logo_url: logoUrl.trim() } : {}) }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Render failed: ${txt || res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clip-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(e?.message || 'Render failed');
    } finally {
      setIsRendering(false);
    }
  }

  const disabled = isLoading || !source.trim() || !title.trim();

  return (
    <>
      <Nav />
      <main className="container py-16 space-y-8">
        <header className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Lab</h1>
          <div className="flex items-center gap-3">
            <span id="credits-indicator" className="text-xs text-white/60" />
            <button
              onClick={async () => {
                try {
                  const res = await fetch('/api/usage', {
                    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
                  });
                  const data = await res.json();
                  const el = document.getElementById('credits-indicator');
                  const inline = document.getElementById('credits-inline');
                  if (!res.ok || data.error) {
                    if (el) el.textContent = '';
                    if (inline) inline.textContent = '';
                  } else if (data.monthly === 'unlimited') {
                    if (el) el.textContent = 'Credits: unlimited';
                    if (inline) inline.textContent = 'unlimited';
                  } else {
                    const msg = `Credits: ${data.remaining} of ${data.monthly} left`;
                    if (el) el.textContent = msg;
                    if (inline) inline.textContent = `${data.remaining}/${data.monthly}`;
                  }
                } catch {}
              }}
              className="btn"
            >
              Refresh
            </button>
            <div className="text-xs text-white/60">Signed in as {email}</div>
            {devOverride && (
              <span className="text-[10px] uppercase tracking-wide bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40 px-2 py-0.5 rounded">
                Dev override active
              </span>
            )}
          </div>
        </header>

        <div className="card p-6 space-y-4">
          {/* Source selector */}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 sm:col-span-1">
              <span className="text-xs text-white/60">Source</span>
              <select
                className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2"
                value={sourceType}
                onChange={(e) => {
                  const v = e.target.value as 'paste' | 'article' | 'youtube' | 'upload'
                  setSourceType(v)
                  // Keep legacy mode in sync for generate flow
                  if (v === 'paste') setMode('Paste')
                  if (v === 'article') setMode('URL')
                }}
              >
                <option value="paste">Paste text</option>
                <option value="article">Article URL</option>
                <option value="youtube">YouTube URL</option>
                <option value="upload">Upload video</option>
              </select>
            </label>
          </div>

          {/* Title */}
          <div>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/60">Project title (required)</span>
              <input className="w-full rounded-xl bg-white/5 ring-1 ring-white/10 p-3" placeholder="e.g., AI breakthroughs explainer" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
          </div>

          {/* Source input */}
          <div>
            {sourceType === 'paste' ? (
              <textarea className="w-full h-36 rounded-xl bg-white/5 ring-1 ring-white/10 p-3" placeholder="Paste source text here…" value={source} onChange={(e) => setSource(e.target.value)} />
            ) : sourceType === 'article' ? (
              <input type="url" className="w-full rounded-xl bg-white/5 ring-1 ring-white/10 p-3" placeholder="https://example.com/article" value={source} onChange={(e) => setSource(e.target.value)} />
            ) : null}
          </div>

          {/* YouTube downloader (inline) */}
          {sourceType === 'youtube' && (
            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
              <YouTubeDownloader onDone={(u)=>{ setYtLastUrl(u); setInitialUploadUrl(u); setSourceType('upload'); }} />
            </div>
          )}

          {/* Upload (Autoclipper inline) */}
          {sourceType === 'upload' && (
            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
              <Autoclipper initialUrl={initialUploadUrl} />
            </div>
          )}

          {/* Options */}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/60">Language</span>
              <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="English" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/60">Tone</span>
              <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Informative" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/60">Topic (optional)</span>
              <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g., AI breakthroughs" />
            </label>
          </div>

          {/* Style preset, b‑roll and music */}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={useTikTokPreset} onChange={e => setUseTikTokPreset(e.target.checked)} />
              TikTok style preset
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={autoBroll} onChange={e => setAutoBroll(e.target.checked)} />
              Auto b‑roll
            </label>
            <label className="flex flex-col gap-1 sm:col-span-1">
              <span className="text-xs text-white/60">Background music URL (optional)</span>
              <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" placeholder="https://.../music.mp3" value={musicUrl} onChange={e => setMusicUrl(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-1">
              <span className="text-xs text-white/60">Watermark logo URL (optional, PNG/SVG)</span>
              <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" placeholder="https://.../logo.png" value={logoUrl} onChange={e => setLogoUrl(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-3">
              <span className="text-xs text-white/60">Background video URL (optional, overrides auto b‑roll)</span>
              <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" placeholder="https://.../background.mp4" value={bgUrlManual} onChange={e => setBgUrlManual(e.target.value)} />
            </label>
          </div>

          {/* Generate */}
          <div className="mt-2 flex items-center gap-3">
            <button onClick={handleGenerate} disabled={disabled} className={`btn-primary ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
              {isLoading ? 'Generating…' : 'Generate'}
            </button>
            <span id="credits-inline" className="text-xs text-white/60 ring-1 ring-white/10 rounded-full px-2 py-0.5" />
            {isLoading && <span className="text-xs text-white/60">This can take ~10–20s…</span>}
          </div>


          {/* Error */}
          {error && <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</div>}

          {/* Result */}
          {result && (
            <div className="pt-4 space-y-3">
              {result.mp3_url && (
                <div className="space-y-2">
                  <audio controls src={result.mp3_url} className="w-full" />
                  <div className="flex gap-2">
                    <a className="btn" href={result.mp3_url} target="_blank">Download MP3</a>
                    <button className="btn-primary" onClick={handleRender} disabled={isRendering || !result.csv_url}>
                      {isRendering ? 'Rendering…' : 'Render Video (MP4)'}
                    </button>
                  </div>
                </div>
              )}
              {result.csv_url && (
                <div>
                  <a className="btn" href={result.csv_url} target="_blank">Download CSV</a>
                </div>
              )}
            </div>
          )}

          {/* Previous projects grid */}
          <ProjectsGrid token={session?.access_token} />
        </div>

        {/* Upload and YouTube are now integrated above via the Source dropdown */}
      </main>
    </>
  );
}

function YouTubeDownloader({ onDone }: { onDone?: (url: string) => void }) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ url: string; key?: string; title?: string } | null>(null)

  async function onDownload() {
    try {
      setLoading(true)
      setError(null)
      setResult(null)
      const r = await fetch('/api/download_youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_url: url.trim() })
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || j?.details || 'Failed')
      if (!j?.url) throw new Error('Unexpected response')
      setResult(j)
    } catch (e: any) {
      setError(e?.message || 'Failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-white/60">YouTube link</span>
        <input type="url" className="w-full rounded-xl bg-white/5 ring-1 ring-white/10 p-3" placeholder="https://www.youtube.com/watch?v=..." value={url} onChange={(e)=>setUrl(e.target.value)} />
      </label>
      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={onDownload} disabled={loading || !url.trim()}>
          {loading ? 'Downloading…' : 'Download'}
        </button>
        {error && <span className="text-xs text-rose-300">{error}</span>}
      </div>
      {result?.url && (
        <div className="space-y-2 text-sm">
          <div className="text-white/70">Uploaded to:</div>
          <div className="flex items-center gap-2 flex-wrap">
            <a className="btn" href={result.url} target="_blank" rel="noreferrer">Open file</a>
            {onDone && (
              <button className="btn" onClick={() => onDone(result.url!)}>Use in Autoclipper</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Autoclipper({ initialUrl }: { initialUrl?: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState<string>('')
  const [uploadedUrl, setUploadedUrl] = useState<string>('')
  const [language, setLanguage] = useState('en')
  const [autoRender, setAutoRender] = useState(false)
  const [isWorking, setIsWorking] = useState(false)
  const [segments, setSegments] = useState<Array<{ start_ms: number; end_ms: number }>>([])
  const [clips, setClips] = useState<Array<{ url: string; start_ms: number; end_ms: number; title?: string | null }>>([])
  const [error, setError] = useState<string | null>(null)

  // Prefill uploadedUrl from YouTube downloader handoff
  useEffect(() => {
    if (initialUrl && !uploadedUrl) setUploadedUrl(initialUrl)
  }, [initialUrl, uploadedUrl])

  async function uploadToBlob(f: File): Promise<string> {
    setStatus('Uploading to Blob...')
    const r = await fetch('/api/blob/upload', {
      method: 'POST',
      headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': f.name || 'upload.mp4' },
      body: f,
    })
    const j = await r.json()
    if (!r.ok) throw new Error(j?.error || 'Blob upload failed')
    return String(j.url)
  }

  async function onSuggest() {
    setError(null)
    setSegments([])
    setClips([])
    try {
      if (!file) throw new Error('Select a video file first')
      setIsWorking(true)
      const url = uploadedUrl || await uploadToBlob(file)
      setUploadedUrl(url)
      setStatus('Analyzing...')
      const r = await fetch('/api/presets/autoclip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_type: 'upload', source_url: url, language, auto_render: autoRender }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'Suggest highlights failed')
      setSegments(Array.isArray(j?.segments) ? j.segments : [])
      setClips(Array.isArray(j?.clips) ? j.clips : [])
      setStatus('Done')
    } catch (e: any) {
      setError(e?.message || 'Failed')
    } finally {
      setIsWorking(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3 items-end">
        <label className="sm:col-span-2">
          <div className="text-xs text-white/60 mb-1">Choose video file (mp4/mov/webm)</div>
          <input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(e)=>{ setFile(e.target.files?.[0] || null); setUploadedUrl(''); setProgress(0); setStatus('') }} />
          {uploadedUrl && (
            <div className="mt-2 text-xs text-white/70">
              Using uploaded URL: <a className="underline" href={uploadedUrl} target="_blank" rel="noreferrer">open</a>
            </div>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-white/60">Transcript language</span>
          <select className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" value={language} onChange={(e)=>setLanguage(e.target.value)}>
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="pt">Portuguese</option>
            <option value="ru">Russian</option>
            <option value="hi">Hindi</option>
            <option value="ja">Japanese</option>
            <option value="ko">Korean</option>
            <option value="zh">Chinese (Simplified)</option>
            <option value="zh-TW">Chinese (Traditional)</option>
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoRender} onChange={(e)=>setAutoRender(e.target.checked)} />
          Auto-render top 3 clips
        </label>
        <button className="btn-primary" onClick={onSuggest} disabled={isWorking || !file}>
          {isWorking ? 'Working…' : 'Suggest Highlights'}
        </button>
      </div>

      {(progress > 0 || status) && (
        <div className="text-xs text-white/60">{status} {progress ? `(${progress}%)` : ''}</div>
      )}

      {error && <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</div>}

      {segments.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold">Suggested segments</div>
          <ol className="text-xs text-white/70 list-decimal pl-5 space-y-1">
            {segments.map((s, i)=> (
              <li key={i}>Start {Math.round(s.start_ms/1000)}s – End {Math.round(s.end_ms/1000)}s ({Math.round((s.end_ms - s.start_ms)/1000)}s)</li>
            ))}
          </ol>
        </div>
      )}

      {clips.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold">Rendered clips</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {clips.map((c, i)=> (
              <a key={i} className="btn" href={c.url} target="_blank">Download clip {i+1}</a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}


function ProjectsGrid({ token }: { token?: string }) {
  const [items, setItems] = useState<Array<{ id: string; title: string; mp3_url: string; csv_url: string; thumb_url: string | null; updated_at: string | null }>>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!token) return;
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch('/api/projects', { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Failed to load projects');
        if (!cancelled) setItems(Array.isArray(data.projects) ? data.projects : []);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'Failed to load projects');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token]);

  if (!token) return null;

  return (
    <div className="pt-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Your Projects</h2>
        {loading && <span className="text-xs text-white/60">Loading…</span>}
        {err && <span className="text-xs text-rose-300">{err}</span>}
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-white/60">No projects yet. Generate one above.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <div key={p.id} className="rounded-xl ring-1 ring-white/10 p-3 bg-white/5 space-y-2">
              <div className="aspect-video w-full overflow-hidden rounded-md ring-1 ring-white/10 bg-white/5">
                {p.thumb_url ? (
                  <img src={p.thumb_url} alt="thumbnail" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full grid place-items-center text-xs text-white/50">No thumbnail</div>
                )}
              </div>
              <div className="text-sm font-semibold truncate" title={p.title}>{p.title}</div>
              <div className="text-[11px] text-white/60">{p.updated_at ? new Date(p.updated_at).toLocaleString() : ''}</div>
              <div className="flex gap-2 pt-1">
                <a className="btn" href={p.mp3_url} target="_blank">MP3</a>
                <a className="btn" href={p.csv_url} target="_blank">CSV</a>
                <button
                  className="btn-primary"
                  onClick={async () => {
                    try {
                      let bg_urls: string[] | undefined;
                      try {
                        const kw = String(p.title || '').split(/\s+/).slice(0,8).filter(Boolean);
                        if (kw.length) {
                          const r = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: p.title, keywords: kw, type: 'video', orientation: 'portrait', max: 8 }) });
                          if (r.ok) {
                            const data = await r.json();
                            bg_urls = (Array.isArray(data?.videos) ? data.videos.map((v: any) => v?.url).filter(Boolean) : []).slice(0,4);
                          }
                        }
                      } catch {}

                      const res = await fetch('/api/render', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mp3_url: p.mp3_url, csv_url: p.csv_url, ...(bg_urls && bg_urls.length ? { bg_urls } : {}), preset: 'tiktok_v1', title: p.title || 'Clip' }),
                      });
                      if (!res.ok) {
                        const txt = await res.text().catch(() => '');
                        throw new Error(`Render failed: ${txt || res.status}`);
                      }
                      const blob = await res.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `clip-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    } catch (e: any) {
                      alert(e?.message || 'Render failed');
                    }
                  }}
                >
                  Render MP4
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

