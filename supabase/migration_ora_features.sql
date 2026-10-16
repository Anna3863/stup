-- Ora feature compatibility migration for existing stup Supabase projects.
alter table public.profiles add column if not exists lumen_balance integer not null default 3;

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  target_profile_id uuid not null references public.profiles(id) on delete cascade,
  reporter_profile_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id text not null,
  reason text not null check (char_length(reason) between 10 and 2000),
  created_at timestamptz not null default now(),
  check (target_profile_id <> reporter_profile_id)
);

alter table public.reports enable row level security;
grant insert on public.reports to authenticated;
drop policy if exists "Users can submit reports" on public.reports;
create policy "Users can submit reports" on public.reports for insert to authenticated
  with check (reporter_profile_id = auth.uid() and target_profile_id <> auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-ids', 'student-ids', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

notify pgrst, 'reload schema';
