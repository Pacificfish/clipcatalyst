import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const headers: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }

    // Auth: require Supabase access token
    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })

const supabaseAdmin = getSupabaseAdmin()
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
    if (userErr || !userData?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
    const user = userData.user
    const email = (user.email || '').toLowerCase()
    if (!email) return NextResponse.json({ error: 'Missing email' }, { status: 400, headers })

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

    // Find or fail if no customer exists for this email
    // Prefer search API for exact email match
    let customer: Stripe.Customer | null = null
    try {
      const res = await stripe.customers.search({ query: `email:'${email}' AND status:'active'` })
      customer = (res.data && res.data[0]) || null
      if (!customer) {
        // fallback: list by email
        const list = await stripe.customers.list({ email, limit: 1 })
        customer = (list.data && list.data[0]) || null
      }
    } catch {
      const list = await stripe.customers.list({ email, limit: 1 })
      customer = (list.data && list.data[0]) || null
    }

    if (!customer) {
      return NextResponse.json({ error: 'No Stripe customer found for this email' }, { status: 404, headers })
    }

const returnUrl = req.headers.get('x-return-url') || `${(process.env.NEXT_PUBLIC_SITE_URL || 'https://clipcatalyst.net').replace(/\/$/,'')}/profile`

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: returnUrl,
    })

    return NextResponse.json({ url: session.url }, { headers })
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } })
  }
}

