'use client';

import { useEffect, useState } from 'react';
import Nav from '@/components/Nav';
import { supabase } from '@/lib/supabaseClient';

type GenerateResult = {
  mp3_url?: string;
  csv_url?: string;
  project_id?: string;
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
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data: GenerateResult = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setResult(data);
    } catch (e: any) {
      setError(e?.message || 'Something went wrong.');
    } finally {
      setIsLoading(false);
    }
  }

  const disabled = isLoading || !source.trim();

  return (
    <>
      <Nav />
      <main className="container py-16 space-y-8">
        <header className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Lab</h1>
          <div className="text-xs text-white/60">Signed in as {email}</div>
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
