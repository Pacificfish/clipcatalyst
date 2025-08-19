import Nav from '@/components/Nav';
import Link from 'next/link';

export default function HomePage() {
  const features = [
    ['AI Script & Storyboard','Optimized for 30–60s pacing.'],
    ['Human-like Voiceovers','Use ElevenLabs or your own voice.'],
    ['Bold Captions','Auto timing for TikTok/Shorts.'],
    ['Topic Research','Find trending topics instantly.'],
    ['Batch Generation','Queue multiple shorts at once.'],
    ['Canva Export (soon)','One-click 9:16 export.'],
  ] as const;

  return (
    <>
      <Nav />
      <main className="container py-16 space-y-16">
        <section className="text-center space-y-6">
          <h1 className="text-4xl md:text-6xl font-extrabold">
            Turn Ideas into <span className="text-cyan-400">Viral Shorts</span> in Minutes
          </h1>
          <p className="text-white/70 max-w-2xl mx-auto">
            Paste a URL or text. Get a 30–60s script, human-sounding voiceover, bold captions,
            and a ready-to-render file.
          </p>
          <div className="flex gap-3 justify-center">
            <Link href="/lab" className="btn-primary">Get Started</Link>
            <a href="#features" className="btn">See Features</a>
          </div>
        </section>

        <section id="features" className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map(([title,desc]) => (
            <div key={title} className="card p-6">
              <div className="text-lg font-semibold">{title}</div>
              <p className="text-white/70 mt-2">{desc}</p>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
