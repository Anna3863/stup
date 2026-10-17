-- Message reply/edit/delete support. Run this after schema.sql.
alter table public.messages
  add column if not exists edited_at timestamptz,
  add column if not exists reply_to_id uuid references public.messages(id) on delete set null;

grant update, delete on public.messages to authenticated;

drop policy if exists "Senders can edit their messages" on public.messages;
create policy "Senders can edit their messages" on public.messages
  for update to authenticated
  using (sender_id = auth.uid() and public.is_conversation_member(messages.conversation_id, auth.uid()))
  with check (sender_id = auth.uid() and public.is_conversation_member(messages.conversation_id, auth.uid()));

drop policy if exists "Senders can delete their messages" on public.messages;
create policy "Senders can delete their messages" on public.messages
  for delete to authenticated
  using (sender_id = auth.uid() and public.is_conversation_member(messages.conversation_id, auth.uid()));
