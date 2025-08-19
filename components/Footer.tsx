export default function Footer(){
  return (
    <footer className="mt-24 border-t border-white/10">
      <div className="container py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/60">
        <div>© {new Date().getFullYear()} ClipCatalyst</div>
        <nav className="flex items-center gap-4">
          <a className="hover:text-white" href="/pricing">Pricing</a>
          <a className="hover:text-white" href="/">Home</a>
        </nav>
      </div>
    </footer>
  )
}
