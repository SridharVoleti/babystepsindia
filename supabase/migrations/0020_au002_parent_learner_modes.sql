create table if not exists learner_unlock_contexts (
  parent_session_id uuid not null, device_session_id uuid not null,
  parent_user_id uuid not null references profiles(id) on delete cascade,
  learner_id uuid not null references learners(id), credential_id uuid not null,
  status text not null check(status in ('active','revoked','expired')), expires_at timestamptz not null,
  version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  revoked_at timestamptz, revocation_reason text, primary key(parent_session_id,device_session_id)
);
create index if not exists idx_learner_unlock_context_credential on learner_unlock_contexts(credential_id,status);
create table if not exists authorization_actions (
  action_key text primary key, required_mode text not null check(required_mode in ('parent_management','learner_mode','app_service')),
  resource_type text not null, sensitive boolean not null default false, version integer not null default 1, active boolean not null default true
);
alter table learner_unlock_contexts enable row level security;
alter table authorization_actions enable row level security;
