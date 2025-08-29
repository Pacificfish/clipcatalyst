'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

export default function Nav() {
  const [session, setSession] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const email = session?.user?.email ?? '';
  const token = session?.access_token || '';

  useEffect(() => {
    const supabase = getSupabaseClient();
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent){
      if (!menuRef.current) return;
      if (menuRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent){ if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey) }
  }, []);

  async function login() {
    const e = prompt('Enter your email for a magic link:');
    if (!e) return;
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.signInWithOtp({ email: e });
    if (error) alert(error.message);
    else alert('Check your email for the magic link.');
  }

  async function loginWithGoogle() {
    const supabase = getSupabaseClient();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/profile` : undefined,
      },
    });
  }

  async function openBillingPortal() {
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ''}`,
          'x-return-url': typeof window !== 'undefined' ? `${window.location.origin}/profile` : '',
        },
      });
      const data = await res.json();
      if (!res.ok || !data?.url) throw new Error(data?.error || 'Could not open billing portal');
      window.location.href = data.url;
    } catch (e: any) {
      alert(e?.message || 'Could not open billing portal.');
    }
  }

  async function logout() { const supabase = getSupabaseClient(); await supabase.auth.signOut(); setOpen(false); }

  function toggleTheme(){
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next)
    }
    try { localStorage.setItem('theme', next) } catch {}
  }

  const initial = email ? email.charAt(0).toUpperCase() : '';

  async function openBilling(){
    try {
      if (!token) return alert('Please sign in');
      const r = await fetch('/api/billing/portal', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-return-url': typeof window!== 'undefined' ? `${window.location.origin}/profile` : '' } })
      const j = await r.json()
      if (!r.ok || !j?.url) throw new Error(j?.error || 'Failed to open billing portal')
      window.location.assign(j.url)
    } catch (e: any) {
      alert(e?.message || 'Failed to open billing portal')
    }
  }

  const initials = (email || 'U').slice(0,1).toUpperCase();

  return (
    <header className="header-frost">
      <div className="container py-3 flex items-center gap-4">
        <Link href="/" className="font-semibold">ClipCatalyst</Link>
        <nav className="ml-auto flex items-center gap-2">
          <Link href="/lab" className="btn">Lab</Link>
          {!session ? (
            <div className="flex items-center gap-2">
              <button onClick={loginWithGoogle} className="btn">Sign in with Google</button>
              <button onClick={login} className="btn">Email link</button>
            </div>
          ) : (
            <div className="relative" ref={menuRef}>
              <button
                className="inline-flex items-center gap-2 rounded-xl px-3 py-1.5 ring-1 ring-white/10 bg-white/5 hover:bg-white/10 transition"
                onClick={() => setOpen((v)=>!v)}
                aria-haspopup="menu"
                aria-expanded={open}
              >
                <span className="grid place-items-center h-7 w-7 rounded-full bg-[var(--brand)] text-black text-xs font-bold">{initials}</span>
                <span className="hidden md:inline text-xs text-white/80">{email || 'Account'}</span>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={`transition ${open ? 'rotate-180' : ''}`}><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {open && (
                <div role="menu" className="absolute right-0 mt-2 w-48 rounded-xl bg-white/5 ring-1 ring-white/10 shadow-xl p-1">
                  <Link role="menuitem" href="/profile" className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/10 text-sm">
                    <span>Profile</span>
                  </Link>
                  <button role="menuitem" className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/10 text-sm" onClick={openBilling}>
                    <span>Billing</span>
                  </button>
                  <button role="menuitem" className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/10 text-sm" onClick={logout}>
                    <span>Sign out</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </nav>
      </div>
    </header>
  );
}
