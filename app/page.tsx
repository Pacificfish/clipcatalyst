import Header from '@/components/Header'
import Footer from '@/components/Footer'
import Link from 'next/link'

export default function HomePage() {
  const features = [
    ['AI Script & Storyboard','Optimized for 30–60s pacing.'],
    ['Human-like Voiceovers','Use ElevenLabs or your own voice.'],
    ['Bold Captions','Auto timing for TikTok/Shorts.'],
    ['Topic Research','Find trending topics instantly.'],
    ['Batch Generation','Queue multiple shorts at once.'],
    ['Canva Export (soon)','One-click 9:16 export.'],
  ] as const

  return (
    <>
      <Header />
      <main className="container py-16 space-y-24">
        <section className="text-center space-y-6">
          <div className="inline-flex items-center gap-2 badge mx-auto">
            <span className="h-2 w-2 rounded-full bg-[var(--brand)]" />
            <span className="text-white/70">Generate shorts 10× faster</span>
          </div>
          <h1 className="text-4xl md:text-6xl font-extrabold leading-tight">
            Turn Ideas into <span className="gradient-text">Viral Shorts</span> in Minutes
          </h1>
          <p className="text-white/70 max-w-2xl mx-auto">
            Paste a URL or text. Get a 30–60s script, human-sounding voiceover, bold captions,
            and ready-to-render assets for TikTok, Reels, and YouTube Shorts.
          </p>
          <div className="flex gap-3 justify-center">
            <Link href="/lab" className="btn-primary">Get Started</Link>
            <a href="#features" className="btn">See Features</a>
          </div>
        </section>

        <section id="features" className="space-y-8">
          <h2 className="text-2xl font-bold text-center">Everything you need to publish faster</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map(([title,desc]) => (
              <div key={title} className="card p-6">
                <div className="text-lg font-semibold">{title}</div>
                <p className="text-white/70 mt-2">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-bold text-center">Trusted by creators and teams</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1,2,3].map(i => (
              <div key={i} className="card p-6 space-y-2">
                <p className="text-white/80">“ClipCatalyst helps us ship quality shorts consistently without burning hours.”</p>
                <div className="text-sm text-white/60">Creator {i}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-bold text-center">FAQs</h2>
          <div className="grid md:grid-cols-2 gap-4">
            {[
              ['Can I use my own voice?', 'Yes. You can upload a custom voice to ElevenLabs or use their stock voices.'],
              ['Will captions fit shorts?', 'Yes. We generate 1–3s captions that cover the full script with bold styling.'],
              ['Where are files stored?', 'MP3 and CSV are uploaded to your Supabase storage bucket for easy access.'],
              ['Is there a free plan?', 'Yes. Get started free and upgrade when you need more throughput.'],
            ].map(([q,a]) => (
              <div key={q} className="card p-6">
                <div className="font-medium">{q}</div>
                <p className="text-white/70 mt-2">{a}</p>
              </div>
            ))}
          </div>
          <div className="text-center">
            <Link href="/pricing" className="btn">See pricing</Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  )
}
