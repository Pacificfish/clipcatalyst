import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
export const runtime = 'nodejs';

export async function GET() {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_ID: !!process.env.ELEVENLABS_VOICE_ID,
  };

  let storage = { ok: false as boolean, error: null as string | null };
  try {
    const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const probePath = `health/${Date.now()}.txt`;
    const up = await supa.storage.from('clips').upload(probePath, new Blob(['ok']), { upsert: true });
    if (up.error) storage = { ok: false, error: up.error.message };
    else {
      await supa.storage.from('clips').remove([probePath]);
      storage = { ok: true, error: null };
    }
  } catch (e:any) {
    storage = { ok: false, error: String(e?.message || e) };
  }

  return NextResponse.json({ env, storage });
}
