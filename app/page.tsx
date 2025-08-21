'use client'

import Header from '@/components/Header'
import Footer from '@/components/Footer'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function Home() {
  const router = useRouter()
  const [trialUsed, setTrialUsed] = useState(false)

  useEffect(() => {
    try {
      setTrialUsed(localStorage.getItem('trial_used') === '1')
    } catch {}
  }, [])

  function handleTryFree() {
    try {
      localStorage.setItem('trial_used', '1')
    } catch {}
    router.push('/lab')
  }

  return (
    <>
      <Header />
      <main className="container py-16 space-y-20">
        <section className="grid lg:grid-cols-2 gap-10 items-center">
          <div className="space-y-6">
            <h1 className="text-5xl font-extrabold leading-tight gradient-text">
              Create viral shorts faster than ever
            </h1>
            <p className="text-white/80 text-lg">
              For creators who care about quality. Generate scripts, voiceovers, bold captions and TikTok‑ready edits in minutes—not hours.
            </p>
            <ul className="grid sm:grid-cols-2 gap-3 text-sm text-white/80">
              <li className="badge">Studio‑grade captions</li>
              <li className="badge">Smart b‑roll & background</li>
              <li className="badge">Fast render pipeline</li>
              <li className="badge">Project history & presets</li>
            </ul>
            <div className="flex items-center gap-3">
              <button onClick={handleTryFree} disabled={trialUsed} className={`btn-primary ${trialUsed ? 'opacity-60 cursor-not-allowed' : ''}`}>
                {trialUsed ? 'Trial used' : 'Try it free'}
              </button>
              <Link href="/pricing" className="btn">See pricing</Link>
            </div>
            <div className="text-xs text-white/60">No credit card required. Free credits included.</div>
          </div>
          <div className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-4 backdrop-blur-md">
            <div className="aspect-[9/16] w-full rounded-xl bg-gradient-to-b from-white/10 to-transparent ring-1 ring-white/10 grid place-items-center text-white/70">
              Live preview coming soon
            </div>
          </div>
        </section>

        <section id="features" className="space-y-8">
          <header className="space-y-2">
            <h2 className="text-2xl font-bold">Why creators choose ClipCatalyst</h2>
            <p className="text-white/70">Better quality than competitors with a workflow built for speed and control.</p>
          </header>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="card p-6 space-y-2">
              <div className="text-lg font-semibold">Studio captions</div>
              <p className="text-sm text-white/70">Bold, dynamic captions tuned for retention with smart line breaks and emphasis.</p>
            </div>
            <div className="card p-6 space-y-2">
              <div className="text-lg font-semibold">Smarter b‑roll</div>
              <p className="text-sm text-white/70">Auto‑selects relevant background clips from your topic and keywords, with manual override.</p>
            </div>
            <div className="card p-6 space-y-2">
              <div className="text-lg font-semibold">Creator presets</div>
              <p className="text-sm text-white/70">Save styles and reuse across projects. Consistency without the hassle.</p>
            </div>
          </div>
        </section>

        <section className="space-y-6">
          <header className="space-y-2 text-center">
            <h2 className="text-2xl font-bold">Outperform competitors</h2>
            <p className="text-white/70">See the differences in quality, speed and control.</p>
          </header>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
              <div className="text-sm text-white/60">Quality</div>
              <div className="text-lg font-semibold">Sharper, more legible captions</div>
            </div>
            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
              <div className="text-sm text-white/60">Speed</div>
              <div className="text-lg font-semibold">From idea to export in minutes</div>
            </div>
            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
              <div className="text-sm text-white/60">Control</div>
              <div className="text-lg font-semibold">Manual overrides when you want them</div>
            </div>
          </div>
          <div className="text-center">
            <Link href="/compare/crayo-ai" className="btn">See full comparison</Link>
          </div>
        </section>

        <section className="rounded-2xl bg-gradient-to-r from-white/5 to-white/[0.03] ring-1 ring-white/10 p-8 text-center space-y-3">
          <h3 className="text-2xl font-bold">Ready to create?</h3>
          <p className="text-white/70">Join creators shipping more high‑quality clips in less time.</p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/lab" className="btn-primary">Get started</Link>
            <Link href="/pricing" className="btn">View pricing</Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  )
}
