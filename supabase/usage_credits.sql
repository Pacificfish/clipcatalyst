-- Supabase SQL: usage tracking per user per month
-- Run this in your Supabase project's SQL editor

create table if not exists public.usage_credits (
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  used_credits int not null default 0,
  primary key (user_id, period_start)
);

-- RLS: allow users to read and update their own row
alter table public.usage_credits enable row level security;

create policy if not exists "allow read own usage" on public.usage_credits
for select using ( auth.uid() = user_id );

create policy if not exists "allow upsert own usage" on public.usage_credits
for insert with check ( auth.uid() = user_id );

create policy if not exists "allow update own usage" on public.usage_credits
for update using ( auth.uid() = user_id );

