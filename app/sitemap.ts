import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || 'https://clipcatalyst.net').replace(/\/$/, '')
  return [
    { url: `${base}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/pricing`, changeFrequency: 'monthly', priority: 0.7 },
  ]
}
