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
  prompt_hints        text,              -- active style stored as "name||stars||styleText"
  updated_at          timestamptz default now() not null,
  unique(user_id, location_name)
);

-- Add prompt_hints to existing gmb_settings tables (safe to run on existing DBs)
alter table public.gmb_settings add column if not exists prompt_hints text;

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

-- Reply style library (multiple saved styles per location)
create table if not exists public.gmb_styles (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade not null,
  location_name text        not null,
  name          text        not null,   -- short label e.g. "Warm & Direct"
  stars         int         default 5,  -- star rating used during training
  apply_mask    int,                    -- bitmask: bit N-1 set = applies to N-star reviews (null = exact match)
  style_text    text        not null,   -- "This owner prefers…" (from GPT)
  override_text text,                  -- optional campaign/situation note
  created_at    timestamptz default now() not null
);

-- Migrate: drop min_stars (range model), add apply_mask (bitmask model)
alter table public.gmb_styles drop   column if exists min_stars;
alter table public.gmb_styles add    column if not exists apply_mask int;

-- Migrate: add has_photo flag to reviews
alter table public.gmb_reviews add column if not exists has_photo boolean default false;

-- Migrate: add per-style context and keywords
alter table public.gmb_styles add    column if not exists context  text;
alter table public.gmb_styles add    column if not exists keywords text;

-- Migrate: track reviews removed from Google (instead of deleting them)
alter table public.gmb_reviews add column if not exists removed_from_google boolean default false;

alter table public.gmb_styles enable row level security;

create policy "Users manage own gmb_styles"
  on public.gmb_styles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
