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
