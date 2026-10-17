-- Message reply/edit/delete support. Run this after schema.sql.
alter table public.messages
  add column if not exists edited_at timestamptz,
  add column if not exists reply_to_id uuid references public.messages(id) on delete set null;

alter table public.conversation_members
  add column if not exists last_read_at timestamptz;

grant update, delete on public.messages to authenticated;
grant update on public.conversation_members to authenticated;

drop policy if exists "Members can update their read status" on public.conversation_members;
create policy "Members can update their read status" on public.conversation_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Senders can edit their messages" on public.messages;
create policy "Senders can edit their messages" on public.messages
  for update to authenticated
  using (sender_id = auth.uid() and public.is_conversation_member(messages.conversation_id, auth.uid()))
  with check (sender_id = auth.uid() and public.is_conversation_member(messages.conversation_id, auth.uid()));

drop policy if exists "Senders can delete their messages" on public.messages;
create policy "Senders can delete their messages" on public.messages
  for delete to authenticated
  using (sender_id = auth.uid() and public.is_conversation_member(messages.conversation_id, auth.uid()));
