-- Run this once in Supabase SQL Editor if you already created the original stup MVP database.
-- Existing profiles get an empty ratings object and can fill in their subjects in Settings.
alter table public.profiles
  add column if not exists subject_ratings jsonb not null default '{}'::jsonb;
