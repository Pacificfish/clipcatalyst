#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs'

const path = 'config/pricing.json'
mkdirSync('config', { recursive: true })

const priceText = process.env.AGENCY_PRICE_TEXT || (`$${process.env.AGENCY_PRICE || '100'}/${process.env.AGENCY_PERIOD || 'month'}`)
const data = {
  credit_unit: process.env.CREDIT_UNIT || '1 video credit = 1 generated video',
  beginner: { price: `$${process.env.BEGINNER_PRICE || '15/mo'}`, credits_per_month: Number(process.env.BEGINNER_CREDITS || '20') },
  pro: { price: `$${process.env.PRO_PRICE || '49/mo'}`, credits_per_month: Number(process.env.PRO_CREDITS || '30') },
  agency: { price: priceText, credits: (process.env.AGENCY_CREDITS || 'unlimited') }
}

writeFileSync(path, JSON.stringify(data, null, 2))
console.log('Wrote', path)

