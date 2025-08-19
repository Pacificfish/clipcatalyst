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
            <div className="font-medium mt-1">Free</div>
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
