-- Run this in your Supabase SQL editor

-- OAuth tokens (one per user — tokens cover all their GMB locations)
create table if not exists public.gmb_connections (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade not null unique,
  access_token  text        not null,
  refresh_token text        not null,
  expires_at    timestamptz not null,
  created_at    timestamptz default now() not null
);

alter table public.gmb_connections enable row level security;

create policy "Users manage own gmb_connections"
  on public.gmb_connections for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Auto-reply settings per location
create table if not exists public.gmb_settings (
  id                  uuid    default gen_random_uuid() primary key,
  user_id             uuid    references auth.users(id) on delete cascade not null,
  account_name        text    not null,   -- e.g. "accounts/123456"
  location_name       text    not null,   -- e.g. "accounts/123456/locations/ChIJ..."
  display_name        text    not null,
  auto_reply_enabled  boolean default false,
  reply_tone          text    default 'professional', -- 'professional' | 'friendly' | 'casual'
  custom_instructions text,
  updated_at          timestamptz default now() not null,
  unique(user_id, location_name)
);

alter table public.gmb_settings enable row level security;

create policy "Users manage own gmb_settings"
  on public.gmb_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Review cache + reply tracking
create table if not exists public.gmb_reviews (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade not null,
  location_name text        not null,
  review_name   text        not null unique,  -- Google resource name e.g. "accounts/.../reviews/abc"
  author        text,
  rating        text,                          -- 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE'
  comment       text,
  replied       boolean     default false,
  reply_text    text,
  review_time   timestamptz,
  created_at    timestamptz default now() not null
);

alter table public.gmb_reviews enable row level security;

create policy "Users manage own gmb_reviews"
  on public.gmb_reviews for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
