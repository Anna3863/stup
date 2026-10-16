alter table public.profiles
  add column if not exists bio text not null default '',
  add column if not exists verified boolean not null default false,
  add column if not exists student_id_photo_url text;

notify pgrst, 'reload schema';
