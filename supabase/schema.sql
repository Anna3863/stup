-- stup MVP schema. Run in Supabase SQL Editor.
-- Do not store CNPs, phone numbers, or identity-document images in profiles.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  school_level smallint not null default 1 check (school_level between 0 and 2),
  county text not null default 'București' check (char_length(county) between 2 and 50),
  main_subject text not null default 'Mathematics' check (char_length(main_subject) between 2 and 100),
  subject_ratings jsonb not null default '{}'::jsonb check (jsonb_typeof(subject_ratings) = 'object'),
  bio text not null default '',
  verified boolean not null default false,
  student_id_photo_url text,
  profile_photo_url text,
  created_at timestamptz not null default now()
);

-- Safe to re-run on an existing stup database: adds the multi-subject rating field.
alter table public.profiles add column if not exists subject_ratings jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists bio text not null default '';
alter table public.profiles add column if not exists verified boolean not null default false;
alter table public.profiles add column if not exists student_id_photo_url text;
alter table public.profiles add column if not exists profile_photo_url text;

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

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index if not exists profiles_county_idx on public.profiles(county);

alter table public.profiles enable row level security;
alter table public.profile_reviews enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

grant select, insert, update on public.profiles to authenticated;
grant select, insert on public.profile_reviews to authenticated;
grant select, insert on public.conversations to authenticated;
grant select, insert on public.conversation_members to authenticated;
grant select, insert on public.messages to authenticated;

create policy "Signed-in users can discover basic profiles" on public.profiles for select to authenticated using (true);
create policy "Users can create their own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "Users can update their own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "Signed-in users can read profile reviews" on public.profile_reviews for select to authenticated using (true);
create policy "Users can post reviews as themselves" on public.profile_reviews for insert to authenticated with check (
  reviewer_profile_id = auth.uid() and target_profile_id <> auth.uid()
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can upload their profile pictures" on storage.objects for insert to authenticated
with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users can update their profile pictures" on storage.objects for update to authenticated
using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users can delete their profile pictures" on storage.objects for delete to authenticated
using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);

notify pgrst, 'reload schema';

create or replace function public.is_conversation_member(target_conversation uuid, target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.conversation_members cm where cm.conversation_id = target_conversation and cm.user_id = target_user);
$$;
revoke all on function public.is_conversation_member(uuid, uuid) from public;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;

create policy "Members can read their conversations" on public.conversations for select to authenticated using (
  public.is_conversation_member(conversations.id, auth.uid())
);
create policy "Members can read membership rows" on public.conversation_members for select to authenticated using (
  public.is_conversation_member(conversation_members.conversation_id, auth.uid())
);
create policy "Conversation participants can read messages" on public.messages for select to authenticated using (
  public.is_conversation_member(messages.conversation_id, auth.uid())
);
create policy "Participants can send messages as themselves" on public.messages for insert to authenticated with check (
  sender_id = auth.uid() and char_length(body) between 1 and 2000 and
  public.is_conversation_member(messages.conversation_id, auth.uid())
);

-- Prevent clients from creating arbitrary conversation rows/members directly.
revoke insert on public.conversations from authenticated;
revoke insert on public.conversation_members from authenticated;

create or replace function public.get_or_create_conversation(other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  found_id uuid;
  new_id uuid;
begin
  if current_user_id is null then raise exception 'You must be signed in'; end if;
  if other_user is null or other_user = current_user_id then raise exception 'Choose another student'; end if;
  if not exists (select 1 from public.profiles where id = other_user) then raise exception 'Student not found'; end if;
  select c.id into found_id
  from public.conversations c
  join public.conversation_members a on a.conversation_id = c.id and a.user_id = current_user_id
  join public.conversation_members b on b.conversation_id = c.id and b.user_id = other_user
  where (select count(*) from public.conversation_members cm where cm.conversation_id = c.id) = 2
  limit 1;
  if found_id is not null then return found_id; end if;
  insert into public.conversations default values returning id into new_id;
  insert into public.conversation_members(conversation_id,user_id) values (new_id,current_user_id),(new_id,other_user);
  return new_id;
end;
$$;
revoke all on function public.get_or_create_conversation(uuid) from public;
grant execute on function public.get_or_create_conversation(uuid) to authenticated;

-- Enable Supabase Realtime for new messages. If this errors because the table is
-- already in the publication, it is already enabled and can be ignored.
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
when others then
  if sqlstate != '42710' then raise; end if;
end $$;
