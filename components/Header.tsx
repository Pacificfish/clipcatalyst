// components/Header.tsx
'use client'
import Link from 'next/link'

export default function Header(){
  return (
    <header className="sticky top-0 z-50 backdrop-blur supports-[backdrop-filter]:bg-black/40">
      <div className="container flex items-center justify-between h-16">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-[var(--brand)]"></div>
          <span className="font-semibold">ClipCatalyst</span>
        </Link>
        <nav className="hidden md:flex items-center gap-6 text-sm text-[var(--muted)]">
          <Link href="/#features">Features</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/lab" className="text-white">Lab</Link>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/#features" className="btn">See Features</Link>
          <Link href="/lab" className="btn-primary">Get Started</Link>
        </div>
      </div>
      <div className="h-px w-full bg-gradient-to-r from-transparent via-white/15 to-transparent" />
    </header>
  )
}