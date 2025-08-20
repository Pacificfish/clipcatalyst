'use client';

import { useEffect, useState } from 'react';
import Nav from '@/components/Nav';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';

type GenerateResult = {
  mp3_url?: string;
  csv_url?: string;
  project_id?: string;
  error?: string;
  details?: string;
};

export default function LabPage() {
  const [session, setSession] = useStatecanye(null);
  const [mode, setMode] = useStatec'Paste' | 'URL'e('Paste');
  const [source, setSource] = useState('');
  const [language, setLanguage] = useState('English');
  const [tone, setTone] = useState('Informative');
  const [topic, setTopic] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useStatecstring | nulle(null);
  const [result, setResult] = useStatecGenerateResult | nulle(null);

  // utils
  function isValidUrl(u: string) {
    try { new URL(u); return true } catch { return false }
  }
  function debounce<T extends (...args: any[]) => void>(fn: T, ms = 250) {
    let t: any; return (...args: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
  }

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
        const res = await fetch('/api/usage', { headers: { Authorization: `Bearer ${session.access_token}` } });
        const data = await res.json();
        const el = document.getElementById('credits-indicator') as HTMLElement | null;
        const inline = document.getElementById('credits-inline') as HTMLElement | null;
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
      } catch {
        // ignore
      }
    }
    loadUsage();

    // Auto-refresh when user returns to tab (e.g., after Stripe portal)
    const onVis = debounce(() => { if (document.visibilityState === 'visible') loadUsage() }, 150);
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

  const plan = String(session?.user?.user_metadata?.plan || '').toLowerCase();
  const hasSubscription = ['beginner', 'pro', 'agency'].includes(plan);
  if (!hasSubscription) {
    return (
      <>
        <Nav />
        <main className="container py-16">
          <div className="card p-6 space-y-3">
            <div className="font-semibold">Subscription required</div>
            <p className="text-white/70 text-sm">Your account does not have an active plan. Choose a plan to unlock the Lab.</p>
            <div>
              <Link className="btn-primary" href="/pricing">View pricing</Link>
            </div>
          </div>
        </main>
      </>
    );
  }

  const email = session?.user?.email || 'anon@example.com';

  async function handleGenerate() {
    setIsLoading(true);
    setError(null);
    setResult(null);
    try {
      const body: any = {
        mode,
        language,
        tone,
        topic,
        email,
        project_id: `lab-${Date.now()}`,
      };
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
      // Refresh usage indicator after successful generation
      try {
        
        const res2 = await fetch('/api/usage', { headers: { Authorization: `Bearer ${session.access_token}` } });
        const data2 = await res2.json();
        const el = document.getElementById('credits-indicator') as HTMLElement | null;
        const inline = document.getElementById('credits-inline') as HTMLElement | null;
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

  const disabled = isLoading || (mode === 'Paste' ? !source.trim() : !isValidUrl(source.trim()));

  return (
    <>
      <Nav />
      <main className="container py-16 space-y-8">
        <header className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Lab</h1>
          <div className="flex items-center gap-3">
            <span id="credits-indicator" className="text-xs text-white/60"></span>
            <button
              onClick={async () => {
                try {
                  const res = await fetch('/api/usage', { headers: { Authorization: `Bearer ${session.access_token}` } });
                  const data = await res.json();
          const el = document.getElementById('credits-indicator') as HTMLElement | null;
          const inline = document.getElementById('credits-inline') as HTMLElement | null;
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
            >Refresh</button>
            <div className="text-xs text-white/60">Signed in as {email}</div>
          </div>
        </header>

        <div className="card p-6 space-y-4">
          {/* Mode selector */}
          <div className="flex gap-2">
            <button
              className={`btn ${mode === 'Paste' ? '!bg-white/15' : ''}`}
              onClick={() => setMode('Paste')}
            >
              Paste
            </button>
            <button
              className={`btn ${mode === 'URL' ? '!bg-white/15' : ''}`}
              onClick={() => setMode('URL')}
            >
              URL
            </button>
          </div>

          {/* Source input */}
          <div>
            {mode === 'Paste' ? (
              <textarea
                className="w-full h-36 rounded-xl bg-white/5 ring-1 ring-white/10 p-3"
                placeholder="Paste source text here…"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            ) : (
              <input
                type="url"
                className="w-full rounded-xl bg-white/5 ring-1 ring-white/10 p-3"
                placeholder="https://example.com/article"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            )}
          </div>

          {/* Options */}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/60">Language</span>
              <input
                className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="English"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/60">Tone</span>
              <input
                className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                placeholder="Informative"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-white/60">Topic (optional)</span>
              <input
                className="rounded-xl bg-white/5 ring-1 ring-white/10 p-2"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g., AI breakthroughs"
              />
            </label>
          </div>

          {/* Generate */}
            <div className="mt-2 flex items-center gap-3">
            <button
              onClick={handleGenerate}
              disabled={disabled}
              className={`btn-primary ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
              {isLoading ? 'Generating…' : 'Generate'}
            </button>
            <span id="credits-inline" className="text-xs text-white/60 ring-1 ring-white/10 rounded-full px-2 py-0.5"></span>
            {isLoading && <span className="text-xs text-white/60">This can take ~10–20s…</span>}
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 p-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="pt-4 space-y-3">
              {result.mp3_url && (
                <div className="space-y-2">
                  <audio controls src={result.mp3_url} className="w-full" />
                  <a className="btn" href={result.mp3_url} target="_blank">Download MP3</a>
                </div>
              )}
              {result.csv_url && (
                <div>
                  <a className="btn" href={result.csv_url} target="_blank">Download CSV</a>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
