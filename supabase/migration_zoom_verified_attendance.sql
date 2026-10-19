-- Private Zoom attendance tracking. Clients cannot read or modify these rows.
alter table public.conversations
  add column if not exists requester_id uuid references public.profiles(id);
alter table public.conversations
  add column if not exists zoom_meeting_id text;
alter table public.conversations
  add column if not exists zoom_join_url text;
create unique index if not exists conversations_zoom_meeting_id_key
  on public.conversations(zoom_meeting_id)
  where zoom_meeting_id is not null;

-- Preserve who initiated a direct help request so the reward recipient is fixed server-side.
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
  if found_id is not null then
    update public.conversations set requester_id = coalesce(requester_id, current_user_id) where id = found_id;
    return found_id;
  end if;
  insert into public.conversations(requester_id) values (current_user_id) returning id into new_id;
  insert into public.conversation_members(conversation_id,user_id) values (new_id,current_user_id),(new_id,other_user);
  return new_id;
end;
$$;
revoke all on function public.get_or_create_conversation(uuid) from public;
grant execute on function public.get_or_create_conversation(uuid) to authenticated;

create table if not exists public.zoom_session_attendance (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique references public.conversations(id) on delete cascade,
  meeting_id text not null unique,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  helper_id uuid not null references public.profiles(id) on delete cascade,
  requester_email_hash text not null,
  helper_email_hash text not null,
  requester_in_meeting boolean not null default false,
  helper_in_meeting boolean not null default false,
  shared_started_at timestamptz,
  shared_seconds integer not null default 0 check (shared_seconds >= 0),
  rewarded_at timestamptz,
  created_at timestamptz not null default now(),
  check (requester_id <> helper_id)
);
alter table public.zoom_session_attendance enable row level security;
revoke all on public.zoom_session_attendance from public, anon, authenticated;

create or replace function public.record_zoom_attendance(
  p_meeting_id text,
  p_participant_email_hash text,
  p_event text,
  p_event_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  attendance public.zoom_session_attendance;
  is_requester boolean;
  both_were_present boolean;
  elapsed integer;
begin
  if p_event not in ('meeting.participant_joined', 'meeting.participant_left') then
    return;
  end if;

  select * into attendance
  from public.zoom_session_attendance
  where meeting_id = p_meeting_id
  for update;
  if not found then return; end if;

  is_requester := p_participant_email_hash = attendance.requester_email_hash;
  if not is_requester and p_participant_email_hash <> attendance.helper_email_hash then
    return;
  end if;

  both_were_present := attendance.requester_in_meeting and attendance.helper_in_meeting;
  if both_were_present and attendance.shared_started_at is not null then
    elapsed := greatest(0, floor(extract(epoch from (p_event_at - attendance.shared_started_at)))::integer);
    attendance.shared_seconds := attendance.shared_seconds + elapsed;
  end if;

  if p_event = 'meeting.participant_joined' then
    if is_requester then
      attendance.requester_in_meeting := true;
    else
      attendance.helper_in_meeting := true;
    end if;
  else
    if is_requester then
      attendance.requester_in_meeting := false;
    else
      attendance.helper_in_meeting := false;
    end if;
  end if;

  if attendance.requester_in_meeting and attendance.helper_in_meeting then
    if attendance.shared_started_at is null then attendance.shared_started_at := p_event_at; end if;
  else
    attendance.shared_started_at := null;
  end if;

  if attendance.rewarded_at is null and attendance.shared_seconds >= 600 then
    update public.profiles
    set lumen_balance = lumen_balance + 1
    where id = attendance.helper_id;
    attendance.rewarded_at := now();
  end if;

  update public.zoom_session_attendance
  set requester_in_meeting = attendance.requester_in_meeting,
      helper_in_meeting = attendance.helper_in_meeting,
      shared_started_at = attendance.shared_started_at,
      shared_seconds = attendance.shared_seconds,
      rewarded_at = attendance.rewarded_at
  where id = attendance.id;
end;
$$;
revoke all on function public.record_zoom_attendance(text, text, text, timestamptz) from public;
grant execute on function public.record_zoom_attendance(text, text, text, timestamptz) to service_role;

create or replace function public.finalize_zoom_attendance()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  attendance public.zoom_session_attendance;
  elapsed integer;
begin
  for attendance in
    select * from public.zoom_session_attendance
    where rewarded_at is null
      and requester_in_meeting
      and helper_in_meeting
      and shared_started_at is not null
      and shared_started_at <= now() - interval '10 minutes'
    for update
  loop
    elapsed := greatest(0, floor(extract(epoch from (now() - attendance.shared_started_at)))::integer);
    if attendance.shared_seconds + elapsed >= 600 then
      update public.profiles set lumen_balance = lumen_balance + 1 where id = attendance.helper_id;
      update public.zoom_session_attendance
      set shared_seconds = attendance.shared_seconds + elapsed,
          rewarded_at = now()
      where id = attendance.id and rewarded_at is null;
    end if;
  end loop;
end;
$$;
revoke all on function public.finalize_zoom_attendance() from public;
grant execute on function public.finalize_zoom_attendance() to service_role;

-- Run the private reward check once per minute. This reveals no attendance data to clients.
create extension if not exists pg_cron;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'stup-zoom-attendance-reward') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'stup-zoom-attendance-reward';
  end if;
  perform cron.schedule('stup-zoom-attendance-reward', '* * * * *', 'select public.finalize_zoom_attendance();');
exception when undefined_table or insufficient_privilege then
  raise notice 'Enable pg_cron and schedule public.finalize_zoom_attendance manually.';
end;
$$;

notify pgrst, 'reload schema';
