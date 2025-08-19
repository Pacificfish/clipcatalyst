import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'ClipCatalyst – Turn ideas into viral shorts in minutes',
  description: 'Generate 30–60s scripts, voiceovers, and bold captions in one click.',
  openGraph: {
    title: 'ClipCatalyst – Viral shorts in minutes',
    description: 'Generate 30–60s scripts, voiceovers, and bold captions in one click.',
    url: 'https://clipcatalyst.app',
    siteName: 'ClipCatalyst',
    images: [{ url: '/og.png', width: 1200, height: 630 }],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ClipCatalyst – Viral shorts in minutes',
    description: 'Generate 30–60s scripts, voiceovers, and bold captions in one click.',
    images: ['/og.png'],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

