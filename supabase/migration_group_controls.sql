-- Adds group ownership/admin controls and persisted message-request acceptance.
alter table public.conversations
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists group_photo_url text;

alter table public.conversation_members
  add column if not exists is_admin boolean not null default false,
  add column if not exists accepted_at timestamptz;

-- Existing conversation creators and participants who have already replied are
-- treated as accepted so this migration does not lock existing chats.
update public.conversations c
set created_by = c.requester_id
where c.created_by is null and c.is_group;

update public.conversation_members cm
set accepted_at = coalesce(cm.accepted_at, c.created_at)
from public.conversations c
where c.id = cm.conversation_id
  and cm.accepted_at is null
  and (c.is_group or cm.user_id = c.requester_id or exists (
    select 1 from public.messages m
    where m.conversation_id = c.id and m.sender_id = cm.user_id
  ));

update public.conversation_members cm
set is_admin = true
from public.conversations c
where c.id = cm.conversation_id
  and c.is_group
  and c.created_by = cm.user_id;

create or replace function public.create_group_conversation(group_name text, member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  new_id uuid;
  selected_id uuid;
  selected_ids uuid[];
begin
  if current_user_id is null then raise exception 'You must be signed in'; end if;
  if group_name is null or char_length(trim(group_name)) not between 1 and 60 then raise exception 'Enter a group name'; end if;
  selected_ids := array(select distinct id from unnest(coalesce(member_ids, '{}')) id where id <> current_user_id);
  if coalesce(array_length(selected_ids, 1), 0) < 1 then raise exception 'Choose at least one accepted student'; end if;

  foreach selected_id in array selected_ids loop
    if not exists (
      select 1
      from public.conversations direct_conversation
      join public.conversation_members requester_member
        on requester_member.conversation_id = direct_conversation.id
       and requester_member.user_id = current_user_id
      join public.conversation_members accepted_member
        on accepted_member.conversation_id = direct_conversation.id
       and accepted_member.user_id = selected_id
      where not direct_conversation.is_group
        and direct_conversation.requester_id = current_user_id
        and accepted_member.accepted_at is not null
        and (select count(*) from public.conversation_members count_members where count_members.conversation_id = direct_conversation.id) = 2
    ) then
      raise exception 'You can only add students who accepted your message request';
    end if;
  end loop;

  insert into public.conversations(title, is_group, requester_id, created_by)
  values (trim(group_name), true, current_user_id, current_user_id)
  returning id into new_id;

  insert into public.conversation_members(conversation_id, user_id, is_admin, accepted_at)
  values (new_id, current_user_id, true, now());
  insert into public.conversation_members(conversation_id, user_id, accepted_at)
  select new_id, id, now() from unnest(selected_ids) id;
  return new_id;
end;
$$;

create or replace function public.accept_conversation_request(target_conversation uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  update public.conversation_members
  set accepted_at = coalesce(accepted_at, now())
  where conversation_id = target_conversation and user_id = auth.uid();
  if not found then raise exception 'Conversation member not found'; end if;
end;
$$;

create or replace function public.update_group_conversation(
  target_conversation uuid,
  group_title text,
  group_photo text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  -- Legacy groups were created before admin metadata existed. Let a member
  -- claim admin once so the group can be repaired without manual ID lookup.
  if not exists (select 1 from public.conversation_members where conversation_id = target_conversation and is_admin) then
    update public.conversation_members set is_admin = true
    where conversation_id = target_conversation and user_id = auth.uid();
  end if;
  if not exists (
    select 1 from public.conversation_members
    where conversation_id = target_conversation and user_id = auth.uid() and is_admin
  ) then raise exception 'Only group admins can update this group'; end if;
  if group_title is null or char_length(trim(group_title)) not between 1 and 60 then raise exception 'Enter a group name'; end if;
  update public.conversations
  set title = trim(group_title), group_photo_url = coalesce(group_photo, group_photo_url)
  where id = target_conversation and is_group;
  if not found then raise exception 'Group not found'; end if;
end;
$$;

create or replace function public.set_group_admin(target_conversation uuid, target_user uuid, make_admin boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if not exists (select 1 from public.conversation_members where conversation_id = target_conversation and is_admin) then
    update public.conversation_members set is_admin = true
    where conversation_id = target_conversation and user_id = auth.uid();
  end if;
  if not exists (
    select 1 from public.conversation_members
    where conversation_id = target_conversation and user_id = auth.uid() and is_admin
  ) then raise exception 'Only group admins can manage admins'; end if;
  if not exists (
    select 1 from public.conversation_members
    where conversation_id = target_conversation and user_id = target_user
  ) then raise exception 'That student is not in this group'; end if;
  if target_user = auth.uid() and not make_admin then
    raise exception 'You cannot remove your own admin access';
  end if;
  update public.conversation_members set is_admin = make_admin
  where conversation_id = target_conversation and user_id = target_user;
end;
$$;

revoke all on function public.accept_conversation_request(uuid) from public;
revoke all on function public.update_group_conversation(uuid, text, text) from public;
revoke all on function public.set_group_admin(uuid, uuid, boolean) from public;
grant execute on function public.accept_conversation_request(uuid) to authenticated;
grant execute on function public.update_group_conversation(uuid, text, text) to authenticated;
grant execute on function public.set_group_admin(uuid, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
