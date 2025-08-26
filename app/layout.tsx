import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'], display: 'swap' })

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || 'https://clipcatalyst-dnuhao2qw-clip-catalyst.vercel.app').replace(/\/$/, '')

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'ClipCatalyst – Turn ideas into viral shorts in minutes',
  description: 'Generate 30–60s scripts, voiceovers, and bold captions in one click.',
  keywords: ['shorts generator','ai video','tiktok','reels','youtube shorts','captions','voiceover','elevenlabs'],
  authors: [{ name: 'ClipCatalyst' }],
  alternates: { canonical: '/' },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
  },
  openGraph: {
    title: 'ClipCatalyst – Viral shorts in minutes',
    description: 'Generate 30–60s scripts, voiceovers, and bold captions in one click.',
    url: siteUrl,
    siteName: 'ClipCatalyst',
    images: [{ url: '/og.svg', width: 1200, height: 630 }],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ClipCatalyst – Viral shorts in minutes',
    description: 'Generate 30–60s scripts, voiceovers, and bold captions in one click.',
    images: ['/og.svg'],
  },
}

export const viewport = {
  themeColor: '#0A0F1F',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'ClipCatalyst',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web',
    description: 'Generate 30–60s scripts, voiceovers, and bold captions for short-form video.',
    url: siteUrl,
  }

  return (
    <html lang="en">
      <body className={inter.className}>
        {/* Theme init script to avoid flash */}
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: `(() => { try { const ls = localStorage.getItem('theme'); const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; const t = ls || (prefersDark ? 'dark' : 'light'); document.documentElement.setAttribute('data-theme', t); } catch (e) {} })();` }}
        />
        {children}
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  )
}

