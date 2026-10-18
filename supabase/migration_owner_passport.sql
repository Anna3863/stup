-- Adds owner badges and changes identity verification uploads from student IDs to passport photos.
alter table public.profiles
  add column if not exists owner boolean not null default false,
  add column if not exists passport_photo_url text;

create or replace function public.prevent_owner_self_assignment()
returns trigger
language plpgsql
security invoker
as $$
begin
  if auth.uid() is not null and new.owner is distinct from old.owner then
    raise exception 'Only an administrator can change the owner flag';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_owner_self_assignment on public.profiles;
create trigger prevent_owner_self_assignment
before update on public.profiles
for each row execute function public.prevent_owner_self_assignment();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('passport-photos', 'passport-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their passport photo" on storage.objects;
create policy "Users can upload their passport photo" on storage.objects for insert to authenticated
with check (bucket_id = 'passport-photos' and (storage.foldername(name))[1] = 'passport-photos');

notify pgrst, 'reload schema';

-- Adds named multi-person conversations for group study.
alter table public.conversations add column if not exists title text;
alter table public.conversations add column if not exists is_group boolean not null default false;

create or replace function public.create_group_conversation(group_name text, member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  new_id uuid;
  selected_ids uuid[];
begin
  if current_user_id is null then raise exception 'You must be signed in'; end if;
  if group_name is null or char_length(trim(group_name)) not between 1 and 60 then raise exception 'Enter a group name'; end if;
  selected_ids := array(select distinct id from unnest(coalesce(member_ids, '{}')) id where id <> current_user_id);
  if coalesce(array_length(selected_ids, 1), 0) < 1 then raise exception 'Choose at least one other student'; end if;
  if exists (select 1 from unnest(selected_ids) id where not exists (select 1 from public.profiles where profiles.id = id)) then raise exception 'One or more students were not found'; end if;
  insert into public.conversations(title, is_group) values (trim(group_name), true) returning id into new_id;
  insert into public.conversation_members(conversation_id, user_id) values (new_id, current_user_id);
  insert into public.conversation_members(conversation_id, user_id) select new_id, id from unnest(selected_ids) id;
  return new_id;
end;
$$;
revoke all on function public.create_group_conversation(text, uuid[]) from public;
grant execute on function public.create_group_conversation(text, uuid[]) to authenticated;

notify pgrst, 'reload schema';
