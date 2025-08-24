import { NextRequest, NextResponse } from 'next/server'

export const config = {
  matcher: ['/api/render']
}

export function middleware(req: NextRequest) {
  // Rewrite legacy /api/render calls to the worker proxy to avoid in-process ffmpeg
  if (req.nextUrl.pathname === '/api/render') {
    const url = new URL('/api/worker/proxy', req.url)
    return NextResponse.rewrite(url)
  }
  return NextResponse.next()
}
