import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getAllowanceForPlan, currentPeriodStart } from '@/lib/credits'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const headers = { 'Access-Control-Allow-Origin': '*' }
  try {
    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
    if (userErr || !userData?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
    const user = userData.user

    const plan = String((user.user_metadata as any)?.plan || '').toLowerCase()
    const email = (user.email || '').toLowerCase()
    const devOverride = (process.env.NEXT_PUBLIC_DEV_SUB_EMAILS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      .includes(email)
    const effectivePlan = (devOverride ? 'pro' : plan) as string
    const allowance = getAllowanceForPlan(effectivePlan)
    const period = currentPeriodStart()

    if (allowance.monthly === 'unlimited') {
      return NextResponse.json({ plan: effectivePlan, monthly: 'unlimited', used: 0, remaining: 'unlimited', period_start: period }, { headers })
    }

    const { data: usageRow, error: usageErr } = await supabaseAdmin
      .from('usage_credits')
      .select('used_credits')
      .eq('user_id', user.id)
      .eq('period_start', period)
      .maybeSingle()

    if (usageErr && usageErr.code !== 'PGRST116') {
      return NextResponse.json({ error: 'Usage read failed', details: usageErr.message }, { status: 500, headers })
    }

    const used = Number(usageRow?.used_credits || 0)
    const monthly = Number(allowance.monthly || 0)
    const remaining = Math.max(0, monthly - used)

    return NextResponse.json({ plan, monthly, used, remaining, period_start: period }, { headers })
  } catch (e: any) {
    return NextResponse.json({ error: 'Server error', details: String(e?.message || e) }, { status: 500, headers })
  }
}

