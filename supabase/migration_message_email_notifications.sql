-- Queue one email notification per message for immediate processing.
-- Run this migration and deploy process-message-notifications.

create table if not exists public.message_notification_batches (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.messages(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  message_count integer not null default 0 check (message_count > 0),
  last_message_at timestamptz not null default now(),
  notify_after timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'processing')),
  last_error text,
  created_at timestamptz not null default now(),
  unique (message_id)
);

alter table public.message_notification_batches
  add column if not exists message_id uuid references public.messages(id) on delete cascade;
alter table public.message_notification_batches
  drop constraint if exists message_notification_batches_recipient_id_sender_id_key;
alter table public.message_notification_batches
  drop constraint if exists message_notification_batches_message_id_key;
alter table public.message_notification_batches
  add constraint message_notification_batches_message_id_key unique (message_id);

create index if not exists message_notification_batches_due_idx
  on public.message_notification_batches(status, notify_after);

alter table public.message_notification_batches enable row level security;
revoke all on public.message_notification_batches from public, anon, authenticated;

create or replace function public.queue_message_email_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.message_notification_batches(message_id, recipient_id, sender_id, message_count, last_message_at, notify_after, status, last_error)
  select new.id, cm.user_id, new.sender_id, 1, new.created_at, new.created_at, 'pending', null
  from public.conversation_members cm
  where cm.conversation_id = new.conversation_id
    and cm.user_id <> new.sender_id
  on conflict (message_id) do nothing;
  return new;
end;
$$;

drop trigger if exists queue_message_email_notifications on public.messages;
create trigger queue_message_email_notifications
after insert on public.messages
for each row execute function public.queue_message_email_notifications();

notify pgrst, 'reload schema';
