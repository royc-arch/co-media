-- Run this in your Supabase SQL editor to set up the schema

-- Jobs table
create table if not exists public.jobs (
  id          uuid        default gen_random_uuid() primary key,
  user_id     uuid        references auth.users(id) on delete cascade not null,
  image1_url  text        not null,
  image2_url  text        not null,
  output_url  text,
  status      text        not null default 'pending',
  created_at  timestamptz default now() not null
);

-- Enable RLS
alter table public.jobs enable row level security;

-- Policies
create policy "Users can view own jobs"
  on public.jobs for select
  using (auth.uid() = user_id);

create policy "Users can insert own jobs"
  on public.jobs for insert
  with check (auth.uid() = user_id);

create policy "Users can update own jobs"
  on public.jobs for update
  using (auth.uid() = user_id);

-- Video jobs table
create table if not exists public.video_jobs (
  id          uuid        default gen_random_uuid() primary key,
  user_id     uuid        references auth.users(id) on delete cascade not null,
  subject_url text        not null,
  output_url  text,
  video_url   text,
  task_id     text,
  showcase    text        not null,
  duration    int         not null,
  status      text        not null default 'processing',
  created_at  timestamptz default now() not null
);

alter table public.video_jobs enable row level security;

create policy "Users can manage own video_jobs"
  on public.video_jobs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Saved references table
create table if not exists public.saved_references (
  id          uuid        default gen_random_uuid() primary key,
  user_id     uuid        references auth.users(id) on delete cascade not null,
  name        text        not null default 'Untitled',
  image_url   text        not null,
  created_at  timestamptz default now() not null
);

alter table public.saved_references enable row level security;

create policy "Users can manage own saved_references"
  on public.saved_references for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Storage bucket (public so images can be displayed)
insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do nothing;

-- Storage RLS: users upload only to their own folder
create policy "Users upload to own folder"
  on storage.objects for insert
  with check (
    bucket_id = 'images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'images');

create policy "Users delete own images"
  on storage.objects for delete
  using (
    bucket_id = 'images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
