'use client';

import { useEffect, useState } from 'react';
import Nav from '@/components/Nav';
import { getSupabaseClient } from '@/lib/supabaseClient';
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
  const [autoAiBg, setAutoAiBg] = useState(true);
  const [projectsRefresh, setProjectsRefresh] = useState(0);
  // Presets: Autoclipper state
  const [ytUrl, setYtUrl] = useState('');
  const [autoNumClips, setAutoNumClips] = useState(3);
  const [autoClipSec, setAutoClipSec] = useState(30);
  const [autoLang, setAutoLang] = useState('en');
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoErr, setAutoErr] = useState<string | null>(null);
  const [autoSegments, setAutoSegments] = useState<Array<{ start: number; end: number; text: string }>>([]);
  const [musicUrl, setMusicUrl] = useState('');
  const [useTikTokPreset, setUseTikTokPreset] = useState(true);
  const [logoUrl, setLogoUrl] = useState('');
  const [bgUrlManual, setBgUrlManual] = useState('');
  // Unified mode/preset selector
  const [view, setView] = useState<'Paste' | 'Autoclipper'>('Paste');
  // Debug: which API base is being used
  const [apiBase, setApiBase] = useState('')
  useEffect(() => {
    try {
      const defaultOrigin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : ''
      const base = (process.env.NEXT_PUBLIC_API_ORIGIN || defaultOrigin).replace(/\/$/, '')
      setApiBase(base)
    } catch {}
  }, [])

  useEffect(() => {
    const supabase = getSupabaseClient();
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
      const body: any = { mode, language, tone, topic, email, title: title.trim(), project_id: `lab-${Date.now()}`, auto_ai_bg: autoAiBg };
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
      const data: GenerateResult & { bg_image_url?: string } = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setResult(data);
      if (data?.bg_image_url) { setBgUrlManual(data.bg_image_url) }
      // Trigger Projects list refresh so the new project appears immediately
      setProjectsRefresh((v) => v + 1);

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

const res = await fetch('/api/worker/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mp3_url: result.mp3_url, csv_url: result.csv_url, ...(bgUrlManual.trim() ? { bg_url: bgUrlManual.trim() } : {}), ...(musicUrl.trim() ? { music_url: musicUrl.trim() } : {}), preset: useTikTokPreset ? 'tiktok_v1' : undefined, title, ...(logoUrl.trim() ? { logo_url: logoUrl.trim() } : {}) }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Render failed: ${txt || res.status}`);
      }
      const ctype = res.headers.get('content-type') || ''
      if (ctype.includes('application/json')) {
        const data = await res.json().catch(() => ({}))
        const url = data?.url
        if (url) {
          window.location.href = url
          return
        }
        throw new Error(`Unexpected JSON from renderer: ${JSON.stringify(data)}`)
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

  const disabled = isLoading || !title.trim() || (view !== 'Autoclipper' && !source.trim());

  async function runAutoclipper() {
    if (!session?.access_token) return;
    setAutoBusy(true);
    setAutoErr(null);
    setAutoSegments([]);
    try {
      const defaultOrigin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : ''
      const base = (process.env.NEXT_PUBLIC_API_ORIGIN || apiBase || defaultOrigin).replace(/\/$/, '')
      const endpoint = `${base}/api/presets/autoclip?ts=${Date.now()}&src=lab`
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ youtube_url: ytUrl.trim(), max_clips: autoNumClips, target_seconds: autoClipSec, language: autoLang }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Autoclip failed');
      setAutoSegments(Array.isArray(data?.segments) ? data.segments : []);
    } catch (e: any) {
      setAutoErr(e?.message || 'Autoclip failed');
    } finally {
      setAutoBusy(false);
    }
  }

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
          {/* Mode selector dropdown (left) */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/60">Mode</span>
              <select
                className="rounded-md bg-white/5 ring-1 ring-white/10 p-1 text-sm"
                value={view}
                onChange={(e) => {
                  const v = e.target.value as 'Paste' | 'Autoclipper'
                  setView(v)
                  if (v === 'Paste') setMode(v)
                }}
              >
                <option value="Paste">Paste</option>
                <option value="Autoclipper">Autoclipper (YouTube)</option>
              </select>
            </div>
          </div>

          {/* Title (hide for Autoclipper) */}
          {view !== 'Autoclipper' && (
            <div>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-white/60">Project title (required)</span>
                <input className="w-full rounded-xl bg-white/5 ring-1 ring-white/10 p-3" placeholder="e.g., AI breakthroughs explainer" value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
            </div>
          )}

          {/* Source input (shown for Paste) */}
          <div>
            {view === 'Paste' && (
              <textarea className="w-full h-36 rounded-xl bg-white/5 ring-1 ring-white/10 p-3" placeholder="Paste source text here…" value={source} onChange={(e) => setSource(e.target.value)} />
            )}
          </div>

          {/* Options (hide for Autoclipper) */}
          {view !== 'Autoclipper' && (
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
          )}

          {/* Style preset, b‑roll and music (hide most when Autoclipper) */}
          <div className="grid gap-3 sm:grid-cols-3">
            {view !== 'Autoclipper' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={useTikTokPreset} onChange={e => setUseTikTokPreset(e.target.checked)} />
                TikTok style preset
              </label>
            )}
            {view !== 'Autoclipper' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoAiBg} onChange={e => setAutoAiBg(e.target.checked)} />
                Auto AI background image
              </label>
            )}
            {view !== 'Autoclipper' && (
              <label className="flex flex-col gap-1 sm:col-span-1">
                <span className="text-xs text-white/60">Background music URL (optional)</span>
                <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" placeholder="https://.../music.mp3" value={musicUrl} onChange={e => setMusicUrl(e.target.value)} />
              </label>
            )}
            {view !== 'Autoclipper' && (
              <label className="flex flex-col gap-1 sm:col-span-1">
                <span className="text-xs text-white/60">Watermark logo URL (optional, PNG/SVG)</span>
                <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" placeholder="https://.../logo.png" value={logoUrl} onChange={e => setLogoUrl(e.target.value)} />
              </label>
            )}
            {view !== 'Autoclipper' && (
              <label className="flex flex-col gap-1 sm:col-span-3">
                <span className="text-xs text-white/60">Background video URL (optional, overrides auto b‑roll)</span>
                <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" placeholder="https://.../background.mp4" value={bgUrlManual} onChange={e => setBgUrlManual(e.target.value)} />
              </label>
            )}
          </div>

          {/* Generate (hide for Autoclipper) */}
          {view !== 'Autoclipper' && (
            <div className="mt-2 flex items-center gap-3">
              <button onClick={handleGenerate} disabled={disabled} className={`btn-primary ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
                {isLoading ? 'Generating…' : 'Generate'}
              </button>
              <span id="credits-inline" className="text-xs text-white/60 ring-1 ring-white/10 rounded-full px-2 py-0.5" />
              {isLoading && <span className="text-xs text-white/60">This can take ~10–20s…</span>}
            </div>
          )}

          {/* Preset configuration below; only show when Autoclipper is chosen */}
          {view === 'Autoclipper' && (
            <div className="mt-8 space-y-4 rounded-2xl bg-white/5 ring-1 ring-white/10 p-4">
              <div className="space-y-3">
                <div className="text-sm font-semibold">Autoclipper (YouTube)</div>
                <p className="text-xs text-white/60">Pick the best {autoNumClips}× ~{autoClipSec}s highlights from a long video. Paste a YouTube URL, we’ll fetch the transcript and suggest timestamps.</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="flex flex-col gap-1 sm:col-span-2">
                    <span className="text-xs text-white/60">YouTube URL</span>
                    <input className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" placeholder="https://www.youtube.com/watch?v=..." value={ytUrl} onChange={e=>setYtUrl(e.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-white/60">Clips</span>
                    <input type="number" min={1} max={10} className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" value={autoNumClips} onChange={e=>setAutoNumClips(parseInt(e.target.value || '3',10))} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-white/60">Seconds per clip</span>
                    <input type="number" min={8} max={90} className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" value={autoClipSec} onChange={e=>setAutoClipSec(parseInt(e.target.value || '30',10))} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-white/60">Language</span>
                    <select className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" value={autoLang} onChange={e=>setAutoLang(e.target.value)}>
                      <option value="en">English (en)</option>
                      <option value="es">Spanish (es)</option>
                      <option value="fr">French (fr)</option>
                      <option value="de">German (de)</option>
                      <option value="pt">Portuguese (pt)</option>
                      <option value="ru">Russian (ru)</option>
                      <option value="hi">Hindi (hi)</option>
                      <option value="ja">Japanese (ja)</option>
                      <option value="ko">Korean (ko)</option>
                      <option value="zh-Hans">Chinese Simplified (zh-Hans)</option>
                      <option value="zh-Hant">Chinese Traditional (zh-Hant)</option>
                    </select>
                  </label>
                </div>
                <div className="flex gap-3 items-center">
                  <button onClick={runAutoclipper} disabled={autoBusy || !ytUrl.trim()} className={`btn-primary ${autoBusy || !ytUrl.trim() ? 'opacity-60 cursor-not-allowed' : ''}`}>{autoBusy ? 'Analyzing…' : 'Suggest Highlights'}</button>
                  {autoErr && <span className="text-xs text-rose-300">{autoErr}</span>}
                </div>
                <div className="text-[10px] text-white/40">API endpoint: {apiBase ? `${apiBase}/api/presets/autoclip` : '/api/presets/autoclip'}</div>
                {autoSegments.length>0 && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-white/60">Suggested segments</div>
                    <ul className="text-sm list-disc pl-5 space-y-1">
                      {autoSegments.map((s,i)=> (
                        <li key={i}><span className="font-mono">{msToHMS(s.start)} → {msToHMS(s.end)}</span> – {s.text?.slice(0,100)}</li>
                      ))}
                    </ul>
                    <div className="text-xs text-white/50">Note: Rendering of these clips into MP4s can be wired next. For now, use the timestamps to guide manual clipping or let me know to auto-render via the worker.</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Veo3 (feature-gated) */}
          {process.env.NEXT_PUBLIC_ENABLE_VEO3 === '1' && (
            <div className="mt-8 space-y-3 rounded-2xl bg-white/5 ring-1 ring-white/10 p-4">
              <div className="text-sm font-semibold">AI Video (Veo3)</div>
              <p className="text-xs text-white/60">Generate an AI video from a text prompt. Configure provider env vars to enable.</p>
              <Veo3Form token={session?.access_token} />
            </div>
          )}

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
          <ProjectsGrid token={session?.access_token} refresh={projectsRefresh} />
        </div>
      </main>
    </>
  );
}

function msToHMS(ms: number){
  ms = Math.max(0, Math.floor(ms));
  const h = Math.floor(ms/3600000);
  const m = Math.floor((ms%3600000)/60000);
  const s = Math.floor((ms%60000)/1000);
  const pad = (n: number, w: number=2)=> String(n).padStart(w,'0');
  return `${pad(h,1)}:${pad(m)}:${pad(s)}`
}

function Veo3Form({ token }: { token?: string }) {
  const [prompt, setPrompt] = useState('A cinematic drone shot over neon city at night')
  const [duration, setDuration] = useState(6)
  const [ar, setAr] = useState<'9:16' | '1:1' | '16:9'>('9:16')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onGenerate() {
    setLoading(true); setErr(null)
    try {
      const res = await fetch('/api/video/veo3', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ prompt, duration, aspect_ratio: ar }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Failed to start Veo3 job')
      if (data?.video_url) {
        const a = document.createElement('a')
        a.href = data.video_url
        a.download = `veo3-${Date.now()}.mp4`
        document.body.appendChild(a)
        a.click()
        a.remove()
      } else {
        alert(data?.message || 'Veo3 job accepted. Check back soon.')
      }
    } catch (e: any) {
      setErr(e?.message || 'Failed to generate video')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-white/60">Prompt</span>
        <textarea className="w-full h-24 rounded-xl bg-white/5 ring-1 ring-white/10 p-3" value={prompt} onChange={e => setPrompt(e.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-white/60">Duration (sec)</span>
          <input type="number" min={2} max={10} className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" value={duration} onChange={e => setDuration(parseInt(e.target.value || '6', 10))} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-white/60">Aspect ratio</span>
          <select className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2" value={ar} onChange={e => setAr(e.target.value as any)}>
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
          </select>
        </label>
      </div>
      {err && <div className="text-xs text-rose-300">{err}</div>}
      <button onClick={onGenerate} disabled={loading} className={`btn-primary ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}>
        {loading ? 'Generating…' : 'Generate with Veo3'}
      </button>
    </div>
  )
}

function ProjectsGrid({ token, refresh }: { token?: string, refresh?: number }) {
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
  }, [token, refresh]);

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
const res = await fetch('/api/worker/proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mp3_url: p.mp3_url, csv_url: p.csv_url, preset: 'tiktok_v1', title: p.title || 'Clip' }),
                      });
                      if (!res.ok) {
                        const txt = await res.text().catch(() => '');
                        throw new Error(`Render failed: ${txt || res.status}`);
                      }
                      const ctype = res.headers.get('content-type') || ''
                      if (ctype.includes('application/json')){
                        const data = await res.json().catch(() => ({}))
                        if (data?.url){
                          window.location.href = data.url
                          return
                        }
                        throw new Error(`Unexpected JSON from renderer: ${JSON.stringify(data)}`)
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

