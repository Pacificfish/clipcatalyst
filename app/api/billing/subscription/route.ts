import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const headers: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }
  try {
    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
    if (userErr || !userData?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
    const email = (userData.user.email || '').toLowerCase()

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

    // Find customer by email
    let customerId: string | null = null
    try {
      const res = await stripe.customers.search({ query: `email:'${email}'` })
      customerId = res.data?.[0]?.id || null
    } catch {
      const list = await stripe.customers.list({ email, limit: 1 })
      customerId = list.data?.[0]?.id || null
    }
    if (!customerId) return NextResponse.json({ error: 'Customer not found' }, { status: 404, headers })

    // Get subscriptions
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 })
    const sub = subs.data?.[0]
    if (!sub) return NextResponse.json({ status: 'none' }, { headers })
    const s: any = sub as any

    return NextResponse.json({
      status: s.status,
      current_period_end: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
      cancel_at_period_end: !!s.cancel_at_period_end,
    }, { headers })
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500, headers })
  }
}

