-- AD-005: platform governance — staff passkey recovery (normal + sole-
-- Platform-Administrator break-glass), recovery-code rotation, governance-
-- gated IA-003 restoration and a privileged-audit read model composed live
-- over existing append-only activity tables. Never a second staff/audit/
-- restoration engine.
create table if not exists staff_recovery_sessions (
  id text primary key,
  target_staff_id text not null references staff_accounts(id) on delete cascade,
  issued_by_staff_id text references staff_accounts(id),
  method text not null check(method in ('normal','break_glass')),
  purpose text not null default 'staff_passkey_recovery' check(purpose='staff_passkey_recovery'),
  expires_at text not null,
  consumed_at text,
  created_at text not null
);
create index if not exists idx_staff_recovery_sessions_target
  on staff_recovery_sessions(target_staff_id, consumed_at, expires_at);
alter table staff_recovery_sessions enable row level security;
alter table staff_recovery_sessions force row level security;

create table if not exists platform_recovery_codes (
  id text primary key,
  generation integer not null,
  verifier_hash text not null,
  status text not null default 'active' check(status in ('active','used','revoked')),
  created_by_staff_id text references staff_accounts(id),
  created_at text not null,
  used_at text,
  used_by_staff_id text references staff_accounts(id),
  revoked_at text
);
create index if not exists idx_platform_recovery_codes_status on platform_recovery_codes(status);
alter table platform_recovery_codes enable row level security;
alter table platform_recovery_codes force row level security;

create table if not exists platform_governance_mutation_requests (
  actor_staff_account_id text not null references staff_accounts(id),
  idempotency_key text not null,
  canonical_action text not null,
  target_reference text,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  response_json text,
  created_at text not null default (now()::text),
  completed_at text,
  primary key (actor_staff_account_id, idempotency_key)
);
alter table platform_governance_mutation_requests enable row level security;
alter table platform_governance_mutation_requests force row level security;

-- AD-005 rule 75: optimistic-concurrency token for governance-gated
-- restoration only.
alter table profiles add column if not exists version integer not null default 1;
