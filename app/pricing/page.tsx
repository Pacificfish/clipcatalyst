import Header from '@/components/Header'
import Footer from '@/components/Footer'

export default function PricingPage(){
  const tiers = [
    { name: 'Free', price: '$0', features: ['5 generations/day', 'Basic captions', 'Email support'], cta: 'Get started' },
    { name: 'Creator', price: '$15/mo', features: ['100 generations/mo', 'Bold captions', 'Priority support'], cta: 'Start trial' },
    { name: 'Pro', price: '$49/mo', features: ['Unlimited', 'Batch generation', 'Team seats (coming)'], cta: 'Contact sales' },
  ] as const

  return (
    <>
      <Header />
      <main className="container py-16 space-y-10">
        <header className="text-center space-y-3">
          <h1 className="text-4xl font-extrabold">Simple, transparent pricing</h1>
          <p className="text-white/70">Start free. Upgrade when you need more throughput.</p>
        </header>
        <section className="grid md:grid-cols-3 gap-4">
          {tiers.map(t => (
            <div key={t.name} className="card p-6 flex flex-col">
              <div className="text-lg font-semibold">{t.name}</div>
              <div className="text-4xl font-extrabold mt-2">{t.price}</div>
              <ul className="mt-4 space-y-2 text-white/80">
                {t.features.map(f => <li key={f}>• {f}</li>)}
              </ul>
              <div className="mt-6">
                <a href="/lab" className="btn-primary w-full inline-flex justify-center">{t.cta}</a>
              </div>
            </div>
          ))}
        </section>
      </main>
      <Footer />
    </>
  )
}
