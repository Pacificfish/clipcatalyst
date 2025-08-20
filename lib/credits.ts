import pricing from '@/config/pricing.json'

export function getAllowanceForPlan(plan: string): { monthly: number | 'unlimited' } {
  const p = (plan || '').toLowerCase()
  if (p === 'agency') return { monthly: 'unlimited' }
  if (p === 'pro') return { monthly: Number(pricing.pro.credits_per_month ?? 0) }
  if (p === 'beginner') return { monthly: Number(pricing.beginner.credits_per_month ?? 0) }
  return { monthly: 0 }
}

export function currentPeriodStart(): string {
  const now = new Date()
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return first.toISOString().slice(0, 10) // YYYY-MM-DD
}

