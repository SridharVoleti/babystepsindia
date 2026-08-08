-- REQ-08 §3.1 — one row per user, no parent/child modeling.

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles are readable by owner"
  on profiles for select
  using (auth.uid() = id);

-- Keep profiles in lockstep with auth.users so every signup path
-- (password, magic link, OAuth) ends up with a row here.
create function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();
