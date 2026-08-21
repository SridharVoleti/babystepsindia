-- Issue #42: repair deployments whose profiles FK still targets the
-- retired public.users identity table. Never fabricate shadow users.
do $$
declare
  legacy_constraint text;
  orphan_count bigint;
begin
  select c.conname into legacy_constraint
  from pg_constraint c
  where c.conrelid = 'public.profiles'::regclass
    and c.confrelid = 'public.users'::regclass
    and c.contype = 'f';

  if legacy_constraint is not null then
    select count(*) into orphan_count
    from public.profiles p
    where not exists (select 1 from auth.users u where u.id = p.id);
    if orphan_count > 0 then
      raise exception 'profiles contain % rows without canonical auth.users identities', orphan_count;
    end if;
    execute format('alter table public.profiles drop constraint %I', legacy_constraint);
  end if;

  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.profiles'::regclass
      and c.confrelid = 'auth.users'::regclass
      and c.contype = 'f'
  ) then
    alter table public.profiles
      add constraint profiles_id_fkey foreign key (id)
      references auth.users (id) on delete cascade;
  end if;
end $$;
