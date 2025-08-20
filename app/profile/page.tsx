'use client';
import { useEffect, useState } from 'react';
import Nav from '@/components/Nav';
import { supabase } from '@/lib/supabaseClient';

export default function ProfilePage() {
  const [session, setSession] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function loadSub() {
      try {
        const res = await fetch('/api/billing/subscription', { headers: { Authorization: `Bearer ${session.access_token}` } });
        const data = await res.json();
        const el = document.getElementById('next-billing');
        if (!el) return;
        if (!res.ok || data.error || data.status === 'none') {
          el.textContent = '';
          return;
        }
        if (data.current_period_end) {
          const d = new Date(data.current_period_end);
          el.textContent = `Next billing date: ${d.toLocaleDateString()}`;
        }
      } catch {}
    }
    loadSub();

    function onVis(){ if (document.visibilityState === 'visible') loadSub(); }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [session?.access_token]);

  if (!session) {
    return (
      <>
        <Nav />
        <main className="container py-16">
          <div className="card p-6">Please sign in to view your profile.</div>
        </main>
      </>
    );
  }

  const plan = String(session.user.user_metadata?.plan || 'Free');


  async function openBillingPortal() {
    const res = await fetch('/api/billing/portal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'x-return-url': typeof window !== 'undefined' ? window.location.origin + '/profile' : '',
      },
    });
    const data = await res.json();
    if (!res.ok || !data.url) {
      alert(data.error || 'Could not open billing portal.');
      return;
    }
    window.location.href = data.url;
  }

  return (
    <>
      <Nav />
      <main className="container py-16 space-y-6">
        <h1 className="text-3xl font-bold">Your Profile</h1>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="card p-6">
            <div className="text-white/60 text-sm">Email</div>
            <div className="font-medium mt-1">{session.user.email}</div>
          </div>
          <div className="card p-6">
    <div className="text-white/60 text-sm">Plan</div>
    <div className="font-medium mt-1">{plan}</div>
    <div className="mt-2 text-xs text-white/60" id="next-billing"></div>
    <div className="mt-4 flex gap-2">
      <button onClick={openBillingPortal} className="btn">Manage billing</button>
      <button onClick={openBillingPortal} className="btn">Cancel subscription</button>
    </div>
  </div>
          <div className="card p-6">
            <div className="text-white/60 text-sm">Projects</div>
            <div className="font-medium mt-1">—</div>
          </div>
        </div>
      </main>
    </>
  );
}
