import Header from '@/components/Header'
import Footer from '@/components/Footer'

import pricing from '@/config/pricing.json'

export default function PricingPage(){
  const tiers = [
    { name: 'Beginner', price: pricing.beginner.price, features: [`${pricing.beginner.credits_per_month} video credits / month`, 'Bold captions', 'Email support'], cta: 'Pay with Stripe', href: 'https://buy.stripe.com/3cI6oHghE2Gl8Gf0zh6sw01' },
    { name: 'Pro', price: pricing.pro.price, features: [`${pricing.pro.credits_per_month} video credits / month`, 'Batch generation', 'Priority support'], cta: 'Pay with Stripe', href: 'https://buy.stripe.com/8x27sL0iG80F7Cb3Lt6sw02' },
    { name: 'Agency', price: pricing.agency.price, features: [`${pricing.agency.credits ?? 'Custom'} credits`, 'Team seats', 'Dedicated support'], cta: 'Pay with Stripe', href: 'https://buy.stripe.com/8x2aEXaXk3Kp2hR2Hp6sw03' },
  ] as const

  return (
    <>
      <Header />
      <main className="container py-16 space-y-10">
        <header className="text-center space-y-3">
          <h1 className="text-4xl font-extrabold">Simple, transparent pricing</h1>
          <p className="text-white/70">Choose a plan that fits your workflow.</p>
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
                <a href={t.href} className="btn-primary w-full inline-flex justify-center" target="_blank" rel="noopener noreferrer">{t.cta}</a>
              </div>
            </div>
          ))}
        </section>
      </main>
      <Footer />
    </>
  )
}
