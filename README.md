# ClipCatalyst (Next.js)

A minimal Next.js App Router project wired for:
- Supabase auth (client)
- `/api/generate` (OpenAI -> captions JSON, ElevenLabs -> MP3, uploads to Supabase storage `clips`)
- `/api/_debug_env` health check
- Pages: Home, Lab (gated), Profile (gated)

## Setup

1) Install deps:
```bash
npm i
```

2) Create `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

OPENAI_API_KEY=your_openai_key
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=wBXNqKUATyqu0RtYt25i

# S3 for uploads (required for Autoclipper uploads)
AWS_REGION=us-east-1
S3_BUCKET=your-bucket-name
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# External render worker (required for Autoclipper)
RENDER_WORKER_URL=https://your-worker.fly.dev
RENDER_WORKER_SECRET=your-shared-secret
```

3) Supabase Storage:
- Create a **public** bucket named `clips`.
- Later you can switch to private and use signed URLs.

4) Dev:
```bash
npm run dev
```

5) Test API:
```bash
curl -s -X POST http://localhost:3000/api/generate \  -H 'content-type: application/json' \  -d '{"mode":"Paste","source_text":"Hello from ClipCatalyst","language":"English","tone":"Informative","email":"you@example.com","project_id":"test123"}' | jq
```

6) Deploy to Vercel:
- Import the repo, set Root Directory to this folder.
- Add the same env vars in Vercel → Project → Settings → Environment Variables.
- Deploy.

## Notes
- Lab page has a simple UI that calls `/api/generate` and shows MP3/CSV download buttons.
- You can extend with Stripe portal and webhooks next.
