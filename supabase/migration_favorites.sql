create table if not exists public.favorite_profiles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  favorite_profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, favorite_profile_id),
  check (user_id <> favorite_profile_id)
);

alter table public.favorite_profiles enable row level security;
grant select, insert, delete on public.favorite_profiles to authenticated;
drop policy if exists "Users can read their favorites" on public.favorite_profiles;
drop policy if exists "Users can add their favorites" on public.favorite_profiles;
drop policy if exists "Users can remove their favorites" on public.favorite_profiles;
create policy "Users can read their favorites" on public.favorite_profiles for select to authenticated using (user_id = auth.uid());
create policy "Users can add their favorites" on public.favorite_profiles for insert to authenticated with check (user_id = auth.uid() and favorite_profile_id <> auth.uid());
create policy "Users can remove their favorites" on public.favorite_profiles for delete to authenticated using (user_id = auth.uid());
notify pgrst, 'reload schema';
