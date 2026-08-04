-- LP-001: permanent, directly parent-owned learner profiles.

create table approved_avatars (
  id text primary key,
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table learners (
  id uuid primary key default gen_random_uuid(),
  owner_parent_id uuid not null references profiles(id),
  display_name text not null,
  normalized_display_name text not null,
  date_of_birth date not null,
  avatar_id text references approved_avatars(id),
  version integer not null default 1 check (version > 0),
  locale text not null,
  timezone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_parent_id, normalized_display_name)
);

create index idx_learners_owner on learners(owner_parent_id);

create trigger learners_set_updated_at
  before update on learners
  for each row execute procedure set_updated_at();

create table learner_creation_requests (
  parent_user_id uuid not null references profiles(id),
  idempotency_key uuid not null,
  request_hash text not null,
  learner_id uuid references learners(id),
  status text not null check (status in ('processing','completed','failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (parent_user_id, idempotency_key)
);

create index idx_learner_creation_requests_status
  on learner_creation_requests(status, created_at);

alter table approved_avatars enable row level security;
alter table learners enable row level security;
alter table learner_creation_requests enable row level security;

create policy "active parents can read approved avatars"
  on approved_avatars for select
  using (
    active and exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.account_status = 'active'
    )
  );

create policy "active parents can read owned learners"
  on learners for select
  using (
    owner_parent_id = auth.uid() and exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.account_status = 'active'
    )
  );

-- Learner writes and idempotency rows are intentionally service-only. The
-- transaction service derives owner_parent_id from the verified session;
-- browser clients have no INSERT/UPDATE policy and therefore fail closed.

-- Down migration (apply manually to reverse):
-- drop table if exists learner_creation_requests;
-- drop trigger if exists learners_set_updated_at on learners;
-- drop table if exists learners;
-- drop table if exists approved_avatars;
