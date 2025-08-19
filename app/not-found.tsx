import Link from 'next/link'
import Header from '@/components/Header'
import Footer from '@/components/Footer'

export default function NotFound(){
  return (
    <>
      <Header />
      <main className="container py-24 text-center space-y-4">
        <h1 className="text-5xl font-extrabold">404</h1>
        <p className="text-white/70">The page you were looking for doesn’t exist.</p>
        <div className="flex gap-3 justify-center">
          <Link className="btn" href="/">Go Home</Link>
          <Link className="btn-primary" href="/lab">Try the Lab</Link>
        </div>
      </main>
      <Footer />
    </>
  )
}
