import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// We need raw body for Stripe signature verification
function readRawBody(req: Request): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const arrayBuffer = await req.arrayBuffer()
      resolve(Buffer.from(arrayBuffer))
    } catch (e) {
      reject(e)
    }
  })
}

export async function POST(req: Request) {
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
    const sig = req.headers.get('stripe-signature') as string
    const buf = await readRawBody(req)
    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET!)
    } catch (err: any) {
      return NextResponse.json({ error: `Invalid signature: ${err.message}` }, { status: 400 })
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const obj: any = event.data.object as any
        // Derive email and plan from the session/subscription
        let email = ''
        let priceId = ''
        if (event.type === 'checkout.session.completed') {
          email = (obj.customer_details?.email || obj.customer_email || '').toLowerCase()
          // line_items requires expansion; fallback to metadata.plan if set
          priceId = obj?.metadata?.price_id || ''
        } else {
          // subscription events
          const sub = obj as Stripe.Subscription
          priceId = (sub.items.data[0]?.price?.id) || ''
          // Need to look up customer email
          if (!email && typeof sub.customer === 'string') {
            const cust = await stripe.customers.retrieve(sub.customer)
            email = ((cust as Stripe.Customer).email || '').toLowerCase()
          }
        }

        // Map priceId to plan. For fixed payment links, set metadata.plan in Stripe Checkout link settings
        let plan = (obj?.metadata?.plan || '').toLowerCase()
        if (!plan) {
          // Fallback mapping by priceId (fill these in if you use Prices)
          const map: Record<string, string> = {
            // 'price_XXX': 'beginner',
            // 'price_YYY': 'pro',
            // 'price_ZZZ': 'agency',
          }
          plan = (map[priceId] || '').toLowerCase()
        }
        if (!plan || !email) return NextResponse.json({ ok: true, note: 'Missing plan or email; no-op' })

        // Find the user by email
        // Search for user by email using admin API
        const { data: list1, error: uerr1 } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 100 }) as any
        if (uerr1) return NextResponse.json({ error: uerr1.message }, { status: 500 })
        const user = list1?.users?.find((u: any) => (u.email || '').toLowerCase() === email)
        if (!user) return NextResponse.json({ ok: true, note: 'User not found for email; no-op' })

        // Update user_metadata.plan
        const { error: upErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { user_metadata: { ...user.user_metadata, plan } })
        if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

        return NextResponse.json({ ok: true })
      }
      case 'customer.subscription.deleted': {
        // Downgrade plan
        const sub = event.data.object as Stripe.Subscription
        let email = ''
        if (typeof sub.customer === 'string') {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
          const cust = await stripe.customers.retrieve(sub.customer)
          email = ((cust as Stripe.Customer).email || '').toLowerCase()
        }
        if (!email) return NextResponse.json({ ok: true, note: 'No email; no-op' })
        const { data: list2, error: uerr2 } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 100 }) as any
        if (uerr2) return NextResponse.json({ error: uerr2.message }, { status: 500 })
        const user = list2?.users?.find((u: any) => (u.email || '').toLowerCase() === email)
        if (!user) return NextResponse.json({ ok: true, note: 'User not found; no-op' })
        const { error: upErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { user_metadata: { ...user.user_metadata, plan: '' } })
        if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ ok: true })
    }
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 })
  }
}

