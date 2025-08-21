'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

export default function Nav() {
  const [session, setSession] = useState<any>(null);
  const email = session?.user?.email ?? '';

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function login() {
    const e = prompt('Enter your email for a magic link:');
    if (!e) return;
    const { error } = await supabase.auth.signInWithOtp({ email: e });
    if (error) alert(error.message);
    else alert('Check your email for the magic link.');
  }

  async function loginWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/profile` : undefined,
      },
    });
  }

  async function logout() { await supabase.auth.signOut(); }

  return (
<header className="header-frost">
      <div className="container py-3 flex items-center gap-4">
        <Link href="/" className="font-semibold">ClipCatalyst</Link>
        <nav className="ml-auto flex items-center gap-2">
          <Link href="/lab" className="btn">Lab</Link>
          <Link href="/profile" className="btn">Profile</Link>
          {!session ? (
            <div className="flex items-center gap-2">
              <button onClick={loginWithGoogle} className="btn">Sign in with Google</button>
              <button onClick={login} className="btn">Email link</button>
            </div>
          ) : (
            <button onClick={logout} className="btn">Sign out</button>
          )}
        </nav>
      </div>
      {email && <div className="text-xs text-white/60 container pb-2">Signed in as {email}</div>}
    </header>
  );
}
