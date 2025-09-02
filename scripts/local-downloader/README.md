# Local YouTube downloader (for ClipCatalyst worker)

This runs on your Mac, uses your real browser cookies, and exposes a simple POST /download_youtube endpoint that returns a public URL to the downloaded MP4. The ClipCatalyst worker will call this service when DOWNLOADER_BASE_URL is set.

Requirements
- macOS
- yt-dlp installed locally (via Homebrew):
  brew install yt-dlp
- Node 18+

Setup
1) Install deps
   npm --prefix scripts/local-downloader install

2) Start the server (port 3009 by default)
   # OPTIONAL: set PUBLIC_BASE to your public tunnel URL (see next step)
   # export PUBLIC_BASE=https://your-public-tunnel.example
   npm --prefix scripts/local-downloader start
   # Or: node scripts/local-downloader/server.js

3) Expose it publicly using a tunnel
   Option A: localtunnel (one-liner, no account)
   npx localtunnel --port 3009
   # This prints a URL like https://<random>.loca.lt

   Option B: Cloudflare Tunnel (requires account)
   cloudflared tunnel --url http://localhost:3009

   Set PUBLIC_BASE to that URL and restart the server so returned URLs are publicly accessible
   export PUBLIC_BASE=https://<your-tunnel-domain>
   npm --prefix scripts/local-downloader start

4) Point the worker at your local downloader
   fly secrets set -a clipcatalyst-worker DOWNLOADER_BASE_URL=https://<your-tunnel-domain>
   # Setting secrets triggers a machine restart. No code deploy needed after our patch.

5) Test the chain
   - Start a job through your frontend or directly:
     curl -sS -X POST https://clipcatalyst-9wjivrtc9-clip-catalyst.vercel.app/api/auto-clip \
       -H 'Content-Type: application/json' \
       --data '{"youtube_url":"https://www.youtube.com/watch?v=fouHF9odKUo","target_clip_count":1}'
   - Poll status with the returned job_id

Notes
- The server uses: yt-dlp --cookies-from-browser chrome and merges to MP4.
- You can adjust max height via env FORMAT, e.g.
  export FORMAT="bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/best"
- Files are saved to scripts/local-downloader/downloads and served at /files/*

Troubleshooting
- If yt-dlp is not found: brew install yt-dlp
- If Chrome profile isn’t detected, try: --cookies-from-browser brave or firefox (edit server.js)
- If the worker still reports youtube_download_failed, verify:
  - The tunnel URL is reachable from the internet
  - PUBLIC_BASE matches the same URL printed by the tunnel
  - The worker secret DOWNLOADER_BASE_URL exactly matches your tunnel URL
  - The local server logs show requests hitting /download_youtube

