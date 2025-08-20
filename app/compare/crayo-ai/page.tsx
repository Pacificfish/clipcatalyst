import Header from '@/components/Header'
import Footer from '@/components/Footer'

export default function CompareCrayo(){
  return (
    <>
      <Header />
      <main className="container py-16 space-y-10">
        <header className="space-y-3">
          <h1 className="text-3xl font-extrabold">ClipCatalyst vs. competitors</h1>
          <p className="text-white/70">A practical comparison for creators focused on quality, speed, and control.</p>
        </header>

        <section className="grid md:grid-cols-2 gap-4">
          <div className="card p-6 space-y-2">
            <div className="text-lg font-semibold">Caption quality</div>
            <p className="text-sm text-white/70">ClipCatalyst produces bold, legible captions with better line breaks and emphasis for retention.</p>
          </div>
          <div className="card p-6 space-y-2">
            <div className="text-lg font-semibold">B‑roll relevance</div>
            <p className="text-sm text-white/70">We score and pick background clips using your title/topic/keywords—with easy manual overrides.</p>
          </div>
          <div className="card p-6 space-y-2">
            <div className="text-lg font-semibold">Speed to export</div>
            <p className="text-sm text-white/70">From idea to MP4 in minutes with a streamlined render pipeline.</p>
          </div>
          <div className="card p-6 space-y-2">
            <div className="text-lg font-semibold">Creator presets</div>
            <p className="text-sm text-white/70">Save templates for your channel’s style and reuse across projects.</p>
          </div>
        </section>

        <section className="rounded-xl bg-white/5 ring-1 ring-white/10 p-6 space-y-3">
          <h2 className="text-xl font-bold">Bottom line</h2>
          <p className="text-white/70">If you prioritize consistent, high‑quality output with fewer edits, ClipCatalyst is built for you. Keep your current pricing tiers—just get better results, faster.</p>
          <div className="flex items-center gap-3">
            <a className="btn" href="/" >Back</a>
            <a className="btn-primary" href="/lab">Try it now</a>
          </div>
        </section>
      </main>
      <Footer />
    </>
  )
}
