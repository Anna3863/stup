create table if not exists public.profile_reviews (
  id uuid primary key default gen_random_uuid(),
  target_profile_id uuid not null references public.profiles(id) on delete cascade,
  reviewer_profile_id uuid not null references public.profiles(id) on delete cascade,
  session_id text not null,
  rating smallint not null check (rating between 1 and 5),
  comment text not null default '' check (char_length(comment) <= 1000),
  created_at timestamptz not null default now(),
  unique (target_profile_id, reviewer_profile_id, session_id),
  check (target_profile_id <> reviewer_profile_id)
);

alter table public.profiles add column if not exists profile_photo_url text;

alter table public.profile_reviews enable row level security;
grant select, insert on public.profile_reviews to authenticated;

drop policy if exists "Signed-in users can read profile reviews" on public.profile_reviews;
create policy "Signed-in users can read profile reviews"
  on public.profile_reviews for select to authenticated using (true);

drop policy if exists "Users can post reviews as themselves" on public.profile_reviews;
create policy "Users can post reviews as themselves"
  on public.profile_reviews for insert to authenticated
  with check (reviewer_profile_id = auth.uid() and target_profile_id <> auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their profile pictures" on storage.objects;
create policy "Users can upload their profile pictures"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can update their profile pictures" on storage.objects;
create policy "Users can update their profile pictures"
  on storage.objects for update to authenticated
  using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete their profile pictures" on storage.objects;
create policy "Users can delete their profile pictures"
  on storage.objects for delete to authenticated
  using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);
