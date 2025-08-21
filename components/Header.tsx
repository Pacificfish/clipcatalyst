// components/Header.tsx
'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export default function Header(){
  const [session, setSession] = useState<any>(null)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const email = session?.user?.email ?? ''
  const plan = String(session?.user?.user_metadata?.plan || 'Free')
  const isPaid = plan.toLowerCase() !== 'free'

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    function onDocClick(e: MouseEvent){
      if(!menuRef.current) return
      if(open && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent){ if(e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function login(){
    const e = prompt('Enter your email for a magic link:')
    if(!e) return
    const { error } = await supabase.auth.signInWithOtp({ email: e })
    if(error) alert(error.message); else alert('Check your email for the magic link.')
  }

  async function loginWithGoogle(){
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/profile` : undefined },
    })
  }

  async function openBillingPortal(){
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ''}`,
          'x-return-url': typeof window !== 'undefined' ? `${window.location.origin}/profile` : '',
        },
      })
      const data = await res.json()
      if(!res.ok || !data?.url) throw new Error(data?.error || 'Could not open billing portal')
      window.location.href = data.url
    } catch(e:any){
      alert(e?.message || 'Could not open billing portal.')
    }
  }

  async function logout(){ await supabase.auth.signOut(); setOpen(false) }
  const initial = email ? email.charAt(0).toUpperCase() : ''

  return (
    <header className="sticky top-0 z-50 backdrop-blur supports-[backdrop-filter]:bg-black/40">
      <div className="container flex items-center justify-between h-16">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-[var(--brand)]"></div>
          <span className="font-semibold">ClipCatalyst</span>
        </Link>
        <nav className="hidden md:flex items-center gap-6 text-sm text-[var(--muted)]">
          <Link href="/#features">Features</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/lab" className="text-white">Lab</Link>
        </nav>
        {!session ? (
          <div className="flex items-center gap-3">
            <button onClick={loginWithGoogle} className="btn">Sign in</button>
            <Link href="/lab" className="btn-primary">Get Started</Link>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Link href="/lab" className="btn">Lab</Link>
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setOpen(v => !v)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15 text-white/90 hover:bg-white/20 backdrop-blur-md"
                aria-label="Open profile menu"
                aria-expanded={open}
              >
                <span className="text-sm font-medium">{initial || '•'}</span>
              </button>
                {open && (
                <div className="absolute right-0 mt-2 w-56 rounded-2xl bg-[rgba(10,15,31,0.9)] text-white ring-1 ring-white/10 backdrop-blur-md shadow-xl p-1">
                  <div className="px-3 py-2 text-xs text-white/70">Signed in as {email}</div>
                  <Link href="/profile" className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-white/10">Profile</Link>
                  <Link href="/pricing" className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-white/10">Pricing</Link>
                  {isPaid && (
                    <button onClick={openBillingPortal} className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-white/10">Manage billing</button>
                  )}
                  <div className="h-px my-1 bg-white/10" />
                  <button onClick={logout} className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-white/10">Sign out</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="h-px w-full bg-gradient-to-r from-transparent via-white/15 to-transparent" />
    </header>
  )
}
